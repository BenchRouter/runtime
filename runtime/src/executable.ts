// One repository_executable work item (§3.3, §3.9, AUTH-007). It runs only on a
// server-dispatched job, as the only item of that job, in a fresh workspace:
//   1. dependency install in its own process group, lifecycle scripts disabled, with
//      the install-only registry grant and no evaluator secret (§7.3 decision 1);
//   2. a re-hash of the declared files after install (`tree_mutated`);
//   3. the customer argv in its own process group, with only the eval-call contract
//      (the item's call token and base URL) and the manifest-declared secret names;
//   4. the result receipt at `result_path`, parsed into case-result rows.
// Every child is killed (SIGTERM, then SIGKILL after 5 s) at its deadline.
import type { ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { EvalExecutionFailureReason } from "../../src/shared/failure-codes";
import type { RunnerWorkItem, Sha256Digest } from "../../src/shared/runner-protocol";
import { childEnv, type ControlContext } from "./control";
import { isJsonFiniteNumber, isJsonObject, isJsonString, parseJsonText, ProtocolError, type JsonObject, type JsonValue } from "./json";
import type { ManifestRoute } from "./manifest";
import { killGroup, spawnGroup } from "./processes";
import type { ItemOutcome, UploadRow } from "./replay";
import { ItemFault } from "./replay";
import { hashDeclaredFiles, sameHashes } from "./snapshot";
import type { StringMap } from "./transport";

/** §7.3 decision 1: the names the install child sees the registry grant under. */
export const INSTALL_TOKEN_ENV_NAMES = ["NODE_AUTH_TOKEN", "NPM_TOKEN"] as const;

export interface ExecutableEnvironment {
  control: ControlContext;
  treeRoot: string;
  route: ManifestRoute;
  item: RunnerWorkItem;
  fileHashes: Record<string, Sha256Digest>;
  signal: AbortSignal;
}

interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startFailed: boolean;
  /** The child's stdout, only when the caller asked to capture it. */
  stdout: string;
}

/** Run argv as a process group until it exits, the deadline passes, or the item aborts. */
function runGroup(argv: string[], cwd: string, env: StringMap, deadlineAt: number, signal: AbortSignal, captureStdout = false): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    // An abort that landed before the spawn (a fence during install or hashing) starts nothing.
    if (command === undefined || signal.aborted) {
      resolve({ exitCode: null, signal: null, timedOut: false, startFailed: true, stdout: "" });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawnGroup(command, args, { cwd, env, stdio: ["ignore", captureStdout ? "pipe" : "inherit", "inherit"] });
    } catch {
      resolve({ exitCode: null, signal: null, timedOut: false, startFailed: true, stdout: "" });
      return;
    }
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString("utf8"); });
    let timedOut = false;
    const stop = () => { void killGroup(child); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, deadlineAt - Date.now()));
    signal.addEventListener("abort", stop, { once: true });
    const finish = (outcome: ProcessOutcome) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(outcome);
    };
    child.once("error", () => finish({ exitCode: null, signal: null, timedOut: false, startFailed: true, stdout }));
    child.once("exit", (code, exitSignal) => {
      // A grandchild the evaluator left behind never outlives the item.
      void killGroup(child);
      finish({ exitCode: code, signal: exitSignal, timedOut, startFailed: false, stdout });
    });
  });
}

function executionDiagnostic(outcome: ProcessOutcome): JsonObject {
  const reason: EvalExecutionFailureReason = outcome.startFailed ? "process_start_failed"
    : outcome.timedOut ? "process_timeout"
    : outcome.signal !== null ? "process_signal"
    : "process_exit";
  return {
    v: 1,
    source: "workflow_fail_step",
    reason_code: "workflow_step_failed",
    failed_step: "evaluator",
    github_conclusion: null,
    cases: null,
    execution: {
      phase: "evaluator",
      reason,
      exit_code: reason === "process_exit" && outcome.exitCode !== null && outcome.exitCode > 0 ? outcome.exitCode : null,
      signal: reason === "process_signal" || reason === "process_timeout" ? outcome.signal : null,
      timed_out: outcome.timedOut
    }
  };
}

function installArgv(route: ManifestRoute): string[] {
  const runtime = route.executable?.runtime;
  // Lifecycle scripts stay disabled for every install (AUTH-007).
  return runtime === "bun" ? ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] : ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
}

function abortFault(signal: AbortSignal): ItemFault {
  const reason: Error | null = signal.reason instanceof ItemFault ? signal.reason : null;
  return reason instanceof ItemFault ? reason : new ItemFault("lease_lost", "the lease ended");
}

