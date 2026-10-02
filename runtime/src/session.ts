// §3.3: one runtime process per job. hello → fetch the eval tree → snapshot → ready →
// claim loop with up to 4 in-process replay slots → exit. Heartbeats every 30 s keep
// the session and every lease alive; a lease whose local expiry passes stops starting
// calls. Claiming stops when the remaining job time is short.
import {
  RUNNER_HEARTBEAT_INTERVAL_S,
  RUNNER_LEASE_TTL_S,
  RUNNER_LOCAL_EXPIRY_MARGIN_S,
  RUNNER_PROTOCOL_MAJOR,
  RUNNER_REPLAY_SLOTS,
  type RunnerBlockedOutcome,
  type RunnerHelloSession,
  type RunnerRouteContract,
  type RunnerWorkFailCause,
  type RunnerWorkItem,
  type Sha256Digest
} from "../../src/shared/runner-protocol";
import { readFile } from "node:fs/promises";
import { loadReplayCases } from "./cases";
import type { ControlContext } from "./control";
import { ancestryProof, fetchEvalTree } from "./eval-tree";
import { runExecutableItem } from "./executable";
import { canonicalJson, errorMessage, objectOf, parseJsonText, ProtocolError, readString, sha256Digest, sleep, type JsonObject } from "./json";
import { readManifest, type ManifestRoute } from "./manifest";
import { killAllGroups } from "./processes";
import { ItemFault, runReplayItem, type ItemOutcome } from "./replay";
import { RunnerApiError, RunnerClient } from "./runner-client";
import { hashDeclaredFiles, routeContract, sameHashes } from "./snapshot";
import { JobSummary, type FailureClass } from "./summary";
import { send, TargetHolds } from "./transport";
import { readCommittedKit } from "./workflow";
import { ReplayMetricsWriter, type MetricsTerminal } from "./metrics";

/** Stop claiming when less than this remains before `retire_at` (the upload reserve is already inside retire_at). */
const MIN_CLAIM_WINDOW_MS = 60_000;
const UNHEALTHY_BEAT_MS = 5_000;

interface LeaseState {
  item: RunnerWorkItem;
  localExpiry: number;
  controller: AbortController;
}

/** Heartbeats (§3.3.4). A beat never revives an expired generation; the server decides. */
class Heartbeat {
  readonly leases = new Map<string, LeaseState>();
  healthy = true;
  stopped: RunnerBlockedOutcome | "expired" | "superseded" | null = null;
  private timer: NodeJS.Timeout | null = null;
  private beating: Promise<void> | null = null;

  constructor(
    private readonly client: RunnerClient,
    private readonly onStop: () => void
  ) {}

