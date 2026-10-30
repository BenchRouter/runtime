"""B11 smoke 8b: a reinstall (a new app and its new SP on the same schema), with the live answers.

After Disconnect, the app's deletion and a new app's Connect, the new SP could not read the eval
folder (export answered 404 for every file), BenchRouter's two volumes (the deleted SP still owned
them: 403 READ VOLUME) or the results table (handed to the admin: 403 SELECT). The 0.2.2 grant check
passed all of it, and every run then failed: refreshes `eval_folder_unreadable`, work `tree_mutated`
(shown as "Fix the eval"), and the results task's setup `grant_select_bad_request`.

Each case replays the answers recorded live (fixtures/reinstall) over a local socket through the
agent's own HTTP clients:
- the agent's check names `folder_read` and `volume_read` and starts no run;
- the results table setup skips the reader grants on a table the agent SP does not own;
- Disconnect drops the two volumes after the handover and before the jobs go;
- the runner tells a refused volume read and a missing artifact from a digest mismatch.
"""

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from benchrouter_databricks.agent import BenchRouter, handle_item
from benchrouter_databricks.artifact import ArtifactMissing, VolumeRefused, copy_planned
from benchrouter_databricks.handlers import Context, Failed, disconnect, setup_results_table
from tests.recorded_workspace import RecordedServer
from tests.eval_manifest import MANIFEST, ROUTE, FOLDER

LIVE = json.loads((Path(__file__).parent / "fixtures" / "reinstall" / "answers.json").read_text())
AGENT_SP = LIVE["agent_principal"]["name"]
CATALOG, SCHEMA = "workspace", "br_b11"
ARTIFACTS = f"{CATALOG}.{SCHEMA}.benchrouter_artifacts"
RESULTS_VOLUME = f"{CATALOG}.{SCHEMA}.benchrouter_results"
RESULTS_TABLE = f"{CATALOG}.{SCHEMA}.benchrouter_eval_results"
DIGEST = "d" * 64
VOLUME_LIST = f"GET /api/2.0/fs/directories/Volumes/{CATALOG}/{SCHEMA}/benchrouter_artifacts"
FROZEN = f"GET /api/2.0/fs/files/Volumes/{CATALOG}/{SCHEMA}/benchrouter_artifacts/{DIGEST}/files/.benchrouter/benchrouter.yml"
STATEMENTS = "POST /api/2.0/sql/statements"
REPORT = "POST /v1/databricks/report"
RUN_NOW = ("POST", "/api/2.2/jobs/run-now")


def launch(purpose: str) -> dict:
    payload = {
        "claim_id": "rclm_8b", "purpose": purpose, "eval_id": "dbxe_8b", "revision": 2, "job_id": 424242,
        "job_parameters": {"benchrouter_claim": "rclm_8b"}, "idempotency_token": "a" * 64,
        "eval_folder": FOLDER, "route_key": ROUTE, "catalog": CATALOG, "schema": SCHEMA,
    }
    if purpose == "work":
        payload["artifact_digest"] = DIGEST
    return {"id": "dbxw_8b", "kind": "launch", "lease_id": "dbxl_8b", "payload": payload}


