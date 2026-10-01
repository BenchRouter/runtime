#!/usr/bin/env node
// BenchRouter bootstrap (RUN-001, GHA contract v1 §2.2). The kit commits this file as
// .benchrouter/bootstrap.mjs. It resolves the signed runtime, verifies it against
// .benchrouter/trust.json, checks revocation before execution, pins the verified bytes
// for this invocation and execs them. It fails closed on anything it does not know.
// It does no executor authentication: the runtime does that (OIDC in Actions, the CLI
// credential for local capture and calibrate).
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOOTSTRAP_VERSION = "1";
const RUNTIME_ORIGIN = "https://runtime.benchrouter.com";
const API_ORIGIN = "https://api.benchrouter.com";
const COMMANDS = ["run", "capture", "calibrate"];
const MAX_DOC_BYTES = 64 * 1024;
const MAX_RUNTIME_BYTES = 16 * 1024 * 1024;
const NOT_AFTER_MAX_MS = 180 * 24 * 60 * 60 * 1000;
const WATCHDOG_GRACE_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;

class BootstrapError extends Error {}
function fail(message) { throw new BootstrapError(message); }
function object(value, keys, what) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(what + " is not an object");
  const got = Object.keys(value).sort().join(",");
  if (got !== [...keys].sort().join(",")) fail(what + " has unknown or missing fields: " + got);
  return value;
}
function isHex(text) { return [...text].every((c) => "0123456789abcdef".includes(c)); }
function isDigest(value) { return typeof value === "string" && value.length === 71 && value.startsWith("sha256:") && isHex(value.slice(7)); }
function isStrings(value) { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function base64Exact(text, what) {
  const bytes = Buffer.from(String(text), "base64");
  if (typeof text !== "string" || bytes.toString("base64") !== text) fail(what + " is not canonical base64");
  return bytes;
}
function time(value, what) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) fail(what + " is not a timestamp");
  return ms;
}

/** trust.json: schema, protocol major, current + next Ed25519 keys, optional digest pins. */
function parseTrust(text) {
  const trust = object(JSON.parse(text), ["schema", "protocol_major", "keys", "pins"], "trust.json");
  if (trust.schema !== "benchrouter.trust.v1" || trust.protocol_major !== 1) fail("trust.json schema or protocol major is not supported");
  const keys = object(trust.keys, ["current", "next"], "trust.json keys");
  const parsed = [keys.current, keys.next].map((key) => {
    object(key, ["key_id", "alg", "public_key"], "trust.json key");
    const raw = base64Exact(key.public_key, "trust.json public_key");
    if (key.alg !== "ed25519" || raw.length !== 32) fail("trust.json key is not a raw Ed25519 key");
    if (key.key_id !== "ed25519:" + sha256(raw).slice(0, 16)) fail("trust.json key_id does not match its public key");
    return { keyId: key.key_id, publicKey: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" }) };
  });
  if (!Array.isArray(trust.pins) || !trust.pins.every(isDigest)) fail("trust.json pins must be sha256 digests");
  return { protocolMajor: trust.protocol_major, keys: parsed, pins: trust.pins };
}

async function fetchBytes(origin, path, maxBytes) {
  if (typeof path !== "string" || path.length === 0) fail("refusing an empty or non-string path");
  const url = new URL(path, origin + "/");
  if (url.origin !== origin) fail("refusing a URL outside " + origin + ": " + url.href);
  let last = "no response";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt * (0.5 + Math.random())));
    let response;
    try {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (response.status >= 300 && response.status < 400) fail("refusing a redirect from " + url.href);
    if (response.status === 429 || response.status >= 500) { last = "HTTP " + response.status; await response.body?.cancel(); continue; }
    if (!response.ok) fail(url.href + " returned HTTP " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) fail(url.href + " is larger than " + maxBytes + " bytes");
    return bytes;
  }
  return fail(url.href + " is unreachable (" + last + ")");
}

/** Verify the signed manifest against trust.json (§2.2 step 4). Returns the manifest payload. */
function verifyManifest(signedText, trust, now) {
  const signed = object(JSON.parse(signedText), ["payload", "key_id", "signature"], "signed manifest");
  const key = trust.keys.find((candidate) => candidate.keyId === signed.key_id);
  if (!key) fail("manifest is signed by a key that trust.json does not list: " + String(signed.key_id));
  const payload = base64Exact(signed.payload, "manifest payload");
  const signature = base64Exact(signed.signature, "manifest signature");
  if (signature.length !== 64 || !verify(null, payload, key.publicKey, signature)) fail("manifest signature is invalid");
  const manifest = object(JSON.parse(payload.toString("utf8")), ["schema", "protocol_major", "version", "digest", "size_bytes",
    "artifact_path", "features", "signed_at", "not_after", "key_id", "source"], "manifest");
  if (manifest.schema !== "benchrouter.runtime-manifest.v1" || manifest.protocol_major !== trust.protocolMajor) fail("manifest schema or protocol major is not supported");
  if (manifest.key_id !== signed.key_id || typeof manifest.version !== "string" || !isDigest(manifest.digest) || !isStrings(manifest.features)) fail("manifest fields are invalid");
  if (!Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes <= 0 || manifest.size_bytes > MAX_RUNTIME_BYTES) fail("manifest size_bytes is invalid");
  const signedAt = time(manifest.signed_at, "manifest signed_at");
  const notAfter = time(manifest.not_after, "manifest not_after");
  if (notAfter <= now) fail("manifest expired at " + manifest.not_after);
  if (notAfter - signedAt > NOT_AFTER_MAX_MS) fail("manifest not_after is more than 180 days after signed_at");
  if (trust.pins.length > 0 && !trust.pins.includes(manifest.digest)) fail("runtime " + manifest.digest + " is not in the trust.json pins");
  return manifest;
}

