// The scorer child (§3.3.5). One killable process runs one customer scorer behind the
// same airtight vm membrane the old kit used (src/setup-packet/scorer-sandbox-source.ts).
// Its env holds no credential. Its only outbound path is the judge, bridged over IPC
// to the parent as strings. A synchronous infinite loop now stops at the parent's
// deadline, which kills this process group. Local `calibrate` loads the scorer with
// `local: true`: the scorer console is live (sent to the parent over IPC) and error
// messages cross back. CI replay keeps the console a no-op and sends no message text.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { SANDBOX_CJS_SHIM_SOURCE, SANDBOX_LOCAL_CONSOLE_SOURCE, SANDBOX_MEMBRANE_SOURCE } from "../../src/setup-packet/scorer-sandbox-source";
import { isRecord } from "../../src/shared/parsing";
import { isJsonBoolean, isJsonObject, isJsonString, type JsonValue } from "./json";

const LOAD_TIMEOUT_MS = 5000;

/** Messages the parent sends. */
export type ScorerHostRequest =
  | { type: "load"; scorerPath: string; local: boolean }
  | { type: "score"; id: number; payloadJson: string }
  | { type: "judge_result"; callId: number; ok: boolean; text: string };

/** Messages this child sends. */
export type ScorerHostReply =
  | { type: "loaded" }
  | { type: "load_error"; errorCode: string; causeName: string | null; message: string | null }
  | { type: "judge"; id: number; callId: number; messagesJson: string; optionsJson: string }
  | { type: "scored"; id: number; resultJson: string }
  | { type: "score_error"; id: number; errorCode: string; causeName: string | null; message: string | null }
  | { type: "console"; level: string; argsJson: string };

// DATA-001: a scorer exception can quote the model output, so only a built-in class name leaves.
const BUILT_IN_ERROR_CLASSES = new Set(["Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"]);

/** A thrown value from the vm realm: `instanceof` does not cross realms, so read it as a record. */
interface ErrorFacts {
  errorCode: string;
  causeName: string | null;
  /** The thrown message. Only local calibrate sends it; CI keeps it in the child (DATA-001). */
  message: string | null;
}

function thrownMessage<Value>(thrown: Value): string {
  if (isRecord(thrown) && isJsonString(thrown.message)) return thrown.message;
  try {
    return String(thrown);
  } catch {
    return "unprintable thrown value";
  }
}

function errorFacts<Value>(thrown: Value, local: boolean): ErrorFacts {
  const error = isRecord(thrown) ? thrown : null;
  const code = error?.benchrouter_error_code === "sandbox_violation" ? "sandbox_violation" : "scorer_exception";
  const name = error?.name;
  return {
    errorCode: code,
    causeName: name !== undefined && isJsonString(name) && BUILT_IN_ERROR_CLASSES.has(name) ? name : null,
    message: local ? thrownMessage(thrown) : null
  };
}

function reply(message: ScorerHostReply): void {
  process.send?.(message);
}

function parseRequest(value: JsonValue): ScorerHostRequest | null {
  if (!isJsonObject(value)) return null;
  if (value.type === "load" && isJsonString(value.scorerPath) && isJsonBoolean(value.local)) return { type: "load", scorerPath: value.scorerPath, local: value.local };
  if (value.type === "score" && Number.isSafeInteger(value.id) && isJsonString(value.payloadJson)) {
    return { type: "score", id: Number(value.id), payloadJson: value.payloadJson };
  }
  if (value.type === "judge_result" && Number.isSafeInteger(value.callId) && isJsonBoolean(value.ok) && isJsonString(value.text)) {
    return { type: "judge_result", callId: Number(value.callId), ok: value.ok, text: value.text };
  }
  return null;
}

type ScorerFunction = (input: JsonValue) => Promise<JsonValue>;

interface Sandbox {
  module?: { exports: JsonValue };
  require?: JsonValue;
  __benchrouter_scorer?: ScorerFunction | JsonValue;
  __benchrouter_hostConsole?: (level: string, argsJson: string) => void;
  __benchrouter_makeJudge?: (hostJudge: (messagesJson: string, optionsJson: string) => Promise<string>) => JsonValue;
  __benchrouter_run?: (payloadJson: string, judge: JsonValue) => Promise<string>;
}

function isScorerFunction(value: Sandbox["__benchrouter_scorer"]): value is ScorerFunction {
  return typeof value === "function";
}

export function runScorerHost(): void {
  let sandbox: Sandbox | null = null;
  let local = false;
  let nextCallId = 1;
  const pendingJudge = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  async function load(scorerPath: string, localMode: boolean): Promise<void> {
    local = localMode;
    try {
      const source = await readFile(scorerPath, "utf8");
      const context: Sandbox = {};
      if (local) {
        // The local console source takes this host callback, deletes the global, and
        // hands the scorer context-realm console methods that pass only strings.
        context.__benchrouter_hostConsole = (level, argsJson) => reply({ type: "console", level: String(level), argsJson: String(argsJson) });
      }
      vm.createContext(context);
      vm.runInContext(SANDBOX_CJS_SHIM_SOURCE, context, { timeout: LOAD_TIMEOUT_MS });
      if (local) vm.runInContext(SANDBOX_LOCAL_CONSOLE_SOURCE, context, { timeout: LOAD_TIMEOUT_MS });
      const factory = vm.runInContext(`(function (module, exports, require) {\n${source}\n})`, context, { filename: scorerPath, timeout: LOAD_TIMEOUT_MS });
      const ctxModule = context.module;
      factory(ctxModule, ctxModule?.exports, context.require);
      vm.runInContext(SANDBOX_MEMBRANE_SOURCE, context, { timeout: LOAD_TIMEOUT_MS });
      if (!isScorerFunction(context.__benchrouter_scorer)) {
        const message = local ? `Scorer ${scorerPath} must export score({request,output,reference,metadata}) -> {pass,checks,reasons}` : null;
        reply({ type: "load_error", errorCode: "scorer_exception", causeName: null, message });
        return;
      }
      sandbox = context;
      reply({ type: "loaded" });
    } catch (error) {
      reply({ type: "load_error", ...errorFacts(error, local) });
    }
  }

  async function score(id: number, payloadJson: string): Promise<void> {
    const context = sandbox;
    if (!context?.__benchrouter_run || !context.__benchrouter_makeJudge) {
      reply({ type: "score_error", id, errorCode: "scorer_exception", causeName: null, message: local ? "scorer score() missing" : null });
      return;
    }
    const hostJudge = (messagesJson: string, optionsJson: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const callId = nextCallId++;
        pendingJudge.set(callId, { resolve, reject });
        reply({ type: "judge", id, callId, messagesJson, optionsJson });
      });
    try {
      const resultJson = await context.__benchrouter_run(payloadJson, context.__benchrouter_makeJudge(hostJudge));
      reply({ type: "scored", id, resultJson: String(resultJson) });
    } catch (error) {
      reply({ type: "score_error", id, ...errorFacts(error, local) });
    }
  }

  process.on("message", (raw: JsonValue) => {
    const request = parseRequest(raw);
    if (request === null) return;
    if (request.type === "load") void load(request.scorerPath, request.local);
    else if (request.type === "score") void score(request.id, request.payloadJson);
    else {
      const pending = pendingJudge.get(request.callId);
      pendingJudge.delete(request.callId);
      // The membrane turns a host rejection into a context Error carrying only the message string.
      if (pending && request.ok) pending.resolve(request.text);
      else if (pending) pending.reject(new Error(request.text));
    }
  });
  process.on("disconnect", () => process.exit(0));
}
