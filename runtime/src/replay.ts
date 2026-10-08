// One isolated_replay work item (§3.3). The runtime replays every declared case
// against the item's model through the proxy, scores it in a killable scorer child,
// and returns either upload rows or a typed failure. Ported from the old kit replay
// harness; the new parts are the per-trial case concurrency (§6.1 item 1), the judge
// output limit and truncation (items 2 and 3), the eval-call header and call token
// (§3.3.2, §3.9), per-target Retry-After, and per-case deadlines.
import {
  EVAL_CASE_ERROR_CODE,
  JUDGE_OUTPUT_TRUNCATED,
  type EvalCaseErrorCode,
  type EvalCaseFailureStage,
  type EvalFailedCaseDiagnostic,
  type EvalRunFailureDiagnostic
} from "../../src/shared/failure-codes";
import {
  RUNNER_EVAL_CALL_HEADER,
  type RunnerCallRole,
  type RunnerEvalCallHeader,
  type RunnerWorkFailCause,
  type RunnerWorkItem
} from "../../src/shared/runner-protocol";
import type { ReplayCase } from "./cases";
import type { ControlContext } from "./control";
import { canonicalJson, finiteOrNull, isJsonObject, isJsonString, safeCode, stringOrEmpty, type JsonObject, type JsonValue } from "./json";
import type { ManifestRoute } from "./manifest";
import {
  completionFinishReason,
  extractAssistantMessage,
  jsonFormatViolation,
  jsonResponseFormat,
  messageContent,
  parseMessage,
  structuralOutcome
} from "./model-output";
import { ScorerProcess, type JudgeBridge } from "./scorer-process";
import { send, TransportError, type HttpReply, type TargetHolds } from "./transport";
import { metricsChecks, type ReplayMetrics } from "./metrics";

/** The Worker bounds each provider attempt; this slightly wider client deadline catches a lost response. */
const MODEL_ATTEMPT_TIMEOUT_MS = 135_000;
const JUDGE_ATTEMPT_TIMEOUT_MS = 60_000;
const PROXY_MAX_ATTEMPTS = 3;
/** The only paths a replay or judge call may target on the API origin. */
export const REPLAY_ENDPOINTS: ReadonlySet<string> = new Set(["/v1/chat/completions", "/v1/messages", "/v1/responses"]);
/** Ledger statuses (§3.3.2) that mean "the same operation is settling; retry the same op later". */
const SETTLING_CODES = new Set(["call_in_progress", "call_outcome_unknown"]);

/** A fault that ends the whole item, not one case. */
export class ItemFault extends Error {
  metrics?: ReplayMetrics[];
  constructor(readonly cause: RunnerWorkFailCause, message: string) {
    super(message);
  }
}

class CaseFault extends Error {
  constructor(
    readonly stage: EvalCaseFailureStage,
    readonly errorCode: EvalCaseErrorCode,
    readonly causeCode: string | null,
    readonly causeName: string | null = null
  ) {
    super(`${stage} failed: ${errorCode}`);
  }
}

export interface ItemEnvironment {
  control: ControlContext;
  holds: TargetHolds;
  treeRoot: string;
  route: ManifestRoute;
  item: RunnerWorkItem;
  cases: ReplayCase[];
  /** Aborted when the lease is fenced or the session stops. */
  signal: AbortSignal;
  /**
   * §3.3.4: resolves true when a new call may start. While heartbeats fail it waits for an
   * acknowledgment; it resolves false once local lease expiry passes without one.
   */
  callsAllowed: () => Promise<boolean>;
}

/** One row in the current case-result schema (parseEvalModelCaseResultRows). */
export interface UploadRow extends JsonObject {
  case_id: string;
  case_version: string;
  critical: boolean;
  model: string;
  selected_model: string | null;
  model_call_ids: string[];
  pass: boolean;
  score: number;
  cost_usd: number | null;
  latency_ms: number | null;
  error: string | null;
  outcome_code: string | null;
  raw_output: string | null;
  judge_cost_usd: number | null;
}

interface CaseResult {
  row: UploadRow;
  failure: EvalFailedCaseDiagnostic | null;
  metrics: ReplayMetrics;
}

