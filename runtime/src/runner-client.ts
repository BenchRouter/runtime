// RUN-001: the typed client of `/v1/runner/*`. Every response is parsed at this
// boundary and fails closed: an unknown outcome is a ProtocolError, never a default.
import {
  parseRunnerAuthorityCapabilities,
  parseRunnerFeatureCapabilities,
  parseRunnerWorkMode,
  RUNNER_BLOCKED_REASONS,
  RUNNER_DONE_REASONS,
  RUNNER_ENDPOINTS,
  RUNNER_EXIT_REASONS,
  RUNNER_IDEMPOTENCY_HEADER,
  RUNNER_RESULT_SET_TERMINAL_STATES,
  RUNNER_SERVER_FEATURES,
  type RunnerAwaitingSnapshotOutcome,
  type RunnerBlockedOutcome,
  type RunnerClaimRequest,
  type RunnerClaimResponse,
  type RunnerDoneOutcome,
  type RunnerFailRequest,
  type RunnerHeartbeatRequest,
  type RunnerHeartbeatResponse,
  type RunnerHelloRequest,
  type RunnerHelloResponse,
  type RunnerLeaseHeartbeat,
  type RunnerReadyRequest,
  type RunnerReadyResponse,
  type RunnerReceipt,
  type RunnerRouteContext,
  type RunnerSnapshotRequest,
  type RunnerSnapshotResponse,
  type RunnerSupersededOutcome,
  type RunnerTerminalResponse,
  type RunnerUploadRequest,
  type RunnerWorkItem
} from "../../src/shared/runner-protocol";
import {
  isJsonObject,
  isJsonString,
  objectOf,
  parseJsonText,
  ProtocolError,
  readArray,
  readBoolean,
  readDigest,
  readInteger,
  readNullableString,
  readPositiveInteger,
  readString,
  readStringList,
  readTimestamp,
  type JsonObject,
  type JsonValue
} from "./json";
import { send, TargetHolds, TransportError, type HttpReply, type StringMap } from "./transport";

const API_ATTEMPT_TIMEOUT_MS = 30_000;
const API_CALL_BUDGET_MS = 3 * 60_000;

/** A typed `/v1/runner/*` error body (RunnerErrorBody). */
export class RunnerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly receipt: RunnerReceipt | null
  ) {
    super(message);
  }
}

function oneOf<Value extends string>(value: string, allowed: readonly Value[], label: string): Value {
  const found = allowed.find((entry) => entry === value);
  if (found === undefined) throw new ProtocolError(`${label} has unknown value ${JSON.stringify(value)}`);
  return found;
}

function parseDone(body: JsonObject): RunnerDoneOutcome {
  return { outcome: "done", reason: oneOf(readString(body, "reason", "done"), RUNNER_DONE_REASONS, "done.reason") };
}

function parseBlocked(body: JsonObject): RunnerBlockedOutcome {
  return {
    outcome: "blocked",
    reason: oneOf(readString(body, "reason", "blocked"), RUNNER_BLOCKED_REASONS, "blocked.reason"),
    scope: oneOf(readString(body, "scope", "blocked"), ["route_context", "repo"] as const, "blocked.scope"),
    action: readString(body, "action", "blocked")
  };
}

function parseSuperseded(body: JsonObject): RunnerSupersededOutcome {
  const by = objectOf(body.superseded_by, "superseded.superseded_by");
  return { outcome: "superseded", superseded_by: { eval_sha: readString(by, "eval_sha", "superseded_by"), pr_head_sha: readNullableString(by, "pr_head_sha", "superseded_by") } };
}

function parseRouteContext(value: JsonValue | undefined, label: string): RunnerRouteContext {
  const context = objectOf(value, label);
  const kind = readString(context, "kind", label);
  if (kind === "production") return { kind };
  if (kind === "pr") {
    return {
      kind,
      pr_number: readPositiveInteger(context, "pr_number", label),
      pr_head_sha: readString(context, "pr_head_sha", label),
      pr_merge_sha: readString(context, "pr_merge_sha", label)
    };
  }
  throw new ProtocolError(`${label}.kind is unknown`);
}

