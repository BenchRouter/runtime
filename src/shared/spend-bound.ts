// EVAL-012: the server-owned dollar bound of a repository_executable model run.
// Customer code is the runaway source (a loop in the eval), so only executable
// runs are bounded; isolated replay runs BenchRouter's own code.
//
// bound_usd = SPEND_BOUND_MULTIPLIER x reference_usd, with no floor, where
// reference_usd is the measured server cost of the route baseline's uploaded
// run with the most live work on the same input and acceptance fingerprints
// (src/evals/spend-bound.ts). A reference of $0 or less is no reference: the
// run is unbounded except for its timeout. Over 30 days of production
// (2026-10-19), 5x alone would have stopped 29 of 2,147 candidate runs, all far
// above the EVAL-004 promotion cost gate (at most 110% of the baseline),
// spending at most $0.10 each and $0.93 in total; none could have been promoted.

/** EVAL-012: the bound is this multiple of the baseline's measured spend. */
export const SPEND_BOUND_MULTIPLIER = 5;

/** EVAL-012: the proxy's permanent code when an executable run's spend reached its bound. */
export const REPOSITORY_EVAL_SPEND_BOUND_REACHED = "repository_eval_spend_bound_reached";

/** EVAL-012: the frozen bound of a run with a positive reference, or null when there is none. */
export function spendBoundUsd(referenceUsd: number | null): number | null {
  // A $0 reference (a free baseline model) would stop every candidate at once.
  if (referenceUsd === null || !Number.isFinite(referenceUsd) || referenceUsd <= 0) return null;
  return SPEND_BOUND_MULTIPLIER * referenceUsd;
}

/** EVAL-012: a stopped run's recorded amounts, in USD. */
export interface SpendBoundStop {
  spent_usd: number;
  bound_usd: number;
  reference_usd: number;
}

function usd(value: number): string {
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** EVAL-012: the plain reason shown for a run stopped at its spend bound. */
export function spendBoundStopCopy(stop: SpendBoundStop): string {
  return `Stopped at ${usd(stop.spent_usd)}: ${SPEND_BOUND_MULTIPLIER}× the baseline's ${usd(stop.reference_usd)} for this eval. Check the eval code for a loop.`;
}
