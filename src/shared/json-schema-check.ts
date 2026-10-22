// EVAL-011: a dependency-free JSON Schema check (2020-12 dialect, assertion subset)
// for a judge reply. It never reports a violation it cannot prove. The runtime uses
// it to refuse a judge reply that misses its requested schema; the proxy uses the
// same check so such a reply is never written to the model-call cache (EVAL-003).
import { isJsonFiniteNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json-parse-contracts";

function objectAt(value: JsonValue | undefined): JsonObject | null {
  return value !== undefined && isJsonObject(value) ? value : null;
}

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
