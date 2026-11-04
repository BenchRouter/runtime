// Local `capture` (RUN-001), ported from the old kit sidecar. A proxy on 127.0.0.1:0
// forwards the app's model calls to the BenchRouter API with the CLI credential and
// records each call as a replay case in `.benchrouter/cases.<route token>.json`. It
// never calls hello or any /v1/runner/* endpoint. Capture is the only local path where
// customer traffic is written to disk, so every stored value passes the redaction walk.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { ControlContext } from "./control";
import { canonicalJson, errorMessage, isJsonFiniteNumber, isJsonObject, isJsonString, sha256Hex, type JsonObject, type JsonValue } from "./json";
import { readManifest } from "./manifest";
import { parseJsonValueFromString } from "../../src/shared/json-parse-contracts";
import { createStreamAssembler, type AssembledStream } from "./stream-capture";
import type { StringMap } from "./transport";

export const REDACTED = "[[benchrouter:redacted]]";

// Secret prefixes redacted on sight, structure preserved. NOT exhaustive: the install
// agent reviews every redaction and flags anything unsafe to retain. The evaluator's
// stderr excerpt (stderr-excerpt.ts) redacts the same prefixes.
export const SECRET_PREFIXES = [
  "sk-", "sk-ant-", "br_", "ghp_", "gho_", "ghs_", "github_pat_",
  "xoxb-", "xoxp-", "xoxa-", "AKIA", "ASIA", "AIza", "ya29.", "Bearer "
];

// `route`, `model`, `provider` and `allow_fallbacks` are BenchRouter routing controls,
// not protocol payload. They and the known client-injected volatile ids are stripped
// from the stored replay body, so the input replays faithfully and dedupes stably.
const ROUTING_SELECTOR_KEYS = ["route", "model", "provider", "allow_fallbacks"];
const VOLATILE_BODY_KEYS = [...ROUTING_SELECTOR_KEYS, "idempotency_key", "request_id", "trace_id", "x_request_id", "user"];

// ROUTE-001: the admitted Anthropic protocol headers are protocol inputs. Only these two
// names are read; no other request header is captured or forwarded.
const PROTOCOL_HEADER_NAMES = ["anthropic-version", "anthropic-beta"];

/** Response headers not relayed: fetch() already decoded the body, so they would lie. */
const UNRELAYED_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);

interface Redaction {
  path: string;
  kind: "declared" | "secret";
}

interface CaptureSettings {
  root: string;
  apiOrigin: string;
  authorization: string;
  codeRefsSha256: string | null;
  samplesTarget: number;
  portFile: string;
  rawLogPath: string;
  redactPaths: string[];
  /** route_id → kit route slug, from benchrouter.yml. */
  routeSlugs: Map<string, string>;
}

interface Sample {
  json: JsonValue | null;
  message: JsonObject;
  ok: boolean;
}

interface ForwardReply {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

function parseRedactPaths(raw: string | undefined): string[] {
  if (!raw) return [];
  const parsed = parseJsonValueFromString(raw);
  return parsed.ok && Array.isArray(parsed.value) ? parsed.value.filter(isJsonString) : [];
}

function parseJsonOrNull(text: string): JsonValue | null {
  const parsed = parseJsonValueFromString(text);
  return parsed.ok ? parsed.value : null;
}

/** JavaScript truthiness of a JSON value, as the old kit's `||` and `&&` tests used it. */
function truthy(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}

export function looksLikeSecret(text: string): boolean {
  return SECRET_PREFIXES.some((prefix) => text.startsWith(prefix) && text.length >= prefix.length + 8);
}

/**
 * Deep, structure-preserving redaction: a string leaf at a declared dot-path (or below
 * it) or with a known secret prefix becomes the redaction token. Keys and arrays stay.
 */
function redact(value: JsonValue, basePath: string, redactPaths: string[], redactions: Redaction[]): JsonValue {
  if (Array.isArray(value)) return value.map((item, index) => redact(item, `${basePath}[${index}]`, redactPaths, redactions));
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child !== undefined) out[key] = redact(child, basePath ? `${basePath}.${key}` : key, redactPaths, redactions);
    }
    return out;
  }
  if (isJsonString(value)) {
    // A declared path redacts that leaf AND all its descendants.
    if (redactPaths.some((declared) => basePath === declared || basePath.startsWith(`${declared}.`) || basePath.startsWith(`${declared}[`))) {
      redactions.push({ path: basePath, kind: "declared" });
      return REDACTED;
    }
    if (looksLikeSecret(value)) {
      redactions.push({ path: basePath, kind: "secret" });
      return REDACTED;
    }
  }
  return value;
}

