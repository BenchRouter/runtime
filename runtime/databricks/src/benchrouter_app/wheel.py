"""The agent wheel, built from the source the app ships with (PEP 427).

The app is installed from a folder, so it carries the agent's source, not a built wheel. At
Connect it packs `benchrouter_databricks` into a pure-Python wheel with fixed file times, so the
same source always gives the same bytes and the same digest. The digest names the upload
folder, so a new agent version never reuses a cached older wheel.
"""

from __future__ import annotations

import base64
import hashlib
import io
import tomllib
import zipfile
from pathlib import Path

PACKAGE = "benchrouter_databricks"
_FIXED_TIME = (1980, 1, 1, 0, 0, 0)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _record_hash(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")


def build_agent_wheel() -> tuple[str, bytes]:
    """The wheel's file name and bytes."""
    project = tomllib.loads((_PROJECT_ROOT / "pyproject.toml").read_text())["project"]
    version = project["version"]
    dist_name = project["name"].replace("-", "_")
    dist_info = f"{dist_name}-{version}.dist-info"
    files: list[tuple[str, bytes]] = []
    package_dir = _PROJECT_ROOT / "src" / PACKAGE
    for path in sorted(package_dir.rglob("*.py")):
        files.append((path.relative_to(package_dir.parent).as_posix(), path.read_bytes()))
    scripts = "".join(f"{name} = {target}\n" for name, target in sorted(project.get("scripts", {}).items()))
    files.append((f"{dist_info}/METADATA", (
        f"Metadata-Version: 2.1\nName: {project['name']}\nVersion: {version}\n"
        f"Requires-Python: {project.get('requires-python', '>=3.11')}\n"
    ).encode()))
    files.append((f"{dist_info}/WHEEL", b"Wheel-Version: 1.0\nGenerator: benchrouter-app\nRoot-Is-Purelib: true\nTag: py3-none-any\n"))
    files.append((f"{dist_info}/entry_points.txt", f"[console_scripts]\n{scripts}".encode()))
    record = "".join(f"{name},{_record_hash(data)},{len(data)}\n" for name, data in files) + f"{dist_info}/RECORD,,\n"
    files.append((f"{dist_info}/RECORD", record.encode()))

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files:
            info = zipfile.ZipInfo(name, date_time=_FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    return f"{dist_name}-{version}-py3-none-any.whl", buffer.getvalue()
