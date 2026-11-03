"""AUTH-012: the wheel entry point drains follow-up work over real HTTPS clients.

The recorded-server harness supplies poll sessions and absent endpoints. A temporary
localhost certificate lets Workspace.from_runtime use its normal environment credentials.
"""

import base64
import os
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.recorded_workspace import RecordedServer

POLL = "/v1/databricks/poll"
REPORT = "/v1/databricks/report"


def secret(value):
    return {"status": 200, "body": {"value": base64.b64encode(value.encode()).decode()}}


def poll(key, items):
    return {"status": 200, "body": {"binding_id": "dbxb_recorded", "poll_key": key,
                                    "items": items, "next_check_seconds": 3600}}


def item(number):
    return {"id": f"item-{number}", "lease_id": f"lease-{number}", "kind": "retire",
            "payload": {"endpoint_name": f"br-retired-{number}"}}


class AgentLoopTest(unittest.TestCase):
    def test_auth_012_agent_polls_after_each_item_despite_nonzero_next_check_and_stops_when_empty(self):
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as directory:
            cert, key = Path(directory) / "cert.pem", Path(directory) / "key.pem"
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
                "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
                "-keyout", str(key), "-out", str(cert),
            ], check=True, capture_output=True, timeout=2)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            server = RecordedServer({
                "GET /api/2.0/secrets/list": {"status": 200, "body": {"secrets": [{"key": "poll-key"}]}},
                "GET /api/2.0/secrets/get": [secret("initial"), secret("initial"), secret("initial"),
                                            secret("rotated-1"), secret("rotated-2")],
                "POST /api/2.0/secrets/put": {"status": 200, "body": {}},
                f"POST {POLL}": [poll("rotated-1", [item(1)]), poll("rotated-2", [item(2)]), poll("rotated-3", [])],
                f"POST {REPORT}": {"status": 200, "body": {"replayed": False}},
            }, tls=tls)
            try:
                result = subprocess.run([
                    sys.executable, "-m", "benchrouter_databricks.agent", "--scope=recorded-scope",
                    f"--api-base={server.base}",
                ], env={**os.environ, "DATABRICKS_HOST": server.base, "DATABRICKS_TOKEN": "recorded",
                        "SSL_CERT_FILE": str(cert), "NO_PROXY": "127.0.0.1"},
                    capture_output=True, text=True, timeout=2)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                work = [(method, path) for method, path in server.paths()
                        if path in (POLL, REPORT) or "serving-endpoints" in path]
                self.assertEqual(work, [
                    ("POST", POLL), ("DELETE", "/api/2.0/serving-endpoints/br-retired-1"), ("POST", REPORT),
                    ("POST", POLL), ("DELETE", "/api/2.0/serving-endpoints/br-retired-2"), ("POST", REPORT),
                    ("POST", POLL),
                ])
                reports = [body for _, path, _, body in server.calls if path == REPORT]
                self.assertEqual([(body["item_id"], body["outcome"]) for body in reports],
                                 [("item-1", "done"), ("item-2", "done")])
                writes = [body for _, path, _, body in server.calls if path == "/api/2.0/secrets/put"]
                self.assertEqual([body["string_value"] for body in writes], ["rotated-1", "rotated-2", "rotated-3"])
            finally:
                server.close()
        self.assertLess(time.monotonic() - started, 5)


if __name__ == "__main__":
    unittest.main()
