"""One handler per work-item kind (docs/plan-databricks-integration.md, section 4.2).

Each handler applies what its payload names as the agent SP created by the CLI. It is idempotent
by object name: a re-delivered item (a lost report, an ended lease) finds the object it made and
updates it, or finds it gone and moves on. A handler returns the report result and an
optional step that runs after the report answers. It raises `Failed` with a fixed code
for a refusal that a repeat would not fix; any other error leaves the item unreported, so
its lease ends and BenchRouter hands it out again (at most five times).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, cast

from .transport import ApiError, with_retries
from .workspace import Principal, PrincipalGrant, StatementFailed, Workspace, cast_parameter, quote_full_name, quote_identifier, split_full_name, statement_parameter

# Plan section 4.5: the only column types a results table may declare.
COLUMN_TYPES = {"STRING", "BIGINT", "DOUBLE", "BOOLEAN", "TIMESTAMP", "DATE", "DECIMAL(18,6)", "MAP<STRING, DOUBLE>"}
CHAT_API_TYPE = "openai/v1/chat/completions"

# AUTH-012: live REST probe, 2026-10-30, evidence/h3-probe-raw.jsonl.
# c-ep-config-admin, d-ep-config-sp2-manage: both phrases distinguish a frozen endpoint.
FROZEN_ENDPOINT_PRINCIPAL_PHRASE = "Delegating principal"
FROZEN_ENDPOINT_WORKSPACE_PHRASE = "is not a member of workspace"
# c-ps-config-admin, d-ps-config-sp2; c-ps-grant-admin, d-ps-grant-sp2.
PROVIDER_UPDATE_PERMISSION_PHRASE = "caller lacks permission to update the model provider service"
PROVIDER_GRANT_MANAGE_PHRASE = "does not have MANAGE on MODEL_PROVIDER_SERVICE"


class Failed(Exception):
    """A permanent refusal, reported as `failed` with a fixed code (DATA-001: no free text)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class EndpointDeletionPending(Exception):
    """Transient: endpoint deletion is settling; leave the item unreported until its next lease."""


@dataclass
class Context:
    workspace: Workspace
    scope: str
    #: The agent job's own id, from `{{job.id}}`.
    job_id: int | None


@dataclass
class Outcome:
    result: dict[str, Any] = field(default_factory=dict)
    #: Runs with the report's answer, after the report.
    after: Callable[[dict[str, Any]], None] | None = None


def fixed_code(step: str, error: ApiError) -> str:
    return f"{step}_http_{error.status}"


def sanitized_code(value: str) -> str:
    """A report error code: lowercase letters, digits, `_` and `.`, at most 64 characters."""
    kept = []
    for char in value.lower():
        kept.append(char if ("a" <= char <= "z") or ("0" <= char <= "9") or char in "_." else "_")
    return "".join(kept)[:64] or "error"


