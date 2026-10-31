"""The runner protocol client (RUN-001), a port of runtime/src/runner-client.ts and transport.ts.

A Databricks session uses the GitHub `/v1/runner/*` endpoints unchanged (plan section 4.4).
Same idempotency keys, same retry rule (network errors, 408, 425, 429 and 5xx retry with
full jitter under a per-call deadline, and `Retry-After` is a floor), and the same terminal
rule: a lost upload or fail answer is recovered by the receipt read with the same key, never
by a second terminal write.
"""

from __future__ import annotations

import json
import random
import time
import urllib.parse
from email.utils import parsedate_to_datetime
from typing import Any

from . import __version__
from .transport import Reply, TransportError, send

#: Cloudflare answers Python's default agent with 403 (error 1010) before the Worker.
USER_AGENT = f"benchrouter-databricks-runner/{__version__}"
IDEMPOTENCY_HEADER = "Idempotency-Key"
ATTEMPT_TIMEOUT_S = 30.0
CALL_BUDGET_S = 180.0
MAX_ATTEMPTS = 6
BASE_BACKOFF_S = 0.5
MAX_BACKOFF_S = 30.0
RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504, 529}

ENDPOINTS = {
    "hello": "/v1/runner/hello",
    "snapshot": "/v1/runner/snapshot",
    "ready": "/v1/runner/ready",
    "claim": "/v1/runner/claim",
    "heartbeat": "/v1/runner/heartbeat",
    "upload": "/v1/runner/upload",
    "fail": "/v1/runner/fail",
    "receipt": "/v1/runner/receipt",
    "result_summary": "/v1/runner/result-summary",
}


class RunnerApiError(Exception):
    """A typed `/v1/runner/*` error answer. The message holds the code only, never a body."""

    def __init__(self, status: int, code: str, receipt: dict[str, Any] | None) -> None:
        super().__init__(f"http {status} {code}")
        self.status = status
        self.code = code
        self.receipt = receipt


class ProtocolError(Exception):
    """An answer the protocol does not allow."""


def retry_after_s(reply: Reply) -> float | None:
    header = reply.headers.get("retry-after")
    if header is not None:
        try:
            seconds = float(header)
            if seconds >= 0:
                return seconds
        except ValueError:
            try:
                return max(0.0, parsedate_to_datetime(header).timestamp() - time.time())
            except (TypeError, ValueError):
                pass
    try:
        ms = float(reply.headers.get("retry-after-ms", ""))
    except ValueError:
        return None
    return ms / 1000 if ms > 0 else None


def _jittered(seconds: float) -> float:
    return random.random() * seconds


def send_with_retries(method: str, url: str, headers: dict[str, str], data: bytes | None, budget_s: float = CALL_BUDGET_S) -> Reply:
    deadline = time.monotonic() + budget_s
    last: Reply | None = None
    for attempt in range(MAX_ATTEMPTS):
        timeout = min(ATTEMPT_TIMEOUT_S, deadline - time.monotonic())
        if timeout <= 0:
            break
        try:
            reply = send(method, url, headers, data, timeout)
        except TransportError:
            time.sleep(min(MAX_BACKOFF_S, _jittered(BASE_BACKOFF_S * 2**attempt), max(0.0, deadline - time.monotonic())))
            continue
        last = reply
        if reply.status not in RETRY_STATUSES or attempt == MAX_ATTEMPTS - 1:
            return reply
        after = retry_after_s(reply)
        wait = after + random.random() * min(1 + after * 0.2, 5) if after is not None else min(MAX_BACKOFF_S, _jittered(BASE_BACKOFF_S * 2**attempt))
        if time.monotonic() + wait >= deadline:
            return reply
        time.sleep(wait)
    if last is not None:
        return last
    raise TransportError("unreachable")


def parse_reply(reply: Reply) -> dict[str, Any]:
    try:
        body = json.loads(reply.body) if reply.body else None
    except ValueError:
        body = None
    if 200 <= reply.status < 300:
        if not isinstance(body, dict):
            raise ProtocolError("the answer is not a JSON object")
        return body
    error = body.get("error") if isinstance(body, dict) else None
    code = error.get("code") if isinstance(error, dict) and isinstance(error.get("code"), str) else f"http_{reply.status}"
    receipt = body.get("receipt") if isinstance(body, dict) and code == "work_terminal" and isinstance(body.get("receipt"), dict) else None
    raise RunnerApiError(reply.status, code, receipt)


def terminal_key(work_id: str, retry_attempt: int, endpoint: str) -> str:
    """Plan 4.4: executable work is one whole item per run, so the key names no lease generation."""
    return f"{work_id}:{retry_attempt}:{endpoint}"


