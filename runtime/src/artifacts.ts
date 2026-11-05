// EVAL-012: the evaluator's declared side outputs (`eval_pack.artifacts`), kept for a person after a
// successful evaluator exit. The runtime copies the matching files from the eval tree into the job's
// results directory, `.br-results/artifacts/<run>/`, which the generated workflow uploads to the
// customer's own repository as a GitHub Actions artifact. Nothing here reaches BenchRouter, and the
// copy never changes the item's outcome, its upload or its identity.
//
// Every read and write is anchored to an opened directory descriptor, as the local replay metrics
// are (metrics.ts): the eval tree is opened before the evaluator starts, and each path component
// below it, on both sides of the copy, is opened with O_NOFOLLOW through `/proc/self/fd/<fd>/<name>`.
// So the copy reads only the admitted tree, never follows a symbolic link, and writes only inside
// the results directory, even if a path is replaced while it runs. Node has no portable openat, so a
// runner that is not Linux keeps no artifacts and says so in the job log.
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathGlobMatches } from "../../src/runner/path-globs";
import {
  EVAL_ARTIFACT_SKIPPED_DIRECTORIES,
  isEvalArtifactGlob,
  MAX_EVAL_ARTIFACT_BYTES_PER_JOB,
  MAX_EVAL_ARTIFACT_BYTES_PER_RUN,
  MAX_EVAL_ARTIFACT_FILES_PER_RUN,
  MAX_EVAL_ARTIFACT_WALK_ENTRIES
} from "../../src/shared/eval-artifacts";
import { METRICS_DIR } from "./metrics";

export const ARTIFACTS_DIR = "artifacts";
/** Characters a GitHub Actions artifact file path cannot hold; upload-artifact refuses the whole upload. */
const ARTIFACT_PATH_REFUSED = new Set(['"', ":", "<", ">", "|", "*", "?", "\\"]);
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** The bytes the job's model runs have kept. The runtime runs one job per process, so one budget serves the job. */
export class EvalArtifactBudget {
  usedBytes = 0;
  constructor(readonly limitBytes: number = MAX_EVAL_ARTIFACT_BYTES_PER_JOB) {}
}

export const JOB_ARTIFACT_BUDGET = new EvalArtifactBudget();

export interface ArtifactCopyInput {
  /** The eval tree, opened by `pinEvalTree` before the evaluator started; every entry is relative to it. */
  tree: FileHandle;
  /** The job workspace that holds `.br-results`. */
  workspace: string;
  patterns: readonly string[];
  /** The model run's folder under `.br-results/artifacts/` (`evalArtifactRunDirectory`). */
  runDirectory: string;
  budget: EvalArtifactBudget;
  /** The directory entries one model run may read; the default is MAX_EVAL_ARTIFACT_WALK_ENTRIES. */
  walkLimit?: number;
}

export interface ArtifactCopyReport {
  /** The run folder, relative to the workspace; null when nothing was kept. */
  directory: string | null;
  kept: Array<{ path: string; bytes: number }>;
  skipped: Array<{ path: string; reason: string }>;
  /** Declared entries that matched no file. */
  unmatched: string[];
  /** The directory-entry bound the walk stopped at, or null when it read everything. */
  walkStoppedAt: number | null;
}

/** A Node file-system error's code, such as ELOOP; "error" for anything else. */
function errorCode(error: Error | string): string {
  return error instanceof Error && "code" in error ? String(error.code) : "error";
}

/** The anchored path of `name` inside an opened directory. */
function at(directory: FileHandle, name: string): string {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

/** The eval tree as admitted, or why the copy cannot run. */
export type PinnedTree = { tree: FileHandle } | { problem: string };

/** Opens the eval tree before the evaluator starts, so the copy reads the admitted tree. */
export async function pinEvalTree(treeRoot: string): Promise<PinnedTree> {
  if (process.platform !== "linux") return { problem: `evaluator artifacts are kept only on a Linux runner, and this job runs on ${process.platform}` };
  try {
    return { tree: await open(treeRoot, DIRECTORY_FLAGS) };
  } catch (error) {
    return { problem: `the eval tree could not be opened (${errorCode(error instanceof Error ? error : String(error))})` };
  }
}

/** A name GitHub artifacts can hold: no refused character and no control character. */
function artifactPathAllowed(relative: string): boolean {
  for (const character of relative) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127 || ARTIFACT_PATH_REFUSED.has(character)) return false;
  }
  return true;
}