/** §6.2 R4: the pre-execution status check on the API host. Anything but `allowed` refuses. */
async function checkReleaseStatus(apiOrigin, manifest) {
  const body = await fetchBytes(apiOrigin, "v1/runner/release-status?digest=" + encodeURIComponent(manifest.digest), MAX_DOC_BYTES);
  const status = JSON.parse(body.toString("utf8"));
  if (status?.outcome === "revoked") fail("runtime " + manifest.digest + " is revoked: " + String(status.reason));
  if (status?.outcome !== "allowed") fail("runtime " + manifest.digest + " is not allowed (status " + JSON.stringify(status?.outcome) + ")");
  object(status, ["outcome", "digest", "retired_key_ids"], "release status");
  if (status.outcome !== "allowed" || status.digest !== manifest.digest || !isStrings(status.retired_key_ids)) fail("runtime " + manifest.digest + " is not allowed");
  if (status.retired_key_ids.includes(manifest.key_id)) fail("runtime is signed by retired key " + manifest.key_id);
}

/** Resolve, verify, pin and exec the runtime. Resolves to the runtime's exit code. */
export async function bootstrap({ command, args = [], trustPath, runtimeOrigin = RUNTIME_ORIGIN, apiOrigin = API_ORIGIN, env = process.env }) {
  if (!COMMANDS.includes(command)) fail("unknown command " + JSON.stringify(command) + "; expected one of " + COMMANDS.join(", "));
  const trust = parseTrust(await readFile(trustPath, "utf8"));
  const query = env.GITHUB_REPOSITORY_ID ? "?repository_id=" + encodeURIComponent(env.GITHUB_REPOSITORY_ID) : "";
  const pointer = object(JSON.parse((await fetchBytes(runtimeOrigin, "v1/pointer" + query, MAX_DOC_BYTES)).toString("utf8")), ["protocol_major", "manifest_path"], "runtime pointer");
  if (pointer.protocol_major !== trust.protocolMajor) fail("runtime pointer protocol major is not supported");
  const manifest = verifyManifest((await fetchBytes(runtimeOrigin, pointer.manifest_path, MAX_DOC_BYTES)).toString("utf8"), trust, Date.now());
  const bytes = await fetchBytes(runtimeOrigin, manifest.artifact_path, MAX_RUNTIME_BYTES);
  if (bytes.length !== manifest.size_bytes || "sha256:" + sha256(bytes) !== manifest.digest) fail("runtime bytes do not match the signed digest");
  await checkReleaseStatus(apiOrigin, manifest);
  const base = env.RUNNER_TEMP ? join(env.RUNNER_TEMP, "benchrouter") : join(tmpdir(), "benchrouter-" + (process.getuid?.() ?? "user"));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const file = join(await mkdtemp(join(base, "runtime-")), "runtime-" + manifest.digest.slice(7) + ".mjs");
  await writeFile(file, bytes, { mode: 0o400, flag: "wx" });
  if ("sha256:" + sha256(await readFile(file)) !== manifest.digest) fail("pinned runtime file changed after write");
  // Network retries can outlast not_after: re-check expiry at the moment of exec.
  if (Date.parse(manifest.not_after) <= Date.now()) fail("manifest expired at " + manifest.not_after);
  return execRuntime(file, [command, ...args], {
    ...env,
    BENCHROUTER_BOOTSTRAP_VERSION: BOOTSTRAP_VERSION,
    BENCHROUTER_RUNTIME_DIGEST: manifest.digest,
    BENCHROUTER_RUNTIME_VERSION: manifest.version,
    BENCHROUTER_RUNTIME_FEATURES: JSON.stringify(manifest.features),
    BENCHROUTER_API_ORIGIN: apiOrigin,
    BENCHROUTER_CONTROL_ROOT: dirname(dirname(trustPath))
  });
}

/**
 * Exec the pinned runtime. The runtime reports `retire_at` over IPC; the watchdog kills it
 * 5 min later (§3.3.4). `retire_at` is never renewed: only an earlier report moves the watchdog.
 */
function execRuntime(file, argv, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...argv], { stdio: ["inherit", "inherit", "inherit", "ipc"], env });
    let watchdog = null;
    let earliest = Infinity;
    const stop = (signal) => { child.kill(signal); setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref(); };
    child.on("message", (message) => {
      const retireAt = message && message.type === "retire_at" ? Date.parse(message.at) : NaN;
      if (!Number.isFinite(retireAt) || retireAt >= earliest) return;
      earliest = retireAt;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { console.error("::error title=BenchRouter::runtime passed retire_at + 5 min; stopping it"); stop("SIGTERM"); }, Math.max(0, retireAt + WATCHDOG_GRACE_MS - Date.now()));
      watchdog.unref();
    });
    const forward = (signal) => stop(signal);
    process.on("SIGINT", forward).on("SIGTERM", forward);
    const done = (code) => { clearTimeout(watchdog); process.off("SIGINT", forward).off("SIGTERM", forward); resolve(code); };
    child.on("error", (error) => { console.error("::error title=BenchRouter::could not start the runtime: " + error.message); done(1); });
    child.on("exit", (code, signal) => done(signal ? 1 : code ?? 1));
  });
}

function isMain() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMain()) {
  const trustPath = join(dirname(fileURLToPath(import.meta.url)), "trust.json");
  bootstrap({ command: process.argv[2], args: process.argv.slice(3), trustPath }).then(
    (code) => { process.exitCode = code; },
    (error) => {
      const message = error instanceof BootstrapError || error instanceof SyntaxError ? error.message : String(error?.stack ?? error);
      console.error("::error title=BenchRouter bootstrap::" + message.replaceAll("\n", " "));
      process.exitCode = 1;
    }
  );
}
