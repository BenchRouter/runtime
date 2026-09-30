# BenchRouter runtime releases

This repository builds, signs and publishes the BenchRouter runtime. The runtime is
the program that the BenchRouter GitHub Actions workflow runs in a customer's
repository. A small bootstrap in the customer's repository downloads it, verifies
it, and runs it.

**Status:** the current release is a placeholder. It proves the signing pipeline
and does no work. No pointer selects it.

## Where the files are

| URL | Content |
|---|---|
| `https://runtime.benchrouter.com/v1/releases/<version>/runtime.mjs` | The runtime file. |
| `https://runtime.benchrouter.com/v1/releases/<version>/manifest.json` | The signed manifest for that file. |
| `https://runtime.benchrouter.com/v1/pointer` | The release that bootstraps use now. |

Release objects are immutable. The storage bucket refuses overwrites and deletes
under `v1/releases/` for 365 days. The origin never redirects.

## Manifest format

`manifest.json` is an envelope:

```json
{ "payload": "<base64 of the manifest JSON bytes>", "key_id": "ed25519:…", "signature": "<base64 Ed25519 signature over the payload bytes>" }
```

The decoded payload:

```json
{
  "schema": "benchrouter.runtime-manifest.v1",
  "protocol_major": 1,
  "version": "0.0.0-placeholder.1",
  "digest": "sha256:<64 hex>",
  "size_bytes": 264,
  "artifact_path": "v1/releases/0.0.0-placeholder.1/runtime.mjs",
  "features": [],
  "signed_at": "2026-09-30T00:00:00.000Z",
  "not_after": "2027-03-29T00:00:00.000Z",
  "key_id": "ed25519:<first 16 hex of sha256(raw public key)>",
  "source": { "repository": "BenchRouter/runtime", "commit": "<sha>", "ref": "refs/tags/runtime-v…" }
}
```

The signature covers the exact payload bytes. There is no canonicalization.
`not_after` is 180 days after `signed_at`. Every release signs a new manifest.

## Signing keys

`release-keys.json` holds the public keys: a current key that signs releases and a
next key for rotation. Customer `trust.json` files carry both. The private keys
exist only as secrets of the `runtime-signing` environment of this repository.

## How a release is made

1. `scripts/mirror.sh <benchrouter-checkout> <version>` copies the runtime source
   into `runtime/` and records the source commit. The change merges by pull request.
2. An organization admin pushes the tag `runtime-v<version>` on the merge commit.
3. The **build** job builds `runtime/` twice from clean copies, requires identical
   bytes, and shows the sha256 digest in the job summary. It has no secrets.
4. The **publish** job runs in the `runtime-signing` environment. It waits until
   patelnav or mrtron approves it. It recomputes the digest, signs the manifest with
   the current key, uploads the file and then the manifest, and verifies both from
   the public origin.
5. `promote.yml`, run on the release tag and approved in the same way, moves the
   pointer to the release. Rollback is the same run on an older tag.

## Verify a release yourself

```sh
git checkout runtime-v<version>
node scripts/release.mjs build --tag runtime-v<version> --out out   # prints the digest
node scripts/release.mjs verify --origin https://runtime.benchrouter.com --version <version>
```

The first command rebuilds the file from this public commit. The second checks the
published manifest signature against `release-keys.json` and the published bytes
against the signed digest.
