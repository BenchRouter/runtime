// Deterministic mutation certification for local `calibrate` (RUN-001), ported from the
// old kit's calibrate command (itself a copy of test/mutation-cert/). From each case's
// reference output it builds labeled mutations: CORRUPTIONS a strong scorer must fail
// and PRESERVATIONS it must pass. A field path is CARDINAL when it is present and
// non-null in every object seen at that path across all cases; corruptions of other
// fields are ADVISORY and do not count toward the result.
import { isJsonFiniteNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json";

const MAX_MUTATIONS = 120;

export type MutationClass = "corruption" | "preservation";
export type MutationKind = "structural" | "semantic" | "format" | "identity";

export interface Mutation {
  id: string;
  class: MutationClass;
  kind: MutationKind;
  description: string;
  output: string;
  advisory?: boolean;
  assumesOrderInsensitive?: boolean;
}

type PathSegment = string | number;

function isIndex(segment: PathSegment): segment is number {
  return typeof segment === "number";
}

/** A parsed JSON object or array: the only values mutated field by field. */
export function isContainer(value: JsonValue): value is JsonObject | JsonValue[] {
  return Array.isArray(value) || isJsonObject(value);
}

function childAt(node: JsonValue | undefined, segment: PathSegment): JsonValue | undefined {
  if (node === undefined) return undefined;
  if (Array.isArray(node)) return isIndex(segment) ? node[segment] : undefined;
  if (isJsonObject(node)) return isIndex(segment) ? node[String(segment)] : node[segment];
  return undefined;
}

function getAtPath(root: JsonValue, segments: PathSegment[]): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;
    current = childAt(current, segment);
  }
  return current;
}

interface Slot {
  parent: JsonObject | JsonValue[];
  segment: PathSegment;
}

function parentOf(root: JsonValue, segments: PathSegment[]): Slot | null {
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  const parent = getAtPath(root, segments.slice(0, -1));
  if (parent === undefined || !isContainer(parent)) return null;
  return { parent, segment: last };
}

function setSlot(slot: Slot, value: JsonValue): void {
  if (Array.isArray(slot.parent)) {
    if (isIndex(slot.segment)) slot.parent[slot.segment] = value;
  } else {
    slot.parent[String(slot.segment)] = value;
  }
}

function removeSlot(slot: Slot): void {
  if (Array.isArray(slot.parent)) {
    if (isIndex(slot.segment)) slot.parent.splice(slot.segment, 1);
  } else {
    delete slot.parent[String(slot.segment)];
  }
}

function pathLabel(segments: PathSegment[]): string {
  return segments.length === 0 ? "$" : `$.${segments.map((segment) => (isIndex(segment) ? `[${segment}]` : segment)).join(".")}`;
}

function normalizePath(segments: PathSegment[]): string {
  let out = "$";
  for (const segment of segments) out += isIndex(segment) ? "[*]" : `.${segment}`;
  return out;
}

function clone(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function wrongTypeValue(value: JsonValue | undefined): JsonValue {
  if (value === undefined) return null;
  if (isJsonString(value)) return 12345;
  if (isJsonFiniteNumber(value)) return "not-a-number";
  if (value === true || value === false) return "true";
  if (Array.isArray(value)) return {};
  if (isJsonObject(value)) return [];
  return 0;
}

/** The old kit's `/^[A-Z][A-Z0-9_]*$/`: an enum-like upper-case token. */
function isEnumToken(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const upper = char >= "A" && char <= "Z";
    if (index === 0 ? !upper : !(upper || (char >= "0" && char <= "9") || char === "_")) return false;
  }
  return true;
}

function corruptString(value: string): { value: string; kind: MutationKind; label: string } | null {
  if (isEnumToken(value)) return { value: `${value}_INVALID`, kind: "structural", label: "invalid-enum" };
  if (value.length >= 2) {
    const chars = value.split("");
    for (let index = 0; index < chars.length - 1; index += 1) {
      const current = chars[index] ?? "";
      const next = chars[index + 1] ?? "";
      if (current !== next) {
        chars[index] = next;
        chars[index + 1] = current;
        return { value: chars.join(""), kind: "semantic", label: "value-corrupt" };
      }
    }
    return { value: `${value}X`, kind: "semantic", label: "value-corrupt" };
  }
  if (value.length === 1) return { value: `${value}X`, kind: "semantic", label: "value-corrupt" };
  return null;
}

