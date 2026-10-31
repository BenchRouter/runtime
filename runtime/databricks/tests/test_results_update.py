"""RUN-001 / DATA-001 (repo work queue §10): the agent is the results table's only writer.

`results_update` reads each serving run's `run.json` as data, joins the server's summary and sends one MERGE per
candidate model, through the real Statement API client against recorded answers. Nothing inside the handler is
replaced. A MERGE's ordering rule runs in the warehouse; this test proves what the handler sends, and the live
smoke proves the warehouse applies it.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from benchrouter_databricks.agent import BenchRouter, handle_item
from benchrouter_databricks.handlers import Context, results_merge_statement, setup
from benchrouter_databricks.workspace import StatementFailed
from tests.recorded_workspace import RecordedServer

FIXTURES = Path(__file__).parent / "fixtures"
SUCCEEDED = json.loads((FIXTURES / "reinstall" / "answers.json").read_text())["statement_succeeded"]
REFUSED = json.loads((FIXTURES / "handover" / "visible_table_owner_refused.json").read_text())["owner_statement"]
TABLE = "main.evals.results"


def row(model: str, claim: str | None, work: str | None, run: int | None, **overrides):
    return {"candidate_model": model, "role": "challenger", "measured": True, "unmeasured_cause": None, "cases": 2, "cases_passed": 1,
            "pass_rate": 0.5, "primary_metric": "correctness/mean", "primary_score": 0.5, "eval_cost_usd": 0.1, "latency_p50_ms": 10.5,
            "latency_p95_ms": 20.5, "on_frontier": False, "is_chosen": False, "job_run_id": run, "claim_id": claim, "work_id": work, **overrides}


class ResultsUpdateTest(unittest.TestCase):
    def setUp(self):
        self.server = RecordedServer({"POST /api/2.0/sql/statements": SUCCEEDED})
        self.ctx = Context(self.server.workspace(), "scope", 99)
        self.volumes = tempfile.TemporaryDirectory()
        os.environ["BENCHROUTER_VOLUMES_ROOT"] = self.volumes.name

    def tearDown(self):
        del os.environ["BENCHROUTER_VOLUMES_ROOT"]
        self.volumes.cleanup()
        self.server.close()

    def leave_run(self, claim: str, work: str, model: str, metrics: dict | None):
        folder = Path(self.volumes.name) / "main" / "evals" / "benchrouter_results" / claim / work
        folder.mkdir(parents=True)
        (folder / "run.json").write_text(json.dumps({"claim_id": claim, "job_run_id": 7, "work_id": work, "model": model, "metrics": metrics}))

    def payload(self, rows, state="published", written_at="2026-10-30T10:00:00.000Z"):
        return {"object": "results_update", "warehouse_id": "warehouse", "table": TABLE, "result_set_id": "set", "set_state": state,
                "written_at": written_at, "route_key": "route", "route_id": "rt", "chosen_model": "a", "decision": "keep",
                "decision_reason": None, "serving_model": "a", "route_runtime_cost_usd_30d": 0.2, "benchrouter_url": "https://example.com/r",
                "artifact_digest": "sha256:x", "acceptance_fingerprint": "fp", "rows": rows}

    def statements(self):
        return [body for _, path, _, body in self.server.calls if path == "/api/2.0/sql/statements"]

    def test_a_set_served_by_two_runs_writes_one_merge_per_model_with_its_own_run_and_metrics(self):
        self.leave_run("claim1", "w1", "a", {"correctness/mean": 0.5})
        self.leave_run("claim2", "w2", "b", {"correctness/mean": 0.9})
        payload = self.payload([row("a", "claim1", "w1", 7), row("b", "claim2", "w2", 8)])
        self.assertEqual(setup(self.ctx, payload).result, {"object": "results_update", "rows_updated": 2})
        first, second = self.statements()
        self.assertEqual(first["statement"], results_merge_statement(TABLE))
        params = lambda body: {entry["name"]: entry.get("value") for entry in body["parameters"]}
        self.assertEqual((params(first)["job_run_id"], params(first)["claim_id"], params(first)["metrics"]), ("7", "claim1", '{"correctness/mean": 0.5}'))
        self.assertEqual((params(second)["job_run_id"], params(second)["claim_id"], params(second)["metrics"]), ("8", "claim2", '{"correctness/mean": 0.9}'))
        self.assertEqual(params(first)["written_at"], "2026-10-30T10:00:00.000Z")

    def test_a_missing_run_json_leaves_the_local_metrics_null_and_a_set_no_run_served_writes_nothing(self):
        payload = self.payload([row("a", "claim1", "gone", 7), row("b", None, None, None)])
        self.assertEqual(setup(self.ctx, payload).result["rows_updated"], 1)
        (only,) = self.statements()
        metrics = next(entry for entry in only["parameters"] if entry["name"] == "metrics")
        self.assertNotIn("value", metrics)

    def test_a_repeat_sends_the_same_merges_and_the_late_closed_item_carries_its_older_summary_time(self):
        self.leave_run("claim1", "w1", "a", {"m": 1})
        published = self.payload([row("a", "claim1", "w1", 7)], "published", "2026-10-30T11:00:00.000Z")
        closed = self.payload([row("a", "claim1", "w1", 7)], "closed", "2026-10-30T10:00:00.000Z")
        for payload in (published, published, closed):
            setup(self.ctx, payload)
        sent = self.statements()
        self.assertEqual(len({body["statement"] for body in sent}), 1)
        times = [next(entry["value"] for entry in body["parameters"] if entry["name"] == "written_at") for body in sent]
        self.assertEqual(times, ["2026-10-30T11:00:00.000Z"] * 2 + ["2026-10-30T10:00:00.000Z"])
        # The statement updates a matched row only when the incoming summary is not older (decided in the warehouse).
        self.assertIn("target.`written_at` IS NULL OR source.`written_at` >= target.`written_at`", sent[0]["statement"])

    def test_the_merge_orders_by_written_at_and_adds_no_column(self):
        # Only a live warehouse can run the MERGE, so this holds its text and clause order. A 0.3.0 row has no `summary_at`
        # and holds its run's end time in `written_at`, which is older: the first update passes (RUN-001 §10).
        statement = results_merge_statement(TABLE)
        self.assertNotIn("summary_at", statement)
        matched, not_matched = statement.index("WHEN MATCHED"), statement.index("WHEN NOT MATCHED")
        guard = "WHEN MATCHED AND (target.`written_at` IS NULL OR source.`written_at` >= target.`written_at`) THEN UPDATE SET"
        self.assertEqual(statement.index(guard), matched)
        self.assertLess(matched, not_matched)
        self.assertLess(statement.index("ON target.`job_run_id`"), matched)
        assigned = statement[matched:not_matched]
        self.assertIn("target.`written_at` = source.`written_at`", assigned)
        self.assertNotIn("target.`claim_id`", assigned)
        self.assertNotIn("target.`candidate_model`", assigned)
        self.assertEqual(statement.count("ALTER TABLE"), 0)

    def test_statement_failure_leaves_the_item_unreported(self):
        self.server.answers["POST /api/2.0/sql/statements"] = {"status": 200, "body": REFUSED}
        payload = self.payload([row("a", "claim1", "w1", 7)])
        with self.assertRaises(StatementFailed) as failure:
            setup(self.ctx, payload)
        self.assertEqual(failure.exception.code, "BAD_REQUEST")
        self.server.calls.clear()
        handle_item(self.ctx, BenchRouter(self.server.base), "test-poll-key", {"id": "recorded-item", "lease_id": "recorded-lease", "kind": "setup", "payload": payload})
        self.assertEqual(self.server.paths(), [("POST", "/api/2.0/sql/statements")])


if __name__ == "__main__":
    unittest.main()
