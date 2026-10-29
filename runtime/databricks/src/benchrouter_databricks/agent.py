"""The agent job's task: poll BenchRouter, apply each leased item, report it (plan 4.2).

The job runs as the app SP on a schedule, with `max_concurrent_runs: 1`. Each run:
1. tries its own key (`poll-key`) and every key a Connect left (`poll-key-<nonce>`), newest
   first, until BenchRouter accepts one. Each Connect writes its own name and never overwrites
   another's, and exactly one issued key is live, so no write order can strand the agent;
2. writes the rotated key to `poll-key` before any report, but only while `poll-key` still holds
   what this run read, so an older run never writes over a newer key; then deletes the Connect
   keys it tried, which are spent or revoked;
3. handles and reports each item, then polls again while `next_check_seconds` is 0.

Logs hold fixed words, item ids and kinds only: never a key or a payload.
"""

from __future__ import annotations

import sys
from typing import Any

from . import __version__
from .grants import GrantNeeded
from .handlers import HANDLERS, Context, Failed
from .transport import ApiError, TransportError, request_json, with_retries
from .workspace import Workspace

DEFAULT_API_BASE = "https://api.benchrouter.com"
DEFAULT_SCOPE = "benchrouter"
DEFAULT_POLL_KEY_NAME = "poll-key"
#: One run handles at most this many polls; the next scheduled run picks up the rest.
MAX_POLLS = 10


class PollKeyInvalid(Exception):
    """BenchRouter refused the poll key: revoked, re-issued, or superseded."""


class BenchRouter:
    def __init__(self, api_base: str) -> None:
        self.api_base = api_base.rstrip("/")

    def _post(self, path: str, key: str, body: dict[str, Any]) -> Any:
        return request_json("POST", f"{self.api_base}{path}", {"authorization": f"Bearer {key}"}, body)

    def poll(self, key: str) -> dict[str, Any]:
        # A repeat with the same key answers the same next key and lease (AUTH-012).
        try:
            return with_retries(lambda: self._post("/v1/databricks/poll", key, {"agent_version": __version__}))
        except ApiError as error:
            if error.status == 401:
                raise PollKeyInvalid() from None
            raise

    def report(self, key: str, item: dict[str, Any], outcome: str, result: dict[str, Any], error_code: str | None) -> dict[str, Any]:
        body: dict[str, Any] = {"item_id": item["id"], "lease_id": item["lease_id"], "outcome": outcome, "result": result}
        if error_code is not None:
            body["error_code"] = error_code
        # A repeated report with the same outcome answers as the first (`replayed`).
        return with_retries(lambda: self._post("/v1/databricks/report", key, body))


def log(message: str, **fields: Any) -> None:
    detail = " ".join(f"{name}={value}" for name, value in fields.items())
    print(f"benchrouter-agent {message} {detail}".rstrip(), flush=True)


def write_rotated_key(workspace: Workspace, scope: str, name: str, seen: str | None, rotated: str) -> bool:
    """Writes the rotated key to `name` unless another run changed it since this run read `seen`."""
    if rotated == seen:
        return True
    current = with_retries(lambda: workspace.secret_get(scope, name))
    if current != seen:
        return False
    with_retries(lambda: workspace.secret_put(scope, name, rotated))
    return True


def candidate_key_names(workspace: Workspace, scope: str, name: str) -> list[str]:
    """The agent's own key and every Connect key (`<name>-<nonce>`), newest first."""
    listed = with_retries(lambda: workspace.secret_keys(scope))
    ours = [(updated, key) for key, updated in listed if key == name or key.startswith(f"{name}-")]
    return [key for _, key in sorted(ours, reverse=True)]


def first_poll(workspace: Workspace, benchrouter: BenchRouter, scope: str, names: list[str]) -> tuple[str, dict[str, Any]] | None:
    """Polls with the first key BenchRouter accepts. A refused key has no effect on BenchRouter."""
    for name in names:
        key = with_retries(lambda name=name: workspace.secret_get(scope, name))
        if key is None:
            continue
        try:
            return key, benchrouter.poll(key)
        except PollKeyInvalid:
            continue
    return None


def handle_item(ctx: Context, benchrouter: BenchRouter, key: str, item: dict[str, Any]) -> None:
    kind = item.get("kind")
    handler = HANDLERS.get(kind) if isinstance(kind, str) else None
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    try:
        if handler is None:
            raise Failed("kind_unknown")
        outcome = handler(ctx, payload)
    except Failed as failure:
        log("item failed", item=item["id"], kind=kind, code=failure.code)
        report(benchrouter, key, item, "failed", {}, failure.code)
        return
    except GrantNeeded as needed:
        # Plan 4.4: no run started. BenchRouter cancels the launch with no failure and sends a new one; the
        # next poll checks again, and the eval shows the missing grants until then.
        log("item waits for a grant", item=item["id"], kind=kind, grants=len(needed.grants))
        report(benchrouter, key, item, "grant_needed", {"grants": needed.grants}, None)
        return
    except Exception as error:  # noqa: BLE001 - one item never stops the others
        # Transient, or a fault in this agent: leave it unreported. The lease ends and
        # the item comes again, at most five times.
        log("item deferred", item=item["id"], kind=kind, error=type(error).__name__)
        return
    answer = report(benchrouter, key, item, "done", outcome.result, None)
    if answer is None:
        return
    if outcome.after is not None:
        try:
            outcome.after(answer)
        except Exception as error:  # noqa: BLE001
            log("after report failed", item=item["id"], kind=kind, error=type(error).__name__)
            return
    log("item done", item=item["id"], kind=kind, replayed=answer.get("replayed"))


