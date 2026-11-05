// EVAL-012: a repository_executable eval pack's `artifacts`: the side outputs its evaluator writes for
// a person to read, such as drafts. One validator serves setup input, the snapshot contract and the
// signed runtime's manifest parser, so all three accept and refuse the same declarations.
//
// Artifacts are never eval identity or evidence. They stay out of the input and acceptance
// fingerprints and the contract digest's manifest entry. BenchRouter keeps the declared list (part
// of the recorded eval pack) and none of the files: the runtime copies them into the job's results
// directory, and the generated workflow uploads that directory to the customer's own repository as
// a GitHub Actions artifact.
import { isJsonString, type JsonValue } from "./json-parse-contracts";
import { isNormalizedRepoPath } from "../runner/path-globs";

/** The most entries one route declares. */
export const MAX_EVAL_ARTIFACT_ENTRIES = 16;
/** The longest entry, in characters. */
export const MAX_EVAL_ARTIFACT_ENTRY_LENGTH = 256;
/** The most files the runtime keeps for one model run. */
export const MAX_EVAL_ARTIFACT_FILES_PER_RUN = 32;
/** The most bytes the runtime keeps for one model run. */
export const MAX_EVAL_ARTIFACT_BYTES_PER_RUN = 8 * 1024 * 1024;
/** The most bytes the runtime keeps across every model run of one job. */
export const MAX_EVAL_ARTIFACT_BYTES_PER_JOB = 128 * 1024 * 1024;
/** The most directory entries the runtime reads while it matches one model run's globs. */
export const MAX_EVAL_ARTIFACT_WALK_ENTRIES = 10_000;
/** Directories a glob never looks inside. */
export const EVAL_ARTIFACT_SKIPPED_DIRECTORIES: readonly string[] = [".git", "node_modules"];

/**
 * Characters a GitHub Actions artifact path cannot hold (upload-artifact refuses the whole
 * upload), plus the glob syntax the matcher does not support. `*` and `?` are the wildcards.
 */
const REFUSED_CHARACTERS = new Set(['"', ":", "<", ">", "|", "[", "]", "{", "}", "+"]);

export type EvalArtifactsParse = { ok: true; artifacts: string[] | null } | { ok: false; message: string };

/** True when the entry holds a wildcard, so the runtime matches it as a glob. */
export function isEvalArtifactGlob(entry: string): boolean {
  return entry.includes("*") || entry.includes("?");
}

function entryProblem(entry: string, label: string): string | null {
  if (entry.length === 0 || entry !== entry.trim()) return `${label} must be a non-empty string without surrounding whitespace`;
  if (entry.length > MAX_EVAL_ARTIFACT_ENTRY_LENGTH) return `${label} must be at most ${MAX_EVAL_ARTIFACT_ENTRY_LENGTH} characters`;
  for (const character of entry) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return `${label} must not contain control characters`;
    if (REFUSED_CHARACTERS.has(character)) return `${label} must not contain ${JSON.stringify(character)}; use only * and ? as wildcards`;
  }
  if (entry.startsWith("!")) return `${label} must not start with !; artifacts take no exclusions`;
  if (!isNormalizedRepoPath(entry)) return `${label} must be a normalized repository-relative path or glob, with no leading /, no .. and no empty segment`;
  if (entry.split("/").includes(".git")) return `${label} must not name a .git directory`;
  return null;
}

/**
 * EVAL-012: `eval_pack.artifacts`. Absent, null or an empty list declares none (null). Otherwise
 * a list of at most 16 distinct repository-relative paths or globs (`*`, `**` and `?`).
 */
export function parseEvalArtifacts(value: JsonValue | undefined, label: string): EvalArtifactsParse {
  if (value === undefined || value === null) return { ok: true, artifacts: null };
  if (!Array.isArray(value)) return { ok: false, message: `${label} must be a list of repository-relative paths or globs` };
  if (value.length > MAX_EVAL_ARTIFACT_ENTRIES) return { ok: false, message: `${label} must list at most ${MAX_EVAL_ARTIFACT_ENTRIES} paths or globs` };
  const artifacts: string[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${label}[${index}]`;
    if (!isJsonString(entry)) return { ok: false, message: `${at} must be a non-empty string without surrounding whitespace` };
    const problem = entryProblem(entry, at);
    if (problem !== null) return { ok: false, message: problem };
    artifacts.push(entry);
  }
  if (new Set(artifacts).size !== artifacts.length) return { ok: false, message: `${label} must not contain duplicates` };
  return { ok: true, artifacts: artifacts.length === 0 ? null : artifacts };
}

/** A directory-name part GitHub artifacts can hold: letters, digits, `.`, `_` and `-`; anything else becomes `_`. */
function directoryPart(value: string): string {
  let part = "";
  for (const character of value) {
    const keep = (character >= "a" && character <= "z") || (character >= "A" && character <= "Z") || (character >= "0" && character <= "9") ||
      character === "." || character === "_" || character === "-";
    part += character === "/" ? "__" : keep ? character : "_";
  }
  return part;
}

/**
 * The directory under `.br-results/artifacts/` that holds one model run's copies, named by the
 * model first, for example `openai__gpt-5.5.as_sent.emr_abc.1-1`. The run, attempt and lease make
 * it unique within a job.
 */
export function evalArtifactRunDirectory(run: { model: string; profile: string; modelRunId: string; retryAttempt: number; leaseGen: number }): string {
  return [directoryPart(run.model), directoryPart(run.profile), directoryPart(run.modelRunId), `${run.retryAttempt}-${run.leaseGen}`].join(".");
}

/** The GitHub run page's artifact list, where the customer downloads a run's artifacts. */
export function githubRunArtifactsUrl(githubRunUrl: string): string {
  return `${githubRunUrl}#artifacts`;
}
