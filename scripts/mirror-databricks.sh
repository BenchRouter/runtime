#!/bin/bash
# Mirror the Databricks wheel source (runtime/databricks/) from a clean benchrouter
# checkout and commit it on a new branch, as scripts/mirror.sh does for the runtime.
#
#   scripts/mirror-databricks.sh <path-to-benchrouter-checkout> <version>
#
# The wheel is built from the public commit this script creates, never from the
# private repository. <version> must equal runtime/databricks/pyproject.toml.
set -euo pipefail
SRC="$1"
VERSION="$2"
[ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "benchrouter checkout is not clean"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "this checkout is not clean"; exit 1; }
SHA=$(git -C "$SRC" rev-parse HEAD)
git switch -c "mirror/databricks-v$VERSION"
rsync -a --checksum --delete --exclude .venv --exclude dist --exclude __pycache__ "$SRC/runtime/databricks/" runtime/databricks/
found=$(RELEASE_KIND=databricks node scripts/release.mjs version)
[ "$found" = "$VERSION" ] || { echo "runtime/databricks/pyproject.toml version is $found, not $VERSION"; exit 1; }
git add -A runtime/databricks
git commit -m "mirror: databricks wheel $VERSION from BenchRouter/benchrouter@$SHA"
echo "Next: push the branch, open a PR, merge it, then tag the merge commit databricks-v$VERSION."
