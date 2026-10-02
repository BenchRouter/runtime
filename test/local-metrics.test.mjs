import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { build } from '../runtime/node_modules/esbuild/lib/main.js';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'runtime-metrics-'));
const bundle = path.join(scratch, 'metrics.mjs');
await build({ entryPoints: [fileURLToPath(new URL('../runtime/src/metrics.ts', import.meta.url))], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
const { metricsChecks, ReplayMetricsWriter, METRICS_DIR } = await import(pathToFileURL(bundle).href);
after(() => rm(scratch, { recursive: true, force: true }));

// The exact check shape emitted by the authored Phone and Spice scorers.
const check = { name: 'response_has_content', pass: false, detail: 'empty content',
  code_ref: 'functions-lib/scorer.ts#callGroq reads data.choices[0].message.content' };

test('RUN-001 preserves declared scorer check fields in the local string schema', { timeout: 5000 }, () => {
  const result = metricsChecks(['existing:check', check]);
  assert.equal(result.checks_omitted, false);
  assert.equal(result.checks[0], 'existing:check');
  assert.deepEqual(JSON.parse(result.checks[1]), check);
});

test('DATA-001 refuses unrecognized, nested, invalid and control-bearing check data', { timeout: 5000 }, () => {
  const invalid = [null, 1, false, [], { ...check, extra: 'private' },
    { ...check, name: { nested: 'private' } }, { ...check, pass: 'false' },
    { ...check, detail: 'private\ntext' }, { ...check, code_ref: 'private\u007ftext' },
    { ...check, name: 'private\u0000text' }, { name: check.name, pass: true, detail: 'missing ref' },
    { arbitrary: 'object' }, 'private\ntext'];
  assert.deepEqual(metricsChecks([check, ...invalid]), { checks: [JSON.stringify(check)], checks_omitted: true });
});

test('RUN-001 retains count and serialized byte ceilings', { timeout: 5000 }, () => {
  assert.deepEqual(metricsChecks(['x'.repeat(4096)]), { checks: ['x'.repeat(4096)], checks_omitted: false });
  assert.deepEqual(metricsChecks([{ ...check, detail: 'x'.repeat(4090) },
    { ...check, detail: '界'.repeat(1500) }, { ...check, detail: '"'.repeat(3000) }]),
    { checks: [], checks_omitted: true });
  const capped = metricsChecks(Array.from({ length: 65 }, () => check));
  assert.equal(capped.checks.length, 64);
  assert.equal(capped.checks_omitted, true);
});

test('RUN-001 writes private diagnostics on Linux and refuses unsupported filesystems', { timeout: 5000 }, async () => {
  const workspace = await mkdtemp(path.join(scratch, 'workspace-'));
  const row = { case_id: 'format-refusal', model: 'candidate', selected_model: null,
    pass: false, technical_failure: false, cost_usd: 0, ...metricsChecks([check]) };
  const writer = new ReplayMetricsWriter(workspace);
  if (process.platform !== 'linux') {
    await assert.rejects(writer.write('work', 0, 1, [row], 'uploaded'), /Linux directory anchor/);
    await assert.rejects(readdir(path.join(workspace, METRICS_DIR)), { code: 'ENOENT' });
    return;
  }
  await writer.write('work', 0, 1, [row], 'uploaded');
  const directory = path.join(workspace, METRICS_DIR);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const file = path.join(directory, files[0]);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(JSON.parse(stored.checks[0]), check);
  assert.equal(stored.checks_omitted, false);
  assert.equal(stored.pass, false);
  assert.equal(stored.server_accepted, true);
  assert.equal(stored.terminal_status, 'uploaded');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await assert.rejects(writer.write('oversize', 0, 1, [{ ...row, case_id: 'x'.repeat(33 * 1024) }], 'uploaded'), /row exceeds/);
  assert.deepEqual(await readdir(directory), files);
});
