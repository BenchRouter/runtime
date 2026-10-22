// §3.11 visibility: the job summary and the job's exit code. The job fails on a block
// (including an unavailable snapshot when nothing else ran), on zero uploads with any
// infra, harness or upload-error cause, and on a protocol error. Provider-only failures
// are data: they are annotated, and the job still succeeds.
//
// A failed evaluator's scrubbed stderr excerpt (stderr-excerpt.ts) is shown here, in
// the customer's own GitHub, and never sent to BenchRouter (DATA-001). When the server's
// fail receipt says `setup_failed` (the item failed before any model call reached it),
// the job gets one cause-first annotation that names no model.
import { appendFile } from "node:fs/promises";
import { caseReuseLine } from "../../src/shared/case-reuse";
import type { RunnerRunSummary } from "../../src/shared/runner-protocol";
import type { EvaluatorErrorExcerpt } from "./stderr-excerpt";

export type FailureClass = "provider" | "harness" | "infra";

function escapeAnnotation(text: string): string {
  return text.split("%").join("%25").split("\r").join("%0D").split("\n").join("%0A");
}

function cell(text: string): string {
  return text.split("|").join("\\|").split("\n").join(" ").slice(0, 240);
}

/** At most this many evaluator excerpt sections per job summary. */
const MAX_EXCERPT_SECTIONS = 3;
const SETUP_FIX = "Fix your eval setup; BenchRouter will retry on your next push.";

/** A fenced code block whose fence is longer than any backtick run in the text, so the text cannot close it. */
function fenced(text: string): string[] {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    run = char === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, text, fence];
}

/** The excerpt lines of the job summary: the error line, then the scrubbed tail. */
function excerptLines(excerpt: EvaluatorErrorExcerpt): string[] {
  if (excerpt.errorLine === null) return [`The evaluator ${excerpt.ending} and wrote nothing to stderr.`, ""];
  return [
    `The evaluator ${excerpt.ending}. Its error:`,
    "",
    ...fenced(excerpt.errorLine),
    "",
    "The end of its stderr (secrets redacted; the full output is in the job log):",
    "",
    ...fenced(excerpt.tail),
    ""
  ];
}

/** The cause to name first: the evaluator's error line, or how it ended, or the runtime's own reason. */
function setupCause(excerpt: EvaluatorErrorExcerpt | undefined, reason: string): string {
  if (excerpt === undefined) return reason;
  return excerpt.errorLine ?? `the evaluator ${excerpt.ending} and wrote nothing to stderr`;
}

export class JobSummary {
  private readonly lines: string[] = [];
  private readonly failures = new Map<string, number>();
  private uploads = 0;
  private batches = 0;
  /** EVAL-002 / EVAL-003: whole-run case counts of this job's uploaded replay runs, from their receipts. */
  private casesCalled = 0;
  private casesRescored = 0;
  private reuseReported = false;
  private infraOrHarness = false;
  private blocked = false;
  private protocolError: string | null = null;
  private snapshotUnavailable = false;
  private setupReported = false;
  private readonly sections: string[] = [];
  outcome = "not started";
  nextWake: string | null = null;

  note(line: string): void {
    this.lines.push(line);
    console.log(`BenchRouter: ${line}`);
  }

  /**
   * An uploaded run. A replay run's receipt names the whole run (`run_summary`): its
   * pass and case counts and how many cases called a model or re-scored a cached
   * output. Without one (a receipt from a server that predates it) the line says the
   * counts are unavailable and keeps this batch's own counts.
   */
  uploaded(workId: string, model: string, cases: number, passes: number, replay: boolean, run?: RunnerRunSummary): void {
    this.uploads += 1;
    if (run !== undefined) {
      this.casesCalled += run.cases_called;
      this.casesRescored += run.cases_rescored;
      this.reuseReported = true;
      this.note(`uploaded ${model}: ${run.pass_count}/${run.case_count} cases passed; ${caseReuseLine(run)} (work ${workId})`);
      return;
    }
    this.note(`uploaded ${model}: ${passes}/${cases} cases passed${replay ? "; reuse counts unavailable" : ""} (work ${workId})`);
  }

  /** §3.3.5: one batch of a run was stored; the run continues with its next batch. */
  stored(workId: string, model: string, cases: number, failed: number): void {
    this.batches += 1;
    this.note(`stored a batch of ${model}: ${cases} cases${failed > 0 ? `, ${failed} without a result` : ""} (work ${workId})`);
  }

