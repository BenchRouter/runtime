// RUN-001: the typed contract of BenchRouter runner protocol v1 (`/v1/runner/*`).
//
// The server endpoints, the signed runtime, the customer bootstrap and the release
// signer all build against this module. Section numbers (§) cite the GHA contract v1
// design (r3.1, 2026-09-30) and its decisions table (§7.3). POLICY.md RUN-001 is the
// canonical rule; the design is supporting evidence.
//
// The module holds types, constants and the fail-closed parsers for the protocol
// major, the work mode and capability names (principle 5: fail closed on the unknown).
// It holds no other runtime logic.

import type { JsonObject, JsonValue } from "./json-parse-contracts";

// ---------------------------------------------------------------------------
// Protocol major and endpoints
// ---------------------------------------------------------------------------

/**
 * §2.2, §7.2 decision 7: the protocol major. `trust.json`, the signed release
 * manifest and hello all carry it. A different major is a customer refresh, never a
 * negotiation: every receiver refuses a major it does not know.
 */
export const RUNNER_PROTOCOL_MAJOR = 1;
export type RunnerProtocolMajor = typeof RUNNER_PROTOCOL_MAJOR;

/** Fail closed (principle 5): only the exact integer major this build knows is accepted. */
export function isRunnerProtocolMajor(value: JsonValue): value is RunnerProtocolMajor {
  return value === RUNNER_PROTOCOL_MAJOR;
}

/**
 * §3: every endpoint. Hello authenticates with Actions OIDC alone (§3.1). Every other
 * call sends `session_id` in the body and the hello `session_credential` as
 * `Authorization: Bearer <credential>`. `release_status` needs no credential (§6.2 R4).
 */
export const RUNNER_ENDPOINTS = {
  hello: "/v1/runner/hello",
  snapshot: "/v1/runner/snapshot",
  ready: "/v1/runner/ready",
  claim: "/v1/runner/claim",
  heartbeat: "/v1/runner/heartbeat",
  upload: "/v1/runner/upload",
  fail: "/v1/runner/fail",
  receipt: "/v1/runner/receipt",
  release_status: "/v1/runner/release-status"
} as const;

/** §3: the header that carries a mutating call's idempotency key. */
export const RUNNER_IDEMPOTENCY_HEADER = "Idempotency-Key";

// ---------------------------------------------------------------------------
// Clocks and limits (§3.3.4, §7.3 decision 10)
// ---------------------------------------------------------------------------

/**
 * §3.3.4: the four clocks. `session_liveness` and `lease` are fixed TTLs renewed by
 * heartbeat. `work_deadline` and `job_retirement` are absolute timestamps that are
 * never renewed. `prepare_deadline` bounds the preparing state only.
 */
export const RUNNER_CLOCKS = ["session_liveness", "lease", "work_deadline", "job_retirement", "prepare_deadline"] as const;
export type RunnerClock = (typeof RUNNER_CLOCKS)[number];

/** §3.3.4 clock 1: session liveness. Any heartbeat or claim renews it while `preparing` or `live`. */
export const RUNNER_SESSION_LIVENESS_S = 90;
/**
 * §3.3.4 clock 2: lease TTL per `(work_id, lease_gen)`. Only a heartbeat for that
 * exact, still-unexpired generation renews it. An expired generation is dead for good.
 */
export const RUNNER_LEASE_TTL_S = 90;
/** §3.3: the runtime heartbeats every 30 s while preparing and while it holds leases. */
export const RUNNER_HEARTBEAT_INTERVAL_S = 30;
/** §3.3.4: the runtime treats a lease as expired at last acknowledged heartbeat + TTL − 15 s. */
export const RUNNER_LOCAL_EXPIRY_MARGIN_S = 15;
/** §3.3.4: the preparation deadline, 20 min after hello. Covers fetch, snapshot and install. */
export const RUNNER_PREPARE_DEADLINE_S = 20 * 60;

/** §7.3 decision 10: `timeout-minutes` of the one workflow job, for every repo. */
export const RUNNER_JOB_CEILING_MIN = 120;
/** §3.3.4: setup allowance (checkout, setup-node, customer setup) before hello. */
export const RUNNER_SETUP_ALLOWANCE_S = 20 * 60;
/**
 * §3.3.4 clock 4: the upload reserve. `retire_at` = authoritative GitHub job start
 * (§6.2 R3) + job ceiling − this reserve. There is no estimate: with no authoritative
 * start, the session gets snapshot admission only.
 */
export const RUNNER_UPLOAD_RESERVE_S = 10 * 60;
/**
 * §7.3 decision 10: the executable work cap, ceiling − setup allowance − upload
 * reserve = 90 min. Planning refuses executable work with a longer timeout.
 */
