import {
  isJsonBoolean,
  isJsonFiniteNumber,
  isJsonString,
  parseJsonValueFromString,
  type JsonObject,
  type JsonValue
} from "./json-parse-contracts";
import { isRecord } from "./parsing";
import { parseStoredRejectionReason, storedRejectionReason, type RejectionReason } from "./rejection-reason";
import type { SpendBoundStop } from "./spend-bound";
import type { TimeBoundStop } from "./time-bound";

export const EVAL_CASE_FAILURE_STAGES = ["model_call", "judge", "scorer", "harness"] as const;
export type EvalCaseFailureStage = (typeof EVAL_CASE_FAILURE_STAGES)[number];

export const EVAL_CASE_ERROR_CODES = [
  "transport_fetch_failed",
  "upstream_timeout",
  "upstream_http_error",
  "providers_exhausted",
  "judge_unavailable",
  "scorer_exception",
  "sandbox_violation",
  "unknown"
] as const;
export type EvalCaseErrorCode = (typeof EVAL_CASE_ERROR_CODES)[number];

/**
 * EVAL-014: the proxy's code for a judge call of a run whose route declares no
 * `eval_pack.judge_model`. There is no default judge, so the cause is permanent.
 */
export const JUDGE_MODEL_UNDECLARED = "judge_model_undeclared";
/**
 * EVAL-013: the proxy refused a call of an extra trial because the trial's
 * allocation, or the set's allowance, is spent. It is terminal: a retry draws
 * on the same allocation.
 */
export const EXTRA_BUDGET_EXHAUSTED = "extra_budget_exhausted";
/**
 * EVAL-013: the proxy refused a call of an extra trial because this call's
 * worst case does not fit what is left of the allocation, counting the holds
 * of calls still in flight. The allocation is not spent; the call is still
 * terminal, since the trial cannot run its full suite within it.
 */
export const EXTRA_HOLD_REJECTED = "extra_hold_rejected";

/**
 * EVAL-013: the judge reply stopped at the runtime's judge output limit
 * (`finish_reason: "length"`), so the case was never judged. Repeating the call hits the
 * same limit, so the cause is permanent.
 */
export const JUDGE_OUTPUT_TRUNCATED = "judge_output_truncated";
/** EVAL-013: a call of an extra trial whose worst-case cost has no bound; it cannot be held. */
export const EXTRA_CALL_UNBOUNDED = "extra_call_unbounded";

// EVAL-002: the protocol fact behind a failed case: the answer had no content, or the
// output limit ended it. Neither reads what the answer says. The scorer alone decides
// pass or fail, and BenchRouter forms no opinion of an answer's content.
export const EVAL_CASE_OUTCOME_CODES = ["output_empty", "output_cut_off"] as const;
export type EvalCaseOutcomeCode = (typeof EVAL_CASE_OUTCOME_CODES)[number];

/**
 * EVAL-011: why a repository cannot run a server-dispatched eval. Each cause
 * fails every model the same way, so a retry or a new candidate only spends
 * GitHub Actions minutes:
 * - `untrusted_repository_eval_context`: the dispatched workflow runs at a
 *   commit other than the result set's frozen eval ref (AUTH-007), so the
 *   historical refusal remains visible until a canonical production import.
 * - `workflow_missing`: GitHub answered the workflow dispatch with 404.
 * - `installation_revoked`: GitHub answered the dispatch with 401 or 403, or
 *   the repository has no active GitHub App installation.
 * - `startup_failing`: the set's route context is startup-blocked (RUN-001 R5,
 *   `src/runner/startup-failures.ts`). It is a context block, kept in
 *   `runner_startup_failures`, so it is never written to `routes.eval_blocked_code`.
 */
export const REPOSITORY_BLOCK_CODES = [
  "untrusted_repository_eval_context",
  "workflow_missing",
  "installation_revoked",
  // EVAL-015: the route harness breaker (src/evals/route-harness-breaker.ts).
  "harness_failing",
  // RUN-001 R5: refusal of a set whose route context is startup-blocked.
  "startup_failing"
] as const;
export type RepositoryBlockCode = (typeof REPOSITORY_BLOCK_CODES)[number];

/** EVAL-015: why a PR's eval workflow never ran (`src/evals/skipped-run-detector.ts`). */
export const SKIPPED_RUN_CAUSES = [
  "skip_ci",
  "fork",
  "diff_limit",
  "workflow_missing",
  "workflow_disabled",
  "workflow_invalid",
  "not_started"
] as const;
export type SkippedRunCause = (typeof SKIPPED_RUN_CAUSES)[number];

export const EVAL_RUN_FAILURE_REASON_CODES = [
  "case_failures",
  "upload_rejected",
  "workflow_step_failed",
  "dispatch_failed",
  "claim_abandoned",
  "liveness_expired",
  "pr_rerun_failed",
  "cancelled",
  "orphaned_before_dispatch",
  // EVAL-011: the repository cannot run a server-dispatched eval (see `REPOSITORY_BLOCK_CODES`).
  "repository_blocked",
  // RUN-001 §3.3.4: the route has more cases than one evaluation run supports, so no
  // worker can run it. The code keeps its first name, from when the limit was one job's time.
  "work_exceeds_job_window",
  // RUN-001 §3.3.1: the job failed in setup before any model call, so the server
  // stopped the whole result set (`src/runner/setup-stop.ts`). Server-written only.
  "setup_failed",
  // EVAL-011 / RUN-001: more than half of the run's cases failed at the model's provider, so the
  // run measured an outage, not the model. Server-written only; the run is unmeasured and retried.
  "provider_outage",
  // EVAL-011 / RUN-001: a case could not be answered because of BenchRouter (settlement, routing
  // contract, credentials, quota, transport, its circuit breaker), so the run measured our
  // failure, not the model. Server-written only; the run is unmeasured and retried.
  "platform_failure"
] as const;
export type EvalRunFailureReasonCode = (typeof EVAL_RUN_FAILURE_REASON_CODES)[number];

