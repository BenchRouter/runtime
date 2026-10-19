// EVAL-012: the SDK base URL BenchRouter gives an app's `call_site.base_url_env`.
// Setup tells the owner to set this value for live traffic, and the signed runtime
// gives the repository executable evaluator the same value, so one app code path
// reaches the same endpoints in production and in an eval. The call site's API family
// chooses the value, not the variable's name. Every model endpoint is under `/v1`: the
// Anthropic SDK appends `/v1/messages` to its base URL, so a native Anthropic Messages
// call site gets the API root; an OpenAI-compatible base URL includes `/v1`.

export type SdkApiFamily = "openai_chat_completions" | "anthropic_messages" | "openai_responses";

/** `apiRoot` has no trailing slash, for example `https://api.benchrouter.com`. */
export function sdkBaseUrlForApiFamily(apiRoot: string, apiFamily: SdkApiFamily): string {
  return apiFamily === "anthropic_messages" ? apiRoot : `${apiRoot}/v1`;
}