class NewSpGrantCheck(unittest.TestCase):
    """The agent's check before `run-now`, as the new SP (plan 4.4)."""

    def setUp(self) -> None:
        self.server = RecordedServer({
            "GET /api/2.0/workspace/export": LIVE["export_unshared"],
            "GET /api/2.0/workspace/get-status": LIVE["folder_status_unshared"],
            f"GET /api/2.1/unity-catalog/tables/main.support.triage_cases": LIVE["cases_table_no_select"],
            "GET /api/2.0/secrets/list": LIVE["scope_no_read"],
            VOLUME_LIST: LIVE["files_no_read"],
            FROZEN: LIVE["files_no_read"],
            "POST /api/2.2/jobs/run-now": {"status": 200, "body": {"run_id": 7701}},
            REPORT: {"status": 200, "body": {"item_id": "dbxw_8b", "state": "done", "replayed": False, "bootstrap_key": None}},
        })
        self.ctx = Context(self.server.workspace(), "benchrouter", 99)

    def tearDown(self) -> None:
        self.server.close()

    def reports(self, item: dict) -> list[dict]:
        handle_item(self.ctx, BenchRouter(self.server.base), "brdp_8b.key", item)
        return [body for method, path, _, body in self.server.calls if f"{method} {path}" == REPORT]

    def test_a_refresh_that_cannot_export_the_manifest_waits_for_the_folder_and_the_volume(self) -> None:
        # The folder answers 200 at get-status, but every export 404: a refused read, not a missing file.
        reports = self.reports(launch("snapshot_refresh"))
        self.assertNotIn(RUN_NOW, self.server.paths())
        self.assertEqual(reports, [{"item_id": "dbxw_8b", "lease_id": "dbxl_8b", "outcome": "grant_needed", "result": {"grants": [
            {"kind": "folder_read"}, {"kind": "volume_read", "volume": ARTIFACTS},
        ]}}])
        # With no manifest, the table and the secrets cannot be named yet (BenchRouter keeps no copy of it).
        self.assertNotIn(("GET", "/api/2.0/secrets/list"), self.server.paths())

    def test_a_work_launch_that_cannot_read_the_frozen_artifact_waits_for_the_volume(self) -> None:
        # 0.2.2 took this 403 for "not a grant" and started the run, which failed tree_mutated.
        reports = self.reports(launch("work"))
        self.assertNotIn(RUN_NOW, self.server.paths())
        self.assertEqual(reports[0]["outcome"], "grant_needed")
        self.assertEqual(reports[0]["result"], {"grants": [{"kind": "volume_read", "volume": ARTIFACTS}]})

    def test_a_work_launch_whose_artifact_is_missing_from_a_readable_volume_runs(self) -> None:
        # A missing artifact is not a grant: the run reports it (artifact_missing) and BenchRouter refreshes.
        self.server.answers[FROZEN] = LIVE["files_missing"]
        reports = self.reports(launch("work"))
        self.assertIn(RUN_NOW, self.server.paths())
        self.assertEqual(reports[0]["outcome"], "done")

    def test_a_refresh_reports_the_table_and_the_scope_once_the_folder_is_readable(self) -> None:
        import base64

        self.server.answers["GET /api/2.0/workspace/export"] = {"status": 200, "body": {"content": base64.b64encode(MANIFEST.encode()).decode()}}
        self.server.answers[VOLUME_LIST] = LIVE["files_list_readable"]
        reports = self.reports(launch("snapshot_refresh"))
        self.assertEqual(reports[0]["result"], {"grants": [
            {"kind": "table_select", "table": "main.support.triage_cases"}, {"kind": "secret_scope_read", "scope": "acme-evals"},
        ]})


class ResultsTableOwnedByTheCustomer(unittest.TestCase):
    """Plan 4.5: the results table setup on a table that Disconnect handed to the admin."""

    def setUp(self) -> None:
        self.server = RecordedServer({STATEMENTS: LIVE["statement_succeeded"]})
        self.ctx = Context(self.server.workspace(), "benchrouter", 99)
        self.payload = {"object": "results_table", "table": RESULTS_TABLE, "warehouse_id": "recorded", "agent_principal": {"type": "service_principal", "name": AGENT_SP},
                        "columns": [{"name": "written_at", "type": "TIMESTAMP"}], "read_principals": [{"type": "user", "name": "nav@benchrouter.com"}]}

    def tearDown(self) -> None:
        self.server.close()

    def statements(self) -> list[str]:
        return [body["statement"] for _, path, _, body in self.server.calls if path == "/api/2.0/sql/statements"]

    def test_without_connects_grant_the_item_fails_with_a_fixed_code(self) -> None:
        self.server.answers[f"GET /api/2.1/unity-catalog/tables/{RESULTS_TABLE}"] = LIVE["results_table_no_select"]
        with self.assertRaises(Failed) as refused:
            setup_results_table(self.ctx, self.payload)
        self.assertEqual(refused.exception.code, "results_table_get_http_403")
        self.assertEqual(len(self.statements()), 1)

    def test_a_table_someone_else_owns_gets_no_reader_grant(self) -> None:
        # After Connect's GRANT SELECT, MODIFY the agent SP can read it; its owner is the admin.
        self.server.answers[f"GET /api/2.1/unity-catalog/tables/{RESULTS_TABLE}"] = LIVE["admin_results_table_owner"]
        outcome = setup_results_table(self.ctx, self.payload)
        self.assertEqual(outcome.result, {"object": "results_table", "table_name": RESULTS_TABLE})
        self.assertEqual(len(self.statements()), 1)
        self.assertTrue(self.statements()[0].startswith("CREATE TABLE IF NOT EXISTS"))


