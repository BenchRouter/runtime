"""The Databricks work of the app's screens (plan sections 4.1, 4.2 and 4.4).

Connect: register the binding, run its GRANTs as the admin, write the poll key, give the agent
job its wheel and schedule, and start it. Add eval: share the eval folder and its cases table
with the app SP, and check which named secrets the app SP can read. The agent job does
everything else as the app SP.
"""

from __future__ import annotations

import base64
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import yaml

from benchrouter_databricks.transport import ApiError
from benchrouter_databricks.workspace import Workspace, is_not_found, quote_full_name, quote_identifier, split_full_name

from . import api, identity, store
from .agent_release import AGENT_ENVIRONMENT

AGENT_JOB_NAME = "BenchRouter agent"
#: The eval folder's manifest: the same file and schema as a repo's, so one folder works on either runner.
EVAL_MANIFEST = ".benchrouter/benchrouter.yml"
STATEMENT_WAIT_SECONDS = 90


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
    """The owner field of a catalog or schema, as the admin can read it."""
    path = {"catalog": "catalogs", "schema": "schemas", "table": "tables"}[kind]
    try:
        return str(workspace.call("GET", f"/api/2.1/unity-catalog/{path}/{full_name}").get("owner") or "unknown")
    except ApiError:
        return "unknown"


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


def connect(token: str, user: Workspace, admin_user_name: str, catalog: str, schema: str, warehouse_id: str) -> ConnectResult:
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
    })
    binding_id = str(registered["binding_id"])
    agent = registered["agent"]
    scope = str(agent["secret_scope"])
    if scope != store.SCOPE:
        raise ValueError("Connect named a scope this app does not keep its sign-ins in")
    # AUTH-012: each register revokes every earlier key, and the scope keeps the last write. So a
    # Connect writes its key under a name of its own and never overwrites another writer's; the
    # agent tries every such key and keeps the one BenchRouter accepts (benchrouter_databricks.agent).
    # The key goes in before the GRANTs, so a refused GRANT never strands the agent.
    store.ensure_scope(app)
    app.secret_put(scope, f"{agent['poll_key_secret']}-{secrets.token_hex(8)}", str(registered["poll_key"]))
    refusal = run_grants(user, warehouse_id, registered["grants"]["statements"],
                         [("catalog", catalog), ("schema", f"{catalog}.{schema}")])
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


def remove_agent(app: Workspace) -> None:
    """After a Disconnect that closed at once (no agent ever polled): delete what Connect made."""
    job_id = app.find_job(AGENT_JOB_NAME)
    if job_id is not None:
        app.delete_job(job_id)
    app.scope_delete(store.SCOPE)


# Add eval (plan section 4.4).
@dataclass
class SecretCheck:
    env: str
    scope: str
    key: str
    readable: bool


@dataclass
class EvalManifest:
    cases_table: str
    secrets: list[dict[str, str]]


class ManifestInvalid(Exception):
    pass


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestInvalid(f"{label} must be a mapping.")
    return value


def read_manifest(workspace: Workspace, folder: str, route_key: str) -> EvalManifest:
    """Reads the route's entry of `<folder>/.benchrouter/benchrouter.yml`, the GitHub schema.

    The app reads only what Add eval must share or check: `eval_pack.databricks.cases_table`, and
    each `eval_pack.executable.secret_env` name, whose value is the key of that name in
    `eval_pack.databricks.secret_scope` (as a GitHub repository secret has the env's name). The
    rest of the manifest is the runner's (B6).
    """
    path = f"{folder}/{EVAL_MANIFEST}"
    try:
        answer = workspace.call("GET", "/api/2.0/workspace/export", query={"path": path, "format": "SOURCE"})
    except ApiError as error:
        if is_not_found(error):
            raise ManifestInvalid(f"{path} was not found.") from None
        raise
    try:
        parsed = yaml.safe_load(base64.b64decode(answer.get("content") or ""))
    except yaml.YAMLError:
        raise ManifestInvalid(f"{EVAL_MANIFEST} is not valid YAML.") from None
    routes = _mapping(parsed, EVAL_MANIFEST).get("routes")
    entry = next((route for route in routes if isinstance(route, dict) and route.get("route_id") == route_key), None) \
        if isinstance(routes, list) else None
    if entry is None:
        raise ManifestInvalid(f"{EVAL_MANIFEST} declares no route with route_id {route_key}.")
    pack = _mapping(entry.get("eval_pack"), "eval_pack")
    databricks = _mapping(pack.get("databricks"), "eval_pack.databricks")
    cases_table = databricks.get("cases_table")
    try:
        quote_full_name(cases_table if isinstance(cases_table, str) else "")
    except ValueError:
        raise ManifestInvalid("eval_pack.databricks.cases_table must name a Unity Catalog table as <catalog>.<schema>.<table>.") from None
    executable = pack.get("executable")
    names = (executable.get("secret_env") or []) if isinstance(executable, dict) else []
    if not isinstance(names, list) or not all(isinstance(name, str) and name for name in names):
        raise ManifestInvalid("eval_pack.executable.secret_env must be a list of names.")
    scope = databricks.get("secret_scope")
    if names and not (isinstance(scope, str) and scope):
        raise ManifestInvalid("eval_pack.databricks.secret_scope must name the scope that holds the secret_env values.")
    return EvalManifest(cases_table, [{"env": name, "scope": scope, "key": name} for name in names])


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


def check_secrets(app: Workspace, declared: list[dict[str, str]]) -> list[SecretCheck]:
    """Which named secrets the app SP can read. Lists key names only; reads no value."""
    keys_by_scope: dict[str, set[str] | None] = {}
    checks = []
    for secret in declared:
        scope = secret["scope"]
        if scope not in keys_by_scope:
            try:
                listed = app.call("GET", "/api/2.0/secrets/list", query={"scope": scope}).get("secrets") or []
                keys_by_scope[scope] = {str(entry.get("key")) for entry in listed}
            except ApiError:
                keys_by_scope[scope] = None
        keys = keys_by_scope[scope]
        checks.append(SecretCheck(secret["env"], scope, secret["key"], keys is not None and secret["key"] in keys))
    return checks
