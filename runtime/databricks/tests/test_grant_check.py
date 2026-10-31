"""Plan 4.4: the agent checks the eval's grants as the agent SP before `run-now`.

A refresh launch checks what the refresh reads (the folder's manifest, its cases table, its
secrets); a work launch checks what the work run reads (the frozen artifact's secrets), the same
check the runner makes before `ready`, so the two never disagree on a manifest that changed.

A missing grant starts no run: the agent reports `grant_needed` with each missing grant named by
kind and identifier, and BenchRouter queues the launch again (src/databricks/queue.ts). A passing
check, a manifest that is missing or refused for a reason that is not a grant, and a launch from a
server that names no folder all go on to `run-now` as before. The check lists key names only and
never reads a secret value. The workspace and BenchRouter answers are replayed over a local socket
through the agent's own HTTP clients.
"""

import base64
import unittest

from benchrouter_databricks.agent import BenchRouter, handle_item
from benchrouter_databricks.handlers import Context
from tests.recorded_workspace import GRANT_ANSWERS, RecordedServer
from tests.eval_manifest import MANIFEST, ROUTE, FOLDER

EXPORT = "GET /api/2.0/workspace/export"
TABLE = "GET /api/2.1/unity-catalog/tables/main.support.triage_cases"
SCOPE_LIST = "GET /api/2.0/secrets/list"
RUN_NOW = "POST /api/2.2/jobs/run-now"
DIGEST = "d" * 64
FROZEN = f"GET /api/2.0/fs/files/Volumes/main/benchrouter/benchrouter_artifacts/{DIGEST}/files/.benchrouter/benchrouter.yml"
REPORT = "POST /v1/databricks/report"


def launch_item(payload_extra: dict | None = None) -> dict:
    payload = {
        "claim_id": "rclm_recorded", "purpose": "snapshot_refresh", "eval_id": "dbxe_recorded", "revision": 1, "job_id": 424242,
        "job_parameters": {"benchrouter_claim": "rclm_recorded"}, "idempotency_token": "a" * 64,
        "eval_folder": FOLDER, "route_key": ROUTE, "catalog": "main", "schema": "benchrouter", **(payload_extra or {}),
    }
    return {"id": "dbxw_recorded", "kind": "launch", "lease_id": "dbxl_recorded", "payload": payload}