function normalizeInput(body: JsonObject): JsonObject {
  const input: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (!VOLATILE_BODY_KEYS.includes(key)) input[key] = value;
  }
  return input;
}

/** Bounded routing context: selector names only, never prompt or user data. */
function routingContext(body: JsonObject): JsonObject {
  const context: JsonObject = {};
  if (isJsonString(body.route)) context.route = body.route;
  if (isJsonString(body.model)) context.model = body.model;
  return context;
}

function protocolHeaders(requestHeaders: IncomingHttpHeaders): StringMap {
  const captured: StringMap = {};
  for (const name of PROTOCOL_HEADER_NAMES) {
    const value = requestHeaders[name];
    if (isJsonString(value) && value.length > 0) captured[name] = value;
  }
  return captured;
}

/**
 * The FULL assistant message (content + tool_calls), captured losslessly. SERVE-009: a
 * Responses body keeps its ordered output items and its native status verbatim.
 */
function extractMessage(response: JsonValue | null): JsonObject {
  if (response === null || !isJsonObject(response)) return { role: "assistant", content: "" };
  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  if (choice !== undefined && isJsonObject(choice) && choice.message !== undefined && isJsonObject(choice.message)) return choice.message;
  if (Array.isArray(response.output)) {
    const incomplete = response.incomplete_details;
    return {
      object: "response",
      status: isJsonString(response.status) ? response.status : null,
      output: response.output,
      incomplete_details: incomplete === undefined ? null : incomplete
    };
  }
  // Anthropic Messages: the content blocks are the assistant message, in the same form
  // CI replay stores (model-output.ts extractAssistantMessage). The old kit stored "" here.
  if (Array.isArray(response.content)) return { role: "assistant", content: response.content, stop_reason: response.stop_reason ?? null };
  return { role: "assistant", content: "" };
}

function extractCost(response: JsonValue | null): number | null {
  const usage = response !== null && isJsonObject(response) ? response.usage : undefined;
  if (usage === undefined || !isJsonObject(usage)) return null;
  const cost = usage.cost !== undefined && usage.cost !== null ? usage.cost : usage.total_cost;
  return cost !== undefined && isJsonFiniteNumber(cost) ? cost : null;
}

/**
 * A request that embeds a prior model or tool output is `dependent`: replay treats it
 * as an isolated compatibility check, never end to end.
 */
/** Responses input items that carry an earlier model output or tool result. */
const RESPONSES_PRIOR_OUTPUT_TYPES = new Set(["function_call", "function_call_output", "reasoning"]);

function detectDependent(input: JsonValue): boolean {
  if (!isJsonObject(input)) return false;
  // Chat and Messages: an assistant turn or a tool result in the history.
  const messages = Array.isArray(input.messages) ? input.messages : [];
  if (messages.some((message) => isJsonObject(message) && (message.role === "assistant" || message.role === "tool"))) return true;
  // Responses: a continuation carries function calls, their outputs or assistant items in `input`.
  const items = Array.isArray(input.input) ? input.input : [];
  return items.some((item) => isJsonObject(item) && (item.role === "assistant" || (isJsonString(item.type) && RESPONSES_PRIOR_OUTPUT_TYPES.has(item.type))));
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: JsonObject): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

class CaptureStore {
  private readonly routeCases = new Map<string, Map<string, JsonObject>>();
  /** One write at a time: concurrent app calls must not interleave read-modify-write. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly settings: CaptureSettings) {}

  /**
   * The kit's replay and the server's drift derive per-route file names from the route
   * SLUG. The app sends the route_id, so the token maps route_id → slug from benchrouter.yml.
   */
  private routeToken(route: string): string {
    const slug = this.settings.routeSlugs.get(route) || route;
    return (slug || "default").split("/").join("__");
  }

  private file(prefix: string, route: string): string {
    return path.join(this.settings.root, ".benchrouter", `${prefix}.${this.routeToken(route)}.json`);
  }

  private async load(route: string): Promise<Map<string, JsonObject>> {
    const loaded = this.routeCases.get(route);
    if (loaded) return loaded;
    const cases = new Map<string, JsonObject>();
    this.routeCases.set(route, cases);
    // Repeated capture runs ACCUMULATE samples on the cases already on disk.
    let text: string | null = null;
    try {
      text = await readFile(this.file("cases", route), "utf8");
    } catch {
      // No prior cases file (first capture): start empty.
    }
    const existing = text === null ? null : parseJsonOrNull(text);
    if (existing !== null && Array.isArray(existing)) {
      for (const entry of existing) {
        if (isJsonObject(entry) && isJsonString(entry.id) && (truthy(entry.input) || Array.isArray(entry.messages))) cases.set(entry.id, entry);
      }
    }
    return cases;
  }