  start(): void {
    this.schedule(RUNNER_HEARTBEAT_INTERVAL_S * 1000);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.beat(), ms);
    this.timer.unref();
  }

  add(item: RunnerWorkItem): LeaseState {
    const localExpiry = Math.min(Date.parse(item.lease_expires_at), Date.now() + RUNNER_LEASE_TTL_S * 1000) - RUNNER_LOCAL_EXPIRY_MARGIN_S * 1000;
    const lease: LeaseState = { item, localExpiry, controller: new AbortController() };
    this.leases.set(item.work_id, lease);
    return lease;
  }

  remove(workId: string): void {
    this.leases.delete(workId);
  }

  beat(): Promise<void> {
    if (!this.beating) {
      this.beating = this.beatOnce().finally(() => {
        this.beating = null;
        if (this.stopped === null && this.timer !== null) this.schedule(this.healthy ? RUNNER_HEARTBEAT_INTERVAL_S * 1000 : UNHEALTHY_BEAT_MS);
      });
    }
    return this.beating;
  }

  private async beatOnce(): Promise<void> {
    const sent = [...this.leases.values()];
    const ackAt = Date.now();
    let response;
    try {
      response = await this.client.heartbeat({ session_id: this.client.sessionId, leases: sent.map((lease) => ({ work_id: lease.item.work_id, lease_gen: lease.item.lease_gen })) });
    } catch {
      // §3.3.4: no acknowledgment. Calls stop starting until a beat succeeds or the local expiry passes.
      this.healthy = false;
      return;
    }
    this.healthy = true;
    if (response.outcome === "ok") {
      for (const status of response.leases) {
        const lease = this.leases.get(status.work_id);
        if (!lease || lease.item.lease_gen !== status.lease_gen) continue;
        if (status.status === "ok") {
          lease.localExpiry = Math.min(Date.parse(status.lease_expires_at), ackAt + RUNNER_LEASE_TTL_S * 1000) - RUNNER_LOCAL_EXPIRY_MARGIN_S * 1000;
        } else {
          lease.controller.abort(new ItemFault("lease_lost", `the server fenced the lease: ${status.reason}`));
        }
      }
      return;
    }
    this.stopped = response.outcome === "blocked" ? response : response.outcome;
    for (const lease of this.leases.values()) lease.controller.abort(new ItemFault("lease_lost", `the session ended: ${response.outcome}`));
    this.onStop();
  }

  /** §3.3.4: may a new call start for this lease? Waits for an acknowledgment while unhealthy. */
  async callsAllowed(lease: LeaseState): Promise<boolean> {
    while (!lease.controller.signal.aborted) {
      if (Date.now() >= lease.localExpiry) {
        lease.controller.abort(new ItemFault("lease_lost", "the lease expired locally without a heartbeat acknowledgment"));
        return false;
      }
      if (this.healthy) return true;
      await this.beat();
      if (!this.healthy) await sleep(1000, lease.controller.signal);
    }
    return false;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

async function requestOidcToken(url: string, token: string, audience: string, holds: TargetHolds): Promise<string> {
  const target = new URL(url);
  target.searchParams.set("audience", audience);
  const reply = await send({
    method: "GET",
    url: target.href,
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    body: null,
    attemptTimeoutMs: 30_000,
    deadlineAt: Date.now() + 120_000,
    target: "oidc"
  }, holds);
  if (reply.status !== 200) throw new ProtocolError(`the GitHub OIDC token request failed (HTTP ${reply.status}); the job needs permissions: id-token: write`);
  return readString(objectOf(parseJsonText(reply.text, "OIDC response"), "OIDC response"), "value", "OIDC response");
}

/** §2.1: the opaque startup claim is the only workflow_dispatch input; read it from the event payload. */
async function dispatchClaim(): Promise<string | null> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !eventPath) return null;
  const event = objectOf(parseJsonText(await readFile(eventPath, "utf8"), "GITHUB_EVENT_PATH"), "event");
  return readString(objectOf(event.inputs, "event.inputs"), "claim", "event.inputs");
}

interface PreparedRoute {
  route: ManifestRoute;
  fileHashes: Record<string, Sha256Digest>;
}

function reportRetireAt(retireAt: string): void {
  // The bootstrap watchdog kills this process 5 min after retire_at (§3.3.4).
  if (process.send) process.send({ type: "retire_at", at: retireAt });
}

function failureClass(cause: RunnerWorkFailCause, providerOnly: boolean): FailureClass {
  if (cause === "case_failures") return providerOnly ? "provider" : "harness";
  if (cause === "harness_failed" || cause === "tree_mutated" || cause === "install_failed" || cause === "nondeterministic_request") return "harness";
  return "infra";
}

export async function runWorker(control: ControlContext): Promise<number> {
  const summary = new JobSummary();
  const holds = new TargetHolds();
  const client = new RunnerClient(control.apiOrigin, holds);
  let heartbeat: Heartbeat | null = null;
  try {
    if (!control.oidc || !control.repository) throw new ProtocolError("`run` needs GitHub Actions OIDC (permissions: id-token: write) and GITHUB_REPOSITORY");
    const kit = await readCommittedKit(control.controlRoot);
    const oidcToken = await requestOidcToken(control.oidc.url, control.oidc.token, `benchrouter:repo:${control.repository}:hello`, holds);
    const hello = await client.hello(oidcToken, {
      protocol: RUNNER_PROTOCOL_MAJOR,
      claim: await dispatchClaim(),
      bootstrap_version: control.bootstrapVersion,
      runtime_digest: control.runtimeDigest,
      features: control.features,
      workflow_authority: kit.authority,
      workflow_paths: kit.workflowPaths,
      kit_file_hashes: kit.kitFileHashes
    });
    if (hello.outcome === "done") {
      summary.outcome = `done: ${hello.reason}`;
      summary.note(`nothing to do (${hello.reason})`);
      return summary.exitCode();
    }
    if (hello.outcome === "blocked") {
      summary.block(hello.reason, hello.action);
      return summary.exitCode();
    }
    client.setSession({ sessionId: hello.session_id, credential: hello.session_credential });
    if (hello.retire_at !== null) reportRetireAt(hello.retire_at);
    let stopRequested = false;
    heartbeat = new Heartbeat(client, () => { stopRequested = true; });
    heartbeat.start();
    const prepared = await prepare(control, client, hello, summary);
    if (prepared === null) return summary.exitCode();
    if (hello.purpose === "snapshot_refresh" || hello.retire_at === null) {
      summary.outcome = hello.purpose === "snapshot_refresh" ? "snapshot refreshed" : "snapshot reported (no job start time, so no work)";
      return summary.exitCode();
    }
    const ready = await client.ready({ session_id: hello.session_id, contract_digests: [...new Set(prepared.keys())] });
    if (ready.outcome === "blocked") {
      summary.block(ready.reason, ready.action);
      return summary.exitCode();
    }
    if (ready.outcome === "superseded") {
      summary.outcome = "superseded before work started";
      return summary.exitCode();
    }
    await claimLoop(control, client, holds, heartbeat, hello, prepared, summary, () => stopRequested);
    return summary.exitCode();
  } catch (error) {
    summary.protocol(errorMessage(error instanceof Error ? error : String(error)));
    return summary.exitCode();
  } finally {
    heartbeat?.stop();
    await killAllGroups();
    await summary.write();
  }
}

