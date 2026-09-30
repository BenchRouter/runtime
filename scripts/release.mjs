#!/usr/bin/env node
// BenchRouter runtime release tool. Node built-ins only.
//
//   build        --tag <tag> --out <dir>
//   sign         --artifact <file> --expected-digest <sha256:..> --out <dir>   (SIGNING_KEY env = PKCS8 PEM)
//   remote-state --origin <url> --version <v>
//   verify       --origin <url> --version <v> [--expected-digest <sha256:..>]
//
// The manifest and envelope types are RuntimeReleaseManifest and
// SignedRuntimeManifest in the benchrouter repo, src/shared/runner-protocol.ts.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMA = "benchrouter.runtime-manifest.v1";
const PROTOCOL_MAJOR = 1;
const NOT_AFTER_DAYS = 180;
const TAG_PREFIX = "runtime-v";
const VERSION_CHARS = new Set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function args() {
  const out = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) fail(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function need(a, name) {
  if (!a[name]) fail(`--${name} is required`);
  return a[name];
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  process.stdout.write(`${markdown}\n`);
}

function checkVersion(version) {
  if (typeof version !== "string" || version.length === 0 || version.length > 64) fail("bad version");
  for (const ch of version) if (!VERSION_CHARS.has(ch)) fail(`version contains '${ch}'`);
  if (version.startsWith(".") || version.includes("..")) fail("bad version");
  return version;
}

function runtimePackage() {
  const pkg = readJson(join(ROOT, "runtime", "package.json"));
  const version = checkVersion(pkg.version);
  const meta = pkg.benchrouter ?? {};
  if (meta.protocol_major !== PROTOCOL_MAJOR) fail(`runtime/package.json benchrouter.protocol_major must be ${PROTOCOL_MAJOR}`);
  if (!Array.isArray(meta.features) || meta.features.some((f) => typeof f !== "string")) {
    fail("runtime/package.json benchrouter.features must be a string array");
  }
  return { version, features: [...meta.features] };
}

function artifactPath(version) {
  return `v1/releases/${version}/runtime.mjs`;
}

function manifestPath(version) {
  return `v1/releases/${version}/manifest.json`;
}

function rawPublicKey(keyObject) {
  const der = keyObject.export({ format: "der", type: "spki" });
  if (!der.subarray(0, 12).equals(SPKI_ED25519_PREFIX) || der.length !== 44) fail("key is not Ed25519");
  return der.subarray(12);
}

function keyIdOf(raw) {
  return `ed25519:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

function publicKeyFromRaw(base64) {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) fail("public key must be 32 raw bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

function releaseKeys() {
  const keys = readJson(join(ROOT, "release-keys.json"));
  for (const role of ["current", "next"]) {
    const k = keys[role];
    if (!k || k.alg !== "ed25519") fail(`release-keys.json ${role} key is missing`);
    if (keyIdOf(Buffer.from(k.public_key, "base64")) !== k.key_id) fail(`release-keys.json ${role} key_id does not match its public key`);
  }
  return keys;
}

// The whole tracked tree is copied, because the mirrored runtime imports files
// outside runtime/ (runtime/MIRROR.txt lists them at their original paths).
const SKIP_TOP = new Set([".git", "out", "signed", "artifact"]);

function buildOnce(workDir) {
  cpSync(ROOT, workDir, {
    recursive: true,
    filter: (src) => {
      const parts = relative(ROOT, src).split(sep);
      if (SKIP_TOP.has(parts[0]) || parts.includes("node_modules")) return false;
      return !(parts[0] === "runtime" && parts[1] === "dist");
    },
  });
  const runtimeDir = join(workDir, "runtime");
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtimeDir, stdio: "inherit" });
  execFileSync("npm", ["run", "build"], { cwd: runtimeDir, stdio: "inherit" });
  return readFileSync(join(runtimeDir, "dist", "runtime.mjs"));
}

function cmdBuild() {
  const a = args();
  const tag = need(a, "tag");
  const outDir = need(a, "out");
  const { version, features } = runtimePackage();
  if (tag !== `${TAG_PREFIX}${version}`) fail(`tag ${tag} does not match runtime/package.json version ${version}`);

  // Two builds from clean copies must produce the same bytes, so anyone can
  // rebuild the tagged public commit and get the signed digest.
  const scratch = mkdtempSync(join(tmpdir(), "runtime-build-"));
  const first = buildOnce(join(scratch, "a"));
  const second = buildOnce(join(scratch, "b"));
  rmSync(scratch, { recursive: true, force: true });
  const digest = sha256(first);
  if (sha256(second) !== digest) fail(`build is not reproducible: ${digest} vs ${sha256(second)}`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "runtime.mjs"), first);
  setOutput("version", version);
  setOutput("digest", digest);
  summary(
    [
      `## Runtime build ${version}`,
      "",
      "Approve the signing job only if this digest is the one you expect.",
      "",
      "| Field | Value |",
      "|---|---|",
      `| version | \`${version}\` |`,
      `| digest | \`${digest}\` |`,
      `| size_bytes | ${first.length} |`,
      `| features | \`${JSON.stringify(features)}\` |`,
      `| commit | \`${process.env.GITHUB_SHA ?? "local"}\` |`,
    ].join("\n"),
  );
}

