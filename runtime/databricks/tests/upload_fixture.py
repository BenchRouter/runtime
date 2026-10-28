"""Builds the upload fixture the server test replays (test/replay-databricks-runner-protocol.test.ts).

The fixture is what this wheel sends for the recorded eval in `fixtures/`: the refresh's
artifact and digest, and a work item's case rows, quality and payload digest, made from a
recorded MLflow result by the receipt adapter. The server test pushes it through activation and
the shared upload path, so a change on either side that breaks byte compatibility fails there.
`python -m tests.upload_fixture` rewrites it; test_upload_fixture.py checks it is current.
"""

from __future__ import annotations

import json
import os
from typing import Any

from benchrouter_databricks.artifact import artifact_digest, hash_tree
from benchrouter_databricks.canonical import canonical_json, sha256_digest
from benchrouter_databricks.manifest import MANIFEST_NAME, load_manifest
from benchrouter_databricks.receipt import Case, build_receipt, read_receipt
from benchrouter_databricks.refresh import acceptance_refs, describe_artifact, input_refs

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.join(HERE, "fixtures", "eval")
TARGET = os.path.join(HERE, "..", "..", "..", "test", "fixtures", "databricks", "runner-wheel-upload.json")
#: The route and the model of the server test's result set.
ROUTE_KEY = "oidc-fixtures/claims"
MODEL = "openai/gpt-oss-20b"
PYTHON = "3.12.3"
PLATFORM = "linux_x86_64+glibc_2.35"


def load_cases() -> list[dict[str, Any]]:
    with open(os.path.join(EVAL, "cases.jsonl"), encoding="utf-8") as handle:
        return [json.loads(line) for line in handle]


def build() -> dict[str, Any]:
    with open(os.path.join(EVAL, MANIFEST_NAME), encoding="utf-8") as handle:
        manifest = load_manifest(handle.read(), ROUTE_KEY)
    cases = load_cases()
    files = hash_tree(EVAL, [*input_refs(manifest, []), *acceptance_refs(manifest)])
    artifact = describe_artifact(manifest, [], files, cases, PYTHON, PLATFORM)
    with open(os.path.join(HERE, "fixtures", "mlflow-results.json"), encoding="utf-8") as handle:
        results = json.load(handle)
    receipt = build_receipt([Case(case["case_id"], case["critical"]) for case in cases], results, manifest.normalization)
    rows, quality = read_receipt(receipt, manifest.normalization.primary_metric, MODEL)
    return {
        "artifact": artifact,
        "artifact_digest": artifact_digest(PYTHON, PLATFORM, files),
        "model": MODEL,
        "case_results": rows,
        "quality": quality,
        "payload_digest": sha256_digest(canonical_json(rows)),
    }


def render() -> str:
    return json.dumps(build(), indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    with open(TARGET, "w", encoding="utf-8") as handle:
        handle.write(render())