def report(benchrouter: BenchRouter, key: str, item: dict[str, Any], outcome: str, result: dict[str, Any], code: str | None) -> dict[str, Any] | None:
    try:
        return benchrouter.report(key, item, outcome, result, code)
    except ApiError as error:
        # 409 lease_lost or work_item_closed: another run holds or closed the item.
        log("report refused", item=item["id"], status=error.status, code=error.code)
        if item.get("kind") == "disconnect" and error.status == 401:
            # A disconnect report that committed before a lost answer revoked the key.
            return {}
        return None
    except TransportError:
        log("report lost", item=item["id"])
        return None


def run(args: dict[str, str]) -> int:
    workspace = Workspace.from_runtime()
    scope = args.get("scope", DEFAULT_SCOPE)
    key_name = args.get("poll_key_name", DEFAULT_POLL_KEY_NAME)
    job_id_text = args.get("job_id", "")
    ctx = Context(workspace, scope, int(job_id_text) if job_id_text.isdigit() else None)
    benchrouter = BenchRouter(args.get("api_base", DEFAULT_API_BASE))

    names = candidate_key_names(workspace, scope, key_name)
    seen = with_retries(lambda: workspace.secret_get(scope, key_name))
    found = first_poll(workspace, benchrouter, scope, names)
    if found is None:
        log("no accepted poll key", scope=scope, keys=len(names))
        return 1
    key, poll = found
    for attempt in range(MAX_POLLS):
        if attempt > 0:
            try:
                poll = benchrouter.poll(key)
            except PollKeyInvalid:
                log("poll key refused")
                return 1
        rotated = poll["poll_key"]
        if not write_rotated_key(workspace, scope, key_name, seen, rotated):
            log("scope moved on; another run holds the newer key")
            return 0
        seen = key = rotated
        if attempt == 0:
            for spent in names:
                if spent != key_name:
                    with_retries(lambda spent=spent: workspace.secret_delete(scope, spent))
        items = poll.get("items") or []
        log("polled", binding=poll.get("binding_id"), items=len(items), next_check=poll.get("next_check_seconds"))
        disconnects = [item for item in items if item.get("kind") == "disconnect"]
        if disconnects:
            # Plan 4.7: nothing runs after the cleanup. Its report cancels every other item,
            # so an item leased in the same poll cannot recreate what the cleanup deleted.
            handle_item(ctx, benchrouter, rotated, disconnects[0])
            return 0
        for item in items:
            handle_item(ctx, benchrouter, rotated, item)
        if poll.get("next_check_seconds") != 0:
            follow_release(ctx, poll.get("agent_release"))
            return 0
    follow_release(ctx, poll.get("agent_release"))
    return 0


#: Plan 4.3: the agent installs only the signed release from its immutable URL, digest pinned.
RELEASE_PREFIX = "https://runtime.benchrouter.com/v1/databricks/releases/"


def follow_release(ctx: Context, release: Any) -> None:
    """Points this agent's own job at the release the poll names; the next run is that release.

    Updates are server-driven: a new release needs no admin visit. The job's environment, not
    this process's version, is compared, so a job that installs anything but the pinned release
    URL (for example a wheel in a path the app SP can write) is repointed even at the same
    version (plan 4.3). Only the environment dependency changes. A failure is logged, and the
    next poll tries again.
    """
    if not isinstance(release, dict) or ctx.job_id is None:
        return
    version, dependency = release.get("version"), release.get("dependency")
    if not isinstance(version, str) or not isinstance(dependency, str):
        return
    if not dependency.startswith(RELEASE_PREFIX) or "#sha256=" not in dependency:
        log("release refused", version=version)
        return
    try:
        job = with_retries(lambda: ctx.workspace.call("GET", "/api/2.2/jobs/get", query={"job_id": str(ctx.job_id)}))
        environments = [env for env in job.get("settings", {}).get("environments") or []
                        if isinstance(env, dict) and isinstance(env.get("environment_key"), str)]
        if not environments:
            log("release not applied", reason="no_environment")
            return
        if all((env.get("spec") or {}).get("dependencies") == [dependency] for env in environments):
            return
        repointed = [{"environment_key": env["environment_key"], "spec": {**(env.get("spec") or {}), "dependencies": [dependency]}}
                     for env in environments]
        with_retries(lambda: ctx.workspace.update_job(ctx.job_id, {"environments": repointed}))
    except (ApiError, TransportError) as error:
        log("release not applied", error=type(error).__name__)
        return
    log("release repointed", running=__version__, next=version)


def parse_args(argv: list[str]) -> dict[str, str]:
    """`python_wheel_task` named parameters arrive as `--name=value`."""
    args: dict[str, str] = {}
    for arg in argv:
        if arg.startswith("--") and "=" in arg:
            name, value = arg[2:].split("=", 1)
            args[name.replace("-", "_")] = value
    return args


def main() -> None:
    # A `python_wheel_task` fails on any SystemExit, even 0, so success returns normally.
    code = run(parse_args(sys.argv[1:]))
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
