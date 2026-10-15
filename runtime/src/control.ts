// §3.9: parent-only credentials. The runtime reads every control value once at startup,
// then deletes it from process.env. Children never inherit process.env: each child gets
// an explicit allowlist env built here.
import path from "node:path";
import {
  parseRunnerFeatureCapabilities,
  type RunnerFeatureCapability,
  type Sha256Digest
} from "../../src/shared/runner-protocol";
import { isSha256Digest, parseJsonText, ProtocolError, trimTrailingSlashes } from "./json";
import type { StringMap } from "./transport";

export interface OidcRequestEnv {
  url: string;
  token: string;
}

/**
 * The credential of the local `capture` command, exactly as the old sidecar read it:
 * the CLI/app key, or a server-issued eval-call token when a model-run context is set.
 */
export interface CliCredential {
  apiKey: string | null;
  modelRunId: string | null;
  evalCallToken: string | null;
}

export interface ControlContext {
  apiOrigin: string;
  runtimeDigest: Sha256Digest;
  runtimeVersion: string;
  features: RunnerFeatureCapability[];
  bootstrapVersion: string;
  /** The `.br-control` checkout at workflow_sha (bootstrap, trust.json, workflow). */
  controlRoot: string;
  /** Where `.br-eval` is created. */
  workspace: string;
  runnerTemp: string;
  oidc: OidcRequestEnv | null;
  /** `github.token`; given only to the git child through the credential helper env. */
  fetchToken: string | null;
  /** §7.3 decision 1: install-only registry grant; given only to the install child. */
  installNpmToken: string | null;
  repository: string | null;
  serverUrl: string;
  eventName: string | null;
  /** Local commands only; `run` authenticates with OIDC and never reads it. */
  cli: CliCredential;
  /** The step env that remains after the control values are removed (evaluator secrets). */
  stepEnv: Map<string, string>;
}

/** Values every child may receive. Everything else is parent-only or granted by name. */
export const CHILD_BASE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"] as const;

const PARENT_ONLY_PREFIXES = ["ACTIONS_", "BENCHROUTER_", "GITHUB_", "RUNNER_", "INPUT_"];

function takeEnv(name: string): string | null {
  const value = process.env[name];
  delete process.env[name];
  return value === undefined || value.length === 0 ? null : value;
}

export function loadControlContext(): ControlContext {
  const env = process.env;
  const digest = env.BENCHROUTER_RUNTIME_DIGEST ?? "";
  if (!isSha256Digest(digest)) throw new ProtocolError("BENCHROUTER_RUNTIME_DIGEST is missing; run the runtime through .benchrouter/bootstrap.mjs");
  const features = parseRunnerFeatureCapabilities(parseJsonText(env.BENCHROUTER_RUNTIME_FEATURES ?? "[]", "BENCHROUTER_RUNTIME_FEATURES"));
  if (!features.ok) throw new ProtocolError(`the release manifest advertises unknown features: ${features.unknown.join(", ")}`);
  const oidcUrl = takeEnv("ACTIONS_ID_TOKEN_REQUEST_URL");
  const oidcToken = takeEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const context: ControlContext = {
    apiOrigin: trimTrailingSlashes(env.BENCHROUTER_API_ORIGIN ?? "https://api.benchrouter.com"),
    runtimeDigest: digest,
    runtimeVersion: env.BENCHROUTER_RUNTIME_VERSION ?? "unknown",
    features: features.value,
    bootstrapVersion: env.BENCHROUTER_BOOTSTRAP_VERSION ?? "unknown",
    controlRoot: env.BENCHROUTER_CONTROL_ROOT ?? path.resolve(".br-control"),
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    runnerTemp: env.RUNNER_TEMP ?? path.join(process.cwd(), ".benchrouter-tmp"),
    oidc: oidcUrl && oidcToken ? { url: oidcUrl, token: oidcToken } : null,
    fetchToken: takeEnv("BENCHROUTER_FETCH_TOKEN"),
    installNpmToken: takeEnv("BENCHROUTER_INSTALL_NPM_TOKEN"),
    repository: env.GITHUB_REPOSITORY ?? null,
    serverUrl: trimTrailingSlashes(env.GITHUB_SERVER_URL ?? "https://github.com"),
    eventName: env.GITHUB_EVENT_NAME ?? null,
    cli: {
      apiKey: takeEnv("BENCHROUTER_API_KEY"),
      modelRunId: takeEnv("BENCHROUTER_MODEL_RUN_ID"),
      evalCallToken: takeEnv("BENCHROUTER_EVAL_CALL_TOKEN") ?? takeEnv("BENCHROUTER_EVAL_CALL_TOKEN_MODEL")
    },
    stepEnv: new Map()
  };
  // Remove every other credential and control value from the parent's own env, so no
  // library call or later child spawn can pick one up by accident.
  for (const name of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RUNTIME_URL", "ACTIONS_CACHE_URL", "GITHUB_TOKEN", "BENCHROUTER_EVAL_CALL_TOKEN_MODEL"]) takeEnv(name);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || PARENT_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    context.stepEnv.set(name, value);
  }
  return context;
}

/**
 * AUTH-007: the job's package-manager, registry, proxy and certificate settings, which the
 * dependency install receives as the customer's own install would. Matched without regard to
 * case. They come only from `stepEnv`, which never holds a parent-only value: no `BENCHROUTER_*`
 * (the item's ecall token, the fetch token, the raw install grant), `ACTIONS_*` (the OIDC request
 * token), `GITHUB_*` (the repository token), `RUNNER_*` or `INPUT_*` name ever reaches the install.
 */
export const INSTALL_PASS_THROUGH_PREFIXES = ["npm_config_", "pnpm_", "corepack_", "bun_"] as const;
export const INSTALL_PASS_THROUGH_NAMES = [
  "http_proxy", "https_proxy", "no_proxy",
  "node_extra_ca_certs", "ssl_cert_file", "ssl_cert_dir",
  "node_options",
  "node_auth_token", "npm_token"
] as const;
/** npm and pnpm read `npm_config_<key>` (pnpm also `pnpm_config_<key>`) with `_` or `-`; the install forces this key on. */
const IGNORE_SCRIPTS_KEYS = ["npm-config-ignore-scripts", "pnpm-config-ignore-scripts"];

/**
 * AUTH-007: the dependency install's env: the base allowlist, the job's install settings
 * (`INSTALL_PASS_THROUGH_*`) except every name in `excluded` (the evaluator secrets every route
 * of the manifest declares, since the workflow grants their union to the job), then `extra`. A job value never turns lifecycle scripts back on.
 */
export function installEnv(context: ControlContext, excluded: readonly string[], extra: StringMap): StringMap {
  const env = childEnv(context);
  for (const [name, value] of context.stepEnv) {
    const lower = name.toLowerCase();
    const listed = INSTALL_PASS_THROUGH_PREFIXES.some((prefix) => lower.startsWith(prefix)) || INSTALL_PASS_THROUGH_NAMES.some((known) => known === lower);
    if (!listed || excluded.includes(name) || IGNORE_SCRIPTS_KEYS.includes(lower.replaceAll("_", "-"))) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** §3.9 minimal child env: the base allowlist plus the named extra values. */
export function childEnv(context: ControlContext, extra: StringMap = {}): StringMap {
  const env: StringMap = {};
  for (const name of CHILD_BASE_ENV_NAMES) {
    const value = context.stepEnv.get(name);
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}
