// EVAL-012: the SDK base URL BenchRouter gives an app's `call_site.base_url_env`.
// Setup tells the owner to set this value for live traffic, and the signed runtime
// gives the repository executable evaluator the same value, so one app code path
// reaches the same endpoints in production and in an eval. Every model endpoint is
// under `/v1`: the Anthropic SDK appends `/v1/messages` to ANTHROPIC_BASE_URL, so that
// variable is the API root; an OpenAI-compatible base URL includes `/v1`.

export function isAnthropicMessagesBaseUrlEnv(name: string | null | undefined): boolean {
  return name?.trim().toUpperCase() === "ANTHROPIC_BASE_URL";
}

/** `apiRoot` has no trailing slash, for example `https://api.benchrouter.com`. */
export function sdkBaseUrlForEnv(apiRoot: string, envName: string | null | undefined): string {
  return isAnthropicMessagesBaseUrlEnv(envName) ? apiRoot : `${apiRoot}/v1`;
}