/**
 * EVAL-012: the failed step of an `upload_rejected` failure whose evidence failed
 * BenchRouter's own call ledger check (`EvalCallLedgerUnverifiedError`), not a
 * fault of the upload, the eval or the model.
 */
export const EVIDENCE_UNVERIFIED_FAILED_STEP = "evidence_unverified";

/** EVAL-012: the failed step of an upload whose run has no priced model call, so no cost to measure. */
export const UNPRICED_RUN_FAILED_STEP = "unknown_live_cost";

/** EVAL-012: the failed step of an executable upload whose run recorded no model call. */
export const NO_MODEL_CALL_FAILED_STEP = "no_model_call";

/**
 * EVAL-011: the failed step of a dispatch that the owning account's billing refused. Only the
 * account owner can fix it: `billing_refused` has no available balance (add eval credits),
 * `billing_inactive` has an account that is not active (reactivate billing).
 */
export const BILLING_REFUSED_FAILED_STEP = "billing_refused";
export const BILLING_INACTIVE_FAILED_STEP = "billing_inactive";

export const EVAL_RUN_FAILURE_SOURCES = [
  "workflow_fail_step",
  "workflow_run_completed",
  "liveness_reaper",
  "pr_rerun",
  "dispatch"
] as const;
export type EvalRunFailureSource = (typeof EVAL_RUN_FAILURE_SOURCES)[number];

export const EVAL_EXECUTION_FAILURE_PHASES = ["evaluator"] as const;
export type EvalExecutionFailurePhase = (typeof EVAL_EXECUTION_FAILURE_PHASES)[number];

export const EVAL_EXECUTION_FAILURE_REASONS = [
  "process_start_failed",
  "process_exit",
  "process_signal",
  "process_timeout"
] as const;
export type EvalExecutionFailureReason = (typeof EVAL_EXECUTION_FAILURE_REASONS)[number];

export const EVAL_CASE_ERROR_CODE = {
  transportFetchFailed: "transport_fetch_failed",
  upstreamTimeout: "upstream_timeout",
  upstreamHttpError: "upstream_http_error",
  providersExhausted: "providers_exhausted",
  judgeUnavailable: "judge_unavailable",
  scorerException: "scorer_exception",
  sandboxViolation: "sandbox_violation",
  unknown: "unknown"
} as const satisfies Record<string, EvalCaseErrorCode>;

export const EVAL_RUN_FAILURE_REASON_CODE = {
  caseFailures: "case_failures",
  uploadRejected: "upload_rejected",
  workflowStepFailed: "workflow_step_failed",
  dispatchFailed: "dispatch_failed",
  claimAbandoned: "claim_abandoned",
  livenessExpired: "liveness_expired",
  prRerunFailed: "pr_rerun_failed",
  cancelled: "cancelled",
  orphanedBeforeDispatch: "orphaned_before_dispatch"
} as const satisfies Record<string, EvalRunFailureReasonCode>;

export interface EvalSucceededCaseDiagnostic {
  case_id: string;
  model_call_ids: string[];
}

// DATA-001: a failed case carries fixed diagnostics only: stage, error code,
// and a bounded cause code or error class. A free-text message could quote the
// model output (a scorer exception often does), so an uploaded or previously
// stored `message` is accepted and dropped, never stored or shown.
/** EVAL-011: the party that owned a failed case (the model's answer is never a failure). */
export const EVAL_CASE_PARTIES = ["provider", "platform", "judge"] as const;
export type EvalCaseParty = (typeof EVAL_CASE_PARTIES)[number];

export interface EvalFailedCaseDiagnostic {
  case_id: string;
  stage: EvalCaseFailureStage;
  error_code: EvalCaseErrorCode;
  cause_code: string | null;
  cause_name: string | null;
  model_call_id: string | null;
  latency_ms: number | null;
  /**
   * EVAL-011: whether the failed case is critical, as the runtime read it from the case.
   * Display detail only: a failed case is never scored, so the rule does not read it.
   */
  critical?: boolean;
  /**
   * EVAL-011: who owned the failure (`src/evals/case-attribution.ts`), written by the server at
   * upload from the code and the call ledger. An upload cannot set it. A diagnostic stored
   * without it falls back to the code-only attribution.
   */
  party?: EvalCaseParty;
  /**
   * SERVE-004 / DATA-001: why the upstream rejected this case's model request.
   * The server adds it from its own call rows (`withRejectionReasons`); an
   * upload cannot set it. It never changes how a failure is classified.
   */
  rejection?: RejectionReason;
}

/** EVAL-011: the cause code of a case whose model request the upstream rejected. */
export const REQUEST_REJECTED_CAUSE = "upstream_request_rejected";

/** True when the upstream rejected the model request of this failed case. */
export function isRejectedRequestCase(row: EvalFailedCaseDiagnostic): boolean {
  return row.stage === "model_call" && row.cause_code === REQUEST_REJECTED_CAUSE;
}

