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
def start_sign_in(client_label: str) -> dict[str, str]:
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    answer = _call("POST", "/v1/cli/authorizations", body={
        "nonce": nonce,
        "code_challenge": challenge,
        "client_name": "BenchRouter Databricks app",
        "token_name": client_label[:80],
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


def expose_route(token: str, binding_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    return _call("POST", f"/v1/databricks/bindings/{_segment(binding_id)}/exposures", token, fields)


def unexpose_route(token: str, binding_id: str, route_key: str) -> None:
    _call("POST", f"/v1/databricks/bindings/{_segment(binding_id)}/exposures/retire", token, {"route_key": route_key})


def disconnect(token: str, binding_id: str, results_owner: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if results_owner:
        body["results_owner"] = results_owner
    return _call("POST", f"/v1/databricks/bindings/{_segment(binding_id)}/disconnect", token, body)


# Routes: the same calls the dashboard makes.
def account_routes(token: str) -> list[dict[str, Any]]:
    """Every route of the account with its serving model and latest eval (`GET /v1/hosted-evals`)."""
    return _call("GET", "/v1/hosted-evals", token).get("routes") or []


def create_route(token: str, product_name: str, route_name: str, model: str) -> dict[str, Any]:
    return _call("POST", "/v1/control/routes", token, {"product": {"name": product_name}, "name": route_name, "model": model})


def catalog_models() -> list[str]:
    answer = _call("GET", "/v1/models")
    return sorted(str(entry["id"]) for entry in answer.get("data") or [] if isinstance(entry, dict) and entry.get("id"))


def dashboard_url(path: str) -> str:
    return f"{DASHBOARD_BASE}{path}"
