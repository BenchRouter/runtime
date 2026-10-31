"""Plan 4.3: the agent refuses workspace wheels and releases without a pinned digest."""

import unittest

from benchrouter_databricks.agent import RELEASE_PREFIX, follow_release
from benchrouter_databricks.handlers import Context
from tests.recorded_workspace import RecordedServer


class AgentReleaseSourceTest(unittest.TestCase):
    def test_untrusted_dependencies_never_reach_the_jobs_api(self):
        server = RecordedServer({})
        try:
            ctx = Context(server.workspace(), "benchrouter", 99)
            for dependency in (
                "/Workspace/Shared/benchrouter.whl#sha256=" + "a" * 64,
                "https://example.com/benchrouter.whl#sha256=" + "a" * 64,
                RELEASE_PREFIX + "0.3.0/benchrouter_databricks-0.3.0-py3-none-any.whl",
            ):
                with self.subTest(dependency=dependency):
                    follow_release(ctx, {"version": "0.3.0", "dependency": dependency})
                    self.assertEqual(server.calls, [])
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
