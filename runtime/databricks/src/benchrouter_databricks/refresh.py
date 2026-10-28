"""The refresh of fixed cases (plan section 4.4, `purpose = snapshot_refresh`).

As the app SP, in the runner parent: read the eval folder's `.benchrouter/benchrouter.yml`, copy the
declared code, freeze the cases table at a pinned Delta version into `cases.jsonl` (ordered by
opaque case id), download every locked wheel binary-only and hash-checked, then write the
content-addressed artifact to the artifact volume and report its manifest of hashes. The
server composes the contract digest and the fingerprints and activates it.

Nothing here runs customer code: wheels are only downloaded (`pip download --only-binary
:all:` runs no package code) and the code files are only copied.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets as token_source
import subprocess
import sys
import tempfile
from typing import Any

from .artifact import API_FAMILY, ARTIFACT_VOLUME, FORMAT, artifact_digest, hash_tree, platform_tag, publish, python_version, volume_root
from .canonical import canonical_json
from .manifest import MANIFEST_NAME, EvalManifest, ManifestError, load_manifest
from .transport import ApiError, TransportError, with_retries
from .workspace import StatementFailed, Workspace, quote_full_name, quote_identifier

#: Plan 4.4: an evaluation dataset holds at most 2000 records.
MAX_CASES = 2000
CASE_SALT_KEY = "case-id-salt"
PIP_TIMEOUT_S = 600
#: The pip settings a customer may need for a private index; nothing else reaches pip.
PIP_ENV_NAMES = ("PATH", "HOME", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_TRUSTED_HOST", "PIP_CERT",
                 "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE")


class RefreshFailed(Exception):
    """The refresh cannot freeze the eval. `cause` is the fixed code reported to the server."""

    def __init__(self, cause: str) -> None:
        super().__init__(cause)
        self.cause = cause


def case_id(salt: str, source_id: str) -> str:
    """DATA-001: an opaque case id, HMAC-SHA256 of the source record id under the scope's salt."""
    return hmac.new(salt.encode(), source_id.encode(), hashlib.sha256).hexdigest()


def case_salt(workspace: Workspace, scope: str) -> str:
    salt = with_retries(lambda: workspace.secret_get(scope, CASE_SALT_KEY))
    if salt is None:
        with_retries(lambda: workspace.secret_put(scope, CASE_SALT_KEY, token_source.token_hex(32)))
        salt = with_retries(lambda: workspace.secret_get(scope, CASE_SALT_KEY))
    if not salt:
        raise RefreshFailed("case_salt_unavailable")
    return salt