/** §3.3.5: what a batch (a case subset) uploads beside its rows. */
export interface BatchOutcome {
  caseIds: string[];
  /** Cases of the batch with no scorable evidence, as EVAL-011 failed-case diagnostics. */
  failures: EvalFailedCaseDiagnostic[];
}

export type ItemOutcome =
  | { kind: "upload"; rows: UploadRow[]; quality: JsonObject | null; metrics?: ReplayMetrics[]; batch?: BatchOutcome }
  | { kind: "fail"; cause: RunnerWorkFailCause; diagnostics: JsonObject; providerOnly: boolean; metrics?: ReplayMetrics[] };

function encodeCallHeader(header: RunnerEvalCallHeader): string {
  return Buffer.from(canonicalJson(header), "utf8").toString("base64url");
}

/** EVAL-011 / DATA-001: BenchRouter's bounded error code, never the raw error body. */
function httpFailureCause(reply: HttpReply): string {
  try {
    const body: JsonValue = JSON.parse(reply.text);
    const error = isJsonObject(body) && body.error !== undefined && isJsonObject(body.error) ? body.error : {};
    const code = error.code ?? error.benchrouter_code;
    const safe = safeCode(code);
    if (safe !== null && safe === safe.toLowerCase()) return safe;
  } catch {
    // Not JSON: keep the status.
  }
  return String(reply.status);
}

function errorCodeOf(reply: HttpReply): string | null {
  try {
    const body: JsonValue = JSON.parse(reply.text);
    const error = isJsonObject(body) && body.error !== undefined && isJsonObject(body.error) ? body.error : {};
    return isJsonString(error.code) ? error.code : null;
  } catch {
    return null;
  }
}

function positiveMs(value: number): number {
  return Math.max(1, Math.round(value));
}

export async function runReplayItem(env: ItemEnvironment): Promise<ItemOutcome> {
  const { item, route } = env;
  if (item.limits.trials !== 1) throw new ItemFault("capability_unsupported", "stage 1 runs one trial per item");
  if (env.cases.length === 0) throw new ItemFault("harness_failed", `no runnable eval cases for route ${route.routeId}`);
  // §3.3.5: a batch is the server's choice of this lease generation's cases, in its order.
  const batchIds = item.case_selection !== null && item.case_selection.kind === "subset" ? item.case_selection.case_ids : null;
  const cases = batchIds === null ? env.cases : selectBatch(env.cases, batchIds);
  const workDeadlineAt = Date.parse(item.work_deadline_at);
  const concurrency = Math.max(1, Math.min(item.limits.case_concurrency, cases.length));
  const scorers: ScorerProcess[] = [];
  const results: CaseResult[] = [];
  // A lost lease, the work deadline or retirement kills every scorer child of the item at once.
  const stopScorers = () => { for (const scorer of scorers) void scorer.stop(); };
  env.signal.addEventListener("abort", stopScorers, { once: true });
  try {
    for (let slot = 0; slot < concurrency; slot += 1) {
      const scorer = new ScorerProcess(env.control, env.treeRoot, route.scorerPath);
      const started = await scorer.start();
      if (!started.ok) throw new ItemFault("harness_failed", `the scorer failed to load (${started.errorCode})`);
      scorers.push(scorer);
    }
    let next = 0;
    const trial = 1;
    // §6.1 item 1: `case_concurrency` bounds the cases of one trial in flight at once,
    // so the proxy's per-trial in-flight cap never refuses a case.
    await Promise.all(scorers.map(async (scorer) => {
      while (true) {
        const index = next++;
        const testCase = cases[index];
        if (testCase === undefined) return;
        if (env.signal.aborted) throw abortFault(env);
        if (!scorer.running) {
          const restarted = await scorer.start();
          if (!restarted.ok) throw new ItemFault("harness_failed", "the scorer failed to restart after a timeout");
        }
        results[index] = await runCase(env, scorer, testCase, trial, workDeadlineAt);
      }
    }));
    if (env.signal.aborted) throw abortFault(env);
    const failed = results.map((result) => result.failure).filter((failure): failure is EvalFailedCaseDiagnostic => failure !== null);
    if (batchIds !== null) {
      // A batch that ran to the end is uploaded: one result row for each scored case
      // and one diagnostic for each case with no scorable evidence. The server decides
      // whether the run goes on.
      return {
        kind: "upload",
        rows: results.filter((result) => result.failure === null).map((result) => result.row),
        quality: null,
        metrics: results.map((result) => result.metrics),
        batch: { caseIds: batchIds, failures: failed }
      };
    }
    if (failed.length === 0) return { kind: "upload", rows: results.map((result) => result.row), quality: null, metrics: results.map(result => result.metrics) };
    return {
      kind: "fail",
      cause: "case_failures",
      diagnostics: caseFailureDiagnostic(results, failed),
      providerOnly: failed.every((failure) => failure.stage === "model_call"),
      metrics: results.map(result => result.metrics)
    };
  } catch (error) {
    // Keep only cases that actually finished. An interrupted item contributes
    // no invented rows for cases which did not execute.
    if (error instanceof ItemFault) error.metrics = results.filter(Boolean).map(result => result.metrics);
    throw error;
  } finally {
    env.signal.removeEventListener("abort", stopScorers);
    await Promise.all(scorers.map((scorer) => scorer.stop()));
  }
}