  /** Record every sample of one call, then persist the route. Serialized with other calls. */
  record(entry: CaptureEntry): Promise<void> {
    const next = this.queue.then(() => this.recordNow(entry));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Wait for every queued write. */
  drain(): Promise<void> {
    return this.queue;
  }

  private async recordNow(entry: CaptureEntry): Promise<void> {
    const cases = await this.load(entry.route);
    // ROUTE-001: case identity is the body PLUS the protocol identity it was sent under.
    const identity = canonicalJson({ input: entry.input, endpoint: entry.endpoint, headers: entry.headers });
    const id = `case_${sha256Hex(identity).slice(0, 16)}`;
    const capturedAt = new Date().toISOString();
    for (const output of entry.outputs) {
      const existing = cases.get(id);
      if (existing) {
        // Repeated identical input: keep each distinct output as a sample (nondeterminism).
        const samples = Array.isArray(existing.samples) ? existing.samples : [];
        if (!samples.includes(output)) samples.push(output);
        existing.samples = samples;
        if (entry.selectedModel) existing.selected_model = entry.selectedModel;
        // The identity already pins these, so they can only be re-asserted.
        existing.endpoint = entry.endpoint;
        existing.headers = { ...entry.headers };
        continue;
      }
      const messages = Array.isArray(entry.input.messages) ? entry.input.messages : [];
      cases.set(id, {
        id,
        route: entry.route,
        // EVAL-006: a captured case is not must-not-regress until the customer marks it so.
        critical: false,
        // The exact captured request body and endpoint, replayed verbatim.
        input: entry.input,
        routing_context: entry.routing,
        headers: { ...entry.headers },
        endpoint: entry.endpoint,
        messages,
        // Structured app-level input and scorer hints: filled by the install agent.
        request: null,
        scorer_metadata: {},
        // A calibration sample, NOT a gold answer: the full assistant message JSON.
        reference_output: output,
        samples: [output],
        selected_model: entry.selectedModel,
        mode: "isolated",
        dependent: entry.dependent,
        volatile_fields: [],
        snapshot: false,
        provenance: { source: "benchrouter-capture", captured_at: capturedAt, code_refs_sha256: this.settings.codeRefsSha256 },
        redactions: entry.redactions.map((redaction) => ({ path: redaction.path, kind: redaction.kind }))
      });
    }
    await this.persist(entry.route, cases);
    try {
      await appendFile(this.settings.rawLogPath, `${JSON.stringify({
        route: entry.route,
        captured_at: new Date().toISOString(),
        selected_model: entry.selectedModel,
        cost_usd: entry.costUsd,
        redaction_count: entry.redactions.length
      })}\n`);
    } catch (error) {
      console.error("BenchRouter capture sidecar: failed to append raw log", errorMessage(error instanceof Error ? error : String(error)));
    }
  }

