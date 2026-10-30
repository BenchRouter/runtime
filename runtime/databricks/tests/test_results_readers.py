"""Plan 4.5: the results table and the experiment are granted to every reader in the payload.

The readers are the recorded admins and the binding's optional results group. A group Databricks
does not know fails the item with a fixed code, which the binding read shows as a customer-owned
setup failure (`resultsSetupFailure`); it never passes silently. The table answers are the B7
recording (fixtures/handover: a principal that does not exist).
"""

import json
import unittest
from pathlib import Path

from benchrouter_databricks.handlers import Context, Failed, setup_experiment, setup_results_table
from tests.recorded_workspace import RecordedServer

HANDOVER = json.loads((Path(__file__).parent / "fixtures" / "handover" / "visible_table_owner_refused.json").read_text())
SUCCEEDED = {"status": 200, "body": {"statement_id": "recorded", "status": {"state": "SUCCEEDED"}}}
REFUSED = {"status": 200, "body": HANDOVER["owner_statement"]}
TABLE = "workspace.br-b11.benchrouter_eval_results"
APP_SP = "6f1c2b0e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"


class ResultsReaders(unittest.TestCase):
    def setUp(self) -> None:
        # The app SP made the table, so it owns it and grants its readers.
        self.server = RecordedServer({f"GET /api/2.1/unity-catalog/tables/{TABLE}": {"status": 200, "body": {"owner": APP_SP}}})
        self.ctx = Context(self.server.workspace(), "benchrouter", 99)

    def tearDown(self) -> None:
        self.server.close()

    def statements(self) -> list[str]:
        return [body["statement"] for method, path, _, body in self.server.calls if path == "/api/2.0/sql/statements"]

    def payload(self, readers: list[dict[str, str]]) -> dict:
        return {"object": "results_table", "table": TABLE, "warehouse_id": "recorded", "agent_principal": {"type": "service_principal", "name": APP_SP},
                "columns": [{"name": "written_at", "type": "TIMESTAMP"}], "read_principals": readers}

    def test_every_reader_gets_select(self) -> None:
        self.server.answers["POST /api/2.0/sql/statements"] = [SUCCEEDED]
        setup_results_table(self.ctx, self.payload([
            {"type": "user", "name": "admin@example.com"},
            {"type": "service_principal", "name": APP_SP},
            {"type": "group", "name": "br-results-readers"},
        ]))
        self.assertEqual(self.statements()[1:], [
            "GRANT SELECT ON TABLE `workspace`.`br-b11`.`benchrouter_eval_results` TO `admin@example.com`",
            f"GRANT SELECT ON TABLE `workspace`.`br-b11`.`benchrouter_eval_results` TO `{APP_SP}`",
            "GRANT SELECT ON TABLE `workspace`.`br-b11`.`benchrouter_eval_results` TO `br-results-readers`",
        ])

    def test_a_group_databricks_does_not_know_fails_the_item(self) -> None:
        self.server.answers["POST /api/2.0/sql/statements"] = [SUCCEEDED, SUCCEEDED, REFUSED]
        with self.assertRaises(Failed) as refused:
            setup_results_table(self.ctx, self.payload([
                {"type": "user", "name": "admin@example.com"}, {"type": "group", "name": "users"},
            ]))
        self.assertEqual(refused.exception.code, "grant_select_bad_request")

    def test_the_experiment_gets_can_read_for_each_reader(self) -> None:
        self.server.answers["POST /api/2.0/workspace/mkdirs"] = {"status": 200, "body": {}}
        self.server.answers["GET /api/2.0/mlflow/experiments/get-by-name"] = {"status": 200, "body": {"experiment": {"experiment_id": "77"}}}
        self.server.answers["PATCH /api/2.0/permissions/experiments/77"] = {"status": 200, "body": {}}
        setup_experiment(self.ctx, {"object": "experiment", "path": "/Shared/benchrouter/recorded",
                                    "read_principals": [
                                        {"type": "user", "name": "admin@example.com"},
                                        {"type": "service_principal", "name": APP_SP},
                                        {"type": "group", "name": "br-results-readers"},
                                    ]})
        acls = [body["access_control_list"] for method, path, _, body in self.server.calls if method == "PATCH"]
        self.assertEqual(acls, [[{"user_name": "admin@example.com", "permission_level": "CAN_READ"}],
                                [{"service_principal_name": APP_SP, "permission_level": "CAN_READ"}],
                                [{"group_name": "br-results-readers", "permission_level": "CAN_READ"}]])


if __name__ == "__main__":
    unittest.main()
