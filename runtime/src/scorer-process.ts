// Parent side of the scorer child (§3.3.5). One ScorerProcess serves one case at a
// time, so a hung scorer kills only its own case. The scorer deadline counts only the
// scorer's own compute time: time spent waiting on a judge call does not count, and
// the judge call carries its own deadline. Local `calibrate` constructs it with
// `local: true`: the scorer console prints through this process, and failures carry
// the scorer's own error message. CI replay keeps both off (DATA-001).
import type { ChildProcess } from "node:child_process";
import { parseJsonValueFromString } from "../../src/shared/json-parse-contracts";
import { childEnv, type ControlContext } from "./control";
import { isJsonBoolean, isJsonObject, isJsonString, parseJsonText, type JsonValue } from "./json";
import { killGroup, spawnGroup } from "./processes";
import type { ScorerHostReply, ScorerHostRequest } from "./scorer-host";

export const SCORER_HOST_COMMAND = "__scorer-host";
const LOAD_DEADLINE_MS = 10_000;
export const SCORE_COMPUTE_DEADLINE_MS = 20_000;

export interface ScorerVerdict {
  pass: boolean;
  checks: JsonValue[];
  reasons: string[];
}

/** `message` is the scorer's error text; only a local ScorerProcess fills it. */
export type ScoreOutcome =
  | { ok: true; verdict: ScorerVerdict }
  | { ok: false; errorCode: string; causeName: string | null; timedOut: boolean; message: string | null };

export type LoadOutcome = { ok: true } | { ok: false; errorCode: string; causeName: string | null; message: string | null };

/** The judge bridge: the parent makes the proxied call and returns the judgment text. */
export type JudgeBridge = (messages: JsonValue, options: JsonValue) => Promise<string>;

function stringOrNull(value: JsonValue | undefined): string | null {
  return value !== undefined && isJsonString(value) ? value : null;
}

function parseReply(value: JsonValue): ScorerHostReply | null {
  if (!isJsonObject(value) || !isJsonString(value.type)) return null;
  const id = Number(value.id);
  switch (value.type) {
    case "loaded":
      return { type: "loaded" };
    case "load_error":
      return { type: "load_error", errorCode: stringOrNull(value.errorCode) ?? "scorer_exception", causeName: stringOrNull(value.causeName), message: stringOrNull(value.message) };
    case "judge":
      return isJsonString(value.messagesJson) && isJsonString(value.optionsJson)
        ? { type: "judge", id, callId: Number(value.callId), messagesJson: value.messagesJson, optionsJson: value.optionsJson }
        : null;
    case "scored":
      return isJsonString(value.resultJson) ? { type: "scored", id, resultJson: value.resultJson } : null;
    case "score_error":
      return { type: "score_error", id, errorCode: stringOrNull(value.errorCode) ?? "scorer_exception", causeName: stringOrNull(value.causeName), message: stringOrNull(value.message) };
    case "console":
      return isJsonString(value.level) && isJsonString(value.argsJson) ? { type: "console", level: value.level, argsJson: value.argsJson } : null;
    default:
      return null;
  }
}

function verdictOf(resultJson: string): ScorerVerdict {
  const parsed = parseJsonText(resultJson, "scorer result");
  const result = isJsonObject(parsed) ? parsed : {};
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const reasons = Array.isArray(result.reasons) ? result.reasons.filter(isJsonString) : [];
  return { pass: isJsonBoolean(result.pass) && result.pass, checks, reasons };
}

function printable(value: JsonValue): string {
  return isJsonString(value) ? value : String(value);
}

/** Local calibrate: print one scorer console call through this process, as the old kit did. */
function printScorerConsole(level: string, argsJson: string): void {
  const parsed = parseJsonValueFromString(argsJson);
  let args: string[];
  if (!parsed.ok) args = [argsJson];
  else if (Array.isArray(parsed.value)) args = parsed.value.map(printable);
  else args = [printable(parsed.value)];
  const print = level === "error" ? console.error : level === "warn" ? console.warn : level === "info" ? console.info : level === "debug" ? console.debug : console.log;
  print("[benchrouter scorer]", ...args);
}

export class ScorerProcess {
  private child: ChildProcess | null = null;
  private listener: ((reply: ScorerHostReply) => void) | null = null;
  private nextId = 1;

  constructor(
    private readonly context: ControlContext,
    private readonly treeRoot: string,
    private readonly scorerPath: string,
    /** Local calibrate: a live scorer console and scorer error messages. CI replay leaves it false. */
    private readonly local = false
  ) {}

  private send(request: ScorerHostRequest): void {
    this.child?.send(request);
  }