// DATA-001: a scorer runs customer code over the model output, so its exception
// can carry output text in any field. Only a built-in error class name is kept.
const BUILT_IN_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
]);

// DATA-001: the only case-error text BenchRouter stores. It is chosen by the
// structural outcome code, never copied from an upload.
export const EVAL_CASE_OUTCOME_ERROR = {
  output_empty: "output_empty: the model returned no content",
  output_cut_off: "output_cut_off: the model reached its output limit (finish_reason=length)"
} as const satisfies Record<EvalCaseOutcomeCode, string>;
export const EVAL_CASE_FAILED_ERROR = "The case reported a failure.";

/**
 * EVAL-011 / RUN-001: the causes of a case whose model call failed at its provider. Only the
 * model's answer is scored, so no row carries them any more: they name the cause of a
 * `provider_outage` run, and they label the case rows that #473 stored before migration 0142
 * ended those runs as unmeasured (the dashboard still reads them from a failed run).
 */
export const EVAL_PROVIDER_FAILURE_CODES = [
  "provider_timeout",
  "provider_rate_limited",
  "provider_rejected",
  "provider_unavailable",
  "provider_error"
] as const;
export type EvalProviderFailureCode = (typeof EVAL_PROVIDER_FAILURE_CODES)[number];
export type EvalStoredOutcomeCode = EvalCaseOutcomeCode | EvalProviderFailureCode;

export const EVAL_PROVIDER_FAILURE_TEXT = {
  provider_timeout: "timed out at provider",
  provider_rate_limited: "rate limited by provider",
  provider_rejected: "request rejected by provider",
  provider_unavailable: "model unavailable at provider",
  provider_error: "failed at provider"
} as const satisfies Record<EvalProviderFailureCode, string>;

export function isProviderFailureCode(code: string | null | undefined): code is EvalProviderFailureCode {
  return EVAL_PROVIDER_FAILURE_CODES.some((known) => known === code);
}

/** EVAL-011: the provider outcome code that names why one failed model call failed. */
export function providerFailureCode(failure: EvalFailedCaseDiagnostic): EvalProviderFailureCode {
  if (failure.error_code === "upstream_timeout" || failure.cause_code === "upstream_timeout") return "provider_timeout";
  if (failure.cause_code === "upstream_rate_limited" || failure.cause_code === "429") return "provider_rate_limited";
  if (failure.cause_code === "upstream_request_rejected") return "provider_rejected";
  if (failure.cause_code === "model_unavailable" || failure.cause_code === "target_temporarily_unroutable") return "provider_unavailable";
  return "provider_error";
}

export function storedCaseError(error: string | null | undefined, outcomeCode: EvalStoredOutcomeCode | null | undefined): string | null {
  if (outcomeCode && !isProviderFailureCode(outcomeCode)) return EVAL_CASE_OUTCOME_ERROR[outcomeCode];
  return error === undefined || error === null ? null : EVAL_CASE_FAILED_ERROR;
}

export interface EvalFailureCasesDiagnostic {
  planned: number;
  succeeded: EvalSucceededCaseDiagnostic[];
  failed: EvalFailedCaseDiagnostic[];
}

export interface EvalFailureVerification {
  missing_claimed_call_ids: string[];
  unclaimed_server_call_ids: string[];
}

export interface EvalExecutionFailureDiagnostic {
  phase: EvalExecutionFailurePhase;
  reason: EvalExecutionFailureReason;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
}

export const EVAL_RUN_RETRY_OUTCOMES = ["requeued", "exhausted"] as const;
export type EvalRunRetryOutcome = (typeof EVAL_RUN_RETRY_OUTCOMES)[number];

/**
 * EVAL-011: server-recorded disposition of a transient failure. `requeued`
 * means a new attempt of the same model was scheduled. `exhausted` means the
 * model used every attempt and the failure is now terminal.
 */
export interface EvalRunRetryDisposition {
  outcome: EvalRunRetryOutcome;
  attempt: number;
  max_attempts: number;
  cause: string;
}

export interface EvalRunFailureDiagnostic {
  v: 1;
  source: EvalRunFailureSource;
  reason_code: EvalRunFailureReasonCode;
  failed_step: string | null;
  github_conclusion: string | null;
  cases: EvalFailureCasesDiagnostic | null;
  execution?: EvalExecutionFailureDiagnostic;
  verification?: EvalFailureVerification;
  diagnostic_rejected?: true;
  retry?: EvalRunRetryDisposition;
  /**
   * RUN-001 / DATA-001: the signed runtime's own reason for a work failure that
   * has no case detail (for example a runtime version the job does not have).
   * Server-written only, from the runtime's fault text; never an exception message.
   */
  runtime_reason?: string;
  /**
   * EVAL-012: the amounts of a run stopped at its server-owned spend bound.
   * Server-written only, from the run row (`prepareModelRunFailure`).
   */
  spend_bound?: SpendBoundStop;
  /**
   * EVAL-011: the times of a retry chain stopped at its time bound.
   * Server-written only, from the run row (`prepareModelRunFailure`) or by the
   * boundary that ends the chain before a retry that would not fit.
   */
  time_bound?: TimeBoundStop;
  /**
   * EVAL-011: the provider failures of a `provider_outage` run: how many of its planned
   * cases failed at the provider, and the most common cause. Server-written only.
   */
  provider_outage?: ProviderOutageStop;
  /**
   * EVAL-011: the BenchRouter failures of a `platform_failure` run: how many of its planned
   * cases it could not answer, and the most common cause code. Server-written only.
   */
  platform_failure?: PlatformFailureStop;
  /**
   * EVAL-011: the model refused the route's request contract and the customer evaluator
   * stopped on that refusal. The model owns the failure, not the evaluator. Server-written
   * only, from the run's recorded refusal (`prepareModelRunFailure`).
   */
  model_refusal?: ModelRefusalStop;
}

