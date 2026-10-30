"""RUN-001 / DATA-001: fixed UPDATE statements through the real Statement API client.

The B11 recording has successful statement status but no affected-row answer for UPDATE.
Report the number of statements. SQLite executes the emitted UPDATE too, to prove NULL
preservation, duplicate job rows, idempotency and the columns the handler must leave alone.
"""

import json
import sqlite3
import unittest
from pathlib import Path

from benchrouter_databricks.agent import BenchRouter, handle_item
from benchrouter_databricks.handlers import Context, setup
from benchrouter_databricks.workspace import StatementFailed
from tests.recorded_workspace import RecordedServer

FIXTURES = Path(__file__).parent / "fixtures"
SUCCEEDED = json.loads((FIXTURES / "reinstall" / "answers.json").read_text())["statement_succeeded"]
REFUSED = json.loads((FIXTURES / "handover" / "visible_table_owner_refused.json").read_text())["owner_statement"]


class ResultsUpdateTest(unittest.TestCase):
    def setUp(self):
        self.server = RecordedServer({"POST /api/2.0/sql/statements": SUCCEEDED})
        self.ctx = Context(self.server.workspace(), "scope", 99)

    def tearDown(self):
        self.server.close()

    def payload(self):
        return {
            "object": "results_update", "warehouse_id": "warehouse", "table": "main.evals.results", "result_set_id": "set",
            "set_state": "published", "chosen_model": "candidate", "decision": "keep", "decision_reason": "baseline_kept",
            "serving_model": "candidate", "route_runtime_cost_usd_30d": 0.2, "benchrouter_url": "https://example.com/route",
            "rows": [
                {"candidate_model": "candidate", "role": "incumbent", "measured": True, "unmeasured_cause": None,
                 "cases": 2, "cases_passed": 1, "pass_rate": 0.5, "primary_metric": "correctness/mean", "primary_score": 0,
                 "eval_cost_usd": 0, "latency_p50_ms": 10.5, "latency_p95_ms": 20.5, "on_frontier": False, "is_chosen": True},
                {"candidate_model": "missing", "role": "challenger", "measured": None, "unmeasured_cause": "not_measured",
                 "cases": None, "cases_passed": None, "pass_rate": None, "primary_metric": None, "primary_score": None,
                 "eval_cost_usd": None, "latency_p50_ms": None, "latency_p95_ms": None, "on_frontier": False, "is_chosen": False},
            ],
        }

    def test_updates_each_model_preserves_null_measurements_and_run_data_and_repeats(self):
        payload = self.payload()
        self.assertEqual(setup(self.ctx, payload).result, {"object": "results_update", "rows_updated": 2})
        first = [body for _, path, _, body in self.server.calls if path == "/api/2.0/sql/statements"]
        self.assertEqual(len(first), 2)
        statement = first[0]["statement"]
        assignments = {
            "set_state": "CAST(:set_state AS STRING)", "role": "CAST(:role AS STRING)", "measured": "COALESCE(CAST(:measured AS BOOLEAN), `measured`)",
            "unmeasured_cause": "CAST(:unmeasured_cause AS STRING)", "cases": "COALESCE(CAST(:cases AS BIGINT), `cases`)",
            "cases_passed": "COALESCE(CAST(:cases_passed AS BIGINT), `cases_passed`)", "pass_rate": "COALESCE(CAST(:pass_rate AS DOUBLE), `pass_rate`)",
            "primary_metric": "COALESCE(CAST(:primary_metric AS STRING), `primary_metric`)", "primary_score": "COALESCE(CAST(:primary_score AS DOUBLE), `primary_score`)",
            "eval_cost_usd": "COALESCE(CAST(:eval_cost_usd AS DECIMAL(18,6)), `eval_cost_usd`)", "latency_p50_ms": "COALESCE(CAST(:latency_p50_ms AS DOUBLE), `latency_p50_ms`)",
            "latency_p95_ms": "COALESCE(CAST(:latency_p95_ms AS DOUBLE), `latency_p95_ms`)", "on_frontier": "CAST(:on_frontier AS BOOLEAN)", "is_chosen": "CAST(:is_chosen AS BOOLEAN)",
            "chosen_model": "CAST(:chosen_model AS STRING)", "decision": "CAST(:decision AS STRING)", "decision_reason": "CAST(:decision_reason AS STRING)", "serving_model": "CAST(:serving_model AS STRING)",
            "route_runtime_cost_usd_30d": "COALESCE(CAST(:route_runtime_cost_usd_30d AS DECIMAL(18,6)), `route_runtime_cost_usd_30d`)", "benchrouter_url": "CAST(:benchrouter_url AS STRING)",
        }
        self.assertEqual(statement, "UPDATE `main`.`evals`.`results` SET " + ", ".join(f"`{name}` = {value}" for name, value in assignments.items()) +
                         " WHERE result_set_id = :result_set_id AND candidate_model = :candidate_model")
        parameters = {entry["name"]: entry for entry in first[0]["parameters"]}
        self.assertEqual(parameters["measured"], {"name": "measured", "type": "BOOLEAN", "value": "true"})
        self.assertEqual(parameters["on_frontier"], {"name": "on_frontier", "type": "BOOLEAN", "value": "false"})
        self.assertEqual(parameters["eval_cost_usd"], {"name": "eval_cost_usd", "type": "DECIMAL(18,6)", "value": "0"})
        self.assertEqual(parameters["cases"], {"name": "cases", "type": "BIGINT", "value": "2"})
        self.assertEqual(parameters["unmeasured_cause"], {"name": "unmeasured_cause", "type": "STRING"})
        self.assertEqual({entry["name"] for entry in first[1]["parameters"] if "value" not in entry},
                         {"measured", "cases", "cases_passed", "pass_rate", "primary_metric", "primary_score", "eval_cost_usd", "latency_p50_ms", "latency_p95_ms"})
        with sqlite3.connect(":memory:") as db:
            # SQLite accepts one attached schema: use the same leaf name, preserving the UPDATE body.
            db.execute("ATTACH DATABASE ':memory:' AS main_catalog")
            columns = ", ".join(f"`{name}`" for name in assignments)
            db.execute(f"CREATE TABLE main_catalog.results ({columns}, result_set_id, candidate_model, metrics, job_run_id, claim_id, written_at)")
            for job, model in ((1, "candidate"), (2, "candidate"), (3, "missing"), (4, "unrelated")):
                db.execute("INSERT INTO main_catalog.results (result_set_id, candidate_model, measured, primary_score, eval_cost_usd, metrics, job_run_id, claim_id, written_at) VALUES (?, ?, 1, 0.75, 0.4, ?, ?, 'claim', 'written')",
                           ("set", model, '{"local":1}', job))
            for _ in range(2):
                for body in first:
                    # SQLite uses TEXT for strings and integers for booleans.
                    values = {entry["name"]: int(entry["value"] == "true") if entry["type"] == "BOOLEAN" and "value" in entry else entry.get("value")
                              for entry in body["parameters"]}
                    db.execute(body["statement"].replace("`main`.`evals`.`results`", "main_catalog.results").replace(" AS STRING)", " AS TEXT)"), values)
            rows = db.execute("SELECT candidate_model, set_state, primary_score, eval_cost_usd, metrics, job_run_id, claim_id, written_at FROM main_catalog.results ORDER BY job_run_id").fetchall()
            self.assertEqual(rows, [
                ("candidate", "published", 0, 0, '{"local":1}', 1, "claim", "written"),
                ("candidate", "published", 0, 0, '{"local":1}', 2, "claim", "written"),
                ("missing", "published", 0.75, 0.4, '{"local":1}', 3, "claim", "written"),
                ("unrelated", None, 0.75, 0.4, '{"local":1}', 4, "claim", "written"),
            ])
        setup(self.ctx, payload)
        self.assertEqual([body for _, path, _, body in self.server.calls if path == "/api/2.0/sql/statements"], first + first)

    def test_statement_failure_leaves_the_item_unreported(self):
        self.server.answers["POST /api/2.0/sql/statements"] = {"status": 200, "body": REFUSED}
        with self.assertRaises(StatementFailed) as failure:
            setup(self.ctx, self.payload())
        self.assertEqual(failure.exception.code, "BAD_REQUEST")
        self.server.calls.clear()
        handle_item(self.ctx, BenchRouter(self.server.base), "test-poll-key", {
            "id": "recorded-item", "lease_id": "recorded-lease", "kind": "setup", "payload": self.payload(),
        })
        self.assertEqual(self.server.paths(), [("POST", "/api/2.0/sql/statements")])


if __name__ == "__main__":
    unittest.main()
