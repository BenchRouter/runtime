"""One handler per work-item kind (docs/plan-databricks-integration.md, section 4.2).

Each handler applies what its payload names, as the app SP, and is idempotent by object
name: a re-delivered item (a lost report, an ended lease) finds the object it made and
updates it, or finds it gone and moves on. A handler returns the report result and an
optional step that runs after the report answers. It raises `Failed` with a fixed code
for a refusal that a repeat would not fix; any other error leaves the item unreported, so
its lease ends and BenchRouter hands it out again (at most five times).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .transport import ApiError, with_retries
from .workspace import StatementFailed, Workspace, quote_full_name, quote_identifier, split_full_name

# Plan section 4.5: the only column types a results table may declare.
COLUMN_TYPES = {"STRING", "BIGINT", "DOUBLE", "BOOLEAN", "TIMESTAMP", "DATE", "DECIMAL(18,6)", "MAP<STRING, DOUBLE>"}
CHAT_API_TYPE = "openai/v1/chat/completions"


class Failed(Exception):
    """A permanent refusal, reported as `failed` with a fixed code (DATA-001: no free text)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


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
    """`run-now` with BenchRouter's token; a repeat returns the same run (plan 4.3)."""
    claim_id = text(payload, "claim_id")
    job_parameters = payload.get("job_parameters")
    if not isinstance(job_parameters, dict) or not all(isinstance(value, str) for value in job_parameters.values()):
        raise Failed("payload_invalid")
    run_id = permanent("run_now", lambda: ctx.workspace.run_now(
        integer(payload, "job_id"), job_parameters, text(payload, "idempotency_token")))

    def release_key(answer: dict[str, Any]) -> None:
        # The answer carries the bootstrap key only once BenchRouter recorded this run.
        key = answer.get("bootstrap_key")
        if isinstance(key, str) and key:
            with_retries(lambda: ctx.workspace.secret_put(ctx.scope, f"claim-{claim_id}", key))

    return Outcome({"run_id": run_id}, release_key)


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
    path = text(payload, "path")
    if not path.startswith("/Shared/"):
        # Plan 4.5: the app SP's home folder is deleted with the app.
        raise Failed("experiment_path_invalid")
    experiment_id = permanent("experiment", lambda: ctx.workspace.ensure_experiment(path))
    reader = optional_text(payload, "read_principal")
    if reader is not None:
        permanent("experiment_grant", lambda: ctx.workspace.grant_experiment(experiment_id, reader, "CAN_READ"))
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


def setup_results_table(ctx: Context, payload: dict[str, Any]) -> Outcome:
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
    reader = optional_text(payload, "read_principal")
    if reader is not None:
        try:
            principal = quote_identifier(reader)
        except ValueError:
            raise Failed("identifier_invalid") from None
        run_sql(ctx, warehouse_id, "grant_select", f"GRANT SELECT ON TABLE {quoted} TO {principal}")
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


def apply_exposure(ctx: Context, payload: dict[str, Any]) -> dict[str, Any]:
    """Creates or updates both objects of an exposed route with the item's runtime key."""
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
    if current is None:
        current = permanent("endpoint_create", lambda: ws.create_endpoint(endpoint, config))
    else:
        permanent("endpoint_update", lambda: ws.update_endpoint_config(endpoint, config))

    service_config = provider_service_config(route_key, api_base, runtime_key)
    if permanent("service_get", lambda: ws.get_provider_service(service)) is None:
        permanent("service_create", lambda: ws.create_provider_service(service, service_config))
    else:
        permanent("service_update", lambda: ws.update_provider_service(service, service_config))

    querier = optional_text(payload, "query_principal")
    if querier is not None:
        endpoint_id = current.get("id")
        if isinstance(endpoint_id, str):
            permanent("endpoint_grant", lambda: ws.grant_endpoint(endpoint_id, querier, "CAN_QUERY"))
    managers = payload.get("manage_principals") or []
    if not isinstance(managers, list) or not all(isinstance(name, str) and name for name in managers):
        raise Failed("payload_invalid")
    # B0 (plan A.6, P5): an admin can delete a provider service the app SP owns only with
    # an explicit MANAGE grant, and its owner cannot change. The `admins` group cannot take
    # a grant (plan 4.6), so the payload names each principal; each setup and rotation
    # grants again.
    changes = [{"principal": name, "add": ["MANAGE"]} for name in managers]
    if querier is not None:
        changes.append({"principal": querier, "add": ["EXECUTE"]})
    if changes:
        permanent("service_grant", lambda: ws.grant_provider_service(service, changes))
    return {"object": endpoint, "endpoint_name": endpoint, "service_name": service}


def setup_serving_endpoint(ctx: Context, payload: dict[str, Any]) -> Outcome:
    return Outcome(apply_exposure(ctx, payload))


SETUP_OBJECTS: dict[str, Callable[[Context, dict[str, Any]], Outcome]] = {
    "experiment": setup_experiment,
    "volume": setup_volume,
    "results_table": setup_results_table,
    "eval_job": setup_eval_job,
    "serving_endpoint": setup_serving_endpoint,
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

def visible_record(step: str, call: Callable[[], Any]) -> Any:
    """Reads a record Disconnect hands over. The app SP can always see what it owns, so 403 or 404
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
    """Plan 4.7: the app SP deletes what it created and hands the records to the admin's group."""
    ws = ctx.workspace
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
    eval_job_id = payload.get("eval_job_id")
    if isinstance(eval_job_id, int) and eval_job_id > 0:
        permanent("jobs_delete", lambda: ws.delete_job(eval_job_id))

    # The results are the customer's records: they stay, handed to the named owner. With no
    # owner (a Disconnect from the dashboard), they stay with the app SP for an admin. A record
    # the app SP can no longer see was handed over already (a Disconnect, then a Reconnect that
    # reused it): it is someone else's, so it is skipped (B7 smoke). A record it can see, it must
    # hand over: any refusal there fails the item.
    owner = optional_text(payload, "results_owner")
    warehouse_id = optional_text(payload, "warehouse_id")
    table = text(payload, "results_table")
    if owner is not None and warehouse_id is not None and visible_record("table_get", lambda: ws.table_exists(table)):
        try:
            statement = f"ALTER TABLE {quote_full_name(table)} OWNER TO {quote_identifier(owner)}"
        except ValueError:
            raise Failed("identifier_invalid") from None
        run_sql(ctx, warehouse_id, "table_owner", statement)
    experiment_id = visible_record("experiment_get", lambda: ws.find_experiment(text(payload, "experiment_path")))
    if owner is not None and experiment_id is not None:
        permanent("experiment_grant", lambda: ws.grant_experiment(experiment_id, owner, "CAN_MANAGE"))

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
