import { RUNNER_SETTLING_CALL_CODES } from "./runner-protocol";

// EVAL-010 / EVAL-011: classify a model-call cause before its public error or display
// summary discards the detail. Only known availability and BenchRouter faults waive a count.
export type EvalCallCause = "timeout" | "rate_limit" | "availability" | "platform" | "provider_response" | "unknown";

// SERVE-004 also uses these exact groups to classify a stream failure before settlement.
export const STREAM_TIMEOUT_CAUSES: ReadonlySet<string> = new Set(["stream_readiness_deadline_exhausted", "stream_idle_ceiling"]);
export const STREAM_ADAPTER_CAUSES: ReadonlySet<string> = new Set([
  "responses_stream_synthesis_unproven", "responses_stream_unsupported_event",
  "responses_stream_unsupported_output_item", "responses_stream_unsupported_content_part",
  "responses_unsupported_output_item", "responses_stream_responses_unsupported_output_item"
]);
export const STREAM_LOCAL_CAUSES: ReadonlySet<string> = new Set([
  "stream_absolute_ceiling", "stream_buffer_exhausted", "sse_buffer_exhausted",
  "sse_line_too_large", "sse_event_too_large", "settlement_unavailable", "stream_delivery_not_persisted", "stream_completion_not_persisted",
  "chat_stream_identity_unapproved", "messages_stream_identity_unapproved",
  "responses_stream_identity_unapproved", "responses_stream_responses_identity_unapproved"
]);

const causes = new Map<string, EvalCallCause>();
function add(kind: EvalCallCause, codes: readonly string[]): void {
  for (const code of codes) causes.set(code, kind);
}

add("timeout", ["upstream_timeout", "408", ...STREAM_TIMEOUT_CAUSES]);
add("rate_limit", ["upstream_rate_limited", "429"]);
add("availability", ["upstream_server_error", "fetch_error", "stream_read_failed", "overloaded",
  "provider_cooldown", "provider_temporarily_unavailable", "providers_exhausted"]);
// The raw proxy and the runner both use an exact decimal status when no more specific error was available.
for (let status = 500; status < 600; status++) causes.set(String(status), "availability");
add("platform", [
  ...STREAM_LOCAL_CAUSES, ...STREAM_ADAPTER_CAUSES, "responses_identity_unapproved",
  "responses_stream_too_many_open_items",
  "extra_trial_stop_unavailable", "repository_eval_budget_unavailable", "idempotency_in_progress",
  "stream_execution_context_required", "stream_contract_unavailable", "protocol_adapter_unsupported", "missing_openrouter_key", "missing_db", "idempotency_store_unavailable", "idempotency_record_failed",
  "eval_breaker_open", "call_response_expired", "internal_error", "routing_contract_unavailable",
  "upstream_credentials_rejected", "upstream_quota_exceeded", "target_temporarily_unroutable", "no_target",
  "internal", "budget_exhausted", ...RUNNER_SETTLING_CALL_CODES, "refusal_unrecorded", "transport_fetch_failed",
  "401", "402", "403"
]);
add("provider_response", [
  "upstream_response_failed", "upstream_stream_error", "upstream_canceled", "upstream_malformed", "malformed_upstream_response", "malformed_response",
  "upstream_refused", "upstream_request_rejected", "model_unavailable", "responses_missing_id", "responses_stateful_response",
  "responses_background_response", "responses_unsupported_status", "stream_body_missing", "stream_content_type_invalid",
  "stream_closed_before_start", "stream_premature_eof", "stream_readiness_failed", "sse_invalid_utf8", "sse_event_name_nul"
]);

export function isBareCallStatus(code: string): boolean {
  const status = Number(code);
  return Number.isInteger(status) && String(status) === code && status >= 400 && status < 600;
}

export function classifyEvalCallCause(code: string | null): EvalCallCause {
  if (code === null) return "unknown";
  const kind = causes.get(code);
  if (kind !== undefined) return kind;
  if (isBareCallStatus(code)) return "provider_response";
  // The proxy's protocol parsers emit names in these namespaces. Their local limits,
  // unsupported features and identity approvals were classified explicitly above.
  if (code.startsWith("chat_stream_") || code.startsWith("messages_stream_") ||
      code.startsWith("responses_stream_") || code.startsWith("responses_bad_") || code === "responses_status_error_conflict") return "provider_response";
  return "unknown";
}

export function isUncountedEvalCallCause(cause: EvalCallCause): boolean {
  return cause === "availability" || cause === "timeout" || cause === "rate_limit" || cause === "platform";
}

export function isProviderEvalCallCause(cause: EvalCallCause): boolean {
  return cause !== "platform" && cause !== "unknown";
}

/** The model-time clock requires more evidence than the attempt-count waiver for a
 * bare refusal. Only the known gateway statuses charged model time before attribution.
 */
export function refusalUsesModelTime(code: string | null): boolean {
  return code !== null && refusalModelTimeCauses.has(code);
}

const refusalModelTimeCauses: ReadonlySet<string> = new Set([
  "upstream_rate_limited", "upstream_timeout", "upstream_server_error", "upstream_response_failed",
  "upstream_malformed", "malformed_upstream_response", "upstream_refused", "upstream_canceled",
  "fetch_error", "overloaded", "provider_cooldown", "provider_temporarily_unavailable", "providers_exhausted",
  "408", "429", "502", "503", "504", "529", ...STREAM_TIMEOUT_CAUSES, "stream_read_failed"
]);

/** A runner transport error describes the runner's own connection. An upstream HTTP error
 * carries the server's precise cause. A platform cause can also explain an executor deadline.
 */
export function evalCaseCallCode(error: string, cause: string | null): string {
  if (error === "transport_fetch_failed") return error;
  return cause ?? error;
}

/** A live, failed target attempt keeps the specific cause even under a misleading HTTP status. */
export function targetFailureCode(code: string | null, status: number | null): string | null {
  return code ?? (status !== null && status >= 400 && status < 600 ? String(status) : null);
}

// All strings in this SQL fragment are compile-time constants or canonical decimal HTTP statuses.
export const UNCOUNTED_CALL_CAUSES_SQL = [...causes.entries()]
  .filter(([, cause]) => isUncountedEvalCallCause(cause)).map(([code]) => `'${code}'`).join(", ");
