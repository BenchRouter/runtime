"""Plan 4.4: the app and the runner read one eval manifest with one parser.

Add eval and Status (the app) read the cases table and the declared secrets of a route's entry; the
runner reads the whole entry. The B11 live smoke found two parsers apart: the app read
`eval_pack.executable.secret_env`, the runner `eval_pack.secret_env`, so Status showed no secret to
grant for a manifest the runner then failed with `secret_unreadable`. The app now reads through
`benchrouter_databricks.manifest.load_manifest`, over the workspace export the app makes.
"""

import base64
import unittest

from benchrouter_app import store
from benchrouter_app.workspace_ops import read_manifest
from benchrouter_databricks.manifest import load_manifest
from tests.recorded_workspace import RecordedServer

ROUTE = "acme/triage"
FOLDER = "/Workspace/Users/admin@example.com/evals/triage"
MANIFEST = f"""
product:
  slug: acme
routes:
  - route_id: {ROUTE}
    call_site:
      base_url_env: OPENAI_BASE_URL
    eval_pack:
      mode: repository_executable
      api_family: openai_chat_completions
      lockfile: requirements.lock
      input_refs: [predict.py]
      acceptance_refs: [scorers.py]
      primary_metric: exact
      timeout_minutes: 20
      secret_env: [JUDGE_API_KEY, LOOKUP_TOKEN]
      databricks:
        cases_table: main.support.triage_cases
        secret_scope: acme-evals
        cases: {{id_column: case_id, inputs_column: inputs}}
        predict: {{file: predict.py, function: predict_fn}}
        scorers: {{file: scorers.py, attribute: SCORERS}}
        normalization:
          version: 1
          metrics:
            - {{name: exact, assessment: exact, type: boolean, required: true}}
          pass_rule: {{metrics: [exact], min_score: 1}}
"""


def exported(text: str) -> dict:
    return {"status": 200, "body": {"content": base64.b64encode(text.encode()).decode(), "file_type": "yml"}}


class AppReadsTheRunnersManifest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = RecordedServer({})

    def tearDown(self) -> None:
        self.server.close()

    def test_same_cases_table_and_secrets(self) -> None:
        self.server.answers["GET /api/2.0/workspace/export"] = exported(MANIFEST)
        app = read_manifest(self.server.workspace(), FOLDER, ROUTE)
        runner = load_manifest(MANIFEST, ROUTE, own_scope=store.SCOPE)
        self.assertEqual(app.cases_table, runner.cases_table)
        self.assertEqual(app.secrets, runner.secrets)
        self.assertEqual([(s.env, s.scope, s.key) for s in app.secrets],
                         [("JUDGE_API_KEY", "acme-evals", "JUDGE_API_KEY"), ("LOOKUP_TOKEN", "acme-evals", "LOOKUP_TOKEN")])
        self.assertEqual(self.server.calls[0][2], {"path": f"{FOLDER}/.benchrouter/benchrouter.yml", "format": "SOURCE"})


if __name__ == "__main__":
    unittest.main()
