"""Shared eval manifest for agent grant and reinstall replays."""

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
