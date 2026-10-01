// §3.3.5 process control: every scorer, install and evaluator runs as a child in its
// own process group. A deadline sends SIGTERM to the group, then SIGKILL after 5 s.
// On runtime exit every group still alive is killed. Child processes are timeout
// control, not a sandbox: they run as the same user.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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
