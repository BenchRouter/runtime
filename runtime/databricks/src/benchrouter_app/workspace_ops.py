"""The Databricks work of the app's screens (plan sections 4.1, 4.2 and 4.4).

Connect: register the binding, run its GRANTs as the admin, write the poll key, give the agent
job its wheel and schedule, and start it. Add eval: share the eval folder and its cases table
with the app SP. The agent job does everything else as the app SP, and checks before each run
that the app SP can read the folder, the table and every declared secret (plan section 4.4).
"""

from __future__ import annotations

import base64
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from benchrouter_databricks import handlers
from benchrouter_databricks.manifest import EvalManifest, ManifestError, is_benchrouter_scope, load_manifest
from benchrouter_databricks.transport import ApiError, TransportError
from benchrouter_databricks.workspace import (ARTIFACT_VOLUME, RESULTS_VOLUME, StatementFailed, Workspace, is_not_found, quote_full_name,
                                              quote_identifier, split_full_name)

from . import api, identity, store

AGENT_JOB_NAME = "BenchRouter agent"
#: The agent job's one environment: the server's pinned release URL (B6, plan section 4.3).
AGENT_ENVIRONMENT = "agent"
#: The eval folder's manifest: the same file and schema as a repo's, so one folder works on either runner.
EVAL_MANIFEST = ".benchrouter/benchrouter.yml"
STATEMENT_WAIT_SECONDS = 90


#: Where Unity Catalog REST reads each securable kind the app names an owner of, as the admin. No
#: volumes: the app's user API scopes hold no `catalog.volumes`, so every OBO volume read answers 403
#: (live, 0.2.3). The app reads volumes with SQL on the admin's `sql` scope (`_volume`).
UC_PATHS = {"catalog": "catalogs", "schema": "schemas", "table": "tables"}
#: Plan 4.2: why a heal statement was refused, beside its owner (the Connect screen shows it).
HEAL_HINT = ("BenchRouter's volumes and results table in this schema belong to someone else: an earlier BenchRouter app's "
             "service principal, or the group a Disconnect handed the results to. Connect gives this app's service principal "
             "the use of them, as you. Ask the owner named here, or a metastore admin, to open this app and click Connect, or "
             "to run the statement above.")


class SqlRefused(Exception):
    """Databricks refused a SQL statement. `message` is Databricks' own text, for the admin."""

    def __init__(self, statement: str, message: str) -> None:
        super().__init__(message)
        self.statement = statement
        self.message = message


@dataclass
class GrantRefusal:
    statement: str
    message: str
    #: (kind, name, owner) for each securable the statement names, so the admin knows whom to ask.
    owners: list[tuple[str, str, str]] = field(default_factory=list)
    #: What to do, when it is not the default (own or hold MANAGE on the catalog and the schema).
    hint: str | None = None


def run_statement(workspace: Workspace, warehouse_id: str, statement: str) -> None:
    answer = workspace.call("POST", "/api/2.0/sql/statements", {
        "warehouse_id": warehouse_id, "statement": statement, "wait_timeout": "30s", "on_wait_timeout": "CONTINUE",
    })
    deadline = time.monotonic() + STATEMENT_WAIT_SECONDS
    while True:
        status = answer.get("status", {})
        state = status.get("state")
        if state == "SUCCEEDED":
            return
        if state in {"FAILED", "CANCELED", "CLOSED"}:
            error = status.get("error", {})
            raise SqlRefused(statement, str(error.get("message") or error.get("error_code") or state))
        if time.monotonic() > deadline:
            raise SqlRefused(statement, "The statement did not finish in time.")
        time.sleep(2)
        answer = workspace.call("GET", f"/api/2.0/sql/statements/{answer['statement_id']}")


def owner_of(workspace: Workspace, kind: str, full_name: str) -> str:
    """The owner field of a securable, as the admin can read it."""
    try:
        return str(workspace.call("GET", f"/api/2.1/unity-catalog/{UC_PATHS[kind]}/{full_name}").get("owner") or "unknown")
    except ApiError:
        return "unknown"


#: Where each SQL answer holds what the heal reads (the live OBO answers, 2026-10-29, tests/fixtures/
#: reinstall/probeapp_*.json): `SHOW VOLUMES` and `SHOW TABLES` rows are [schema, name, ...], and the
#: one `DESCRIBE VOLUME` row is [name, catalog, schema, owner, ...].
SHOW_NAME_INDEX = 1
DESCRIBE_VOLUME_OWNER_INDEX = 3


def _listed(user: Workspace, warehouse_id: str, statement: str, name: str) -> bool:
    """Whether a SHOW statement, as the admin, lists `name` (names are case-insensitive).

    A statement that fails lists nothing: a heal never runs on an object the admin was not shown.
    """
    try:
        _, rows = user.query(warehouse_id, statement)
    except StatementFailed:
        return False
    return any(len(row) > SHOW_NAME_INDEX and isinstance(row[SHOW_NAME_INDEX], str) and row[SHOW_NAME_INDEX].lower() == name.lower()
               for row in rows)


