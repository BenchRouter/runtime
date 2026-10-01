// §2.2, §2.3, §3.1: what hello reports about the committed kit at workflow_sha. The
// control checkout holds only the bootstrap, trust.json and the workflow file. The
// workflow is parsed with a real YAML parser, never by pattern matching.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { RunnerAuthorityCapability, Sha256Digest } from "../../src/shared/runner-protocol";
import { isJsonObject, isJsonString, ProtocolError, sha256Digest, type JsonObject, type JsonValue } from "./json";

export const WORKFLOW_PATH = ".github/workflows/benchrouter-evals.yml";
export const KIT_FILES = [".benchrouter/bootstrap.mjs", ".benchrouter/trust.json", WORKFLOW_PATH] as const;
/** §3.9: the install-only registry grant env name (§7.3 decision 1). */
export const INSTALL_GRANT_ENV = "BENCHROUTER_INSTALL_NPM_TOKEN";

export interface CommittedKit {
  workflowPaths: string[];
  authority: RunnerAuthorityCapability[];
  kitFileHashes: Record<string, Sha256Digest>;
  /** Evaluator secret names the workflow grants to the runtime step (names only). */
  evaluatorSecretNames: string[];
}

function toJson(value: JsonValue | undefined): JsonObject {
  return value !== undefined && isJsonObject(value) ? value : {};
}

function pathList(trigger: JsonValue | undefined): string[] {
  const paths = toJson(trigger).paths;
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || !paths.every(isJsonString)) throw new ProtocolError(`${WORKFLOW_PATH}: trigger paths must be a list of strings`);
  return paths;
}

function referencesSecret(value: JsonValue): boolean {
  return isJsonString(value) && value.includes("secrets.");
}

export async function readCommittedKit(controlRoot: string): Promise<CommittedKit> {
  const kitFileHashes: Record<string, Sha256Digest> = {};
  for (const file of KIT_FILES) kitFileHashes[file] = sha256Digest(await readFile(path.join(controlRoot, file)));
  let parsed: JsonValue;
  try {
    // SAFETY: the yaml parser returns plain JSON-compatible data for a workflow file (no custom tags).
    parsed = parseYaml(await readFile(path.join(controlRoot, WORKFLOW_PATH), "utf8")) as JsonValue;
  } catch (error) {
    throw new ProtocolError(`${WORKFLOW_PATH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workflow = toJson(parsed);
  const on = toJson(workflow.on);
  // Order matters: GitHub evaluates `!` negations in sequence, and so does the server.
  const workflowPaths = [...pathList(on.pull_request)];
  for (const entry of pathList(on.push)) if (!workflowPaths.includes(entry)) workflowPaths.push(entry);
  const secretNames = new Set<string>();
  let installGrant = false;
  for (const job of Object.values(toJson(workflow.jobs))) {
    const steps = toJson(job).steps;
    for (const step of Array.isArray(steps) ? steps : []) {
      for (const [name, value] of Object.entries(toJson(toJson(step).env))) {
        if (!referencesSecret(value)) continue;
        if (name === INSTALL_GRANT_ENV) installGrant = true;
        else if (!name.startsWith("BENCHROUTER_")) secretNames.add(name);
      }
    }
  }
  const authority: RunnerAuthorityCapability[] = [];
  if (secretNames.size > 0) authority.push("evaluator_secrets");
  if (installGrant) authority.push("install_grant");
  return { workflowPaths, authority, kitFileHashes, evaluatorSecretNames: [...secretNames].sort() };
}