def text(payload: dict[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value:
        raise Failed("payload_invalid")
    return value


def optional_text(payload: dict[str, Any], name: str) -> str | None:
    value = payload.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise Failed("payload_invalid")
    return value


def principal(value: Any) -> Principal:
    """AUTH-012: payload principals are typed; pre-launch, no string compatibility path."""
    if not isinstance(value, dict) or value.get("type") not in ("user", "service_principal", "group"):
        raise Failed("payload_invalid")
    name = value.get("name")
    if not isinstance(name, str) or not name.strip():
        raise Failed("payload_invalid")
    return cast(Principal, value)


def optional_principal(payload: dict[str, Any], name: str) -> Principal | None:
    value = payload.get(name)
    return None if value is None else principal(value)


def principals(payload: dict[str, Any], name: str) -> list[Principal]:
    """An optional list of typed principals; absent is none."""
    value = payload.get(name, [])
    if not isinstance(value, list):
        raise Failed("payload_invalid")
    return [principal(entry) for entry in value]


def integer(payload: dict[str, Any], name: str) -> int:
    value = payload.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise Failed("payload_invalid")
    return value


def permanent(step: str, call: Callable[[], Any]) -> Any:
    """Runs a call; a 4xx refusal becomes `Failed`, and a transient error propagates."""
    try:
        return call()
    except ApiError as error:
        if error.transient:
            raise
        raise Failed(fixed_code(step, error)) from None


# launch ------------------------------------------------------------------------------

def launch(ctx: Context, payload: dict[str, Any]) -> Outcome:
    """`run-now` with BenchRouter's token; a repeat returns the same run (plan 4.3).

    First, as the agent SP, the eval's grants (plan 4.4): a missing one raises `grants.GrantNeeded`,
    which the agent reports as `grant_needed`, and no run starts.
    """
    claim_id = text(payload, "claim_id")
    job_parameters = payload.get("job_parameters")
    if not isinstance(job_parameters, dict) or not all(isinstance(value, str) for value in job_parameters.values()):
        raise Failed("payload_invalid")
    check = launch_check(ctx, payload)
    if check is not None:
        _require_grants(with_retries(check))
    run_id = permanent("run_now", lambda: ctx.workspace.run_now(
        integer(payload, "job_id"), job_parameters, text(payload, "idempotency_token")))

    def release_key(answer: dict[str, Any]) -> None:
        # The answer carries the bootstrap key only once BenchRouter recorded this run.
        key = answer.get("bootstrap_key")
        if isinstance(key, str) and key:
            with_retries(lambda: ctx.workspace.secret_put(ctx.scope, f"claim-{claim_id}", key))

    return Outcome({"run_id": run_id}, release_key)


def _require_grants(missing: list[dict[str, str]]) -> None:
    from . import grants

    grants.require(missing)


def launch_check(ctx: Context, payload: dict[str, Any]) -> Callable[[], list[dict[str, str]]] | None:
    """Plan 4.4: the check of what this launch's run will read, or None when the payload names no target
    (BenchRouter found no eval row for it at the poll), in which case the launch runs unchecked.
    """
    from . import grants

    route_key = optional_text(payload, "route_key")
    if route_key is None:
        return None
    catalog, schema = optional_text(payload, "catalog"), optional_text(payload, "schema")
    if payload.get("purpose") == "snapshot_refresh":
        folder = optional_text(payload, "eval_folder")
        return None if folder is None else (lambda: grants.check_eval(ctx.workspace, folder, route_key, catalog, schema))
    digest = optional_text(payload, "artifact_digest")
    if catalog is None or schema is None or digest is None:
        return None
    return lambda: grants.check_frozen(ctx.workspace, catalog, schema, digest, route_key)


def grant_check(ctx: Context, payload: dict[str, Any]) -> Outcome:
    """Plan 4.4: the claim-less re-check of an eval that waits for a grant, the same check a launch makes.

    A missing grant raises `grants.GrantNeeded` (reported as `grant_needed`); a pass reports done,
    which clears the eval so BenchRouter launches it again.
    """
    check = launch_check(ctx, payload)
    if check is None:
        raise Failed("payload_invalid")
    _require_grants(with_retries(check))
    return Outcome()


def cancel(ctx: Context, payload: dict[str, Any]) -> Outcome:
    claim_id = text(payload, "claim_id")
    permanent("runs_cancel", lambda: ctx.workspace.cancel_run(integer(payload, "run_id")))
    ctx.workspace.secret_delete(ctx.scope, f"claim-{claim_id}")
    return Outcome()


# schedule ----------------------------------------------------------------------------

def schedule(ctx: Context, payload: dict[str, Any]) -> Outcome:
    if ctx.job_id is None:
        raise Failed("agent_job_id_missing")
    settings = {"schedule": {
        "quartz_cron_expression": text(payload, "quartz_cron_expression"),
        "timezone_id": text(payload, "timezone_id"),
        "pause_status": "UNPAUSED",
    }}
    permanent("jobs_update", lambda: ctx.workspace.update_job(ctx.job_id, settings))
    return Outcome()


# setup -------------------------------------------------------------------------------

def setup(ctx: Context, payload: dict[str, Any]) -> Outcome:
    handler = SETUP_OBJECTS.get(text(payload, "object"))
    if handler is None:
        raise Failed("setup_object_unknown")
    return handler(ctx, payload)


def setup_experiment(ctx: Context, payload: dict[str, Any]) -> Outcome:
    readers = principals(payload, "read_principals")
    path = text(payload, "path")
    if not path.startswith("/Shared/"):
        # Plan 4.5: the experiment must survive a change of agent SP.
        raise Failed("experiment_path_invalid")
    experiment_id = permanent("experiment", lambda: ctx.workspace.ensure_experiment(path))
    # Plan 4.5: the whole reader list each time (the recorded admins and the optional results group).
    for reader in readers:
        permanent("experiment_grant", lambda reader=reader: ctx.workspace.grant_experiment(experiment_id, reader, "CAN_READ"))
    return Outcome({"object": "experiment", "experiment_id": experiment_id})


def setup_volume(ctx: Context, payload: dict[str, Any]) -> Outcome:
    catalog, schema, name = text(payload, "catalog"), text(payload, "schema"), text(payload, "name")
    permanent("volume", lambda: ctx.workspace.ensure_volume(catalog, schema, name))
    return Outcome({"object": f"{catalog}.{schema}.{name}"})


def run_sql(ctx: Context, warehouse_id: str, step: str, statement: str) -> None:
    try:
        permanent(step, lambda: ctx.workspace.execute_sql(warehouse_id, statement))
    except StatementFailed as error:
        raise Failed(sanitized_code(f"{step}_{error.code}")) from None


# DATA-001 / plan 4.5: fixed columns only. Preserve measured values when a summary
# has no observation; unmeasured_cause must clear to NULL after a successful measure.
RESULTS_UPDATE_COLUMNS = {
    "set_state": "STRING", "role": "STRING", "measured": "BOOLEAN", "unmeasured_cause": "STRING",
    "cases": "BIGINT", "cases_passed": "BIGINT", "pass_rate": "DOUBLE", "primary_metric": "STRING",
    "primary_score": "DOUBLE", "eval_cost_usd": "DECIMAL(18,6)", "latency_p50_ms": "DOUBLE", "latency_p95_ms": "DOUBLE",
    "on_frontier": "BOOLEAN", "is_chosen": "BOOLEAN", "chosen_model": "STRING", "decision": "STRING",
    "decision_reason": "STRING", "serving_model": "STRING", "route_runtime_cost_usd_30d": "DECIMAL(18,6)",
    "benchrouter_url": "STRING",
}
RESULTS_MEASURED_COLUMNS = {
    "measured", "cases", "cases_passed", "pass_rate", "primary_metric", "primary_score",
    "eval_cost_usd", "latency_p50_ms", "latency_p95_ms", "route_runtime_cost_usd_30d",
}
RESULTS_ROW_COLUMNS = {
    "role", "measured", "unmeasured_cause", "cases", "cases_passed", "pass_rate", "primary_metric", "primary_score",
    "eval_cost_usd", "latency_p50_ms", "latency_p95_ms", "on_frontier", "is_chosen",
}


def results_update(ctx: Context, payload: dict[str, Any]) -> Outcome:
    """Update existing rows for a settled set; never insert or overwrite local run data."""
    warehouse_id = text(payload, "warehouse_id")
    result_set_id = text(payload, "result_set_id")
    rows = payload.get("rows")
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise Failed("payload_invalid")
    try:
        table = quote_full_name(text(payload, "table"))
    except ValueError:
        raise Failed("identifier_invalid") from None
    assignments = ", ".join(
        f"`{name}` = " + (f"COALESCE({cast_parameter(name, kind)}, `{name}`)"
                         if name in RESULTS_MEASURED_COLUMNS else cast_parameter(name, kind))
        for name, kind in RESULTS_UPDATE_COLUMNS.items()
    )
    statement = (f"UPDATE {table} SET {assignments} "
                 "WHERE result_set_id = :result_set_id AND candidate_model = :candidate_model")
    statements_run = 0
    for row in rows:
        parameters = [statement_parameter(name, (row if name in RESULTS_ROW_COLUMNS else payload).get(name), kind)
                      for name, kind in RESULTS_UPDATE_COLUMNS.items()]
        parameters += [statement_parameter("result_set_id", result_set_id, "STRING"),
                       statement_parameter("candidate_model", text(row, "candidate_model"), "STRING")]
        permanent("results_update", lambda: ctx.workspace.execute_sql(warehouse_id, statement, parameters))
        statements_run += 1
    # Recorded statement answers have no UPDATE affected-row count. Do not infer a wire shape.
    return Outcome({"object": "results_update", "rows_updated": statements_run})


def setup_results_table(ctx: Context, payload: dict[str, Any]) -> Outcome:
    """Plan 4.5: creates the results table, and gives its readers SELECT while the agent SP owns it.

    After a reinstall the table can belong to someone else: a Disconnect handed it to the admin's
    group, or the agent SP that made it is gone. Its owner then decides who reads it, so the agent SP
    grants no reader. Connect gave the agent SP SELECT and MODIFY on it as the admin (plan 4.2), so the
    item is done once the agent SP can see it. The owner comes from Unity Catalog `tables/get` as the
    agent SP: B11 smoke 8b recorded 403 PERMISSION_DENIED for a table the agent SP has no privilege
    on, which fails the item (`results_table_get_http_403`), and an `owner` field once it can read
    it. Before, the item ran `GRANT SELECT` on a table it did not own and failed
    `grant_select_bad_request`. MODIFY is not checked apart: a refused write shows in the results
    task, which changes no eval.
    """
    agent_principal = principal(payload.get("agent_principal"))
    if agent_principal["type"] != "service_principal":
        raise Failed("payload_invalid")
    readers = principals(payload, "read_principals")
    table = text(payload, "table")
    warehouse_id = text(payload, "warehouse_id")
    columns = payload.get("columns")
    if not isinstance(columns, list) or not columns:
        raise Failed("payload_invalid")
    try:
        definitions = []
        for column in columns:
            if not isinstance(column, dict) or column.get("type") not in COLUMN_TYPES:
                raise Failed("column_invalid")
            definitions.append(f"{quote_identifier(text(column, 'name'))} {column['type']}")
        quoted = quote_full_name(table)
    except ValueError:
        raise Failed("identifier_invalid") from None
    run_sql(ctx, warehouse_id, "create_table", f"CREATE TABLE IF NOT EXISTS {quoted} ({', '.join(definitions)})")
    found = permanent("results_table_get", lambda: ctx.workspace.call("GET", f"/api/2.1/unity-catalog/tables/{table}"))
    owner = found.get("owner") if isinstance(found, dict) else None
    if not isinstance(owner, str) or owner.lower() != agent_principal["name"].lower():
        return Outcome({"object": "results_table", "table_name": table})
    for reader in readers:
        try:
            who = quote_identifier(reader["name"])
        except ValueError:
            raise Failed("identifier_invalid") from None
        run_sql(ctx, warehouse_id, "grant_select", f"GRANT SELECT ON TABLE {quoted} TO {who}")
    return Outcome({"object": "results_table", "table_name": table})


def setup_eval_job(ctx: Context, payload: dict[str, Any]) -> Outcome:
    settings = payload.get("job_settings")
    if not isinstance(settings, dict):
        raise Failed("payload_invalid")
    name = text(settings, "name")
    existing = permanent("jobs_list", lambda: ctx.workspace.find_job(name))
    if existing is None:
        job_id = permanent("jobs_create", lambda: ctx.workspace.create_job(settings))
    else:
        permanent("jobs_reset", lambda: ctx.workspace.reset_job(existing, settings))
        job_id = existing
    return Outcome({"object": "eval_job", "job_id": job_id})


def endpoint_config(endpoint: str, route_key: str, api_base: str, runtime_key: str) -> dict[str, Any]:
    """Plan 4.6: one external model, the Custom provider, the route key as the model."""
    return {"served_entities": [{
        "name": endpoint,
        "external_model": {
            "name": route_key,
            "provider": "custom",
            "task": "llm/v1/chat",
            "custom_provider_config": {
                "custom_provider_url": f"{api_base}/v1/chat/completions",
                "bearer_token_auth": {"token_plaintext": runtime_key},
            },
        },
    }]}


def provider_service_config(route_key: str, api_base: str, runtime_key: str) -> dict[str, Any]:
    return {
        "provider_type": "EXTERNAL_MODEL_PROVIDER_TYPE_CUSTOM",
        # Unity Gateway appends the route to `base_url` (B0, plan A.6).
        "targets": [{"model": route_key, "native_api_types": [CHAT_API_TYPE], "endpoint_route": "chat/completions"}],
        "custom": {"direct": {"base_url": f"{api_base}/v1", "api_key": {"plaintext": runtime_key}}},
    }


def provider_service_change(step: str, call: Callable[[], Any]) -> Any:
    """AUTH-012, DATA-001: report an orphaned provider service with a fixed code only."""
    try:
        return call()
    except ApiError as error:
        if error.status == 403 and error.code == "PERMISSION_DENIED":
            refusal = (PROVIDER_UPDATE_PERMISSION_PHRASE if step == "service_update"
                       else PROVIDER_GRANT_MANAGE_PHRASE)
            if refusal in (error.message or ""):
                raise Failed("provider_service_unmanageable") from None
        if error.transient:
            raise
        raise Failed(fixed_code(step, error)) from None


def apply_exposure(ctx: Context, payload: dict[str, Any]) -> dict[str, Any]:
    """Creates or updates both objects of an exposed route with the item's runtime key."""
    querier = optional_principal(payload, "query_principal")
    managers = principals(payload, "manage_principals")
    endpoint = text(payload, "endpoint_name")
    service = text(payload, "provider_service")
    route_key = text(payload, "route_key")
    api_base = text(payload, "api_base")
    runtime_key = payload.get("runtime_key")
    if not isinstance(runtime_key, str) or not runtime_key:
        # BenchRouter attaches the key only while it is live.
        raise Failed("runtime_key_missing")
    try:
        split_full_name(service)
    except ValueError:
        raise Failed("identifier_invalid") from None
    ws = ctx.workspace

    config = endpoint_config(endpoint, route_key, api_base, runtime_key)
    current = permanent("endpoint_get", lambda: ws.get_endpoint(endpoint))
    if current is not None:
        try:
            ws.update_endpoint_config(endpoint, config)
        except ApiError as error:
            message = error.message or ""
            # AUTH-012, A.7: the deleted creator freezes updates for everyone. Never retry it.
            if (error.status == 403 and error.code == "PERMISSION_DENIED"
                    and FROZEN_ENDPOINT_PRINCIPAL_PHRASE in message and FROZEN_ENDPOINT_WORKSPACE_PHRASE in message):
                permanent("endpoint_delete", lambda: ws.delete_endpoint(endpoint))
                current = None
            elif error.transient:
                raise
            else:
                raise Failed(fixed_code("endpoint_update", error)) from None
    if current is None:
        try:
            current = ws.create_endpoint(endpoint, config)
        except ApiError as error:
            if error.code == "RESOURCE_ALREADY_EXISTS":
                raise EndpointDeletionPending() from None
            if error.transient:
                raise
            raise Failed(fixed_code("endpoint_create", error)) from None

    endpoint_id = current.get("id")
    if querier is not None or managers:
        if not isinstance(endpoint_id, str) or not endpoint_id:
            # The item cannot be done until its ACL is restored. A later delivery reads its id.
            raise ValueError("endpoint_id_missing")
        if querier is not None:
            permanent("endpoint_grant", lambda: ws.grant_endpoint(endpoint_id, querier, "CAN_QUERY"))
        for manager in managers:
            permanent("endpoint_grant", lambda manager=manager: ws.grant_endpoint(endpoint_id, manager, "CAN_MANAGE"))

    service_config = provider_service_config(route_key, api_base, runtime_key)
    if permanent("service_get", lambda: ws.get_provider_service(service)) is None:
        permanent("service_create", lambda: ws.create_provider_service(service, service_config))
    else:
        provider_service_change("service_update", lambda: ws.update_provider_service(service, service_config))

    # B0 (plan A.6, P5): an admin can delete a provider service the agent SP owns only with
    # an explicit MANAGE grant, and its owner cannot change. The `admins` group cannot take
    # a grant (plan 4.6), so the payload names each principal; each setup and rotation
    # grants again.
    changes: list[PrincipalGrant] = [{"principal": manager, "add": ["MANAGE"]} for manager in managers]
    if querier is not None:
        changes.append({"principal": querier, "add": ["EXECUTE"]})
    if changes:
        provider_service_change("service_grant", lambda: ws.grant_provider_service(service, changes))
    return {"object": endpoint, "endpoint_name": endpoint, "service_name": service}


def setup_serving_endpoint(ctx: Context, payload: dict[str, Any]) -> Outcome:
    return Outcome(apply_exposure(ctx, payload))


SETUP_OBJECTS: dict[str, Callable[[Context, dict[str, Any]], Outcome]] = {
    "experiment": setup_experiment,
    "volume": setup_volume,
    "results_table": setup_results_table,
    "results_update": results_update,
    "eval_job": setup_eval_job,
    "serving_endpoint": setup_serving_endpoint,
    # Plan 4.4: the claim-less re-check of an eval that waits for a grant (a setup item by object).
    "grant_check": grant_check,
}


# retire and rotate_key ----------------------------------------------------------------

def remove_exposure(ctx: Context, endpoint: str, service: str) -> None:
    """Deletes both objects of an exposure. An object already gone counts as deleted."""
    permanent("endpoint_delete", lambda: ctx.workspace.delete_endpoint(endpoint))
    permanent("service_delete", lambda: ctx.workspace.delete_provider_service(service))


def retire(ctx: Context, payload: dict[str, Any]) -> Outcome:
    remove_exposure(ctx, text(payload, "endpoint_name"), text(payload, "provider_service"))
    return Outcome()


def rotate_key(ctx: Context, payload: dict[str, Any]) -> Outcome:
    """Writes the new key into both objects; BenchRouter revokes the old key after the report."""
    apply_exposure(ctx, payload)
    return Outcome()


# disconnect --------------------------------------------------------------------------

def drop_volumes(ws: Workspace, names: list[str]) -> None:
    """Plan 4.7: deletes BenchRouter's working volumes (frozen artifacts and results hand-off).

    They are BenchRouter's scratch: every receipt reached BenchRouter before the runner wrote the
    results volume, and a later Connect freezes the artifacts again. Unity Catalog's REST delete
    needs no SQL warehouse. A volume already gone (404) counts as deleted, and one the agent SP may
    not delete (403) is not its own (an earlier agent SP made it), so both are skipped; any other
    refusal fails the item, which the next poll queues again.
    """
    for name in names:
        try:
            split_full_name(name)
        except ValueError:
            raise Failed("identifier_invalid") from None
        try:
            ws.call("DELETE", f"/api/2.1/unity-catalog/volumes/{name}")
        except ApiError as error:
            if error.transient:
                raise
            if error.status not in (403, 404):
                raise Failed(fixed_code("volume_delete", error)) from None


def visible_record(step: str, call: Callable[[], Any]) -> Any:
    """Reads a record Disconnect hands over. The agent SP can always see what it owns, so 403 or 404
    means the record is not its own: it was handed over before (a Disconnect, then a Reconnect that
    reused it). That gives None, and the handover skips it. Any other refusal fails the item (the
    next poll queues it again); a transient error propagates, so the item comes again."""
    try:
        return call()
    except ApiError as error:
        if error.transient:
            raise
        if error.status in (403, 404):
            return None
        raise Failed(fixed_code(step, error)) from None


def disconnect(ctx: Context, payload: dict[str, Any]) -> Outcome:
    """Plan 4.7: the agent SP deletes what it created and hands the records to the admin's group."""
    ws = ctx.workspace
    owner = optional_principal(payload, "results_owner")
    agent_principal = principal(payload.get("agent_principal"))
    if agent_principal["type"] != "service_principal":
        raise Failed("payload_invalid")
    runs = payload.get("cancel_runs") or []
    exposures = payload.get("exposures") or []
    if not isinstance(runs, list) or not isinstance(exposures, list):
        raise Failed("payload_invalid")
    for run in runs:
        if not isinstance(run, dict):
            raise Failed("payload_invalid")
        cancel(ctx, run)
    for exposure in exposures:
        if not isinstance(exposure, dict):
            raise Failed("payload_invalid")
        remove_exposure(ctx, text(exposure, "endpoint_name"), text(exposure, "provider_service"))
    volumes = payload.get("volumes")
    if not isinstance(volumes, list) or not all(isinstance(name, str) and name for name in volumes):
        raise Failed("payload_invalid")

    # The results are the customer's records: they stay, handed to the named owner. With no
    # owner (a Disconnect from the dashboard), they stay with the agent SP for an admin. A record
    # the agent SP can no longer see was handed over already (a Disconnect, then a Reconnect that
    # reused it): it is someone else's, so it is skipped (B7 smoke). So is a table it can see but
    # does not own: after a reinstall Connect gave this SP SELECT and MODIFY on a table a deleted
    # SP or the admin's group owns, and an `OWNER TO` would fail every cleanup (Codex gate, PR #683).
    # A table it owns, it must hand over: any refusal there fails the item.
    warehouse_id = optional_text(payload, "warehouse_id")
    table = text(payload, "results_table")
    found = visible_record("table_get", lambda: ws.call("GET", f"/api/2.1/unity-catalog/tables/{table}"))
    table_owner = found.get("owner") if isinstance(found, dict) else None
    owns_table = isinstance(table_owner, str) and table_owner.lower() == agent_principal["name"].lower()
    if owner is not None and warehouse_id is not None and owns_table:
        try:
            statement = f"ALTER TABLE {quote_full_name(table)} OWNER TO {quote_identifier(owner['name'])}"
        except ValueError:
            raise Failed("identifier_invalid") from None
        run_sql(ctx, warehouse_id, "table_owner", statement)
    experiment_id = visible_record("experiment_get", lambda: ws.find_experiment(text(payload, "experiment_path")))
    if owner is not None and experiment_id is not None:
        permanent("experiment_grant", lambda: ws.grant_experiment(experiment_id, owner, "CAN_MANAGE"))
    # Plan 4.7: after the handover, before the jobs go. A volume left behind would belong to a
    # service principal a reinstall replaces, and the next agent SP could not use it (B11 8b).
    drop_volumes(ws, volumes)
    eval_job_id = payload.get("eval_job_id")
    if isinstance(eval_job_id, int) and eval_job_id > 0:
        permanent("jobs_delete", lambda: ws.delete_job(eval_job_id))

    scope = optional_text(payload, "scope") or ctx.scope
    agent_job_id = payload.get("agent_job_id")
    own_job = agent_job_id if isinstance(agent_job_id, int) and agent_job_id > 0 else ctx.job_id

    def remove_agent(answer: dict[str, Any]) -> None:
        # After the report: the poll key is revoked, so the scope and the job go last.
        ws.scope_delete(scope)
        if own_job is not None:
            ws.delete_job(own_job)

    return Outcome({}, remove_agent)


HANDLERS: dict[str, Callable[[Context, dict[str, Any]], Outcome]] = {
    "launch": launch,
    "setup": setup,
    "retire": retire,
    "rotate_key": rotate_key,
    "cancel": cancel,
    "schedule": schedule,
    "disconnect": disconnect,
}
