// RUN-001: local customer diagnostics are observations, never server evidence.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isJsonString, type JsonValue } from "./json";

export const METRICS_DIR = ".br-results";
const MAX_CHECKS = 64;
const MAX_CHECK_BYTES = 4096;
const MAX_ROW_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_JOB_BYTES = 64 * 1024 * 1024;
const MAX_JOB_FILES = 256;
const MAX_ROWS = 4096;

export interface ReplayMetrics {
  case_id: string;
  model: string;
  selected_model: string | null;
  pass: boolean;
  technical_failure: boolean;
  cost_usd: number | null;
  checks: string[];
  checks_omitted: boolean;
}

/** Keep existing string diagnostics, with explicit loss when a scorer exceeds the bound. */
export function metricsChecks(checks: JsonValue[]): Pick<ReplayMetrics, "checks" | "checks_omitted"> {
  const kept = checks.slice(0, MAX_CHECKS).filter((check): check is string => isJsonString(check) && check.length <= MAX_CHECK_BYTES && Buffer.byteLength(check) <= MAX_CHECK_BYTES && [...check].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
  return { checks: kept, checks_omitted: kept.length !== checks.length };
}

export type MetricsTerminal = "uploaded" | "failed" | "unconfirmed";

/** One writer per job, so four concurrent replay slots share the same storage limit. */
export class ReplayMetricsWriter {
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;
  private directoryIdentity: { dev: number; ino: number } | null = null;
  private bytes = 0;
  private files = 0;
  private readonly directory: string;

  constructor(private readonly workspace: string) {
    this.directory = path.join(workspace, METRICS_DIR);
  }

  write(workId: string, retryAttempt: number, leaseGen: number, rows: ReplayMetrics[], terminal: MetricsTerminal): Promise<void> {
    const task = this.tail.then(() => this.writeOnce(workId, retryAttempt, leaseGen, rows, terminal));
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async verifyDirectory(): Promise<void> {
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.directoryIdentity?.dev || stat.ino !== this.directoryIdentity.ino || await realpath(this.directory) !== path.join(await realpath(this.workspace), METRICS_DIR)) throw new Error("local metrics directory changed");
  }

  private async writeOnce(workId: string, retryAttempt: number, leaseGen: number, rows: ReplayMetrics[], terminal: MetricsTerminal): Promise<void> {
    if (rows.length === 0) return;
    // Node has no portable renameat. Refuse export rather than race a parent
    // symlink on a platform without Linux's opened-directory descriptor path.
    if (process.platform !== "linux") throw new Error("local metrics require a Linux directory anchor");
    if (rows.length > MAX_ROWS || this.files >= MAX_JOB_FILES) throw new Error("local metrics storage limit reached");
    const lines = rows.map(row => JSON.stringify({ ...row, terminal_status: terminal, server_accepted: terminal === "uploaded", diagnostic_schema: "benchrouter.local_metrics.v1" }));
    if (lines.some(line => Buffer.byteLength(line) > MAX_ROW_BYTES)) throw new Error("local metrics row exceeds the bound");
    const content = lines.join("\n") + "\n", bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES || this.bytes + bytes > MAX_JOB_BYTES) throw new Error("local metrics storage limit reached");
    if (!this.initialized) {
      // An existing directory or symlink is refused, never adopted or cleared.
      await mkdir(this.directory, { mode: 0o700 });
      const stat = await lstat(this.directory);
      this.directoryIdentity = { dev: stat.dev, ino: stat.ino };
      this.initialized = true;
    }
    await this.verifyDirectory();
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await directory.stat();
    if (opened.dev !== this.directoryIdentity?.dev || opened.ino !== this.directoryIdentity.ino) {
      await directory.close();
      throw new Error("local metrics directory changed");
    }
    // GitHub's Linux runner can anchor rename and creation to the opened directory,
    // even if another process replaces its pathname while this write is running.
    const anchoredDirectory = `/proc/self/fd/${directory.fd}`;
    const name = createHash("sha256").update(JSON.stringify([workId, retryAttempt, leaseGen])).digest("hex");
    const temporary = path.join(anchoredDirectory, `.metrics-${randomUUID()}.tmp`);
    const target = path.join(anchoredDirectory, `results.${name}.jsonl`);
    let file;
    try {
      file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      // Reserve the bound before writing. An interrupted export never frees
      // storage which may already exist under the pinned directory descriptor.
      this.bytes += bytes;
      this.files += 1;
      await file.writeFile(content);
      await file.sync();
      await this.verifyDirectory();
      await rename(temporary, target);
      await this.verifyDirectory();
    } finally {
      await file?.close();
      await unlink(temporary).catch(() => undefined);
      await directory.close();
    }
  }
}