/** A directory below `root`, opened one component at a time without following a link. The caller closes it. */
async function openDirectories(root: FileHandle, segments: readonly string[]): Promise<FileHandle> {
  let current = root;
  try {
    for (const segment of segments) {
      const next = await open(at(current, segment), DIRECTORY_FLAGS);
      if (current !== root) await current.close();
      current = next;
    }
  } catch (error) {
    if (current !== root) await current.close();
    throw error;
  }
  return current === root ? open(at(root, "."), DIRECTORY_FLAGS) : current;
}

interface Matching {
  candidates: Set<string>;
  skipped: Map<string, string>;
  visited: number;
  limit: number;
  stopped: boolean;
}

/** Reads `base` and the directories below it, a bounded number of entries at a time; adds the files `matches` takes. */
async function walk(tree: FileHandle, base: string[], matches: (relative: string) => boolean, state: Matching): Promise<boolean> {
  let matched = false;
  const pending = [base];
  while (pending.length > 0 && !state.stopped) {
    const segments = pending.pop()!;
    let handle: FileHandle;
    try {
      handle = await openDirectories(tree, segments);
    } catch {
      continue;
    }
    try {
      // opendir reads the directory in small batches, so the bound also bounds memory.
      const directory = await opendir(`/proc/self/fd/${handle.fd}`);
      for await (const entry of directory) {
        state.visited += 1;
        if (state.visited > state.limit) {
          state.stopped = true;
          break;
        }
        const relative = [...segments, entry.name].join("/");
        if (entry.isSymbolicLink()) {
          if (matches(relative)) {
            matched = true;
            state.skipped.set(relative, "is a symbolic link");
          }
        } else if (entry.isDirectory()) {
          if (!EVAL_ARTIFACT_SKIPPED_DIRECTORIES.includes(entry.name)) pending.push([...segments, entry.name]);
        } else if (matches(relative)) {
          matched = true;
          if (entry.isFile()) state.candidates.add(relative);
          else state.skipped.set(relative, "is not a regular file");
        }
      }
    } catch {
      // An unreadable directory adds nothing.
    } finally {
      await handle.close();
    }
  }
  return matched;
}

/** The files one declared entry matches. A literal entry that names a directory takes every file under it. */
async function matchEntry(tree: FileHandle, entry: string, state: Matching): Promise<boolean> {
  const segments = entry.split("/");
  const firstGlob = segments.findIndex(isEvalArtifactGlob);
  const literal = firstGlob < 0 ? segments : segments.slice(0, firstGlob);
  let parent = tree;
  try {
    for (let index = 0; index < literal.length; index += 1) {
      const segment = literal[index]!;
      const relative = literal.slice(0, index + 1).join("/");
      let stat;
      try {
        stat = await lstat(at(parent, segment));
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) {
        state.skipped.set(relative, "is a symbolic link");
        return true;
      }
      const last = index === literal.length - 1;
      if (last && firstGlob < 0 && !stat.isDirectory()) {
        if (stat.isFile()) state.candidates.add(relative);
        else state.skipped.set(relative, "is not a regular file");
        return true;
      }
      if (!stat.isDirectory()) return false;
      let next: FileHandle;
      try {
        next = await open(at(parent, segment), DIRECTORY_FLAGS);
      } catch (error) {
        if (errorCode(error instanceof Error ? error : String(error)) !== "ELOOP") return false;
        state.skipped.set(relative, "is a symbolic link");
        return true;
      }
      if (parent !== tree) await parent.close();
      parent = next;
    }
  } finally {
    if (parent !== tree) await parent.close();
  }
  // A glob, or a literal entry that names a directory, is a walk, which never reads .git or node_modules.
  if (literal.some((segment) => EVAL_ARTIFACT_SKIPPED_DIRECTORIES.includes(segment))) {
    state.skipped.set(entry, "reads inside .git or node_modules, which a glob or a folder entry never does");
    return true;
  }
  return walk(tree, literal, firstGlob < 0 ? () => true : (relative) => pathGlobMatches(entry, relative), state);
}

