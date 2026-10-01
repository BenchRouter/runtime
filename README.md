# BenchRouter runtime releases

This repository builds, signs and publishes the BenchRouter runtime. The runtime is
the program that the BenchRouter GitHub Actions workflow runs in a customer's
repository. A small bootstrap in the customer's repository downloads it, verifies
it, and runs it.

Runtime releases execute admitted eval work, local capture, and calibration.
The public pointer selects the promoted release; its value is verified by the
bootstrap before execution.

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
4. One **sign, publish and promote** job runs in the `runtime-signing` environment.
   The required reviewer approves the displayed version and reproducible digest
   once. The job recomputes the digest, signs the manifest, uploads the artifact
   and manifest, verifies the public bytes, and registers the digest with the API.
5. In that same protected job, current main's trust and retirement policy verifies
   the exact approved version and digest again. The API must report that digest
   allowed with an unretired key. Only then does the job write the canonical
   pointer and verify its public readback. A failure stops the job. A failure
   before the pointer write leaves the current pointer unchanged; a failed
   readback reports failure and requires inspection rather than automatic rollback.

The protected release job and manual promotion share the `runtime-pointer`
concurrency group. The secret-free build does not hold this lock. Pointer writers
cannot run concurrently. `cancel-in-progress: false` preserves a running writer.
GitHub keeps one pending writer by default; a later request replaces that pending
request. Approval waiting and concurrency are separate controls, so this does not
promise rollback priority. For an urgent rollback, an operator must inspect and
cancel a waiting release if it blocks the rollback. Never bypass its approval or
interrupt a running pointer write without checking its outcome.
See [GitHub's concurrency rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

Existing tag restrictions,
required reviewers and environment secrets remain in force. No job approves
its own environment or transfers an approval between jobs.

`promote.yml` remains a separate protected operation for manual rollback or
promotion of an already published release. It verifies with current main's
trust policy and requires one approval for that operation.

Tags created before this combined workflow retain their immutable old workflow.
For example, `runtime-v1.0.2` finished with its existing protected manual promotion.
Do not retag, re-sign, or overwrite an old release
just to combine approvals. Future reviewed tags use the single protected job.

## Verify a release yourself

```sh
git checkout runtime-v<version>
node scripts/release.mjs build --tag runtime-v<version> --out out   # prints the digest
node scripts/release.mjs verify --origin https://runtime.benchrouter.com --version <version>
```

The first command rebuilds the file from this public commit. The second checks the
published manifest signature against `release-keys.json` and the published bytes
against the signed digest.