/** The BenchRouter codes by which a model's targets refuse a route's request contract. */
export const MODEL_CONTRACT_REFUSAL_CODES = ["request_contract_unsupported", "control_unsupported"] as const;
export type ModelContractRefusalCode = (typeof MODEL_CONTRACT_REFUSAL_CODES)[number];

export function isModelContractRefusalCode(code: string | null): code is ModelContractRefusalCode {
  return MODEL_CONTRACT_REFUSAL_CODES.some((known) => known === code);
}

export interface ModelRefusalStop {
  cause: ModelContractRefusalCode;
}

/**
 * EVAL-011: the contract refusal that ended a run, from the stored stop or from failed cases that
 * all carry a contract refusal code. Null when the model did not refuse the contract.
 */
export function modelContractRefusal(diagnostic: EvalRunFailureDiagnostic): ModelContractRefusalCode | null {
  if (diagnostic.model_refusal) return diagnostic.model_refusal.cause;
  const failed = diagnostic.cases?.failed ?? [];
  const codes = failed.map(contractRefusalOfCase);
  return codes.length > 0 && codes.every((code) => code !== null) ? codes[0] ?? null : null;
}

/** The contract refusal code a failed model-call case carries, or null. */
export function contractRefusalOfCase(row: EvalFailedCaseDiagnostic): ModelContractRefusalCode | null {
  return row.stage === "model_call" && isModelContractRefusalCode(row.cause_code) ? row.cause_code : null;
}

/**
 * EVAL-011 / EVAL-012: the failed step of an executable run that ended unmeasured because
 * BenchRouter refused its model request and the customer evaluator stopped on that refusal
 * (`refusalExplainedStop`, src/runner/fail-diagnostic.ts). Server-written only.
 */
export const REQUEST_REFUSED_FAILED_STEP = "request_refused";

export interface PlatformFailureStop {
  failed: number;
  planned: number;
  cause: string;
}

export interface ProviderOutageStop {
  failed: number;
  planned: number;
  cause: EvalProviderFailureCode;
}

export type ParseFailureDiagnosticResult =
  | { ok: true; value: EvalRunFailureDiagnostic }
  | { ok: false; message: string };

const MAX_CASES = 256;
/**
 * A run can plan more cases than a diagnostic lists (case-batch leasing): `planned`
 * is the run's case count, and the two case lists stay bounded by `MAX_CASES`.
 */
const MAX_PLANNED_CASES = 5000;
const MAX_CALL_IDS_PER_CASE = 16;
const MAX_ID = 200;
const MAX_MESSAGE = 500;
const MAX_SMALL = 64;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

export function parseEvalRunFailureDiagnostic<Value>(value: Value): ParseFailureDiagnosticResult {
  return parseDiagnostic(value, false);
}

export function parseStoredEvalRunFailureDiagnostic(json: string | null): EvalRunFailureDiagnostic | null {
  if (!json) return null;
  const parsedJson = parseJsonValueFromString(json);
  if (!parsedJson.ok) return null;
  const parsed = parseDiagnostic(parsedJson.value, true);
  return parsed.ok ? parsed.value : null;
}

/**
 * RUN-001 / DATA-001: the runtime's fault reason, bounded like a case message
 * (500 characters) and on one line. The runtime quotes free-form evaluator and
 * scorer text with JSON.stringify (an invalid metric name, a refused call
 * endpoint), so a reason with a double quote is dropped whole, as is one with
 * any control character. Its other interpolations are fixed codes, numbers,
 * identifiers the server already stores, and runtime versions.
 */
export function parseRuntimeFaultReason<Value>(value: Value): string | null {
  if (!text(value, MAX_MESSAGE, false) || value.includes('"')) return null;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  return value;
}

/**
 * EVAL-011: parse a retry disposition read on its own from stored failure JSON,
 * so the retry chain stays readable even when the rest of the diagnostic is not.
 */
export function parseStoredRetryDisposition(json: string | null): EvalRunRetryDisposition | null {
  if (!json) return null;
  const parsedJson = parseJsonValueFromString(json);
  if (!parsedJson.ok) return null;
  const parsed = parseRetryDisposition(parsedJson.value);
  return parsed.ok ? parsed.value : null;
}

export function fallbackFailureDiagnostic(input: {
  source: EvalRunFailureSource;
  reasonCode?: EvalRunFailureReasonCode;
  failedStep?: string | null;
  githubConclusion?: string | null;
  rejected?: boolean;
}): EvalRunFailureDiagnostic {
  const diagnostic: EvalRunFailureDiagnostic = {
    v: 1,
    source: input.source,
    reason_code: input.reasonCode ?? "workflow_step_failed",
    failed_step: input.failedStep ?? null,
    github_conclusion: input.githubConclusion ?? null,
    cases: null
  };
  if (input.rejected) {
    diagnostic.diagnostic_rejected = true;
  }
  return diagnostic;
}