def _json_object(value: Any, cause: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise RefreshFailed(cause)
    try:
        parsed = json.loads(value)
    except ValueError:
        raise RefreshFailed(cause) from None
    if not isinstance(parsed, dict):
        raise RefreshFailed(cause)
    return parsed


def _critical(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if value in ("true", "false"):
        return value == "true"
    raise RefreshFailed("cases_invalid")


def freeze_cases(workspace: Workspace, warehouse_id: str, manifest: EvalManifest, salt: str) -> list[dict[str, Any]]:
    """The cases at the table's current Delta version, as `cases.jsonl` records sorted by case id."""
    try:
        table = quote_full_name(manifest.cases_table)
        columns = [manifest.id_column, manifest.inputs_column, manifest.expectations_column, manifest.critical_column]
        selected = ", ".join(quote_identifier(column) if column else "NULL" for column in columns)
    except ValueError:
        raise RefreshFailed("manifest_invalid") from None
    try:
        names, history = workspace.query(warehouse_id, f"DESCRIBE HISTORY {table} LIMIT 1")
        if not history or "version" not in names:
            raise RefreshFailed("cases_unreadable")
        version = int(history[0][names.index("version")])
        _, rows = workspace.query(warehouse_id, f"SELECT {selected} FROM {table} VERSION AS OF {version}")
    except StatementFailed:
        raise RefreshFailed("cases_unreadable") from None
    except ApiError as error:
        if error.transient:
            raise
        raise RefreshFailed("cases_unreadable") from None
    if not rows:
        raise RefreshFailed("cases_empty")
    if len(rows) > MAX_CASES:
        raise RefreshFailed("cases_too_many")
    cases: dict[str, dict[str, Any]] = {}
    for source_id, inputs, expectations, critical in rows:
        if source_id is None or source_id == "":
            raise RefreshFailed("cases_invalid")
        record = {
            "case_id": case_id(salt, str(source_id)),
            "inputs": _json_object(inputs, "cases_invalid"),
            "expectations": None if expectations is None else _json_object(expectations, "cases_invalid"),
            "critical": _critical(critical),
        }
        if record["case_id"] in cases:
            raise RefreshFailed("case_id_duplicate")
        cases[record["case_id"]] = record
    return [cases[key] for key in sorted(cases)]


def copy_declared(workspace: Workspace, folder: str, paths: list[str], root: str) -> None:
    for path in paths:
        try:
            data = workspace.export_file(f"{folder.rstrip('/')}/{path}")
        except ApiError as error:
            if error.transient:
                raise
            raise RefreshFailed("eval_folder_unreadable") from None
        destination = os.path.join(root, path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as handle:
            handle.write(data)


def download_wheels(lockfile: str, wheels: str) -> list[str]:
    """`pip download` binary-only and hash-checked, on this image. Returns `wheels/<file>` paths."""
    os.makedirs(wheels, exist_ok=True)
    env = {name: os.environ[name] for name in PIP_ENV_NAMES if name in os.environ}
    command = [sys.executable, "-m", "pip", "download", "--disable-pip-version-check", "--no-input", "--only-binary", ":all:",
               "--require-hashes", "--no-deps", "--dest", wheels, "--requirement", lockfile]
    try:
        completed = subprocess.run(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   timeout=PIP_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        raise RefreshFailed("wheel_download_failed") from None
    if completed.returncode != 0:
        # pip's own words name packages, never case content; they stay in the job log.
        sys.stderr.write(completed.stderr.decode(errors="replace")[-4000:])
        raise RefreshFailed("wheel_download_failed")
    names = sorted(name for name in os.listdir(wheels) if name.endswith(".whl"))
    if not names:
        raise RefreshFailed("wheel_download_failed")
    return [f"wheels/{name}" for name in names]


def build_artifact(workspace: Workspace, folder: str, route_key: str, warehouse_id: str, scope: str, root: str) -> tuple[dict[str, Any], EvalManifest]:
    """Freezes the eval into `root`; returns the reported artifact object and the manifest."""
    copy_declared(workspace, folder, [MANIFEST_NAME], root)
    try:
        with open(os.path.join(root, MANIFEST_NAME), encoding="utf-8") as handle:
            manifest = load_manifest(handle.read(), route_key, own_scope=scope)
    except UnicodeDecodeError:
        raise RefreshFailed("manifest_invalid") from None
    except ManifestError as error:
        print(f"benchrouter-runner manifest refused: {error}", flush=True)
        raise RefreshFailed(error.code) from None
    copy_declared(workspace, folder, [*manifest.code_files, *manifest.scorer_files, manifest.requirements_lock], root)
    cases = freeze_cases(workspace, warehouse_id, manifest, case_salt(workspace, scope))
    with open(os.path.join(root, "cases.jsonl"), "w", encoding="utf-8") as handle:
        for record in cases:
            handle.write(canonical_json(record) + "\n")
    wheels = download_wheels(os.path.join(root, manifest.requirements_lock), os.path.join(root, "wheels"))
    files = hash_tree(root, [*input_refs(manifest, wheels), *acceptance_refs(manifest)])
    artifact = describe_artifact(manifest, wheels, files, cases, python_version(), platform_tag())
    return artifact, manifest


def input_refs(manifest: EvalManifest, wheels: list[str]) -> list[str]:
    return ["cases.jsonl", *manifest.code_files, manifest.requirements_lock, *wheels]


def acceptance_refs(manifest: EvalManifest) -> list[str]:
    """The scorers and the manifest (normalization, secrets) are the acceptance side."""
    return [*manifest.scorer_files, MANIFEST_NAME]


def describe_artifact(manifest: EvalManifest, wheels: list[str], files: dict[str, str], cases: list[dict[str, Any]],
                      python: str, platform_name: str) -> dict[str, Any]:
    """The `artifact` object `composeDatabricksRouteContract` reads (src/runner/snapshot-contract.ts)."""
    artifact: dict[str, Any] = {
        "format": FORMAT,
        "python_version": python,
        "platform_tag": platform_name,
        "files": files,
        "manifest_path": MANIFEST_NAME,
        "lockfile": manifest.requirements_lock,
        "input_refs": input_refs(manifest, wheels),
        "acceptance_refs": acceptance_refs(manifest),
        "primary_metric": manifest.normalization.primary_metric,
        "api_family": API_FAMILY,
        "secret_env": sorted(secret.env for secret in manifest.secrets),
        "timeout_minutes": manifest.timeout_minutes,
        "case_count": len(cases),
        "critical_case_count": sum(1 for record in cases if record["critical"]),
    }
    if manifest.base_url_env is not None:
        artifact["base_url_env"] = manifest.base_url_env
    return artifact


def run_refresh(workspace: Workspace, folder: str, route_key: str, warehouse_id: str, scope: str, catalog: str, schema: str) -> dict[str, Any]:
    """The snapshot body to report: an artifact, or `databricks_unavailable` with a fixed cause."""
    with tempfile.TemporaryDirectory(prefix="benchrouter-refresh-") as root:
        try:
            artifact, _ = build_artifact(workspace, folder, route_key, warehouse_id, scope, root)
            digest = publish(root, artifact, volume_root(catalog, schema, ARTIFACT_VOLUME))
        except RefreshFailed as failure:
            return {"kind": "databricks_unavailable", "cause": failure.cause}
        except OSError:
            return {"kind": "databricks_unavailable", "cause": "artifact_write_failed"}
        except TransportError:
            return {"kind": "databricks_unavailable", "cause": "workspace_unreachable"}
        except ApiError as error:
            return {"kind": "databricks_unavailable", "cause": f"workspace_http_{error.status}"}
    assert digest == artifact_digest(artifact["python_version"], artifact["platform_tag"], artifact["files"])
    return {"kind": "databricks_artifact", "artifact_digest": digest, "artifact": artifact}