  private async persist(route: string, cases: Map<string, JsonObject>): Promise<void> {
    const list = [...cases.values()];
    await mkdir(path.join(this.settings.root, ".benchrouter"), { recursive: true });
    await writeFile(this.file("cases", route), `${JSON.stringify(list, null, 2)}\n`);
    let redactionCount = 0;
    let maxSamples = 0;
    for (const testCase of list) {
      redactionCount += Array.isArray(testCase.redactions) ? testCase.redactions.length : 0;
      maxSamples = Math.max(maxSamples, Array.isArray(testCase.samples) ? testCase.samples.length : 0);
    }
    const provenance = {
      route,
      source: "benchrouter-capture",
      captured_at: new Date().toISOString(),
      case_count: list.length,
      code_refs_sha256: this.settings.codeRefsSha256,
      redaction_count: redactionCount,
      max_samples: maxSamples,
      note: "Local capture. Review redactions; enrich request/scorer_metadata/critical before relying on these cases."
    };
    await writeFile(this.file("capture", route), `${JSON.stringify(provenance, null, 2)}\n`);
  }
}

interface CaptureEntry {
  route: string;
  input: JsonObject;
  outputs: string[];
  selectedModel: string | null;
  redactions: Redaction[];
  dependent: boolean;
  endpoint: string;
  routing: JsonObject;
  headers: StringMap;
  costUsd: number | null;
}

function upstreamHeaders(settings: CaptureSettings, admitted: StringMap): StringMap {
  const headers: StringMap = {
    authorization: settings.authorization,
    "content-type": "application/json",
    // The capture marker: the proxy serves the route normally but excludes the call
    // from runtime traffic observation (no wired flip).
    "x-benchrouter-capture": "1"
  };
  // /v1/messages requires an admitted `anthropic-version`.
  for (const name of PROTOCOL_HEADER_NAMES) {
    const value = admitted[name];
    if (value !== undefined && value.length > 0) headers[name] = value;
  }
  return headers;
}

function fetchUpstream(settings: CaptureSettings, call: CallContext, signal?: AbortSignal): Promise<Response> {
  return fetch(call.target, { method: call.method, headers: upstreamHeaders(settings, call.admitted), body: call.body.length > 0 ? call.body : undefined, signal });
}

async function forwardOnce(settings: CaptureSettings, call: CallContext): Promise<ForwardReply> {
  const upstream = await fetchUpstream(settings, call);
  return { status: upstream.status, ok: upstream.ok, headers: upstream.headers, text: await upstream.text() };
}

function relayHeaders(headers: Headers): StringMap {
  const relay: StringMap = {};
  headers.forEach((value, key) => {
    if (!UNRELAYED_HEADERS.has(key.toLowerCase())) relay[key] = value;
  });
  return relay;
}

/** One app call: what the sidecar forwards and how its case is keyed. */
interface CallContext {
  requestJson: JsonObject | null;
  route: string;
  endpoint: string;
  target: string;
  method: string;
  body: Buffer;
  admitted: StringMap;
}

/** Record the call's samples as one case when the first relayed reply succeeded. */
async function recordSamples(settings: CaptureSettings, store: CaptureStore, call: CallContext, samples: Sample[], selectedModel: string | null): Promise<void> {
  const firstSample = samples[0];
  if (call.requestJson === null || !firstSample?.ok) return;
  const redactions: Redaction[] = [];
  const input = redact(normalizeInput(call.requestJson), "", settings.redactPaths, redactions);
  // Redact each message OBJECT (structure-preserving), then store it as JSON text.
  const outputs = samples.map((sample) => JSON.stringify(redact(sample.message, "reference_output", settings.redactPaths, redactions)));
  await store.record({
    route: call.route,
    input: isJsonObject(input) ? input : {},
    outputs,
    selectedModel,
    redactions,
    dependent: detectDependent(input),
    endpoint: call.endpoint,
    routing: routingContext(call.requestJson),
    headers: call.admitted,
    costUsd: extractCost(firstSample.json)
  });
}

/**
 * A streamed call that is not a case. The reason goes to stderr and to the raw log,
 * so the install agent sees why the call is missing from the cases file.
 */
async function logNotRecorded(settings: CaptureSettings, call: CallContext, reason: string): Promise<void> {
  console.error(`BenchRouter capture sidecar: streamed call not recorded (${reason})`);
  try {
    await appendFile(settings.rawLogPath, `${JSON.stringify({ route: call.route, endpoint: call.endpoint, captured_at: new Date().toISOString(), not_recorded: reason })}\n`);
  } catch (error) {
    console.error("BenchRouter capture sidecar: failed to append raw log", errorMessage(error instanceof Error ? error : String(error)));
  }
}

function streamSample(assembled: { response: JsonObject }): Sample {
  return { json: assembled.response, message: extractMessage(assembled.response), ok: true };
}

/** Resolves true once the app has the whole response, false when it left first. */
function delivered(response: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    if (response.writableFinished) resolve(true);
    else if (response.destroyed) resolve(false);
    else {
      response.once("finish", () => resolve(true));
      response.once("close", () => resolve(response.writableFinished));
    }
  });
}

