"""RUN-001 (repo work queue §10, §13): the runner's session over the real protocol client and recorded BenchRouter answers.

A queue session claims until the server answers `exit`, and each item leaves its own folder. A session with no queue
flag (today's hello answer) runs one item and ends. Items here fail before any evaluator starts (their mode is not
executable), so the protocol, the loop and the hand-off run as in a job, with no customer code.
"""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from benchrouter_databricks.protocol import RunnerClient
from benchrouter_databricks.runner import Heartbeat, Runner
from tests.recorded_workspace import RecordedServer

COMMITTED = {"status": 200, "body": {"outcome": "committed", "receipt": {"terminal": "failed"}}}
LIVE = {"status": 200, "body": {"outcome": "live"}}
EXIT_IDLE = {"status": 200, "body": {"outcome": "exit", "reason": "idle"}}


def item(work_id: str, model: str) -> dict:
    return {"work_id": work_id, "lease_gen": 1, "retry_attempt": 0, "mode": "isolated_replay", "contract_digest": "sha256:a",
            "eval_sha": "sha256:e", "route_key": "route/a", "lease_expires_at": "2099-01-01T00:00:00Z",
            "model_run": {"result_set_id": "set", "model_run_id": "mr", "model": model}}


def claim_run(*items: dict) -> dict:
    return {"status": 200, "body": {"outcome": "run", "items": list(items)}}


