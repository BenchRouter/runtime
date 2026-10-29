"""What the app keeps: each admin's BenchRouter sign-in, in this install's own secret scope.

The CLI keeps its control token in its config file; the app keeps it here, one key per
Databricks user, and never in a log. Key names hold a hash of the user name, not the name:
any workspace user can list scope and key names (plan section 4.9). The agent's `disconnect`
deletes the scope, which signs every admin out.

Each install has its own scope, named from its app SP (plan section 4.1). Deleting the app
deletes its SP but not the scope that SP made, which keeps its ACL: a new app's SP could not
write a shared name (B11 smoke, 2026-10-29). The name is known before any BenchRouter call, so
sign-in works first, and Connect names the same scope for the agent.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from benchrouter_databricks.manifest import BENCHROUTER_SCOPE_PREFIX
from benchrouter_databricks.transport import ApiError
from benchrouter_databricks.workspace import Workspace, is_already_exists

from . import identity


def install_scope(app_sp_application_id: str) -> str:
    """The scope of the install whose app SP this is: `agentSecretScope` on the server (connect.ts)."""
    digest = hashlib.sha256(app_sp_application_id.lower().encode()).hexdigest()
    return f"{BENCHROUTER_SCOPE_PREFIX}{digest[:12]}"


def scope() -> str:
    """This install's scope."""
    return install_scope(identity.app_sp_client_id())


def _user_key(kind: str, user_name: str) -> str:
    return f"{kind}-{hashlib.sha256(user_name.lower().encode()).hexdigest()[:24]}"


def ensure_scope(workspace: Workspace) -> None:
    try:
        workspace.call("POST", "/api/2.0/secrets/scopes/create", {"scope": scope()})
    except ApiError as error:
        if not is_already_exists(error):
            raise


def _read(workspace: Workspace, key: str) -> dict[str, Any] | None:
    value = workspace.secret_get(scope(), key)
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _write(workspace: Workspace, key: str, value: dict[str, Any]) -> None:
    ensure_scope(workspace)
    workspace.secret_put(scope(), key, json.dumps(value))


def sign_in(workspace: Workspace, user_name: str) -> dict[str, Any] | None:
    """`{token, expires_at, account}` of the user's BenchRouter sign-in, or None."""
    return _read(workspace, _user_key("control", user_name))


def save_sign_in(workspace: Workspace, user_name: str, value: dict[str, Any]) -> None:
    _write(workspace, _user_key("control", user_name), value)


def forget_sign_in(workspace: Workspace, user_name: str) -> None:
    workspace.secret_delete(scope(), _user_key("control", user_name))


def pending_sign_in(workspace: Workspace, user_name: str) -> dict[str, Any] | None:
    """The user's open CLI authorization transaction: its id, nonce and PKCE verifier."""
    return _read(workspace, _user_key("signin", user_name))


def save_pending_sign_in(workspace: Workspace, user_name: str, value: dict[str, Any]) -> None:
    _write(workspace, _user_key("signin", user_name), value)


def forget_pending_sign_in(workspace: Workspace, user_name: str) -> None:
    workspace.secret_delete(scope(), _user_key("signin", user_name))
