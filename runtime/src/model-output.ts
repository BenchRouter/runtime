// EVAL-002 / SERVE-008 / SERVE-009: reading a replayed model response: the per-protocol
// extraction of text, tool calls, refusal and finish reason, and the two outcome codes
// that state a protocol fact (the output limit ended the answer; the answer has no
// content). The runner forms no opinion of what a model answered: the customer's scorer
// is the only judge. EVAL-011: the JSON-schema check below is for a judge reply only.
import { isJsonFiniteNumber, isJsonObject, isJsonString, stringOrEmpty, type JsonObject, type JsonValue } from "./json";

export const OUTCOME = {
  outputEmpty: "output_empty",
  outputCutOff: "output_cut_off"
} as const;

export type JsonFormat = { kind: "json_schema"; schema: JsonValue } | { kind: "json_object" } | { kind: "json" };

function objectAt(value: JsonValue | undefined): JsonObject | null {
  return value !== undefined && isJsonObject(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Responses (SERVE-009)
// ---------------------------------------------------------------------------

export interface ResponsesExtraction {
  object: "response";
  status: string | null;
  output: JsonValue;
  text: string;
  tool_calls: JsonObject[];
  refusal: string | null;
  structured_output: string | null;
  unsupported_items: string[];
}

export function extractResponsesOutput(parsed: JsonObject): ResponsesExtraction {
  const text: string[] = [];
  const toolCalls: JsonObject[] = [];
  const refusals: string[] = [];
  const unsupported: string[] = [];
  for (const item of Array.isArray(parsed.output) ? parsed.output : []) {
    if (!isJsonObject(item)) { unsupported.push("malformed_item"); continue; }
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!isJsonObject(part)) continue;
        if (part.type === "output_text" && isJsonString(part.text)) text.push(part.text);
        else if (part.type === "refusal" && isJsonString(part.refusal)) refusals.push(part.refusal);
        else unsupported.push(`content_part:${String(part.type)}`);
      }
      continue;
    }
    if (item.type === "function_call") {
      toolCalls.push({ call_id: item.call_id ?? null, name: item.name ?? null, arguments: item.arguments ?? null });
      continue;
    }
    // A reasoning item is native output but not a scorer input.
    if (item.type === "reasoning") continue;
    unsupported.push(`item:${String(item.type)}`);
  }
  return {
    object: "response",
    status: isJsonString(parsed.status) ? parsed.status : null,
    output: parsed.output ?? null,
    text: text.join(""),
    tool_calls: toolCalls,
    refusal: refusals[0] ?? null,
    structured_output: refusals.length === 0 && text.length > 0 ? text.join("") : null,
    unsupported_items: unsupported
  };
}

/** The full assistant message as JSON, lossless for re-judge and tool-calling routes. */
export function extractAssistantMessage(parsed: JsonObject): string {
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const message = objectAt(objectAt(choices[0])?.message);
  if (message) return JSON.stringify(message);
  if (Array.isArray(parsed.output)) return JSON.stringify(extractResponsesOutput(parsed));
  // Anthropic Messages: the content blocks are the assistant message.
  if (Array.isArray(parsed.content)) return JSON.stringify({ role: "assistant", content: parsed.content, stop_reason: parsed.stop_reason ?? null });
  return "";
}

/** A stored value as an assistant-message envelope, or null (a plain content string). */
export function parseMessage(stored: JsonValue | undefined): JsonObject | null {
  if (stored === undefined || !isJsonString(stored) || stored.length === 0) return null;
  try {
    const value: JsonValue = JSON.parse(stored);
    if (isJsonObject(value) && ("content" in value || "tool_calls" in value || "role" in value || value.object === "response")) return value;
  } catch {
    // A plain content string.
  }
  return null;
}

