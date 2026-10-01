// RUN-001 / RUN-004: bounded authored repeats preserve the first request as sent.
import { isJsonFiniteNumber, isJsonObject, type JsonValue } from "./json-parse-contracts";

export interface ReplayCaseRepeatPolicy {
  critical: number;
  noncritical: 1;
  /** The seed of generation two. Generation one keeps its authored input. */
  seed_start: number;
}

export const REPLAY_CASE_REPEATS_FEATURE = "case_repeats";
export const MAX_EXPANDED_REPLAY_CASES = 5000;

export type ReplayCaseRepeatPolicyParse =
  | { ok: true; policy: ReplayCaseRepeatPolicy | null }
  | { ok: false; message: string };

export function parseReplayCaseRepeatPolicy(value: JsonValue | undefined): ReplayCaseRepeatPolicyParse {
  if (value === undefined) return { ok: true, policy: null };
  if (!isJsonObject(value)) return { ok: false, message: "case_repeats must be a mapping" };
  if (Object.keys(value).some(key => !["critical", "noncritical", "seed_start"].includes(key))) {
    return { ok: false, message: "case_repeats contains an unknown field" };
  }
  const critical = value.critical;
  const seedStart = value.seed_start;
  if (!isJsonFiniteNumber(critical) || !Number.isSafeInteger(critical) || critical < 1 || critical > 3) {
    return { ok: false, message: "case_repeats.critical must be an integer from 1 through 3" };
  }
  if (value.noncritical !== 1) return { ok: false, message: "case_repeats.noncritical must be 1" };
  if (!isJsonFiniteNumber(seedStart) || !Number.isSafeInteger(seedStart) || seedStart < 0
    || !Number.isSafeInteger(seedStart + Math.max(0, critical - 2))) {
    return { ok: false, message: "case_repeats.seed_start and every added seed must be non-negative safe integers" };
  }
  return { ok: true, policy: { critical, noncritical: 1, seed_start: seedStart } };
}
