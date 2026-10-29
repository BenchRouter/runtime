"""The grants an eval needs before it runs (plan section 4.4).

As the app SP, before anything starts: the agent before `run-now` on every launch. It checks exactly
what the run will read: a refresh the folder's manifest, its cases table and its secrets
(`check_eval`); work the frozen artifact's secrets (`check_frozen`). A run that still fails on a
grant (one revoked in between) reports it as before, an ordinary failure. A missing grant is the customer's to
give, so nothing runs and nothing counts as a failure: the agent reports `grant_needed` and the
launch is cancelled with no failure, and BenchRouter checks a new launch at each poll until the grants exist.

Each check makes the cheapest call that answers the same way the run's own read would:

- the eval folder: export of `.benchrouter/benchrouter.yml`, the refresh's first read. A refusal
  (403), or a folder the app SP cannot see at all, is `folder_read`. A folder it can read without
  the manifest is the eval's own fault, not a grant: the run reports it as before;
- the cases table: Unity Catalog `tables/get`, which answers 403 when the app SP lacks USE CATALOG,
  USE SCHEMA or any privilege on the table, and 404 when it can see no such table. Both are
  `table_select`. It needs no SQL warehouse, so a check never starts one;
- each declared secret: `secrets/list` on its scope (key names only; a check never reads a value).
  A refused or missing scope is `secret_scope_read`; a scope without the key is
  `secret_key_missing`.

A manifest that is unreadable for any other reason (not UTF-8, invalid YAML, the route not declared,
a field the runner refuses) is not a grant: the check passes and the run reports it as before.
DATA-001: a reported grant carries identifiers only, and a name outside the server's identifier
rule is left out of the report rather than sent.
"""

from __future__ import annotations

import urllib.parse
from typing import Any

from .artifact import ARTIFACT_VOLUME, volume_root
from .manifest import MANIFEST_NAME, EvalManifest, ManifestError, Secret, load_manifest
from .transport import ApiError
from .workspace import Workspace, is_not_found

MAX_NAME_LENGTH = 128
#: The server takes at most this many grants in one report (`MAX_REPORTED_GRANTS`, src/databricks/grants.ts);
#: the rest show at the next check, once these are given.
MAX_REPORTED_GRANTS = 64


class GrantNeeded(Exception):
    """A check found grants missing; `grants` is what the report names."""

    def __init__(self, grants: list[dict[str, str]]) -> None:
        super().__init__("grant_needed")
        self.grants = grants


def _name(value: str, extra: str) -> bool:
    return 0 < len(value) <= MAX_NAME_LENGTH and all(
        ("a" <= char <= "z") or ("A" <= char <= "Z") or ("0" <= char <= "9") or char in extra for char in value)


def _table(value: str) -> bool:
    parts = value.split(".")
    return len(parts) == 3 and all(_name(part, "_-") for part in parts)


def _refused(error: ApiError) -> bool:
    """A permanent refusal of the app SP: a missing permission or an object it cannot see."""
    return error.status == 403 or error.code == "PERMISSION_DENIED" or is_not_found(error)


def _grant(kind: str, **names: str) -> dict[str, str]:
    """DATA-001: the server's identifier rule (src/databricks/grants.ts); a name outside it is left out."""
    rules = {"table": _table, "scope": lambda value: _name(value, "_-.@"), "key": lambda value: _name(value, "_-.")}
    grant = {"kind": kind}
    grant.update({field: value for field, value in names.items() if rules[field](value)})
    return grant


def read_folder_manifest(workspace: Workspace, folder: str) -> tuple[str | None, list[dict[str, str]]]:
    """The manifest text, or None with the folder grant it needs (none when only the file is missing).

    A transient error propagates, so the caller tries again later.
    """
    try:
        data = workspace.export_file(f"{folder.rstrip('/')}/{MANIFEST_NAME}")
    except ApiError as error:
        if error.transient:
            raise
        if not is_not_found(error):
            return None, [_grant("folder_read")] if _refused(error) else []
        # The folder itself: one the app SP cannot see is a grant; a readable one without the file is not.
        try:
            workspace.call("GET", "/api/2.0/workspace/get-status", query={"path": folder})
        except ApiError as folder_error:
            if folder_error.transient:
                raise
            return None, [_grant("folder_read")] if _refused(folder_error) else []
        return None, []
    try:
        return data.decode("utf-8"), []
    except UnicodeDecodeError:
        return None, []


