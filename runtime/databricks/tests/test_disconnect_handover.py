"""Plan 4.7 (B7 follow-up, PR #665): a record the app SP can see, it must hand over.

Disconnect skips only a record whose read answers 403 or 404 (it was handed over before a
Reconnect). A visible record whose handover Databricks refuses fails the `disconnect` item, so
the agent does not delete itself while the requested owner lacks the records; the next poll
queues the item again. The answers below were recorded in the test workspace and are replayed
over a local socket through the agent's own HTTP client.
"""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from benchrouter_databricks.handlers import Context, Failed, disconnect
from benchrouter_databricks.workspace import Workspace

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "handover" / "visible_table_owner_refused.json").read_text())
TABLE = FIXTURE["table_get"]["full_name"]
#: The B7 app SP made the table, so it owned it; the recording kept no `owner` field, so it is added here.
APP_SP = "6f1c2b0e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"
TABLE_GET = {**FIXTURE["table_get"], "owner": APP_SP}


class RecordedWorkspace(BaseHTTPRequestHandler):
    """Answers the two recorded calls; any other call is a 404 and is logged for the test to see."""

    calls: list[tuple[str, str]] = []

    def _answer(self, status: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self.calls.append(("GET", self.path))
        if self.path == f"/api/2.1/unity-catalog/tables/{TABLE}":
            self._answer(200, TABLE_GET)
        else:
            self._answer(404, {"error_code": "RESOURCE_DOES_NOT_EXIST"})

    def do_POST(self) -> None:  # noqa: N802
        self.rfile.read(int(self.headers.get("content-length") or 0))
        self.calls.append(("POST", self.path))
        if self.path == "/api/2.0/sql/statements":
            self._answer(200, FIXTURE["owner_statement"])
        else:
            self._answer(404, {"error_code": "RESOURCE_DOES_NOT_EXIST"})

    def log_message(self, format: str, *args: object) -> None:
        pass


class DisconnectHandoverTest(unittest.TestCase):
    def setUp(self) -> None:
        RecordedWorkspace.calls = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RecordedWorkspace)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        host = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.ctx = Context(Workspace(host, lambda: {"authorization": "Bearer recorded"}), "benchrouter", 99)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def test_a_visible_record_whose_handover_is_refused_fails_the_item(self) -> None:
        payload = {
            "results_owner": {"type": "group", "name": "br-b7-no-such-group"}, "warehouse_id": "recorded", "results_table": TABLE,
            "experiment_path": "/Shared/benchrouter/recorded", "scope": "benchrouter", "agent_job_id": 99,
            "exposures": [], "cancel_runs": [], "volumes": ["workspace.br_b7.benchrouter_artifacts"], "agent_principal": {"type": "service_principal", "name": APP_SP},
        }
        with self.assertRaises(Failed) as refused:
            disconnect(self.ctx, payload)
        self.assertEqual(refused.exception.code, "table_owner_bad_request")
        # The item stops at the refused handover: no experiment step, and no scope or job deleted.
        self.assertEqual(RecordedWorkspace.calls, [
            ("GET", f"/api/2.1/unity-catalog/tables/{TABLE}"),
            ("POST", "/api/2.0/sql/statements"),
        ])


if __name__ == "__main__":
    unittest.main()