export const RUNNER_EXECUTABLE_WORK_CAP_S = RUNNER_JOB_CEILING_MIN * 60 - RUNNER_SETUP_ALLOWANCE_S - RUNNER_UPLOAD_RESERVE_S;
/** §3.3.4: the bootstrap watchdog kills the runtime at `retire_at` + 5 min. */
export const RUNNER_RETIRE_WATCHDOG_GRACE_S = 5 * 60;
/** §3.3.5: SIGTERM to a child process group, then SIGKILL after 5 s. */
export const RUNNER_CHILD_KILL_GRACE_S = 5;
/** §3.4, §7.1: server ceiling on how long an idle runtime waits for near-term work. */
export const RUNNER_IDLE_EXIT_MAX_S = 60;
/** §3.4, §7.1: in-process replay slots of one replay session (W = 1 per pool). */
export const RUNNER_REPLAY_SLOTS = 4;
/** §3.3.1: session credentials stay valid for receipt reads until `retire_at` + 1 h. */
export const RUNNER_RECEIPT_READ_GRACE_S = 60 * 60;
/** §3.3.2, §7.3 decision 9, DATA-001: a stored model response lives at most 24 h. */
export const RUNNER_CALL_RESPONSE_RETENTION_MAX_S = 24 * 60 * 60;
/** §2.2, §7.3 decision 5: a signed release manifest expires 180 days after signing. */
export const RUNTIME_MANIFEST_NOT_AFTER_DAYS = 180;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** `sha256:` + 64 lowercase hex. Every digest in the protocol uses this form. */
export type Sha256Digest = `sha256:${string}`;
/** ISO-8601 UTC timestamp, for example `2026-09-30T12:00:00.000Z`. */
export type RunnerTimestamp = string;
/** A 40-hex Git commit SHA. */
export type GitSha = string;

// ---------------------------------------------------------------------------
// Modes and capabilities (§2.2, §3.3.5)
// ---------------------------------------------------------------------------

/**
 * §3.3.5: the work modes, named as in the committed route manifest
 * (`eval_pack.mode`). An unknown mode never falls back to replay: the runtime
 * returns `blocked`, and the server never issues it.
 */
export const RUNNER_WORK_MODES = ["isolated_replay", "repository_executable"] as const;
export type RunnerWorkMode = (typeof RUNNER_WORK_MODES)[number];

/** Fail closed: an unknown or non-string mode parses to null, which the caller turns into `blocked`. */
export function parseRunnerWorkMode(value: JsonValue): RunnerWorkMode | null {
  return RUNNER_WORK_MODES.find((mode) => mode === value) ?? null;
}

/**
 * §2.2 feature capabilities. Their source is the signed release manifest. The
 * server issues work that needs a feature only to a runtime that advertised it at
 * hello. A new feature needs no customer refresh, but the server must know its name
 * before any release advertises it: an unknown advertised name is a protocol error.
 * `case_subset` (§3.3.5): the runtime runs a server-chosen batch of a replay run's
 * cases, reports the case index with its snapshot, and uses the batch upload
 * and fail calls. The server leases batches only to a session that advertised it.
 */
export const RUNNER_FEATURE_CAPABILITIES = ["case_subset", "case_repeats"] as const;
export type RunnerFeatureCapability = (typeof RUNNER_FEATURE_CAPABILITIES)[number];

/**
 * §2.2 authority capabilities. Their source is customer-committed files: the
 * workflow grants (`evaluator_secrets`, `install_grant`) and the route manifest
 * (`executable`). The server issues work that needs one only if the customer
 * committed it. A new authority capability always needs a customer refresh.
 */
export const RUNNER_AUTHORITY_CAPABILITIES = ["executable", "evaluator_secrets", "install_grant"] as const;
export type RunnerAuthorityCapability = (typeof RUNNER_AUTHORITY_CAPABILITIES)[number];

export type RunnerCapabilityListParse<Name extends string> =
  | { ok: true; value: Name[] }
  | { ok: false; code: "invalid_capability_list" | "capability_unsupported"; unknown: string[] };

function parseCapabilityList<Name extends string>(
  value: JsonValue,
  known: readonly Name[]
): RunnerCapabilityListParse<Name> {
  if (!Array.isArray(value)) return { ok: false, code: "invalid_capability_list", unknown: [] };
  const parsed: Name[] = [];
  const unknown: string[] = [];
  for (const entry of value) {
    const name = known.find((candidate) => candidate === entry);
    if (name === undefined) unknown.push(JSON.stringify(entry));
    else if (!parsed.includes(name)) parsed.push(name);
  }
  return unknown.length > 0 ? { ok: false, code: "capability_unsupported", unknown } : { ok: true, value: parsed };
}

/** Fail closed: any unknown or non-string entry refuses the whole list. */
export function parseRunnerFeatureCapabilities(value: JsonValue): RunnerCapabilityListParse<RunnerFeatureCapability> {
  return parseCapabilityList(value, RUNNER_FEATURE_CAPABILITIES);
}

/** Fail closed: any unknown or non-string entry refuses the whole list. */
export function parseRunnerAuthorityCapabilities(value: JsonValue): RunnerCapabilityListParse<RunnerAuthorityCapability> {
  return parseCapabilityList(value, RUNNER_AUTHORITY_CAPABILITIES);
}

// ---------------------------------------------------------------------------
// Idempotency keys and logical call IDs (§3, §3.3.2)
// ---------------------------------------------------------------------------

/**
 * §3.1: hello's key is derived by the server from verified OIDC claims
 * `(repository_id, run_id, run_attempt)`. The client never sends it.
 */
