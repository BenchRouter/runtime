// SERVE-004 / DATA-001: why an upstream model rejected a request, as fixed
// vocabulary only. The kind is one of a closed list. The parameter is kept only
// when it is exactly one of the request parameter paths listed here. No
// provider message, value, or schema key is ever part of a reason.

import { isJsonObject, isJsonString, type JsonValue } from "./json-parse-contracts";

export const REJECTION_KINDS = [
  "response_schema",
  "tool_schema",
  "unsupported_parameter",
  "context_too_long",
  "content_policy",
  "other"
] as const;
export type RejectionKind = (typeof REJECTION_KINDS)[number];

export interface RejectionReason {
  kind: RejectionKind;
  /** A path from `REJECTION_PARAM_PATHS`, or null. */
  param: string | null;
}

/**
 * The request parameter paths a reason may name. A list position is written
 * `*`, so `tools[0].function.parameters` and `tools.0.function.parameters`
 * are both `tools.*.function.parameters`. A path below one of these (a schema
 * property, for example) names customer content and is never kept.
 */
export const REJECTION_PARAM_PATHS: readonly string[] = [
  // Structured output.
  "response_format",
  "response_format.type",
  "response_format.json_schema",
  "response_format.json_schema.name",
  "response_format.json_schema.schema",
  "response_format.json_schema.strict",
  "output_config",
  "output_config.effort",
  "output_config.format",
  "output_config.format.type",
  "output_config.format.schema",
  "output_format",
  "output_format.type",
  "output_format.schema",
  "text",
  "text.format",
  "text.format.type",
  "text.format.name",
  "text.format.schema",
  "text.format.strict",
  "text.verbosity",
  // Tools.
  "tools",
  "tools.*",
  "tools.*.type",
  "tools.*.name",
  "tools.*.parameters",
  "tools.*.strict",
  "tools.*.input_schema",
  "tools.*.custom",
  "tools.*.custom.name",
  "tools.*.custom.input_schema",
  "tools.*.function",
  "tools.*.function.name",
  "tools.*.function.parameters",
  "tools.*.function.strict",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
  // Input.
  "messages",
  "messages.*",
  "messages.*.role",
  "messages.*.content",
  "messages.*.content.*",
  "messages.*.content.*.type",
  "input",
  "instructions",
  "system",
  // Output limits and sampling.
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "top_k",
  "n",
  "seed",
  "stop",
  "stop_sequences",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  // Reasoning.
  "reasoning",
  "reasoning.effort",
  "reasoning.max_tokens",
  "reasoning.summary",
  "reasoning_effort",
  "thinking",
  "thinking.type",
  "thinking.budget_tokens",
  "verbosity",
  // Request envelope.
  "model",
  "stream",
  "stream_options",
  "modalities",
  "prediction",
  "service_tier",
  "store",
  "metadata",
  "user",
  "include",
  "truncation"
];

const PARAM_PATHS: ReadonlySet<string> = new Set(REJECTION_PARAM_PATHS);

function isRejectionKind(value: string): value is RejectionKind {
  return REJECTION_KINDS.some((kind) => kind === value);
}

/** True when `param` is exactly one of the listed request parameter paths. */
export function isRejectionParamPath(param: string): boolean {
  return PARAM_PATHS.has(param);
}

/** The stored reason, or null unless the kind is in the vocabulary. A parameter off the list is dropped. */
export function storedRejectionReason(kind: string | null | undefined, param: string | null | undefined): RejectionReason | null {
  if (kind === null || kind === undefined || !isRejectionKind(kind)) return null;
  return { kind, param: param !== null && param !== undefined && PARAM_PATHS.has(param) ? param : null };
}

/** A reason read from stored JSON, under the same rule as `storedRejectionReason`. */
export function parseStoredRejectionReason(value: JsonValue | undefined): RejectionReason | null {
  if (value === undefined || !isJsonObject(value) || !isJsonString(value.kind)) return null;
  const param = value.param;
  return storedRejectionReason(value.kind, param !== undefined && isJsonString(param) ? param : null);
}

const KIND_LABEL = {
  response_schema: "response schema",
  tool_schema: "tool schema",
  unsupported_parameter: "unsupported parameter",
  context_too_long: "context too long",
  content_policy: "content policy",
  other: null
} as const satisfies Record<RejectionKind, string | null>;

export const INCOMPATIBLE_REQUEST_LABEL = "Incompatible request";

/** The reason in plain words ("response schema"). A reason of kind `other` names its parameter, or nothing. */
export function rejectionReasonDetail(reason: RejectionReason | null): string | null {
  return reason === null ? null : KIND_LABEL[reason.kind] ?? reason.param;
}

/** "Incompatible request: response schema", or "Incompatible request" when the reason has no detail. */
export function incompatibleRequestLabel(reason: RejectionReason | null): string {
  const detail = rejectionReasonDetail(reason);
  return detail === null ? INCOMPATIBLE_REQUEST_LABEL : `${INCOMPATIBLE_REQUEST_LABEL}: ${detail}`;
}

const KIND_SENTENCE = {
  response_schema: "The upstream model rejected this request: it does not accept the response schema.",
  tool_schema: "The upstream model rejected this request: it does not accept a tool definition.",
  unsupported_parameter: "The upstream model rejected this request: it does not support a request parameter.",
  context_too_long: "The upstream model rejected this request: the input is longer than its context window.",
  content_policy: "The upstream model rejected this request under its content policy.",
  other: "The upstream model rejected this request."
} as const satisfies Record<RejectionKind, string>;

/**
 * One fixed sentence for the reason, with the listed parameter when there is
 * one. BenchRouter writes every word; none comes from the provider.
 */
export function rejectionReasonCopy(reason: RejectionReason): string {
  const sentence = KIND_SENTENCE[reason.kind];
  return reason.param === null ? sentence : `${sentence} Parameter: ${reason.param}.`;
}
