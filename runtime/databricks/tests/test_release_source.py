"""Plan 4.3 (FUSE access): the agent job installs the server's pinned release, never an uploaded wheel.

Codex review round 3 (PR #657): Connect built the agent job from a wheel in the app SP's home folder.
"""

import unittest

from benchrouter_app.workspace_ops import agent_job_settings

PINNED = ("https://runtime.benchrouter.com/v1/databricks/releases/0.2.0/benchrouter_databricks-0.2.0-py3-none-any.whl"
          "#sha256=" + "a" * 64)


class AgentReleaseSourceTest(unittest.TestCase):
    def test_connect_installs_exactly_the_servers_environment(self):
        registered = {
            "agent": {"package": "benchrouter_databricks", "entry_point": "agent", "max_concurrent_runs": 1,
                      "job_parameters": {"api_base": "https://api.benchrouter.com", "scope": "benchrouter", "poll_key_name": "poll-key", "job_id": "{{job.id}}"},
                      "environment": {"client": "3", "dependencies": [PINNED]}},
            "agent_schedule": {"quartz_cron_expression": "0 7 * * * ?", "timezone_id": "UTC"},
        }
        settings = agent_job_settings(registered)
        self.assertEqual([env["spec"] for env in settings["environments"]], [{"client": "3", "dependencies": [PINNED]}])


if __name__ == "__main__":
    unittest.main()
