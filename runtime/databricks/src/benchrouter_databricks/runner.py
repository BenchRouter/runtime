"""The eval job's runner parent (plan sections 4.3 to 4.5; RUN-001, AUTH-010, EVAL-002).

A thin executor variant of the GitHub runtime (runtime/src/session.ts). One job run serves one
startup claim:

1. Wait for the bootstrap key `claim-<claim>` that the agent writes once BenchRouter recorded
   this run, then say hello with it and this run's id. Delete the key once hello committed.
2. Heartbeat every 30 s from then on.
3. A `snapshot_refresh` session freezes the eval and reports the artifact (refresh.py).
4. A `work` session says ready with the hello's contract digests and claims. An executable item
   runs alone: copy the planned artifact into a private directory and verify every file
   (`tree_mutated`), build the venv offline from the locked wheels (`install_failed`), run the
   evaluator child, map its assessments to the receipt, and upload, or fail with a fixed cause.
5. Read the result summary until the set closes (at most 5 minutes) and leave it, with the
   child's local MLflow store, in the results volume for the results task.

The parent holds the bootstrap key and the session credential in memory only, imports no
customer module and no MLflow, and logs fixed words and ids only.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from typing import Any

from . import __version__
from .agent import parse_args
from .artifact import (ARTIFACT_VOLUME, RESULTS_VOLUME, ArtifactMissing, TreeMutated, VolumeRefused, copy_planned, platform_tag,
                       python_version, volume_root)
from .canonical import canonical_json, sha256_digest
from .child import Masker, child_env, run_child
from .manifest import MANIFEST_NAME, ManifestError, load_manifest
from .protocol import ProtocolError, RunnerApiError, RunnerClient
from .receipt import Case, Unmeasured, build_receipt, read_receipt
from .refresh import run_refresh
from .transport import ApiError, TransportError, with_retries
from .workspace import Workspace

PROTOCOL = 1
HEARTBEAT_S = 30
LEASE_TTL_S = 90
LOCAL_EXPIRY_MARGIN_S = 15
#: Plan 4.3: the parent waits for its bootstrap key inside the 20-minute prepare deadline.
KEY_WAIT_S = 20 * 60
KEY_POLL_S = 5
SUMMARY_POLL_S = 30
SUMMARY_WAIT_S = 5 * 60
IDLE_EXIT_GRACE = 1.25
INSTALL_TIMEOUT_S = 600
PIP_ENV_NAMES = ("PATH", "HOME")


def log(message: str, **fields: Any) -> None:
    detail = " ".join(f"{name}={value}" for name, value in fields.items())
    print(f"benchrouter-runner {message} {detail}".rstrip(), flush=True)


def parse_time(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class ItemFault(Exception):
    """One work item's failure: a protocol cause and identifier-only diagnostics (DATA-001)."""

    def __init__(self, cause: str, reason: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(reason)
        self.cause = cause
        self.diagnostics = diagnostics if diagnostics is not None else {"message": reason}


class Heartbeat:
    """§3.3.4: beats every 30 s; a fenced lease or an ended session aborts the item."""

    def __init__(self, client: RunnerClient) -> None:
        self.client = client
        self.lease: dict[str, Any] | None = None
        self.local_expiry = 0.0
        self.abort = threading.Event()
        self.ended: str | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def hold(self, item: dict[str, Any]) -> None:
        with self._lock:
            self.lease = item
            self.local_expiry = min(parse_time(item["lease_expires_at"]), time.time() + LEASE_TTL_S) - LOCAL_EXPIRY_MARGIN_S

    def release(self) -> None:
        with self._lock:
            self.lease = None

    def _loop(self) -> None:
        while not self._stop.wait(HEARTBEAT_S):
            self.beat()

    def beat(self) -> None:
        with self._lock:
            lease = self.lease
        sent_at = time.time()
        leases = [] if lease is None else [{"work_id": lease["work_id"], "lease_gen": lease["lease_gen"]}]
        try:
            answer = self.client.heartbeat(leases)
        except (RunnerApiError, TransportError, ProtocolError):
            # No acknowledgment: the lease lives until its local expiry.
            with self._lock:
                if self.lease is not None and time.time() >= self.local_expiry:
                    self.abort.set()
            return
        outcome = answer.get("outcome")
        if outcome != "ok":
            self.ended = str(outcome)
            self.abort.set()
            self._stop.set()
            return
        for status in answer.get("leases") or []:
            with self._lock:
                held = self.lease
                if held is None or status.get("work_id") != held["work_id"] or status.get("lease_gen") != held["lease_gen"]:
                    continue
                if status.get("status") == "ok":
                    self.local_expiry = min(parse_time(status["lease_expires_at"]), sent_at + LEASE_TTL_S) - LOCAL_EXPIRY_MARGIN_S
                else:
                    self.abort.set()


class Runner:
    def __init__(self, args: dict[str, str]) -> None:
        self.claim = args["claim"]
        self.run_id = int(args["run_id"])
        self.api_base = args.get("api_base", "https://api.benchrouter.com").rstrip("/")
        self.scope = args.get("scope", "benchrouter")
        self.catalog = args["catalog"]
        self.schema = args["schema"]
        self.warehouse_id = args["warehouse_id"]
        # RUN-003: the job installs the pinned release (src/databricks/eval-job.ts); this is its digest.
        self.runtime_digest = args["runtime_digest"]
        self.workspace = Workspace.from_runtime()
        self.client = RunnerClient(self.api_base)
        self.results_dir = os.path.join(volume_root(self.catalog, self.schema, RESULTS_VOLUME), self.claim)

    # 1. Bootstrap key and hello ------------------------------------------------------------

    def bootstrap_key(self) -> str | None:
        name = f"claim-{self.claim}"
        deadline = time.monotonic() + KEY_WAIT_S
        while time.monotonic() < deadline:
            key = with_retries(lambda: self.workspace.secret_get(self.scope, name))
            if key:
                return key
            time.sleep(KEY_POLL_S)
        return None

    def hello(self, key: str) -> dict[str, Any]:
        return self.client.hello(key, {
            "protocol": PROTOCOL,
            "claim": self.claim,
            "bootstrap_version": __version__,
            "runtime_digest": self.runtime_digest,
            "features": [],
            "databricks_run_id": self.run_id,
        })

    def run(self) -> int:
        key = self.bootstrap_key()
        if key is None:
            log("no bootstrap key", claim=self.claim)
            return 1
        answer = self.hello(key)
        # A bootstrap key exists only from its write to hello commit (plan 4.3).
        try:
            with_retries(lambda: self.workspace.secret_delete(self.scope, f"claim-{self.claim}"))
        except (ApiError, TransportError) as error:
            log("bootstrap key delete failed", error=type(error).__name__)
        del key
        outcome = answer.get("outcome")
        if outcome != "session":
            log("hello ended", outcome=outcome, reason=answer.get("reason"))
            self.write_run({"outcome": f"hello_{outcome}", "reason": answer.get("reason")})
            return 0
        log("session", session=answer["session_id"], purpose=answer.get("purpose"), revision=answer.get("revision"))
        heartbeat = Heartbeat(self.client)
        heartbeat.start()
        try:
            if answer.get("purpose") == "snapshot_refresh":
                return self.refresh(answer)
            return self.work(answer, heartbeat)
        finally:
            heartbeat.stop()

    # 3. Refresh -----------------------------------------------------------------------------

    def refresh(self, hello: dict[str, Any]) -> int:
        folder, route_key = hello.get("eval_folder"), hello.get("route_key")
        if not isinstance(folder, str) or not folder or not isinstance(route_key, str) or not route_key:
            body: dict[str, Any] = {"kind": "databricks_unavailable", "cause": "eval_folder_missing"}
        else:
            body = run_refresh(self.workspace, folder, route_key, self.warehouse_id, self.scope, self.catalog, self.schema)
        answer = self.client.snapshot(body)
        log("snapshot", kind=body["kind"], cause=body.get("cause"), digest=body.get("artifact_digest"), outcome=answer.get("outcome"),
            reason=answer.get("reason") or answer.get("cause"))
        return 0

    # 4. Work --------------------------------------------------------------------------------

    def work(self, hello: dict[str, Any], heartbeat: Heartbeat) -> int:
        digests = hello.get("contract_digests") or []
        ready = self.client.ready(digests)
        if ready.get("outcome") != "live":
            log("ready ended", outcome=ready.get("outcome"), reason=ready.get("reason"))
            return 0
        idle_limit = max(1, int(hello.get("idle_exit_s") or 60)) * IDLE_EXIT_GRACE
        last_lease = time.monotonic()
        claim_seq = 0
        while heartbeat.ended is None:
            if time.monotonic() - last_lease >= idle_limit:
                log("exit idle")
                return 0
            answer = self.client.claim(claim_seq + 1, 1)
            claim_seq += 1
            outcome = answer.get("outcome")
            if outcome == "run" and answer.get("items"):
                items = answer["items"]
                # An executable item runs alone, and the job claims nothing after it.
                item = items[0]
                refusal = None if len(items) == 1 else ItemFault("mode_unsupported", "executable_work_runs_alone")
                self.item(hello, item, digests, heartbeat, refusal)
                return 0
            if outcome == "run" or outcome == "wait_until":
                until = parse_time(answer["until"]) if outcome == "wait_until" else time.time() + 1
                time.sleep(max(0.0, min(until - time.time(), idle_limit - (time.monotonic() - last_lease))))
                continue
            log("claim ended", outcome=outcome, reason=answer.get("reason"), state=answer.get("state"))
            return 0
        log("session ended", outcome=heartbeat.ended)
        return 0

    def item(self, hello: dict[str, Any], item: dict[str, Any], digests: list[str], heartbeat: Heartbeat, refusal: ItemFault | None) -> None:
        heartbeat.hold(item)
        model = item["model_run"]["model"]
        log("item", work=item["work_id"], model=model)
        record: dict[str, Any] = {"work_id": item["work_id"], "model": model, "result_set_id": item["model_run"]["result_set_id"],
                                  "route_id": hello.get("route_key"), "artifact_digest": hello.get("eval_sha")}
        with tempfile.TemporaryDirectory(prefix="benchrouter-item-") as private:
            os.chmod(private, 0o700)
            try:
                if refusal is not None:
                    raise refusal
                try:
                    rows, quality, files, details = self.execute(hello, item, digests, heartbeat, private)
                except ItemFault:
                    raise
                except Exception as error:  # noqa: BLE001 - an arbitrary exception's text never leaves the job (DATA-001)
                    log("item error", error=type(error).__name__)
                    raise ItemFault("runtime_error", "runtime_error") from None
                record.update(details)
                committed = self.client.upload({
                    "work_id": item["work_id"], "lease_gen": item["lease_gen"], "retry_attempt": item["retry_attempt"],
                    "contract_digest": item["contract_digest"], "file_hashes": files, "runtime_digest": self.runtime_digest,
                    "payload_digest": sha256_digest(canonical_json(rows)), "case_results": rows, "quality": quality,
                })
                record["outcome"] = f"upload_{committed['receipt'].get('terminal')}"
            except ItemFault as fault:
                log("item failed", work=item["work_id"], cause=fault.cause)
                record["outcome"] = f"fail_{fault.cause}"
                try:
                    self.client.fail({"work_id": item["work_id"], "lease_gen": item["lease_gen"], "retry_attempt": item["retry_attempt"],
                                      "cause": fault.cause, "diagnostics": fault.diagnostics})
                except RunnerApiError as error:
                    log("fail refused", status=error.status, code=error.code)
            except RunnerApiError as error:
                log("upload refused", status=error.status, code=error.code)
                record["outcome"] = f"refused_{error.code}"
            finally:
                heartbeat.release()
            record["summary"] = self.summary(item["model_run"]["result_set_id"])
            self.write_run(record, store=os.path.join(private, "home", "mlflow.db"))
        log("item done", work=item["work_id"], outcome=record["outcome"])

    def execute(self, hello: dict[str, Any], item: dict[str, Any], digests: list[str], heartbeat: Heartbeat,
                private: str) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, str], dict[str, Any]]:
        if item.get("mode") != "repository_executable":
            raise ItemFault("mode_unsupported", "mode_unsupported")
        if item.get("contract_digest") not in digests:
            raise ItemFault("runtime_error", "contract_not_admitted")
        if (item.get("requires") or {}).get("features"):
            raise ItemFault("capability_unsupported", "feature_unsupported")
        selection = item.get("case_selection")
        if selection is not None and selection.get("kind") != "all":
            raise ItemFault("capability_unsupported", "case_subset_unsupported")
        if (item.get("limits") or {}).get("trials") != 1:
            raise ItemFault("capability_unsupported", "trials_unsupported")
        deadline_at = parse_time(item["work_deadline_at"])

        # Copy the planned artifact into the private directory and prove every file. Only a copy that
        # does not match its digest is `tree_mutated`. A volume the app SP may not read (B11 smoke 8b:
        # a reinstall's new SP, before Connect healed the volume) and an artifact that is gone are not
        # the eval's fault: each has its own fixed reason, which BenchRouter shows as its own or as
        # Connect's to fix (src/shared/failure-display.ts), never as "fix the eval".
        tree = os.path.join(private, "artifact")
        try:
            artifact = copy_planned(volume_root(self.catalog, self.schema, ARTIFACT_VOLUME), str(hello["eval_sha"]), tree)
        except VolumeRefused:
            raise ItemFault("harness_failed", "artifact_unreadable") from None
        except ArtifactMissing:
            raise ItemFault("harness_failed", "artifact_missing") from None
        except (TreeMutated, OSError):
            raise ItemFault("tree_mutated", "artifact_mismatch") from None
        files_root = os.path.join(tree, "files")
        # The manifest's `route_id` is the route key; the item's `route_id` is an internal id.
        route_key = hello.get("route_key")
        if not isinstance(route_key, str) or not route_key:
            raise ItemFault("harness_failed", "route_key_missing")
        try:
            with open(os.path.join(files_root, MANIFEST_NAME), encoding="utf-8") as handle:
                manifest = load_manifest(handle.read(), route_key, own_scope=self.scope)
        except UnicodeDecodeError:
            raise ItemFault("harness_failed", "manifest_invalid") from None
        except ManifestError as error:
            raise ItemFault("harness_failed", error.code) from None

        # Build the venv offline from the locked wheels. Wheel installs run no package code.
        if artifact.get("platform_tag") != platform_tag() or str(artifact.get("python_version")).split(".")[:2] != python_version().split(".")[:2]:
            raise ItemFault("install_failed", "python_or_platform_mismatch")
        venv = os.path.join(private, "venv")
        self.build_venv(venv, os.path.join(files_root, "wheels"), os.path.join(files_root, manifest.requirements_lock), deadline_at)
        if heartbeat.abort.is_set():
            raise ItemFault("lease_lost", "lease_lost")

        # Declared secrets: read only the named keys from the customer's scope (plan 4.4).
        secrets: dict[str, str] = {}
        for secret in manifest.secrets:
            try:
                value = with_retries(lambda: self.workspace.secret_get(secret.scope, secret.key))
            except ApiError:
                value = None
            if not value:
                raise ItemFault("harness_failed", "secret_unreadable")
            secrets[secret.env] = value

        home = os.path.join(private, "home")
        os.makedirs(home, mode=0o700)
        out = os.path.join(home, "results.json")
        env = child_env(os.environ, venv=venv, home=home, call_token=item["call_token"], api_base=self.api_base,
                        route_id=route_key, base_url_env=manifest.base_url_env, secrets=secrets)
        argv = [os.path.join(venv, "bin", "python"), "-I", os.path.join(os.path.dirname(__file__), "evaluator.py"),
                "--code-dir", files_root, "--cases", os.path.join(files_root, "cases.jsonl"),
                "--predict", manifest.predict_file, manifest.predict_function,
                "--scorers", manifest.scorers_file, manifest.scorers_attribute,
                "--store", os.path.join(home, "mlflow.db"), "--out", out]
        timeout_at = min(deadline_at, time.time() + manifest.timeout_minutes * 60)
        mask = Masker([item["call_token"], *secrets.values()])
        outcome = run_child(argv, home, env, time.monotonic() + max(0.0, timeout_at - time.time()), heartbeat.abort, mask)
        if outcome.aborted:
            raise ItemFault("lease_lost", "lease_lost")
        if outcome.timed_out and timeout_at >= deadline_at:
            raise ItemFault("deadline_exceeded", "deadline_exceeded")
        if outcome.start_failed or outcome.timed_out or outcome.exit_code != 0:
            raise ItemFault("harness_failed", "evaluator_failed", execution_diagnostic(outcome))

        # The receipt: assessments -> benchrouter.result.v1 -> rows (receipt.py).
        cases = []
        with open(os.path.join(files_root, "cases.jsonl"), encoding="utf-8") as handle:
            for line in handle:
                record = json.loads(line)
                cases.append(Case(record["case_id"], record["critical"] is True))
        try:
            with open(out, encoding="utf-8") as handle:
                results = json.load(handle)
            receipt = build_receipt(cases, results, manifest.normalization)
            rows, quality = read_receipt(receipt, manifest.normalization.primary_metric, item["model_run"]["model"])
        except (OSError, ValueError):
            raise ItemFault("harness_failed", "results_unreadable") from None
        except Unmeasured as gap:
            diagnostics: dict[str, Any] = {"message": gap.code}
            log("unmeasured", code=gap.code, case=gap.case_id, metric=gap.metric)
            raise ItemFault("harness_failed", gap.code, diagnostics) from None
        details = {"mlflow_run_id": results.get("run_id"), "metrics": quality["metrics"], "primary_metric": quality["primary_metric"],
                   "cases": len(rows), "cases_passed": sum(1 for row in rows if row["pass"]), "traces": results.get("cases")}
        return rows, quality, artifact["files"], details

    def build_venv(self, venv: str, wheels: str, lockfile: str, deadline_at: float) -> None:
        env = {name: os.environ[name] for name in PIP_ENV_NAMES if name in os.environ}
        timeout = max(1.0, min(INSTALL_TIMEOUT_S, deadline_at - time.time()))
        commands = [
            [sys.executable, "-m", "venv", "--without-pip", venv],
            [sys.executable, "-m", "pip", "--disable-pip-version-check", "--python", os.path.join(venv, "bin", "python"), "install",
             "--no-index", "--find-links", wheels, "--only-binary", ":all:", "--require-hashes", "--no-deps", "--requirement", lockfile],
        ]
        for command in commands:
            try:
                completed = subprocess.run(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                           timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                raise ItemFault("install_failed", "install_timeout") from None
            if completed.returncode != 0:
                sys.stderr.write(completed.stderr.decode(errors="replace")[-4000:])
                raise ItemFault("install_failed", "install_failed")

    # 5. Results hand-off ------------------------------------------------------------------

    def summary(self, result_set_id: str) -> dict[str, Any] | None:
        """Plan 4.5: poll the result summary until the set closes, for at most 5 minutes."""
        deadline = time.monotonic() + SUMMARY_WAIT_S
        last: dict[str, Any] | None = None
        while True:
            try:
                last = self.client.result_summary(result_set_id)
            except (RunnerApiError, TransportError, ProtocolError) as error:
                log("summary unavailable", error=getattr(error, "code", type(error).__name__))
                return last
            if last.get("set_state") in ("closed", "published") or time.monotonic() + SUMMARY_POLL_S > deadline:
                return last
            time.sleep(SUMMARY_POLL_S)

    def write_run(self, record: dict[str, Any], store: str | None = None) -> None:
        """Leaves the run's record (and the child's local MLflow store) for the results task."""
        try:
            os.makedirs(self.results_dir, exist_ok=True)
            if store is not None and os.path.exists(store):
                shutil.copyfile(store, os.path.join(self.results_dir, "mlflow.db"))
            with open(os.path.join(self.results_dir, "run.json"), "w", encoding="utf-8") as handle:
                json.dump({"claim_id": self.claim, "job_run_id": self.run_id, **record}, handle)
        except OSError as error:
            log("results write failed", error=type(error).__name__)


def execution_diagnostic(outcome: Any) -> dict[str, Any]:
    """runtime/src/executable.ts `executionDiagnostic`: the evaluator's ending, identifiers only."""
    reason = ("process_start_failed" if outcome.start_failed else "process_timeout" if outcome.timed_out
              else "process_signal" if outcome.exit_code is not None and outcome.exit_code < 0 else "process_exit")
    signal_name = None
    if reason in ("process_signal", "process_timeout") and outcome.exit_code is not None and outcome.exit_code < 0:
        signal_name = signal.Signals(-outcome.exit_code).name
    return {
        "v": 1,
        "source": "workflow_fail_step",
        "reason_code": "workflow_step_failed",
        "failed_step": "evaluator",
        "github_conclusion": None,
        "cases": None,
        "execution": {
            "phase": "evaluator",
            "reason": reason,
            "exit_code": outcome.exit_code if reason == "process_exit" and outcome.exit_code and outcome.exit_code > 0 else None,
            "signal": signal_name,
            "timed_out": outcome.timed_out,
        },
    }


def main() -> None:
    # A `python_wheel_task` fails on any SystemExit, even 0, so success returns normally.
    code = Runner(parse_args(sys.argv[1:])).run()
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