function parseAwaitingSnapshot(body: JsonObject): RunnerAwaitingSnapshotOutcome {
  return { outcome: "awaiting_snapshot", route_ctx: parseRouteContext(body.route_ctx, "awaiting_snapshot.route_ctx"), eval_sha: readString(body, "eval_sha", "awaiting_snapshot") };
}

function parseReceipt(value: JsonValue | undefined): RunnerReceipt {
  const receipt = objectOf(value, "receipt");
  const key = readString(receipt, "idempotency_key", "receipt");
  return {
    receipt_id: readString(receipt, "receipt_id", "receipt"),
    // SAFETY: the server echoes the key this client sent; its template is checked by the server.
    idempotency_key: key as RunnerReceipt["idempotency_key"],
    work_id: readString(receipt, "work_id", "receipt"),
    retry_attempt: readInteger(receipt, "retry_attempt", "receipt"),
    lease_gen: readInteger(receipt, "lease_gen", "receipt"),
    terminal: oneOf(readString(receipt, "terminal", "receipt"), ["uploaded", "failed", "accepted", "released"] as const, "receipt.terminal"),
    committed_at: readString(receipt, "committed_at", "receipt")
  };
}

/** §3.3: one leased work item. Unknown modes and capability names fail closed. */
export function parseWorkItem(value: JsonValue): RunnerWorkItem {
  const item = objectOf(value, "work item");
  const label = "work item";
  const mode = parseRunnerWorkMode(item.mode ?? null);
  if (mode === null) throw new ProtocolError(`work item mode ${JSON.stringify(item.mode)} is unknown`);
  const requires = objectOf(item.requires, "work item.requires");
  const features = parseRunnerFeatureCapabilities(requires.features ?? null);
  const authority = parseRunnerAuthorityCapabilities(requires.authority ?? null);
  if (!features.ok || !authority.ok) throw new ProtocolError("work item requires an unknown capability");
  const modelRun = objectOf(item.model_run, "work item.model_run");
  const budget = objectOf(item.budget_scope, "work item.budget_scope");
  const limits = objectOf(item.limits, "work item.limits");
  const selection = item.case_selection ?? null;
  const ancestry = item.ancestry ?? null;
  return {
    work_id: readString(item, "work_id", label),
    lease_gen: readPositiveInteger(item, "lease_gen", label),
    retry_attempt: readInteger(item, "retry_attempt", label),
    mode,
    route_id: readString(item, "route_id", label),
    route_generation: readInteger(item, "route_generation", label),
    route_ctx: parseRouteContext(item.route_ctx, "work item.route_ctx"),
    auth_origin: oneOf(readString(item, "auth_origin", label), ["person", "customer", "background"] as const, "work item.auth_origin"),
    snapshot_id: readString(item, "snapshot_id", label),
    contract_digest: readDigest(item, "contract_digest", label),
    eval_sha: readString(item, "eval_sha", label),
    budget_scope: {
      account_id: readString(budget, "account_id", "budget_scope"),
      route_context_id: readString(budget, "route_context_id", "budget_scope"),
      result_set_id: readString(budget, "result_set_id", "budget_scope")
    },
    model_run: {
      result_set_id: readString(modelRun, "result_set_id", "model_run"),
      model_run_id: readString(modelRun, "model_run_id", "model_run"),
      model: readString(modelRun, "model", "model_run"),
      profile: readString(modelRun, "profile", "model_run")
    },
    requires: { features: features.value, authority: authority.value },
    case_selection: parseCaseSelection(selection),
    ancestry: ancestry === null ? null : {
      base_result_set_id: readString(objectOf(ancestry, "ancestry"), "base_result_set_id", "ancestry"),
      base_snapshot_id: readString(objectOf(ancestry, "ancestry"), "base_snapshot_id", "ancestry"),
      base_contract_digest: readDigest(objectOf(ancestry, "ancestry"), "base_contract_digest", "ancestry")
    },
    lease_expires_at: readString(item, "lease_expires_at", label),
    work_deadline_at: readString(item, "work_deadline_at", label),
    call_token: readString(item, "call_token", label),
    limits: {
      case_timeout_s: readPositiveInteger(limits, "case_timeout_s", "limits"),
      case_concurrency: readPositiveInteger(limits, "case_concurrency", "limits"),
      trials: readPositiveInteger(limits, "trials", "limits"),
      judge_max_completion_tokens: readPositiveInteger(limits, "judge_max_completion_tokens", "limits")
    }
  };
}

