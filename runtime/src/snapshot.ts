// §3.2, §3.8: the snapshot of the eval tree. The runtime reports what the server needs
// to compose the fingerprint and `contract_digest`; it never composes a digest itself.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRunnerBatchCaseId, type RunnerRouteContract, type Sha256Digest } from "../../src/shared/runner-protocol";
import { loadReplayCases, planningRequirements } from "./cases";
import { sha256Digest } from "./json";
import { declaredFiles, type ManifestRoute } from "./manifest";

export async function hashDeclaredFiles(treeRoot: string, route: ManifestRoute): Promise<Record<string, Sha256Digest>> {
  const hashes: Record<string, Sha256Digest> = {};
  for (const file of declaredFiles(route)) hashes[file] = sha256Digest(await readFile(path.join(treeRoot, file)));
  return hashes;
}

/**
 * `reportCaseIndex`: the server accepts a case index (hello listed `case_index`)
 * and this runtime runs case subsets. A route with a case ID outside the batch
 * case domain (`isRunnerBatchCaseId`) reports none, so it is leased whole.
 */
export async function routeContract(treeRoot: string, route: ManifestRoute, reportCaseIndex = false): Promise<RunnerRouteContract> {
  const fileHashes = await hashDeclaredFiles(treeRoot, route);
  if (route.executable) {
    const executable = route.executable;
    return {
      route_key: route.routeId,
      mode: route.mode,
      manifest_entry: route.entry,
      file_hashes: fileHashes,
      argv: executable.argv,
      working_directory: executable.workingDirectory,
      judge_model: null,
      env_names: [...executable.secretEnv].sort(),
      case_count: 0,
      // Executable planning knows the API family but has no frozen request examples.
      request_features: { required_parameters: [], api_families: [executable.apiFamily], features: [], input_kinds: ["input.text"], output_kinds: ["text"], protocol_headers: [] }
    };
  }
  const cases = await loadReplayCases(treeRoot, route);
  const contract: RunnerRouteContract = {
    route_key: route.routeId,
    mode: route.mode,
    manifest_entry: route.entry,
    file_hashes: fileHashes,
    argv: null,
    working_directory: null,
    judge_model: route.judgeModel,
    env_names: [],
    case_count: cases.length,
    request_features: planningRequirements(cases)
  };
  if (reportCaseIndex && cases.length > 0 && cases.every((testCase) => isRunnerBatchCaseId(testCase.id))) {
    contract.case_index = cases.map((testCase) => ({ case_id: testCase.id, case_version: testCase.version }));
  }
  return contract;
}

/** §3.2: re-hash before an item runs; any difference is `tree_mutated`. */
export function sameHashes(left: Record<string, Sha256Digest>, right: Record<string, Sha256Digest>): boolean {
  const keys = Object.keys(left).sort();
  return keys.join("\n") === Object.keys(right).sort().join("\n") && keys.every((key) => left[key] === right[key]);
}