/** `name` inside `directory` as a directory this copy may write into: made here, or already a real directory. */
async function directoryAt(directory: FileHandle, name: string, mustBeNew = false): Promise<FileHandle> {
  try {
    await mkdir(at(directory, name), { mode: 0o700 });
  } catch (error) {
    if (mustBeNew || errorCode(error instanceof Error ? error : String(error)) !== "EEXIST") throw error;
  }
  return open(at(directory, name), DIRECTORY_FLAGS);
}

/** Reads at most `size` bytes; null when the file holds more than its stat said (it changed). */
async function boundedRead(handle: FileHandle, size: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(size + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total === size ? buffer.subarray(0, size) : null;
}

type CopyResult = { kept: number } | { skipped: string };

async function copyOne(input: ArtifactCopyInput, run: FileHandle, relative: string, runRemaining: number): Promise<CopyResult> {
  const segments = relative.split("/");
  const name = segments.pop()!;
  let parent: FileHandle;
  try {
    parent = await openDirectories(input.tree, segments);
  } catch (error) {
    return { skipped: errorCode(error instanceof Error ? error : String(error)) === "ELOOP" ? "is below a symbolic link" : "could not be read" };
  }
  let source: FileHandle;
  try {
    source = await open(at(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { skipped: errorCode(error instanceof Error ? error : String(error)) === "ELOOP" ? "is a symbolic link" : "could not be read" };
  } finally {
    await parent.close();
  }
  try {
    const stat = await source.stat();
    if (!stat.isFile()) return { skipped: "is not a regular file" };
    if (stat.size > runRemaining) return { skipped: `is over the ${sizeText(MAX_EVAL_ARTIFACT_BYTES_PER_RUN)} limit for a model run` };
    if (stat.size > input.budget.limitBytes - input.budget.usedBytes) return { skipped: `is over the ${sizeText(input.budget.limitBytes)} limit for the job` };
    const content = await boundedRead(source, stat.size);
    if (content === null) return { skipped: "changed while it was copied" };
    let target = run;
    try {
      for (const segment of segments) {
        const next = await directoryAt(target, segment);
        if (target !== run) await target.close();
        target = next;
      }
      const out = await open(at(target, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await out.writeFile(content);
      } finally {
        await out.close();
      }
    } finally {
      if (target !== run) await target.close();
    }
    input.budget.usedBytes += content.length;
    return { kept: content.length };
  } finally {
    await source.close();
  }
}

/** The run folder, made new below `.br-results/artifacts`, each level opened without following a link. */
async function openRunFolder(workspace: string, runDirectory: string): Promise<FileHandle> {
  const resultsRoot = path.join(workspace, METRICS_DIR);
  try {
    await mkdir(resultsRoot, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error instanceof Error ? error : String(error)) !== "EEXIST") throw error;
  }
  const results = await open(resultsRoot, DIRECTORY_FLAGS);
  try {
    const artifacts = await directoryAt(results, ARTIFACTS_DIR);
    try {
      return await directoryAt(artifacts, runDirectory, true);
    } finally {
      await artifacts.close();
    }
  } finally {
    await results.close();
  }
}

/**
 * EVAL-012: copies the files `patterns` match into `.br-results/artifacts/<runDirectory>/`, under their
 * repository-relative paths. A file that cannot be copied is a skipped entry of the report.
 */
export async function copyEvalArtifacts(input: ArtifactCopyInput): Promise<ArtifactCopyReport> {
  const limit = input.walkLimit ?? MAX_EVAL_ARTIFACT_WALK_ENTRIES;
  const report: ArtifactCopyReport = { directory: null, kept: [], skipped: [], unmatched: [], walkStoppedAt: null };
  const state: Matching = { candidates: new Set(), skipped: new Map(), visited: 0, limit, stopped: false };
  for (const entry of input.patterns) {
    if (!(await matchEntry(input.tree, entry, state))) report.unmatched.push(entry);
    if (state.stopped) break;
  }
  report.walkStoppedAt = state.stopped ? limit : null;
  const candidates = [...state.candidates].sort();
  for (const [relative, reason] of state.skipped) report.skipped.push({ path: relative, reason });
  if (candidates.length === 0) return report;

  let run: FileHandle;
  try {
    run = await openRunFolder(input.workspace, input.runDirectory);
  } catch (error) {
    const code = errorCode(error instanceof Error ? error : String(error));
    for (const relative of candidates) report.skipped.push({ path: relative, reason: `was not copied: the results folder could not be made (${code})` });
    return report;
  }
  report.directory = path.posix.join(METRICS_DIR, ARTIFACTS_DIR, input.runDirectory);
  let runBytes = 0;
  try {
    for (const relative of candidates) {
      if (!artifactPathAllowed(relative)) {
        report.skipped.push({ path: relative, reason: "has a character GitHub artifacts cannot hold" });
        continue;
      }
      if (report.kept.length >= MAX_EVAL_ARTIFACT_FILES_PER_RUN) {
        report.skipped.push({ path: relative, reason: `is over the ${MAX_EVAL_ARTIFACT_FILES_PER_RUN}-file limit for a model run` });
        continue;
      }
      let result: CopyResult;
      try {
        result = await copyOne(input, run, relative, MAX_EVAL_ARTIFACT_BYTES_PER_RUN - runBytes);
      } catch (error) {
        result = { skipped: `could not be copied (${errorCode(error instanceof Error ? error : String(error))})` };
      }
      if ("kept" in result) {
        runBytes += result.kept;
        report.kept.push({ path: relative, bytes: result.kept });
      } else {
        report.skipped.push({ path: relative, reason: result.skipped });
      }
    }
  } finally {
    await run.close();
  }
  return report;
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The job log lines for one model run's copy: every kept and skipped file. Paths are JSON-quoted, so no name starts a workflow command. */
export function artifactReportLines(model: string, report: ArtifactCopyReport): string[] {
  const lines: string[] = [];
  const total = report.kept.reduce((sum, file) => sum + file.bytes, 0);
  lines.push(report.kept.length === 0
    ? `BenchRouter: no artifacts kept for ${model}.`
    : `BenchRouter: kept ${report.kept.length} evaluator artifact(s) (${sizeText(total)}) for ${model} in ${report.directory}; the workflow uploads them with this GitHub run's artifacts.`);
  for (const file of report.kept) lines.push(`BenchRouter: kept artifact ${JSON.stringify(file.path)} (${sizeText(file.bytes)}).`);
  for (const file of report.skipped) lines.push(`BenchRouter: skipped artifact ${JSON.stringify(file.path)}: it ${file.reason}.`);
  for (const entry of report.unmatched) lines.push(`BenchRouter: artifact entry ${JSON.stringify(entry)} matched no file.`);
  if (report.walkStoppedAt !== null) lines.push(`BenchRouter: artifact matching stopped after ${report.walkStoppedAt} directory entries; narrow the globs to keep the rest.`);
  if (report.skipped.length > 0) lines.push(`::warning title=BenchRouter artifacts::${report.skipped.length} evaluator artifact(s) of ${model} were skipped. The job log names each one and why.`);
  return lines;
}

/** EVAL-012: copies one model run's artifacts and writes the job log lines. It never throws. */
export async function keepEvalArtifacts(input: Omit<ArtifactCopyInput, "tree"> & { pinned: PinnedTree; model: string }): Promise<void> {
  if (!("tree" in input.pinned)) {
    console.log(`::warning title=BenchRouter artifacts::BenchRouter: no artifacts kept for ${input.model}: ${input.pinned.problem}.`);
    return;
  }
  try {
    for (const line of artifactReportLines(input.model, await copyEvalArtifacts({ ...input, tree: input.pinned.tree }))) console.log(line);
  } catch (error) {
    console.log(`::warning title=BenchRouter artifacts::BenchRouter: no artifacts kept for ${input.model}: the copy failed (${errorCode(error instanceof Error ? error : String(error))}). The result is not affected.`);
  }
}
