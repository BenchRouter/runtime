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

/** §3.9 minimal child env: the base allowlist plus the named extra values. */
export function childEnv(context: ControlContext, extra: StringMap = {}): StringMap {
  const env: StringMap = {};
  for (const name of CHILD_BASE_ENV_NAMES) {
    const value = context.stepEnv.get(name);
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}
