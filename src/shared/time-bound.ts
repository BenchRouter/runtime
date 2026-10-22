// EVAL-011: the server-owned time bound of one model's evaluation in a result
// set: its retry chain (the model run and the runs EVAL-011 requeues after its
// temporary failures). Both execution modes are bounded.
//
// bound_s = TIME_BOUND_MULTIPLIER x (reference_s + TIME_BOUND_RUN_OVERHEAD_S), where
// reference_s is the wall time (first lease to upload) of the route baseline's
// uploaded as-sent run on the same input and acceptance fingerprints with the
// most live work. A run with no reference is bounded only by its timeouts.
//
// The chain is charged the time its model or the model's provider takes:
// leases that end in work or in a provider-side failure, the in-run waits
// before a case whose model call failed upstream runs again, and the backoff
// before a retry run after a provider-side failure. Waits caused by BenchRouter
// or GitHub (queue time, job starts, lost runners, our own errors, the judge)
// are not charged (`failureTimeSide` in src/evals/transient-failure.ts).

/**
 * EVAL-011: the bound is this multiple of the baseline's time plus the run
 * overhead. Nav, 2026-10-19: "5x seems high, but something's better than
 * nothing right now". It is the one chosen constant; lower it here.
 */
export const TIME_BOUND_MULTIPLIER = 5;

/**
 * EVAL-011: the fixed per-run overhead that does not scale with the eval's
 * work (job start inside the lease, judge, scoring, upload). Measured, not
 * chosen: the p99 of baseline wall time minus live call time / case
 * concurrency over 134 replay baseline runs in production D1, 2026-09-19 to
 * 2026-10-19 (p50 11 s, p95 47 s, p99 159 s, max 306 s; time-budget design
 * section 2b, 2026-10-19). Measure it again whenever the multiplier changes.
 */
export const TIME_BOUND_RUN_OVERHEAD_S = 159;

/** EVAL-011: the permanent cause of a chain whose charged time reached its bound. */
export const EVAL_TIME_BOUND_REACHED = "eval_time_bound_reached";

/** EVAL-011: the frozen bound for a reference wall time, or null when there is no reference. */
export function timeBoundSeconds(referenceS: number | null): number | null {
  if (referenceS === null || !Number.isFinite(referenceS) || referenceS < 0) return null;
  return TIME_BOUND_MULTIPLIER * (referenceS + TIME_BOUND_RUN_OVERHEAD_S);
}

/** EVAL-011: a stopped chain's recorded times, in seconds. */
export interface TimeBoundStop {
  used_s: number;
  bound_s: number;
  reference_s: number;
  /** Set when the chain stopped before a wait that would not fit what was left. */
  next_wait_s?: number;
}

function minutes(seconds: number): string {
  const value = seconds / 60;
  if (value < 1) return `${Math.max(0, Math.round(seconds))} s`;
  return value < 10 ? `${value.toFixed(1)} min` : `${Math.round(value)} min`;
}

/** EVAL-011: the plain reason shown for a chain stopped at its time bound. */
export function timeBoundStopCopy(stop: TimeBoundStop): string {
  const basis = `${TIME_BOUND_MULTIPLIER}× the comparison model's ${minutes(stop.bound_s / TIME_BOUND_MULTIPLIER)} for this eval`;
  const counted = "provider and model time, including failed attempts";
  if (stop.next_wait_s !== undefined) {
    return `Stopped after ${minutes(stop.used_s)}: not enough of its ${minutes(stop.bound_s)} left for the next retry (${basis}; ${counted}).`;
  }
  return `Stopped after ${minutes(stop.used_s)}: ${basis} (${counted}).`;
}