export function withFailureVerification(
  diagnostic: EvalRunFailureDiagnostic,
  serverCallIds: readonly string[]
): EvalRunFailureDiagnostic {
  const claimed = new Set<string>();
  for (const row of diagnostic.cases?.succeeded ?? []) {
    for (const id of row.model_call_ids) claimed.add(id);
  }
  for (const row of diagnostic.cases?.failed ?? []) {
    if (row.model_call_id) claimed.add(row.model_call_id);
  }
  const server = new Set(serverCallIds);
  return {
    ...diagnostic,
    verification: {
      missing_claimed_call_ids: [...claimed].filter((id) => !server.has(id)).sort(),
      unclaimed_server_call_ids: [...server].filter((id) => !claimed.has(id)).sort()
    }
  };
}

/** The rejection columns of one server call row of a model run. */
export interface EvalCallRejectionRow {
  traffic_mode: string | null;
  settlement_state: string | null;
  rejection_kind: string | null;
  rejection_param: string | null;
}

/**
 * SERVE-004 / DATA-001: add the stored rejection reason to each failed case
 * whose model request the upstream rejected. A failed case does not name its
 * call, so the reason is added only when every rejected model call of the run
 * has the same reason. A run with two different reasons keeps none. A model
 * call that is still pending can settle with another reason after this read,
 * so a run with a pending model call keeps none either. This adds a label
 * only: no case is added, removed, or classified differently.
 */
export function withRejectionReasons(
  diagnostic: EvalRunFailureDiagnostic,
  serverCalls: readonly EvalCallRejectionRow[]
): EvalRunFailureDiagnostic {
  const cases = diagnostic.cases;
  if (!cases || !cases.failed.some(isRejectedRequestCase)) return diagnostic;
  const reasons = new Map<string, RejectionReason>();
  for (const call of serverCalls) {
    if (call.traffic_mode !== "eval_model") continue;
    if (call.settlement_state === null || call.settlement_state === "pending") return diagnostic;
    const reason = storedRejectionReason(call.rejection_kind, call.rejection_param);
    if (reason) reasons.set(`${reason.kind} ${reason.param ?? ""}`, reason);
  }
  const [reason] = [...reasons.values()];
  if (reasons.size !== 1 || !reason) return diagnostic;
  return {
    ...diagnostic,
    cases: { ...cases, failed: cases.failed.map((row) => (isRejectedRequestCase(row) ? { ...row, rejection: reason } : row)) }
  };
}

export function hasStructuredFailureCases(diagnostic: EvalRunFailureDiagnostic | null): boolean {
  return Boolean(diagnostic?.cases && (diagnostic.cases.succeeded.length > 0 || diagnostic.cases.failed.length > 0));
}

function parseDiagnostic<Value>(value: Value, stored: boolean): ParseFailureDiagnosticResult {
  if (!isRecord(value)) return invalid("Failure diagnostic must be an object");
  const allowed = new Set([
    "v", "source", "reason_code", "failed_step", "github_conclusion", "cases",
    "execution",
    ...(stored ? ["verification", "diagnostic_rejected", "retry", "runtime_reason", "spend_bound", "time_bound", "provider_outage", "platform_failure", "model_refusal"] : [])
  ]);
  const unknown = unknownKey(value, allowed);
  if (unknown) return invalid(`Failure diagnostic ${unknown} is not allowed`);
  if (value.v !== 1) return invalid("Failure diagnostic v must be 1");
  if (!member(EVAL_RUN_FAILURE_SOURCES, value.source)) return invalid("Failure diagnostic source is invalid");
  if (!member(EVAL_RUN_FAILURE_REASON_CODES, value.reason_code)) return invalid("Failure diagnostic reason_code is invalid");
  // An upload never reports an outage: the server decides it from the stored case results.
  if (!stored && (value.reason_code === "provider_outage" || value.reason_code === "platform_failure")) {
    return invalid("Failure diagnostic reason_code is invalid");
  }
  const failedStep = nullableText(value.failed_step, MAX_SMALL, true);
  if (!failedStep.ok) return invalid("Failure diagnostic failed_step is invalid");
  const conclusion = nullableText(value.github_conclusion, MAX_SMALL, true);
  if (!conclusion.ok) return invalid("Failure diagnostic github_conclusion is invalid");
  const cases = parseCases(value.cases, stored);
  if (!cases.ok) return cases;
  const execution = parseExecution(value.execution);
  if (!execution.ok) return execution;
  // RUN-001 §3.3.1: the server stores an evaluator exit before any model call as
  // `setup_failed` with its execution detail; an upload never carries that reason.
  const executionReason = value.reason_code === "workflow_step_failed" || (stored && value.reason_code === "setup_failed");
  if (
    execution.value &&
    (value.source !== "workflow_fail_step" || !executionReason || cases.value !== null)
  ) {
    return invalid("Failure diagnostic execution does not match a terminal evaluator failure");
  }
  const result: EvalRunFailureDiagnostic = {
    v: 1,
    source: value.source,
    reason_code: value.reason_code,
    failed_step: failedStep.value,
    github_conclusion: conclusion.value,
    cases: cases.value
  };
  if (execution.value) result.execution = execution.value;
  if (stored) {
    if (value.diagnostic_rejected !== undefined && value.diagnostic_rejected !== true) {
      return invalid("Failure diagnostic diagnostic_rejected must be true");
    }
    if (value.diagnostic_rejected === true) result.diagnostic_rejected = true;
    const verification = parseVerification(value.verification);
    if (!verification.ok) return verification;
    if (verification.value) result.verification = verification.value;
    const retry = parseRetryDisposition(value.retry);
    if (!retry.ok) return retry;
    if (retry.value) result.retry = retry.value;
    // A stored reason that is not valid text is dropped. It never makes the
    // diagnostic unreadable, so it cannot change a retry classification.
    const runtimeReason = parseRuntimeFaultReason(value.runtime_reason);
    if (runtimeReason !== null) result.runtime_reason = runtimeReason;
    // EVAL-012: display detail only; an unreadable one is dropped the same way.
    const spendBound = parseSpendBoundStop(value.spend_bound);
    if (spendBound !== null) result.spend_bound = spendBound;
    // EVAL-011: display detail only; an unreadable one is dropped the same way.
    const timeBound = parseTimeBoundStop(value.time_bound);
    if (timeBound !== null) result.time_bound = timeBound;
    const outage = parseProviderOutageStop(value.provider_outage);
    if (outage !== null) result.provider_outage = outage;
    const platform = parsePlatformFailureStop(value.platform_failure);
    if (platform !== null) result.platform_failure = platform;
    if (isRecord(value.model_refusal) && isJsonString(value.model_refusal.cause) && isModelContractRefusalCode(value.model_refusal.cause)) {
      result.model_refusal = { cause: value.model_refusal.cause };
    }
  }
  return { ok: true, value: result };
}

