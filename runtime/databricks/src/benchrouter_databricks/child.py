"""The parent's side of the evaluator child (plan section 4.3, the isolation rule).

Customer code runs only in a child process with an explicit minimal environment, never in the
parent. The parent never copies its own environment, never passes a Databricks credential,
and drops `GRPC_GATEWAY_TOKEN`. The child gets only `PATH`, `HOME` (its private directory),
`DATABRICKS_RUNTIME_VERSION`, the eval-call contract and the manifest's declared secrets, as
runtime/src/executable.ts gives a GitHub evaluator only the eval-call contract and the
declared secret names.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from typing import Mapping

#: A version string, not a credential. Without it `import mlflow` fails in a job task
#: (MLflow reads /databricks/DBR_VERSION, mode 0500; plan A.6, P15).
RUNTIME_VERSION_ENV = "DATABRICKS_RUNTIME_VERSION"
SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin"
KILL_GRACE_S = 5.0
MASK = "***"


def sdk_base_url(api_base: str) -> str:
    """src/shared/sdk-base-url.ts for `openai_chat_completions`: the API root plus `/v1`."""
    return f"{api_base.rstrip('/')}/v1"


def child_env(
    parent_env: Mapping[str, str],
    *,
    venv: str,
    home: str,
    call_token: str,
    api_base: str,
    route_id: str,
    base_url_env: str | None,
    secrets: Mapping[str, str],
    tmpdir: str | None = None,
) -> dict[str, str]:
    """The child's whole environment. Nothing from `parent_env` but the runtime version."""
    env = {
        "PATH": f"{venv}/bin:{SYSTEM_PATH}",
        "HOME": home,
        "BENCHROUTER_API_KEY": call_token,
        "BENCHROUTER_EVAL_BASE_URL": api_base.rstrip("/"),
        "BENCHROUTER_ROUTE_ID": route_id,
    }
    if tmpdir is not None:
        # RUN-001 (repo work queue §8.3): the item's private temp directory, so a leftover file of route A is not in route B's.
        env["TMPDIR"] = tmpdir
    runtime_version = parent_env.get(RUNTIME_VERSION_ENV)
    if runtime_version:
        env[RUNTIME_VERSION_ENV] = runtime_version
    if base_url_env is not None:
        env[base_url_env] = sdk_base_url(api_base)
    for name, value in secrets.items():
        if value:
            env[name] = value
    return env


class Masker:
    """Replaces every listed secret in the child's output before it reaches the job log."""

    def __init__(self, secrets: list[str]) -> None:
        self.secrets = sorted({secret for secret in secrets if secret}, key=len, reverse=True)

    def __call__(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, MASK)
        return text


class Outcome:
    def __init__(self, exit_code: int | None, timed_out: bool, aborted: bool, start_failed: bool) -> None:
        self.exit_code = exit_code
        self.timed_out = timed_out
        self.aborted = aborted
        self.start_failed = start_failed


def _kill_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=KILL_GRACE_S)
    except subprocess.TimeoutExpired:
        pass
    try:
        # A grandchild the evaluator left behind never outlives the item.
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_child(argv: list[str], cwd: str, env: dict[str, str], deadline: float, abort: threading.Event, mask: Masker) -> Outcome:
    """Runs argv as its own process group until it exits, the deadline passes, or `abort` is set."""
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, errors="replace", start_new_session=True)
    except OSError:
        return Outcome(None, False, False, True)

    def forward() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            print(mask(line), end="", flush=True)

    reader = threading.Thread(target=forward, daemon=True)
    reader.start()
    timed_out = aborted = False
    while process.poll() is None:
        if abort.is_set():
            aborted = True
            break
        if time.monotonic() >= deadline:
            timed_out = True
            break
        time.sleep(0.5)
    _kill_group(process)
    reader.join(timeout=2)
    if process.stdout is not None:
        process.stdout.close()
    return Outcome(process.returncode, timed_out, aborted, False)
