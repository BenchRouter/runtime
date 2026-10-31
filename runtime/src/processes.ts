// §3.3.5 process control: every scorer, install and evaluator runs as a child in its
// own process group. A deadline sends SIGTERM to the group, then SIGKILL after 5 s.
// On runtime exit every group still alive is killed. Child processes are timeout
// control, not a sandbox: they run as the same user.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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
 * RUN-001 (repo work queue §8.3): the new same-UID processes that count as residue. A new process counts
 * when its parent chain reaches PID 1 (an orphan: a `setsid` or double-fork daemon) or the runtime itself
 * without passing through a process that already existed before the item. A new process under an
 * older, unrelated parent (another session's tool, a runner agent) is not ours. Fail safe: a chain that
 * cannot be read (a missing parent, a loop, more than 64 steps) counts as residue, so the job ends and the
 * next item gets a fresh job. A process started through an already-running daemon (`docker run` under
 * dockerd) has a parent chain into that daemon and is not seen; a route that needs this declares `isolation: job`.
 */
export function residuePids(before: ProcessTable, after: ProcessTable, runtimePid: number, uid: number, exempt: ReadonlySet<number> = new Set()): number[] {
  const residue: number[] = [];
  for (const [pid, row] of after) {
    if (before.has(pid) || row.uid !== uid || pid === runtimePid || exempt.has(pid)) continue;
    let current = row.ppid;
    let verdict: "residue" | "unrelated" = "residue";
    const seen = new Set<number>([pid]);
    for (let step = 0; step < MAX_CHAIN; step += 1) {
      if (current <= 1 || current === runtimePid) break;
      if (before.has(current) || exempt.has(current)) {
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

/** macOS system locations: launchd starts per-user helpers from here (`mdworker_shared`, `com.apple.WebKit.GPU`, `biomesyncd`). */
const DARWIN_SYSTEM_PREFIXES = ["/System/", "/usr/libexec/", "/usr/sbin/"];

/** RUN-001 (repo work queue §8.3): whether a command path belongs to macOS itself. A plain prefix test. */
export function isDarwinSystemPath(command: string): boolean {
  return DARWIN_SYSTEM_PREFIXES.some((prefix) => command.startsWith(prefix));
}

/** The command path of one process, from `ps -o comm=`. `null` when it cannot be read. */
export function commandPath(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 10_000 }, (error, stdout) => {
      const command = error ? "" : stdout.trim();
      resolve(command.length > 0 ? command : null);
    });
  });
}

/**
 * RUN-001 (repo work queue §8.3): on macOS, the new same-UID processes that launchd (PID 1) started from a system
 * path. launchd starts per-user helpers all the time, and each has the shape of a `setsid` daemon, so without this
 * a logged-in Mac ends most batches. Only paths under `/System/`, `/usr/libexec/` and `/usr/sbin/` are exempt.
 * Everything else stays residue, and so does a command that cannot be read. Other platforms exempt nothing.
 */
export async function systemOrphanPids(before: ProcessTable, after: ProcessTable, runtimePid: number, uid: number): Promise<Set<number>> {
  const exempt = new Set<number>();
  if (process.platform !== "darwin") return exempt;
  for (const pid of residuePids(before, after, runtimePid, uid)) {
    if (after.get(pid)?.ppid !== 1) continue;
    const command = await commandPath(pid);
    if (command !== null && isDarwinSystemPath(command)) exempt.add(pid);
  }
  return exempt;
}