/** §3.3 preparing: fetch, verify, snapshot. Returns the admitted routes by contract digest. */
async function prepare(control: ControlContext, client: RunnerClient, hello: RunnerHelloSession, summary: JobSummary): Promise<Map<Sha256Digest, PreparedRoute> | null> {
  const tree = await fetchEvalTree(control, hello.eval_sha);
  if (!tree.ok) {
    const response = await client.snapshot({ kind: "unavailable", session_id: hello.session_id, eval_sha: hello.eval_sha, cause: "fetch_failed" });
    summary.note(`could not fetch ${hello.eval_sha}: ${tree.detail}`);
    if (response.outcome === "blocked") summary.block(response.reason, response.action);
    else summary.unavailableSnapshot(hello.eval_sha);
    return null;
  }
  const manifest = await readManifest(tree.root);
  const routes: RunnerRouteContract[] = [];
  const byKey = new Map<string, PreparedRoute>();
  for (const route of manifest.routes) {
    const contract = await routeContract(tree.root, route);
    routes.push(contract);
    byKey.set(route.routeId, { route, fileHashes: contract.file_hashes });
  }
  const needsAncestry = hello.purpose === "snapshot_refresh" || control.eventName === "push";
  const ancestry = needsAncestry ? await ancestryProof(control, tree.root, hello.eval_sha, manifest.product.defaultBranch, hello.last_imported_sha) : null;
  if (Date.now() > Date.parse(hello.prepare_deadline_at)) throw new ProtocolError("the preparation deadline passed before the snapshot");
  const snapshot = await client.snapshot({
    kind: "snapshot",
    session_id: hello.session_id,
    eval_sha: hello.eval_sha,
    product: manifest.product.slug,
    default_branch: manifest.product.defaultBranch,
    routes,
    ancestry
  });
  if (snapshot.outcome === "done") {
    summary.outcome = `done: ${snapshot.reason}`;
    return null;
  }
  if (snapshot.outcome === "blocked") {
    summary.block(snapshot.reason, snapshot.action);
    return null;
  }
  if (snapshot.outcome === "awaiting_snapshot") {
    summary.unavailableSnapshot(snapshot.eval_sha);
    return null;
  }
  if (snapshot.history_rewritten) summary.note("the default branch history was rewritten; BenchRouter imported this push by the ancestry reset rule");
  summary.note(`snapshot ${snapshot.snapshot_id} imported for ${routes.length} route(s)`);
  const prepared = new Map<Sha256Digest, PreparedRoute>();
  for (const [routeKey, digest] of Object.entries(snapshot.contract_digests)) {
    const entry = byKey.get(routeKey);
    if (!entry) throw new ProtocolError(`the snapshot returned a digest for unknown route ${routeKey}`);
    prepared.set(digest, entry);
  }
  return prepared;
}