/** The batch's cases from the eval tree. A case the tree does not have is not this tree's batch. */
function selectBatch(cases: ReplayCase[], caseIds: string[]): ReplayCase[] {
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length) throw new ItemFault("harness_failed", "the batch names no case, or one case twice");
  return caseIds.map((caseId) => {
    const testCase = byId.get(caseId);
    if (testCase === undefined) throw new ItemFault("harness_failed", `the batch names case ${JSON.stringify(caseId.slice(0, 80))}, which the eval tree does not have`);
    return testCase;
  });
}

async function runCase(env: ItemEnvironment, scorer: ScorerProcess, testCase: ReplayCase, trial: number, workDeadlineAt: number): Promise<CaseResult> {
  const { item, route } = env;
  const started = Date.now();
  const caseDeadlineAt = Math.min(started + item.limits.case_timeout_s * 1000, workDeadlineAt);
  const row: UploadRow = {
    case_id: testCase.id,
    case_version: testCase.version,
    critical: testCase.critical,
    model: item.model_run.model,
    selected_model: null,
    model_call_ids: [],
    pass: false,
    score: 0,
    cost_usd: null,
    latency_ms: null,
    error: null,
    outcome_code: null,
    raw_output: null,
    judge_cost_usd: null
  };
  let checks: ReturnType<typeof metricsChecks> = { checks: [], checks_omitted: false };
  // RUN-001 F9: model seq is 0; judge operations start at 1.
  let judgeSeq = 1;
  let judgeCost = 0;
  let judgeFailure: CaseFault | null = null;
  // EVAL-013: a truncated judge reply never judged the case, so no later outcome clears it.
  let judgeTruncated: CaseFault | null = null;
  // A lease, deadline or retirement fault raised inside a judge call crosses the scorer
  // membrane only as text; keep it so the item fails with its own cause.
  let itemFault: ItemFault | null = null;
  const judge: JudgeBridge = async (messages, options) => {
    try {
      const judgment = await callJudge(env, testCase, trial, judgeSeq++, messages, options, caseDeadlineAt, (cost) => { judgeCost += cost; });
      // EVAL-011: a later successful judge call resolves an earlier failure.
      judgeFailure = null;
      return judgment;
    } catch (error) {
      if (error instanceof ItemFault) {
        itemFault = error;
        throw error;
      }
      judgeFailure = error instanceof CaseFault ? error : new CaseFault("judge", EVAL_CASE_ERROR_CODE.transportFetchFailed, null);
      if (judgeFailure.causeCode === JUDGE_OUTPUT_TRUNCATED) judgeTruncated = judgeFailure;
      throw new Error(judgeFailure.message);
    }
  };
  let failure: CaseFault | null = null;
  try {
    const callStarted = Date.now();
    const reply = await proxyCall(env, { case_id: testCase.id, trial, role: "model", seq: 0 }, testCase.endpoint, buildReplayBody(testCase, route.routeId), testCase.headers, caseDeadlineAt, MODEL_ATTEMPT_TIMEOUT_MS);
    row.latency_ms = positiveMs(Date.now() - callStarted);
    row.selected_model = reply.headers.get("x-benchrouter-selected-model");
    const callId = reply.headers.get("x-benchrouter-model-call-id");
    if (reply.status < 200 || reply.status >= 300) {
      throw new CaseFault("model_call", EVAL_CASE_ERROR_CODE.upstreamHttpError, httpFailureCause(reply));
    }
    const parsedValue = safeParse(reply.text);
    const message = extractAssistantMessage(parsedValue);
    row.raw_output = message;
    row.cost_usd = usageCost(parsedValue);
    if (!callId) throw new CaseFault("harness", EVAL_CASE_ERROR_CODE.unknown, null);
    row.model_call_ids = [callId];
    const scorerMetadata = testCase.raw.scorer_metadata;
    const metadata: JsonObject = { case_id: testCase.id, message: parseMessage(message), reference_message: parseMessage(testCase.raw.reference_output ?? null) };
    // Declared scorer hints win over the built-in fields, as in the old kit.
    if (scorerMetadata !== undefined && isJsonObject(scorerMetadata)) Object.assign(metadata, scorerMetadata);
    const payload = {
      request: testCase.raw.request ?? null,
      output: messageContent(message),
      reference: messageContent(testCase.raw.reference_output ?? null),
      metadata
    };
    const scored = await scorer.score(JSON.stringify(payload), judge, caseDeadlineAt);
    if (itemFault !== null) throw itemFault;
    if (env.signal.aborted) throw abortFault(env);
    if (judgeTruncated !== null) throw judgeTruncated;
    if (!scored.ok) {
      throw judgeFailure ?? new CaseFault("scorer", scored.errorCode === "sandbox_violation" ? EVAL_CASE_ERROR_CODE.sandboxViolation : EVAL_CASE_ERROR_CODE.scorerException, null, scored.causeName);
    }
    row.pass = scored.verdict.pass;
    checks = metricsChecks(scored.verdict.checks);
    row.score = row.pass ? 1 : 0;
    if (!row.pass && judgeFailure) {
      // EVAL-011: the scorer turned a failed judge call into a rejection; the candidate was never judged.
      throw judgeFailure;
    }
    if (!row.pass) {
      // EVAL-002: name the protocol fact, if any, behind the failure. Neither the scorer's
      // reasons nor what the answer says is read.
      const structural = structuralOutcome(parsedValue, completionFinishReason(parsedValue));
      if (structural) {
        row.error = structural.message;
        row.outcome_code = structural.code;
      }
    }
  } catch (error) {
    if (error instanceof ItemFault) throw error;
    failure = error instanceof CaseFault ? error : new CaseFault("harness", EVAL_CASE_ERROR_CODE.unknown, null);
  }
  row.judge_cost_usd = judgeCost > 0 ? judgeCost : null;
  if (row.latency_ms === null) row.latency_ms = positiveMs(Date.now() - started);
  const metrics: ReplayMetrics = { case_id: row.case_id, model: row.model, selected_model: row.selected_model, pass: row.pass, technical_failure: failure !== null, cost_usd: row.cost_usd, ...checks };
  if (failure === null) return { row, failure: null, metrics };
  row.error = failure.message;
  return {
    row,
    metrics,
    failure: {
      case_id: testCase.id.slice(0, 200),
      stage: failure.stage,
      error_code: failure.errorCode,
      cause_code: failure.stage === "scorer" ? null : safeCode(failure.causeCode ?? undefined),
      cause_name: safeCode(failure.causeName ?? undefined),
      model_call_id: row.model_call_ids[0] ?? null,
      latency_ms: row.latency_ms
    }
  };
}

