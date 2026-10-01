// Local `calibrate` (RUN-001), ported from the old kit's calibrate command. It checks a
// route's scorer against its own reference outputs and fixtures before any CI eval runs.
// Every scorer call runs in a killable ScorerProcess child with a LIVE console; CI
// replay keeps the console a no-op. Local commands never call the BenchRouter API.
import { ARGV_LAUNCHERS } from "./executable";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadReplayCases } from "./cases";
import type { ControlContext } from "./control";
import { errorMessage, isJsonObject, isJsonString, parseJsonText, ProtocolError, type JsonObject, type JsonValue } from "./json";
import { isRepoPath, readManifest, type ManifestRoute } from "./manifest";
import { messageContent, parseMessage } from "./model-output";
import { computeCardinalPaths, generateMutations, isContainer, type Mutation } from "./mutation-cert";
import { ScorerProcess, type JudgeBridge } from "./scorer-process";

type Archetype = "code-consumed" | "human-read" | "neither-defensible";
type Verdict = "caught" | "false-pass" | "pass" | "false-fail" | "needs-judge" | "error";

interface CalibrationFile {
  archetype: Archetype | null;
  fixtures: JsonObject[];
}

interface Bucket {
  corruptionCaught: number;
  corruptionFalsePass: number;
  corruptionNeedsJudge: number;
  preservationPass: number;
  preservationFalseFail: number;
  preservationNeedsJudge: number;
}

interface CertTotals {
  cardinal: Bucket;
  advisory: Bucket;
  errors: number;
  mutationResults: number;
  skippedCases: number;
}

interface CertReport {
  scorerName: string;
  cardinalPaths: string[];
  totals: CertTotals;
  certified: boolean;
  certifiedReasons: string[];
}

interface FixtureResult {
  label: string;
  expect: "pass" | "fail";
  actualPass: boolean;
  ok: boolean;
  judgeInvoked: boolean;
  reasons: string[];
  error: string | null;
}

interface ScoreRun {
  pass: boolean;
  reasons: string[];
  error: string | null;
}

const REPLAY_REFUSAL = "benchrouter:calibrate --replay is not shipped in this kit yet; run offline calibration first, then use CI eval replay for live best-model evidence.";
const NO_JUDGE_MESSAGE = "MUTATION_CERT_NO_JUDGE: offline harness provides no judge model";

/** JavaScript truthiness of a JSON value, as the old kit's `||` tests used it. */
function truthy(value: JsonValue | undefined): value is JsonValue {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}

function firstTruthy(...values: (JsonValue | undefined)[]): JsonValue | undefined {
  return values.find(truthy);
}

/** The old kit's string concatenation of a JSON value. */
function textOf(value: JsonValue): string {
  return isJsonString(value) ? value : String(value);
}

function normalizeArchetype(value: JsonValue | undefined): Archetype | null {
  if (value === undefined || !isJsonString(value)) return null;
  const v = value.trim().toLowerCase().replaceAll("_", "-");
  if (v === "code-consumed" || v === "structured" || v === "structured/code-consumed" || v === "structured-code-consumed") return "code-consumed";
  if (v === "human-read" || v === "free-text" || v === "human" || v === "human-read/free-text") return "human-read";
  if (v === "neither-defensible" || v === "neither" || v === "unverified" || v === "no-cert") return "neither-defensible";
  return null;
}

function routeArchetype(route: ManifestRoute): Archetype | null {
  const metadata = route.entry.metadata;
  return metadata !== undefined && isJsonObject(metadata) ? normalizeArchetype(metadata.eval_archetype) : null;
}

function objectField(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  return value !== undefined && isJsonObject(value) ? value : {};
}

function looksStructured(value: string): boolean {
  try {
    const parsed: JsonValue = JSON.parse(value);
    return isContainer(parsed);
  } catch {
    return false;
  }
}

function archetypeFromCases(cases: JsonObject[]): Archetype | null {
  let sawReference = false;
  for (const testCase of cases) {
    const stored = isJsonString(testCase.reference_output) ? testCase.reference_output : null;
    const message = stored === null ? null : parseMessage(stored);
    if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return "code-consumed";
    const content = stored === null ? "" : messageContent(stored);
    if (content.length === 0) continue;
    sawReference = true;
    if (looksStructured(content)) return "code-consumed";
  }
  return sawReference ? "human-read" : null;
}

