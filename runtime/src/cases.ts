// Declared replay cases. §6.1: the runtime reads EVERY entry of `case_refs` (the old
// kit read only `case_refs[0]`). Raw cases never leave the runner (§3.8): only counts,
// hashes and the CAT-006 planning metadata do.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerRouteContract } from "../../src/shared/runner-protocol";
import { MAX_EXPANDED_REPLAY_CASES } from "../../src/shared/replay-case-repeats";
import { CasePlanningError, planningRequirements as sharedPlanningRequirements } from "../../src/shared/case-planning";
import { isJsonFiniteNumber, isJsonObject, isJsonString, parseJsonText, ProtocolError, sha256Hex, type JsonObject } from "./json";
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
// CAT-006 planning metadata: src/shared/case-planning.ts (shared with hosted evals)
// ---------------------------------------------------------------------------

/** CAT-006: the request contract the declared cases need; an unknown endpoint is a protocol error. */
export function planningRequirements(cases: ReplayCase[]): RunnerRouteContract["request_features"] {
  try {
    return sharedPlanningRequirements(cases);
  } catch (error) {
    if (error instanceof CasePlanningError) throw new ProtocolError(error.message);
    throw error;
  }
}