  private localMessage(text: string): string | null {
    return this.local ? text : null;
  }

  /** Start the child and load the scorer. A load failure is a harness failure of the item. */
  async start(): Promise<LoadOutcome> {
    const child = spawnGroup(process.execPath, [process.argv[1] ?? "", SCORER_HOST_COMMAND], {
      cwd: this.treeRoot,
      env: childEnv(this.context),
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    this.child = child;
    child.on("message", (raw: JsonValue) => {
      const reply = parseReply(raw);
      if (reply?.type === "console") {
        if (this.local) printScorerConsole(reply.level, reply.argsJson);
      } else if (reply) {
        this.listener?.(reply);
      }
    });
    const loaded = await new Promise<LoadOutcome>((resolve) => {
      const timer = setTimeout(() => settle({ ok: false, errorCode: "scorer_exception", causeName: null, message: this.localMessage(`scorer load exceeded ${LOAD_DEADLINE_MS}ms`) }), LOAD_DEADLINE_MS);
      const settle = (value: LoadOutcome) => { clearTimeout(timer); child.off("exit", onExit); resolve(value); };
      const onExit = () => settle({ ok: false, errorCode: "scorer_exception", causeName: null, message: this.localMessage("the scorer process exited while loading") });
      child.once("exit", onExit);
      this.listener = (reply) => {
        if (reply.type === "loaded") settle({ ok: true });
        if (reply.type === "load_error") settle({ ok: false, errorCode: reply.errorCode, causeName: reply.causeName, message: reply.message });
      };
      this.send({ type: "load", scorerPath: this.scorerPath, local: this.local });
    });
    if (!loaded.ok) await this.stop();
    return loaded;
  }

  /** Score one case. On a deadline the child's process group is killed; call start() again before reuse. */
  score(payloadJson: string, judge: JudgeBridge, hardDeadlineAt: number): Promise<ScoreOutcome> {
    const child = this.child;
    if (!child) return Promise.resolve({ ok: false, errorCode: "scorer_exception", causeName: null, timedOut: false, message: this.localMessage("the scorer process is not running") });
    const id = this.nextId++;
    return new Promise((resolve) => {
      let judgeWaitMs = 0;
      let judgesInFlight = 0;
      let judgeStartedAt = 0;
      const started = Date.now();
      let settled = false;
      const settle = (outcome: ScoreOutcome) => {
        if (settled) return;
        settled = true;
        clearInterval(ticker);
        child.off("exit", onExit);
        resolve(outcome);
      };
      const timeout = () => {
        settle({ ok: false, errorCode: "scorer_exception", causeName: null, timedOut: true, message: this.localMessage(`scorer score() exceeded deadline (${SCORE_COMPUTE_DEADLINE_MS}ms)`) });
        void this.stop();
      };
      const ticker = setInterval(() => {
        const now = Date.now();
        const waiting = judgeWaitMs + (judgesInFlight > 0 ? now - judgeStartedAt : 0);
        if (now >= hardDeadlineAt || now - started - waiting > SCORE_COMPUTE_DEADLINE_MS) timeout();
      }, 200);
      const onExit = () => settle({ ok: false, errorCode: "scorer_exception", causeName: null, timedOut: false, message: this.localMessage("the scorer process exited") });
      child.once("exit", onExit);
      this.listener = (reply) => {
        if (reply.type === "judge" && reply.id === id) {
          if (judgesInFlight === 0) judgeStartedAt = Date.now();
          judgesInFlight += 1;
          const done = () => {
            judgesInFlight -= 1;
            if (judgesInFlight === 0) judgeWaitMs += Date.now() - judgeStartedAt;
          };
          judge(parseJsonText(reply.messagesJson, "judge messages"), parseJsonText(reply.optionsJson, "judge options")).then(
            (text) => { done(); this.send({ type: "judge_result", callId: reply.callId, ok: true, text }); },
            (error: Error) => { done(); this.send({ type: "judge_result", callId: reply.callId, ok: false, text: error.message }); }
          );
        } else if (reply.type === "scored" && reply.id === id) {
          try {
            settle({ ok: true, verdict: verdictOf(reply.resultJson) });
          } catch {
            settle({ ok: false, errorCode: "scorer_exception", causeName: null, timedOut: false, message: this.localMessage("the scorer result is not valid JSON") });
          }
        } else if (reply.type === "score_error" && reply.id === id) {
          settle({ ok: false, errorCode: reply.errorCode, causeName: reply.causeName, timedOut: false, message: reply.message });
        }
      };
      this.send({ type: "score", id, payloadJson });
    });
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.listener = null;
    if (child) await killGroup(child);
  }
}