function archetypeFromCaseMetadata(cases: JsonObject[]): Archetype | null {
  for (const testCase of cases) {
    const metadata = objectField(testCase, "scorer_metadata");
    const archetype = normalizeArchetype(metadata.eval_archetype) ?? normalizeArchetype(metadata.archetype);
    if (archetype) return archetype;
  }
  return null;
}

function archetypeFromFixtures(fixtures: JsonObject[]): Archetype | null {
  const hasPass = fixtures.some((fixture) => fixture.expect === "pass");
  const hasFail = fixtures.some((fixture) => fixture.expect === "fail");
  return hasPass && hasFail ? "human-read" : null;
}

function archetypeSourceNote(route: ManifestRoute, calibration: CalibrationFile, cases: JsonObject[]): string {
  if (routeArchetype(route)) return " (from route metadata)";
  if (calibration.archetype) return " (from calibration file)";
  if (archetypeFromCaseMetadata(cases)) return " (from case metadata)";
  if (archetypeFromCases(cases)) return " (inferred from structured reference outputs)";
  return " (inferred from fixtures)";
}

function isMissingFile(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

async function readCalibrationFile(root: string, filePath: string): Promise<CalibrationFile> {
  let text: string;
  try {
    text = await readFile(path.join(root, filePath), "utf8");
  } catch (error) {
    if (error instanceof Error && isMissingFile(error)) return { archetype: null, fixtures: [] };
    throw error;
  }
  const parsed = parseJsonText(text, filePath);
  if (Array.isArray(parsed)) return { archetype: null, fixtures: parsed.filter(isJsonObject) };
  if (isJsonObject(parsed)) {
    return {
      archetype: normalizeArchetype(parsed.archetype) ?? normalizeArchetype(parsed.eval_archetype),
      fixtures: Array.isArray(parsed.fixtures) ? parsed.fixtures.filter(isJsonObject) : []
    };
  }
  throw new ProtocolError(`${filePath} must be a JSON array of fixtures or an object with { fixtures }`);
}

/** `.benchrouter/calibration.<slug token>.json`, as the old kit named it. */
function calibrationPath(route: ManifestRoute): string {
  return `.benchrouter/calibration.${route.slug.split("/").join("__")}.json`;
}

function storedFixtureValue(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  return isJsonString(value) ? value : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Scorer runs: one killable child per calibration pass, as the old kit loaded one
// vm context per pass.
// ---------------------------------------------------------------------------

class LocalScorer {
  private readonly process: ScorerProcess;

  constructor(control: ControlContext, private readonly scorerPath: string) {
    this.process = new ScorerProcess(control, control.controlRoot, scorerPath, true);
  }

  async start(): Promise<void> {
    const loaded = await this.process.start();
    if (!loaded.ok) throw new Error(loaded.message ?? `Scorer ${this.scorerPath} failed to load (${loaded.errorCode})`);
  }

  /** Score one input. A hung scorer's process group is killed and restarted for the next call. */
  async score(payload: JsonObject, judge: JudgeBridge): Promise<ScoreRun> {
    if (!this.process.running) await this.start();
    const outcome = await this.process.score(JSON.stringify(payload), judge, Number.POSITIVE_INFINITY);
    if (outcome.ok) return { pass: outcome.verdict.pass, reasons: outcome.verdict.reasons, error: null };
    return { pass: false, reasons: [], error: outcome.message ?? outcome.errorCode };
  }

  stop(): Promise<void> {
    return this.process.stop();
  }
}

function scorerPayload(request: JsonValue | undefined, output: string, reference: string, metadata: JsonObject): JsonObject {
  const dataMetadata: JsonObject = {};
  // The judge is a function, never data: a declared `judge` key does not cross.
  for (const [key, value] of Object.entries(metadata)) if (key !== "judge") dataMetadata[key] = value;
  const payload: JsonObject = { output, reference, metadata: dataMetadata };
  if (request !== undefined) payload.request = request;
  return payload;
}

function copyInto(target: JsonObject, source: JsonValue | undefined): void {
  if (source === undefined || !isJsonObject(source)) return;
  for (const [key, value] of Object.entries(source)) target[key] = value;
}

// ---------------------------------------------------------------------------
// Mutation certification
// ---------------------------------------------------------------------------

function emptyBucket(): Bucket {
  return { corruptionCaught: 0, corruptionFalsePass: 0, corruptionNeedsJudge: 0, preservationPass: 0, preservationFalseFail: 0, preservationNeedsJudge: 0 };
}

function tally(bucket: Bucket, verdict: Verdict, mutation: Mutation): void {
  if (verdict === "caught") bucket.corruptionCaught++;
  else if (verdict === "false-pass") bucket.corruptionFalsePass++;
  else if (verdict === "pass") bucket.preservationPass++;
  else if (verdict === "false-fail") bucket.preservationFalseFail++;
  else if (verdict === "needs-judge" && mutation.class === "corruption") bucket.corruptionNeedsJudge++;
  else if (verdict === "needs-judge") bucket.preservationNeedsJudge++;
}

async function runMutationCert(control: ControlContext, cases: JsonObject[], scorerPath: string): Promise<CertReport> {
  const scorer = new LocalScorer(control, scorerPath);
  await scorer.start();
  try {
    const refContents = cases.map((testCase) => messageContent(testCase.reference_output));
    const cardinal = computeCardinalPaths(refContents.filter((value) => value.length > 0));
    const totals: CertTotals = { cardinal: emptyBucket(), advisory: emptyBucket(), errors: 0, mutationResults: 0, skippedCases: 0 };
    for (const [index, testCase] of cases.entries()) {
      const referenceEnvelope = parseMessage(testCase.reference_output);
      const referenceContent = refContents[index] ?? "";
      if (!referenceContent) {
        // A tool-call route (empty content) or a case with no reference: not certifiable.
        totals.skippedCases++;
        continue;
      }
      for (const mutation of generateMutations(referenceContent, cardinal)) {
        let judgeInvoked = false;
        const metadata: JsonObject = {
          case_id: testCase.id ?? null,
          message: referenceEnvelope ? { ...referenceEnvelope, content: mutation.output } : { role: "assistant", content: mutation.output },
          reference_message: referenceEnvelope
        };
        copyInto(metadata, testCase.scorer_metadata);
        // The judge probe: an offline harness has no judge model, so a judged verdict is "needs-judge".
        const probe: JudgeBridge = () => {
          judgeInvoked = true;
          return Promise.reject(new Error(NO_JUDGE_MESSAGE));
        };
        const run = await scorer.score(scorerPayload(testCase.request, mutation.output, referenceContent, metadata), probe);
        let verdict: Verdict;
        if (run.error !== null) verdict = "error";
        else if (judgeInvoked) verdict = "needs-judge";
        else if (mutation.class === "corruption") verdict = run.pass ? "false-pass" : "caught";
        else verdict = run.pass ? "pass" : "false-fail";
        totals.mutationResults++;
        if (verdict === "error") totals.errors++;
        else tally(mutation.advisory ? totals.advisory : totals.cardinal, verdict, mutation);
      }
    }
    const c = totals.cardinal;
    const reasons: string[] = [];
    if (totals.mutationResults < 1) reasons.push("no mutation results produced");
    if (totals.skippedCases > 0) reasons.push(`${totals.skippedCases} case(s) skipped (not certifiable)`);
    if (c.corruptionFalsePass > 0) reasons.push(`${c.corruptionFalsePass} cardinal false-pass on corruptions`);
    if (c.preservationFalseFail > 0) reasons.push(`${c.preservationFalseFail} cardinal false-fail on preservations`);
    if (c.corruptionNeedsJudge > 0) reasons.push(`${c.corruptionNeedsJudge} cardinal corruption(s) need a judge`);
    if (c.preservationNeedsJudge > 0) reasons.push(`${c.preservationNeedsJudge} cardinal preservation(s) need a judge`);
    if (totals.errors > 0) reasons.push(`${totals.errors} scorer error(s)`);
    return { scorerName: scorerPath, cardinalPaths: [...cardinal].sort(), totals, certified: reasons.length === 0, certifiedReasons: reasons };
  } finally {
    await scorer.stop();
  }
}

function formatReport(report: CertReport): string {
  const c = report.totals.cardinal;
  const a = report.totals.advisory;
  return [
    `Scorer: ${report.scorerName}  (judge mode: probe)`,
    "  -- CARDINAL (counts toward local scorer calibration) --",
    `  CARDINAL false-pass on corruptions: ${c.corruptionFalsePass}  ${c.corruptionFalsePass === 0 ? "(OK)" : "(FAIL)"}`,
    `  corruptions caught (deterministic): ${c.corruptionCaught}`,
    `  corruptions needing a judge:        ${c.corruptionNeedsJudge}`,
    `  preservations passed:               ${c.preservationPass}`,
    `  preservations false-failed:         ${c.preservationFalseFail}`,
    `  preservations needing a judge:      ${c.preservationNeedsJudge}`,
    "  -- ADVISORY (optional fields / order-sensitive; excluded) --",
    `  advisory corruption false-pass:     ${a.corruptionFalsePass}`,
    `  advisory corruption caught:         ${a.corruptionCaught}`,
    `  advisory corruption needs-judge:    ${a.corruptionNeedsJudge}`,
    `  advisory preservation pass/fail/nj: ${a.preservationPass}/${a.preservationFalseFail}/${a.preservationNeedsJudge}`,
    "  -- global --",
    `  errors:                             ${report.totals.errors}`,
    `  skipped cases:                      ${report.totals.skippedCases}`,
    `  total mutation results:             ${report.totals.mutationResults}`,
    `  cardinal field paths:               ${report.cardinalPaths.join(", ") || "(none)"}`,
    `  LOCAL SCORER CALIBRATION: ${report.certified ? "PASS" : `FAIL - ${report.certifiedReasons.join("; ") || "strict mutation checks failed"}`}`
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function casesToReferenceFixtures(cases: JsonObject[]): JsonObject[] {
  const fixtures: JsonObject[] = [];
  for (const testCase of cases) {
    const reference = testCase.reference_output;
    if (reference === undefined || !isJsonString(reference) || messageContent(reference).length === 0) continue;
    const id = testCase.id ?? null;
    const fixture: JsonObject = {
      id,
      label: `case:${textOf(id)}:reference`,
      output: reference,
      reference,
      scorer_metadata: truthy(testCase.scorer_metadata) ? testCase.scorer_metadata : {},
      expect: "pass"
    };
    if (testCase.request !== undefined) fixture.request = testCase.request;
    fixtures.push(fixture);
  }
  return fixtures;
}

async function runFixtureChecks(control: ControlContext, scorerPath: string, explicitFixtures: JsonObject[], implicitGood: JsonObject[]): Promise<FixtureResult[]> {
  const fixtures = [...implicitGood, ...explicitFixtures].filter((fixture) => fixture.expect === "pass" || fixture.expect === "fail");
  if (fixtures.length === 0) return [];
  const scorer = new LocalScorer(control, scorerPath);
  await scorer.start();
  try {
    const results: FixtureResult[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const expect = fixture.expect === "fail" ? "fail" : "pass";
      const fallbackLabel = `fixture_${index + 1}`;
      const storedOutput = storedFixtureValue(fixture.output !== undefined ? fixture.output : fixture.message);
      const output = messageContent(storedOutput ?? undefined);
      const storedReference = storedFixtureValue(fixture.reference !== undefined ? fixture.reference : fixture.reference_output);
      const reference = messageContent(storedReference ?? undefined);
      const metadata: JsonObject = {
        case_id: firstTruthy(fixture.id, fixture.label) ?? fallbackLabel,
        message: parseMessage(storedOutput ?? undefined) ?? { role: "assistant", content: output },
        reference_message: parseMessage(storedReference ?? undefined)
      };
      copyInto(metadata, firstTruthy(fixture.scorer_metadata, fixture.metadata));
      const reply = firstTruthy(fixture.judge_reply, fixture.judge_response);
      const judgeReply = reply === undefined ? (expect === "pass" ? "PASS: local calibration fixture" : "FAIL: local calibration fixture") : textOf(reply);
      let judgeInvoked = false;
      const judge: JudgeBridge = () => {
        judgeInvoked = true;
        return Promise.resolve(judgeReply);
      };
      const run = await scorer.score(scorerPayload(fixture.request, output, reference, metadata), judge);
      const label = firstTruthy(fixture.label, fixture.id);
      results.push({
        label: label === undefined ? fallbackLabel : textOf(label),
        expect,
        actualPass: run.error === null && run.pass,
        ok: run.error === null && (expect === "pass" ? run.pass : !run.pass),
        judgeInvoked,
        reasons: run.reasons,
        error: run.error
      });
    }
    return results;
  } finally {
    await scorer.stop();
  }
}

function printFixtureResults(title: string, results: FixtureResult[]): void {
  console.log("");
  console.log(`${title}: ${results.filter((result) => result.ok).length}/${results.length} passed`);
  for (const result of results) {
    const actual = result.error ? "error" : result.actualPass ? "pass" : "fail";
    const judge = result.judgeInvoked ? " judge" : "";
    const detail = result.error ? ` error=${result.error}` : result.reasons.length ? ` reasons=${result.reasons.join("; ")}` : "";
    console.log(`  ${result.ok ? "OK   " : "FAIL "}${result.label} expect=${result.expect} actual=${actual}${judge}${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function calibrateStructured(control: ControlContext, route: ManifestRoute, cases: JsonObject[], explicitFixtures: JsonObject[]): Promise<boolean> {
  const report = await runMutationCert(control, cases, route.scorerPath);
  console.log(formatReport(report));
  const fixtureResults = await runFixtureChecks(control, route.scorerPath, explicitFixtures, []);
  printFixtureResults("Explicit calibration fixtures", fixtureResults);
  const ok = report.certified && fixtureResults.every((result) => result.ok);
  console.log(`Result: LOCAL SCORER CALIBRATION ${ok ? "PASSED" : "FAILED"}`);
  if (!report.certified) {
    console.log(`Local scorer calibration blockers: ${report.certifiedReasons.join("; ") || "strict mutation checks failed"}`);
  }
  return ok;
}

async function calibrateHumanRead(control: ControlContext, route: ManifestRoute, cases: JsonObject[], calibration: CalibrationFile): Promise<boolean> {
  const fixtureResults = await runFixtureChecks(control, route.scorerPath, calibration.fixtures, casesToReferenceFixtures(cases));
  printFixtureResults("Human-read fixture calibration", fixtureResults);
  const passCount = fixtureResults.filter((result) => result.expect === "pass").length;
  const failCount = fixtureResults.filter((result) => result.expect === "fail").length;
  let ok = fixtureResults.length > 0 && passCount > 0 && failCount > 0 && fixtureResults.every((result) => result.ok);
  if (passCount === 0 || failCount === 0) {
    console.log("Human-read calibration requires at least one expected pass and one expected fail fixture.");
    ok = false;
  }
  if (cases.length > 0) {
    const advisory = await runMutationCert(control, cases, route.scorerPath);
    console.log("");
    console.log("Advisory deterministic mutations (not a human-read task-quality result):");
    console.log(formatReport(advisory));
    console.log("Mutation output above is advisory only for human-read routes; fixture/rubric checks are the hard local gate.");
  }
  console.log(`Result: LOCAL SCORER FIXTURE CALIBRATION ${ok ? "PASSED" : "FAILED"}`);
  return ok;
}

/** The workflow path an older manifest declares in `eval_pack.workflow`, when present. */
function declaredWorkflow(route: ManifestRoute): string | null {
  const workflow = objectField(route.entry, "eval_pack").workflow;
  if (workflow === undefined || workflow === null) return null;
  if (!isJsonString(workflow) || !isRepoPath(workflow)) throw new ProtocolError(`route ${route.routeId}: eval_pack.workflow must be a normalized repository-relative path`);
  return workflow;
}

async function calibrateRepositoryExecutable(control: ControlContext, route: ManifestRoute): Promise<boolean> {
  const executable = route.executable;
  if (!executable) throw new Error(`Repository executable route is missing its executable contract: ${route.routeId}`);
  const workflow = declaredWorkflow(route);
  const declaredRefs: [string, string][] = [["config_path", route.configPath]];
  if (workflow !== null) declaredRefs.push(["workflow", workflow]);
  declaredRefs.push(["lockfile", executable.lockfilePath]);
  for (const filePath of executable.inputRefs) declaredRefs.push(["input_ref", filePath]);
  for (const filePath of executable.acceptanceRefs) declaredRefs.push(["acceptance_ref", filePath]);
  for (const filePath of route.caseRefs) declaredRefs.push(["case_ref", filePath]);
  const uniqueRefs = new Map<string, string[]>();
  for (const [kind, filePath] of declaredRefs) {
    const labels = uniqueRefs.get(filePath) ?? [];
    labels.push(kind);
    uniqueRefs.set(filePath, labels);
  }
  for (const [filePath, labels] of uniqueRefs) {
    try {
      await readFile(path.join(control.controlRoot, filePath));
    } catch (error) {
      throw new Error(`Missing or unreadable repository executable reference ${filePath} (${labels.join(", ")}): ${errorMessage(error instanceof Error ? error : String(error))}`);
    }
  }
  console.log("Mode: repository_executable");
  console.log(`Declared command: ${JSON.stringify(executable.argv)}`);
  // EVAL-012: CI runs the evaluator only on the pinned runtime; say so here, not at the first dispatch.
  const launchers: readonly string[] = ARGV_LAUNCHERS[executable.runtime];
  if (!launchers.includes(executable.argv[0] ?? "")) {
    console.log(`Result: EXECUTABLE DECLARATION INVALID - argv must start with one of ${launchers.join(", ")} so it runs on the pinned ${executable.runtime} ${executable.runtimeVersion}.`);
    return false;
  }
  console.log(`Validated executable references: ${uniqueRefs.size}`);
  console.log(`Quality source: ${route.resultSchema} at ${executable.resultPath} with primary metric ${executable.primaryMetric}`);
  console.log("Result: EXECUTABLE DECLARATION VALIDATED");
  console.log("Quality is produced by the declared repository executable result when the evaluator runs. No isolated-replay cases or scorer were loaded.");
  return true;
}

async function calibrateRoute(control: ControlContext, route: ManifestRoute): Promise<boolean> {
  console.log("");
  console.log(`== Route ${route.routeId} ==`);
  if (route.mode === "repository_executable") return calibrateRepositoryExecutable(control, route);
  // A missing scorer fails the command before any case is read, as before.
  await readFile(path.join(control.controlRoot, route.scorerPath));
  // §6.1: every case_ref, with the same route filter and case identity as CI replay.
  const cases = (await loadReplayCases(control.controlRoot, route)).map((testCase) => testCase.raw);
  const calibration = await readCalibrationFile(control.controlRoot, calibrationPath(route));
  const archetype = routeArchetype(route) ?? calibration.archetype ?? archetypeFromCaseMetadata(cases) ?? archetypeFromCases(cases) ?? archetypeFromFixtures(calibration.fixtures);
  if (!archetype) {
    console.log("Archetype: UNCLASSIFIED");
    console.log("Result: UNVERIFIED - no route archetype or defensible local calibration evidence found.");
    return false;
  }
  console.log(`Archetype: ${archetype}${archetypeSourceNote(route, calibration, cases)}`);
  if (archetype === "code-consumed") return calibrateStructured(control, route, cases, calibration.fixtures);
  if (archetype === "human-read") return calibrateHumanRead(control, route, cases, calibration);
  console.log("Result: UNVERIFIED - this route is marked neither-defensible, so no local scorer calibration pass is reported.");
  return false;
}

/** Run local calibration for every route, or the one BENCHROUTER_ROUTE_ID names. */
export async function runCalibrate(control: ControlContext, args: string[]): Promise<number> {
  if (args.includes("--replay")) throw new Error(REPLAY_REFUSAL);
  const routeFilter = process.env.BENCHROUTER_ROUTE_ID ?? "";
  const manifest = await readManifest(control.controlRoot);
  const selected = routeFilter ? manifest.routes.filter((route) => route.routeId === routeFilter || route.slug === routeFilter) : manifest.routes;
  if (selected.length === 0) throw new Error(`No route matched BENCHROUTER_ROUTE_ID=${JSON.stringify(routeFilter)}`);
  console.log("BenchRouter local scorer calibration");
  console.log("Scope: local scorer behavior only. This does not prove task quality, routing eligibility, observed runtime traffic, or production readiness.");
  console.log("Scorer console is LIVE in this local command. CI evals keep console no-op.");
  let failures = 0;
  for (const route of selected) {
    if (!(await calibrateRoute(control, route))) failures++;
  }
  if (failures > 0) throw new Error(`BenchRouter calibration failed for ${failures} route(s)`);
  return 0;
}
