// `.benchrouter/benchrouter.yml` at eval_sha. The runtime parses it with a real YAML
// parser and applies the same validation the old kit engines applied. The raw route
// mapping is kept verbatim: it is the snapshot's `manifest_entry`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { RunnerWorkMode } from "../../src/shared/runner-protocol";
import { parseReplayCaseRepeatPolicy, type ReplayCaseRepeatPolicy } from "../../src/shared/replay-case-repeats";
import { isJsonFiniteNumber, isJsonObject, isJsonString, ProtocolError, type JsonObject, type JsonValue } from "./json";

export const MANIFEST_PATH = ".benchrouter/benchrouter.yml";
export const EXECUTABLE_API_FAMILIES = ["openai_chat_completions", "anthropic_messages", "openai_responses"] as const;

export interface ExecutableSpec {
  argv: string[];
  apiFamily: (typeof EXECUTABLE_API_FAMILIES)[number];
  runtime: "node" | "bun";
  runtimeVersion: string;
  lockfile: string;
  /** The lockfile in the repository: `<working_directory>/<lockfile>`, or `<lockfile>` at the root. */
  lockfilePath: string;
  workingDirectory: string | null;
  inputRefs: string[];
  acceptanceRefs: string[];
  resultPath: string;
  primaryMetric: string;
  maxModelCalls: number;
  maxCostUsd: number;
  maxCostPerCallUsd: number;
  timeoutMinutes: number;
  secretEnv: string[];
}

export interface ManifestRoute {
  routeId: string;
  slug: string;
  name: string;
  codeRefs: string[];
  /** `call_site.base_url_env`: the env var the customer code reads for its LLM base URL. */
  baseUrlEnv: string | null;
  bestModel: string;
  mode: RunnerWorkMode;
  executable: ExecutableSpec | null;
  judgeModel: string | null;
  /** `eval_pack.config_path`: the committed manifest file, hashed as part of the contract. */
  configPath: string;
  scorerPath: string;
  resultSchema: string;
  caseRefs: string[];
  caseRepeats: ReplayCaseRepeatPolicy | null;
  /** The committed route mapping, verbatim (snapshot `manifest_entry`). */
  entry: JsonObject;
}

export interface Manifest {
  product: { slug: string; repo: string; defaultBranch: string };
  routes: ManifestRoute[];
}

function fail(label: string, message: string): never {
  throw new ProtocolError(`${MANIFEST_PATH}: ${label} ${message}`);
}

function objectAt(value: JsonValue | undefined, label: string): JsonObject {
  if (value === undefined || value === null) return {};
  if (!isJsonObject(value)) fail(label, "must be a mapping");
  return value;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (value === undefined || !isJsonString(value) || value.length === 0 || value !== value.trim()) fail(label, "is required without surrounding whitespace");
  return value;
}

function optionalString(value: JsonValue | undefined, label: string): string | null {
  return value === undefined || value === null || value === "" ? null : requiredString(value, label);
}

/** A normalized repository-relative path: no absolute, drive, home, backslash, empty, `.` or `..` part. */
export function isRepoPath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.startsWith("~")) return false;
  if (value.length >= 2 && value[1] === ":") return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function repoPath(value: JsonValue | undefined, label: string): string {
  const text = requiredString(value, label);
  if (!isRepoPath(text)) fail(label, "must be a normalized repository-relative path");
  return text;
}

