"""A small JSON client over urllib. The agent imports no third-party package for its calls."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from . import __version__

# Cloudflare answers Python's default `Python-urllib/*` agent with 403 (error 1010) before
# the Worker (plan section 4.2), so every call names the agent.
USER_AGENT = f"benchrouter-databricks-agent/{__version__}"
TIMEOUT_SECONDS = 60


class ApiError(Exception):
    """An HTTP answer outside 2xx. `code` is the API's error code when the body names one.

    `detail` is the error object of the body (BenchRouter's `error`, or Databricks' whole body),
    for the app to show to the admin. The agent never logs it.
    """

    def __init__(self, status: int, code: str | None, detail: dict[str, Any] | None = None) -> None:
        super().__init__(f"http {status} {code or ''}".strip())
        self.status = status
        self.code = code
        self.detail = detail or {}

    @property
    def message(self) -> str | None:
        message = self.detail.get("message")
        return message if isinstance(message, str) else None

    @property
    def transient(self) -> bool:
        return self.status == 429 or self.status >= 500


class TransportError(Exception):
    """No HTTP answer: a network error or a timeout."""


def _api_error(status: int, body: bytes) -> ApiError:
    try:
        parsed = json.loads(body)
    except ValueError:
        return ApiError(status, None)
    if not isinstance(parsed, dict):
        return ApiError(status, None)
    # Databricks: {"error_code": "...", "message": "..."}; BenchRouter: {"error": {"code": "...", "message": "..."}}.
    code = parsed.get("error_code")
    if isinstance(code, str):
        return ApiError(status, code, parsed)
    error = parsed.get("error")
    if isinstance(error, dict) and isinstance(error.get("code"), str):
        return ApiError(status, error["code"], error)
    return ApiError(status, None)


def request_json(
    method: str,
    url: str,
    headers: dict[str, str],
    body: Any = None,
    query: dict[str, str] | None = None,
) -> Any:
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    data = None if body is None else json.dumps(body).encode()
    all_headers = {"user-agent": USER_AGENT, "accept": "application/json", **headers}
    if data is not None:
        all_headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=all_headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        raise _api_error(error.code, error.read()) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        raise TransportError(type(error).__name__) from None
    if not payload:
        return {}
    return json.loads(payload)


class Reply:
    """An HTTP answer of any status."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body


def send(method: str, url: str, headers: dict[str, str], data: bytes | None, timeout: float) -> Reply:
    """One HTTP attempt. Every status is an answer; only a network error or timeout raises."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return Reply(response.status, {name.lower(): value for name, value in response.headers.items()}, response.read())
    except urllib.error.HTTPError as error:
        return Reply(error.code, {name.lower(): value for name, value in error.headers.items()}, error.read())
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
        raise TransportError(type(error).__name__) from None


def with_retries(call: Callable[[], Any], attempts: int = 3) -> Any:
    """Repeats a call after a transport error or a 429 or 5xx answer, with a short backoff."""
    for attempt in range(attempts):
        try:
            return call()
        except TransportError:
            if attempt == attempts - 1:
                raise
        except ApiError as error:
            if not error.transient or attempt == attempts - 1:
                raise
        time.sleep(2**attempt)
    raise AssertionError("unreachable")