/** EVAL-011: a stored provider outage, or null when it is absent or unreadable (display detail only). */
function parseProviderOutageStop<Value>(value: Value): ProviderOutageStop | null {
  if (!isRecord(value) || unknownKey(value, new Set(["failed", "planned", "cause"]))) return null;
  if (!isJsonFiniteNumber(value.failed) || !isJsonFiniteNumber(value.planned) || value.failed < 0 || value.planned < value.failed) return null;
  if (!isJsonString(value.cause) || !isProviderFailureCode(value.cause)) return null;
  return { failed: Number(value.failed), planned: Number(value.planned), cause: value.cause };
}

/** EVAL-011: a stored platform failure, or null when it is absent or unreadable (display detail only). */
function parsePlatformFailureStop<Value>(value: Value): PlatformFailureStop | null {
  if (!isRecord(value) || unknownKey(value, new Set(["failed", "planned", "cause"]))) return null;
  if (!isJsonFiniteNumber(value.failed) || !isJsonFiniteNumber(value.planned) || value.failed < 0 || value.planned < value.failed) return null;
  if (!isJsonString(value.cause) || !SAFE_CODE.test(value.cause)) return null;
  return { failed: Number(value.failed), planned: Number(value.planned), cause: value.cause };
}

/** EVAL-011: a stored time-bound stop, or null when it is absent or unreadable. */
export function parseTimeBoundStop<Value>(value: Value): TimeBoundStop | null {
  if (!isRecord(value) || unknownKey(value, new Set(["used_s", "bound_s", "reference_s", "next_wait_s"]))) return null;
  const times = [value.used_s, value.bound_s, value.reference_s];
  if (!times.every((time) => isJsonFiniteNumber(time) && time >= 0)) return null;
  const stop: TimeBoundStop = { used_s: Number(value.used_s), bound_s: Number(value.bound_s), reference_s: Number(value.reference_s) };
  if (value.next_wait_s !== undefined) {
    if (!isJsonFiniteNumber(value.next_wait_s) || value.next_wait_s < 0) return null;
    stop.next_wait_s = Number(value.next_wait_s);
  }
  return stop;
}

function parseSpendBoundStop<Value>(value: Value): SpendBoundStop | null {
  if (!isRecord(value) || unknownKey(value, new Set(["spent_usd", "bound_usd", "reference_usd"]))) return null;
  const amounts = [value.spent_usd, value.bound_usd, value.reference_usd];
  if (!amounts.every((amount) => isJsonFiniteNumber(amount) && amount >= 0)) return null;
  return { spent_usd: Number(value.spent_usd), bound_usd: Number(value.bound_usd), reference_usd: Number(value.reference_usd) };
}

function parseExecution<Value>(
  value: Value
): { ok: true; value: EvalExecutionFailureDiagnostic | null } | FailureDiagnosticInvalid {
  if (value === undefined) return { ok: true, value: null };
  if (!isRecord(value) || unknownKey(value, new Set(["phase", "reason", "exit_code", "signal", "timed_out"]))) {
    return invalid("Failure diagnostic execution is invalid");
  }
  if (!member(EVAL_EXECUTION_FAILURE_PHASES, value.phase)) {
    return invalid("Failure diagnostic execution phase is invalid");
  }
  if (!member(EVAL_EXECUTION_FAILURE_REASONS, value.reason)) {
    return invalid("Failure diagnostic execution reason is invalid");
  }
  const exitCode = value.exit_code;
  if (
    exitCode !== null &&
    (!isJsonFiniteNumber(exitCode) || !Number.isInteger(exitCode) || exitCode < 1 || exitCode > 2_147_483_647)
  ) {
    return invalid("Failure diagnostic execution exit_code is invalid");
  }
  const signal = nullableText(value.signal, MAX_SMALL, true);
  if (!signal.ok || (value.timed_out !== true && value.timed_out !== false)) {
    return invalid("Failure diagnostic execution outcome is invalid");
  }
  if (
    (value.reason === "process_start_failed" && (exitCode !== null || signal.value !== null || value.timed_out)) ||
    (value.reason === "process_exit" && (exitCode === null || signal.value !== null || value.timed_out)) ||
    (value.reason === "process_signal" && (exitCode !== null || signal.value === null || value.timed_out)) ||
    (value.reason === "process_timeout" && (exitCode !== null || !value.timed_out))
  ) {
    return invalid("Failure diagnostic execution fields do not match its reason");
  }
  return {
    ok: true,
    value: {
      phase: value.phase,
      reason: value.reason,
      exit_code: exitCode,
      signal: signal.value,
      timed_out: value.timed_out
    }
  };
}