/** EVAL-011: the per-case failure diagnostic (EvalRunFailureDiagnostic), bounded like the old kit. */
function caseFailureDiagnostic(results: CaseResult[], failed: EvalFailedCaseDiagnostic[]): JsonObject {
  const diagnostic: EvalRunFailureDiagnostic = {
    v: 1,
    source: "workflow_fail_step",
    reason_code: "case_failures",
    failed_step: "evaluator",
    github_conclusion: null,
    cases: {
      planned: results.length,
      succeeded: results.filter((result) => result.failure === null).slice(0, 256).map((result) => ({ case_id: result.row.case_id.slice(0, 200), model_call_ids: result.row.model_call_ids.slice(0, 16) })),
      failed: failed.slice(0, 256)
    }
  };
  const cases = diagnostic.cases;
  return {
    v: diagnostic.v,
    source: diagnostic.source,
    reason_code: diagnostic.reason_code,
    failed_step: diagnostic.failed_step,
    github_conclusion: diagnostic.github_conclusion,
    cases: cases === null ? null : {
      planned: cases.planned,
      succeeded: cases.succeeded.map((entry) => ({ case_id: entry.case_id, model_call_ids: entry.model_call_ids })),
      failed: cases.failed.map((entry) => ({
        case_id: entry.case_id,
        stage: entry.stage,
        error_code: entry.error_code,
        cause_code: entry.cause_code,
        cause_name: entry.cause_name,
        model_call_id: entry.model_call_id,
        latency_ms: entry.latency_ms
      }))
    }
  };
}