function reorderKeys(node: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(node).reverse()) {
    const value = node[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface FieldStats {
  objectCount: Map<string, number>;
  presentNonNull: Map<string, number>;
  containerOfField: Map<string, string>;
}

function collectStats(node: JsonValue, segments: PathSegment[], stats: FieldStats): void {
  if (isJsonObject(node)) {
    const container = normalizePath(segments);
    stats.objectCount.set(container, (stats.objectCount.get(container) ?? 0) + 1);
    for (const key of Object.keys(node)) {
      const fieldPath = normalizePath([...segments, key]);
      stats.containerOfField.set(fieldPath, container);
      const value = node[key];
      if (value !== undefined && value !== null) stats.presentNonNull.set(fieldPath, (stats.presentNonNull.get(fieldPath) ?? 0) + 1);
      if (value !== undefined) collectStats(value, [...segments, key], stats);
    }
  } else if (Array.isArray(node)) {
    node.forEach((child, index) => collectStats(child, [...segments, index], stats));
  }
}

function parseContainer(text: string): JsonObject | JsonValue[] | null {
  try {
    const parsed: JsonValue = JSON.parse(text);
    return isContainer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function computeCardinalPaths(referenceContents: string[]): Set<string> {
  const stats: FieldStats = { objectCount: new Map(), presentNonNull: new Map(), containerOfField: new Map() };
  for (const content of referenceContents) {
    // Free-text references have no structured field paths.
    const parsed = parseContainer(content);
    if (parsed !== null) collectStats(parsed, [], stats);
  }
  const cardinal = new Set<string>();
  for (const [fieldPath, present] of stats.presentNonNull) {
    const container = stats.containerOfField.get(fieldPath);
    if (!container) continue;
    const total = stats.objectCount.get(container) ?? 0;
    if (total > 0 && present === total) cardinal.add(fieldPath);
  }
  return cardinal;
}

function emitFieldMutations(parsed: JsonValue, segments: PathSegment[], cardinal: Set<string>, out: Mutation[]): void {
  const value = getAtPath(parsed, segments);
  const at = pathLabel(segments);
  const advisory = !cardinal.has(normalizePath(segments));
  for (const op of ["remove", "null", "wrong-type"] as const) {
    const mutated = clone(parsed);
    const slot = parentOf(mutated, segments);
    if (!slot) continue;
    if (op === "remove") {
      removeSlot(slot);
      out.push({ id: `corruption:remove:${at}`, class: "corruption", kind: "structural", description: `remove field ${at}`, output: JSON.stringify(mutated), advisory });
    } else if (op === "null") {
      setSlot(slot, null);
      out.push({ id: `corruption:null:${at}`, class: "corruption", kind: "structural", description: `null out field ${at}`, output: JSON.stringify(mutated), advisory });
    } else {
      setSlot(slot, wrongTypeValue(value));
      out.push({ id: `corruption:wrong-type:${at}`, class: "corruption", kind: "structural", description: `wrong type for field ${at}`, output: JSON.stringify(mutated), advisory });
    }
  }
  if (value !== undefined && isJsonString(value)) {
    const corrupt = corruptString(value);
    if (corrupt) {
      const mutated = clone(parsed);
      const slot = parentOf(mutated, segments);
      if (slot) {
        setSlot(slot, corrupt.value);
        out.push({ id: `corruption:${corrupt.label}:${at}`, class: "corruption", kind: corrupt.kind, description: `${corrupt.label} at ${at}`, output: JSON.stringify(mutated), advisory });
      }
    }
  } else if (value !== undefined && isJsonFiniteNumber(value)) {
    const mutated = clone(parsed);
    const slot = parentOf(mutated, segments);
    if (slot) {
      setSlot(slot, value + 1);
      out.push({ id: `corruption:value-corrupt:${at}`, class: "corruption", kind: "semantic", description: `value-corrupt number at ${at}`, output: JSON.stringify(mutated), advisory });
    }
  }
}

function walkStructured(parsed: JsonValue, segments: PathSegment[], cardinal: Set<string>, out: Mutation[]): void {
  if (out.length >= MAX_MUTATIONS) return;
  const node = getAtPath(parsed, segments);
  if (node !== undefined && isJsonObject(node)) {
    for (const key of Object.keys(node)) {
      if (out.length >= MAX_MUTATIONS) return;
      emitFieldMutations(parsed, [...segments, key], cardinal, out);
      walkStructured(parsed, [...segments, key], cardinal, out);
    }
    if (Object.keys(node).length >= 2) {
      const mutated = clone(parsed);
      const slot = parentOf(mutated, segments);
      const label = pathLabel(segments);
      if (segments.length === 0 && isJsonObject(mutated)) {
        out.push({ id: `preservation:reorder-keys:${label}`, class: "preservation", kind: "format", description: `reorder object keys at ${label}`, output: JSON.stringify(reorderKeys(mutated)) });
      } else if (slot) {
        setSlot(slot, reorderKeys(node));
        out.push({ id: `preservation:reorder-keys:${label}`, class: "preservation", kind: "format", description: `reorder object keys at ${label}`, output: JSON.stringify(mutated) });
      }
    }
  } else if (Array.isArray(node)) {
    const label = pathLabel(segments);
    if (node.length >= 1) {
      const mutated = clone(parsed);
      const array = getAtPath(mutated, segments);
      if (Array.isArray(array)) array.splice(0, 1);
      out.push({ id: `corruption:drop-array-elem:${label}`, class: "corruption", kind: "semantic", description: `drop first element of array ${label}`, output: JSON.stringify(mutated), advisory: !cardinal.has(normalizePath(segments)) });
    }
    if (node.length >= 2) {
      const mutated = clone(parsed);
      const array = getAtPath(mutated, segments);
      if (Array.isArray(array)) array.reverse();
      out.push({ id: `preservation:reorder-array:${label}`, class: "preservation", kind: "format", description: `reverse array order at ${label}`, output: JSON.stringify(mutated), advisory: true, assumesOrderInsensitive: true });
    }
    if (node.length >= 1) walkStructured(parsed, [...segments, 0], cardinal, out);
  }
}

/** The old kit's `text.trim().split(/\s+/)[0]`: `trim()` strips exactly the `\s` set. */
function firstWord(text: string): string {
  const trimmed = text.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed.charAt(index).trim().length === 0) return trimmed.slice(0, index);
  }
  return trimmed;
}

export function generateMutations(referenceContent: string, cardinal: Set<string>): Mutation[] {
  const out: Mutation[] = [{ id: "preservation:identity", class: "preservation", kind: "identity", description: "unchanged reference (known-good output)", output: referenceContent }];
  const parsed = parseContainer(referenceContent);
  if (parsed !== null) {
    walkStructured(parsed, [], cardinal, out);
  } else {
    const word = firstWord(referenceContent);
    if (word.length > 0 && word !== referenceContent) {
      out.push({ id: "corruption:text-truncated-word", class: "corruption", kind: "semantic", description: "keep only the first word", output: word });
    }
  }
  out.push({ id: "corruption:empty-output", class: "corruption", kind: "structural", description: "empty output", output: "" });
  if (referenceContent.length >= 4) {
    out.push({ id: "corruption:truncated", class: "corruption", kind: "structural", description: "truncated to first half", output: referenceContent.slice(0, Math.floor(referenceContent.length / 2)) });
  }
  out.push({ id: "corruption:injected-prose", class: "corruption", kind: "structural", description: "prepend conversational prose", output: `Sure! Here is the result:\n${referenceContent}` });
  out.push({ id: "corruption:unrelated", class: "corruption", kind: "semantic", description: "replace with an unrelated answer", output: "I'm sorry, I can't help with that request." });
  if (parsed !== null && referenceContent.length >= 2) {
    out.push({ id: "corruption:broken-json", class: "corruption", kind: "structural", description: "drop the final character (breaks JSON)", output: referenceContent.slice(0, -1) });
  }
  if (parsed !== null) {
    const compact = JSON.stringify(parsed);
    if (compact !== referenceContent) out.push({ id: "preservation:whitespace-compact", class: "preservation", kind: "format", description: "minified JSON", output: compact });
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty !== referenceContent && pretty !== compact) out.push({ id: "preservation:whitespace-pretty", class: "preservation", kind: "format", description: "pretty JSON", output: pretty });
  } else {
    out.push({ id: "preservation:trailing-newline", class: "preservation", kind: "format", description: "add trailing newline", output: `${referenceContent}\n` });
    out.push({ id: "preservation:surrounding-space", class: "preservation", kind: "format", description: "add surrounding whitespace", output: `  ${referenceContent}  ` });
  }
  const byKey = new Map<string, Mutation>();
  for (const mutation of out) {
    const key = `${mutation.class} ${mutation.output}`;
    const existing = byKey.get(key);
    if (!existing || (existing.advisory && !mutation.advisory)) byKey.set(key, mutation);
  }
  return [...byKey.values()];
}
