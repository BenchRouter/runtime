"""RUN-001 (repo work queue §8.3, §10): the wheel's residue check, the item's private TMPDIR and the `isolation` key."""

import os
import sys
import tempfile
import threading
import time
import unittest

from benchrouter_databricks import residue
from benchrouter_databricks.child import Masker, child_env, run_child
from benchrouter_databricks.manifest import load_manifest
from benchrouter_databricks.refresh import describe_artifact
from tests.eval_manifest import MANIFEST, ROUTE

# Some CI interpreters cannot start without their library path; it is added on top of `child_env` (see test_child.py).
HARNESS = {name: os.environ[name] for name in ("LD_LIBRARY_PATH",) if name in os.environ}
ME = 1000
OWN = 500
BEFORE = {1: (0, 0), 200: (1, ME), 300: (200, ME), OWN: (200, ME)}


class ResiduePidsTest(unittest.TestCase):
    def test_an_orphan_re_parented_to_init_and_its_children_are_residue(self):
        after = {**BEFORE, 900: (1, ME), 901: (900, ME)}
        self.assertEqual(residue.residue_pids(BEFORE, after, OWN, ME), [900, 901])

    def test_a_new_process_under_an_older_parent_or_of_another_user_is_not(self):
        after = {**BEFORE, 900: (300, ME), 901: (1, 0)}
        self.assertEqual(residue.residue_pids(BEFORE, after, OWN, ME), [])

    def test_a_process_the_runner_started_and_a_chain_it_cannot_read_are_residue(self):
        after = {**BEFORE, 900: (OWN, ME), 901: (777, ME), 902: (903, ME), 903: (902, ME)}
        self.assertEqual(residue.residue_pids(BEFORE, after, OWN, ME), [900, 901, 902, 903])


class ZombieTest(unittest.TestCase):
    def test_a_zombie_is_not_a_running_process(self):
        with tempfile.TemporaryDirectory() as proc:
            for pid, state in ((os.getpid(), "S"), (900, "Z"), (901, "S")):
                os.mkdir(os.path.join(proc, str(pid)))
                with open(os.path.join(proc, str(pid), "stat"), "w", encoding="utf-8") as handle:
                    handle.write(f"{pid} (a (b) c) {state} 1 0 0")
            table = residue.list_processes(proc)
        self.assertNotIn(900, table)
        self.assertIn(901, table)


@unittest.skipUnless(os.path.isdir("/proc"), "the wheel runs on Linux compute")
class RealTableTest(unittest.TestCase):
    def test_the_real_table_lists_this_process_and_shows_no_residue_against_itself(self):
        table = residue.list_processes()
        self.assertEqual(table[os.getpid()], (os.getppid(), os.getuid()))
        self.assertEqual(residue.residue_pids(table, table, os.getpid(), os.getuid()), [])

    def test_a_proc_that_does_not_list_this_process_is_unreadable(self):
        with tempfile.TemporaryDirectory() as empty:
            with open(os.path.join(empty, "1"), "w"):
                pass
            with self.assertRaises(OSError):
                residue.list_processes(empty)

    def test_a_started_process_that_outlives_its_group_is_found_after_the_settle(self):
        before = residue.list_processes()
        stray = os.fork()
        if stray == 0:
            os.setsid()
            time.sleep(5)
            os._exit(0)
        try:
            # The child is ours, so its parent chain reaches this process: it counts as residue.
            self.assertEqual(residue.survivors(before, settle_s=0.1, recheck_s=0.1), [stray])
        finally:
            os.kill(stray, 9)
            os.waitpid(stray, 0)


class ChildTmpdirTest(unittest.TestCase):
    def test_the_child_gets_its_items_private_tmpdir(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as private:
            env = child_env({}, venv="/venv", home=home, call_token="t", api_base="https://api.benchrouter.com", route_id="r",
                            base_url_env=None, secrets={}, tmpdir=private)
            out = os.path.join(home, "tmp.txt")
            script = f"import os, tempfile; open({out!r}, 'w').write(tempfile.gettempdir())"
            outcome = run_child([sys.executable, "-I", "-c", script], home, {**env, "PATH": os.environ["PATH"], **HARNESS}, time.monotonic() + 4, threading.Event(), Masker([]))
            self.assertEqual(outcome.exit_code, 0)
            with open(out, encoding="utf-8") as handle:
                self.assertEqual(os.path.realpath(handle.read()), os.path.realpath(private))


class IsolationKeyTest(unittest.TestCase):
    def artifact(self, manifest_text):
        manifest = load_manifest(manifest_text, ROUTE)
        return describe_artifact(manifest, [], {}, [{"critical": False}], "3.12.3", "linux_x86_64+glibc_2.35")

    def test_a_route_that_declares_job_sends_it_and_the_default_sends_nothing(self):
        self.assertNotIn("isolation", self.artifact(MANIFEST))
        declared = MANIFEST.replace("      mode: repository_executable\n", "      mode: repository_executable\n      isolation: job\n")
        self.assertEqual(self.artifact(declared)["isolation"], "job")


if __name__ == "__main__":
    unittest.main()