/** §3.3.5: case_selection is parsed now; subset execution is deferred to stage 2. */
function parseCaseSelection(value: JsonValue): RunnerWorkItem["case_selection"] {
  if (value === null) return null;
  const selection = objectOf(value, "case_selection");
  const kind = readString(selection, "kind", "case_selection");
  if (kind === "all") return { kind };
  if (kind === "subset") return { kind, case_ids: readStringList(selection, "case_ids", "case_selection") };
  throw new ProtocolError("case_selection.kind is unknown");
}

function parseLease(value: JsonValue): RunnerLeaseHeartbeat {
  const lease = objectOf(value, "lease");
  const base = { work_id: readString(lease, "work_id", "lease"), lease_gen: readPositiveInteger(lease, "lease_gen", "lease") };
  const status = readString(lease, "status", "lease");
  if (status === "ok") return { ...base, status, lease_expires_at: readString(lease, "lease_expires_at", "lease") };
  if (status === "fenced") {
    return { ...base, status, reason: oneOf(readString(lease, "reason", "lease"), ["lease_expired", "superseded_generation", "work_terminal", "runtime_revoked"] as const, "lease.reason") };
  }
  throw new ProtocolError("lease.status is unknown");
}

export interface SessionAuth {
  sessionId: string;
  credential: string;
}

export class RunnerClient {
  private auth: SessionAuth | null = null;

  constructor(
    private readonly apiOrigin: string,
    private readonly holds: TargetHolds
  ) {}

  setSession(auth: SessionAuth): void {
    this.auth = auth;
  }

  get sessionId(): string {
    if (!this.auth) throw new ProtocolError("no session yet");
    return this.auth.sessionId;
  }

  private async call(path: string, body: string, bearer: string, idempotencyKey: string | null, budgetMs = API_CALL_BUDGET_MS): Promise<JsonObject> {
    const headers: StringMap = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
    if (idempotencyKey !== null) headers[RUNNER_IDEMPOTENCY_HEADER] = idempotencyKey;
    const reply = await send({
      method: "POST",
      url: this.apiOrigin + path,
      headers,
      body,
      attemptTimeoutMs: API_ATTEMPT_TIMEOUT_MS,
      deadlineAt: Date.now() + budgetMs,
      target: "api"
    }, this.holds);
    return parseReply(path, reply);
  }

  private session(): SessionAuth {
    if (!this.auth) throw new ProtocolError("no session yet");
    return this.auth;
  }

  /** §3.1: OIDC is the only credential; the server derives the idempotency key from verified claims. */
  async hello(oidcToken: string, request: RunnerHelloRequest): Promise<RunnerHelloResponse> {
    const body = await this.call(RUNNER_ENDPOINTS.hello, JSON.stringify(request), oidcToken, null);
    const outcome = readString(body, "outcome", "hello");
    if (outcome === "done") return parseDone(body);
    if (outcome === "blocked") return parseBlocked(body);
    if (outcome !== "session") throw new ProtocolError(`hello outcome ${outcome} is unknown`);
    const leaseTtl = readInteger(body, "lease_ttl_s", "hello");
    if (leaseTtl !== 90) throw new ProtocolError("hello lease_ttl_s must be 90");
    const retireAt = readNullableString(body, "retire_at", "hello");
    return {
      outcome,
      session_id: readString(body, "session_id", "hello"),
      session_credential: readString(body, "session_credential", "hello"),
      purpose: oneOf(readString(body, "purpose", "hello"), ["work", "snapshot_refresh"] as const, "hello.purpose"),
      eval_sha: readString(body, "eval_sha", "hello"),
      workflow_sha: readString(body, "workflow_sha", "hello"),
      last_imported_sha: readNullableString(body, "last_imported_sha", "hello"),
      lease_ttl_s: 90,
      idle_exit_s: readInteger(body, "idle_exit_s", "hello"),
      prepare_deadline_at: new Date(readTimestamp(body, "prepare_deadline_at", "hello")).toISOString(),
      retire_at: retireAt === null ? null : new Date(readTimestamp(body, "retire_at", "hello")).toISOString(),
      // A server that predates the field lists nothing. A name this runtime does not
      // know is a feature it does not use, so it is ignored.
      server_features: body.server_features === undefined
        ? []
        : RUNNER_SERVER_FEATURES.filter((feature) => readStringList(body, "server_features", "hello").includes(feature))
    };
  }

