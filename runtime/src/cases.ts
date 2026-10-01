// Declared replay cases. §6.1: the runtime reads EVERY entry of `case_refs` (the old
// kit read only `case_refs[0]`). Raw cases never leave the runner (§3.8): only counts,
// hashes and the CAT-006 planning metadata do.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerRouteContract } from "../../src/shared/runner-protocol";
import { MAX_EXPANDED_REPLAY_CASES } from "../../src/shared/replay-case-repeats";
import { isJsonFiniteNumber, isJsonObject, isJsonString, parseJsonText, ProtocolError, sha256Hex, type JsonObject, type JsonValue } from "./json";
import type { ManifestRoute } from "./manifest";

export interface ReplayCase {
  id: string;
  /** "sha256:" + sha256(JSON.stringify(case)), the case identity the server stores. */
  version: string;
  critical: boolean;
  endpoint: string;
  headers: Record<string, string>;
  body: JsonObject;
  raw: JsonObject;
}

/** The replay endpoints on the API origin. Any other value would let a case redirect the call token. */
const CASE_ENDPOINTS = ["/v1/chat/completions", "/v1/messages", "/v1/responses"];

/** ROUTE-001: the only request headers a case may carry into replay. */
const PROTOCOL_HEADER_NAMES = ["anthropic-version", "anthropic-beta"];

function runnableBody(testCase: JsonObject): JsonObject | null {
  const input = testCase.input;
  if (input !== undefined && isJsonObject(input) && Object.keys(input).length > 0) return { ...input };
  const messages = testCase.messages;
  if (Array.isArray(messages) && messages.length > 0) return { messages };
  return null;
}

function forRoute(testCase: JsonObject, routeId: string): boolean {
  const route = testCase.route;
  const name = route !== undefined && isJsonString(route) ? route.trim() : "";
  return name.length === 0 || name === routeId;
}