def check_table(workspace: Workspace, table: str) -> list[dict[str, str]]:
    try:
        workspace.call("GET", f"/api/2.1/unity-catalog/tables/{urllib.parse.quote(table, safe='.')}")
    except ApiError as error:
        if error.transient:
            raise
        return [_grant("table_select", table=table)] if _refused(error) else []
    return []


def check_secrets(workspace: Workspace, secrets: tuple[Secret, ...] | list[Secret]) -> list[dict[str, str]]:
    """Lists each declared scope's key names once. Reads no secret value."""
    missing: list[dict[str, str]] = []
    keys_by_scope: dict[str, set[str] | None] = {}
    for secret in secrets:
        if secret.scope not in keys_by_scope:
            try:
                listed = workspace.call("GET", "/api/2.0/secrets/list", query={"scope": secret.scope}).get("secrets") or []
                keys_by_scope[secret.scope] = {str(entry.get("key")) for entry in listed if isinstance(entry, dict)}
            except ApiError as error:
                if error.transient:
                    raise
                keys_by_scope[secret.scope] = None
                # Any other refusal is not a grant this check can name; the run reports what it meets.
                if _refused(error):
                    missing.append(_grant("secret_scope_read", scope=secret.scope))
        keys = keys_by_scope[secret.scope]
        if keys is not None and secret.key not in keys:
            missing.append(_grant("secret_key_missing", scope=secret.scope, key=secret.key))
    return missing


def parsed_manifest(text: str, route_key: str, own_scope: str) -> EvalManifest | None:
    """The runner's own parse; None when the manifest is refused for a reason that is not a grant."""
    try:
        return load_manifest(text, route_key, own_scope=own_scope)
    except ManifestError:
        return None


def check_eval(workspace: Workspace, folder: str, route_key: str, own_scope: str) -> list[dict[str, str]]:
    """Every grant the eval folder's manifest declares: the folder, the cases table, each secret."""
    text, missing = read_folder_manifest(workspace, folder)
    if text is None:
        return missing
    manifest = parsed_manifest(text, route_key, own_scope)
    if manifest is None:
        return []
    return [*check_table(workspace, manifest.cases_table), *check_secrets(workspace, manifest.secrets)]


def check_frozen(workspace: Workspace, catalog: str, schema: str, digest: str, route_key: str, own_scope: str) -> list[dict[str, str]]:
    """Each declared secret of a frozen artifact's manifest: what a work run reads (runner.py).

    The work run reads no folder and no table, only its artifact in the app SP's own volume and
    the secrets that artifact declares, so a work launch checks exactly that. The manifest is read
    through the Files API without its proof only to name the secrets; the
    item proves the whole artifact after its claim. A manifest that is missing or unreadable is
    not a grant: the item reports it.
    """
    path = f"{volume_root(catalog, schema, ARTIFACT_VOLUME)}/{digest}/files/{MANIFEST_NAME}"
    try:
        data = workspace.download(path)
    except ApiError as error:
        if error.transient:
            raise
        return []
    if data is None:
        return []
    try:
        manifest = parsed_manifest(data.decode("utf-8"), route_key, own_scope)
    except UnicodeDecodeError:
        return []
    return [] if manifest is None else check_secrets(workspace, manifest.secrets)


def require(grants: list[dict[str, Any]]) -> None:
    if grants:
        # Repeats (two declared keys missing from one refused scope report one scope) are dropped first.
        unique = [dict(entry) for entry in {tuple(sorted(grant.items())): grant for grant in grants}]
        raise GrantNeeded(unique[:MAX_REPORTED_GRANTS])
