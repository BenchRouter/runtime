"""The eval job's results task (plan section 4.5). `run_if: ALL_DONE`; no BenchRouter credential.

It reads what the runner parent left in `<results volume>/<claim>/<work_id>/` and writes it into the
customer's workspace, as the agent SP:

- the MLflow experiment (`/Shared/benchrouter/<binding>`): one run per work item with the
  metrics, the ledger metrics and the `benchrouter.*` tags, the per-case assessments as an
  artifact, and a copy of each case trace (`mlflow.log_trace`, request and response) with its
  assessments (`mlflow.log_feedback`, `mlflow.log_expectation`). A copy is a new trace with a
  new id, not the original span tree (plan A.6, P15).
- no table. The agent alone writes the results table, one MERGE per candidate model once the set
  settles (handlers.results_update), so a run that serves many sets leaves no row of its own.

A failed results task changes no eval, no decision and no route. It imports MLflow (the image's
trusted set) and reads the child's local store as data only; it runs no customer code.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from typing import Any

from .agent import parse_args
from .artifact import RESULTS_VOLUME, volume_root

def log(message: str, **fields: Any) -> None:
    detail = " ".join(f"{name}={value}" for name, value in fields.items())
    print(f"benchrouter-results {message} {detail}".rstrip(), flush=True)


def read_run_record(catalog: str, schema: str, claim_id: str, work_id: str | None) -> dict[str, Any] | None:
    """One item's `run.json`, read as data: `<results volume>/<claim>/<work_id>/run.json`. None when it is absent or unreadable."""
    folder = os.path.join(volume_root(catalog, schema, RESULTS_VOLUME), claim_id)
    if work_id:
        folder = os.path.join(folder, work_id)
    try:
        with open(os.path.join(folder, "run.json"), encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


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
    tags = {
        "benchrouter.route": str(record.get("route_id")),
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
    """Logs every item of the claim into the customer's experiment. A failed item loses only its MLflow data."""
    folder = os.path.join(volume_root(args["catalog"], args["schema"], RESULTS_VOLUME), args["claim"])
    try:
        names = sorted(name for name in os.listdir(folder) if os.path.isfile(os.path.join(folder, name, "run.json")))
    except FileNotFoundError:
        names = []
    if not names:
        log("nothing to write", claim=args["claim"])
        return 0
    for name in names:
        item = os.path.join(folder, name)
        try:
            with open(os.path.join(item, "run.json"), encoding="utf-8") as handle:
                record = json.load(handle)
            store = os.path.join(item, "mlflow.db")
            if not (os.path.exists(store) and record.get("mlflow_run_id")):
                continue
            with tempfile.TemporaryDirectory(prefix="benchrouter-results-") as local:
                # SQLite needs a local file system for its locks.
                copy = os.path.join(local, "mlflow.db")
                shutil.copyfile(store, copy)
                copied = copy_to_experiment(record, copy, args["experiment_path"])
            log("experiment", work=name, traces=copied)
        except Exception as error:  # noqa: BLE001 - one item's MLflow data never stops the others
            log("experiment failed", work=name, error=type(error).__name__)
    return 0


def main() -> None:
    code = run(parse_args(sys.argv[1:]))
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
