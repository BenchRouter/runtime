import {
  isJsonBoolean,
  isJsonFiniteNumber,
  isJsonObject,
  isJsonString,
  parseJsonValueFromString,
  type JsonObject,
  type OptionalJsonObject
} from "./json-parse-contracts";

/** Optional-default parser contract: malformed persisted JSON becomes `{}`. */
export function parseJsonObject(value: string): OptionalJsonObject {
  const parsed = parseJsonValueFromString(value);
  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : {};
}

export function stringField<Value>(value: Value): string | null {
  return isJsonString(value) && value.length > 0 ? value : null;
}

export function semverStringField<Value>(value: Value): string | null {
  return isJsonString(value) && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

export function recordField<Value>(value: Value): JsonObject {
  return isRecord(value) ? value : {};
}

export function stringArrayField<Value>(value: Value): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => isJsonString(item) && item.length > 0)
    : [];
}

export function stringArrayFromJson(value: string): string[] {
  const parsed = parseJsonValueFromString(value);
  return parsed.ok ? stringArrayField(parsed.value) : [];
}

export function numberField<Value>(value: Value): number | null {
  return isJsonFiniteNumber(value) ? value : null;
}

export function booleanField<Value>(value: Value): boolean | null {
  return isJsonBoolean(value) ? value : null;
}

export function positiveIntegerField<Value>(value: Value): number | null {
  const textValue = stringField(value);
  const parsedTextValue = textValue && /^[1-9]\d*$/.test(textValue) ? Number(textValue) : null;
  const numberValue = numberField(value) ?? parsedTextValue;
  return numberValue !== null && Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.floor(value)));
}

export function isRecord<Value>(value: Value): value is Value & JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject<Value>(value: Value & JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (field !== undefined) result[key] = field;
  }
  return result;
}

export function isNumber<Value>(value: Value): value is Extract<Value, number> {
  return isJsonFiniteNumber(value);
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function percentile95(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? sorted[sorted.length - 1] ?? null;
}

export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function isGitCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

export function canonicalJson<Value>(value: Value): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

interface D1MutationResult {
  meta?: {
    changes?: number;
  };
}

export function d1Changes(result: D1MutationResult): number {
  return result.meta?.changes ?? 0;
}