export type RunnerHelloIdempotencyKey = `hello:${number}:${number}:${number}`;

/**
 * §3, §3.3: the `Idempotency-Key` of every other mutating call. The server stores
 * `(key, request body digest, response)`. The same key and digest return the stored
 * response; the same key with another digest returns `409 idempotency_body_conflict`.
 * Only a committed outcome is stored: a refused call (`fenced`, validation) stores
 * nothing, so a replacement lease can still use the key.
 *
 * - snapshot: `<session_id>:snapshot`
 * - ready: `<session_id>:ready`
 * - claim: `<session_id>:claim:<claim_seq>`. A retried claim returns the same items.
 * - upload: `<work_id>:<retry_attempt>:upload`
 * - fail: `<work_id>:<retry_attempt>:fail`
 * - batch upload (`case_subset`): `<work_id>:<retry_attempt>:<lease_gen>:upload`
 * - batch fail (`case_subset`): `<work_id>:<retry_attempt>:<lease_gen>:fail`
 *
 * A batch is one lease generation of a batched item, so its key names the generation.
 *
 * Heartbeat is not keyed: it only renews, and it never revives an expired generation.
 */
export type RunnerIdempotencyKey =
  | `${string}:snapshot`
  | `${string}:ready`
  | `${string}:claim:${number}`
  | `${string}:${number}:upload`
  | `${string}:${number}:fail`
  | `${string}:${number}:${number}:upload`
  | `${string}:${number}:${number}:fail`;

/** §3.3.2: the role of a model-facing call. */
export const RUNNER_CALL_ROLES = ["model", "judge"] as const;
export type RunnerCallRole = (typeof RUNNER_CALL_ROLES)[number];

/**
 * §3.3.2: the inputs of a logical call ID. There is no request body digest and no
 * `lease_gen`, so an HTTP retry and a replacement lease reach the same operation.
 * `op_id` = `op_` + hex sha256 of the canonical JSON array
 * `[work_id, retry_attempt, case_id, trial, role, seq]`.
 *
 * - Replay: the runtime assigns `seq` in its deterministic call order.
 * - Executable: the proxy assigns `seq` through the durable mapping in
 *   `RunnerExecutableCallSeq` (§6.2 R1).
 */
export interface RunnerLogicalCallKey {
  work_id: string;
  retry_attempt: number;
  /** Null when an executable child's eval-call contract names no case (§3.3.2). */
  case_id: string | null;
  trial: number;
  role: RunnerCallRole;
  seq: number;
}
export type RunnerLogicalCallId = `op_${string}`;

/** §3.3.2: operation states in the ledger. */
export const RUNNER_CALL_STATES = ["in_progress", "completed", "failed_retryable", "unknown"] as const;
export type RunnerCallState = (typeof RUNNER_CALL_STATES)[number];

/**
 * §3.3.2: one ledger row. `request_digest` is the proxy-computed digest of the
 * canonical request body. It is stored beside the ID, never inside it: the same
 * `op_id` with another digest returns `409 call_body_changed` and runs nothing.
 */
export interface RunnerLogicalCallRecord {
  op_id: RunnerLogicalCallId;
  key: RunnerLogicalCallKey;
  request_digest: Sha256Digest;
  state: RunnerCallState;
  model_call_id: string | null;
  upstream_deadline_at: RunnerTimestamp;
}

/**
 * §6.2 R1: the executable call mapping, written at first arrival. An HTTP retry and a
 * replacement lease reuse it and get the same `seq`, so the same `op_id`.
 * `occurrence` counts identical requests inside the case.
 */
export interface RunnerExecutableCallSeq {
  work_id: string;
  retry_attempt: number;
  case_id: string | null;
  trial: number;
  role: RunnerCallRole;
  request_digest: Sha256Digest;
  occurrence: number;
  seq: number;
}

/**
 * §3.3.2, §3.3.3, §3.9: the header a work item's child sends with each model or judge
 * call, next to `Authorization: Bearer <call_token>`. Its value is
 * base64url(canonicalJson(RunnerEvalCallHeader)), with canonicalJson from
 * src/shared/parsing.ts.
 */
export const RUNNER_EVAL_CALL_HEADER = "x-benchrouter-eval-call";

/**
 * §3.3.2: the child-supplied part of a call's identity. Replay sends `seq` in its
 * deterministic call order; executable sends null and the proxy assigns it (R1).
 * `case_id` is null when an executable child cannot name its case.
 */
export interface RunnerEvalCallHeader {
  case_id: string | null;
  trial: number;
  role: RunnerCallRole;
  seq: number | null;
}

/**
 * §3.3.3: the server-side call context. `work_id`, `lease_gen` and `retry_attempt`
 * come only from the verified `call_token`, never from the header.
 */
export interface RunnerEvalCallContext extends RunnerEvalCallHeader {
  work_id: string;
  lease_gen: number;
  retry_attempt: number;
}

// ---------------------------------------------------------------------------
// Error codes (HTTP error bodies)
// ---------------------------------------------------------------------------

