"""The grants an eval needs before it runs (plan section 4.4).

As the app SP, before anything starts: the agent before `run-now` on every launch. It makes exactly
the reads the run makes: a refresh reads the folder's manifest and every file it declares, its
cases table and its secrets, and writes BenchRouter's artifact volume (`check_eval`); work reads the
frozen artifact from that volume and the secrets it declares (`check_frozen`). A run that still
fails on a grant (one revoked in between) reports it as before, an ordinary failure. A missing
grant is the workspace's to give, so nothing runs and nothing counts as a failure: the agent
reports `grant_needed` and the launch is cancelled with no failure, and BenchRouter checks a new
launch at each poll until the grants exist.

Each check classifies with the answers recorded live (B11 smoke 8b, 2026-10-29,
tests/fixtures/reinstall/answers.json):

- the eval folder: workspace export of the manifest and each declared file, as the refresh
  exports them. Without CAN_READ on the folder, export answers 404 RESOURCE_DOES_NOT_EXIST for
  every file while get-status still answers 200 for the folder, so a 404 is a refused read, not a
  missing file: the admin's Add eval read the manifest. Any 403 or 404 is `folder_read`;
- the cases table: Unity Catalog `tables/get`, which answers 403 PERMISSION_DENIED without
  SELECT, and 404 when the app SP can see no such table. Both are `table_select`. It needs no SQL
  warehouse, so a check never starts one;
- each declared secret: `secrets/list` on its scope (key names only; a check never reads a value).
  A refused (403) or missing scope is `secret_scope_read`; a scope without the key is
  `secret_key_missing`;
- BenchRouter's artifact volume: the Files API answers 403 PERMISSION_DENIED ("does not have
  READ VOLUME") on a volume the app SP cannot read, for example one an earlier app's SP owned.
  That is `volume_read`, which Connect heals (plan 4.2). A 404 for a file in a readable volume is
  a missing artifact, not a grant: the run reports it.

A manifest that is unreadable for any other reason (not UTF-8, invalid YAML, the route not declared,
a field the runner refuses) is not a grant: the check passes and the run reports it as before.
When the manifest itself is unreadable, the check cannot name the table and secret grants too:
BenchRouter keeps no copy of the manifest, so those show at the next check after the folder grant.
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
    rules = {"table": _table, "volume": _table, "scope": lambda value: _name(value, "_-.@"), "key": lambda value: _name(value, "_-.")}
    grant = {"kind": kind}
    grant.update({field: value for field, value in names.items() if rules[field](value)})
    return grant


def _export(workspace: Workspace, folder: str, path: str) -> bytes | None:
    """One file of the eval folder as the refresh exports it, or None when the app SP is refused.

    A transient error propagates, so the caller tries again later. Any other refusal than 403 or
    404 (a file too large to export, say) is not a grant: the run reports it.
    """
    try:
        return workspace.export_file(f"{folder.rstrip('/')}/{path}")
    except ApiError as error:
        if error.transient or not _refused(error):
            raise
        return None


def read_folder_manifest(workspace: Workspace, folder: str) -> tuple[str | None, list[dict[str, str]]]:
    """The manifest text, or None with the folder grant it needs (none for a refusal that is not a grant)."""
    try:
        data = _export(workspace, folder, MANIFEST_NAME)
    except ApiError as error:
        if error.transient:
            raise
        return None, []
    if data is None:
        return None, [_grant("folder_read")]
    try:
        return data.decode("utf-8"), []
    except UnicodeDecodeError:
        return None, []


def check_declared_files(workspace: Workspace, folder: str, manifest: EvalManifest) -> list[dict[str, str]]:
    """Each file the manifest declares, exported as the refresh copies it; the first refusal is `folder_read`."""
    for path in [*manifest.code_files, *manifest.scorer_files, manifest.requirements_lock]:
        try:
            if _export(workspace, folder, path) is None:
                return [_grant("folder_read")]
        except ApiError as error:
            if error.transient:
                raise
    return []


def check_volume(workspace: Workspace, catalog: str, schema: str) -> list[dict[str, str]]:
    """BenchRouter's artifact volume, which a refresh writes and a work run reads (Files API listing)."""
    root = volume_root(catalog, schema, ARTIFACT_VOLUME)
    try:
        workspace.call("GET", f"/api/2.0/fs/directories{urllib.parse.quote(root)}")
    except ApiError as error:
        if error.transient:
            raise
        # 404: no volume yet (Connect's setup makes it). Neither that nor another refusal is a grant.
        return [_volume_grant(catalog, schema)] if _volume_refused(error) else []
    return []


def _volume_refused(error: ApiError) -> bool:
    """The recorded refusal of a volume without READ VOLUME: 403 PERMISSION_DENIED."""
    return error.status == 403


def _volume_grant(catalog: str, schema: str) -> dict[str, str]:
    return _grant("volume_read", volume=f"{catalog}.{schema}.{ARTIFACT_VOLUME}")


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


def check_eval(workspace: Workspace, folder: str, route_key: str, own_scope: str, catalog: str | None = None,
               schema: str | None = None) -> list[dict[str, str]]:
    """What a refresh reads and writes: the folder's manifest and its files, the cases table, each
    secret, and BenchRouter's artifact volume (when the payload names the binding's schema)."""
    volume = [] if catalog is None or schema is None else check_volume(workspace, catalog, schema)
    text, missing = read_folder_manifest(workspace, folder)
    if text is None:
        return [*missing, *volume]
    manifest = parsed_manifest(text, route_key, own_scope)
    if manifest is None:
        return volume
    return [*check_declared_files(workspace, folder, manifest), *check_table(workspace, manifest.cases_table),
            *check_secrets(workspace, manifest.secrets), *volume]


def check_frozen(workspace: Workspace, catalog: str, schema: str, digest: str, route_key: str, own_scope: str) -> list[dict[str, str]]:
    """The frozen artifact's manifest in BenchRouter's volume, and each secret it declares: what a work
    run reads (runner.py).

    The work run reads no folder and no table, only its artifact in the artifact volume and the
    secrets that artifact declares, so a work launch checks exactly that. A volume the app SP may not
    read answers 403 (`volume_read`). B11 smoke 8b: the 0.2.2 check passed that 403 as "not a grant",
    and every work run then failed `tree_mutated`. The manifest is read through the Files API
    without its proof only to name the secrets; the item proves the whole artifact after its claim.
    A manifest that is missing (404) or unreadable is not a grant: the run reports it.
    """
    path = f"{volume_root(catalog, schema, ARTIFACT_VOLUME)}/{digest}/files/{MANIFEST_NAME}"
    try:
        data = workspace.download(path)
    except ApiError as error:
        if error.transient:
            raise
        return [_volume_grant(catalog, schema)] if _volume_refused(error) else []
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