/** The item's abort reason: the session sets an ItemFault (lease lost, deadline, retiring). */
function abortFault(env: ItemEnvironment): ItemFault {
  const reason: Error | null = env.signal.reason instanceof ItemFault ? env.signal.reason : null;
  return reason instanceof ItemFault ? reason : new ItemFault("lease_lost", "the lease ended");
}

function safeParse(text: string): JsonObject {
  try {
    const value: JsonValue = JSON.parse(text);
    return isJsonObject(value) ? value : {};
  } catch {
    return {};
  }
}

function usageCost(parsed: JsonObject): number | null {
  const usage = parsed.usage !== undefined && isJsonObject(parsed.usage) ? parsed.usage : {};
  return finiteOrNull(usage.cost ?? usage.total_cost);
}

/** The declared request replayed verbatim, forced to the route id, never streamed (SERVE-009). */
function buildReplayBody(testCase: ReplayCase, routeId: string): JsonObject {
  const body: JsonObject = { ...testCase.body, model: routeId };
  delete body.stream;
  delete body.stream_options;
  if (body.temperature === undefined) body.temperature = 0;
  return body;
}

/**
 * One model or judge call through the proxy. The call token authenticates the item
 * (§3.9); the header names the logical operation (§3.3.2), so an HTTP retry and a
 * replacement lease reach the same `op_id`. Retries honor Retry-After per target.
 */
async function proxyCall(env: ItemEnvironment, header: RunnerEvalCallHeader, endpoint: string, body: JsonObject, extraHeaders: Record<string, string>, deadlineAt: number, attemptTimeoutMs: number): Promise<HttpReply> {
  if (env.signal.aborted) throw abortFault(env);
  if (!(await env.callsAllowed())) throw new ItemFault("lease_lost", "the lease expired locally without a heartbeat acknowledgment; no new call starts");
  // The call token goes only to the API origin, and only to a replay endpoint.
  const url = new URL(endpoint, `${env.control.apiOrigin}/`);
  if (url.origin !== new URL(env.control.apiOrigin).origin || !REPLAY_ENDPOINTS.has(url.pathname) || url.search !== "") {
    throw new ItemFault("harness_failed", `refusing the call endpoint ${JSON.stringify(endpoint)}`);
  }
  const role: RunnerCallRole = header.role;
  const target = role === "judge" ? `judge:${env.route.routeId}` : `model:${env.item.model_run.model}`;
  let reply: HttpReply;
  try {
    reply = await send({
      method: "POST",
      url: url.href,
      headers: {
        ...extraHeaders,
        authorization: `Bearer ${env.item.call_token}`,
        "content-type": "application/json",
        [RUNNER_EVAL_CALL_HEADER]: encodeCallHeader(header)
      },
      body: JSON.stringify(body),
      attemptTimeoutMs,
      deadlineAt,
      target,
      maxAttempts: PROXY_MAX_ATTEMPTS,
      // §3.3.4: an HTTP retry is a new call start; it needs a live lease too.
      beforeAttempt: env.callsAllowed,
      retryWhen: (candidate) => candidate.status === 409 && SETTLING_CODES.has(errorCodeOf(candidate) ?? ""),
      signal: env.signal
    }, env.holds);
  } catch (error) {
    if (env.signal.aborted) throw abortFault(env);
    if (!(error instanceof TransportError)) throw error;
    const stage: EvalCaseFailureStage = role === "judge" ? "judge" : "model_call";
    // A Retry-After hold that outlasts the case keeps the refusal code that set it (EVAL-011 classifies it).
    if (error.reason === "held" && error.lastReply) throw new CaseFault(stage, EVAL_CASE_ERROR_CODE.upstreamHttpError, httpFailureCause(error.lastReply));
    throw new CaseFault(stage, error.reason === "unreachable" ? EVAL_CASE_ERROR_CODE.transportFetchFailed : EVAL_CASE_ERROR_CODE.upstreamTimeout, null);
  }
  const code = errorCodeOf(reply);
  if (reply.status === 409 && code === "call_body_changed") throw new ItemFault("nondeterministic_request", "the proxy refused a changed request body under the same operation");
  if (reply.status === 410 && code === "call_response_expired") throw new ItemFault("call_response_expired", "the stored response of an operation expired");
  if (code === "fenced" || code === "session_expired") throw new ItemFault("lease_lost", `the proxy refused the call: ${code}`);
  if (code === "work_deadline_exceeded") throw new ItemFault("deadline_exceeded", "the work deadline passed");
  return reply;
}