function cmdSign() {
  const a = args();
  const artifactFile = need(a, "artifact");
  const expected = need(a, "expected-digest");
  const outDir = need(a, "out");
  const { version, features } = runtimePackage();

  const bytes = readFileSync(artifactFile);
  const digest = sha256(bytes);
  if (digest !== expected) fail(`artifact digest ${digest} does not equal the build output ${expected}`);

  const pem = process.env.SIGNING_KEY;
  if (!pem) fail("SIGNING_KEY is empty");
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  const keys = releaseKeys();
  const raw = rawPublicKey(createPublicKey(privateKey));
  if (raw.toString("base64") !== keys.current.public_key) fail("SIGNING_KEY does not match the current key in release-keys.json");

  const signedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const notAfter = new Date(signedAt.getTime() + NOT_AFTER_DAYS * 86_400_000);
  const manifest = {
    schema: SCHEMA,
    protocol_major: PROTOCOL_MAJOR,
    version,
    digest,
    size_bytes: bytes.length,
    artifact_path: artifactPath(version),
    features,
    signed_at: signedAt.toISOString(),
    not_after: notAfter.toISOString(),
    key_id: keys.current.key_id,
    source: {
      repository: process.env.GITHUB_REPOSITORY ?? "local",
      commit: process.env.GITHUB_SHA ?? "local",
      ref: process.env.GITHUB_REF ?? "local",
    },
  };
  const payload = Buffer.from(JSON.stringify(manifest), "utf8");
  const envelope = {
    payload: payload.toString("base64"),
    key_id: keys.current.key_id,
    signature: sign(null, payload, privateKey).toString("base64"),
  };
  checkEnvelope(envelope, bytes, version, keys);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(envelope)}\n`);
  summary(
    [
      `## Signed manifest ${version}`,
      "",
      "```json",
      JSON.stringify(manifest, null, 2),
      "```",
    ].join("\n"),
  );
}

// The same checks the bootstrap makes, minus trust.json pins and the API status check.
function checkEnvelope(envelope, artifactBytes, version, keys) {
  const trusted = [keys.current, keys.next].filter((k) => k.key_id === envelope.key_id);
  if (trusted.length !== 1) fail(`manifest key ${envelope.key_id} is not a current or next release key`);
  if ((keys.retired ?? []).includes(envelope.key_id)) fail(`manifest key ${envelope.key_id} is retired`);
  const payload = Buffer.from(envelope.payload, "base64");
  const ok = verify(null, payload, publicKeyFromRaw(trusted[0].public_key), Buffer.from(envelope.signature, "base64"));
  if (!ok) fail("manifest signature does not verify");
  const m = JSON.parse(payload.toString("utf8"));
  if (m.schema !== SCHEMA) fail(`manifest schema ${m.schema}`);
  if (m.key_id !== envelope.key_id) fail("manifest key_id differs from the envelope key_id");
  if (m.protocol_major !== PROTOCOL_MAJOR) fail(`manifest protocol_major ${m.protocol_major}`);
  if (m.version !== version) fail(`manifest version ${m.version} is not ${version}`);
  if (m.artifact_path !== artifactPath(version)) fail(`manifest artifact_path ${m.artifact_path}`);
  if (!(Date.parse(m.not_after) > Date.now())) fail(`manifest expired at ${m.not_after}`);
  if (m.digest !== sha256(artifactBytes)) fail("artifact bytes do not match the manifest digest");
  if (m.size_bytes !== artifactBytes.length) fail("artifact size does not match the manifest");
  return m;
}

async function get(url) {
  // The origin never redirects. A redirect is an error, as in the bootstrap.
  const res = await fetch(url, { redirect: "error", cache: "no-store" });
  if (res.status === 404) return null;
  if (res.status !== 200) fail(`GET ${url} returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function originOf(a) {
  const origin = new URL(need(a, "origin"));
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search) fail("--origin must be a bare https origin");
  return origin.origin;
}

async function cmdRemoteState() {
  const a = args();
  const origin = originOf(a);
  const version = checkVersion(need(a, "version"));
  // A query string keeps these probes out of the edge cache entry for the
  // canonical URL, so a 404 seen here is never served to a later reader.
  const bust = `?probe=${Date.now()}`;
  const manifest = await get(`${origin}/${manifestPath(version)}${bust}`);
  const artifact = await get(`${origin}/${artifactPath(version)}${bust}`);
  const state = { manifest: manifest !== null, artifact_digest: artifact === null ? null : sha256(artifact) };
  process.stdout.write(`${JSON.stringify(state)}\n`);
  setOutput("manifest", String(state.manifest));
  setOutput("artifact_digest", state.artifact_digest ?? "");
}

async function cmdVerify() {
  const a = args();
  const origin = originOf(a);
  const version = checkVersion(need(a, "version"));
  const manifestUrl = `${origin}/${manifestPath(version)}`;
  const artifactUrl = `${origin}/${artifactPath(version)}`;
  const envelopeBytes = await get(manifestUrl);
  const artifact = await get(artifactUrl);
  if (!envelopeBytes || !artifact) fail(`release ${version} is not complete at ${origin}`);
  const m = checkEnvelope(JSON.parse(envelopeBytes.toString("utf8")), artifact, version, releaseKeys());
  if (a["expected-digest"] && m.digest !== a["expected-digest"]) fail(`published digest ${m.digest} is not ${a["expected-digest"]}`);
  summary(
    [
      `## Verified from ${origin}`,
      "",
      `- manifest: ${manifestUrl}`,
      `- artifact: ${artifactUrl}`,
      `- digest: \`${m.digest}\``,
      `- key_id: \`${m.key_id}\``,
      `- not_after: \`${m.not_after}\``,
    ].join("\n"),
  );
}

const commands = { build: cmdBuild, sign: cmdSign, "remote-state": cmdRemoteState, verify: cmdVerify };
const command = commands[process.argv[2]];
if (!command) fail(`usage: release.mjs <${Object.keys(commands).join("|")}> [--flag value ...]`);
await command();
