// EVAL-002 / EVAL-003: how an uploaded replay run's cases got their evidence, and
// the one line that names it in the job summary (runtime) and on the dashboard.
import { isJsonFiniteNumber, isJsonObject, type JsonObject, type JsonValue } from "./json-parse-contracts";

/**
 * `cases_called` cases called a model; `cases_rescored` cases re-scored a cached
 * model output with the current scorer and called no provider. Every case is
 * scored by the run's own scorer. The judge counts are the run's judge calls,
 * live or replayed from the cache.
 */
export interface CaseReuse {
  cases_called: number;
  cases_rescored: number;
  judge_calls_called: number;
  judge_calls_reused: number;
}

function count(fields: JsonObject, name: keyof CaseReuse | "pass_count" | "case_count"): number | null {
  const raw = fields[name];
  return isJsonFiniteNumber(raw) && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

/** A stored count object, or null unless every count is a non-negative integer. */
export function parseCaseReuse(value: JsonValue | undefined): CaseReuse | null {
  if (value === undefined || !isJsonObject(value)) return null;
  const called = count(value, "cases_called");
  const rescored = count(value, "cases_rescored");
  const judgeCalled = count(value, "judge_calls_called");
  const judgeReused = count(value, "judge_calls_reused");
  if (called === null || rescored === null || judgeCalled === null || judgeReused === null) return null;
  return { cases_called: called, cases_rescored: rescored, judge_calls_called: judgeCalled, judge_calls_reused: judgeReused };
}

/** A stored run summary (RUN-001 receipt): the case reuse counts and the run's pass and case counts. */
export function parseCaseReuseSummary(value: JsonValue | undefined): (CaseReuse & { pass_count: number; case_count: number }) | null {
  const reuse = parseCaseReuse(value);
  if (reuse === null || value === undefined || !isJsonObject(value)) return null;
  const passCount = count(value, "pass_count");
  const caseCount = count(value, "case_count");
  if (passCount === null || caseCount === null || caseCount < passCount) return null;
  return { pass_count: passCount, case_count: caseCount, ...reuse };
}

/** Whole numbers of a run, for example `3 called models, 19 reused from cache and re-scored; judge calls: 3 called, 19 reused`. */
export function caseReuseLine(reuse: CaseReuse): string {
  const judgeCalls = reuse.judge_calls_called + reuse.judge_calls_reused;
  const cases = `${reuse.cases_called} called models, ${reuse.cases_rescored} reused from cache and re-scored`;
  return judgeCalls === 0 ? cases : `${cases}; judge calls: ${reuse.judge_calls_called} called, ${reuse.judge_calls_reused} reused`;
}
