// §3.11 visibility: the job summary and the job's exit code. The job fails on a block
// (including an unavailable snapshot when nothing else ran), on zero uploads with any
// infra, harness or upload-error cause, and on a protocol error. Provider-only failures
// are data: they are annotated, and the job still succeeds.
import { appendFile } from "node:fs/promises";

export type FailureClass = "provider" | "harness" | "infra";

function escapeAnnotation(text: string): string {
  return text.split("%").join("%25").split("\r").join("%0D").split("\n").join("%0A");
}

function cell(text: string): string {
  return text.split("|").join("\\|").split("\n").join(" ").slice(0, 240);
}

export class JobSummary {
  private readonly lines: string[] = [];
  private readonly failures = new Map<string, number>();
  private uploads = 0;
  private batches = 0;
  private infraOrHarness = false;
  private blocked = false;
  private protocolError: string | null = null;
  private snapshotUnavailable = false;
  outcome = "not started";
  nextWake: string | null = null;

  note(line: string): void {
    this.lines.push(line);
    console.log(`BenchRouter: ${line}`);
  }

  uploaded(workId: string, model: string, cases: number, passes: number): void {
    this.uploads += 1;
    this.note(`uploaded ${model}: ${passes}/${cases} cases passed (work ${workId})`);
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
      `| Next wake-up | ${cell(this.nextWake ?? "none")} |`,
      ...(this.protocolError ? [`| Protocol error | ${cell(this.protocolError)} |`] : []),
      "",
      ...(failures.length > 0 ? ["| Failure cause | Items |", "| --- | --- |", ...failures, ""] : []),
      ...this.lines.slice(-50).map((line) => `- ${line}`),
      ""
    ].join("\n");
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (target) await appendFile(target, text).catch(() => undefined);
  }
}
