// §3.2: the immutable execution tree. The runtime fetches `eval_sha` into an empty
// `.br-eval`, checks it out detached, and verifies HEAD and a clean status. The fetch
// token reaches git only through a credential helper in the git child's env: never in
// argv, never in a config file, and the helper answers only for this repository.
// §3.8: the push-ordering proof reads the default branch's commit graph (no trees).
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RunnerAncestryProof } from "../../src/shared/runner-protocol";
import { childEnv, type ControlContext } from "./control";
import type { StringMap } from "./transport";

export const EVAL_TREE_DIR = ".br-eval";
const GIT_TIMEOUT_MS = 10 * 60_000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function repositoryUrl(context: ControlContext): string {
  if (!context.repository) throw new Error("GITHUB_REPOSITORY is required to fetch the eval tree");
  return `${context.serverUrl}/${context.repository}.git`;
}

/**
 * The git child's env. The helper is set through GIT_CONFIG_* env (git ≥ 2.31), scoped to
 * this repository's URL, answers only `get`, and reads the token from its own env var.
 * System and global config are ignored, so no other helper can store the token.
 */
function gitEnv(context: ControlContext): StringMap {
  const env = childEnv(context, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "",
    SSH_ASKPASS: ""
  });
  if (!context.fetchToken) return { ...env, GIT_CONFIG_COUNT: "0" };
  const scope = repositoryUrl(context);
  return {
    ...env,
    BENCHROUTER_GIT_TOKEN: context.fetchToken,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.useHttpPath",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: `credential.${scope}.helper`,
    GIT_CONFIG_VALUE_2: '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$BENCHROUTER_GIT_TOKEN"; }; f'
  };
}

function git(context: ControlContext, cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: gitEnv(context), timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : Number.isInteger(error.code) ? Number(error.code) : 1;
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function gitOk(context: ControlContext, cwd: string, args: string[]): Promise<string> {
  const result = await git(context, cwd, args);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.slice(0, 400)}`);
  return result.stdout;
}

export type EvalTreeResult = { ok: true; root: string } | { ok: false; detail: string };

/** §3.2 checkout: fetch depth 1, detached, HEAD = eval_sha, clean status. */
export async function fetchEvalTree(context: ControlContext, evalSha: string): Promise<EvalTreeResult> {
  const root = path.join(context.workspace, EVAL_TREE_DIR);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await gitOk(context, root, ["init", "-q"]);
  await gitOk(context, root, ["remote", "add", "origin", repositoryUrl(context)]);
  const fetched = await git(context, root, ["fetch", "-q", "--no-tags", "--depth=1", "origin", evalSha]);
  if (fetched.code !== 0) return { ok: false, detail: fetched.stderr.slice(0, 400) };
  await gitOk(context, root, ["checkout", "-q", "--detach", evalSha]);
  const head = await gitOk(context, root, ["rev-parse", "HEAD"]);
  if (head !== evalSha) throw new Error(`eval tree HEAD ${head} is not eval_sha ${evalSha}`);
  const status = await gitOk(context, root, ["status", "--porcelain"]);
  if (status.length > 0) throw new Error("eval tree is not clean after checkout");
  return { ok: true, root };
}

/**
 * §3.8: `descends` = last_imported_sha is an ancestor of eval_sha (vacuously true before
 * the first import); `is_head` = eval_sha is the remote default-branch head now.
 */
export async function ancestryProof(context: ControlContext, treeRoot: string, evalSha: string, defaultBranch: string, lastImported: string | null): Promise<RunnerAncestryProof> {
  const ref = `refs/remotes/origin/${defaultBranch}`;
  await gitOk(context, treeRoot, ["fetch", "-q", "--no-tags", "--filter=tree:0", "--unshallow", "origin", `+refs/heads/${defaultBranch}:${ref}`]);
  const head = await gitOk(context, treeRoot, ["rev-parse", ref]);
  let descends = true;
  if (lastImported !== null) {
    const check = await git(context, treeRoot, ["merge-base", "--is-ancestor", lastImported, evalSha]);
    // 0 = ancestor, 1 = not an ancestor; anything else (an orphaned, unknown commit) is not proof of descent.
    descends = check.code === 0;
  }
  return { last_imported_sha: lastImported, descends, is_head: head === evalSha };
}
