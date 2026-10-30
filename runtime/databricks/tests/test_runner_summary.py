"""RUN-001: an open result set must not keep an eval job idle after upload.

Use the real protocol client over a local socket and the real file hand-off. The child
has a short process deadline so a reintroduced 30-second sleep fails within five seconds.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.recorded_workspace import RecordedServer

# BenchRouter's own summary contract. No external Databricks response is synthesized.
OPEN_SUMMARY = {"result_set_id": "set", "set_state": "open", "decision": None, "rows": []}

CHILD = """
import sys
from benchrouter_databricks.runner import Runner
from benchrouter_databricks.protocol import RunnerClient
runner = Runner.__new__(Runner)
runner.client = RunnerClient(sys.argv[1])
runner.client.session_id = 'session'
runner.client.credential = 'credential'
runner.claim, runner.run_id, runner.results_dir = 'claim', 1, sys.argv[2]
runner.write_run({'summary': runner.summary('set')})
"""


class RunnerSummaryTest(unittest.TestCase):
    def test_open_summary_is_read_once_and_written_without_sleep(self):
        server = RecordedServer({"GET /v1/runner/result-summary": {"status": 200, "body": OPEN_SUMMARY}})
        try:
            with tempfile.TemporaryDirectory() as root:
                subprocess.run([sys.executable, "-c", CHILD, server.base, root], check=True, timeout=2, capture_output=True)
                record = json.loads((Path(root) / "run.json").read_text())
                self.assertEqual(record, {"claim_id": "claim", "job_run_id": 1, "summary": OPEN_SUMMARY})
            self.assertEqual(server.paths(), [("GET", "/v1/runner/result-summary")])
            self.assertEqual(server.calls[0][2], {"session_id": "session", "result_set": "set"})
        finally:
            server.close()

    def test_read_failure_leaves_none_and_writes_the_run(self):
        server = RecordedServer({})
        try:
            with tempfile.TemporaryDirectory() as root:
                subprocess.run([sys.executable, "-c", CHILD, server.base, root], check=True, timeout=2, capture_output=True)
                self.assertIsNone(json.loads((Path(root) / "run.json").read_text())["summary"])
            self.assertEqual(server.paths(), [("GET", "/v1/runner/result-summary")])
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
