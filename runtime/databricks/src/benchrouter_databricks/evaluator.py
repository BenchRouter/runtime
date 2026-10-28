"""The evaluator child (plan sections 4.3 and 4.4). It runs customer code; the parent never does.

The parent starts this file with the venv's interpreter, `python -I evaluator.py <args>`, in
its own process group, with a minimal environment: no Databricks credential, the item's eval
call token and base URL, `DATABRICKS_RUNTIME_VERSION` (without it `import mlflow` fails), and
the manifest's declared secrets. It imports nothing from the BenchRouter wheel (the venv holds
only the customer's locked wheels), so it is self-contained.

It runs `mlflow.genai.evaluate` over the frozen cases against a local MLflow store in its
private home, tagging each case's trace with its opaque case id, and writes, per case, the
assessments MLflow recorded: name, value, source type, and only whether it errored and its
error code. The parent's receipt adapter turns them into the receipt. Rationales, inputs and
outputs stay in the local store, which the results task copies into the customer's
experiment; none of it goes to BenchRouter.
"""

import argparse
import importlib.util
import json
import os
import sys

CASE_TAG = "benchrouter.case_id"


def load_attribute(code_dir, relative_path, attribute):
    path = os.path.join(code_dir, relative_path)
    name = "benchrouter_eval_" + relative_path.replace("/", "_").replace(".", "_")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {relative_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return getattr(module, attribute)


def plain(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-dir", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--predict", required=True, nargs=2)
    parser.add_argument("--scorers", required=True, nargs=2)
    parser.add_argument("--store", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    # Customer modules import their siblings by name.
    sys.path.insert(0, args.code_dir)
    import mlflow

    mlflow.set_tracking_uri("sqlite:///" + args.store)
    mlflow.set_experiment("benchrouter")
    data = []
    with open(args.cases, encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            entry = {"inputs": record["inputs"], "tags": {CASE_TAG: record["case_id"]}}
            if record.get("expectations") is not None:
                entry["expectations"] = record["expectations"]
            data.append(entry)
    predict_fn = load_attribute(args.code_dir, args.predict[0], args.predict[1])
    scorers = load_attribute(args.code_dir, args.scorers[0], args.scorers[1])
    result = mlflow.genai.evaluate(data=data, predict_fn=predict_fn, scorers=list(scorers))

    cases = []
    for trace in mlflow.search_traces(run_id=result.run_id, return_type="list"):
        case_id = trace.info.tags.get(CASE_TAG)
        if case_id is None:
            continue
        assessments = []
        for assessment in trace.info.assessments or []:
            source = getattr(assessment, "source", None)
            feedback = getattr(assessment, "feedback", None)
            expectation = getattr(assessment, "expectation", None)
            error = getattr(feedback, "error", None) if feedback is not None else None
            value = feedback.value if feedback is not None else (expectation.value if expectation is not None else None)
            assessments.append({
                "name": assessment.name,
                "value": plain(value),
                "error": None if error is None else (getattr(error, "error_code", None) or "ERROR"),
                "source_type": getattr(source, "source_type", None),
            })
        cases.append({"case_id": case_id, "trace_id": trace.info.trace_id, "assessments": assessments})
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump({"run_id": result.run_id, "cases": cases}, handle)


if __name__ == "__main__":
    main()
