"""The Databricks REST calls the agent makes, as the identity the job runs as (the app SP)."""

from __future__ import annotations

import base64
import os
import time
import urllib.parse
from typing import Any, Callable

from .transport import TIMEOUT_SECONDS, USER_AGENT, ApiError, _api_error, request_json, send

NOT_FOUND_CODES = {"RESOURCE_DOES_NOT_EXIST", "NOT_FOUND", "TABLE_OR_VIEW_NOT_FOUND", "ENDPOINT_NOT_FOUND"}
STATEMENT_WAIT_SECONDS = 300


def is_not_found(error: ApiError) -> bool:
    return error.status == 404 or (error.code in NOT_FOUND_CODES)


def is_already_exists(error: ApiError) -> bool:
    return error.code in {"RESOURCE_ALREADY_EXISTS", "ALREADY_EXISTS"}


class Workspace:
    def __init__(self, host: str, auth: Callable[[], dict[str, str]]) -> None:
        self.host = host.rstrip("/")
        self._auth = auth

    @classmethod
    def from_runtime(cls) -> "Workspace":
        """Inside a job task: the runtime's own credential for the job's Run as identity.

        Only the image's databricks-sdk is used, and only for this credential; no token is
        read from a file or passed on. `DATABRICKS_HOST` and `DATABRICKS_TOKEN` serve a run
        outside a job.
        """
        token = os.environ.get("DATABRICKS_TOKEN")
        host = os.environ.get("DATABRICKS_HOST")
        if token and host:
            return cls(host if host.startswith("https://") else f"https://{host}", lambda: {"authorization": f"Bearer {token}"})
        from databricks.sdk.core import Config  # the runtime image's SDK

        config = Config()
        return cls(config.host, config.authenticate)

    def call(self, method: str, path: str, body: Any = None, query: dict[str, str] | None = None) -> Any:
        return request_json(method, f"{self.host}{path}", self._auth(), body, query)

    # Secrets: the poll key and the bootstrap keys live in the app SP's scope.
    def secret_get(self, scope: str, key: str) -> str | None:
        try:
            answer = self.call("GET", "/api/2.0/secrets/get", query={"scope": scope, "key": key})
        except ApiError as error:
            if is_not_found(error):
                return None
            raise
        return base64.b64decode(answer["value"]).decode()

    def secret_keys(self, scope: str) -> list[tuple[str, int]]:
        """Each key name in the scope with its last update time (ms). Reads no value."""
        try:
            answer = self.call("GET", "/api/2.0/secrets/list", query={"scope": scope})
        except ApiError as error:
            if is_not_found(error):
                return []
            raise
        return [(str(entry["key"]), int(entry.get("last_updated_timestamp") or 0)) for entry in answer.get("secrets") or []]

    def secret_put(self, scope: str, key: str, value: str) -> None:
        self.call("POST", "/api/2.0/secrets/put", {"scope": scope, "key": key, "string_value": value})

    def secret_delete(self, scope: str, key: str) -> None:
        try:
            self.call("POST", "/api/2.0/secrets/delete", {"scope": scope, "key": key})
        except ApiError as error:
            if not is_not_found(error):
                raise

    def scope_delete(self, scope: str) -> None:
        try:
            self.call("POST", "/api/2.0/secrets/scopes/delete", {"scope": scope})
        except ApiError as error:
            if not is_not_found(error):
                raise

    # Jobs.
    def run_now(self, job_id: int, job_parameters: dict[str, str], idempotency_token: str) -> int:
        answer = self.call("POST", "/api/2.2/jobs/run-now", {
            "job_id": job_id, "job_parameters": job_parameters, "idempotency_token": idempotency_token,
        })
        return int(answer["run_id"])

    def cancel_run(self, run_id: int) -> None:
        try:
            self.call("POST", "/api/2.2/jobs/runs/cancel", {"run_id": run_id})
        except ApiError as error:
            # A run that already ended, or is gone, needs no cancel.
            if not (is_not_found(error) or error.code == "INVALID_STATE"):
                raise

    def find_job(self, name: str) -> int | None:
        answer = self.call("GET", "/api/2.2/jobs/list", query={"name": name, "limit": "2"})
        jobs = answer.get("jobs") or []
        return int(jobs[0]["job_id"]) if jobs else None

    def create_job(self, settings: dict[str, Any]) -> int:
        return int(self.call("POST", "/api/2.2/jobs/create", settings)["job_id"])

    def reset_job(self, job_id: int, settings: dict[str, Any]) -> None:
        self.call("POST", "/api/2.2/jobs/reset", {"job_id": job_id, "new_settings": settings})

    def update_job(self, job_id: int, settings: dict[str, Any]) -> None:
        self.call("POST", "/api/2.2/jobs/update", {"job_id": job_id, "new_settings": settings})

    def delete_job(self, job_id: int) -> None:
        try:
            self.call("POST", "/api/2.2/jobs/delete", {"job_id": job_id})
        except ApiError as error:
            if not (is_not_found(error) or error.code == "INVALID_PARAMETER_VALUE"):
                raise

    # Serving endpoints (external model, Custom provider).
    def get_endpoint(self, name: str) -> dict[str, Any] | None:
        try:
            return self.call("GET", f"/api/2.0/serving-endpoints/{name}")
        except ApiError as error:
            if is_not_found(error):
                return None
            raise

    def create_endpoint(self, name: str, config: dict[str, Any]) -> dict[str, Any]:
        return self.call("POST", "/api/2.0/serving-endpoints", {"name": name, "config": config})

    def update_endpoint_config(self, name: str, config: dict[str, Any]) -> None:
        self.call("PUT", f"/api/2.0/serving-endpoints/{name}/config", config)

    def delete_endpoint(self, name: str) -> None:
        try:
            self.call("DELETE", f"/api/2.0/serving-endpoints/{name}")
        except ApiError as error:
            if not is_not_found(error):
                raise

    def grant_endpoint(self, endpoint_id: str, principal: str, level: str) -> None:
        self.call("PATCH", f"/api/2.0/permissions/serving-endpoints/{endpoint_id}",
                  {"access_control_list": [acl_entry(principal, level)]})

    # Unity Gateway provider services.
    def get_provider_service(self, full_name: str) -> dict[str, Any] | None:
        try:
            return self.call("GET", f"/api/2.1/unity-catalog/model-provider-services/{full_name}")
        except ApiError as error:
            if is_not_found(error):
                return None
            raise

    def create_provider_service(self, full_name: str, config: dict[str, Any]) -> None:
        catalog, schema, name = split_full_name(full_name)
        self.call("POST", "/api/2.1/unity-catalog/model-provider-services",
                  {"comment": "BenchRouter route", "config": config},
                  query={"parent": f"schemas/{catalog}.{schema}", "model_provider_service_id": name})

    def update_provider_service(self, full_name: str, config: dict[str, Any]) -> None:
        self.call("PATCH", f"/api/2.1/unity-catalog/model-provider-services/{full_name}",
                  {"config": config}, query={"update_mask": "config"})

    def delete_provider_service(self, full_name: str) -> None:
        try:
            self.call("DELETE", f"/api/2.1/unity-catalog/model-provider-services/{full_name}")
        except ApiError as error:
            if not is_not_found(error):
                raise

    def grant_provider_service(self, full_name: str, changes: list[dict[str, Any]]) -> None:
        self.call("PATCH", f"/api/2.1/unity-catalog/permissions/model_provider_service/{full_name}", {"changes": changes})

    # Unity Catalog volumes and tables.
    def ensure_volume(self, catalog: str, schema: str, name: str) -> None:
        try:
            self.call("GET", f"/api/2.1/unity-catalog/volumes/{catalog}.{schema}.{name}")
            return
        except ApiError as error:
            if not is_not_found(error):
                raise
        try:
            self.call("POST", "/api/2.1/unity-catalog/volumes",
                      {"catalog_name": catalog, "schema_name": schema, "name": name, "volume_type": "MANAGED"})
        except ApiError as error:
            if not is_already_exists(error):
                raise

    def table_exists(self, full_name: str) -> bool:
        try:
            self.call("GET", f"/api/2.1/unity-catalog/tables/{full_name}")
            return True
        except ApiError as error:
            if is_not_found(error):
                return False
            raise

    def execute_sql(self, warehouse_id: str, statement: str, parameters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """Runs one statement and waits for it. A failed statement raises StatementFailed."""
        body: dict[str, Any] = {
            "warehouse_id": warehouse_id, "statement": statement, "wait_timeout": "30s", "on_wait_timeout": "CONTINUE",
            "format": "JSON_ARRAY", "disposition": "INLINE",
        }
        if parameters:
            body["parameters"] = parameters
        answer = self.call("POST", "/api/2.0/sql/statements", body)
        deadline = time.monotonic() + STATEMENT_WAIT_SECONDS
        while True:
            state = answer.get("status", {}).get("state")
            if state == "SUCCEEDED":
                return answer
            if state in {"FAILED", "CANCELED", "CLOSED"}:
                error = answer.get("status", {}).get("error", {})
                raise StatementFailed(str(error.get("error_code") or state))
            if time.monotonic() > deadline:
                raise StatementFailed("WAIT_TIMEOUT")
            time.sleep(3)
            answer = self.call("GET", f"/api/2.0/sql/statements/{answer['statement_id']}")

    def query(self, warehouse_id: str, statement: str, parameters: list[dict[str, Any]] | None = None) -> tuple[list[str], list[list[Any]]]:
        """Runs a query and returns its column names and every row (values as the API's strings)."""
        answer = self.execute_sql(warehouse_id, statement, parameters)
        columns = [column["name"] for column in answer.get("manifest", {}).get("schema", {}).get("columns", [])]
        rows: list[list[Any]] = []
        result = answer.get("result") or {}
        statement_id = answer["statement_id"]
        while True:
            rows.extend(result.get("data_array") or [])
            next_chunk = result.get("next_chunk_index")
            if next_chunk is None:
                return columns, rows
            result = self.call("GET", f"/api/2.0/sql/statements/{statement_id}/result/chunks/{int(next_chunk)}")

    # Unity Catalog volume files (the frozen artifacts), through the Files API.
    def download(self, path: str) -> bytes | None:
        """A volume file's bytes, or None when it does not exist. Any other refusal raises ApiError."""
        url = f"{self.host}/api/2.0/fs/files{urllib.parse.quote(path)}"
        reply = send("GET", url, {"user-agent": USER_AGENT, **self._auth()}, None, TIMEOUT_SECONDS)
        if reply.status == 404:
            return None
        if not 200 <= reply.status < 300:
            raise _api_error(reply.status, reply.body)
        return reply.body

    # Workspace files (the eval folder).
    def list_folder(self, path: str) -> list[dict[str, Any]]:
        return self.call("GET", "/api/2.0/workspace/list", query={"path": path}).get("objects") or []

    def export_file(self, path: str) -> bytes:
        """A workspace file's bytes. A notebook is exported as its source."""
        answer = self.call("GET", "/api/2.0/workspace/export", query={"path": path, "format": "AUTO"})
        return base64.b64decode(answer.get("content") or "")

    # MLflow experiments and workspace folders.
    def ensure_experiment(self, path: str) -> str:
        parent = path.rsplit("/", 1)[0]
        self.call("POST", "/api/2.0/workspace/mkdirs", {"path": parent})
        found = self.find_experiment(path)
        if found is not None:
            return found
        try:
            return str(self.call("POST", "/api/2.0/mlflow/experiments/create", {"name": path})["experiment_id"])
        except ApiError as error:
            if not is_already_exists(error):
                raise
        found = self.find_experiment(path)
        if found is None:
            raise ApiError(404, "RESOURCE_DOES_NOT_EXIST")
        return found

    def find_experiment(self, path: str) -> str | None:
        try:
            answer = self.call("GET", "/api/2.0/mlflow/experiments/get-by-name", query={"experiment_name": path})
        except ApiError as error:
            if is_not_found(error):
                return None
            raise
        return str(answer["experiment"]["experiment_id"])

    def grant_experiment(self, experiment_id: str, principal: str, level: str) -> None:
        self.call("PATCH", f"/api/2.0/permissions/experiments/{experiment_id}",
                  {"access_control_list": [acl_entry(principal, level)]})


class StatementFailed(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def acl_entry(principal: str, level: str) -> dict[str, str]:
    """A workspace ACL entry: an email is a user, anything else a group."""
    field = "user_name" if "@" in principal else "group_name"
    return {field: principal, "permission_level": level}


def split_full_name(full_name: str) -> tuple[str, str, str]:
    parts = full_name.split(".")
    if len(parts) != 3 or not all(parts):
        raise ValueError("a full name is <catalog>.<schema>.<name>")
    return parts[0], parts[1], parts[2]


def quote_identifier(name: str) -> str:
    """A Databricks SQL identifier in backticks. A name with a backtick is refused, not escaped."""
    if not name or "`" in name:
        raise ValueError("identifier")
    return f"`{name}`"


def quote_full_name(full_name: str) -> str:
    return ".".join(quote_identifier(part) for part in split_full_name(full_name))
