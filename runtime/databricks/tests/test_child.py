"""The isolation rule (plan 4.3) and declared-secret passthrough (plan 4.4), on a real child process."""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from io import StringIO

from benchrouter_databricks.child import Masker, child_env, run_child

#: Only for the test harness: some CI interpreters (actions/setup-python) cannot start without
#: their own library path, which `child_env` rightly never passes. It is added to the test
#: child's env on top of `child_env`, so the assertions still cover everything `child_env` sets.
HARNESS = {name: os.environ[name] for name in ("LD_LIBRARY_PATH",) if name in os.environ}

PARENT = {
    "PATH": "/usr/bin:/bin",
    "HOME": "/home/spark",
    "DATABRICKS_RUNTIME_VERSION": "client.3.1",
    "DATABRICKS_HOST": "https://dbc.example.cloud.databricks.com",
    "DATABRICKS_TOKEN": "dapi-parent-token",
    "GRPC_GATEWAY_TOKEN": "gateway-token",
    "DB_HOME": "/databricks",
    "SPARK_HOME": "/databricks/spark",
    "AWS_SECRET_ACCESS_KEY": "aws-secret",
    "JUDGE_API_KEY": "the-parent-value-never-passes",
}


class ChildEnvTest(unittest.TestCase):
    def env(self, home):
        return child_env(PARENT, venv=os.path.dirname(os.path.dirname(sys.executable)), home=home, call_token="brct_item_token",
                         api_base="https://api.benchrouter.com/", route_id="pinned/route", base_url_env="OPENAI_BASE_URL",
                         secrets={"JUDGE_API_KEY": "judge-value-from-scope", "EMPTY_SECRET": ""})

    def test_child_sees_only_the_contract(self):
        with tempfile.TemporaryDirectory() as home:
            out = os.path.join(home, "env.json")
            script = f"import json, os; json.dump(dict(os.environ), open({out!r}, 'w'))"
            outcome = run_child([sys.executable, "-I", "-c", script], home, {**self.env(home), **HARNESS}, time.monotonic() + 4, threading.Event(), Masker([]))
            self.assertEqual(outcome.exit_code, 0)
            with open(out, encoding="utf-8") as handle:
                seen = json.load(handle)
        # The interpreter may add its own locale variables; nothing of the parent arrives.
        seen = {name: value for name, value in seen.items() if not name.startswith("__CF") and name not in ("LC_CTYPE", *HARNESS)}
        self.assertEqual(seen, {
            "PATH": f"{os.path.dirname(os.path.dirname(sys.executable))}/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME": home,
            "DATABRICKS_RUNTIME_VERSION": "client.3.1",
            "BENCHROUTER_API_KEY": "brct_item_token",
            "BENCHROUTER_EVAL_BASE_URL": "https://api.benchrouter.com",
            "BENCHROUTER_ROUTE_ID": "pinned/route",
            "OPENAI_BASE_URL": "https://api.benchrouter.com/v1",
            "JUDGE_API_KEY": "judge-value-from-scope",
        })

    def test_output_masks_the_call_token_and_secrets(self):
        with tempfile.TemporaryDirectory() as home:
            env = {**self.env(home), **HARNESS}
            script = "import os; print('token', os.environ['BENCHROUTER_API_KEY'], 'judge', os.environ['JUDGE_API_KEY'])"
            captured = StringIO()
            with redirect_stdout(captured):
                run_child([sys.executable, "-I", "-c", script], home, env, time.monotonic() + 4, threading.Event(),
                          Masker([env["BENCHROUTER_API_KEY"], env["JUDGE_API_KEY"]]))
        self.assertEqual(captured.getvalue().strip(), "token *** judge ***")

    def test_abort_kills_the_child(self):
        abort = threading.Event()
        abort.set()
        with tempfile.TemporaryDirectory() as home:
            started = time.monotonic()
            outcome = run_child([sys.executable, "-I", "-c", "import time; time.sleep(30)"], home, {**self.env(home), **HARNESS}, time.monotonic() + 4, abort, Masker([]))
        self.assertTrue(outcome.aborted)
        self.assertLess(time.monotonic() - started, 4)


if __name__ == "__main__":
    unittest.main()