class DisconnectDropsTheVolumes(unittest.TestCase):
    """Plan 4.7: after the handover, before the jobs; a volume gone or not the agent SP's is skipped."""

    def test_order_and_skips(self) -> None:
        server = RecordedServer({
            f"GET /api/2.1/unity-catalog/tables/{RESULTS_TABLE}": {"status": 200, "body": {"owner": AGENT_SP}},
            STATEMENTS: LIVE["statement_succeeded"],
            "GET /api/2.0/mlflow/experiments/get-by-name": {"status": 200, "body": {"experiment": {"experiment_id": "77"}}},
            "PATCH /api/2.0/permissions/experiments/77": {"status": 200, "body": {}},
            f"DELETE /api/2.1/unity-catalog/volumes/{ARTIFACTS}": {"status": 200, "body": {}},
            f"DELETE /api/2.1/unity-catalog/volumes/{RESULTS_VOLUME}": LIVE["volume_get_no_read"],
            "POST /api/2.2/jobs/delete": {"status": 200, "body": {}},
        })
        try:
            disconnect(Context(server.workspace(), "benchrouter", 99), {
                "results_owner": {"type": "user", "name": "nav@benchrouter.com"}, "warehouse_id": "recorded", "results_table": RESULTS_TABLE,
                "experiment_path": "/Shared/benchrouter/dbxb_8b", "scope": "benchrouter", "agent_job_id": 99,
                "eval_job_id": 5150, "exposures": [], "volumes": [ARTIFACTS, RESULTS_VOLUME], "agent_principal": {"type": "service_principal", "name": AGENT_SP},
            })
            steps = [(method, path) for method, path in server.paths() if method != "GET"]
        finally:
            server.close()
        self.assertEqual(steps, [
            ("POST", "/api/2.0/sql/statements"),
            ("PATCH", "/api/2.0/permissions/experiments/77"),
            ("DELETE", f"/api/2.1/unity-catalog/volumes/{ARTIFACTS}"),
            ("DELETE", f"/api/2.1/unity-catalog/volumes/{RESULTS_VOLUME}"),
            ("POST", "/api/2.2/jobs/delete"),
        ])


class DisconnectKeepsATableTheAgentSpDoesNotOwn(unittest.TestCase):
    """Codex gate (PR #683): after a reinstall Connect gave the new SP SELECT and MODIFY on a table the
    admin owns. Disconnect must not try `ALTER TABLE ... OWNER TO` on it: the SP may not, and every
    cleanup would fail. The table answer is the admin's live read of it (owner nav@benchrouter.com)."""

    def test_no_handover_statement(self) -> None:
        server = RecordedServer({
            f"GET /api/2.1/unity-catalog/tables/{RESULTS_TABLE}": LIVE["admin_results_table_owner"],
            STATEMENTS: LIVE["statement_succeeded"],
            "POST /api/2.2/jobs/delete": {"status": 200, "body": {}},
        })
        try:
            outcome = disconnect(Context(server.workspace(), "benchrouter", 99), {
                "results_owner": {"type": "user", "name": "nav@benchrouter.com"}, "warehouse_id": "recorded", "results_table": RESULTS_TABLE,
                "experiment_path": "/Shared/benchrouter/dbxb_8b", "scope": "benchrouter", "agent_job_id": 99,
                "exposures": [], "volumes": [], "agent_principal": {"type": "service_principal", "name": AGENT_SP},
            })
            statements = [body["statement"] for _, path, _, body in server.calls if path == "/api/2.0/sql/statements"]
        finally:
            server.close()
        self.assertEqual(statements, [])
        self.assertEqual(outcome.result, {})


class RunnerTellsARefusedReadFromAMismatch(unittest.TestCase):
    """The runner's artifact copy: a refused read (PermissionError through the volume mount) and a
    missing artifact each raise their own error, never `TreeMutated`."""

    def test_a_volume_the_agent_sp_may_not_read(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("root reads any directory")
        with tempfile.TemporaryDirectory() as volume:
            os.makedirs(os.path.join(volume, DIGEST))
            os.chmod(volume, 0)
            try:
                with self.assertRaises(VolumeRefused):
                    copy_planned(volume, DIGEST, os.path.join(tempfile.gettempdir(), "never-written"))
            finally:
                os.chmod(volume, stat.S_IRWXU)

    def test_a_missing_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as volume, tempfile.TemporaryDirectory() as private:
            with self.assertRaises(ArtifactMissing):
                copy_planned(volume, DIGEST, os.path.join(private, "artifact"))


if __name__ == "__main__":
    unittest.main()