async function claimLoop(
  control: ControlContext,
  client: RunnerClient,
  holds: TargetHolds,
  heartbeat: Heartbeat,
  hello: RunnerHelloSession,
  prepared: Map<Sha256Digest, PreparedRoute>,
  summary: JobSummary,
  stopRequested: () => boolean
): Promise<void> {
  const retireAt = Date.parse(hello.retire_at ?? "");
  const metrics = new ReplayMetricsWriter(control.workspace);
  const running = new Map<string, Promise<void>>();
  let claimSeq = 0;
  let claimErrors = 0;
  let stop: string | null = null;
  const retireTimer = setTimeout(() => {
    for (const lease of heartbeat.leases.values()) lease.controller.abort(new ItemFault("retiring", "the job reached retire_at"));
  }, Math.max(0, retireAt - Date.now()));
  retireTimer.unref();
  const waitForAny = (ms: number) => Promise.race([...running.values(), sleep(ms)]);
  try {
    while (true) {
      if (stop === null && stopRequested()) stop = "the session ended";
      if (stop === null && Date.now() >= retireAt - MIN_CLAIM_WINDOW_MS) stop = "too little job time left to claim";
      const free = RUNNER_REPLAY_SLOTS - running.size;
      if (stop !== null || free <= 0 || !heartbeat.healthy) {
        if (running.size === 0 && stop !== null) break;
        await waitForAny(1000);
        continue;
      }
      let response;
      try {
        response = await client.claim({ session_id: hello.session_id, claim_seq: claimSeq + 1, slots_free: free });
      } catch (error) {
        // A retried claim with the same claim_seq returns the same items, so an unknown outcome is safe to repeat.
        claimErrors += 1;
        if (claimErrors >= 3 || (error instanceof RunnerApiError && error.status < 500)) throw error;
        await sleep(2000);
        continue;
      }
      claimErrors = 0;
      claimSeq += 1;
      switch (response.outcome) {
        case "run":
          for (const item of response.items) {
            // §3.4: an executable item runs alone, in its own fresh job. It never shares a
            // session with replay work, and the job claims nothing after it.
            let refusal: ItemFault | null = null;
            if (item.mode === "repository_executable") {
              if (running.size > 0 || response.items.length > 1) refusal = new ItemFault("mode_unsupported", "executable work never shares a job with other work");
              stop = "an executable item runs alone in a fresh job";
            }
            const promise = runItem(control, client, holds, heartbeat, prepared, item, summary, refusal, metrics).finally(() => running.delete(item.work_id));
            running.set(item.work_id, promise);
          }
          if (response.items.length === 0) await waitForAny(1000);
          break;
        case "wait_until":
          summary.nextWake = response.until;
          await waitForAny(Math.max(0, Date.parse(response.until) - Date.now()));
          break;
        case "draining":
          stop = "draining";
          break;
        case "exit":
          stop = `exit: ${response.reason}`;
          summary.outcome = stop;
          break;
        case "complete":
          stop = `result set ${response.result_set_id} ${response.state}`;
          summary.outcome = `complete: ${response.state}`;
          break;
        case "blocked":
          stop = "blocked";
          summary.block(response.reason, response.action);
          break;
        case "superseded":
          stop = "superseded";
          summary.outcome = "superseded by a newer commit";
          for (const lease of heartbeat.leases.values()) lease.controller.abort(new ItemFault("lease_lost", "the session was superseded"));
          break;
        case "awaiting_snapshot":
          stop = "awaiting_snapshot";
          summary.unavailableSnapshot(response.eval_sha);
          break;
      }
    }
  } finally {
    clearTimeout(retireTimer);
    await Promise.allSettled(running.values());
  }
  // A heartbeat that ended the session is as visible as a claim that did (§3.11).
  const ended = heartbeat.stopped;
  if (ended === "expired") summary.protocol("the server expired this session (no acknowledged heartbeat within 90 s)");
  else if (ended === "superseded") summary.outcome = "superseded by a newer commit";
  else if (ended !== null) summary.block(ended.reason, ended.action);
  if (summary.outcome === "not started") summary.outcome = stop ?? "finished";
}

async function runItem(
  control: ControlContext,
  client: RunnerClient,
  holds: TargetHolds,
  heartbeat: Heartbeat,
  prepared: Map<Sha256Digest, PreparedRoute>,
  item: RunnerWorkItem,
  summary: JobSummary,
  refusal: ItemFault | null,
  metrics: ReplayMetricsWriter
): Promise<void> {
  const lease = heartbeat.add(item);
  const deadlineTimer = setTimeout(() => lease.controller.abort(new ItemFault("deadline_exceeded", "the work deadline passed")), Math.max(0, Date.parse(item.work_deadline_at) - Date.now()));
  deadlineTimer.unref();
  let outcome: ItemOutcome;
  try {
    if (refusal !== null) throw refusal;
    outcome = await executeItem(control, holds, heartbeat, lease, prepared, item);
  } catch (error) {
    const fault = error instanceof ItemFault ? error : new ItemFault("runtime_error", errorMessage(error instanceof Error ? error : String(error)));
    outcome = { kind: "fail", cause: fault.cause, diagnostics: { message: fault.message.slice(0, 500) }, providerOnly: false, metrics: fault.metrics };
  } finally {
    clearTimeout(deadlineTimer);
  }
  try {
    const terminal = await commit(control, client, item, outcome, summary, prepared.get(item.contract_digest)?.fileHashes ?? {});
    if (outcome.metrics) {
      try {
        await metrics.write(item.work_id, item.retry_attempt, item.lease_gen, outcome.metrics, terminal);
        if (outcome.metrics.some(row => row.checks_omitted)) {
          summary.note("Some local scorer diagnostics had unsupported types or fields, control characters, or exceeded export limits; customer metrics are incomplete.");
          console.log("::warning title=BenchRouter metrics::Some scorer checks were omitted from local metrics.");
        }
      } catch {
        // Diagnostic failure cannot change evaluation or imply a successful export.
        summary.note("Local replay metrics could not be exported; customer metrics are incomplete.");
        console.log("::warning title=BenchRouter metrics::Local replay metrics export failed or exceeded its bound.");
      }
    }
  } finally {
    heartbeat.remove(item.work_id);
  }
}