  async snapshot(request: RunnerSnapshotRequest): Promise<RunnerSnapshotResponse> {
    const auth = this.session();
    const body = await this.call(RUNNER_ENDPOINTS.snapshot, JSON.stringify(request), auth.credential, `${auth.sessionId}:snapshot`);
    const outcome = readString(body, "outcome", "snapshot");
    if (outcome === "done") return parseDone(body);
    if (outcome === "blocked") return parseBlocked(body);
    if (outcome === "awaiting_snapshot") return parseAwaitingSnapshot(body);
    if (outcome !== "imported") throw new ProtocolError(`snapshot outcome ${outcome} is unknown`);
    const digests = objectOf(body.contract_digests, "snapshot.contract_digests");
    const contractDigests: Record<string, `sha256:${string}`> = {};
    for (const key of Object.keys(digests)) contractDigests[key] = readDigest(digests, key, "snapshot.contract_digests");
    return {
      outcome,
      snapshot_id: readString(body, "snapshot_id", "snapshot"),
      contract_digests: contractDigests,
      history_rewritten: readBoolean(body, "history_rewritten", "snapshot")
    };
  }

  async ready(request: RunnerReadyRequest): Promise<RunnerReadyResponse> {
    const auth = this.session();
    const body = await this.call(RUNNER_ENDPOINTS.ready, JSON.stringify(request), auth.credential, `${auth.sessionId}:ready`);
    const outcome = readString(body, "outcome", "ready");
    if (outcome === "blocked") return parseBlocked(body);
    if (outcome === "superseded") return parseSuperseded(body);
    if (outcome !== "live") throw new ProtocolError(`ready outcome ${outcome} is unknown`);
    return { outcome, session_expires_at: readString(body, "session_expires_at", "ready") };
  }

  /** §3.3: a retried claim with the same claim_seq returns the same items. */
  async claim(request: RunnerClaimRequest): Promise<RunnerClaimResponse> {
    const auth = this.session();
    const body = await this.call(RUNNER_ENDPOINTS.claim, JSON.stringify(request), auth.credential, `${auth.sessionId}:claim:${request.claim_seq}`);
    const outcome = readString(body, "outcome", "claim");
    switch (outcome) {
      case "run":
        return { outcome, items: readArray(body, "items", "claim").map(parseWorkItem) };
      case "wait_until":
        return { outcome, until: new Date(readTimestamp(body, "until", "claim")).toISOString() };
      case "draining":
        return { outcome };
      case "exit":
        return { outcome, reason: oneOf(readString(body, "reason", "claim"), RUNNER_EXIT_REASONS, "exit.reason") };
      case "complete":
        return { outcome, result_set_id: readString(body, "result_set_id", "claim"), state: oneOf(readString(body, "state", "claim"), RUNNER_RESULT_SET_TERMINAL_STATES, "complete.state") };
      case "blocked":
        return parseBlocked(body);
      case "superseded":
        return parseSuperseded(body);
      case "awaiting_snapshot":
        return parseAwaitingSnapshot(body);
      default:
        throw new ProtocolError(`claim outcome ${outcome} is unknown`);
    }
  }

