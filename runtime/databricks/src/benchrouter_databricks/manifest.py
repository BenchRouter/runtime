"""The eval folder's manifest, `.benchrouter/benchrouter.yml` (plan section 4.4).

The same file and schema as a GitHub repository's (runtime/src/manifest.ts), so one eval folder
can serve either runner. The runner takes the route entry whose `route_id` is the eval's route key.
It must be a `repository_executable` eval with `api_family: openai_chat_completions`, and it uses
the GitHub executable fields as they are: `lockfile` (the hash-locked `requirements.lock`),
`input_refs` (the predict side), `acceptance_refs` (the scorer side), `primary_metric`,
`timeout_minutes`, `secret_env` and `call_site.base_url_env`. GitHub-only fields (`runtime`,
`argv`, `result_path`, ...) are ignored here. The Databricks-only fields sit in one block that the
GitHub runner ignores:

```yaml
routes:
  - route_id: acme/support-triage
    call_site: {base_url_env: OPENAI_BASE_URL}
    eval_pack:
      mode: repository_executable
      api_family: openai_chat_completions
      lockfile: requirements.lock
      input_refs: [predict.py]
      acceptance_refs: [scorers.py]
      primary_metric: correctness
      timeout_minutes: 30
      secret_env: [JUDGE_API_KEY]
      databricks:
        cases_table: main.evals.cases
        secret_scope: acme-evals          # each secret_env value is the key of the same name
        cases: {id_column: case_id, inputs_column: inputs, expectations_column: expectations, critical_column: critical}
        predict: {file: predict.py, function: predict_fn}
        scorers: {file: scorers.py, attribute: SCORERS}
        normalization:
          version: 1
          metrics:
            - {name: correctness, assessment: correctness, type: boolean, required: true}
            - {name: tone, assessment: tone, type: categorical, values: {good: 1, ok: 0.5, bad: 0}, required: false}
          pass_rule: {metrics: [correctness], min_score: 1}
```

Parsing is strict inside the `databricks` block and for every field the runner uses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

MANIFEST_NAME = ".benchrouter/benchrouter.yml"
API_FAMILY = "openai_chat_completions"
MAX_TIMEOUT_MINUTES = 360
METRIC_TYPES = ("boolean", "categorical", "numeric")


class ManifestError(Exception):
    """A refused manifest. `code` is a fixed cause (DATA-001: no free text leaves the job)."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code


@dataclass(frozen=True)
class Metric:
    name: str
    assessment: str
    type: str
    direction: str
    required: bool
    values: dict[str, float] = field(default_factory=dict)
    low: float = 0.0
    high: float = 1.0


@dataclass(frozen=True)
class Secret:
    env: str
    scope: str
    key: str


@dataclass(frozen=True)
class Normalization:
    primary_metric: str
    metrics: tuple[Metric, ...]
    pass_metrics: tuple[str, ...]
    min_score: float


@dataclass(frozen=True)
class EvalManifest:
    cases_table: str
    id_column: str
    inputs_column: str
    expectations_column: str | None
    critical_column: str | None
    predict_file: str
    predict_function: str
    scorers_file: str
    scorers_attribute: str
    code_files: tuple[str, ...]
    scorer_files: tuple[str, ...]
    requirements_lock: str
    base_url_env: str | None
    secrets: tuple[Secret, ...]
    timeout_minutes: int
    normalization: Normalization


def _fail(detail: str) -> ManifestError:
    return ManifestError("manifest_invalid", detail)


