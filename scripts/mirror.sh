#!/bin/bash
# Mirror the runtime source from a clean benchrouter checkout and commit it on a new
# branch. Run it from the root of this repository on a founder machine. No CI
# credential of either repository is involved.
#
#   scripts/mirror.sh <path-to-benchrouter-checkout> <version>
#
# It copies runtime/ and every repo-relative path listed in runtime/MIRROR.txt (one
# per line; blank lines and lines starting with # are ignored) to the same paths
# here. The commit message records the source commit. The release is built from the
# public commit that this script creates, never from the private repository.
set -euo pipefail
SRC="$1"
VERSION="$2"
[ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "benchrouter checkout is not clean"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "this checkout is not clean"; exit 1; }
SHA=$(git -C "$SRC" rev-parse HEAD)
git switch -c "mirror/runtime-v$VERSION"

# Remove the previous mirror so deleted source files disappear here too.
if [ -f runtime/MIRROR.txt ]; then
  while IFS= read -r path; do
    case "$path" in ''|'#'*) continue ;; esac
    git rm -q --ignore-unmatch -- "$path"
  done < runtime/MIRROR.txt
fi
# --checksum: compare file contents. The default check compares size and time only,
# and it skipped package-lock.json once during the 1.1.0 mirror.
rsync -a --checksum --delete --exclude node_modules --exclude dist "$SRC/runtime/" runtime/
if [ -f runtime/MIRROR.txt ]; then
  while IFS= read -r path; do
    case "$path" in ''|'#'*) continue ;; esac
    case "$path" in /*|*..*) echo "refusing path $path"; exit 1 ;; esac
    [ -f "$SRC/$path" ] || { echo "listed file $path is missing in the source"; exit 1; }
    mkdir -p "$(dirname "$path")"
    cp "$SRC/$path" "$path"
  done < runtime/MIRROR.txt
fi
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("runtime/package.json", "utf8"));
  if (pkg.version !== process.argv[1]) { console.error(`runtime/package.json version is ${pkg.version}, not ${process.argv[1]}`); process.exit(1); }
' "$VERSION"
git add -A
git commit -m "mirror: runtime $VERSION from BenchRouter/benchrouter@$SHA"
echo "Next: push the branch, open a PR, merge it, then tag the merge commit runtime-v$VERSION."