/** The model's text for the scorer: Chat content, Responses output text, or Messages text blocks. */
export function messageContent(stored: JsonValue | undefined): string {
  if (stored === undefined || !isJsonString(stored)) return "";
  const message = parseMessage(stored);
  if (!message) return stored;
  if (message.object === "response") {
    // A replayed reply carries the extracted text; a captured reference keeps the raw output items.
    if (isJsonString(message.text)) return message.text;
    return extractResponsesOutput(message).text;
  }
  const content = message.content;
  if (content !== undefined && isJsonString(content)) return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isJsonObject(part) && (part.type === "text" || part.type === "output_text") && isJsonString(part.text) ? part.text : "")).join("");
  }
  return "";
}

/** SERVE-008: "length" whenever the protocol says the output limit ended the answer. */
export function completionFinishReason(parsed: JsonObject): string | null {
  const choice = objectAt(Array.isArray(parsed.choices) ? parsed.choices[0] : undefined);
  if (choice && isJsonString(choice.finish_reason)) return choice.finish_reason;
  if (Array.isArray(parsed.output) && isJsonString(parsed.status)) {
    const incomplete = objectAt(parsed.incomplete_details);
    return parsed.status === "incomplete" && incomplete?.reason === "max_output_tokens" ? "length" : parsed.status;
  }
  if (isJsonString(parsed.stop_reason)) return parsed.stop_reason === "max_tokens" ? "length" : parsed.stop_reason;
  return null;
}

interface Answer {
  text: string;
  hasToolCalls: boolean;
  hasRefusal: boolean;
}

function responseAnswer(parsed: JsonObject): Answer {
  const choice = objectAt(Array.isArray(parsed.choices) ? parsed.choices[0] : undefined);
  const message = objectAt(choice?.message);
  if (message) {
    const content = message.content;
    const text = isJsonString(content) ? content
      : Array.isArray(content) ? content.map((part) => (isJsonObject(part) && isJsonString(part.text) ? part.text : "")).join("") : "";
    return {
      text,
      hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
      hasRefusal: isJsonString(message.refusal) && message.refusal.length > 0
    };
  }
  if (Array.isArray(parsed.output)) {
    const extracted = extractResponsesOutput(parsed);
    return { text: extracted.text, hasToolCalls: extracted.tool_calls.length > 0, hasRefusal: extracted.refusal !== null };
  }
  if (Array.isArray(parsed.content)) {
    const blocks = parsed.content.filter(isJsonObject);
    return {
      text: blocks.map((block) => (block.type === "text" && isJsonString(block.text) ? block.text : "")).join(""),
      hasToolCalls: blocks.some((block) => block.type === "tool_use"),
      hasRefusal: parsed.stop_reason === "refusal"
    };
  }
  return { text: "", hasToolCalls: false, hasRefusal: false };
}

/** Chat Completions nests the schema under `json_schema.schema`. */
export function jsonResponseFormat(value: JsonValue | undefined): JsonFormat | null {
  const format = objectAt(value);
  if (!format) return null;
  const type = stringOrEmpty(format.type).toLowerCase();
  if (type === "json_schema") {
    const jsonSchema = objectAt(format.json_schema);
    return jsonSchema && jsonSchema.schema !== undefined ? { kind: "json_schema", schema: jsonSchema.schema } : { kind: "json" };
  }
  return type === "json_object" ? { kind: "json_object" } : null;
}

/** EVAL-011: why a judge reply does not satisfy the format its scorer asked for, or null when it does or cannot be proven. */
export function jsonFormatViolation(format: JsonFormat | null, text: string): string | null {
  if (!format) return null;
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    return "is not valid JSON";
  }
  if (format.kind === "json_object" && !isJsonObject(value)) return "is not a JSON object";
  if (format.kind === "json_schema") {
    const checked = validateJsonSchema(format.schema, value);
    if (checked.status === "invalid") return `violates the requested JSON schema at ${checked.path || "/"}`;
  }
  return null;
}

/**
 * EVAL-002: the protocol fact that explains a failed case, or null. It never reads the
 * request or what the answer says, so it cannot disagree with the scorer.
 */
export function structuralOutcome(parsed: JsonObject, finishReason: string | null): { code: string; message: string } | null {
  if (finishReason === "length") return { code: OUTCOME.outputCutOff, message: `${OUTCOME.outputCutOff}: the model reached its output limit (finish_reason=length)` };
  const answer = responseAnswer(parsed);
  if (answer.hasRefusal || answer.hasToolCalls || answer.text.trim().length > 0) return null;
  return { code: OUTCOME.outputEmpty, message: `${OUTCOME.outputEmpty}: the model returned no content` };
}