async function callJudge(env: ItemEnvironment, testCase: ReplayCase, trial: number, seq: number, messages: JsonValue, options: JsonValue, caseDeadlineAt: number, addCost: (cost: number) => void): Promise<string> {
  // EVAL-011: an opt-in { response_format } is sent to the judge, and the reply is validated against it.
  const responseFormat = isJsonObject(options) && options.response_format !== undefined ? options.response_format : undefined;
  const format = responseFormat === undefined ? null : jsonResponseFormat(responseFormat);
  if (responseFormat !== undefined && (!format || format.kind === "json")) {
    throw new CaseFault("scorer", EVAL_CASE_ERROR_CODE.scorerException, null);
  }
  const body: JsonObject = {
    model: env.route.routeId,
    messages,
    temperature: 0,
    // §6.1 item 2: every judge call carries the output limit, so its spend hold stays small.
    max_completion_tokens: env.item.limits.judge_max_completion_tokens
  };
  if (responseFormat !== undefined) body.response_format = responseFormat;
  const reply = await proxyCall(env, { case_id: testCase.id, trial, role: "judge", seq }, "/v1/chat/completions", body, {}, caseDeadlineAt, JUDGE_ATTEMPT_TIMEOUT_MS);
  if (reply.status < 200 || reply.status >= 300) throw new CaseFault("judge", EVAL_CASE_ERROR_CODE.upstreamHttpError, httpFailureCause(reply));
  const parsed = safeParse(reply.text);
  const cost = usageCost(parsed);
  if (cost !== null) addCost(cost);
  const choice = Array.isArray(parsed.choices) && parsed.choices[0] !== undefined && isJsonObject(parsed.choices[0]) ? parsed.choices[0] : {};
  // §6.1 item 3: a reply cut off at the judge output limit never finished judging. It is
  // never graded, and repeating it hits the same limit (a permanent cause).
  if (choice.finish_reason === "length") throw new CaseFault("judge", EVAL_CASE_ERROR_CODE.judgeUnavailable, JUDGE_OUTPUT_TRUNCATED);
  const message = choice.message !== undefined && isJsonObject(choice.message) ? choice.message : {};
  // Reasoning judges may leave content empty and answer in reasoning fields.
  const judgment = stringOrEmpty(message.content) || stringOrEmpty(message.reasoning_content) || stringOrEmpty(message.reasoning);
  if (!judgment) throw new CaseFault("judge", EVAL_CASE_ERROR_CODE.judgeUnavailable, null);
  const violation = format ? jsonFormatViolation(format, stringOrEmpty(message.content).trim()) : null;
  if (violation) throw new CaseFault("judge", EVAL_CASE_ERROR_CODE.judgeUnavailable, "judge_output_invalid");
  return judgment;
}