async function executeItem(
  control: ControlContext,
  holds: TargetHolds,
  heartbeat: Heartbeat,
  lease: LeaseState,
  prepared: Map<Sha256Digest, PreparedRoute>,
  item: RunnerWorkItem
): Promise<ItemOutcome> {
  const missing = item.requires.features.filter((feature) => !control.features.includes(feature));
  if (missing.length > 0) throw new ItemFault("capability_unsupported", `this runtime does not advertise ${missing.join(", ")}`);
  const entry = prepared.get(item.contract_digest);
  if (!entry) throw new ItemFault("runtime_error", `the work item names contract ${item.contract_digest}, which this session did not admit`);
  const treeRoot = `${control.workspace}/.br-eval`;
  // §3.2: re-hash the declared files before each item. A difference is `tree_mutated`.
  if (!sameHashes(await hashDeclaredFiles(treeRoot, entry.route), entry.fileHashes)) throw new ItemFault("tree_mutated", "a declared file changed after the snapshot");
  if (item.mode !== entry.route.mode) throw new ItemFault("mode_unsupported", `the item mode ${item.mode} does not match route ${entry.route.routeId}`);
  if (item.mode === "repository_executable") {
    return runExecutableItem({ control, treeRoot, route: entry.route, item, fileHashes: entry.fileHashes, signal: lease.controller.signal });
  }
  const cases = await loadReplayCases(treeRoot, entry.route);
  return runReplayItem({
    control,
    holds,
    treeRoot,
    route: entry.route,
    item,
    cases,
    signal: lease.controller.signal,
    callsAllowed: () => heartbeat.callsAllowed(lease)
  });
}

/** §3.3.1: one terminal write per item. A lost response is recovered from the receipt. */
async function commit(control: ControlContext, client: RunnerClient, item: RunnerWorkItem, outcome: ItemOutcome, summary: JobSummary, fileHashes: Record<string, Sha256Digest>): Promise<MetricsTerminal> {
  try {
    if (outcome.kind === "upload") {
      const rows: JsonObject[] = outcome.rows;
      const committed = await client.upload({
        session_id: client.sessionId,
        work_id: item.work_id,
        lease_gen: item.lease_gen,
        retry_attempt: item.retry_attempt,
        contract_digest: item.contract_digest,
        file_hashes: fileHashes,
        runtime_digest: control.runtimeDigest,
        payload_digest: sha256Digest(canonicalJson(rows)),
        case_results: rows,
        quality: outcome.quality
      });
      // §3.3.1: the server can commit the upload as a failure (its evidence could not be published).
      if (committed.receipt.terminal === "failed") {
        summary.failed(item.work_id, "upload_error", "infra", "the server recorded the upload as a failure");
        return "failed";
      }
      summary.uploaded(item.work_id, item.model_run.model, outcome.rows.length, outcome.rows.filter((row) => row.pass).length);
      return "uploaded";
    }
    await client.fail({ session_id: client.sessionId, work_id: item.work_id, lease_gen: item.lease_gen, retry_attempt: item.retry_attempt, cause: outcome.cause, diagnostics: outcome.diagnostics });
    summary.failed(item.work_id, outcome.cause, failureClass(outcome.cause, outcome.providerOnly), item.model_run.model);
    return "failed";
  } catch (error) {
    if (error instanceof RunnerApiError && error.code === "work_terminal" && error.receipt) {
      summary.note(`work ${item.work_id} was already ${error.receipt.terminal}`);
      // A winning receipt need not describe these local observations.
      return "unconfirmed";
    }
    if (error instanceof RunnerApiError && error.code === "fenced") {
      summary.failed(item.work_id, "lease_lost", "infra", "the server fenced the lease before the result committed");
      return "unconfirmed";
    }
    summary.failed(item.work_id, outcome.kind === "upload" ? "upload_error" : "fail_error", "infra", errorMessage(error instanceof Error ? error : String(error)));
    return "unconfirmed";
  }
}
