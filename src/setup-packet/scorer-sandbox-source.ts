// Single source of truth for the scorer SANDBOX MEMBRANE.
//
// The contract-scorer runs in a node:vm context (its own realm) behind an
// airtight in-process membrane: NO host globals are injected, and the DATA args
// (request/output/reference/metadata) are round-tripped as JSON strings INTO the
// context so their prototypes are the context's — closing the two escape surfaces
// (globals + arguments) that a P0 sandbox-escape review (task #23) identified.
//
// These two source blocks are the security/behaviour-critical part. They are
// defined here ONCE and consumed in two places so they can never drift:
//   1. runtime/src/scorer-host.ts loads them in the signed runtime.
//   2. The mutation-certification harness (test/mutation-cert/) loads scorers
//      through a host loader that runs exactly these blocks — so a scorer that
//      passes/fails in the harness passes/fails identically in CI.
//
// This module imports NOTHING (pure string constants) so it is safe to import
// from Worker code. The node:vm loaders live in the runtime and test harness.

export interface ScorerStructuredCheckResult {
  name: string;
  pass: boolean;
  detail: string;
  code_ref: string;
}

export type ScorerCheckResult = string | ScorerStructuredCheckResult;

// Context-side CommonJS shims + a no-op console + a throwing require. Run BY code
// inside the context (via vm.runInContext) so they are context-realm objects.
export const SANDBOX_CJS_SHIM_SOURCE = [
  "globalThis.module = { exports: {} };",
  "globalThis.exports = globalThis.module.exports;",
  "globalThis.require = function (id) {",
  "  var error = new Error('BenchRouter scorer sandbox: require/import is forbidden (attempted: ' + id + ')');",
  "  error.benchrouter_error_code = 'sandbox_violation';",
  "  error.benchrouter_stage = 'scorer';",
  "  throw error;",
  "};",
  "globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };"
].join("\n");

// Local-only console bridge. The generated calibrate command installs a host
// callback at globalThis.__benchrouter_hostConsole, runs this source inside the
// context, then the source deletes the global and exposes context-realm console
// methods. This keeps CI hermetic while making local scorer debugging usable.
export const SANDBOX_LOCAL_CONSOLE_SOURCE = [
  "var __benchrouter_consoleBridge = globalThis.__benchrouter_hostConsole;",
  "delete globalThis.__benchrouter_hostConsole;",
  "function __benchrouter_consoleArgs(args) {",
  "  var out = [];",
  "  for (var i = 0; i < args.length; i++) {",
  "    var value = args[i];",
  "    if (typeof value === 'string') out.push(value);",
  "    else {",
  "      try { out.push(JSON.stringify(value)); }",
  "      catch (err) { out.push(String(value)); }",
  "    }",
  "  }",
  "  return out;",
  "}",
  "function __benchrouter_sendConsole(level, args) {",
  "  if (typeof __benchrouter_consoleBridge === 'function') {",
  "    __benchrouter_consoleBridge(level, JSON.stringify(__benchrouter_consoleArgs(args)));",
  "  }",
  "}",
  "globalThis.console = {",
  "  log: function () { __benchrouter_sendConsole('log', Array.prototype.slice.call(arguments)); },",
  "  info: function () { __benchrouter_sendConsole('info', Array.prototype.slice.call(arguments)); },",
  "  warn: function () { __benchrouter_sendConsole('warn', Array.prototype.slice.call(arguments)); },",
  "  error: function () { __benchrouter_sendConsole('error', Array.prototype.slice.call(arguments)); },",
  "  debug: function () { __benchrouter_sendConsole('debug', Array.prototype.slice.call(arguments)); }",
  "};"
].join("\n");

