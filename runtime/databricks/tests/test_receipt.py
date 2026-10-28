"""The receipt adapter on a recorded MLflow result (plan 4.4: all-pass, partial, judge error,
categorical and out-of-range values). The recording holds, per case, the assessments of five
scorers: `exact` (True, False, True), `always` (True), `tone` ("good", "good", "maybe"),
`rating` (7, 3, 12) and `broken` (a judge that raised: value null, SCORER_ERROR), plus the
case's HUMAN expectation `answer`.
"""

import json
import os
import unittest

from benchrouter_databricks.manifest import parse_manifest
from benchrouter_databricks.receipt import Case, Unmeasured, build_receipt

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "fixtures", "mlflow-results.json"), encoding="utf-8") as handle:
    RESULTS = json.load(handle)
CASES = [Case("c1", False), Case("c2", True), Case("c3", False)]


def normalization(metrics, primary, pass_metrics, min_score=1):
    manifest = {"routes": [{"route_id": "r/k", "eval_pack": {
        "mode": "repository_executable", "api_family": "openai_chat_completions", "lockfile": "requirements.lock",
        "input_refs": ["p.py"], "acceptance_refs": ["s.py"], "primary_metric": primary,
        "databricks": {
            "cases_table": "c.s.t", "cases": {"id_column": "id", "inputs_column": "inputs"},
            "predict": {"file": "p.py", "function": "predict_fn"}, "scorers": {"file": "s.py", "attribute": "SCORERS"},
            "normalization": {"version": 1, "metrics": metrics, "pass_rule": {"metrics": pass_metrics, "min_score": min_score}},
        },
    }}]}
    return parse_manifest(manifest, "r/k").normalization


def receipt(metrics, primary, pass_metrics, min_score=1, results=RESULTS):
    return build_receipt(CASES, results, normalization(metrics, primary, pass_metrics, min_score))


def scores(value):
    return [(row["id"], row["pass"], row["score"]) for row in value["observations"]]


class ReceiptTest(unittest.TestCase):
    def test_all_pass(self):
        value = receipt([{"name": "always", "assessment": "always", "type": "boolean"}], "always", ["always"])
        self.assertEqual(scores(value), [("c1", True, 1.0), ("c2", True, 1.0), ("c3", True, 1.0)])
        self.assertEqual(value["primary_metric"], {"name": "always", "score": 1.0})
        self.assertEqual([row["critical"] for row in value["observations"]], [False, True, False])

    def test_partial(self):
        value = receipt([{"name": "exact", "assessment": "exact", "type": "boolean"}], "exact", ["exact"])
        self.assertEqual(scores(value), [("c1", True, 1.0), ("c2", False, 0.0), ("c3", True, 1.0)])
        self.assertAlmostEqual(value["metrics"]["exact"], 2 / 3)

    def test_judge_error_is_a_measurement_failure_never_a_no(self):
        metrics = [{"name": "always", "assessment": "always", "type": "boolean"},
                   {"name": "judge", "assessment": "broken", "type": "boolean"}]
        with self.assertRaises(Unmeasured) as raised:
            receipt(metrics, "always", ["always"])
        self.assertEqual((raised.exception.code, raised.exception.case_id, raised.exception.metric), ("assessment_failed", "c1", "judge"))
        # An optional metric's failure leaves it out of the aggregate; it never scores 0.
        metrics[1]["required"] = False
        value = receipt(metrics, "always", ["always"])
        self.assertNotIn("judge", value["metrics"])
        self.assertEqual(scores(value), [("c1", True, 1.0), ("c2", True, 1.0), ("c3", True, 1.0)])

    def test_categorical(self):
        mapped = [{"name": "tone", "assessment": "tone", "type": "categorical", "values": {"good": 1, "maybe": 0.5}}]
        value = receipt(mapped, "tone", ["tone"])
        self.assertEqual(scores(value), [("c1", True, 1.0), ("c2", True, 1.0), ("c3", False, 0.5)])
        unmapped = [{"name": "tone", "assessment": "tone", "type": "categorical", "values": {"good": 1}}]
        with self.assertRaises(Unmeasured) as raised:
            receipt(unmapped, "tone", ["tone"])
        self.assertEqual(raised.exception.code, "assessment_value_unmapped")

    def test_numeric_range_and_direction(self):
        with self.assertRaises(Unmeasured) as raised:
            receipt([{"name": "rating", "assessment": "rating", "type": "numeric", "range": [0, 10]}], "rating", ["rating"])
        self.assertEqual((raised.exception.code, raised.exception.case_id), ("assessment_out_of_range", "c3"))
        value = receipt([{"name": "rating", "assessment": "rating", "type": "numeric", "range": [0, 20], "direction": "lower"}],
                        "rating", ["rating"], min_score=0.5)
        self.assertEqual(scores(value), [("c1", True, 0.65), ("c2", True, 0.85), ("c3", False, 0.4)])

    def test_expectations_never_count(self):
        # `answer` exists only as a HUMAN expectation on every case.
        with self.assertRaises(Unmeasured) as raised:
            receipt([{"name": "answer", "assessment": "answer", "type": "categorical", "values": {"yes": 1}}], "answer", ["answer"])
        self.assertEqual(raised.exception.code, "assessment_missing")

    def test_every_case_needs_its_trace(self):
        partial = {"run_id": "r", "cases": [case for case in RESULTS["cases"] if case["case_id"] != "c2"]}
        with self.assertRaises(Unmeasured) as raised:
            receipt([{"name": "always", "assessment": "always", "type": "boolean"}], "always", ["always"], results=partial)
        self.assertEqual((raised.exception.code, raised.exception.case_id), ("case_missing", "c2"))


if __name__ == "__main__":
    unittest.main()