export async function loadReplayCases(treeRoot: string, route: ManifestRoute): Promise<ReplayCase[]> {
  const cases: ReplayCase[] = [];
  const seen = new Set<string>();
  for (const ref of route.caseRefs) {
    const parsed = parseJsonText(await readFile(path.join(treeRoot, ref), "utf8"), ref);
    if (!Array.isArray(parsed)) throw new ProtocolError(`${ref} must contain a JSON array of declared eval cases`);
    for (const entry of parsed) {
      if (!isJsonObject(entry) || !forRoute(entry, route.routeId)) continue;
      const id = entry.id;
      const body = runnableBody(entry);
      // Shape examples and docs entries (no id or no body) are skipped, as before.
      if (id === undefined || !isJsonString(id) || id.length === 0 || body === null) continue;
      if (seen.has(id)) throw new ProtocolError(`case id ${JSON.stringify(id)} appears twice in the case_refs of route ${route.routeId}`);
      seen.add(id);
      const headers: Record<string, string> = {};
      const declared = entry.headers !== undefined && isJsonObject(entry.headers) ? entry.headers : {};
      for (const [name, value] of Object.entries(declared)) {
        const lowered = name.toLowerCase();
        if (PROTOCOL_HEADER_NAMES.includes(lowered) && isJsonString(value) && value.length > 0) headers[lowered] = value;
      }
      const endpoint = entry.endpoint !== undefined && isJsonString(entry.endpoint) && entry.endpoint.length > 0 ? entry.endpoint : "/v1/chat/completions";
      if (!CASE_ENDPOINTS.includes(endpoint)) throw new ProtocolError(`case ${JSON.stringify(id)} names endpoint ${JSON.stringify(endpoint)}; a case may use only ${CASE_ENDPOINTS.join(", ")}`);
      cases.push({ id, version: `sha256:${sha256Hex(JSON.stringify(entry))}`, critical: entry.critical === true, endpoint, headers, body, raw: entry });
    }
  }
  const policy = route.caseRepeats;
  if (policy === null) return cases;
  const expanded: ReplayCase[] = [];
  for (const testCase of cases) {
    expanded.push(testCase);
    const repeats = testCase.critical ? policy.critical : policy.noncritical;
    if (repeats > 1) {
      if (testCase.endpoint !== "/v1/chat/completions") {
        throw new ProtocolError(`case ${JSON.stringify(testCase.id)} repeats require the chat completions seed contract`);
      }
      const input = testCase.raw.input;
      if (input === undefined || !isJsonObject(input) || Object.keys(input).length === 0) {
        throw new ProtocolError(`case ${JSON.stringify(testCase.id)} repeats require an authored input object`);
      }
      if (input.seed !== undefined && (!isJsonFiniteNumber(input.seed) || !Number.isSafeInteger(input.seed))) {
        throw new ProtocolError(`case ${JSON.stringify(testCase.id)} has an unsafe authored seed`);
      }
      for (let index = 1; index < repeats; index += 1) {
        const id = `${testCase.id}#repeat-${index + 1}`;
        if (seen.has(id)) throw new ProtocolError(`expanded case id ${JSON.stringify(id)} collides with a declared or generated case`);
        seen.add(id);
        const seed = policy.seed_start + index - 1;
        if (input.seed === seed) throw new ProtocolError(`case ${JSON.stringify(testCase.id)} repeats duplicate its authored seed`);
        const repeatedInput: JsonObject = { ...input, seed };
        const raw: JsonObject = { ...testCase.raw, id, input: repeatedInput, repeat_of: testCase.id, repeat_index: index + 1 };
        expanded.push({ ...testCase, id, version: `sha256:${sha256Hex(JSON.stringify(raw))}`, body: repeatedInput, raw });
      }
    }
    if (expanded.length > MAX_EXPANDED_REPLAY_CASES) {
      throw new ProtocolError(`case repeats exceed ${MAX_EXPANDED_REPLAY_CASES} expanded cases`);
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// CAT-006 planning metadata (ported unchanged from the old kit's snapshot builder)
// ---------------------------------------------------------------------------

type ApiFamily = "openai_chat_completions" | "anthropic_messages" | "openai_responses";

function endpointFamily(endpoint: string): ApiFamily {
  let base = endpoint.split("?")[0] ?? "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  if (base.endsWith("/chat/completions")) return "openai_chat_completions";
  if (base.endsWith("/messages")) return "anthropic_messages";
  // SERVE-009: `/responses` publishes `openai_responses`; the retired `responses` value has no alias.
  if (base.endsWith("/responses")) return "openai_responses";
  throw new ProtocolError(`Unknown eval case endpoint for candidate planning: ${endpoint}`);
}

function field(body: JsonObject, key: string): JsonValue | undefined {
  return body[key];
}

function objectField(body: JsonObject, key: string): JsonObject | null {
  const value = body[key];
  return value !== undefined && isJsonObject(value) ? value : null;
}

function requestsJsonSchema(family: ApiFamily, body: JsonObject): boolean {
  const format = family === "openai_chat_completions" ? objectField(body, "response_format")
    : family === "openai_responses" ? objectField(objectField(body, "text") ?? {}, "format") : null;
  return format !== null && format.type === "json_schema";
}

function isNoOpPlanningValue(family: ApiFamily, body: JsonObject, key: string): boolean {
  const value = field(body, key);
  if (value === null) return true;
  if (key === "n") return value === 1;
  if (key === "logprobs") return value === false;
  if (key === "top_logprobs") return family === "openai_chat_completions" && body.logprobs !== true;
  if (key === "parallel_tool_calls") return !Array.isArray(body.tools) || body.tools.length === 0;
  if (key === "text") return family === "openai_responses" && !requestsJsonSchema(family, body);
  if (key === "stream_options") {
    const options = objectField(body, "stream_options");
    return family === "openai_chat_completions" && body.stream === true && options !== null && Object.keys(options).every((name) => name === "include_usage");
  }
  return false;
}

function reasoningKind(family: ApiFamily, body: JsonObject): string {
  if (family === "openai_responses") {
    const reasoning = objectField(body, "reasoning");
    return reasoning !== null && (reasoning.effort !== undefined || reasoning.summary !== undefined || reasoning.context !== undefined) ? "responses" : "none";
  }
  if (family === "anthropic_messages") {
    if (body.thinking !== undefined) {
      const thinking = objectField(body, "thinking");
      return thinking !== null && thinking.budget_tokens !== undefined ? "budget" : "provider_object";
    }
    const outputConfig = objectField(body, "output_config");
    return outputConfig !== null && outputConfig.effort !== undefined ? "effort" : "none";
  }
  if (body.reasoning !== undefined) return "provider_object";
  if (body.reasoning_effort !== undefined) return "effort";
  return "none";
}

function containsKeyDeep(value: JsonValue, key: string): boolean {
  if (Array.isArray(value)) return value.some((child) => containsKeyDeep(child, key));
  if (!isJsonObject(value)) return false;
  return Object.entries(value).some(([name, child]) => name === key || containsKeyDeep(child, key));
}

function collectResponses(body: JsonObject, features: Set<string>, inputKinds: Set<string>): void {
  const reasoning = objectField(body, "reasoning");
  if (reasoning !== null) {
    for (const control of ["summary", "context"]) if (reasoning[control] !== undefined) features.add(`reasoning.responses.${control}`);
  }
  if (Array.isArray(body.include) && body.include.includes("reasoning.encrypted_content")) features.add("reasoning.encrypted_output");
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isJsonObject(tool) || tool.type !== "function") continue;
    features.add(tool.strict === true ? "tools.function.strict" : "tools.function");
  }
  const format = objectField(objectField(body, "text") ?? {}, "format");
  if (format !== null && format.type === "json_schema") {
    features.add("structured_output_json_schema");
    if (format.strict === true) features.add("strict_output_schema");
  }
  features.add("responses.stateless_store_false");
  features.add("responses.authoritative_cost");
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!isJsonObject(item)) continue;
    const type = isJsonString(item.type) ? item.type : "message";
    if (type === "message" && item.role === "assistant") { features.add("input.responses.assistant_history"); continue; }
    if (type === "function_call" || type === "function_call_output") { features.add("input.responses.function_history"); continue; }
    if (type === "reasoning") {
      const encrypted = item.encrypted_content;
      features.add(encrypted !== undefined && isJsonString(encrypted) && encrypted.length > 0 ? "reasoning.encrypted_input" : "input.responses.reasoning_summary_history");
      continue;
    }
    if (type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (!isJsonObject(part)) continue;
      if (part.type === "input_image" && isJsonString(part.image_url)) inputKinds.add(part.image_url.startsWith("data:") ? "input.image.inline" : "input.image.url");
      if (part.type === "input_file") {
        if (isJsonString(part.file_data)) inputKinds.add("input.document.inline");
        else if (isJsonString(part.file_url)) inputKinds.add("input.document.url");
      }
    }
  }
}