// Context-side membrane: resolves the scorer's score(), a judge factory that
// closes over the (unreachable) host callback and exchanges ONLY strings across
// the boundary, and a runner that parses host-supplied DATA in-context. Defined
// by code RUN IN the context, so all of it is context-realm.
export const SANDBOX_MEMBRANE_SOURCE = [
  "globalThis.__benchrouter_scorer = (globalThis.module.exports && typeof globalThis.module.exports.score === 'function') ? globalThis.module.exports.score : (globalThis.benchrouterScorer && globalThis.benchrouterScorer.score);",
  "globalThis.__benchrouter_makeJudge = function (hostJudge) {",
  "  return async function judge(messages, options) {",
  // Serialize in-context; JSON.stringify(undefined) is undefined, so coerce to
  // 'null' rather than feed undefined to the host JSON.parse.
  "    var payload;",
  "    try { payload = JSON.stringify(messages); } catch (stringifyErr) {",
  "      throw new Error('judge messages are not serializable');",
  "    }",
  "    if (typeof payload !== 'string') { payload = 'null'; }",
  // EVAL-011: optional { response_format } crosses as a string too, so the host
  // can validate the judge reply without the scorer seeing a host object.
  "    var optionsPayload;",
  "    try { optionsPayload = JSON.stringify(options === undefined ? null : options); } catch (optionsErr) {",
  "      throw new Error('judge options are not serializable');",
  "    }",
  "    if (typeof optionsPayload !== 'string') { optionsPayload = 'null'; }",
  "    var reply;",
  "    try {",
  "      reply = await hostJudge(payload, optionsPayload);",
  "    } catch (hostErr) {",
  // A host-realm rejection must NOT surface to the scorer as a host Error (its
  // prototype chain reaches host Function -> process). Re-throw a CONTEXT Error
  // carrying ONLY the message STRING.
  "      throw new Error('judge call failed: ' + (hostErr && hostErr.message ? String(hostErr.message) : String(hostErr)));",
  "    }",
  "    return typeof reply === 'string' ? reply : String(reply == null ? '' : reply);",
  "  };",
  "};",
  "globalThis.__benchrouter_run = async function (payloadJson, judgeWrapper) {",
  "  var data = JSON.parse(payloadJson);",
  "  if (judgeWrapper) { if (!data.metadata) data.metadata = {}; data.metadata.judge = judgeWrapper; }",
  "  if (typeof globalThis.__benchrouter_scorer !== 'function') { throw new Error('scorer score() missing'); }",
  "  var result = await globalThis.__benchrouter_scorer(data);",
  "  var checks = result && Array.isArray(result.checks) ? result.checks : [];",
  "  for (var checkIndex = 0; checkIndex < checks.length; checkIndex++) {",
  "    var check = checks[checkIndex];",
  "    if (typeof check === 'string') { continue; }",
  "    if (!check || typeof check !== 'object' || Array.isArray(check)) { throw new Error('scorer result.checks[' + checkIndex + '] must be an object'); }",
  "    var checkKeys = Object.keys(check).sort();",
  "    if (checkKeys.length !== 4 || checkKeys[0] !== 'code_ref' || checkKeys[1] !== 'detail' || checkKeys[2] !== 'name' || checkKeys[3] !== 'pass') {",
  "      throw new Error('scorer result.checks[' + checkIndex + '] must contain exactly name, pass, detail, and code_ref');",
  "    }",
  "    if (typeof check.name !== 'string' || check.name.trim().length === 0) { throw new Error('scorer result.checks[' + checkIndex + '].name must be a non-empty string'); }",
  "    if (typeof check.pass !== 'boolean') { throw new Error('scorer result.checks[' + checkIndex + '].pass must be a boolean'); }",
  "    if (typeof check.detail !== 'string' || check.detail.trim().length === 0) { throw new Error('scorer result.checks[' + checkIndex + '].detail must be a non-empty string'); }",
  "    if (typeof check.code_ref !== 'string' || check.code_ref.trim().length === 0) { throw new Error('scorer result.checks[' + checkIndex + '].code_ref must be a non-empty string'); }",
  "  }",
  "  var reasons = result && Array.isArray(result.reasons) ? result.reasons.map(String) : [];",
  "  return JSON.stringify({ pass: !!(result && result.pass === true), checks: checks, reasons: reasons });",
  "};"
].join("\n");