class RunnerClient:
    def __init__(self, api_base: str) -> None:
        self.api_base = api_base.rstrip("/")
        self.session_id: str | None = None
        self.credential: str | None = None

    def _post(self, path: str, body: dict[str, Any], bearer: str, key: str | None, budget_s: float = CALL_BUDGET_S) -> dict[str, Any]:
        headers = {"authorization": f"Bearer {bearer}", "content-type": "application/json", "user-agent": USER_AGENT, "accept": "application/json"}
        if key is not None:
            headers[IDEMPOTENCY_HEADER] = key
        # The same bytes on every attempt, so a replay matches the stored body digest.
        data = json.dumps(body, separators=(",", ":")).encode()
        return parse_reply(send_with_retries("POST", self.api_base + path, headers, data, budget_s))

    def _auth(self) -> tuple[str, str]:
        if self.session_id is None or self.credential is None:
            raise ProtocolError("no session yet")
        return self.session_id, self.credential

    def hello(self, bootstrap_key: str, body: dict[str, Any]) -> dict[str, Any]:
        answer = self._post(ENDPOINTS["hello"], body, bootstrap_key, None)
        if answer.get("outcome") == "session":
            if answer.get("lease_ttl_s") != 90:
                raise ProtocolError("hello lease_ttl_s must be 90")
            self.session_id = str(answer["session_id"])
            self.credential = str(answer["session_credential"])
        elif answer.get("outcome") not in ("done", "blocked"):
            raise ProtocolError("hello outcome is unknown")
        return answer

    def snapshot(self, body: dict[str, Any]) -> dict[str, Any]:
        session_id, credential = self._auth()
        return self._post(ENDPOINTS["snapshot"], {"session_id": session_id, **body}, credential, f"{session_id}:snapshot")

    def ready(self, contract_digests: list[str]) -> dict[str, Any]:
        session_id, credential = self._auth()
        return self._post(ENDPOINTS["ready"], {"session_id": session_id, "contract_digests": contract_digests}, credential, f"{session_id}:ready")

    def claim(self, claim_seq: int, slots_free: int, job_end_reason: str | None = None) -> dict[str, Any]:
        """A retried claim with the same claim_seq returns the same items. `job_end_reason` closes the session (§8.3)."""
        session_id, credential = self._auth()
        body: dict[str, Any] = {"session_id": session_id, "claim_seq": claim_seq, "slots_free": slots_free}
        if job_end_reason is not None:
            body["job_end_reason"] = job_end_reason
        return self._post(ENDPOINTS["claim"], body, credential, f"{session_id}:claim:{claim_seq}")

    def heartbeat(self, leases: list[dict[str, Any]]) -> dict[str, Any]:
        """Not keyed: it only renews. A short budget, so a slow API never stalls the beat."""
        session_id, credential = self._auth()
        return self._post(ENDPOINTS["heartbeat"], {"session_id": session_id, "leases": leases}, credential, None, budget_s=20.0)

    def upload(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._terminal("upload", body)

    def fail(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._terminal("fail", body)

    def _terminal(self, endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
        session_id, credential = self._auth()
        key = terminal_key(str(body["work_id"]), int(body["retry_attempt"]), endpoint)
        try:
            answer = self._post(ENDPOINTS[endpoint], {"session_id": session_id, **body}, credential, key)
        except TransportError:
            stored = self.receipt(key)
            if stored is not None:
                return stored
            raise
        if answer.get("outcome") != "committed" or not isinstance(answer.get("receipt"), dict):
            raise ProtocolError(f"{endpoint} outcome is unknown")
        return answer

    def receipt(self, key: str) -> dict[str, Any] | None:
        _, credential = self._auth()
        url = f"{self.api_base}{ENDPOINTS['receipt']}?{urllib.parse.urlencode({'key': key})}"
        headers = {"authorization": f"Bearer {credential}", "user-agent": USER_AGENT, "accept": "application/json"}
        answer = parse_reply(send_with_retries("GET", url, headers, None, budget_s=60.0))
        if answer.get("outcome") == "not_found":
            return None
        if answer.get("outcome") != "committed":
            raise ProtocolError("receipt outcome is unknown")
        return answer

    def result_summary(self, result_set_id: str) -> dict[str, Any]:
        session_id, credential = self._auth()
        query = urllib.parse.urlencode({"session_id": session_id, "result_set": result_set_id})
        headers = {"authorization": f"Bearer {credential}", "user-agent": USER_AGENT, "accept": "application/json"}
        return parse_reply(send_with_retries("GET", f"{self.api_base}{ENDPOINTS['result_summary']}?{query}", headers, None, budget_s=60.0))