// ---------------------------------------------------------------------------
// EVAL-011: a dependency-free JSON Schema check (2020-12 dialect, assertion subset)
// for a judge reply. It never reports a violation it cannot prove.
// ---------------------------------------------------------------------------

const ANNOTATIONS = new Set(["$schema", "$comment", "$anchor", "$defs", "definitions", "title", "description", "default", "examples", "format", "deprecated", "readOnly", "writeOnly", "contentEncoding", "contentMediaType", "strict"]);
const ASSERTIONS = new Set(["$ref", "type", "enum", "const", "properties", "required", "additionalProperties", "minProperties", "maxProperties", "items", "prefixItems", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "allOf", "anyOf", "oneOf", "not"]);
const REF_SIBLINGS = new Set(["$ref", "$schema", "$comment", "$defs", "definitions", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly"]);
const DEFAULT_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const MAX_DEPTH = 64;
const MAX_EVALUATIONS = 100_000;

class BudgetExhausted extends Error {}

export type SchemaCheck = { status: "valid" } | { status: "invalid"; path: string } | { status: "unknown" };

function numeric(value: JsonValue | undefined): number | null {
  return value !== undefined && isJsonFiniteNumber(value) ? value : null;
}

export function validateJsonSchema(root: JsonValue, value: JsonValue): SchemaCheck {
  let unknown = false;
  let evaluations = 0;
  function resolveRef(ref: JsonValue | undefined): JsonValue | undefined {
    if (ref === undefined || !isJsonString(ref) || !ref.startsWith("#")) return undefined;
    if (ref === "#") return root;
    if (!ref.startsWith("#/")) return undefined;
    let node: JsonValue = root;
    for (const part of ref.slice(2).split("/")) {
      const key = decodeURIComponent(part).split("~1").join("/").split("~0").join("~");
      if (!isJsonObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
      const next: JsonValue | undefined = node[key];
      if (next === undefined) return undefined;
      node = next;
    }
    return node;
  }
  function typeOf(item: JsonValue): string {
    if (item === null) return "null";
    if (Array.isArray(item)) return "array";
    if (isJsonFiniteNumber(item)) return Number.isInteger(item) ? "integer" : "number";
    if (isJsonString(item)) return "string";
    if (isJsonObject(item)) return "object";
    return "boolean";
  }
  function canonical(item: JsonValue): JsonValue {
    if (Array.isArray(item)) return item.map(canonical);
    if (isJsonObject(item)) {
      const sorted: JsonObject = Object.create(null);
      for (const key of Object.keys(item).sort()) sorted[key] = canonical(item[key] ?? null);
      return sorted;
    }
    return item;
  }
  const same = (left: JsonValue, right: JsonValue) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  const childPath = (at: string, key: string | number) => `${at}/${String(key).split("~").join("~0").split("/").join("~1")}`;
  const matches = (schema: JsonValue, item: JsonValue, depth: number) => check(schema, item, "", depth) === null;
  function check(schema: JsonValue, item: JsonValue, at: string, depth: number): string | null {
    if (unknown) return null;
    evaluations += 1;
    if (evaluations > MAX_EVALUATIONS) throw new BudgetExhausted();
    if (depth > MAX_DEPTH) { unknown = true; return null; }
    if (schema === true) return null;
    if (schema === false) return at;
    if (!isJsonObject(schema)) { unknown = true; return null; }
    for (const key of Object.keys(schema)) {
      if (!ASSERTIONS.has(key) && !ANNOTATIONS.has(key)) { unknown = true; return null; }
    }
    const dialect = schema.$schema;
    if (dialect !== undefined && (!isJsonString(dialect) || (dialect !== DEFAULT_DIALECT && dialect !== `${DEFAULT_DIALECT}#`))) { unknown = true; return null; }
    if (schema.$ref !== undefined && Object.keys(schema).some((key) => !REF_SIBLINGS.has(key))) { unknown = true; return null; }
    if (schema.$ref !== undefined) {
      const target = resolveRef(schema.$ref);
      if (target === undefined) { unknown = true; return null; }
      const failed = check(target, item, at, depth + 1);
      if (failed !== null) return failed;
    }
    const actual = typeOf(item);
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => type === actual || (type === "number" && actual === "integer"))) return at;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, item))) return at;
    if (schema.const !== undefined && !same(schema.const, item)) return at;
    if (isJsonString(item)) {
      const length = Array.from(item).length;
      const min = numeric(schema.minLength);
      const max = numeric(schema.maxLength);
      if (min !== null && length < min) return at;
      if (max !== null && length > max) return at;
    }
    if (isJsonFiniteNumber(item)) {
      const minimum = numeric(schema.minimum);
      const maximum = numeric(schema.maximum);
      const exclusiveMinimum = numeric(schema.exclusiveMinimum);
      const exclusiveMaximum = numeric(schema.exclusiveMaximum);
      const multipleOf = numeric(schema.multipleOf);
      if (minimum !== null && item < minimum) return at;
      if (maximum !== null && item > maximum) return at;
      if (exclusiveMinimum !== null && item <= exclusiveMinimum) return at;
      if (exclusiveMaximum !== null && item >= exclusiveMaximum) return at;
      if (multipleOf !== null && multipleOf > 0) {
        const quotient = item / multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return at;
      }
    }
    if (Array.isArray(item)) {
      const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : [];
      for (let index = 0; index < item.length; index += 1) {
        const itemSchema = index < prefix.length ? prefix[index] : schema.items !== undefined && !Array.isArray(schema.items) ? schema.items : undefined;
        const entry = item[index];
        if (itemSchema === undefined || entry === undefined) continue;
        const failed = check(itemSchema, entry, childPath(at, index), depth + 1);
        if (failed !== null) return failed;
      }
      const minItems = numeric(schema.minItems);
      const maxItems = numeric(schema.maxItems);
      if (minItems !== null && item.length < minItems) return at;
      if (maxItems !== null && item.length > maxItems) return at;
      if (schema.uniqueItems === true && new Set(item.map((entry) => JSON.stringify(canonical(entry)))).size !== item.length) return at;
    }
    if (isJsonObject(item)) {
      const keys = Object.keys(item);
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (isJsonString(key) && !Object.prototype.hasOwnProperty.call(item, key)) return childPath(at, key);
        }
      }
      const properties = objectAt(schema.properties) ?? {};
      for (const key of keys) {
        const covered = Object.prototype.hasOwnProperty.call(properties, key);
        const entry = item[key] ?? null;
        const property = properties[key];
        if (covered && property !== undefined) {
          const failed = check(property, entry, childPath(at, key), depth + 1);
          if (failed !== null) return failed;
        }
        if (!covered && schema.additionalProperties !== undefined) {
          const failed = check(schema.additionalProperties, entry, childPath(at, key), depth + 1);
          if (failed !== null) return failed;
        }
      }
      const minProperties = numeric(schema.minProperties);
      const maxProperties = numeric(schema.maxProperties);
      if (minProperties !== null && keys.length < minProperties) return at;
      if (maxProperties !== null && keys.length > maxProperties) return at;
    }
    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) {
        const failed = check(branch, item, at, depth + 1);
        if (failed !== null) return failed;
      }
    }
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => matches(branch, item, depth + 1))) return at;
    if (Array.isArray(schema.oneOf) && schema.oneOf.filter((branch) => matches(branch, item, depth + 1)).length !== 1) return at;
    if (schema.not !== undefined && matches(schema.not, item, depth + 1)) return at;
    return null;
  }
  let failedPath: string | null;
  try {
    failedPath = check(root, value, "", 0);
  } catch {
    // The budget ran out or the check failed (for example a stack overflow): unknown, never a failure.
    return { status: "unknown" };
  }
  if (unknown) return { status: "unknown" };
  return failedPath === null ? { status: "valid" } : { status: "invalid", path: failedPath };
}