/** Wait until the app's socket takes more bytes, or is gone. */
function writable(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

/**
 * SERVE-009: a streamed call. The first upstream stream is relayed to the app chunk by
 * chunk as it arrives, unchanged, so the app's tool loop runs exactly as in production.
 * The same bytes feed the assembler, which rebuilds the body a non-streamed call would
 * have returned. Extra samples are read whole and assembled the same way.
 */
async function relayStream(settings: CaptureSettings, store: CaptureStore, call: CallContext, response: ServerResponse): Promise<void> {
  const abort = new AbortController();
  // Settles once, in every phase: before the upstream headers, mid-stream, or on the last write.
  const appDone = delivered(response);
  // The app hung up: stop the upstream stream, as production does.
  response.once("close", () => {
    if (!response.writableFinished) abort.abort();
  });
  let upstream: Response;
  try {
    upstream = await fetchUpstream(settings, call, abort.signal);
  } catch (error) {
    console.error("BenchRouter capture sidecar:", errorMessage(error instanceof Error ? error : String(error)));
    if (abort.signal.aborted) {
      await logNotRecorded(settings, call, "client_disconnected");
      return;
    }
    sendJson(response, 502, { error: { message: "BenchRouter capture sidecar upstream fetch failed" } });
    await logNotRecorded(settings, call, "upstream_fetch_failed");
    return;
  }
  response.writeHead(upstream.status, relayHeaders(upstream.headers));
  response.flushHeaders();
  const assembler = createStreamAssembler(call.endpoint);
  const reader = upstream.body?.getReader();
  try {
    for (let read = await reader?.read(); read !== undefined && !read.done; read = await reader?.read()) {
      if (abort.signal.aborted) break;
      assembler.push(read.value);
      if (!response.write(read.value)) await writable(response);
    }
  } catch (error) {
    // The upstream stream broke (or the app left). The app gets the same broken stream
    // it would get in production, and a partial stream is never a case.
    response.destroy();
    console.error("BenchRouter capture sidecar:", errorMessage(error instanceof Error ? error : String(error)));
    await logNotRecorded(settings, call, abort.signal.aborted ? "client_disconnected" : "upstream_stream_dropped");
    return;
  }
  if (!response.destroyed) response.end();
  // A stream the app did not receive to its end is not what the app saw: no case.
  if (!(await appDone)) {
    await reader?.cancel().catch(() => undefined);
    await logNotRecorded(settings, call, "client_disconnected");
    return;
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  const assembled: AssembledStream = !upstream.ok
    ? { ok: false, reason: `upstream_status_${upstream.status}` }
    : !contentType.startsWith("text/event-stream")
      ? { ok: false, reason: "stream_not_event_stream" }
      : assembler.finish();
  if (!assembled.ok) {
    await logNotRecorded(settings, call, assembled.reason);
    return;
  }
  const samples: Sample[] = [streamSample(assembled)];
  let selectedModel = upstream.headers.get("x-benchrouter-selected-model");
  try {
    for (let index = 1; index < settings.samplesTarget; index += 1) {
      const extra = await forwardOnce(settings, call);
      selectedModel = extra.headers.get("x-benchrouter-selected-model") || selectedModel;
      const extraAssembler = createStreamAssembler(call.endpoint);
      extraAssembler.push(Buffer.from(extra.text, "utf8"));
      const extraAssembled = extraAssembler.finish();
      // Only a complete stream is a sample; a failed extra sample is left out.
      if (extra.ok && extraAssembled.ok) samples.push(streamSample(extraAssembled));
      else console.error(`BenchRouter capture sidecar: extra streamed sample not recorded (${extra.ok && !extraAssembled.ok ? extraAssembled.reason : `upstream_status_${extra.status}`})`);
    }
  } catch (error) {
    // The app already has its answer. A failed extra sample leaves the samples taken so far.
    console.error("BenchRouter capture sidecar: extra sample failed", errorMessage(error instanceof Error ? error : String(error)));
  }
  await recordSamples(settings, store, call, samples, selectedModel);
}

async function handle(settings: CaptureSettings, store: CaptureStore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(request);
  } catch {
    response.writeHead(400);
    response.end("BenchRouter capture sidecar: failed to read request body");
    return;
  }
  const endpoint = request.url || "/v1/chat/completions";
  const admitted = protocolHeaders(request.headers);
  // The credential goes only to the API origin: a request target that resolves elsewhere is refused.
  const resolved = endpoint.startsWith("/") ? new URL(endpoint, `${settings.apiOrigin}/`) : null;
  if (resolved === null || resolved.origin !== new URL(settings.apiOrigin).origin) {
    sendJson(response, 400, { error: { message: "BenchRouter capture forwards only paths on the BenchRouter API origin", code: "capture_target_refused" } });
    return;
  }
  const parsed = parseJsonOrNull(body.toString("utf8"));
  const requestJson = parsed !== null && isJsonObject(parsed) ? parsed : null;
  // ROUTE-001: `route` is the selector. `model` is the route only in the one-field SDK form.
  const route = requestJson !== null && isJsonString(requestJson.route) && requestJson.route.length > 0
    ? requestJson.route
    : requestJson !== null && isJsonString(requestJson.model) ? requestJson.model : "default";
  const call: CallContext = { requestJson, route, endpoint, target: resolved.href, method: request.method || "POST", body, admitted };
  // SERVE-009: a streamed call is forwarded as sent and recorded like a buffered one.
  // Replay strips `stream` later (src/shared/replay-body.ts).
  if (requestJson !== null && requestJson.stream === true) {
    await relayStream(settings, store, call, response);
    return;
  }

  let first: ForwardReply | null = null;
  try {
    // Multi-sample: capture samplesTarget outputs. Only the first response goes to the app.
    const samples: Sample[] = [];
    let selectedModel: string | null = null;
    for (let index = 0; index < settings.samplesTarget; index += 1) {
      const result = await forwardOnce(settings, call);
      if (index === 0) first = result;
      selectedModel = result.headers.get("x-benchrouter-selected-model") || selectedModel;
      const json = parseJsonOrNull(result.text);
      samples.push({ json, message: extractMessage(json), ok: result.ok });
    }
    if (first?.ok) await recordSamples(settings, store, call, samples, selectedModel);
  } catch (error) {
    console.error("BenchRouter capture sidecar:", errorMessage(error instanceof Error ? error : String(error)));
    sendJson(response, 502, { error: { message: "BenchRouter capture sidecar upstream fetch failed" } });
    return;
  }
  if (first === null) {
    sendJson(response, 502, { error: { message: "BenchRouter capture sidecar upstream fetch failed" } });
    return;
  }
  response.writeHead(first.status, relayHeaders(first.headers));
  response.end(first.text);
}

function resolveInRoot(root: string, value: string | undefined, fallback: string): string {
  return path.resolve(root, value || fallback);
}

/** Run the capture proxy until `stop` aborts. Resolves to the exit code. */
export async function runCapture(control: ControlContext, stop: AbortSignal): Promise<number> {
  const { apiKey, modelRunId, evalCallToken } = control.cli;
  if (!apiKey) {
    console.error("BenchRouter capture sidecar requires BENCHROUTER_API_KEY");
    return 1;
  }
  const root = control.controlRoot;
  // The manifest is the only source of route_id → slug. Read it before any call is
  // relayed, so capture never writes a file the replay cannot find.
  const manifest = await readManifest(root);
  const env = process.env;
  const settings: CaptureSettings = {
    root,
    apiOrigin: control.apiOrigin,
    // An eval-call token replaces the key only inside a model-run context, as before.
    authorization: `Bearer ${modelRunId && evalCallToken ? evalCallToken : apiKey}`,
    codeRefsSha256: env.BENCHROUTER_CODE_REFS_SHA256 || null,
    samplesTarget: Math.max(1, Number(env.BENCHROUTER_CAPTURE_SAMPLES) || 1),
    portFile: resolveInRoot(root, env.BENCHROUTER_SIDECAR_PORT_FILE, ".benchrouter/sidecar.port"),
    rawLogPath: resolveInRoot(root, env.BENCHROUTER_CAPTURE_RAW_LOG, ".benchrouter/captured.jsonl"),
    redactPaths: parseRedactPaths(env.BENCHROUTER_CAPTURE_REDACT_PATHS),
    routeSlugs: new Map(manifest.routes.map((route) => [route.routeId, route.slug]))
  };
  const store = new CaptureStore(settings);
  // A streamed call records after its last byte reaches the app, so exit waits for
  // every call still in flight, not only for queued writes.
  const inFlight = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const handled = handle(settings, store, request, response).catch((error: Error) => {
      console.error("BenchRouter capture sidecar:", errorMessage(error instanceof Error ? error : String(error)));
    });
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address !== null && !isJsonString(address) ? address.port : 0;
  try {
    await mkdir(path.dirname(settings.portFile), { recursive: true });
    await writeFile(settings.portFile, String(port));
  } catch (error) {
    console.error("BenchRouter capture sidecar: failed to write port file", errorMessage(error instanceof Error ? error : String(error)));
  }
  console.log(`BenchRouter capture sidecar listening on 127.0.0.1:${port} (capture mode)`);
  await new Promise<void>((resolve) => {
    if (stop.aborted) resolve();
    else stop.addEventListener("abort", () => resolve(), { once: true });
  });
  // Stop taking calls, then let every queued case write finish before exit.
  // A stream still open is cut, as before, and is not recorded.
  server.close();
  server.closeAllConnections();
  await Promise.all(inFlight);
  await store.drain();
  return 0;
}