  /** Heartbeat is not keyed: it only renews. A short budget, so a slow API never stalls the loop. */
  async heartbeat(request: RunnerHeartbeatRequest): Promise<RunnerHeartbeatResponse> {
    const auth = this.session();
    const body = await this.call(RUNNER_ENDPOINTS.heartbeat, JSON.stringify(request), auth.credential, null, 20_000);
    const outcome = readString(body, "outcome", "heartbeat");
    if (outcome === "expired") return { outcome };
    if (outcome === "blocked") return parseBlocked(body);
    if (outcome === "superseded") return parseSuperseded(body);
    if (outcome !== "ok") throw new ProtocolError(`heartbeat outcome ${outcome} is unknown`);
    return { outcome, session_expires_at: readString(body, "session_expires_at", "heartbeat"), leases: readArray(body, "leases", "heartbeat").map(parseLease) };
  }

  async upload(request: RunnerUploadRequest): Promise<RunnerTerminalResponse> {
    const auth = this.session();
    return this.terminal(RUNNER_ENDPOINTS.upload, JSON.stringify(request), auth, terminalKey(request, "upload"));
  }

  async fail(request: RunnerFailRequest): Promise<RunnerTerminalResponse> {
    const auth = this.session();
    return this.terminal(RUNNER_ENDPOINTS.fail, JSON.stringify(request), auth, terminalKey(request, "fail"));
  }

  /**
   * §3.3.1: upload and fail are keyed and return a durable receipt. A lost response is
   * recovered by the receipt read with the same key, never by a second terminal write.
   */
  private async terminal(path: string, body: string, auth: SessionAuth, key: string): Promise<RunnerTerminalResponse> {
    try {
      const reply = await this.call(path, body, auth.credential, key);
      if (readString(reply, "outcome", path) !== "committed") throw new ProtocolError(`${path} outcome is unknown`);
      return { outcome: "committed", receipt: parseReceipt(reply.receipt) };
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      const stored = await this.receipt(key).catch(() => null);
      if (stored) return stored;
      throw error;
    }
  }

  async receipt(key: string): Promise<RunnerTerminalResponse | null> {
    const auth = this.session();
    const reply = await send({
      method: "GET",
      url: `${this.apiOrigin}${RUNNER_ENDPOINTS.receipt}?key=${encodeURIComponent(key)}`,
      headers: { authorization: `Bearer ${auth.credential}` },
      body: null,
      attemptTimeoutMs: API_ATTEMPT_TIMEOUT_MS,
      deadlineAt: Date.now() + 60_000,
      target: "api"
    }, this.holds);
    const body = parseReply(RUNNER_ENDPOINTS.receipt, reply);
    const outcome = readString(body, "outcome", "receipt");
    if (outcome === "not_found") return null;
    if (outcome !== "committed") throw new ProtocolError("receipt outcome is unknown");
    return { outcome, receipt: parseReceipt(body.receipt) };
  }
}

/** §3.3.5: a batch call (one lease generation of a batched item) names its generation in its key. */
function terminalKey(request: { work_id: string; retry_attempt: number; lease_gen: number; case_ids?: string[] }, endpoint: "upload" | "fail"): string {
  return request.case_ids === undefined
    ? `${request.work_id}:${request.retry_attempt}:${endpoint}`
    : `${request.work_id}:${request.retry_attempt}:${request.lease_gen}:${endpoint}`;
}

function parseReply(path: string, reply: HttpReply): JsonObject {
  const parsed = reply.text.length > 0 ? parseJsonText(reply.text, path) : null;
  if (reply.status >= 200 && reply.status < 300) return objectOf(parsed ?? undefined, path);
  const body = parsed !== null && isJsonObject(parsed) ? parsed : {};
  const error = body.error !== undefined && isJsonObject(body.error) ? body.error : {};
  const code = error.code !== undefined && isJsonString(error.code) ? error.code : `http_${reply.status}`;
  const message = error.message !== undefined && isJsonString(error.message) ? error.message : reply.text.slice(0, 300);
  const receipt = code === "work_terminal" && body.receipt !== undefined ? parseReceipt(body.receipt) : null;
  throw new RunnerApiError(reply.status, code, `${path} returned HTTP ${reply.status} ${code}: ${message}`, receipt);
}