function collectInputKinds(family: ApiFamily, body: JsonObject, inputKinds: Set<string>): void {
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isJsonObject(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isJsonObject(part)) continue;
      if (family === "anthropic_messages") {
        const source = objectField(part, "source");
        if (part.type === "image" && source) inputKinds.add(source.type === "base64" ? "input.image.inline" : "input.image.url");
        if (part.type === "document" && source) inputKinds.add(source.type === "base64" ? "input.document.inline" : "input.document.url");
        continue;
      }
      if (part.type === "image_url" || part.image_url !== undefined) {
        const image = part.image_url;
        const raw = image !== undefined && isJsonObject(image) ? image.url : image;
        inputKinds.add(raw !== undefined && isJsonString(raw) && raw.startsWith("data:") ? "input.image.inline" : "input.image.url");
      }
      if (part.type === "file" || part.file !== undefined) {
        const file = objectField(part, "file") ?? {};
        inputKinds.add(file.file_data !== undefined ? "input.document.inline" : "input.document.url");
      }
    }
  }
}

function collectFeatures(family: ApiFamily, body: JsonObject, features: Set<string>, inputKinds: Set<string>): void {
  const kind = reasoningKind(family, body);
  if (kind !== "none") features.add(`reasoning_kind:${kind}`);
  if (family === "openai_responses") {
    collectResponses(body, features, inputKinds);
    return;
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isJsonObject(tool)) continue;
    const fn = objectField(tool, "function");
    if (tool.strict === true || (fn !== null && fn.strict === true)) features.add("strict_tool_schema");
  }
  const responseFormat = objectField(body, "response_format");
  if (responseFormat !== null) {
    if (responseFormat.type === "json_object") features.add("structured_output_json_object");
    if (responseFormat.type === "json_schema") {
      features.add("structured_output_json_schema");
      const schema = objectField(responseFormat, "json_schema");
      if (schema !== null && schema.strict === true) features.add("strict_output_schema");
    }
  }
  const outputConfig = objectField(body, "output_config");
  if (outputConfig !== null && outputConfig.format !== undefined) {
    features.add("structured_output_json_schema");
    const format = objectField(outputConfig, "format");
    if (format !== null && format.strict === true) features.add("strict_output_schema");
  }
  if (containsKeyDeep(body, "cache_control")) {
    features.add("cache_accounting");
    features.add("provider_reported_cost");
  }
  collectInputKinds(family, body, inputKinds);
}

const CORE_KEYS = new Set(["model", "messages", "stream", "route", "provider", "allow_fallbacks"]);

/**
 * CAT-006: the request contract the declared cases need. `[]` api_families means none
 * known; the server then stores all six planning fields as unknown (agreed with W1a).
 */
export function planningRequirements(cases: ReplayCase[]): RunnerRouteContract["request_features"] {
  const families = new Set<string>();
  const required = new Set<string>();
  const features = new Set<string>();
  const inputKinds = new Set<string>(["input.text"]);
  const protocolHeaders = new Set<string>();
  for (const testCase of cases) {
    const family = endpointFamily(testCase.endpoint);
    families.add(family);
    for (const [name, value] of Object.entries(testCase.headers)) {
      if (name === "anthropic-version") protocolHeaders.add(`anthropic-version:${value.trim()}`);
      if (name === "anthropic-beta") {
        for (const beta of value.split(",")) if (beta.trim()) protocolHeaders.add(`anthropic-beta:${beta.trim()}`);
      }
    }
    const body: JsonObject = { ...testCase.body, model: "route" };
    for (const key of Object.keys(body)) {
      if (CORE_KEYS.has(key) || isNoOpPlanningValue(family, body, key)) continue;
      required.add(key);
    }
    if (requestsJsonSchema(family, body)) required.add("structured_outputs");
    collectFeatures(family, body, features, inputKinds);
  }
  if (families.size === 0) {
    return { required_parameters: [], api_families: [], features: [], input_kinds: [], output_kinds: [], protocol_headers: [] };
  }
  return {
    required_parameters: [...required].sort(),
    api_families: [...families].sort(),
    features: [...features].sort(),
    input_kinds: [...inputKinds].sort(),
    output_kinds: ["text"],
    protocol_headers: [...protocolHeaders].sort()
  };
}