  failed(workId: string, cause: string, failureClass: FailureClass, detail: string): void {
    this.failures.set(cause, (this.failures.get(cause) ?? 0) + 1);
    if (failureClass !== "provider") this.infraOrHarness = true;
    const text = `work ${workId} failed: ${cause} (${detail})`;
    console.log(`::${failureClass === "provider" ? "warning" : "error"} title=BenchRouter::${escapeAnnotation(text)}`);
    this.lines.push(text);
  }

  /**
   * RUN-001 §3.3.1: the server stopped the set because this item failed before any model
   * call (`setup_failed`). The work line says the model was not evaluated; the job gets one
   * run-level annotation and one summary section, however many items fail this way.
   */
  setupFailed(workId: string, cause: string, model: string, reason: string, excerpt?: EvaluatorErrorExcerpt): void {
    this.failures.set("setup_failed", (this.failures.get("setup_failed") ?? 0) + 1);
    this.infraOrHarness = true;
    this.note(`work ${workId} stopped: eval setup failed before any model call (${cause}); ${model} was not evaluated and is not at fault`);
    if (this.setupReported) return;
    this.setupReported = true;
    const causeText = setupCause(excerpt, reason).trim();
    const sentence = causeText.endsWith(".") ? causeText : `${causeText}.`;
    console.log(`::error title=BenchRouter eval setup failed::${escapeAnnotation(`Eval setup failed before any model call: ${sentence} ${SETUP_FIX}`)}`);
    this.sections.push([
      "### Eval setup failed before any model call",
      "",
      `Work ${workId} failed before it called any model, so no model was evaluated and none is at fault. BenchRouter stopped this result set.`,
      "",
      ...(excerpt === undefined ? [...fenced(reason), ""] : excerptLines(excerpt)),
      SETUP_FIX,
      ""
    ].join("\n"));
  }

  /** A failed evaluator's excerpt under its work line, for a failure that is not a setup stop. */
  evaluatorError(workId: string, excerpt: EvaluatorErrorExcerpt): void {
    if (this.sections.length >= MAX_EXCERPT_SECTIONS) return;
    this.sections.push([`### Evaluator error (work ${workId})`, "", ...excerptLines(excerpt)].join("\n"));
  }

  block(reason: string, action: string): void {
    this.blocked = true;
    this.outcome = `blocked: ${reason}`;
    console.log(`::error title=BenchRouter blocked (${reason})::${escapeAnnotation(action)}`);
    this.lines.push(`Blocked: ${reason}. ${action}`);
  }

  unavailableSnapshot(evalSha: string): void {
    this.snapshotUnavailable = true;
    this.outcome = "awaiting_snapshot";
    console.log(`::error title=BenchRouter::the eval commit ${escapeAnnotation(evalSha)} could not be fetched; this route context waits for a snapshot refresh`);
  }

  protocol(message: string): void {
    this.protocolError = message;
    this.outcome = "protocol error";
    console.log(`::error title=BenchRouter protocol error::${escapeAnnotation(message)}`);
  }

  exitCode(): number {
    if (this.blocked || this.protocolError !== null) return 1;
    if (this.snapshotUnavailable && this.uploads + this.batches === 0) return 1;
    if (this.uploads + this.batches === 0 && this.infraOrHarness) return 1;
    return 0;
  }

  async write(): Promise<void> {
    const failures = [...this.failures.entries()].map(([cause, count]) => `| ${cell(cause)} | ${count} |`);
    const text = [
      "## BenchRouter evaluation worker",
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Outcome | ${cell(this.outcome)} |`,
      `| Results uploaded | ${this.uploads} |`,
      ...(this.batches > 0 ? [`| Batches stored | ${this.batches} |`] : []),
      ...(this.reuseReported
        ? [`| Cases that called models | ${this.casesCalled} |`, `| Cases reused from cache and re-scored | ${this.casesRescored} |`]
        : []),
      `| Next wake-up | ${cell(this.nextWake ?? "none")} |`,
      ...(this.protocolError ? [`| Protocol error | ${cell(this.protocolError)} |`] : []),
      "",
      ...(failures.length > 0 ? ["| Failure cause | Items |", "| --- | --- |", ...failures, ""] : []),
      ...this.lines.slice(-50).map((line) => `- ${line}`),
      "",
      ...this.sections
    ].join("\n");
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (target) await appendFile(target, text).catch(() => undefined);
  }
}