function stringList(value: JsonValue | undefined, label: string, requireOne = true): string[] {
  if (value === undefined || value === null) {
    if (requireOne) fail(label, "must include at least one value");
    return [];
  }
  if (!Array.isArray(value) || (requireOne && value.length === 0)) fail(label, "must include at least one value");
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

function uniqueList(value: JsonValue | undefined, label: string, pathsOnly: boolean, requireOne = true): string[] {
  const list = stringList(value, label, requireOne);
  if (pathsOnly) list.forEach((entry, index) => repoPath(entry, `${label}[${index}]`));
  if (new Set(list).size !== list.length) fail(label, "must not contain duplicates");
  return list;
}

function positiveNumber(value: JsonValue | undefined, label: string, integer: boolean): number {
  if (value === undefined || !isJsonFiniteNumber(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    fail(label, integer ? "must be a positive integer" : "must be a positive number");
  }
  return value;
}

function isExactVersion(value: string): boolean {
  const core = (value.startsWith("v") ? value.slice(1) : value).split("-")[0] ?? "";
  const parts = core.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0 && [...part].every((c) => c >= "0" && c <= "9"));
}

function isEnvName(name: string): boolean {
  if (name.length === 0 || !(name[0] >= "A" && name[0] <= "Z")) return false;
  return [...name].every((c) => (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_");
}

function optionalEnvName(value: JsonValue | undefined, label: string): string | null {
  const name = optionalString(value, label);
  const reserved = ["BENCHROUTER_API_KEY", "BENCHROUTER_ROUTE_ID", "BENCHROUTER_EVAL_BASE_URL", "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"];
  if (name !== null && (!isEnvName(name) || reserved.includes(name) || name.startsWith("ACTIONS_") || name.startsWith("GITHUB_"))) {
    fail(label, "must be a plain environment variable name that the eval-call contract does not use");
  }
  return name;
}

function parseExecutable(pack: JsonObject, prefix: string): ExecutableSpec {
  const label = (key: string) => `${prefix}.eval_pack.${key}`;
  const apiFamily = requiredString(pack.api_family, label("api_family"));
  const family = EXECUTABLE_API_FAMILIES.find((entry) => entry === apiFamily);
  if (!family) fail(label("api_family"), "must be openai_chat_completions, anthropic_messages, or openai_responses");
  const runtime = requiredString(pack.runtime, label("runtime"));
  if (runtime !== "node" && runtime !== "bun") fail(label("runtime"), "must be node or bun");
  const runtimeVersion = requiredString(pack.runtime_version, label("runtime_version"));
  if (!isExactVersion(runtimeVersion)) fail(label("runtime_version"), "must be an exact runtime version");
  const lockfile = repoPath(pack.lockfile, label("lockfile"));
  const workingDirectory = pack.working_directory === undefined || pack.working_directory === null ? null : repoPath(pack.working_directory, label("working_directory"));
  const lockName = path.posix.basename(lockfile);
  if (runtime === "bun" && lockName !== "bun.lock" && lockName !== "bun.lockb") fail(label("lockfile"), "must be bun.lock or bun.lockb for Bun");
  if (runtime === "node" && lockName !== "package-lock.json" && lockName !== "npm-shrinkwrap.json") fail(label("lockfile"), "must be package-lock.json or npm-shrinkwrap.json for Node");
  const secretEnv = uniqueList(pack.secret_env, label("secret_env"), false, false);
  if (secretEnv.some((name) => !isEnvName(name) || ["BENCHROUTER_", "ACTIONS_", "GITHUB_"].some((reserved) => name.startsWith(reserved)))) {
    fail(label("secret_env"), "contains a reserved or invalid name");
  }
  const spec: ExecutableSpec = {
    argv: stringList(pack.argv, label("argv")),
    apiFamily: family,
    runtime,
    runtimeVersion,
    lockfile,
    lockfilePath: workingDirectory === null ? lockfile : path.posix.join(workingDirectory, lockfile),
    workingDirectory,
    inputRefs: uniqueList(pack.input_refs, label("input_refs"), true),
    acceptanceRefs: uniqueList(pack.acceptance_refs, label("acceptance_refs"), true),
    resultPath: repoPath(pack.result_path, label("result_path")),
    primaryMetric: requiredString(pack.primary_metric, label("primary_metric")),
    maxModelCalls: positiveNumber(pack.max_model_calls, label("max_model_calls"), true),
    maxCostUsd: positiveNumber(pack.max_cost_usd, label("max_cost_usd"), false),
    maxCostPerCallUsd: positiveNumber(pack.max_cost_per_call_usd, label("max_cost_per_call_usd"), false),
    timeoutMinutes: positiveNumber(pack.timeout_minutes, label("timeout_minutes"), true),
    secretEnv
  };
  if (spec.maxCostPerCallUsd > spec.maxCostUsd) fail(label("max_cost_per_call_usd"), "must not exceed max_cost_usd");
  if (spec.acceptanceRefs.some((ref) => spec.inputRefs.includes(ref))) fail(label("input_refs"), "and acceptance_refs must not overlap");
  return spec;
}

function parseRoute(value: JsonValue, index: number): ManifestRoute {
  const prefix = `routes[${index}]`;
  const entry = objectAt(value, prefix);
  const pack = objectAt(entry.eval_pack, `${prefix}.eval_pack`);
  const seed = objectAt(entry.seed, `${prefix}.seed`);
  const caseRefs = uniqueList(pack.case_refs, `${prefix}.eval_pack.case_refs`, true);
  // Fail closed (principle 5): an unknown mode never falls back to replay.
  const rawMode = pack.mode === undefined ? "isolated_replay" : requiredString(pack.mode, `${prefix}.eval_pack.mode`);
  if (rawMode !== "isolated_replay" && rawMode !== "repository_executable") fail(`${prefix}.eval_pack.mode`, "is unknown");
  const repeats = parseReplayCaseRepeatPolicy(pack.case_repeats);
  if (!repeats.ok) fail(`${prefix}.eval_pack`, repeats.message);
  if (rawMode !== "isolated_replay" && repeats.policy !== null) {
    fail(`${prefix}.eval_pack.case_repeats`, "applies only to isolated_replay evals");
  }
  const executable = rawMode === "repository_executable" ? parseExecutable(pack, prefix) : null;
  // EVAL-014: the eval implementer declares the judge model. There is no default judge.
  const judgeModel = optionalString(pack.judge_model, `${prefix}.eval_pack.judge_model`);
  if (executable && judgeModel) fail(`${prefix}.eval_pack.judge_model`, "applies only to isolated_replay evals");
  return {
    routeId: requiredString(entry.route_id, `${prefix}.route_id`),
    slug: requiredString(entry.id, `${prefix}.id`),
    name: requiredString(entry.name, `${prefix}.name`),
    codeRefs: stringList(entry.code_refs, `${prefix}.code_refs`, false),
    baseUrlEnv: optionalEnvName(objectAt(entry.call_site, `${prefix}.call_site`).base_url_env, `${prefix}.call_site.base_url_env`),
    bestModel: requiredString(seed.incumbent_model, `${prefix}.seed.incumbent_model`),
    mode: rawMode,
    executable,
    judgeModel,
    configPath: repoPath(pack.config_path, `${prefix}.eval_pack.config_path`),
    scorerPath: repoPath(pack.scorer, `${prefix}.eval_pack.scorer`),
    resultSchema: requiredString(pack.result_schema, `${prefix}.eval_pack.result_schema`),
    caseRefs,
    caseRepeats: repeats.policy,
    entry
  };
}

export function parseManifest(text: string): Manifest {
  let parsed: JsonValue;
  try {
    // SAFETY: the yaml parser returns plain JSON-compatible data for this file (no custom tags).
    parsed = parseYaml(text) as JsonValue;
  } catch (error) {
    throw new ProtocolError(`${MANIFEST_PATH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectAt(parsed, "root");
  const product = objectAt(root.product, "product");
  const routes = root.routes;
  if (!Array.isArray(routes) || routes.length === 0) fail("routes", "must declare at least one route");
  const parsedRoutes = routes.map(parseRoute);
  if (new Set(parsedRoutes.map((route) => route.routeId)).size !== parsedRoutes.length) fail("routes", "must not repeat a route_id");
  if (new Set(parsedRoutes.map((route) => route.configPath)).size !== 1) fail("routes", "must share one eval_pack.config_path");
  return {
    product: {
      slug: requiredString(product.slug, "product.slug"),
      repo: requiredString(product.repo, "product.repo"),
      defaultBranch: requiredString(product.default_branch, "product.default_branch")
    },
    routes: parsedRoutes
  };
}

export async function readManifest(treeRoot: string): Promise<Manifest> {
  return parseManifest(await readFile(path.join(treeRoot, MANIFEST_PATH), "utf8"));
}

/**
 * §3.2: every declared file of a route, exactly the set the server requires: config_path,
 * scorer, every case_ref and code_ref, and for executable routes the lockfile, input_refs
 * and acceptance_refs.
 */
export function declaredFiles(route: ManifestRoute): string[] {
  const files = new Set<string>([route.configPath, route.scorerPath, ...route.caseRefs, ...route.codeRefs]);
  if (route.executable) {
    for (const ref of [route.executable.lockfilePath, ...route.executable.inputRefs, ...route.executable.acceptanceRefs]) files.add(ref);
  }
  return [...files].sort();
}
