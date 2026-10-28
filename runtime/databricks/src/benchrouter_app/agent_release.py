"""Where the agent job gets its wheel, and how a newer agent reaches an installed workspace.

This build ships the agent with the app: the app builds the wheel from the source it carries and
uploads it to the app SP's home folder, in a folder named by the wheel's digest. Connect points
the agent job at it, and every Status visit checks that the job still runs the wheel this app
carries, so updating the app's folder updates the agent the next time an admin opens the app.

B6 replaces this module's source with BenchRouter's signed release channel (RUN-002, RUN-003);
the screens call only `publish_agent_wheel` and `refresh_agent`.
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any

from benchrouter_databricks.transport import ApiError
from benchrouter_databricks.workspace import Workspace

from . import identity
from .wheel import build_agent_wheel

#: The job environment that holds the agent wheel.
AGENT_ENVIRONMENT = "agent"


def _release() -> tuple[str, str, bytes]:
    """This app's agent wheel: its folder in the app SP's home, its file name, and its bytes."""
    name, data = build_agent_wheel()
    return f"/Users/{identity.app_sp_client_id()}/benchrouter/agent/{hashlib.sha256(data).hexdigest()[:16]}", name, data


def publish_agent_wheel(app: Workspace) -> str:
    """Writes this app's agent wheel to the app SP's home folder; returns its path for the job.

    Only the app SP and workspace admins can write there, so no other user can change the code
    the agent job runs as the app SP. The upload is idempotent: the folder is named by digest.
    """
    folder, name, data = _release()
    app.call("POST", "/api/2.0/workspace/mkdirs", {"path": folder})
    app.call("POST", "/api/2.0/workspace/import", {
        "path": f"{folder}/{name}", "format": "AUTO", "overwrite": True, "content": base64.b64encode(data).decode(),
    })
    return f"/Workspace{folder}/{name}"


def agent_environment(wheel_path: str) -> dict[str, Any]:
    return {"environment_key": AGENT_ENVIRONMENT, "spec": {"client": "2", "dependencies": [wheel_path]}}


def _current_wheel_path() -> str:
    folder, name, _ = _release()
    return f"/Workspace{folder}/{name}"


def refresh_agent(app: Workspace, job_id: int | str | None) -> bool:
    """Points the agent job at this app's wheel when it runs another one. True when it changed.

    A failure changes nothing: the job keeps its wheel, and the next visit checks again.
    """
    if job_id is None:
        return False
    try:
        settings = app.call("GET", "/api/2.2/jobs/get", query={"job_id": str(job_id)}).get("settings") or {}
        environments = settings.get("environments") or []
        running = [dep for env in environments if env.get("environment_key") == AGENT_ENVIRONMENT
                   for dep in (env.get("spec") or {}).get("dependencies") or []]
        if running == [_current_wheel_path()]:
            return False
        path = publish_agent_wheel(app)
        app.call("POST", "/api/2.2/jobs/update", {"job_id": int(job_id), "new_settings": {"environments": [agent_environment(path)]}})
        return True
    except (ApiError, ValueError):
        return False