function parseCases<Value>(
  value: Value,
  stored: boolean
): { ok: true; value: EvalFailureCasesDiagnostic | null } | FailureDiagnosticInvalid {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return invalid("Failure diagnostic cases must be an object or null");
  const unknown = unknownKey(value, new Set(["planned", "succeeded", "failed"]));
  if (unknown) return invalid(`Failure diagnostic cases.${unknown} is not allowed`);
  if (
    !isJsonFiniteNumber(value.planned) ||
    !Number.isInteger(value.planned) ||
    value.planned < 0 ||
    value.planned > MAX_PLANNED_CASES
  ) {
    return invalid("Failure diagnostic cases.planned is invalid");
  }
  if (!Array.isArray(value.succeeded) || !Array.isArray(value.failed)) {
    return invalid("Failure diagnostic succeeded and failed must be arrays");
  }
  if (value.succeeded.length > MAX_CASES || value.failed.length > MAX_CASES || value.succeeded.length + value.failed.length > value.planned) {
    return invalid("Failure diagnostic case arrays exceed planned cases");
  }
  const succeeded: EvalSucceededCaseDiagnostic[] = [];
  const failed: EvalFailedCaseDiagnostic[] = [];
  const caseIds = new Set<string>();
  const callIds = new Set<string>();
  for (const item of value.succeeded) {
    const parsed = parseSucceeded(item);
    if (!parsed.ok) return parsed;
    if (caseIds.has(parsed.value.case_id)) return invalid("Failure diagnostic case ids must be unique");
    caseIds.add(parsed.value.case_id);
    for (const id of parsed.value.model_call_ids) {
      if (callIds.has(id)) return invalid("Failure diagnostic claimed call ids must be unique");
      callIds.add(id);
    }
    succeeded.push(parsed.value);
  }
  for (const item of value.failed) {
    const parsed = parseFailed(item, stored);
    if (!parsed.ok) return parsed;
    if (caseIds.has(parsed.value.case_id)) return invalid("Failure diagnostic case ids must be unique");
    caseIds.add(parsed.value.case_id);
    if (parsed.value.model_call_id) {
      if (callIds.has(parsed.value.model_call_id)) return invalid("Failure diagnostic claimed call ids must be unique");
      callIds.add(parsed.value.model_call_id);
    }
    failed.push(parsed.value);
  }
  return { ok: true, value: { planned: value.planned, succeeded, failed } };
}

/** RUN-001: the opaque 200-character case domain, without control characters. */
function caseIdentity<Value>(value: Value): value is Value & string {
  return text(value, MAX_ID, false) && !/[\t\n\r]/.test(value);
}

function parseSucceeded<Value>(value: Value): { ok: true; value: EvalSucceededCaseDiagnostic } | FailureDiagnosticInvalid {
  if (!isRecord(value) || unknownKey(value, new Set(["case_id", "model_call_ids"]))) {
    return invalid("Failure diagnostic succeeded case shape is invalid");
  }
  // EVAL-011 / RUN-001: case IDs are opaque bounded identities, not error codes.
  // The native repeat loader adds #repeat-2/3 to the authored identity.
  const caseId = value.case_id;
  if (!caseIdentity(caseId)) return invalid("Failure diagnostic succeeded case_id is invalid");
  if (!Array.isArray(value.model_call_ids) || value.model_call_ids.length === 0 || value.model_call_ids.length > MAX_CALL_IDS_PER_CASE) {
    return invalid("Failure diagnostic succeeded model_call_ids are invalid");
  }
  const modelCallIds: string[] = [];
  for (const id of value.model_call_ids) {
    if (!text(id, MAX_ID, true)) return invalid("Failure diagnostic succeeded model_call_ids are invalid");
    modelCallIds.push(id);
  }
  if (new Set(modelCallIds).size !== modelCallIds.length) return invalid("Failure diagnostic succeeded model_call_ids are invalid");
  return { ok: true, value: { case_id: caseId, model_call_ids: modelCallIds } };
}

/**
 * EVAL-011: a failed case read back from `runner_case_results.failure_json`, which holds the
 * server's own copy of the uploaded diagnostic plus its `party`. Null when it does not parse.
 */
export function parseStoredFailedCase<Value>(value: Value): EvalFailedCaseDiagnostic | null {
  const parsed = parseFailed(value, true);
  return parsed.ok ? parsed.value : null;
}

