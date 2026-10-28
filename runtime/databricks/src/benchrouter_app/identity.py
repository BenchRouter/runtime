"""The two Databricks identities the app acts as (plan section 4.1).

- The app SP, from the client credentials Databricks injects. They go only to this workspace's
  own token endpoint.
- The signed-in admin, from the `X-Forwarded-Access-Token` the Apps proxy forwards (OBO). The
  app uses it only for what the admin must authorize: SQL grants and folder permissions.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from benchrouter_databricks.transport import TIMEOUT_SECONDS, USER_AGENT, ApiError, TransportError
from benchrouter_databricks.workspace import Workspace

#: The workspace scope of the app SP token that proves the host to BenchRouter (AUTH-012).
APP_SP_PROOF_SCOPE = "iam.current-user:read"
#: Renew a cached token this many seconds before it expires.
TOKEN_MARGIN_SECONDS = 120


def workspace_url() -> str:
    host = os.environ["DATABRICKS_HOST"].rstrip("/")
    return host if host.startswith("https://") else f"https://{host}"


def app_sp_client_id() -> str:
    return os.environ["DATABRICKS_CLIENT_ID"]


def mint_app_sp_token(scope: str) -> tuple[str, float]:
    """A client-credentials token of the app SP for `scope`, and its expiry time."""
    credentials = f"{app_sp_client_id()}:{os.environ['DATABRICKS_CLIENT_SECRET']}".encode()
    request = urllib.request.Request(
        f"{workspace_url()}/oidc/v1/token",
        data=urllib.parse.urlencode({"grant_type": "client_credentials", "scope": scope}).encode(),
        method="POST",
        headers={
            "authorization": f"Basic {base64.b64encode(credentials).decode()}",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            answer = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise ApiError(error.code, "app_sp_token_refused") from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        raise TransportError(type(error).__name__) from None
    return str(answer["access_token"]), time.time() + float(answer.get("expires_in", 3600))


class _AppSpToken:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires = 0.0

    def headers(self) -> dict[str, str]:
        with self._lock:
            if self._token is None or time.time() > self._expires - TOKEN_MARGIN_SECONDS:
                self._token, self._expires = mint_app_sp_token("all-apis")
            return {"authorization": f"Bearer {self._token}"}


_app_sp_token = _AppSpToken()


def app_workspace() -> Workspace:
    """The workspace API as the app SP."""
    return Workspace(workspace_url(), _app_sp_token.headers)


def user_workspace(forwarded_token: str) -> Workspace:
    """The workspace API as the signed-in admin (OBO)."""
    return Workspace(workspace_url(), lambda: {"authorization": f"Bearer {forwarded_token}"})


def workspace_id() -> str:
    """The workspace id: the Apps environment names it; else the `aud` of an app SP token."""
    named = os.environ.get("DATABRICKS_WORKSPACE_ID")
    if named:
        return named
    token, _ = mint_app_sp_token(APP_SP_PROOF_SCOPE)
    payload = token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    audience = claims["aud"]
    return str(audience[0] if isinstance(audience, list) else audience)