def _volume(user: Workspace, warehouse_id: str, full_name: str) -> tuple[bool, str | None]:
    """A volume's presence and owner through SQL as the admin: membership in `SHOW VOLUMES IN <c>.<s>`,
    then the owner of `DESCRIBE VOLUME`. Never Unity Catalog REST: the app's OBO token has no
    `catalog.volumes` scope, so a volume read answers 403 "does not have required scopes:
    unity-catalog" for a volume that exists and for one that does not (live). 0.2.3 took that 403 for
    "present", ran `ALTER VOLUME ... OWNER TO` on a volume that did not exist (`UC_VOLUME_NOT_FOUND`),
    and refused every Connect on a schema without BenchRouter volumes."""
    catalog, schema, volume = split_full_name(full_name)
    if not _listed(user, warehouse_id, f"SHOW VOLUMES IN {quote_identifier(catalog)}.{quote_identifier(schema)}", volume):
        return False, None
    try:
        _, rows = user.query(warehouse_id, f"DESCRIBE VOLUME {quote_full_name(full_name)}")
    except StatementFailed:
        return True, None
    owner = rows[0][DESCRIBE_VOLUME_OWNER_INDEX] if rows and len(rows[0]) > DESCRIBE_VOLUME_OWNER_INDEX else None
    return True, owner if isinstance(owner, str) and owner else None


def _present_owner(user: Workspace, warehouse_id: str, kind: str, name: str) -> tuple[bool, str | None]:
    """Whether a securable exists, as the admin reads it, and its owner when the read shows one.

    A volume is read with SQL (`_volume`). A table is read with Unity Catalog REST (`catalog.tables` is
    an app user scope); a refused read (403) is checked with `SHOW TABLES` before the table counts as
    present with no owner, so a heal never runs on a table that does not exist, and the statement's
    own refusal names the owner. A transient error propagates: the page reloads.
    """
    if kind == "volume":
        return _volume(user, warehouse_id, name)
    try:
        answer = user.call("GET", f"/api/2.1/unity-catalog/{UC_PATHS[kind]}/{name}")
    except ApiError as error:
        if error.transient:
            raise
        if is_not_found(error):
            return False, None
        catalog, schema, table = split_full_name(name)
        return _listed(user, warehouse_id, f"SHOW TABLES IN {quote_identifier(catalog)}.{quote_identifier(schema)}", table), None
    owner = answer.get("owner") if isinstance(answer, dict) else None
    return True, owner if isinstance(owner, str) and owner else None


def heal_reinstall(user: Workspace, warehouse_id: str, heals: list[dict[str, str]], app_principal: str) -> GrantRefusal | None:
    """Plan 4.2: after a reinstall, gives this app's SP the use of what BenchRouter left in the schema.

    Unity Catalog keeps a volume and a table when the SP that made them is deleted, and Disconnect
    hands the results table to the admin's group, so a new app's SP finds objects it cannot use
    (B11 smoke 8b: `volume_http_403` at setup, then every work run failed). As the connecting admin,
    each heal the server returns runs only for an object that exists and that this SP does not own:
    `ALTER VOLUME ... OWNER TO` for BenchRouter's two working volumes (its scratch), and `GRANT
    SELECT, MODIFY` on a results table someone else owns (the customer's record keeps its owner).
    The admin's recorded probe ran both on a volume whose owner was gone and on a table the admin's
    account owned. A refused statement shows its owner, unless the object is gone by then.
    """
    for heal in heals:
        kind, name, statement = heal["securable"], heal["name"], heal["statement"]
        present, owner = _present_owner(user, warehouse_id, kind, name)
        if not present or (owner is not None and owner.lower() == app_principal.lower()):
            continue
        try:
            run_statement(user, warehouse_id, statement)
        except SqlRefused as refused:
            present, owner = _present_owner(user, warehouse_id, kind, name)
            if not present:
                continue
            return GrantRefusal(statement, refused.message, [(kind, name, owner or "unknown")], HEAL_HINT)
    return None


def run_grants(user: Workspace, warehouse_id: str, statements: list[str], securables: list[tuple[str, str]]) -> GrantRefusal | None:
    """Runs each GRANT as the admin. Databricks' refusal names no owner, so the app reads them."""
    for statement in statements:
        try:
            run_statement(user, warehouse_id, statement)
        except SqlRefused as refused:
            owners = [(kind, name, owner_of(user, kind, name)) for kind, name in securables]
            return GrantRefusal(statement, refused.message, owners)
    return None