/**
 * Typed error codes of `/v1/runner/*` and of runner-context proxy admission
 * (§3.3.3). The body is `{ error: { code, message, retry_after_s? } }`, and a
 * `Retry-After` header repeats `retry_after_s`.
 */
export const RUNNER_ERROR_CODES = [
  // Authentication and protocol (§3.1, principle 5)
  "oidc_invalid",
  "claim_invalid",
  "session_invalid",
  "protocol_unsupported",
  "request_invalid",
  // Idempotency and terminal state (§3, §3.3.1)
  "idempotency_body_conflict",
  "work_terminal",
  // Fencing and clocks (§3.3.4)
  "fenced",
  "session_expired",
  "work_deadline_exceeded",
  "retiring",
  // Evidence identity (§3.2)
  "contract_digest_mismatch",
  "file_hash_mismatch",
  // Operation ledger (§3.3.2)
  "call_in_progress",
  "call_outcome_unknown",
  "call_body_changed",
  "call_response_expired",
  // Proxy admission (§3.3.3, §3.5)
  "budget_exhausted",
  "breaker_open",
  "target_temporarily_unroutable",
  "rate_limited"
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export interface RunnerErrorBody {
  error: { code: RunnerErrorCode; message: string; retry_after_s?: number };
}

/** §3.3.1: a losing upload or fail gets `409 work_terminal` with the winning receipt. */
export interface RunnerWorkTerminalErrorBody extends RunnerErrorBody {
  receipt: RunnerReceipt;
}

// ---------------------------------------------------------------------------
// Shared outcomes (§3.1, §3.3, §3.4)
// ---------------------------------------------------------------------------

/** §3.8, §3.5: a block covers one route context, or the whole repo surface. */
export type RunnerBlockScope = "route_context" | "repo";

/** §3.1, §3.3.5, §3.5, §6.2 R5: why a session is blocked. The job fails visibly (§3.11). */
export const RUNNER_BLOCKED_REASONS = [
  "workflow_outdated",
  "grant_revoked",
  "runtime_revoked",
  "runtime_not_allowed",
  "protocol_unsupported",
  "mode_unsupported",
  "capability_unsupported",
  "path_outside_triggers",
  "startup_failing",
  "route_harness_failing"
] as const;
export type RunnerBlockedReason = (typeof RUNNER_BLOCKED_REASONS)[number];

/** `action` is the one-line fix the runtime prints before it fails the job. */
export interface RunnerBlockedOutcome {
  outcome: "blocked";
  reason: RunnerBlockedReason;
  scope: RunnerBlockScope;
  action: string;
}

/** §3.1, §3.8, §6.2 R2: why a session ends with nothing to do. The job succeeds. */
export const RUNNER_DONE_REASONS = ["nothing_relevant", "stale_start", "stale_push", "pool_busy", "kit_ok", "capacity"] as const;
export type RunnerDoneReason = (typeof RUNNER_DONE_REASONS)[number];

export interface RunnerDoneOutcome {
  outcome: "done";
  reason: RunnerDoneReason;
}

/** §3.4, §3.10: an identity-proven newer event replaced this session; its leases are fenced. */
export interface RunnerSupersededOutcome {
  outcome: "superseded";
  superseded_by: { eval_sha: GitSha; pr_head_sha: GitSha | null };
}

/**
 * §3.2, §3.8: the context's `eval_sha` could not be fetched. Only that route
 * context moves to `awaiting_snapshot`; no model run fails and no work is dispatched
 * for it until a snapshot recovers it.
 */
export interface RunnerAwaitingSnapshotOutcome {
  outcome: "awaiting_snapshot";
  route_ctx: RunnerRouteContext;
  eval_sha: GitSha;
}

// ---------------------------------------------------------------------------
// hello (§3.1)
// ---------------------------------------------------------------------------

export type RunnerSessionPurpose = "work" | "snapshot_refresh";

/**
 * §3.1: sent with the Actions OIDC token as the bearer (audience
 * `benchrouter:repo:<repo>:hello`). Identity comes from verified claims only.
 */
export interface RunnerHelloRequest {
  protocol: RunnerProtocolMajor;
  /** The opaque startup claim; present only on `workflow_dispatch`. */
  claim: string | null;
  bootstrap_version: string;
  /** The verified runtime digest. The session pins it until exit (§2.2). */
  runtime_digest: Sha256Digest;
  /** Feature capabilities from the verified manifest. Unknown names: `protocol_unsupported`. */
  features: RunnerFeatureCapability[];
  /** Authority granted by the committed workflow at `workflow_sha` (§2.2). */
  workflow_authority: RunnerAuthorityCapability[];
  /** The committed workflow `paths` filters (§2.3). */
  workflow_paths: string[];
  /** sha256 of each kit file at `workflow_sha`, keyed by repo path. */
  kit_file_hashes: Record<string, Sha256Digest>;
}

/**
 * What this server accepts beyond the base v1 bodies. A runtime sends an optional
 * request field only when hello listed its feature, so an older server never
 * receives a field it would refuse. `case_index`: `RunnerRouteContract.case_index`.
 */
export const RUNNER_SERVER_FEATURES = ["case_index"] as const;
export type RunnerServerFeature = (typeof RUNNER_SERVER_FEATURES)[number];

export interface RunnerHelloSession {
  outcome: "session";
  session_id: string;
  session_credential: string;
  purpose: RunnerSessionPurpose;
  eval_sha: GitSha;
  workflow_sha: GitSha;
  /** §3.8: the push-ordering anchor, or null before the first import. */
  last_imported_sha: GitSha | null;
  lease_ttl_s: typeof RUNNER_LEASE_TTL_S;
  idle_exit_s: number;
  prepare_deadline_at: RunnerTimestamp;
  /** §3.3.4 clock 4; null means snapshot admission only (§6.2 R3). */
  retire_at: RunnerTimestamp | null;
  /** Absent from a server that predates it; a runtime treats that as none. */
  server_features?: RunnerServerFeature[];
}

/** §3.1: `done` and `blocked` release the startup slot in the hello transaction. */
export type RunnerHelloResponse = RunnerHelloSession | RunnerDoneOutcome | RunnerBlockedOutcome;

// ---------------------------------------------------------------------------
// Release status: the bootstrap's pre-execution revocation check (§2.2, §6.2 R4)
// ---------------------------------------------------------------------------

/**
 * §6.2 R4: `GET /v1/runner/release-status?digest=<sha256:...>` on the API host, not
 * the runtime origin. No credential. The bootstrap runs it before exec for `run`,
 * `capture` and `calibrate`, and refuses to exec on `revoked`, `unknown`, an
 * unreachable endpoint, or a manifest `key_id` in `retired_key_ids`. A customer pin
 * never exempts a revoked digest.
 */
export interface RunnerReleaseStatusRequest {
  digest: Sha256Digest;
}

export type RunnerReleaseStatusResponse =
  | { outcome: "allowed"; digest: Sha256Digest; retired_key_ids: string[] }
  | { outcome: "revoked"; digest: Sha256Digest; reason: string }
  | { outcome: "unknown"; digest: Sha256Digest };

// ---------------------------------------------------------------------------
// snapshot (§3.2, §3.8)
// ---------------------------------------------------------------------------

/** One case of a frozen replay route: its ID and the version the runtime derived from its content. */
export interface RunnerCaseRef {
  case_id: string;
  case_version: string;
}
/** RUN-001: the opaque case domain, shared with the eval-call header and failure diagnostics. */
export const RUNNER_CASE_ID_MAX = 200;

/**
 * Whether a case ID may be named in a case index and a batch: 1 to 200 characters
 * with no control character. The runtime reports a case index only when every case
 * of the route passes, and the server accepts only such an index, so the two agree.
 */
export function isRunnerBatchCaseId(value: string): boolean {
  if (value.length === 0 || value.length > RUNNER_CASE_ID_MAX) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** §3.2: the execution contract parts the runtime reports for one route. */
export interface RunnerRouteContract {
  route_key: string;
  mode: RunnerWorkMode;
  /** The normalized route manifest entry (the committed `benchrouter.yml` route). */
  manifest_entry: JsonObject;
  /** sha256 of each declared file (cases, scorers, judge files, lockfiles, code, input and acceptance refs). */
  file_hashes: Record<string, Sha256Digest>;
  argv: string[] | null;
  working_directory: string | null;
  judge_model: string | null;
  /** Declared evaluator env names; never values. */
  env_names: string[];
  case_count: number;
  /**
   * `case_subset`: the route's cases in the runtime's order, repeats expanded.
   * Replay routes only, and only when hello listed `case_index`. Its length is
   * `case_count`. IDs and versions only; raw cases are never sent.
   */
  case_index?: RunnerCaseRef[];
  /** §3.8: locally derived request-feature metadata. Raw cases are never sent. */
  request_features: {
    required_parameters: string[];
    api_families: string[];
    features: string[];
    input_kinds: string[];
    output_kinds: string[];
    protocol_headers: string[];
  };
}

/** §3.8: the push-ordering proof from the default branch's commit graph. */
export interface RunnerAncestryProof {
  last_imported_sha: GitSha | null;
  descends: boolean;
  is_head: boolean;
}

/**
 * §3.8: `kind: "snapshot"` reports the tree at `eval_sha`. `kind: "unavailable"`
 * reports an unfetchable `eval_sha` (§3.2). The server composes the fingerprint and
 * `contract_digest`; it never trusts a client-composed digest.
 *
 * Every session reports its snapshot, so every session learns the digests it sends in
 * `ready`. Only a push session or a production `snapshot_refresh` imports the manifest.
 * For a dispatched `work` session the server compares the reported hashes with the
 * admitted snapshot of that `eval_sha`, imports nothing, and returns the stored
 * `contract_digests`; a difference refuses with `contract_digest_mismatch` or
 * `file_hash_mismatch`. This also proves the fetched tree is the frozen one (§3.2).
 * `ancestry` is null for a dispatched `work` session.
 */
export type RunnerSnapshotRequest =
  | {
      kind: "snapshot";
      session_id: string;
      eval_sha: GitSha;
      product: string;
      default_branch: string;
      routes: RunnerRouteContract[];
      /** Required for a push session or a production `snapshot_refresh`. */
      ancestry: RunnerAncestryProof | null;
    }
  | { kind: "unavailable"; session_id: string; eval_sha: GitSha; cause: "fetch_failed" | "not_found" };

/**
 * §3.8: `history_rewritten` is true only for an authenticated ancestry reset
 * (`descends: false`, `is_head: true`).
 */
export type RunnerSnapshotResponse =
  | { outcome: "imported"; snapshot_id: string; contract_digests: Record<string, Sha256Digest>; history_rewritten: boolean }
  | RunnerDoneOutcome
  | RunnerBlockedOutcome
  | RunnerAwaitingSnapshotOutcome;

// ---------------------------------------------------------------------------
// ready (§3.3)
// ---------------------------------------------------------------------------

/** §3.3: ends `preparing`. For a replay work session, one digest per admitted route. */
export interface RunnerReadyRequest {
  session_id: string;
  contract_digests: Sha256Digest[];
}

export type RunnerReadyResponse = { outcome: "live"; session_expires_at: RunnerTimestamp } | RunnerBlockedOutcome | RunnerSupersededOutcome;

// ---------------------------------------------------------------------------
// Work descriptor (§3.3, §3.7)
// ---------------------------------------------------------------------------

/** §3.7: production, or one open PR with both SHAs (§3.2 SHA names). */
export type RunnerRouteContext =
  | { kind: "production" }
  | { kind: "pr"; pr_number: number; pr_head_sha: GitSha; pr_merge_sha: GitSha };

/**
 * §3.7, EVAL-010: who authorized the work, stored at admission and never changed by
 * a claim. `person` and `customer` come only from a verified credential
 * (`ExplicitRequest`); `background` is BenchRouter's own automation. A dispatched
 * worker never mints an explicit origin.
 */
export type RunnerAuthorityOrigin = "person" | "customer" | "background";

/** §3.7: the item's own budget scope. The proxy checks it on every call (§3.3.3). */
export interface RunnerBudgetScope {
  account_id: string;
  route_context_id: string;
  result_set_id: string;
}

/**
 * §3.3.5: the cases of this lease generation. A batched replay item always
 * carries `subset` (even when the batch is the whole route) and requires the
 * `case_subset` feature; the server never sends `all`. Null on any other item.
 */
export type RunnerCaseSelection = { kind: "all" } | { kind: "subset"; case_ids: string[] };

/**
 * §3.3.5: the evidence a subset combines with. The server sends the item's own
 * result set, snapshot and contract digest: batches combine only inside one run.
 * A runtime refuses a subset whose base snapshot or contract digest is not the item's.
 */
export interface RunnerWorkAncestry {
  base_result_set_id: string;
  base_snapshot_id: string;
  base_contract_digest: Sha256Digest;
}

/** Per-item limits the runtime enforces locally; the server enforces the same bounds. */
export interface RunnerWorkLimits {
  case_timeout_s: number;
  /** §6.1 item 1: per-trial case concurrency, so the proxy in-flight cap never refuses a case. */
  case_concurrency: number;
  /**
   * Repetitions of the case set inside the item; the `trial` of every call ID. Stage 1
   * issues 1: the case-result row has no trial field yet, so a runtime refuses an item
   * with more than one trial (`capability_unsupported`).
   */
  trials: number;
  /** §6.1 item 2: sent on every judge call. */
  judge_max_completion_tokens: number;
}

/**
 * §3.3, §3.7: one leased work item. `repo + eval_sha` is only the pool key: every
 * item carries its own route context, authority origin and budget scope, and the
 * proxy and upload check the item's fields, never the session's event.
 */
export interface RunnerWorkItem {
  work_id: string;
  /** §3.3.4: fencing generation; a replacement lease is `lease_gen + 1`. */
  lease_gen: number;
  /** §3.3.2: only the server issues a new attempt; it is a new call-ID namespace, billed. */
  retry_attempt: number;
  mode: RunnerWorkMode;
  route_id: string;
  route_generation: number;
  route_ctx: RunnerRouteContext;
  auth_origin: RunnerAuthorityOrigin;
  snapshot_id: string;
  contract_digest: Sha256Digest;
  eval_sha: GitSha;
  budget_scope: RunnerBudgetScope;
  model_run: { result_set_id: string; model_run_id: string; model: string; profile: string };
  /** Unknown names here make the runtime answer `blocked: capability_unsupported`. */
  requires: { features: RunnerFeatureCapability[]; authority: RunnerAuthorityCapability[] };
  case_selection: RunnerCaseSelection | null;
  ancestry: RunnerWorkAncestry | null;
  /** §3.3.4 clock 2. */
  lease_expires_at: RunnerTimestamp;
  /** §3.3.4 clock 3: absolute, never renewed, never later than `retire_at`. */
  work_deadline_at: RunnerTimestamp;
  /**
   * §3.9: the proxy credential of this item, scoped to `(work_id, lease_gen)`; it dies
   * with the lease. It is the only credential a child receives, for replay and
   * executable alike. It is never the session credential.
   */
  call_token: string;
  limits: RunnerWorkLimits;
}

// ---------------------------------------------------------------------------
// claim (§3.3, §3.4, §3.6)
// ---------------------------------------------------------------------------

export interface RunnerClaimRequest {
  session_id: string;
  claim_seq: number;
  slots_free: number;
}

/** §3.4: why a session exits without `complete`. */
export const RUNNER_EXIT_REASONS = ["idle", "retiring", "long_hold", "fenced"] as const;
export type RunnerExitReason = (typeof RUNNER_EXIT_REASONS)[number];

/** §3.6: the durable terminal result-set outcomes that `complete` reports. */
export const RUNNER_RESULT_SET_TERMINAL_STATES = ["decided", "failed", "expired", "noop", "superseded"] as const;
export type RunnerResultSetTerminalState = (typeof RUNNER_RESULT_SET_TERMINAL_STATES)[number];

/**
 * §3.3, §3.4, §3.6: claim outcomes. `exit`, `complete`, `blocked`, `superseded` and
 * `awaiting_snapshot` close the session in the claim transaction and release its
 * slot (§3.4 closure table). `wait_until` is returned only when `until` − now ≤
 * `idle_exit_s`. `draining` means finish leased items and claim nothing new.
 * `complete` means the result set has a durable terminal outcome, never only
 * execution release.
 */
export type RunnerClaimResponse =
  | { outcome: "run"; items: RunnerWorkItem[] }
  | { outcome: "wait_until"; until: RunnerTimestamp }
  | { outcome: "draining" }
  | { outcome: "exit"; reason: RunnerExitReason }
  | { outcome: "complete"; result_set_id: string; state: RunnerResultSetTerminalState }
  | RunnerBlockedOutcome
  | RunnerSupersededOutcome
  | RunnerAwaitingSnapshotOutcome;

// ---------------------------------------------------------------------------
// heartbeat (§3.3, §3.3.4)
// ---------------------------------------------------------------------------

export interface RunnerLeaseRef {
  work_id: string;
  lease_gen: number;
}

export interface RunnerHeartbeatRequest {
  session_id: string;
  leases: RunnerLeaseRef[];
}

/** §3.3.4: renewal is conditional on `lease_gen = current AND lease_expires_at > now`. */
export type RunnerLeaseHeartbeat =
  | { work_id: string; lease_gen: number; status: "ok"; lease_expires_at: RunnerTimestamp }
  | { work_id: string; lease_gen: number; status: "fenced"; reason: "lease_expired" | "superseded_generation" | "work_terminal" | "runtime_revoked" };

/** §2.2: a revoked runtime digest fences every live lease within one lease TTL. */
export type RunnerHeartbeatResponse =
  | { outcome: "ok"; session_expires_at: RunnerTimestamp; leases: RunnerLeaseHeartbeat[] }
  | { outcome: "expired" }
  | RunnerBlockedOutcome
  | RunnerSupersededOutcome;

// ---------------------------------------------------------------------------
// upload and fail (§3.3.1)
// ---------------------------------------------------------------------------

/**
 * §3.2, §3.3.1: every upload repeats the admitted identity. The server rejects any
 * `contract_digest` or `file_hashes` mismatch with the snapshot. `case_results` uses
 * the current case-result row schema (`parseEvalModelCaseResultRows` in
 * src/evals/result-schema.ts). The runtime digest is recorded on evidence but is not
 * part of eval identity.
 */
export interface RunnerUploadRequest {
  session_id: string;
  work_id: string;
  lease_gen: number;
  retry_attempt: number;
  contract_digest: Sha256Digest;
  file_hashes: Record<string, Sha256Digest>;
  runtime_digest: Sha256Digest;
  /** "sha256:" + hex(sha256(canonicalJson(case_results))), canonicalJson from src/shared/parsing.ts. */
  payload_digest: Sha256Digest;
  case_results: JsonValue[];
  /**
   * Batched items only (required there, refused elsewhere): the lease generation's
   * `case_selection.case_ids`, repeated like the contract digest. `case_results`
   * and `case_failures` together name each of them exactly once.
   */
  case_ids?: string[];
  /**
   * Batched items only: the cases of the batch with no scorable evidence, as the
   * fixed fields of the EVAL-011 failed-case diagnostic. A batch that ran to the
   * end is uploaded even when some cases failed; a scorer's "fail" is a result row.
   */
  case_failures?: JsonObject[];
  /**
   * Executable items only: the evaluator's result receipt quality,
   * `{ primary_metric: { name, score }, metrics }`. Null for replay items, whose quality is
   * the case rows. Not part of `payload_digest`.
   */
  quality: JsonObject | null;
}

/** §3.2, §3.3.2, §3.3.4, §3.3.5: why the runtime failed a work item. */
export const RUNNER_WORK_FAIL_CAUSES = [
  /**
   * §3.11: the item ran, but at least one case has no scorable evidence (a provider,
   * judge, scorer or harness failure of that case). `diagnostics` carries the per-case
   * stages and codes of the EVAL-011 failure diagnostic. Provider-only failures are
   * data: the job does not fail for them.
   */
  "case_failures",
  "tree_mutated",
  "deadline_exceeded",
  "lease_lost",
  "retiring",
  "nondeterministic_request",
  "call_response_expired",
  "install_failed",
  "harness_failed",
  "mode_unsupported",
  "capability_unsupported",
  "runtime_error"
] as const;
export type RunnerWorkFailCause = (typeof RUNNER_WORK_FAIL_CAUSES)[number];

export interface RunnerFailRequest {
  session_id: string;
  work_id: string;
  lease_gen: number;
  retry_attempt: number;
  cause: RunnerWorkFailCause;
  diagnostics: JsonObject;
  /** Batched items only (required there): the lease generation's case IDs. */
  case_ids?: string[];
}

/**
 * Causes that end one batch, not the run: the batch did not run to the end, its
 * cases stay pending, and a later grant gives them out again.
 */
export const RUNNER_BATCH_RELEASE_CAUSES = ["retiring", "lease_lost", "deadline_exceeded"] as const satisfies readonly RunnerWorkFailCause[];

/**
 * §3.3.1: the durable receipt. One D1 batch commits evidence, receipt, terminal state
 * and the continuation outbox row, so a receipt never follows a later 400. A retry
 * with the same key and body returns it even after lease expiry.
 */
export interface RunnerReceipt {
  receipt_id: string;
  idempotency_key: RunnerIdempotencyKey;
  work_id: string;
  retry_attempt: number;
  lease_gen: number;
  /**
   * `uploaded` and `failed` end the work item. A batched item also commits
   * `accepted` (the batch is stored and the run continues) and `released` (the
   * batch is given back and its cases stay pending).
   */
  terminal: "uploaded" | "failed" | "accepted" | "released";
  committed_at: RunnerTimestamp;
}

/** Upload and fail are mutually exclusive: the loser gets `409 work_terminal` (`RunnerWorkTerminalErrorBody`). */
export interface RunnerTerminalResponse {
  outcome: "committed";
  receipt: RunnerReceipt;
}

/**
 * §3.3.1: `GET /v1/runner/receipt?key=<idempotency key>` with the session
 * credential, valid until `retire_at` + `RUNNER_RECEIPT_READ_GRACE_S`. A receipt
 * read never restores mutation authority.
 */
export type RunnerReceiptResponse = RunnerTerminalResponse | { outcome: "not_found" };

// ---------------------------------------------------------------------------
// Signed release manifest and trust.json (§2.2, §2.4, §7.3 decisions 4, 5, 7)
// ---------------------------------------------------------------------------

export const RUNTIME_MANIFEST_SCHEMA = "benchrouter.runtime-manifest.v1";

/**
 * §2.2 step 4: the signed release manifest. The bootstrap verifies the signature
 * against a `trust.json` key, `not_after > now`, `protocol_major` equal to
 * `trust.json`, the pin list, and the downloaded bytes against `digest`.
 */
export interface RuntimeReleaseManifest {
  schema: typeof RUNTIME_MANIFEST_SCHEMA;
  protocol_major: RunnerProtocolMajor;
  /** Matches the release tag `runtime-v<version>`. */
  version: string;
  /** sha256 of the runtime file bytes. */
  digest: Sha256Digest;
  size_bytes: number;
  /** Path on the fixed runtime origin. Redirects and other origins are refused. */
  artifact_path: string;
  features: RunnerFeatureCapability[];
  signed_at: RunnerTimestamp;
  /** `signed_at` + `RUNTIME_MANIFEST_NOT_AFTER_DAYS`. */
  not_after: RunnerTimestamp;
  /** `ed25519:` + the first 16 hex of sha256(raw 32-byte public key). */
  key_id: string;
  /** Provenance; informational only. */
  source: { repository: string; commit: GitSha; ref: string };
}

/**
 * The file served as the manifest. `signature` is base64 Ed25519 over the exact
 * decoded `payload` bytes (no canonicalization). `key_id` must equal the payload's.
 * The bootstrap parses the payload only after the signature verifies.
 */
export interface SignedRuntimeManifest {
  /** base64 of the UTF-8 JSON bytes of `RuntimeReleaseManifest`. */
  payload: string;
  key_id: string;
  signature: string;
}

/** §2.2 step 2: the unauthenticated pointer response from the runtime origin. */
export interface RuntimePointer {
  protocol_major: RunnerProtocolMajor;
  /** Path of the `SignedRuntimeManifest` on the same origin. */
  manifest_path: string;
}

export const RUNNER_TRUST_SCHEMA = "benchrouter.trust.v1";

export interface RunnerTrustKey {
  key_id: string;
  alg: "ed25519";
  /** base64 of the raw 32-byte public key. */
  public_key: string;
}

/**
 * `.benchrouter/trust.json`, committed by the kit. §7.3 decision 7: the kit always
 * writes a current and a next key; rotation promotes `next` with no refresh.
 * §7.3 decision 4: `pins` is empty by default; a non-empty list restricts which
 * digests may run, and never exempts a revoked one (§6.2 R4).
 */
export interface RunnerTrustFile {
  schema: typeof RUNNER_TRUST_SCHEMA;
  protocol_major: RunnerProtocolMajor;
  keys: { current: RunnerTrustKey; next: RunnerTrustKey };
  pins: Sha256Digest[];
}