export async function runExecutableItem(env: ExecutableEnvironment): Promise<ItemOutcome> {
  const { control, route, item, treeRoot, signal } = env;
  const executable = route.executable;
  if (!executable) throw new ItemFault("mode_unsupported", `route ${route.routeId} declares no executable contract`);
  // AUTH-007: executable work starts only through the server's workflow_dispatch.
  if (control.eventName !== "workflow_dispatch") throw new ItemFault("capability_unsupported", "executable work runs only on a server-dispatched job");
  if (item.limits.trials !== 1) throw new ItemFault("capability_unsupported", "stage 1 runs one trial per item");
  const workDir = executable.workingDirectory === null ? treeRoot : path.join(treeRoot, executable.workingDirectory);
  const workDeadlineAt = Date.parse(item.work_deadline_at);

  // 0. EVAL-012: bind the evaluator to the pinned runtime. The runtime binary is resolved
  // once from PATH and its version checked in a tracked child. argv[0] must be the runtime
  // itself and is replaced by that checked binary, so the evaluator process is the pinned
  // runtime; its directory also goes first on every child's PATH. (What the evaluator
  // itself spawns later is outside what a runner can prove.)
  const runtimeBinary = await resolveOnPath(executable.runtime, control.stepEnv.get("PATH") ?? "");
  if (runtimeBinary === null) throw new ItemFault("harness_failed", `${executable.runtime} is not on PATH; set it up in the workflow's customer-setup block`);
  const launcher = executable.argv[0] ?? "";
  const launchers: readonly string[] = ARGV_LAUNCHERS[executable.runtime];
  if (!launchers.includes(launcher)) {
    throw new ItemFault("harness_failed", `argv must start with one of ${ARGV_LAUNCHERS[executable.runtime].join(", ")} so it runs on the pinned ${executable.runtime}`);
  }
  const pinnedPath = `${path.dirname(runtimeBinary)}${path.delimiter}${control.stepEnv.get("PATH") ?? ""}`;
  const probe = await runGroup([runtimeBinary, "--version"], workDir, childEnv(control, { PATH: pinnedPath }), Math.min(workDeadlineAt, Date.now() + 30_000), signal, true);
  if (signal.aborted) throw abortFault(signal);
  const found = probe.exitCode === 0 ? probe.stdout.trim() : null;
  if (found === null || normalizeVersion(found) !== normalizeVersion(executable.runtimeVersion)) {
    throw new ItemFault("harness_failed", `the route pins ${executable.runtime} ${executable.runtimeVersion}, but the job has ${found ?? "none"}; set it up in the workflow's customer-setup block`);
  }

  // 1. Install: the install-only registry grant, no evaluator secret, scripts disabled.
  const installEnv: StringMap = childEnv(control, { npm_config_ignore_scripts: "true", PATH: pinnedPath });
  if (control.installNpmToken !== null) {
    for (const name of INSTALL_TOKEN_ENV_NAMES) installEnv[name] = control.installNpmToken;
  }
  const install = await runGroup(installArgv(route), workDir, installEnv, workDeadlineAt, signal);
  if (signal.aborted) throw abortFault(signal);
  if (install.timedOut) throw new ItemFault("deadline_exceeded", "the dependency install ran past the work deadline");
  if (install.startFailed || install.exitCode !== 0) throw new ItemFault("install_failed", `the dependency install failed (${install.startFailed ? "could not start" : `exit ${install.exitCode ?? install.signal}`})`);

  // 2. §3.2: the install must not change a declared file.
  if (!sameHashes(await hashDeclaredFiles(treeRoot, route), env.fileHashes)) throw new ItemFault("tree_mutated", "the dependency install changed a declared file");

  // 3. The evaluator: the eval-call contract plus the declared secret names, nothing else.
  const baseUrl = control.apiOrigin;
  const evaluatorEnv: StringMap = childEnv(control, {
    PATH: pinnedPath,
    BENCHROUTER_API_KEY: item.call_token,
    BENCHROUTER_EVAL_BASE_URL: baseUrl,
    BENCHROUTER_ROUTE_ID: route.routeId
  });
  if (route.baseUrlEnv !== null) evaluatorEnv[route.baseUrlEnv] = baseUrl;
  // The workflow grants these values on server-dispatched runs only; the manifest names them.
  for (const name of executable.secretEnv) {
    const value = control.stepEnv.get(name);
    if (value !== undefined && value.length > 0) evaluatorEnv[name] = value;
  }
  // A receipt left in the tree never counts: only one this evaluator run writes does.
  await rm(path.join(treeRoot, executable.resultPath), { force: true });
  const timeoutAt = Math.min(workDeadlineAt, Date.now() + executable.timeoutMinutes * 60_000);
  const evaluatorArgv = [runtimeBinary, ...executable.argv.slice(1)];
  const run = await runGroup(evaluatorArgv, workDir, evaluatorEnv, timeoutAt, signal);
  if (signal.aborted) throw abortFault(signal);
  if (run.timedOut && timeoutAt >= workDeadlineAt) throw new ItemFault("deadline_exceeded", "the evaluator ran past the work deadline");
  if (run.startFailed || run.timedOut || run.signal !== null || run.exitCode !== 0) {
    return { kind: "fail", cause: "harness_failed", diagnostics: executionDiagnostic(run), providerOnly: false };
  }

  // 4. The result receipt.
  const receipt = await readReceipt(path.join(treeRoot, executable.resultPath), executable.primaryMetric, item.model_run.model);
  return { kind: "upload", rows: receipt.rows, quality: receipt.quality };
}

