// JSON parse contracts: optional-default vs required authoritative shapes.

export type JsonParseFailureCode = "invalid_json" | "not_object" | "wrong_shape";

export interface JsonParseError {
  code: JsonParseFailureCode;
  message: string;
}

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Optional persisted JSON blob: malformed input becomes `{}` (intentional default). */
export type OptionalJsonObject = JsonObject;

/** Required authoritative JSON: parse failures surface as structured errors. */
export type RequiredJsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: JsonParseError };

/** Legacy result-object variant used by proxy upstream body parsing until callers migrate. */
export type LegacyJsonObjectParseResult =
  | { ok: true; value: JsonObject }
  | { ok: false; value: JsonObject };

export function requiredJsonParseError(code: JsonParseFailureCode, message: string): RequiredJsonParseResult<never> {
  return { ok: false, error: { code, message } };
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonString<Value>(value: Value): value is Extract<Value, string> {
  return typeof value === "string";
}

export function isJsonFiniteNumber<Value>(value: Value): value is Extract<Value, number> {
  return typeof value === "number" && Number.isFinite(value);
}

export function isJsonBoolean<Value>(value: Value): value is Extract<Value, boolean> {
  return value === true || value === false;
}

export function parseJsonValueFromString(raw: string): RequiredJsonParseResult<JsonValue> {
  try {
    // SAFETY: JSON.parse without a reviver returns only JSON-compatible values.
    return { ok: true, value: JSON.parse(raw) as JsonValue };
  } catch {
    return requiredJsonParseError("invalid_json", "must be valid JSON");
  }
}

export function parseRequiredJsonObject(raw: string, label = "JSON"): RequiredJsonParseResult<JsonObject> {
  const parsed = parseJsonValueFromString(raw);
  if (!parsed.ok) {
    return requiredJsonParseError("invalid_json", `${label} must be valid JSON`);
  }
  if (isJsonObject(parsed.value)) {
    return { ok: true, value: parsed.value };
  }
  return requiredJsonParseError("not_object", `${label} must be a JSON object`);
}

/** Required authoritative parse for request bodies already decoded as unknown. */
export function parseRequiredJsonValue<Value>(value: Value, label = "Request body"): RequiredJsonParseResult<JsonObject> {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return requiredJsonParseError("not_object", `${label} must be a JSON object`);
    }
    return parseRequiredJsonObject(serialized, label);
  } catch {
    return requiredJsonParseError("wrong_shape", `${label} contains unsupported values`);
  }
}

/** Legacy `{ ok, value }` parser for hot-path upstream JSON where callers branch on ok. */
export function parseLegacyJsonObject(value: string): LegacyJsonObjectParseResult {
  const parsed = parseRequiredJsonObject(value);
  if (parsed.ok) {
    return { ok: true, value: parsed.value };
  }
  return { ok: false, value: {} };
}
