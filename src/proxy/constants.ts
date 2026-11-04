export const UPSTREAM_ABORT_CEILING_MS = 90_000;

// ── SERVE-009 OpenAI Responses ──────────────────────────────────────────────

/** Largest `input` item array one Responses create request may carry. */
export const MAX_RESPONSES_INPUT_ITEMS = 1024;

/**
 * The SINGLE dependency gate for `POST /v1/responses`. It is compiled on after
 * the current live fixtures, capability head, SDK proof, and settlement path
 * landed. Target-level evidence still fails closed independently.
 */
export const RESPONSES_ENABLED = true;
/** Added to the request timeout when scheduling delayed settlement recovery. */
export const SETTLEMENT_RECOVERY_GRACE_MS = 30_000;
/**
 * BILL-001: the recovery deadline a request gets when it is created, before any
 * attempt is planned. Scheduling the plan's recovery replaces it. It only takes
 * effect when the request path ends before it finalizes the request or
 * schedules recovery (a failed D1 write or a thrown error), so the settlement
 * sweep still reaches that request. Admission never takes this long.
 */
export const ADMISSION_RECOVERY_BACKSTOP_SECONDS = 10 * 60;

// ── SERVE-007 stream transport bounds ───────────────────────────────────────
// Every limit below is measured in DECODED bytes, never in network chunks. A
// network chunk is never one SSE event, so no bound may make a valid event
// depend on where the upstream happened to split its writes.

/** Largest single decoded SSE line the decoder will accept. */
export const MAX_SSE_LINE_BYTES = 1_048_576;
/** Largest single decoded SSE event (all its `data:` lines joined). */
export const MAX_SSE_EVENT_BYTES = 1_048_576;
/**
 * Complete decoded events held between downstream pulls. Two is the minimum a
 * usage lookbehind needs (one held event plus the one that proves it
 * nonterminal); a larger FIFO would be a background pump in disguise.
 */
export const MAX_PENDING_SSE_EVENTS = 2;
/**
 * Total decoded bytes the transport may hold at once: the FIFO, the retained
 * read cursor, the readiness frame, the usage lookbehind, and the terminal hold
 * all count against this.
 */
export const MAX_STREAM_BUFFER_BYTES = 2_097_152;

/**
 * Wall clock for the WHOLE frozen plan before the public attempt is committed.
 * Sequential fallback must never multiply caller latency by plan length, so each
 * attempt gets only the time still remaining, capped further by the target
 * contract's own `readiness_ceiling_ms`.
 */
export const STREAM_PRECOMMIT_CEILING_MS = 90_000;
// SERVE-004: leave time for another compatible target inside the request ceiling.
// This is BenchRouter's per-attempt limit, not a provider capability certificate.
export const STREAM_TARGET_READINESS_CEILING_MS = 30_000;
/** Never open a new upstream connection with less than this left in the ceiling. */
export const MIN_ATTEMPT_BUDGET_MS = 2_000;

// ── SERVE-010 Databricks caller deadline ────────────────────────────────────

/**
 * The headers that mark a Databricks call to an external model; either one counts,
 * with any value. Recorded live:
 * - `x-databricks-endpoints-api-client: Databricks External Model`, sent by the
 *   legacy external-model serving endpoint (2026-10-24, again 2026-10-27).
 * - `x-databricks-backbone-destination-host: <our host>`, sent by a Unity AI
 *   Gateway custom provider service, which does not send the first header
 *   (2026-10-27, buffered and streaming calls).
 * They are a client signature, not authentication: a caller that sends one only
 * shortens its own upstream time.
 */
export const DATABRICKS_CALLER_HEADERS: readonly string[] = [
  "x-databricks-endpoints-api-client",
  "x-databricks-backbone-destination-host"
];
/**
 * SERVE-010: Databricks abandons a call that has no response after about 120 s
 * and sends it again, so a slower BenchRouter call is billed twice. Requests that
 * carry a Databricks caller header stop all upstream work this long after ingress; the
 * 10 s left before the re-send are for settlement and the answer.
 */
export const DATABRICKS_CALLER_DEADLINE_MS = 110_000;
/**
 * Post-commit idle ceiling: no upstream byte for this long ends the stream. It
 * counts ONLY while an upstream read is pending, and is suspended while
 * downstream backpressure, D1 persistence, or terminal settlement prevents
 * another read. An SSE comment or a Messages ping resets it even when it is not
 * forwarded.
 */
export const STREAM_IDLE_CEILING_MS = 60_000;
/** Absolute ceiling from the committed attempt's upstream fetch. */
export const STREAM_ABSOLUTE_CEILING_MS = 600_000;
/**
 * Settlement latency SLO. This is an ALERT threshold ONLY — never a cancellation
 * deadline, because a D1 mutation is not cancellable and abandoning it would
 * leave an unresolvable billing state.
 */
export const SETTLEMENT_ALERT_MS = 2_000;

/**
 * Compile-time launch state for the runtime stream transport. It is on only for
 * protocol families whose code readiness and target-level live contracts both
 * fail closed.
 */
export const STREAMING_LAUNCH_ENABLED = true;