function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

/** The launchers that start on the pinned runtime found first on PATH. */
// Package tools (npm run, npx, pnpm, yarn, bunx) put node_modules/.bin first on PATH, where a
// dependency can ship its own runtime binary, so only the runtime itself may start the evaluator.
export const ARGV_LAUNCHERS = {
  node: ["node"],
  bun: ["bun"]
} as const satisfies Record<"node" | "bun", readonly string[]>;

/** The first executable `name` on PATH, as an absolute path. */
async function resolveOnPath(name: string, searchPath: string): Promise<string | null> {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir.length === 0 || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Not here.
    }
  }
  return null;
}

function isMetricName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  const first = name.charAt(0);
  if (!((first >= "A" && first <= "Z") || (first >= "a" && first <= "z"))) return false;
  for (let index = 1; index < name.length; index += 1) {
    const c = name.charAt(index);
    const ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_" || c === "." || c === "-";
    if (!ok) return false;
  }
  return true;
}

function score(value: JsonValue | undefined, label: string): number {
  if (value === undefined || !isJsonFiniteNumber(value) || value < 0 || value > 1) throw new ItemFault("harness_failed", `${label} must be a number from 0 to 1`);
  return value;
}

/** The executable result receipt, validated as the old kit validated it. */
interface Receipt {
  rows: UploadRow[];
  quality: JsonObject;
}

async function readReceipt(resultPath: string, primaryMetric: string, model: string): Promise<Receipt> {
  let parsed: JsonValue;
  try {
    parsed = parseJsonText(await readFile(resultPath, "utf8"), "executable result");
  } catch (error) {
    throw new ItemFault("harness_failed", error instanceof ProtocolError ? error.message : "the evaluator wrote no result receipt");
  }
  if (!isJsonObject(parsed)) throw new ItemFault("harness_failed", "the executable result receipt must be an object");
  const primary = parsed.primary_metric;
  if (primary === undefined || !isJsonObject(primary) || primary.name !== primaryMetric) throw new ItemFault("harness_failed", "the executable result receipt has an invalid primary metric");
  score(primary.score, "primary_metric.score");
  const observations = Array.isArray(parsed.observations) ? parsed.observations : [];
  // The same bounds the server's quality parser applies: an invalid receipt is refused here, never repaired.
  const rawMetrics = parsed.metrics === undefined ? {} : parsed.metrics;
  if (!isJsonObject(rawMetrics)) throw new ItemFault("harness_failed", "the executable result receipt metrics must be an object");
  const metrics: JsonObject = {};
  for (const [name, value] of Object.entries(rawMetrics)) {
    if (!isMetricName(name)) throw new ItemFault("harness_failed", `the executable result metric name ${JSON.stringify(name)} is invalid`);
    metrics[name] = score(value, `metrics.${name}`);
  }
  const rows = observations.map((entry, index): UploadRow => {
    if (!isJsonObject(entry) || (entry.pass !== true && entry.pass !== false)) throw new ItemFault("harness_failed", `executable result observation ${index + 1} must include an explicit boolean pass value`);
    const value = entry.score === undefined ? (entry.pass ? 1 : 0) : score(entry.score, `observation ${index + 1} score`);
    return {
      case_id: isJsonString(entry.id) && entry.id.length > 0 ? entry.id : String(index + 1),
      case_version: isJsonString(entry.version) && entry.version.length > 0 ? entry.version : "1",
      critical: entry.critical === true,
      model,
      selected_model: model,
      // The server derives the call set from its own durable rows; the evaluator never echoes call IDs.
      model_call_ids: [],
      pass: entry.pass,
      score: value,
      cost_usd: null,
      latency_ms: null,
      error: null,
      outcome_code: null,
      raw_output: null,
      judge_cost_usd: null
    };
  });
  return { rows, quality: { primary_metric: { name: primaryMetric, score: score(primary.score, "primary_metric.score") }, metrics } };
}
