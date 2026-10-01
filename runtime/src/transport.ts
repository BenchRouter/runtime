// §3.3.5 transport: every call has an explicit per-attempt timeout and an absolute
// deadline. Network errors, 429 and 5xx retry with full jitter under the same
// request (so the same Idempotency-Key or call context). `Retry-After` is honored per
// target: one refusal holds every call to that target until the time passes.
import { errorMessage, jittered, sleep } from "./json";

/** Request headers or a child env: names to values. */
export interface StringMap {
  [name: string]: string;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: StringMap;
  body: string | null;
  /** Per-attempt timeout. */
  attemptTimeoutMs: number;
  /** Absolute epoch ms after which no attempt starts. */
  deadlineAt: number;
  /** The Retry-After scope: "api" for runner calls, the model or judge target for proxy calls. */
  target: string;
  /** Extra statuses that retry (besides network errors, 429 and 5xx), e.g. 409 while a call settles. */
  retryWhen?: (reply: HttpReply) => boolean;
  /** Attempts in total (default 6). */
  maxAttempts?: number;
  /** Checked before every attempt, retries included; false stops with `aborted`. */
  beforeAttempt?: () => Promise<boolean>;
  signal?: AbortSignal;
}

export interface HttpReply {
  status: number;
  headers: Headers;
  text: string;
}

/** Why no usable reply arrived: the deadline passed, a Retry-After hold outlasts it, the call was aborted, or every attempt failed. */
export type TransportFailure = "deadline" | "held" | "aborted" | "unreachable";

export class TransportError extends Error {
  constructor(readonly reason: TransportFailure, message: string, readonly lastReply: HttpReply | null) {
    super(message);
  }
}

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/** Per-target not-before times, shared by every concurrent call of the runtime. */
export class TargetHolds {
  private readonly notBefore = new Map<string, number>();
  private readonly causes = new Map<string, HttpReply>();

  /** Hold `target` until `at`. The refusal that set the hold is kept, so a call that never ran reports it. */
  holdUntil(target: string, at: number, cause: HttpReply): void {
    if (at > (this.notBefore.get(target) ?? 0)) {
      this.notBefore.set(target, at);
      this.causes.set(target, cause);
    }
  }

  cause(target: string): HttpReply | null {
    return this.causes.get(target) ?? null;
  }

  waitMs(target: string, now = Date.now()): number {
    return Math.max(0, (this.notBefore.get(target) ?? 0) - now);
  }
}

/** `Retry-After` in seconds or as an HTTP date, else the body's `error.retry_after_s`. */
export function retryAfterMs(reply: HttpReply, now = Date.now()): number | null {
  const header = reply.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const ms = Number(reply.headers.get("retry-after-ms"));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export async function send(request: HttpRequest, holds: TargetHolds): Promise<HttpReply> {
  let lastReply: HttpReply | null = null;
  let lastError = "no attempt";
  const maxAttempts = request.maxAttempts ?? MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const hold = holds.waitMs(request.target);
    if (Date.now() + hold >= request.deadlineAt) {
      throw new TransportError("held", `${request.target} is held by Retry-After past the call deadline (${lastError})`, lastReply ?? holds.cause(request.target));
    }
    await sleep(hold, request.signal);
    if (request.signal?.aborted) throw new TransportError("aborted", "call aborted", lastReply);
    if (request.beforeAttempt && !(await request.beforeAttempt())) throw new TransportError("aborted", "the caller refused a new attempt", lastReply);
    const timeoutMs = Math.min(request.attemptTimeoutMs, request.deadlineAt - Date.now());
    if (timeoutMs <= 0) throw new TransportError("deadline", `deadline reached (${lastError})`, lastReply);
    const signals = [AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])];
    let reply: HttpReply;
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "error",
        signal: AbortSignal.any(signals)
      });
      reply = { status: response.status, headers: response.headers, text: await response.text() };
    } catch (error) {
      if (request.signal?.aborted) throw new TransportError("aborted", "call aborted", lastReply);
      lastError = errorMessage(error instanceof Error ? error : String(error));
      await sleep(Math.min(MAX_BACKOFF_MS, jittered(BASE_BACKOFF_MS * 2 ** attempt)), request.signal);
      continue;
    }
    lastReply = reply;
    const retryable = RETRY_STATUSES.has(reply.status) || (request.retryWhen?.(reply) ?? false);
    if (!retryable || attempt === maxAttempts - 1) return reply;
    lastError = `HTTP ${reply.status}`;
    const after = retryAfterMs(reply);
    // Retry-After is a floor: the jitter only adds, so concurrent waiters spread out after it.
    if (after !== null) holds.holdUntil(request.target, Date.now() + after + Math.random() * Math.min(1000 + after * 0.2, 5000), reply);
    else await sleep(Math.min(MAX_BACKOFF_MS, jittered(BASE_BACKOFF_MS * 2 ** attempt)), request.signal);
  }
  if (lastReply) return lastReply;
  throw new TransportError(Date.now() >= request.deadlineAt ? "deadline" : "unreachable", `${request.url} is unreachable (${lastError})`, null);
}
