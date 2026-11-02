// §3.3.5 process control: every scorer, install and evaluator runs as a child in its
// own process group. A deadline sends SIGTERM to the group, then SIGKILL after 5 s.
// On runtime exit every group still alive is killed. Child processes are timeout
// control, not a sandbox: they run as the same user.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import { RUNNER_CHILD_KILL_GRACE_S } from "../../src/shared/runner-protocol";

const live = new Set<ChildProcess>();

/**
 * Signal the child's whole process group. The group outlives its leader, so this does not
 * check whether the leader already exited: grandchildren stay reachable through the group.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Spawn a child as the leader of a new process group, tracked for kill-on-exit. */
export function spawnGroup(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true, shell: false });
  live.add(child);
  child.once("exit", () => live.delete(child));
  child.once("error", () => live.delete(child));
  return child;
}

/** SIGTERM the group, then SIGKILL after the grace period. Resolves when the child exits. */
export function killGroup(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      // The leader is gone; members that outlived it (grandchildren) still get SIGKILL.
      signalGroup(child, "SIGKILL");
      resolve();
      return;
    }
    const timer = setTimeout(() => signalGroup(child, "SIGKILL"), RUNNER_CHILD_KILL_GRACE_S * 1000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      // Grandchildren may outlive the leader: finish the group.
      signalGroup(child, "SIGKILL");
      resolve();
    });
    signalGroup(child, "SIGTERM");
  });
}

export async function killAllGroups(): Promise<void> {
  await Promise.all([...live].map(killGroup));
}

/** Synchronous last resort at process exit: SIGKILL every tracked group. */
export function killAllGroupsNow(): void {
  for (const child of live) signalGroup(child, "SIGKILL");
}

/** One row of `ps -A -o pid=,ppid=,uid=`. */
export type ProcessTable = Map<number, { ppid: number; uid: number }>;

/**
 * RUN-001 (repo work queue §8.3): every process on the machine, from `ps -A -o pid=,ppid=,uid=` (Linux
 * and macOS). Each line is split into fields and read as integers. The `ps` child is left out.
 */
export function listProcesses(): Promise<ProcessTable> {
  return new Promise((resolve, reject) => {
    const child = execFile("ps", ["-A", "-o", "pid=,ppid=,uid="], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const table: ProcessTable = new Map();
      for (const line of stdout.split("\n")) {
        const fields = line.split(" ").filter((field) => field.length > 0).map(Number);
        const [pid, ppid, uid] = fields;
        if (fields.length !== 3 || pid === undefined || ppid === undefined || uid === undefined) continue;
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid) || pid === child.pid) continue;
        table.set(pid, { ppid, uid });
      }
      resolve(table);
    });
  });
}

const MAX_CHAIN = 64;

/**
 * RUN-001 (repo work queue §8.3): candidate filter before the environment marker check. A new process qualifies
 * when its parent chain reaches PID 1 (an orphan: a `setsid` or double-fork daemon) or the runtime itself
 * without passing through a process that already existed before the item. A new process under an
 * older, unrelated parent (another session's tool, a runner agent) is not ours. Fail safe: a chain that
 * cannot be read (a missing parent, a loop, more than 64 steps) stays a candidate. The marker check
 * decides ownership; an unreadable environment fails closed. A process started through an already-running daemon (`docker run` under
 * dockerd) has a parent chain into that daemon and is not seen; a route that needs this declares `isolation: job`.
 */
export function residuePids(before: ProcessTable, after: ProcessTable, runtimePid: number, uid: number): number[] {
  const residue: number[] = [];
  for (const [pid, row] of after) {
    if (before.has(pid) || row.uid !== uid || pid === runtimePid) continue;
    let current = row.ppid;
    let verdict: "residue" | "unrelated" = "residue";
    const seen = new Set<number>([pid]);
    for (let step = 0; step < MAX_CHAIN; step += 1) {
      if (current <= 1 || current === runtimePid) break;
      if (before.has(current)) {
        verdict = "unrelated";
        break;
      }
      const parent = after.get(current);
      // A missing parent or a loop is an unreadable chain: residue.
      if (parent === undefined || seen.has(current)) break;
      seen.add(current);
      current = parent.ppid;
    }
    if (verdict === "residue") residue.push(pid);
  }
  return residue;
}

