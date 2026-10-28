"""The eval job's results task (plan section 4.5). `run_if: ALL_DONE`; no BenchRouter credential.

It reads what the runner parent left in `<results volume>/<claim>/` and writes it into the
customer's workspace, as the app SP:

- the MLflow experiment (`/Shared/benchrouter/<binding>`): one run per work item with the
  metrics, the ledger metrics and the `benchrouter.*` tags, the per-case assessments as an
  artifact, and a copy of each case trace (`mlflow.log_trace`, request and response) with its
  assessments (`mlflow.log_feedback`, `mlflow.log_expectation`). A copy is a new trace with a
  new id, not the original span tree (plan A.6, P15).
- the results table, append only: one row per candidate model of the set per job run, by
  `MERGE ... WHEN NOT MATCHED THEN INSERT` on (`job_run_id`, `result_set_id`, `candidate_model`).

A failed results task changes no eval, no decision and no route. It imports MLflow (the image's
trusted set) and reads the child's local store as data only; it runs no customer code.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any

from .agent import parse_args
from .artifact import RESULTS_VOLUME, volume_root
from .transport import with_retries
from .workspace import Workspace, quote_full_name

KEY_COLUMNS = ("job_run_id", "result_set_id", "candidate_model")


def log(message: str, **fields: Any) -> None:
    detail = " ".join(f"{name}={value}" for name, value in fields.items())
    print(f"benchrouter-results {message} {detail}".rstrip(), flush=True)


def _parameter(name: str, value: Any, kind: str) -> dict[str, Any]:
    """A typed statement parameter; a missing value is SQL NULL."""
    entry: dict[str, Any] = {"name": name, "type": kind}
    if value is not None:
        entry["value"] = ("true" if value else "false") if isinstance(value, bool) else str(value)
    return entry


def table_rows(record: dict[str, Any], written_at: str) -> list[list[dict[str, Any]]]:
    """Plan 4.5: the results table rows of one job run, as statement parameters."""
    summary = record.get("summary")
    if not isinstance(summary, dict) or not isinstance(summary.get("rows"), list):
        return []
    rows = []
    for row in summary["rows"]:
        own = row.get("candidate_model") == record.get("model")
        metrics = json.dumps(record.get("metrics")) if own and isinstance(record.get("metrics"), dict) else None
        rows.append([
            _parameter("written_at", written_at, "TIMESTAMP"),
            _parameter("job_run_id", record.get("job_run_id"), "BIGINT"),
            _parameter("claim_id", record.get("claim_id"), "STRING"),
            _parameter("route_key", summary.get("route_key"), "STRING"),
            _parameter("route_id", summary.get("route_id"), "STRING"),
            _parameter("result_set_id", summary.get("result_set_id"), "STRING"),
            _parameter("set_state", summary.get("set_state"), "STRING"),
            _parameter("artifact_digest", summary.get("artifact_digest"), "STRING"),
            _parameter("acceptance_fingerprint", summary.get("acceptance_fingerprint"), "STRING"),
            _parameter("candidate_model", row.get("candidate_model"), "STRING"),
            _parameter("role", row.get("role"), "STRING"),
            _parameter("measured", row.get("measured"), "BOOLEAN"),
            _parameter("unmeasured_cause", row.get("unmeasured_cause"), "STRING"),
            _parameter("cases", row.get("cases"), "BIGINT"),
            _parameter("cases_passed", row.get("cases_passed"), "BIGINT"),
            _parameter("pass_rate", row.get("pass_rate"), "DOUBLE"),
            _parameter("primary_metric", row.get("primary_metric"), "STRING"),
            _parameter("primary_score", row.get("primary_score"), "DOUBLE"),
            _parameter("metrics", metrics, "STRING"),
            _parameter("eval_cost_usd", row.get("eval_cost_usd"), "DECIMAL(18,6)"),
            # The ledger does not keep per-route call counts per window yet (plan 4.4).
            _parameter("eval_calls", None, "BIGINT"),
            _parameter("latency_p50_ms", row.get("latency_p50_ms"), "DOUBLE"),
            _parameter("latency_p95_ms", row.get("latency_p95_ms"), "DOUBLE"),
            _parameter("on_frontier", row.get("on_frontier"), "BOOLEAN"),
            _parameter("is_chosen", row.get("is_chosen"), "BOOLEAN"),
            _parameter("chosen_model", summary.get("chosen_model"), "STRING"),
            _parameter("decision", summary.get("decision"), "STRING"),
            _parameter("decision_reason", summary.get("decision_reason"), "STRING"),
            _parameter("serving_model", summary.get("serving_model"), "STRING"),
            _parameter("route_runtime_cost_usd_30d", summary.get("route_runtime_cost_usd_30d"), "DECIMAL(18,6)"),
            _parameter("route_runtime_calls_30d", None, "BIGINT"),
            _parameter("benchrouter_url", summary.get("benchrouter_url"), "STRING"),
        ])
    return rows


def merge_statement(table: str, parameters: list[dict[str, Any]]) -> str:
    def value(entry: dict[str, Any]) -> str:
        if entry["name"] == "metrics":
            return "from_json(:metrics, 'MAP<STRING, DOUBLE>')"
        return f"CAST(:{entry['name']} AS {entry['type']})"

    columns = [entry["name"] for entry in parameters]
    selected = ", ".join(f"{value(entry)} AS `{entry['name']}`" for entry in parameters)
    on = " AND ".join(f"target.`{name}` = source.`{name}`" for name in KEY_COLUMNS)
    names = ", ".join(f"`{name}`" for name in columns)
    sources = ", ".join(f"source.`{name}`" for name in columns)
    return (f"MERGE INTO {quote_full_name(table)} AS target USING (SELECT {selected}) AS source ON {on} "
            f"WHEN NOT MATCHED THEN INSERT ({names}) VALUES ({sources})")


def write_table(workspace: Workspace, warehouse_id: str, table: str, record: dict[str, Any]) -> int:
    written_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    rows = table_rows(record, written_at)
    for parameters in rows:
        with_retries(lambda: workspace.execute_sql(warehouse_id, merge_statement(table, parameters), parameters))
    return len(rows)


def copy_to_experiment(record: dict[str, Any], store: str, experiment_path: str, destination: str = "databricks") -> int:
    """Logs the work item's run, its traces and their assessments into the customer's experiment."""
    import mlflow
    from mlflow.entities import AssessmentSource
    from mlflow.tracking import MlflowClient

    local = MlflowClient(tracking_uri=f"sqlite:///{store}")
    traces = []
    if record.get("mlflow_run_id"):
        experiment_id = local.get_run(record["mlflow_run_id"]).info.experiment_id
        token = None
        while True:
            page = local.search_traces(locations=[experiment_id], run_id=record["mlflow_run_id"], page_token=token)
            traces.extend(page)
            token = page.token
            if not token:
                break
    mlflow.set_tracking_uri(destination)
    mlflow.set_experiment(experiment_path)
    summary = record.get("summary") or {}
    ledger = next((row for row in summary.get("rows") or [] if row.get("candidate_model") == record.get("model")), {})
    tags = {
        "benchrouter.route": str(summary.get("route_key") or record.get("route_id")),
        "benchrouter.route_id": str(summary.get("route_id") or ""),
        "benchrouter.model": str(record.get("model")),
        "benchrouter.result_set": str(record.get("result_set_id")),
        "benchrouter.work_id": str(record.get("work_id")),
        "benchrouter.artifact_digest": str(record.get("artifact_digest")),
        "benchrouter.claim": str(record.get("claim_id")),
        "benchrouter.outcome": str(record.get("outcome")),
    }
    copied = 0
    with mlflow.start_run(run_name=f"{record.get('model')} {record.get('work_id')}", tags=tags):
        metrics = {f"{name}/mean": value for name, value in (record.get("metrics") or {}).items()}
        for name in ("eval_cost_usd", "latency_p50_ms", "latency_p95_ms"):
            if isinstance(ledger.get(name), (int, float)):
                metrics[{"eval_cost_usd": "benchrouter.cost_usd"}.get(name, f"benchrouter.{name}")] = ledger[name]
        if metrics:
            mlflow.log_metrics(metrics)
        if record.get("traces") is not None:
            mlflow.log_dict({"cases": record["traces"]}, "benchrouter/assessments.json")
        pending = []
        for trace in traces:
            # One trace per case. A judge's own model call inside a scorer is traced too; it is not a case.
            case_id = trace.info.tags.get("benchrouter.case_id")
            if case_id is None:
                continue
            trace_id = mlflow.log_trace(
                name="benchrouter_case", request=trace.data.request, response=trace.data.response,
                tags={"benchrouter.case_id": case_id, "benchrouter.model": str(record.get("model"))},
                start_time_ms=trace.info.request_time, execution_time_ms=trace.info.execution_duration,
            )
            pending.append((trace_id, trace.info.assessments or []))
            copied += 1
    # Plan A.6: an assessment logged before its trace is exported gets NOT_FOUND.
    flush = getattr(mlflow, "flush_trace_async_logging", None)
    if flush is not None:
        flush()
    for trace_id, assessments in pending:
        for assessment in assessments:
            source = assessment.source or AssessmentSource(source_type="CODE")
            if getattr(assessment, "expectation", None) is not None:
                mlflow.log_expectation(trace_id=trace_id, name=assessment.name, value=assessment.expectation.value, source=source)
            elif getattr(assessment, "feedback", None) is not None:
                feedback = assessment.feedback
                mlflow.log_feedback(trace_id=trace_id, name=assessment.name, value=feedback.value, source=source,
                                    rationale=assessment.rationale, error=feedback.error)
    return copied


def run(args: dict[str, str]) -> int:
    folder = os.path.join(volume_root(args["catalog"], args["schema"], RESULTS_VOLUME), args["claim"])
    try:
        with open(os.path.join(folder, "run.json"), encoding="utf-8") as handle:
            record = json.load(handle)
    except FileNotFoundError:
        log("nothing to write", claim=args["claim"])
        return 0
    rows = write_table(Workspace.from_runtime(), args["warehouse_id"], args["results_table"], record)
    log("table rows", rows=rows)
    store = os.path.join(folder, "mlflow.db")
    if os.path.exists(store) and record.get("mlflow_run_id"):
        with tempfile.TemporaryDirectory(prefix="benchrouter-results-") as local:
            # SQLite needs a local file system for its locks.
            copy = os.path.join(local, "mlflow.db")
            shutil.copyfile(store, copy)
            copied = copy_to_experiment(record, copy, args["experiment_path"])
        log("experiment", traces=copied)
    return 0


def main() -> None:
    code = run(parse_args(sys.argv[1:]))
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
