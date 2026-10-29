// CAT-006: the request contract a set of replay cases needs, the planning
// metadata a route snapshot carries (`request_features`). Shared by the GitHub
// runtime (runtime/src/cases.ts, mirrored by runtime/MIRROR.txt) and the hosted
// eval approval (src/hosted-evals), so both executors plan a case set the same way.
// Moved unchanged from runtime/src/cases.ts.

import type { RunnerRouteContract } from "./runner-protocol";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json-parse-contracts";

/** A declared case as planning reads it: its endpoint, protocol headers and request body. */
export interface PlannedCase {
  endpoint: string;
  headers: Record<string, string>;
  body: JsonObject;
}

/** A case endpoint that is not a replay endpoint. The runtime reports it as a protocol error. */
export class CasePlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasePlanningError";
  }
}

type ApiFamily = "openai_chat_completions" | "anthropic_messages" | "openai_responses";

function endpointFamily(endpoint: string): ApiFamily {
  let base = endpoint.split("?")[0] ?? "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  if (base.endsWith("/chat/completions")) return "openai_chat_completions";
  if (base.endsWith("/messages")) return "anthropic_messages";
  // SERVE-009: `/responses` publishes `openai_responses`; the retired `responses` value has no alias.
  if (base.endsWith("/responses")) return "openai_responses";
  throw new CasePlanningError(`Unknown eval case endpoint for candidate planning: ${endpoint}`);
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
export function planningRequirements(cases: readonly PlannedCase[]): RunnerRouteContract["request_features"] {
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