class QueueSessionTest(unittest.TestCase):
    def setUp(self):
        self.results = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.results.cleanup()

    def runner(self, server: RecordedServer) -> Runner:
        runner = Runner.__new__(Runner)
        runner.client = RunnerClient(server.base)
        runner.client.session_id, runner.client.credential = "session", "credential"
        runner.claim, runner.run_id, runner.api_base, runner.runtime_digest = "claim", 5, server.base, "sha256:r"
        runner.results_dir = os.path.join(self.results.name, "claim")
        return runner

    def serve(self, server: RecordedServer, hello: dict):
        heartbeat = Heartbeat(RunnerClient(server.base))
        heartbeat.client.session_id, heartbeat.client.credential = "session", "credential"
        return self.runner(server).work(hello, heartbeat)

    @unittest.skipUnless(os.path.isdir("/proc"), "the residue check reads Linux /proc")
    def test_a_queue_session_serves_two_items_then_closes_idle_and_each_item_has_its_folder(self):
        server = RecordedServer({
            "POST /v1/runner/ready": LIVE,
            "POST /v1/runner/claim": [claim_run(item("w1", "a")), claim_run(item("w2", "b")), EXIT_IDLE],
            "POST /v1/runner/fail": COMMITTED,
        })
        try:
            self.assertEqual(self.serve(server, {"queue": True, "contract_digests": ["sha256:a"], "idle_exit_s": 60}), 0)
            paths = [path for _, path, _, _ in server.calls]
            self.assertEqual(paths.count("/v1/runner/claim"), 3)
            self.assertEqual(paths.count("/v1/runner/fail"), 2)
            for work, model in (("w1", "a"), ("w2", "b")):
                record = json.loads((Path(self.results.name) / "claim" / work / "run.json").read_text())
                self.assertEqual((record["work_id"], record["model"], record["route_id"], record["artifact_digest"]), (work, model, "route/a", "sha256:e"))
        finally:
            server.close()

    def test_a_session_with_no_queue_flag_runs_one_item_and_ends(self):
        server = RecordedServer({
            "POST /v1/runner/ready": LIVE,
            "POST /v1/runner/claim": [claim_run(item("w1", "a")), claim_run(item("w2", "b"))],
            "POST /v1/runner/fail": COMMITTED,
        })
        try:
            self.assertEqual(self.serve(server, {"contract_digests": ["sha256:a"], "idle_exit_s": 60, "eval_sha": "sha256:e", "route_key": "route/a"}), 0)
            paths = [path for _, path, _, _ in server.calls]
            self.assertEqual((paths.count("/v1/runner/claim"), paths.count("/v1/runner/fail")), (1, 1))
        finally:
            server.close()

    def test_a_queue_session_ends_by_its_own_idle_clock_when_the_server_never_says_exit(self):
        soon = {"status": 200, "body": {"outcome": "wait_until", "until": "2099-01-01T00:00:00Z"}}
        server = RecordedServer({"POST /v1/runner/ready": LIVE, "POST /v1/runner/claim": soon})
        try:
            runner = self.runner(server)
            heartbeat = Heartbeat(RunnerClient(server.base))
            heartbeat.client.session_id, heartbeat.client.credential = "session", "credential"
            started = time.monotonic()
            self.assertEqual(runner.work({"queue": True, "contract_digests": ["sha256:a"], "idle_exit_s": 1}, heartbeat), 0)
            self.assertLess(time.monotonic() - started, 4)
        finally:
            server.close()

    def test_the_hello_advertises_executable_queue(self):
        server = RecordedServer({"POST /v1/runner/hello": {"status": 200, "body": {"outcome": "done", "reason": "stale_start"}}})
        try:
            runner = self.runner(server)
            runner.hello("brdc_key")
            body = next(call[3] for call in server.calls if call[1] == "/v1/runner/hello")
            self.assertEqual(body["features"], ["executable_queue"])
        finally:
            server.close()

    def test_a_claim_extends_hello_digests_before_the_item_check(self):
        admitted = {**item("w-new", "b"), "mode": "repository_executable", "contract_digest": "sha256:b",
                    "requires": {"features": ["case_subset"]}}
        answer = claim_run(admitted)
        answer["body"]["new_contract_digests"] = ["sha256:b"]
        server = RecordedServer({"POST /v1/runner/ready": LIVE, "POST /v1/runner/claim": answer,
                                 "POST /v1/runner/fail": COMMITTED})
        try:
            hello = {"contract_digests": ["sha256:a"], "idle_exit_s": 60}
            self.assertEqual(self.serve(server, hello), 0)
            # Execution passes admission and reaches the existing unsupported-feature check.
            failed = next(body for _, path, _, body in server.calls if path == "/v1/runner/fail")
            self.assertEqual(failed["diagnostics"], {"message": "feature_unsupported"})
            self.assertEqual(hello["contract_digests"], ["sha256:a"])
            ready = next(body for _, path, _, body in server.calls if path == "/v1/runner/ready")
            self.assertEqual(ready["contract_digests"], ["sha256:a"])
        finally:
            server.close()

    @unittest.skipUnless(os.path.isdir("/proc"), "the residue check reads Linux /proc")
    def test_an_unknown_digest_fails_alone_and_the_next_admitted_item_executes(self):
        unknown = {**item("w-unknown", "a"), "mode": "repository_executable", "contract_digest": "sha256:unknown"}
        admitted = {**item("w-admitted", "b"), "mode": "repository_executable", "contract_digest": "sha256:b",
                    "requires": {"features": ["case_subset"]}}
        answer = claim_run(unknown, admitted)
        answer["body"]["new_contract_digests"] = ["sha256:b"]
        # A later answer omits the field: an explicit admission lasts for the session.
        later = claim_run({**admitted, "work_id": "w-later"})
        server = RecordedServer({"POST /v1/runner/ready": LIVE,
                                 "POST /v1/runner/claim": [answer, later, EXIT_IDLE],
                                 "POST /v1/runner/fail": COMMITTED})
        try:
            self.assertEqual(self.serve(server, {"queue": True, "contract_digests": ["sha256:a"], "idle_exit_s": 60}), 0)
            failed = [body for _, path, _, body in server.calls if path == "/v1/runner/fail"]
            self.assertEqual([(body["work_id"], body["diagnostics"]["message"]) for body in failed],
                             [("w-unknown", "contract_not_admitted"), ("w-admitted", "feature_unsupported"),
                              ("w-later", "feature_unsupported")])
            self.assertEqual([path for _, path, _, _ in server.calls].count("/v1/runner/claim"), 3)
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
