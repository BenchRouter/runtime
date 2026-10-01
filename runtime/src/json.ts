// Boundary readers for JSON the runtime receives: protocol responses, case files and
// manifests. Every reader fails closed with a ProtocolError that names the field.
import { createHash } from "node:crypto";
import {
  isJsonBoolean,
  isJsonFiniteNumber,
  isJsonObject,
  isJsonString,
  parseJsonValueFromString,
  type JsonObject,
  type JsonValue
} from "../../src/shared/json-parse-contracts";
import { canonicalJson } from "../../src/shared/parsing";
import type { Sha256Digest } from "../../src/shared/runner-protocol";

export { canonicalJson, isJsonObject, isJsonString, isJsonFiniteNumber, isJsonBoolean };
export type { JsonObject, JsonValue };

/** A response or file that breaks its contract. The job fails visibly (§3.11). */
export class ProtocolError extends Error {}

export function parseJsonText(text: string, label: string): JsonValue {
  const parsed = parseJsonValueFromString(text);
  if (!parsed.ok) throw new ProtocolError(`${label} is not valid JSON`);
  return parsed.value;
}

export function objectOf(value: JsonValue | undefined, label: string): JsonObject {
  if (value === undefined || !isJsonObject(value)) throw new ProtocolError(`${label} must be an object`);
  return value;
}

export function readString(source: JsonObject, key: string, label: string): string {
  const value = source[key];
  if (!isJsonString(value) || value.length === 0) throw new ProtocolError(`${label}.${key} must be a non-empty string`);
  return value;
}

export function readNullableString(source: JsonObject, key: string, label: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (!isJsonString(value)) throw new ProtocolError(`${label}.${key} must be a string or null`);
  return value;
}

export function readInteger(source: JsonObject, key: string, label: string): number {
  const value = source[key];
  if (!isJsonFiniteNumber(value) || !Number.isSafeInteger(value)) throw new ProtocolError(`${label}.${key} must be an integer`);
  return value;
}

export function readPositiveInteger(source: JsonObject, key: string, label: string): number {
  const value = readInteger(source, key, label);
  if (value <= 0) throw new ProtocolError(`${label}.${key} must be positive`);
  return value;
}

export function readBoolean(source: JsonObject, key: string, label: string): boolean {
  const value = source[key];
  if (!isJsonBoolean(value)) throw new ProtocolError(`${label}.${key} must be a boolean`);
  return value;
}

export function readArray(source: JsonObject, key: string, label: string): JsonValue[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new ProtocolError(`${label}.${key} must be an array`);
  return value;
}

export function readStringList(source: JsonObject, key: string, label: string): string[] {
  return readArray(source, key, label).map((entry, index) => {
    if (!isJsonString(entry)) throw new ProtocolError(`${label}.${key}[${index}] must be a string`);
    return entry;
  });
}

export function readTimestamp(source: JsonObject, key: string, label: string): number {
  const ms = Date.parse(readString(source, key, label));
  if (!Number.isFinite(ms)) throw new ProtocolError(`${label}.${key} must be an ISO timestamp`);
  return ms;
}

export function isSha256Digest(value: string): value is Sha256Digest {
  if (value.length !== 71 || !value.startsWith("sha256:")) return false;
  for (let index = 7; index < value.length; index += 1) {
    if (!"0123456789abcdef".includes(value.charAt(index))) return false;
  }
  return true;
}

export function readDigest(source: JsonObject, key: string, label: string): Sha256Digest {
  const value = readString(source, key, label);
  if (!isSha256Digest(value)) throw new ProtocolError(`${label}.${key} must be a sha256 digest`);
  return value;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Digest(bytes: Buffer | string): Sha256Digest {
  return `sha256:${sha256Hex(bytes)}`;
}

export function stringOrEmpty(value: JsonValue | undefined): string {
  return value !== undefined && isJsonString(value) ? value : "";
}

export function finiteOrNull(value: JsonValue | undefined): number | null {
  return value !== undefined && isJsonFiniteNumber(value) ? value : null;
}

/** DATA-001: a bounded code token, or null. */
export function safeCode(value: JsonValue | undefined): string | null {
  if (value === undefined || !isJsonString(value) || value.length === 0 || value.length > 64) return null;
  for (let index = 0; index < value.length; index += 1) {
    if (!"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-".includes(value.charAt(index))) return null;
  }
  return value;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Full jitter: a uniform wait in [base/2, base * 1.5). */
export function jittered(baseMs: number): number {
  return Math.round(baseMs * (0.5 + Math.random()));
}

export function errorMessage(error: Error | string | null | undefined): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown error");
}

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
