#!/bin/bash
# Mirror the runtime source from a clean benchrouter checkout into runtime/ and
# commit it on a new branch. Run it from the root of this repository on a founder
# machine. No CI credential of either repository is involved.
#
#   scripts/mirror.sh <path-to-benchrouter-checkout> <version>
#
# The commit message records the source commit. The release is built from the
# public commit that this script creates, never from the private repository.
set -euo pipefail
SRC="$1"
VERSION="$2"
[ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "benchrouter checkout is not clean"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "this checkout is not clean"; exit 1; }
SHA=$(git -C "$SRC" rev-parse HEAD)
git switch -c "mirror/runtime-v$VERSION"
rsync -a --delete --exclude node_modules --exclude dist "$SRC/runtime/" runtime/
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("runtime/package.json", "utf8"));
  if (pkg.version !== process.argv[1]) { console.error(`runtime/package.json version is ${pkg.version}, not ${process.argv[1]}`); process.exit(1); }
' "$VERSION"
git add -A runtime
git commit -m "mirror: runtime $VERSION from BenchRouter/benchrouter@$SHA"
echo "Next: push the branch, open a PR, merge it, then tag the merge commit runtime-v$VERSION."
