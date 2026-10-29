// EVAL-002 / SERVE-009: the replay request body. A declared case's request is
// replayed verbatim, forced to the route id, never streamed. Its sampling controls
// stay as captured, omission included (replay semantics revision 3).
//
// design-hosted-evals §8.4: one function for the signed GitHub runtime
// (runtime/src/replay.ts; runtime/MIRROR.txt lists this file) and the Worker
// executor (src/runner/worker-executor.ts). A change here bumps the release's
// `replay_semantics_<n>` feature (runtime/package.json and
// RUNNER_REPLAY_SEMANTICS_FEATURES), so no case result carries across it.
import type { JsonObject } from "./json-parse-contracts";

export function replayRequestBody(caseBody: JsonObject, routeId: string): JsonObject {
  const body: JsonObject = { ...caseBody, model: routeId };
  delete body.stream;
  delete body.stream_options;
  return body;
}