def _object(value: Any, label: str, keys: set[str], required: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _fail(f"{label} must be an object")
    unknown = sorted(set(value) - keys)
    if unknown:
        raise _fail(f"{label} has unknown fields: {', '.join(unknown)}")
    missing = sorted(required - set(value))
    if missing:
        raise _fail(f"{label} misses: {', '.join(missing)}")
    return value


def _text(value: Any, label: str, max_length: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise _fail(f"{label} must be a non-empty string")
    return value


def _optional_text(value: Any, label: str) -> str | None:
    return None if value is None else _text(value, label)


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _fail(f"{label} must be a number")
    return float(value)


def is_identifier(value: str, extra: str = "_") -> bool:
    if not value or not (("a" <= value[0] <= "z") or ("A" <= value[0] <= "Z")):
        return False
    return all(("a" <= char <= "z") or ("A" <= char <= "Z") or ("0" <= char <= "9") or char in extra for char in value)


def is_env_name(value: str) -> bool:
    """`[A-Z][A-Z0-9_]*`, and not a name BenchRouter or Databricks reserves (as the server checks)."""
    if not value or not ("A" <= value[0] <= "Z"):
        return False
    if value.startswith("BENCHROUTER_") or value.startswith("DATABRICKS_"):
        return False
    return all(("A" <= char <= "Z") or ("0" <= char <= "9") or char == "_" for char in value)


def is_metric_name(value: str) -> bool:
    """The server's quality parser: a letter, then up to 63 letters, digits, `_`, `.` or `-`."""
    return len(value) <= 64 and is_identifier(value, "_.-")


def is_relative_path(value: str) -> bool:
    """A normalized folder-relative path, as `isNormalizedRepoPath` admits."""
    if not value or len(value) > 512 or "\\" in value or "\0" in value:
        return False
    if value.startswith("/") or value.startswith("~") or (len(value) > 1 and value[1] == ":"):
        return False
    return all(segment not in ("", ".", "..") for segment in value.split("/"))


def is_table_name(value: str) -> bool:
    parts = value.split(".")
    return len(parts) == 3 and all(part and "`" not in part for part in parts)


def _path(value: Any, label: str) -> str:
    text = _text(value, label, 512)
    if not is_relative_path(text):
        raise _fail(f"{label} must be a normalized relative path")
    return text


def _paths(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise _fail(f"{label} must be a non-empty list")
    paths = tuple(_path(entry, f"{label}[{index}]") for index, entry in enumerate(value))
    if len(set(paths)) != len(paths):
        raise _fail(f"{label} has duplicates")
    return paths


def _metric(value: Any, label: str) -> Metric:
    entry = _object(value, label, {"name", "assessment", "type", "direction", "required", "values", "range"}, {"name", "assessment", "type"})
    name = _text(entry["name"], f"{label}.name", 64)
    if not is_metric_name(name):
        raise _fail(f"{label}.name must be a metric name")
    kind = entry["type"]
    if kind not in METRIC_TYPES:
        raise _fail(f"{label}.type must be boolean, categorical or numeric")
    direction = entry.get("direction", "higher")
    if direction not in ("higher", "lower"):
        raise _fail(f"{label}.direction must be higher or lower")
    required = entry.get("required", True)
    if not isinstance(required, bool):
        raise _fail(f"{label}.required must be a boolean")
    values: dict[str, float] = {}
    low, high = 0.0, 1.0
    if kind == "categorical":
        raw = entry.get("values")
        if not isinstance(raw, dict) or not raw:
            raise _fail(f"{label}.values must map each category to a score")
        for category, score in raw.items():
            number = _number(score, f"{label}.values.{category}")
            if not 0 <= number <= 1:
                raise _fail(f"{label}.values scores must be from 0 to 1")
            values[str(category)] = number
    elif "values" in entry:
        raise _fail(f"{label}.values applies to categorical metrics only")
    if kind == "numeric":
        raw_range = entry.get("range")
        if not isinstance(raw_range, list) or len(raw_range) != 2:
            raise _fail(f"{label}.range must be [low, high]")
        low, high = _number(raw_range[0], f"{label}.range[0]"), _number(raw_range[1], f"{label}.range[1]")
        if not low < high:
            raise _fail(f"{label}.range must have low < high")
    elif "range" in entry:
        raise _fail(f"{label}.range applies to numeric metrics only")
    return Metric(name, _text(entry["assessment"], f"{label}.assessment", 128), kind, direction, required, values, low, high)


def _normalization(value: Any, primary: str) -> Normalization:
    entry = _object(value, "normalization", {"version", "metrics", "pass_rule"}, {"version", "metrics", "pass_rule"})
    if entry["version"] != 1:
        raise _fail("normalization.version must be 1")
    raw_metrics = entry["metrics"]
    if not isinstance(raw_metrics, list) or not raw_metrics:
        raise _fail("normalization.metrics must be a non-empty list")
    metrics = tuple(_metric(item, f"normalization.metrics[{index}]") for index, item in enumerate(raw_metrics))
    names = [metric.name for metric in metrics]
    if len(set(names)) != len(names) or len({metric.assessment for metric in metrics}) != len(metrics):
        raise _fail("normalization.metrics names and assessments must be unique")
    by_name = {metric.name: metric for metric in metrics}
    if primary not in by_name or not by_name[primary].required:
        raise _fail("eval_pack.primary_metric must name a required normalization metric")
    rule = _object(entry["pass_rule"], "normalization.pass_rule", {"metrics", "min_score"}, {"metrics", "min_score"})
    pass_metrics = rule["metrics"]
    if not isinstance(pass_metrics, list) or not pass_metrics or not all(isinstance(name, str) and name in by_name and by_name[name].required for name in pass_metrics):
        raise _fail("normalization.pass_rule.metrics must name required metrics")
    min_score = _number(rule["min_score"], "normalization.pass_rule.min_score")
    if not 0 <= min_score <= 1:
        raise _fail("normalization.pass_rule.min_score must be from 0 to 1")
    return Normalization(primary, metrics, tuple(pass_metrics), min_score)


def load_manifest(text: str, route_key: str, own_scope: str | None = None) -> EvalManifest:
    """Parses the YAML text with `yaml.safe_load` (plain data, no tags) and takes `route_key`'s entry."""
    import yaml  # PyYAML, a dependency of this wheel

    try:
        value = yaml.safe_load(text)
    except yaml.YAMLError:
        raise _fail("is not valid YAML") from None
    return parse_manifest(value, route_key, own_scope)


def parse_manifest(value: Any, route_key: str, own_scope: str | None = None) -> EvalManifest:
    """`own_scope` is the app SP's scope (poll key, bootstrap keys, case salt): no declared secret may come from it."""
    if not isinstance(value, dict) or not isinstance(value.get("routes"), list):
        raise _fail("routes must be a list")
    entries = [entry for entry in value["routes"] if isinstance(entry, dict) and entry.get("route_id") == route_key]
    if len(entries) != 1:
        raise ManifestError("route_not_declared", f"the manifest must declare route_id {route_key} once")
    entry = entries[0]
    pack = entry.get("eval_pack")
    if not isinstance(pack, dict):
        raise _fail("eval_pack must be a mapping")
    if pack.get("mode") != "repository_executable":
        raise _fail("eval_pack.mode must be repository_executable")
    if pack.get("api_family") != API_FAMILY:
        raise _fail(f"eval_pack.api_family must be {API_FAMILY}")
    lock = _path(pack.get("lockfile"), "eval_pack.lockfile")
    code_files, scorer_files = _paths(pack.get("input_refs"), "eval_pack.input_refs"), _paths(pack.get("acceptance_refs"), "eval_pack.acceptance_refs")
    primary = _text(pack.get("primary_metric"), "eval_pack.primary_metric", 64)
    timeout = pack.get("timeout_minutes", 30)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 0 < timeout <= MAX_TIMEOUT_MINUTES:
        raise _fail(f"eval_pack.timeout_minutes must be an integer from 1 to {MAX_TIMEOUT_MINUTES}")
    call_site = entry.get("call_site") or {}
    if not isinstance(call_site, dict):
        raise _fail("call_site must be a mapping")
    base_url_env = _optional_text(call_site.get("base_url_env"), "call_site.base_url_env")
    if base_url_env is not None and not is_env_name(base_url_env):
        raise _fail("call_site.base_url_env is reserved or invalid")

    block = _object(pack.get("databricks"), "eval_pack.databricks",
                    {"cases_table", "secret_scope", "cases", "predict", "scorers", "normalization"},
                    {"cases_table", "cases", "predict", "scorers", "normalization"})
    table = _text(block["cases_table"], "databricks.cases_table")
    if not is_table_name(table):
        raise _fail("databricks.cases_table must be <catalog>.<schema>.<table>")
    cases = _object(block["cases"], "databricks.cases", {"id_column", "inputs_column", "expectations_column", "critical_column"},
                    {"id_column", "inputs_column"})
    columns = {name: _optional_text(cases.get(name), f"databricks.cases.{name}") for name in ("id_column", "inputs_column", "expectations_column", "critical_column")}
    for name, column in columns.items():
        if column is not None and not is_identifier(column):
            raise _fail(f"databricks.cases.{name} must be a plain column name")
    predict = _object(block["predict"], "databricks.predict", {"file", "function"}, {"file", "function"})
    scorers = _object(block["scorers"], "databricks.scorers", {"file", "attribute"}, {"file", "attribute"})
    predict_file, scorers_file = _path(predict["file"], "databricks.predict.file"), _path(scorers["file"], "databricks.scorers.file")
    predict_function, scorers_attribute = _text(predict["function"], "databricks.predict.function"), _text(scorers["attribute"], "databricks.scorers.attribute")
    if not is_identifier(predict_function) or not is_identifier(scorers_attribute):
        raise _fail("databricks.predict.function and databricks.scorers.attribute must be Python names")
    if predict_file not in code_files or scorers_file not in scorer_files:
        raise _fail("databricks.predict.file must be an input_ref and databricks.scorers.file an acceptance_ref")
    reserved = {"cases.jsonl", MANIFEST_NAME, lock}
    if set(code_files) & set(scorer_files) or reserved & (set(code_files) | set(scorer_files)):
        raise _fail("input_refs and acceptance_refs must not overlap each other or the frozen files")
    if any(path.startswith("wheels/") for path in code_files + scorer_files):
        raise _fail("wheels/ is reserved for the locked wheels")

    secret_env = pack.get("secret_env") or []
    if not isinstance(secret_env, list) or len(set(map(str, secret_env))) != len(secret_env):
        raise _fail("eval_pack.secret_env must be a list of unique names")
    scope = _optional_text(block.get("secret_scope"), "databricks.secret_scope")
    if secret_env and scope is None:
        raise _fail("databricks.secret_scope is required when secret_env names a secret")
    # Databricks scope names are case-insensitive.
    if scope is not None and own_scope is not None and scope.casefold() == own_scope.casefold():
        # The scope holds BenchRouter's own credentials; eval code never receives them.
        raise ManifestError("secret_scope_reserved", "databricks.secret_scope is BenchRouter's own scope")
    secrets = []
    for index, env in enumerate(secret_env):
        name = _text(env, f"eval_pack.secret_env[{index}]", 64)
        if not is_env_name(name) or name == base_url_env:
            raise _fail(f"eval_pack.secret_env[{index}] is reserved or invalid")
        # As a GitHub repository secret takes the variable's name, the value is the scope key of that name.
        secrets.append(Secret(name, scope or "", name))
    return EvalManifest(
        cases_table=table, id_column=columns["id_column"] or "", inputs_column=columns["inputs_column"] or "",
        expectations_column=columns["expectations_column"], critical_column=columns["critical_column"],
        predict_file=predict_file, predict_function=predict_function, scorers_file=scorers_file, scorers_attribute=scorers_attribute,
        code_files=code_files, scorer_files=scorer_files, requirements_lock=lock, base_url_env=base_url_env,
        secrets=tuple(secrets), timeout_minutes=timeout, normalization=_normalization(block["normalization"], primary),
    )