def warehouses(user: Workspace) -> list[dict[str, str]]:
    """The SQL warehouses the admin can see; the Serverless Starter Warehouse first."""
    try:
        listed = user.call("GET", "/api/2.0/sql/warehouses").get("warehouses") or []
    except ApiError:
        return []
    rows = [{"id": str(entry["id"]), "name": str(entry.get("name") or entry["id"])} for entry in listed]
    return sorted(rows, key=lambda row: (row["name"] != "Serverless Starter Warehouse", row["name"]))


# Connect, steps 1 to 3 (plan section 4.2). Step 4 is the agent's first poll.
@dataclass
class ConnectResult:
    binding_id: str | None = None
    refusal: GrantRefusal | None = None


def connect(token: str, user: Workspace, admin_user_name: str, catalog: str, schema: str, warehouse_id: str,
            results_reader: str | None) -> ConnectResult:
    app = identity.app_workspace()
    proof, _ = identity.mint_app_sp_token(identity.APP_SP_PROOF_SCOPE)
    registered = api.register_binding(token, {
        "workspace_url": identity.workspace_url(),
        "workspace_id": identity.workspace_id(),
        "app_sp_application_id": identity.app_sp_client_id(),
        "app_sp_token": proof,
        "catalog": catalog,
        "schema": schema,
        "warehouse_id": warehouse_id,
        "admin_user_name": admin_user_name,
        # Plan 4.5: an optional account group that reads the results beside the admins who use the app.
        "results_reader": results_reader,
    })
    binding_id = str(registered["binding_id"])
    agent = registered["agent"]
    scope = str(agent["secret_scope"])
    if scope != store.scope():
        raise ValueError("Connect named a scope this app does not keep its sign-ins in")
    # AUTH-012: each register revokes every earlier key, and the scope keeps the last write. So a
    # Connect writes its key under a name of its own and never overwrites another writer's; the
    # agent tries every such key and keeps the one BenchRouter accepts (benchrouter_databricks.agent).
    # The key goes in before the GRANTs, so a refused GRANT never strands the agent.
    store.ensure_scope(app)
    app.secret_put(scope, f"{agent['poll_key_secret']}-{secrets.token_hex(8)}", str(registered["poll_key"]))
    refusal = run_grants(user, warehouse_id, registered["grants"]["statements"],
                         [("catalog", catalog), ("schema", f"{catalog}.{schema}")])
    if refusal is None:
        refusal = heal_reinstall(user, warehouse_id, registered["grants"]["heal"], identity.app_sp_client_id())
    if refusal is not None:
        return ConnectResult(binding_id, refusal)

    job_id = ensure_agent_job(app, agent_job_settings(registered))
    api.record_agent(token, binding_id, job_id, scope)
    start_agent(job_id)
    return ConnectResult(binding_id)


def agent_job_settings(registered: dict[str, Any]) -> dict[str, Any]:
    agent = registered["agent"]
    schedule = registered["agent_schedule"]
    return {
        "name": AGENT_JOB_NAME,
        # AUTH-012: two agent runs never write the scope at once.
        "max_concurrent_runs": int(agent["max_concurrent_runs"]),
        "queue": {"enabled": True},
        "schedule": {
            "quartz_cron_expression": schedule["quartz_cron_expression"],
            "timezone_id": schedule["timezone_id"],
            "pause_status": "UNPAUSED",
        },
        "tasks": [{
            "task_key": "agent",
            "environment_key": AGENT_ENVIRONMENT,
            "max_retries": 0,
            # P9: without it, serverless retries a failed task once.
            "disable_auto_optimization": True,
            # The agent reads `--name=value` arguments; job-level parameters never reach a wheel task.
            "python_wheel_task": {
                "package_name": agent["package"],
                "entry_point": agent["entry_point"],
                "named_parameters": {name: str(value) for name, value in agent["job_parameters"].items()},
            },
        }],
        # B6 (plan 4.3): the server's pinned release URL, never a wheel in a path the app SP can
        # write; the agent repoints itself when a poll names a new release.
        "environments": [{"environment_key": AGENT_ENVIRONMENT, "spec": dict(agent["environment"])}],
    }


def ensure_agent_job(app: Workspace, settings: dict[str, Any]) -> int:
    """Creates the agent job, or resets the one an earlier Connect made."""
    existing = app.find_job(AGENT_JOB_NAME)
    if existing is None:
        return app.create_job(settings)
    app.reset_job(existing, settings)
    return existing


def start_agent(job_id: int | str | None) -> None:
    """Starts the agent now, so the admin does not wait for the next scheduled poll.

    A failed start changes nothing: the schedule runs the agent anyway.
    """
    if job_id is None:
        return
    try:
        identity.app_workspace().call("POST", "/api/2.2/jobs/run-now", {"job_id": int(job_id)})
    except (ApiError, ValueError):
        pass


