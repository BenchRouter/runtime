"""What the app keeps: each admin's BenchRouter sign-in, in the app SP's own secret scope.

The CLI keeps its control token in its config file; the app keeps it here, one key per
Databricks user, and never in a log. Key names hold a hash of the user name, not the name:
any workspace user can list scope and key names (plan section 4.9). The agent's `disconnect`
deletes the scope, which signs every admin out.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from benchrouter_databricks.transport import ApiError
from benchrouter_databricks.workspace import Workspace, is_already_exists

#: The scope Connect names for the agent (`AGENT_SECRET_SCOPE` on the server).
SCOPE = "benchrouter"


def _user_key(kind: str, user_name: str) -> str:
    return f"{kind}-{hashlib.sha256(user_name.lower().encode()).hexdigest()[:24]}"


def ensure_scope(workspace: Workspace) -> None:
    try:
        workspace.call("POST", "/api/2.0/secrets/scopes/create", {"scope": SCOPE})
    except ApiError as error:
        if not is_already_exists(error):
            raise


def _read(workspace: Workspace, key: str) -> dict[str, Any] | None:
    value = workspace.secret_get(SCOPE, key)
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _write(workspace: Workspace, key: str, value: dict[str, Any]) -> None:
    ensure_scope(workspace)
    workspace.secret_put(SCOPE, key, json.dumps(value))


def sign_in(workspace: Workspace, user_name: str) -> dict[str, Any] | None:
    """`{token, expires_at, account}` of the user's BenchRouter sign-in, or None."""
    return _read(workspace, _user_key("control", user_name))


def save_sign_in(workspace: Workspace, user_name: str, value: dict[str, Any]) -> None:
    _write(workspace, _user_key("control", user_name), value)


def forget_sign_in(workspace: Workspace, user_name: str) -> None:
    workspace.secret_delete(SCOPE, _user_key("control", user_name))


def pending_sign_in(workspace: Workspace, user_name: str) -> dict[str, Any] | None:
    """The user's open CLI authorization transaction: its id, nonce and PKCE verifier."""
    return _read(workspace, _user_key("signin", user_name))


def save_pending_sign_in(workspace: Workspace, user_name: str, value: dict[str, Any]) -> None:
    _write(workspace, _user_key("signin", user_name), value)


def forget_pending_sign_in(workspace: Workspace, user_name: str) -> None:
    workspace.secret_delete(SCOPE, _user_key("signin", user_name))