class AgentGrantCheck(unittest.TestCase):
    def setUp(self) -> None:
        manifest = {"status": 200, "body": {"content": base64.b64encode(MANIFEST.encode()).decode()}}
        self.server = RecordedServer({
            EXPORT: manifest,
            TABLE: GRANT_ANSWERS["table_get"],
            SCOPE_LIST: {"status": 200, "body": {"secrets": [{"key": "JUDGE_API_KEY"}, {"key": "LOOKUP_TOKEN"}]}},
            RUN_NOW: GRANT_ANSWERS["run_now"],
            REPORT: {"status": 200, "body": {"item_id": "dbxw_recorded", "state": "done", "replayed": False, "bootstrap_key": None}},
        })
        self.ctx = Context(self.server.workspace(), "benchrouter", 99)
        self.benchrouter = BenchRouter(self.server.base)

    def tearDown(self) -> None:
        self.server.close()

    def run_launch(self, item: dict | None = None) -> list[dict]:
        handle_item(self.ctx, self.benchrouter, "brdp_recorded.key", item or launch_item())
        return [body for method, path, _, body in self.server.calls if f"{method} {path}" == REPORT]

    def assert_no_secret_value_read(self) -> None:
        self.assertNotIn(("GET", "/api/2.0/secrets/get"), self.server.paths())

    def test_every_grant_present_starts_the_run(self) -> None:
        reports = self.run_launch()
        self.assertIn(("POST", "/api/2.2/jobs/run-now"), self.server.paths())
        self.assertEqual(reports, [{"item_id": "dbxw_recorded", "lease_id": "dbxl_recorded", "outcome": "done", "result": {"run_id": 7701}}])
        self.assert_no_secret_value_read()

    def test_a_scope_with_no_read_grant_starts_nothing_and_names_the_scope(self) -> None:
        self.server.answers[SCOPE_LIST] = GRANT_ANSWERS["scope_refused"]
        reports = self.run_launch()
        self.assertNotIn(("POST", "/api/2.2/jobs/run-now"), self.server.paths())
        self.assertEqual(reports, [{
            "item_id": "dbxw_recorded", "lease_id": "dbxl_recorded", "outcome": "grant_needed",
            "result": {"grants": [{"kind": "secret_scope_read", "scope": "acme-evals"}]},
        }])
        # One listing per scope, however many secrets it holds.
        self.assertEqual(self.server.paths().count(("GET", "/api/2.0/secrets/list")), 1)
        self.assert_no_secret_value_read()

    def test_a_missing_key_and_a_refused_table_are_both_named(self) -> None:
        self.server.answers[SCOPE_LIST] = GRANT_ANSWERS["scope_keys"]
        self.server.answers[TABLE] = GRANT_ANSWERS["table_refused"]
        reports = self.run_launch()
        self.assertNotIn(("POST", "/api/2.2/jobs/run-now"), self.server.paths())
        self.assertEqual(reports[0]["result"], {"grants": [
            {"kind": "table_select", "table": "main.support.triage_cases"},
            {"kind": "secret_key_missing", "scope": "acme-evals", "key": "LOOKUP_TOKEN"},
        ]})

    def test_a_refused_folder_is_the_only_grant_named(self) -> None:
        self.server.answers[EXPORT] = GRANT_ANSWERS["export_refused"]
        reports = self.run_launch()
        self.assertEqual(reports[0]["outcome"], "grant_needed")
        self.assertEqual(reports[0]["result"], {"grants": [{"kind": "folder_read"}]})
        # The artifact volume (no volume yet: not a grant), then the manifest; no table or secret read.
        self.assertEqual(self.server.paths(), [
            ("GET", "/api/2.0/fs/directories/Volumes/main/benchrouter/benchrouter_artifacts"),
            ("GET", "/api/2.0/workspace/export"), ("POST", "/v1/databricks/report")])

    def test_a_folder_the_app_cannot_see_is_a_grant(self) -> None:
        self.server.answers[EXPORT] = GRANT_ANSWERS["export_missing"]
        reports = self.run_launch()
        self.assertEqual(reports[0]["result"], {"grants": [{"kind": "folder_read"}]})

    def test_a_work_launch_checks_the_frozen_artifact_not_the_folder(self) -> None:
        # The folder's manifest dropped the secret since the refresh; the frozen artifact still declares it.
        self.server.answers[FROZEN] = {"status": 200, "raw": MANIFEST}
        self.server.answers[EXPORT] = GRANT_ANSWERS["export_refused"]
        self.server.answers[SCOPE_LIST] = GRANT_ANSWERS["scope_keys"]
        reports = self.run_launch(launch_item({"purpose": "work", "artifact_digest": DIGEST, "result_set_id": "rset_recorded"}))
        self.assertEqual(reports[0]["result"], {"grants": [{"kind": "secret_key_missing", "scope": "acme-evals", "key": "LOOKUP_TOKEN"}]})
        self.assertNotIn(("GET", "/api/2.0/workspace/export"), self.server.paths())
        self.assertNotIn(("POST", "/api/2.2/jobs/run-now"), self.server.paths())
        self.assert_no_secret_value_read()

    def test_a_work_launch_whose_frozen_secrets_are_readable_runs(self) -> None:
        self.server.answers[FROZEN] = {"status": 200, "raw": MANIFEST}
        reports = self.run_launch(launch_item({"purpose": "work", "artifact_digest": DIGEST}))
        self.assertEqual(reports[0]["outcome"], "done")

    def test_a_pool_launch_holds_only_the_failing_eval_and_still_runs_the_others(self) -> None:
        # Repo work queue §10: every listed eval is checked; one failure holds that eval, and the run starts.
        other = "e" * 64
        self.server.answers[FROZEN] = {"status": 200, "raw": MANIFEST}
        self.server.answers[FROZEN.replace(DIGEST, other)] = {"status": 200, "raw": MANIFEST}
        self.server.answers[SCOPE_LIST] = [{"status": 200, "body": {"secrets": [{"key": "JUDGE_API_KEY"}, {"key": "LOOKUP_TOKEN"}]}}, GRANT_ANSWERS["scope_refused"]]
        evals = [{"eval_id": "dbxe_ok", "artifact_digest": DIGEST, "route_key": ROUTE}, {"eval_id": "dbxe_held", "artifact_digest": other, "route_key": ROUTE}]
        reports = self.run_launch(launch_item({"purpose": "work", "artifact_digest": DIGEST, "evals": evals}))
        self.assertEqual(reports[0]["outcome"], "done")
        self.assertEqual(reports[0]["result"], {"run_id": 7701, "checked_evals": ["dbxe_ok"],
                                                "held_evals": [{"eval_id": "dbxe_held", "grants": [{"kind": "secret_scope_read", "scope": "acme-evals"}]}]})

    def test_a_pool_launch_where_every_eval_fails_starts_nothing_and_reports_the_triggers_grants(self) -> None:
        self.server.answers[FROZEN] = {"status": 200, "raw": MANIFEST}
        self.server.answers[SCOPE_LIST] = GRANT_ANSWERS["scope_refused"]
        evals = [{"eval_id": "dbxe_recorded", "artifact_digest": DIGEST, "route_key": ROUTE}]
        reports = self.run_launch(launch_item({"purpose": "work", "artifact_digest": DIGEST, "evals": evals}))
        self.assertEqual(reports[0]["outcome"], "grant_needed")
        self.assertNotIn(("POST", "/api/2.2/jobs/run-now"), self.server.paths())

    def test_a_grant_check_item_reports_the_same_check_and_a_pass(self) -> None:
        # The claim-less re-check of a waiting eval: a setup item with object grant_check.
        check = {"id": "dbxw_check", "kind": "setup", "lease_id": "dbxl_check", "payload": {
            "object": "grant_check", "eval_id": "dbxe_recorded", "purpose": "snapshot_refresh",
            "eval_folder": FOLDER, "route_key": ROUTE, "artifact_digest": None, "catalog": "main", "schema": "benchrouter"}}
        self.server.answers[SCOPE_LIST] = GRANT_ANSWERS["scope_refused"]
        reports = self.run_launch(check)
        self.assertEqual(reports[-1], {"item_id": "dbxw_check", "lease_id": "dbxl_check", "outcome": "grant_needed",
                                       "result": {"grants": [{"kind": "secret_scope_read", "scope": "acme-evals"}]}})
        self.server.answers[SCOPE_LIST] = {"status": 200, "body": {"secrets": [{"key": "JUDGE_API_KEY"}, {"key": "LOOKUP_TOKEN"}]}}
        reports = self.run_launch(check)
        self.assertEqual(reports[-1]["outcome"], "done")
        self.assertEqual(reports[-1]["result"], {})
        self.assertNotIn(("POST", "/api/2.2/jobs/run-now"), self.server.paths())

    def test_a_report_names_at_most_the_server_limit(self) -> None:
        # Codex gate (PR #681): a valid manifest can declare more missing keys than one report carries.
        many = MANIFEST.replace("secret_env: [JUDGE_API_KEY, LOOKUP_TOKEN]", "secret_env: [" + ", ".join(f"KEY_{index}" for index in range(70)) + "]")
        self.server.answers[EXPORT] = {"status": 200, "body": {"content": base64.b64encode(many.encode()).decode()}}
        reports = self.run_launch()
        self.assertEqual(reports[0]["outcome"], "grant_needed")
        self.assertEqual(len(reports[0]["result"]["grants"]), 64)

    def test_a_launch_that_names_no_folder_runs_as_before(self) -> None:
        item = launch_item()
        del item["payload"]["eval_folder"]
        del item["payload"]["route_key"]
        reports = self.run_launch(item)
        self.assertEqual(self.server.paths()[0], ("POST", "/api/2.2/jobs/run-now"))
        self.assertEqual(reports[0]["outcome"], "done")


if __name__ == "__main__":
    unittest.main()