def remove_agent(app: Workspace, binding: dict[str, Any], exposures: list[dict[str, Any]]) -> None:
    """After a Disconnect that closed at once (no agent ran the cleanup): the app SP deletes what
    the agent's `disconnect` would have deleted, with the agent's own code (plan section 4.7).

    Records stay: the results table and the experiment keep their owner. BenchRouter's two working
    volumes go, as the agent's Disconnect drops them. Each step treats an object already gone as
    deleted, so a repeat is safe.
    """
    for exposure in exposures:
        handlers.remove_exposure(handlers.Context(app, store.scope(), None),
                                 str(exposure["endpoint_name"]), str(exposure["provider_service_name"]))
    handlers.drop_volumes(app, [f"{binding['catalog']}.{binding['schema']}.{name}" for name in (ARTIFACT_VOLUME, RESULTS_VOLUME)])
    eval_job_id = binding.get("eval_job_id")
    if eval_job_id is not None:
        app.delete_job(int(eval_job_id))
    job_id = app.find_job(AGENT_JOB_NAME)
    if job_id is not None:
        app.delete_job(job_id)
    app.scope_delete(store.scope())


def stale_scopes(app: Workspace) -> list[str]:
    """BenchRouter scopes in this workspace that are not this install's, for Status's optional clean-up.

    Plan 4.7: deleting an app leaves the scope its SP made, and only a workspace admin can delete it.
    A new install uses its own scope, and its Connect revoked every key the old one held, so the old
    scope is only clutter. Scope names are readable by every workspace user (Databricks: "Secret scope
    names are considered non-sensitive and are readable by all users in the workspace"; plan 4.9, Live),
    so the app SP lists them. A list that fails shows nothing: the note is never a blocker.
    """
    try:
        listed = app.call("GET", "/api/2.0/secrets/scopes/list").get("scopes") or []
    except (ApiError, TransportError):
        return []
    own = store.scope().casefold()
    names = {str(entry["name"]) for entry in listed if isinstance(entry, dict) and isinstance(entry.get("name"), str)}
    return sorted(name for name in names if is_benchrouter_scope(name) and name.casefold() != own)


# Add eval (plan section 4.4).
class ManifestInvalid(Exception):
    pass


class ManifestMissing(ManifestInvalid):
    """Export answered not found. As the app SP that is also a folder it may not read (B11 smoke 8b)."""


def read_manifest(workspace: Workspace, folder: str, route_key: str) -> EvalManifest:
    """Reads the route's entry of `<folder>/.benchrouter/benchrouter.yml` with the runner's own parser.

    One parser (`benchrouter_databricks.manifest`) for the app and the runner, so Add eval shares
    exactly the cases table the refresh reads, and refuses a manifest the runner would refuse. The
    B11 live smoke found two parsers apart: the app read secrets from another field than the runner.
    """
    path = f"{folder}/{EVAL_MANIFEST}"
    try:
        answer = workspace.call("GET", "/api/2.0/workspace/export", query={"path": path, "format": "SOURCE"})
    except ApiError as error:
        if is_not_found(error):
            raise ManifestMissing(f"{path} was not found.") from None
        raise
    try:
        text = base64.b64decode(answer.get("content") or "").decode("utf-8")
        return load_manifest(text, route_key)
    except UnicodeDecodeError:
        raise ManifestInvalid(f"{EVAL_MANIFEST} is not UTF-8 text.") from None
    except ManifestError as refused:
        raise ManifestInvalid(f"{EVAL_MANIFEST}: {refused}.") from None


def share_eval(user: Workspace, warehouse_id: str, folder: str, cases_table: str) -> GrantRefusal | None:
    """As the admin: CAN_READ on the folder and SELECT on the cases table, for the app SP."""
    principal = identity.app_sp_client_id()
    status = user.call("GET", "/api/2.0/workspace/get-status", query={"path": folder})
    kind = "repos" if status.get("object_type") == "REPO" else "directories"
    try:
        user.call("PATCH", f"/api/2.0/permissions/{kind}/{status['object_id']}", {
            "access_control_list": [{"service_principal_name": principal, "permission_level": "CAN_READ"}],
        })
    except ApiError as error:
        return GrantRefusal(f"CAN_READ on {folder}", error.message or f"Databricks answered {error.status}.")
    catalog, schema, _ = split_full_name(cases_table)
    who = quote_identifier(principal)
    statements = [
        f"GRANT USE CATALOG ON CATALOG {quote_identifier(catalog)} TO {who}",
        f"GRANT USE SCHEMA ON SCHEMA {quote_identifier(catalog)}.{quote_identifier(schema)} TO {who}",
        f"GRANT SELECT ON TABLE {quote_full_name(cases_table)} TO {who}",
    ]
    return run_grants(user, warehouse_id, statements,
                      [("catalog", catalog), ("schema", f"{catalog}.{schema}"), ("table", cases_table)])
