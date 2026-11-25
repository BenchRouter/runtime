import { RUNNER_AUTO_SEND_PREFIX, RUNNER_EVAL_CALL_HEADER, type RunnerWorkItem } from "../../src/shared/runner-protocol";
import { canonicalJson, objectOf, parseJsonText, sha256Hex } from "./json";

export type ExecutableWork = Pick<RunnerWorkItem, "work_id" | "retry_attempt" | "model_run" | "call_token">;

// An executable can send identical requests more than once. A replacement child
// reconstructs each occurrence without the previous lease's bearer or process state.
export function executableSends(item: ExecutableWork) {
  const occurrences = new Map<string, number>();
  return (path: string, input: Headers, body: string): Headers | "invalid_eval_request" => {
    let digest: string;
    try {
      const encoded = input.get(RUNNER_EVAL_CALL_HEADER);
      const header = encoded ? objectOf(parseJsonText(Buffer.from(encoded, "base64url").toString(), "eval call"), "eval call")
        : { case_id: null, trial: 1, role: "model", seq: null };
      const request = objectOf(parseJsonText(body, "request body"), "request body");
      digest = sha256Hex(canonicalJson([item.model_run.model_run_id, item.work_id, item.retry_attempt, header,
        item.model_run.model, path, input.get("anthropic-version"), input.get("anthropic-beta"), request]));
    } catch {
      return "invalid_eval_request";
    }
    const provided = input.get("idempotency-key");
    let key: string;
    if (provided) {
      // The owner compares the request digest, including after a replacement child starts.
      key = "br-sdk:" + sha256Hex(canonicalJson([item.model_run.model_run_id, item.work_id, item.retry_attempt, provided]));
    } else {
      const occurrence = occurrences.get(digest) ?? 0;
      key = RUNNER_AUTO_SEND_PREFIX + sha256Hex(canonicalJson([digest, occurrence]));
      occurrences.set(digest, occurrence + 1);
    }
    const headers = new Headers({ authorization: "Bearer " + item.call_token, "content-type": "application/json", "idempotency-key": key });
    for (const field of ["anthropic-version", "anthropic-beta", RUNNER_EVAL_CALL_HEADER]) {
      const value = input.get(field);
      if (value !== null) headers.set(field, value);
    }
    return headers;
  };
}