/** The command path of one process, from `ps -o comm=`. `null` when it cannot be read. */
export function commandPath(pid: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 10_000 }, (error, stdout) => {
      const command = error ? "" : stdout.trim();
      resolve(command.length > 0 ? command : null);
    });
  }).catch(() => null);
}

/** RUN-001 / EVAL-012: only executable-item children receive this entry. */
export const ITEM_MARK_ENV = "BENCHROUTER_ITEM_MARK";

export type ProcessEnvironment =
  | { kind: "readable"; entries: string[] }
  | { kind: "gone" }
  | { kind: "unreadable" };

/** RUN-001: a failed read fails closed; a readable row must carry the exact entry. */
export function environmentIsResidue(environment: ProcessEnvironment, mark: string): boolean {
  return environment.kind === "unreadable" ||
    (environment.kind === "readable" && environment.entries.some((entry) => entry === `${ITEM_MARK_ENV}=${mark}`));
}

/** RUN-001: read only the environment, without exporting its contents or command arguments. */
export async function processEnvironment(pid: number): Promise<ProcessEnvironment> {
  if (process.platform === "linux") {
    try {
      return { kind: "readable", entries: (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0") };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return { kind: "gone" };
      return { kind: "unreadable" };
    }
  }
  if (process.platform !== "darwin") return { kind: "unreadable" };
  return new Promise<ProcessEnvironment>((resolve) => {
    execFile("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve(error.code === 1 && stdout.trim() === "" && stderr.trim() === "" ? { kind: "gone" } : { kind: "unreadable" });
        return;
      }
      resolve({ kind: "readable", entries: stdout.trim().split(" ") });
    });
  }).catch(() => ({ kind: "unreadable" }));
}

/**
 * RUN-001: the environments of many processes with one `ps` call on macOS (one read per process on Linux), so a
 * candidate set the size of a whole user session is read quickly. Rows are `pid command env...`, split on spaces;
 * a pid with no row is gone. A `ps` error other than "some pids are gone" leaves every environment unreadable.
 */
export async function processEnvironments(pids: readonly number[]): Promise<Map<number, ProcessEnvironment>> {
  const result = new Map<number, ProcessEnvironment>();
  if (pids.length === 0) return result;
  if (process.platform !== "darwin") {
    await Promise.all(pids.map(async (pid) => { result.set(pid, await processEnvironment(pid)); }));
    return result;
  }
  const output = await new Promise<{ ok: true; stdout: string } | { ok: false }>((resolve) => {
    execFile("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      // ps exits 1 when some of the pids no longer exist and still prints the rest.
      resolve(error && error.code !== 1 ? { ok: false } : { ok: true, stdout });
    });
  });
  if (!output.ok) {
    for (const pid of pids) result.set(pid, { kind: "unreadable" });
    return result;
  }
  for (const line of output.stdout.split("\n")) {
    const tokens = line.split(" ").filter((token) => token.length > 0);
    const pid = Number(tokens[0]);
    if (!Number.isSafeInteger(pid) || !pids.includes(pid)) continue;
    result.set(pid, { kind: "readable", entries: tokens.slice(1) });
  }
  for (const pid of pids) if (!result.has(pid)) result.set(pid, { kind: "gone" });
  return result;
}

export interface ItemResidue {
  pid: number;
  ppid: number;
  envUnreadable: boolean;
}

/** RUN-001: apply the marker check after the before/after and parent-chain candidate filter. */
export async function itemResidue(before: ProcessTable, after: ProcessTable, runtimePid: number, uid: number, mark: string): Promise<ItemResidue[]> {
  const found: ItemResidue[] = [];
  const candidates = residuePids(before, after, runtimePid, uid);
  const environments = await processEnvironments(candidates);
  for (const pid of candidates) {
    const environment = environments.get(pid) ?? { kind: "unreadable" };
    const row = after.get(pid);
    if (row !== undefined && environmentIsResidue(environment, mark)) found.push({ pid, ppid: row.ppid, envUnreadable: environment.kind === "unreadable" });
  }
  return found;
}