function parseFailed<Value>(
  value: Value,
  stored: boolean
): { ok: true; value: EvalFailedCaseDiagnostic } | FailureDiagnosticInvalid {
  if (!isRecord(value)) return invalid("Failure diagnostic failed case must be an object");
  const unknown = unknownKey(value, new Set([
    "case_id", "stage", "error_code", "cause_code", "cause_name", "message", "model_call_id", "latency_ms", "critical",
    // Server-written only: an upload that carries it is refused as an unknown key.
    ...(stored ? ["rejection", "party"] : [])
  ]));
  if (unknown) return invalid(`Failure diagnostic failed case ${unknown} is not allowed`);
  // EVAL-011 / RUN-001: case IDs are opaque bounded identities, not error codes.
  // The native repeat loader adds #repeat-2/3 to the authored identity.
  const caseId = value.case_id;
  if (!caseIdentity(caseId)) return invalid("Failure diagnostic failed case_id is invalid");
  const stage = value.stage;
  if (!member(EVAL_CASE_FAILURE_STAGES, stage)) return invalid("Failure diagnostic failed stage is invalid");
  const errorCode = value.error_code;
  if (!member(EVAL_CASE_ERROR_CODES, errorCode)) return invalid("Failure diagnostic failed error_code is invalid");
  const causeCode = nullableText(value.cause_code, MAX_SMALL, true);
  const causeName = nullableText(value.cause_name, MAX_SMALL, true);
  if (!causeCode.ok || !causeName.ok) return invalid("Failure diagnostic cause is invalid");
  const message = value.message;
  if (message !== undefined && !text(message, MAX_MESSAGE, false)) return invalid("Failure diagnostic message is invalid");
  const scorerStage = stage === "scorer";
  const modelCallId = value.model_call_id;
  if (modelCallId !== null && !text(modelCallId, MAX_ID, true)) return invalid("Failure diagnostic model_call_id is invalid");
  const latencyMs = value.latency_ms;
  if (
    latencyMs !== null &&
    (!isJsonFiniteNumber(latencyMs) || !Number.isInteger(latencyMs) || latencyMs < 0)
  ) {
    return invalid("Failure diagnostic latency_ms is invalid");
  }
  const critical = value.critical;
  if (critical !== undefined && !isJsonBoolean(critical)) return invalid("Failure diagnostic critical is invalid");
  const failed: EvalFailedCaseDiagnostic = {
    case_id: caseId,
    stage,
    error_code: errorCode,
    cause_code: scorerStage ? null : causeCode.value,
    cause_name: scorerStage && (causeName.value === null || !BUILT_IN_ERROR_CLASSES.has(causeName.value))
      ? null
      : causeName.value,
    model_call_id: modelCallId,
    latency_ms: latencyMs
  };
  if (critical !== undefined) failed.critical = critical;
  // A stored reason outside the vocabulary is dropped. It never makes the
  // diagnostic unreadable, so it cannot change a retry classification.
  const rejection = stored ? parseStoredRejectionReason(value.rejection) : null;
  if (rejection) failed.rejection = rejection;
  // Server-written only. An unknown stored value is dropped, never an unreadable diagnostic.
  const party = stored ? EVAL_CASE_PARTIES.find((known) => known === value.party) : undefined;
  if (party !== undefined) failed.party = party;
  return { ok: true, value: failed };
}

function parseVerification<Value>(value: Value): { ok: true; value: EvalFailureVerification | null } | FailureDiagnosticInvalid {
  if (value === undefined) return { ok: true, value: null };
  if (!isRecord(value) || unknownKey(value, new Set(["missing_claimed_call_ids", "unclaimed_server_call_ids"]))) {
    return invalid("Failure diagnostic verification is invalid");
  }
  const missingClaimedCallIds = parseCallIds(value.missing_claimed_call_ids);
  const unclaimedServerCallIds = parseCallIds(value.unclaimed_server_call_ids);
  if (!missingClaimedCallIds || !unclaimedServerCallIds ||
      missingClaimedCallIds.length > MAX_CASES * MAX_CALL_IDS_PER_CASE ||
      unclaimedServerCallIds.length > MAX_CASES * MAX_CALL_IDS_PER_CASE) {
    return invalid("Failure diagnostic verification ids are invalid");
  }
  return { ok: true, value: { missing_claimed_call_ids: missingClaimedCallIds, unclaimed_server_call_ids: unclaimedServerCallIds } };
}

function parseRetryDisposition<Value>(
  value: Value
): { ok: true; value: EvalRunRetryDisposition | null } | FailureDiagnosticInvalid {
  if (value === undefined) return { ok: true, value: null };
  if (!isRecord(value) || unknownKey(value, new Set(["outcome", "attempt", "max_attempts", "cause"]))) {
    return invalid("Failure diagnostic retry is invalid");
  }
  const { outcome, attempt, max_attempts: maxAttempts, cause } = value;
  if (
    !member(EVAL_RUN_RETRY_OUTCOMES, outcome) ||
    !isJsonFiniteNumber(attempt) || !Number.isInteger(attempt) || attempt < 1 ||
    !isJsonFiniteNumber(maxAttempts) || !Number.isInteger(maxAttempts) || maxAttempts < attempt ||
    !text(cause, MAX_SMALL, true)
  ) {
    return invalid("Failure diagnostic retry is invalid");
  }
  return { ok: true, value: { outcome, attempt, max_attempts: maxAttempts, cause } };
}

function parseCallIds<Value>(value: Value): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (!text(id, MAX_ID, true)) return null;
    ids.push(id);
  }
  return ids;
}

function nullableText<Value>(value: Value, max: number, safeCode: boolean): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  return text(value, max, safeCode) ? { ok: true, value } : { ok: false };
}

function text<Value>(value: Value, max: number, safeCode: boolean): value is Extract<Value, string> {
  return isJsonString(value) && value.length > 0 && value.length <= max && !hasControlCharacter(value) && (!safeCode || SAFE_CODE.test(value));
}

function invalid(message: string): FailureDiagnosticInvalid {
  return { ok: false, message };
}

interface FailureDiagnosticInvalid {
  ok: false;
  message: string;
}

function member<T extends string>(values: readonly T[], value: JsonValue): value is T {
  return isJsonString(value) && values.some((item) => item === value);
}

function unknownKey(value: JsonObject, allowed: Set<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}
