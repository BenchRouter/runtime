"""BenchRouter's API, as the app calls it: the CLI sign-in (AUTH-006) and the shared control
surface that the dashboard and the CLI also use. No Databricks-only server copy."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import urllib.parse
from typing import Any

from benchrouter_databricks import __version__
from benchrouter_databricks.transport import ApiError, request_json, with_retries

API_BASE = os.environ.get("BENCHROUTER_API_BASE", "https://api.benchrouter.com").rstrip("/")
DASHBOARD_BASE = os.environ.get("BENCHROUTER_DASHBOARD_BASE", "https://benchrouter.com").rstrip("/")
USER_AGENT = f"benchrouter-databricks-app/{__version__}"


def _call(method: str, path: str, token: str | None = None, body: Any = None) -> Any:
    headers = {"user-agent": USER_AGENT}
    if token is not None:
        headers["authorization"] = f"Bearer {token}"
    url = f"{API_BASE}{path}"
    if method == "GET":
        return with_retries(lambda: request_json(method, url, headers))
    return request_json(method, url, headers, body if body is not None else {})


def _segment(value: str) -> str:
    return urllib.parse.quote(value, safe="")


# Sign-in: the CLI authorization flow, with the CLI's default token lifetime.
def start_sign_in(host: str) -> dict[str, str]:
    """`databricks_host` tells BenchRouter which workspace this sign-in is for: a Reconnect by a new
    app SP revokes the old install's sign-ins of that workspace only (AUTH-006, AUTH-012)."""
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    answer = _call("POST", "/v1/cli/authorizations", body={
        "nonce": nonce,
        "code_challenge": challenge,
        "client_name": "BenchRouter Databricks app",
        "token_name": f"Databricks {host}"[:80],
        "databricks_host": host,
    })
    return {
        "transaction_id": answer["transaction_id"],
        "authorize_url": answer["authorize_url"],
        "expires_at": answer["expires_at"],
        "nonce": nonce,
        "verifier": verifier,
    }


def sign_in_status(pending: dict[str, str]) -> str:
    """pending, approved, denied, cancelled, exchanged or expired."""
    try:
        answer = _call("POST", f"/v1/cli/authorizations/{_segment(pending['transaction_id'])}/status",
                       body={"nonce": pending["nonce"]})
    except ApiError as error:
        if error.status in (404, 410):
            return "expired"
        raise
    return str(answer["status"])


def finish_sign_in(pending: dict[str, str]) -> dict[str, Any]:
    """Exchanges an approved sign-in once: the control token and its account."""
    answer = _call("POST", f"/v1/cli/authorizations/{_segment(pending['transaction_id'])}/exchange",
                   body={"nonce": pending["nonce"], "code_verifier": pending["verifier"]})
    return {
        "token": answer["control_token"]["token"],
        "expires_at": answer["control_token"]["expires_at"],
        "account": answer["account"],
    }


# The Databricks binding surface (`session_or_control`, AUTH-012).
def list_bindings(token: str) -> list[dict[str, Any]]:
    return _call("GET", "/v1/databricks/bindings", token)["bindings"]


def get_binding(token: str, binding_id: str) -> dict[str, Any]:
    return _call("GET", f"/v1/databricks/bindings/{_segment(binding_id)}", token)


def register_binding(token: str, fields: dict[str, Any]) -> dict[str, Any]:
    return _call("POST", "/v1/databricks/bindings", token, fields)


def record_agent(token: str, binding_id: str, agent_job_id: int, secret_scope: str) -> None:
    _call("POST", f"/v1/databricks/bindings/{_segment(binding_id)}/agent", token,
          {"agent_job_id": agent_job_id, "secret_scope": secret_scope})


def add_eval(token: str, binding_id: str, route_key: str, eval_folder: str) -> dict[str, Any]:
    return _call("POST", f"/v1/databricks/bindings/{_segment(binding_id)}/evals", token,
                 {"route_key": route_key, "eval_folder": eval_folder})


def disconnect(token: str, binding_id: str, results_owner: str | None, force: bool = False) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if results_owner:
        body["results_owner"] = results_owner
    if force:
        body["force"] = True
    return _call("POST", f"/v1/databricks/bindings/{_segment(binding_id)}/disconnect", token, body)


# Routes: the same calls the dashboard makes.
def account_routes(token: str) -> list[dict[str, Any]]:
    """Every route of the account with its serving model and latest eval (`GET /v1/hosted-evals`)."""
    return _call("GET", "/v1/hosted-evals", token).get("routes") or []


def list_groups(token: str) -> list[dict[str, Any]]:
    return _call("GET", "/v1/control/groups", token)["groups"]


def create_route(token: str, group_name: str, route_name: str, model: str) -> dict[str, Any]:
    """Add the route to the account's group of that name or short name, or create a new group with it."""
    wanted = group_name.strip().lower()
    existing = next(
        (
            group
            for group in list_groups(token)
            if group["repo"] is None and group["can_change"] and wanted in (group["name"].lower(), group["slug"])
        ),
        None,
    )
    group: dict[str, Any] = {"group_id": existing["group_id"]} if existing else {"group": {"name": group_name}}
    return _call("POST", "/v1/control/routes", token, {**group, "name": route_name, "model": model})


def catalog_models() -> list[str]:
    answer = _call("GET", "/v1/models")
    return sorted(str(entry["id"]) for entry in answer.get("data") or [] if isinstance(entry, dict) and entry.get("id"))


def dashboard_url(path: str) -> str:
    return f"{DASHBOARD_BASE}{path}"
