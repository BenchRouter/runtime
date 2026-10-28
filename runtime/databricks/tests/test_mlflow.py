"""The results task on real MLflow (local SQLite stores, no HTTP).

CI runs this with the results task's MLflow installed (.github/workflows/ci.yml). The evaluator
child itself is proved live (plan 4.4, B6 dry run and smoke): a real `mlflow.genai.evaluate` run
takes longer than the 5 s test limit on CI.
"""

import os
import tempfile
import unittest
import warnings

import mlflow

from benchrouter_databricks.results import copy_to_experiment

QUIET = {"MLFLOW_DISABLE_TELEMETRY": "true", "MLFLOW_DISABLE_AGENT_HINT": "1", "MLFLOW_ENABLE_ASYNC_TRACE_LOGGING": "false"}


class ResultsCopyTest(unittest.TestCase):
    def test_every_case_trace_is_copied_past_one_page(self):
        warnings.filterwarnings("ignore", category=FutureWarning)
        os.environ.update(QUIET)
        with tempfile.TemporaryDirectory() as root:
            mlflow.set_tracking_uri(f"sqlite:///{root}/source.db")
            mlflow.set_experiment("source")
            with mlflow.start_run() as run:
                for index in range(101):
                    with mlflow.start_span(name="predict") as span:
                        span.set_inputs({"question": str(index)})
                        span.set_outputs(str(index))
                        mlflow.set_trace_tag(span.trace_id, "benchrouter.case_id", f"c{index}")
                # A judge's own traced call is not a case.
                with mlflow.start_span(name="judge") as span:
                    span.set_outputs("yes")
            record = {"mlflow_run_id": run.info.run_id, "model": "candidate", "work_id": "work", "result_set_id": "set"}
            copied = copy_to_experiment(record, f"{root}/source.db", "destination", f"sqlite:///{root}/destination.db")
        self.assertEqual(copied, 101)


if __name__ == "__main__":
    unittest.main()
