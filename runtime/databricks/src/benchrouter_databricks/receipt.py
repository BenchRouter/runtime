"""The receipt adapter (plan section 4.4): MLflow assessments to the executable receipt.

The evaluator child writes, per case, the assessments MLflow recorded on its trace. This
trusted step maps them, under the manifest's `normalization` block, onto the same
`benchrouter.result.v1` receipt a GitHub executable evaluator writes
(`{primary_metric, metrics, observations}`), and then reads that receipt into upload rows
exactly as runtime/src/executable.ts `readReceipt` does. So one server path takes both.

- Every case and every required metric needs exactly one assessment with no error and a
  value. Anything else makes the run unmeasured with a fixed cause (EVAL-011); a partial run
  is never aggregated.
- A failed judge records `value: null` and an `error`; that is a measurement failure, never a
  "no". `HUMAN` assessments are expectations and never count.
- BenchRouter does not derive `pass` from `score` (EVAL-002): the manifest's `pass_rule` does.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .manifest import Metric, Normalization

EXPECTATION_SOURCE = "HUMAN"


class Unmeasured(Exception):
    """The run has no complete measurement. `code` is fixed; `case_id` and `metric` are identifiers."""

    def __init__(self, code: str, case_id: str | None = None, metric: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.case_id = case_id
        self.metric = metric


@dataclass(frozen=True)
class Case:
    case_id: str
    critical: bool


def metric_score(metric: Metric, value: Any) -> float:
    """One assessment value on the 0..1 scale, higher is better. Raises Unmeasured."""
    if metric.type == "boolean":
        if not isinstance(value, bool):
            raise Unmeasured("assessment_type_mismatch")
        score = 1.0 if value else 0.0
    elif metric.type == "categorical":
        if isinstance(value, bool):
            key = "true" if value else "false"
        elif isinstance(value, str):
            key = value
        else:
            raise Unmeasured("assessment_type_mismatch")
        if key not in metric.values:
            raise Unmeasured("assessment_value_unmapped")
        score = metric.values[key]
    else:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Unmeasured("assessment_type_mismatch")
        if not metric.low <= value <= metric.high:
            raise Unmeasured("assessment_out_of_range")
        score = (float(value) - metric.low) / (metric.high - metric.low)
    return 1.0 - score if metric.direction == "lower" else score


def _assessment(entries: list[dict[str, Any]], metric: Metric) -> dict[str, Any] | None:
    found = [entry for entry in entries if entry.get("name") == metric.assessment and entry.get("source_type") != EXPECTATION_SOURCE]
    if len(found) > 1:
        raise Unmeasured("assessment_duplicate", metric=metric.name)
    return found[0] if found else None


def build_receipt(cases: list[Case], results: dict[str, Any], normalization: Normalization) -> dict[str, Any]:
    """The `benchrouter.result.v1` receipt for one run. Raises Unmeasured."""
    raw_cases = results.get("cases")
    if not isinstance(raw_cases, list):
        raise Unmeasured("results_invalid")
    by_case: dict[str, list[dict[str, Any]]] = {}
    for entry in raw_cases:
        if not isinstance(entry, dict) or not isinstance(entry.get("case_id"), str) or not isinstance(entry.get("assessments"), list):
            raise Unmeasured("results_invalid")
        if entry["case_id"] in by_case:
            raise Unmeasured("case_duplicate", case_id=entry["case_id"])
        by_case[entry["case_id"]] = [item for item in entry["assessments"] if isinstance(item, dict)]
    known = {case.case_id for case in cases}
    if any(case_id not in known for case_id in by_case):
        raise Unmeasured("case_unknown")

    by_name = {metric.name: metric for metric in normalization.metrics}
    totals: dict[str, list[float]] = {metric.name: [] for metric in normalization.metrics}
    observations = []
    for case in cases:
        entries = by_case.get(case.case_id)
        if entries is None:
            raise Unmeasured("case_missing", case_id=case.case_id)
        scores: dict[str, float] = {}
        for metric in normalization.metrics:
            found = _assessment(entries, metric)
            failed = found is None or found.get("error") is not None or found.get("value") is None
            if failed:
                if metric.required:
                    code = "assessment_missing" if found is None else "assessment_failed"
                    raise Unmeasured(code, case_id=case.case_id, metric=metric.name)
                continue
            try:
                scores[metric.name] = metric_score(metric, found["value"])
            except Unmeasured as error:
                if metric.required:
                    raise Unmeasured(error.code, case_id=case.case_id, metric=metric.name) from None
                continue
            totals[metric.name].append(scores[metric.name])
        passed = all(scores[name] >= normalization.min_score for name in normalization.pass_metrics)
        observations.append({
            "id": case.case_id,
            "version": "1",
            "pass": passed,
            "score": scores[normalization.primary_metric],
            "critical": case.critical,
        })
    metrics = {name: sum(values) / len(values) for name, values in totals.items() if values and name in by_name}
    return {
        "primary_metric": {"name": normalization.primary_metric, "score": metrics[normalization.primary_metric]},
        "metrics": metrics,
        "observations": observations,
    }


def _score(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise Unmeasured("receipt_invalid")
    return float(value)


def _is_metric_name(name: str) -> bool:
    if not 0 < len(name) <= 64 or not (("A" <= name[0] <= "Z") or ("a" <= name[0] <= "z")):
        return False
    return all(("A" <= c <= "Z") or ("a" <= c <= "z") or ("0" <= c <= "9") or c in "_.-" for c in name)


def read_receipt(receipt: dict[str, Any], primary_metric: str, model: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """runtime/src/executable.ts `readReceipt`: the receipt as upload rows and the quality object.

    The Databricks rows leave out `raw_output` and `judge_cost_usd` entirely: the server refuses
    either key on a Databricks upload (DATA-001), even as null.
    """
    primary = receipt.get("primary_metric")
    if not isinstance(primary, dict) or primary.get("name") != primary_metric:
        raise Unmeasured("receipt_invalid")
    primary_score = _score(primary.get("score"))
    raw_metrics = receipt.get("metrics", {})
    if not isinstance(raw_metrics, dict):
        raise Unmeasured("receipt_invalid")
    metrics = {}
    for name, value in raw_metrics.items():
        if not _is_metric_name(name):
            raise Unmeasured("receipt_invalid")
        metrics[name] = _score(value)
    observations = receipt.get("observations", [])
    if not isinstance(observations, list):
        raise Unmeasured("receipt_invalid")
    rows = []
    for index, entry in enumerate(observations):
        if not isinstance(entry, dict) or not isinstance(entry.get("pass"), bool):
            raise Unmeasured("receipt_invalid")
        value = (1.0 if entry["pass"] else 0.0) if entry.get("score") is None else _score(entry["score"])
        case_id = entry.get("id") if isinstance(entry.get("id"), str) and entry.get("id") else str(index + 1)
        version = entry.get("version") if isinstance(entry.get("version"), str) and entry.get("version") else "1"
        rows.append({
            "case_id": case_id,
            "case_version": version,
            "critical": entry.get("critical") is True,
            "model": model,
            "selected_model": model,
            # The server derives the call set from its own rows; the evaluator never echoes call ids.
            "model_call_ids": [],
            "pass": entry["pass"],
            "score": value,
            "cost_usd": None,
            "latency_ms": None,
            "error": None,
            "outcome_code": None,
        })
    return rows, {"primary_metric": {"name": primary_metric, "score": primary_score}, "metrics": metrics}
