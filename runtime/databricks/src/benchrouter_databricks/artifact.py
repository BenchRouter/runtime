"""The frozen artifact (plan section 4.4, EVAL-002 identity).

Layout in the binding's artifact volume, written once and never changed:

    /Volumes/<catalog>/<schema>/benchrouter_artifacts/<digest>/files/<path>   every frozen file
    /Volumes/<catalog>/<schema>/benchrouter_artifacts/<digest>/artifact.json  written last

`artifact.json` is the `artifact` object the refresh reports to `/v1/runner/snapshot`. The
digest is the hex SHA-256 of the canonical JSON of `{format, python_version, platform_tag,
files}`, exactly as `databricksArtifactDigest` composes it, so a work session can prove a
copy against its planned digest with no server call.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import sysconfig
from typing import Any

from .canonical import file_digest, sha256_canonical
from .workspace import ARTIFACT_VOLUME, RESULTS_VOLUME

FORMAT = "benchrouter.databricks.artifact.v1"
API_FAMILY = "openai_chat_completions"


class TreeMutated(Exception):
    """A copied file or the digest does not match the planned artifact."""


class ArtifactMissing(Exception):
    """The planned artifact is not in the volume (a Disconnect dropped it, say): not a mismatch."""


class VolumeRefused(Exception):
    """The app SP may not read or write BenchRouter's volume (no READ VOLUME): a grant, not the eval.

    Through the volume's FUSE mount the Files API's 403 arrives as PermissionError (B11 smoke 8b).
    """


def volume_root(catalog: str, schema: str, volume: str) -> str:
    return f"/Volumes/{catalog}/{schema}/{volume}"


def python_version() -> str:
    return platform.python_version()


def platform_tag() -> str:
    """The interpreter's platform and C library, e.g. `linux_x86_64+glibc_2.35`.

    Locked wheels are built for them, so they are identity (EVAL-002); a work image that
    differs fails `install_failed`.
    """
    libc, version = platform.libc_ver()
    tag = sysconfig.get_platform().replace("-", "_")
    return f"{tag}+{libc}_{version}" if libc else tag


def artifact_digest(python: str, platform_name: str, files: dict[str, str]) -> str:
    return sha256_canonical({"format": FORMAT, "python_version": python, "platform_tag": platform_name, "files": files})


def hash_tree(root: str, paths: list[str]) -> dict[str, str]:
    return {path: file_digest(os.path.join(root, path)) for path in sorted(paths)}


def publish(local_root: str, artifact: dict[str, Any], volume: str) -> str:
    """Writes the artifact under `<volume>/<digest>/` unless it is already there. Returns the digest."""
    digest = artifact_digest(artifact["python_version"], artifact["platform_tag"], artifact["files"])
    target = os.path.join(volume, digest)
    marker = os.path.join(target, "artifact.json")
    if _exists(marker):
        # Content-addressed: an artifact frozen before (A -> B -> A) is reused, never rewritten.
        verify_copy(target, digest)
        return digest
    for path in artifact["files"]:
        destination = os.path.join(target, "files", path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copyfile(os.path.join(local_root, path), destination)
    with open(marker, "w", encoding="utf-8") as handle:
        json.dump(artifact, handle, sort_keys=True)
    return digest


def read_artifact(target: str) -> dict[str, Any]:
    with open(os.path.join(target, "artifact.json"), encoding="utf-8") as handle:
        artifact = json.load(handle)
    if not isinstance(artifact, dict) or not isinstance(artifact.get("files"), dict):
        raise TreeMutated("artifact.json")
    return artifact


def verify_copy(root: str, digest: str) -> dict[str, Any]:
    """Proves `root/files` against the planned digest; returns the artifact. Raises TreeMutated."""
    artifact = read_artifact(root)
    files = artifact["files"]
    if artifact.get("format") != FORMAT or artifact_digest(str(artifact.get("python_version")), str(artifact.get("platform_tag")), files) != digest:
        raise TreeMutated("digest")
    for path, expected in files.items():
        local = os.path.join(root, "files", path)
        if not os.path.isfile(local) or file_digest(local) != expected:
            raise TreeMutated("file")
    return artifact


def _exists(path: str) -> bool:
    """Like `os.path.exists`, but a refused read raises VolumeRefused instead of reading as absent."""
    try:
        os.stat(path)
    except FileNotFoundError:
        return False
    except PermissionError:
        raise VolumeRefused(path) from None
    return True


def copy_planned(volume: str, digest: str, destination: str) -> dict[str, Any]:
    """Copies `<volume>/<digest>/` into a private directory and verifies every file there.

    Raises ArtifactMissing when the artifact is not there, VolumeRefused when the app SP may not
    read the volume, and TreeMutated when a copied file or the digest does not match.
    """
    source = os.path.join(volume, digest)
    if not _exists(os.path.join(source, "artifact.json")):
        raise ArtifactMissing(digest)
    try:
        shutil.copytree(source, destination)
    except PermissionError:
        raise VolumeRefused(source) from None
    return verify_copy(destination, digest)
