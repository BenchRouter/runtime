"""RUN-001 (repo work queue §8.3, §10): the residue check for a queue session on the customer's compute.

An item's evaluator runs in its own process group, and the group kill misses a `setsid` or double-fork daemon. That
daemon runs as the same user as the next item's child, so it can read the next item's `/proc/<pid>/environ`. After each
item the parent diffs `/proc` by UID against the table it took before the item. A new same-UID process counts as residue
when its parent chain reaches PID 1 or the runner itself without passing through a process that existed before. A chain
that cannot be read counts as residue, and so does a table that cannot be read. This mirrors runtime/src/processes.ts.
"""

from __future__ import annotations

import os
import time

#: A process table: pid -> (ppid, uid).
Table = dict[int, tuple[int, int]]

SETTLE_S = 1.0
RECHECK_S = 0.5
MAX_CHAIN = 64


def list_processes(proc: str = "/proc") -> Table:
    """Every process under `proc` (Linux, the customer's compute). A missing `/proc` raises `OSError`. `/proc/<pid>/stat` is `pid (comm) state ppid ...`, and `comm` can hold spaces and parentheses."""
    table: Table = {}
    for name in os.listdir(proc):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            uid = os.stat(os.path.join(proc, name)).st_uid
            with open(os.path.join(proc, name, "stat"), encoding="utf-8", errors="replace") as handle:
                stat = handle.read()
            fields = stat[stat.rindex(")") + 1:].split()
            ppid = int(fields[1])
        except (OSError, ValueError, IndexError):
            # The process ended while the table was read.
            continue
        # A zombie is not a running process: it holds no environment to read. Nothing reaps it when PID 1 of the compute does not.
        if fields[0] == "Z":
            continue
        table[pid] = (ppid, uid)
    if os.getpid() not in table:
        raise OSError("the process table does not list this process")
    return table


def residue_pids(before: Table, after: Table, own_pid: int, uid: int) -> list[int]:
    residue: list[int] = []
    for pid, (ppid, owner) in after.items():
        if pid in before or owner != uid or pid == own_pid:
            continue
        current = ppid
        verdict = "residue"
        seen = {pid}
        for _ in range(MAX_CHAIN):
            if current <= 1 or current == own_pid:
                break
            if current in before:
                verdict = "unrelated"
                break
            parent = after.get(current)
            # A missing parent or a loop is an unreadable chain: residue.
            if parent is None or current in seen:
                break
            seen.add(current)
            current = parent[0]
        if verdict == "residue":
            residue.append(pid)
    return residue


def survivors(before: Table, uid: int | None = None, own_pid: int | None = None, proc: str = "/proc",
              settle_s: float = SETTLE_S, recheck_s: float = RECHECK_S) -> list[int]:
    """New residue after the settle and the recheck. A short-lived process mid-exit in the first read is gone in the second."""
    uid = os.getuid() if uid is None else uid
    own_pid = os.getpid() if own_pid is None else own_pid
    time.sleep(settle_s)
    stray = residue_pids(before, list_processes(proc), own_pid, uid)
    if stray:
        time.sleep(recheck_s)
        later = set(residue_pids(before, list_processes(proc), own_pid, uid))
        stray = [pid for pid in stray if pid in later]
    return stray
