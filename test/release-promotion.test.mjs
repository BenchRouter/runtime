import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../runtime/package.json', import.meta.url));
const { parse } = require('yaml');
const scratch = mkdtempSync(join(tmpdir(), 'release-contract-'));
const version = '9.9.9-local-proof';
const artifact = Buffer.from('export const genuineLocalCryptoProof = true;\n');
const digest = 'sha256:' + createHash('sha256').update(artifact).digest('hex');
const recordedAllowed = JSON.parse(readFileSync(new URL('fixtures/release-status-allowed.json', import.meta.url)));
const recordedUnknown = JSON.parse(readFileSync(new URL('fixtures/release-status-unknown.json', import.meta.url)));
let server, origin, keyConfig, key, envelope;
let statusMode = 'allowed', artifactMode = 'original', pointerVersion = version, requestedPaths = [];
function run(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scratch, 'scripts/release.mjs'), command, ...args], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(scratch, 'tls-cert.pem'), SIGNING_KEY: key ?? '' }
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
function flags() {
  return ['--origin', origin, '--api', origin, '--version', version, '--expected-digest', digest];
}
before(async () => {
  mkdirSync(join(scratch, 'scripts')); mkdirSync(join(scratch, 'runtime'));
  cpSync(new URL('../scripts/release.mjs', import.meta.url), join(scratch, 'scripts/release.mjs'));
  const signing = generateKeyPairSync('ed25519');
  const next = generateKeyPairSync('ed25519');
  function publicConfig(pair, slot) {
    const raw = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
    return { slot, alg: 'ed25519', key_id: 'ed25519:' + createHash('sha256').update(raw).digest('hex').slice(0, 16), public_key: raw.toString('base64') };
  }
  key = signing.privateKey.export({ type: 'pkcs8', format: 'pem' });
  keyConfig = { current: publicConfig(signing, 'A'), next: publicConfig(next, 'B'), retired: [] };
  writeFileSync(join(scratch, 'release-keys.json'), JSON.stringify(keyConfig));
  writeFileSync(join(scratch, 'runtime/package.json'), JSON.stringify({ version, benchrouter: { protocol_major: 1, features: [] } }));
  writeFileSync(join(scratch, 'runtime.mjs'), artifact);
  const signed = await run('sign', ['--artifact', join(scratch, 'runtime.mjs'), '--expected-digest', digest, '--out', join(scratch, 'signed')]);
  assert.equal(signed.code, 0, signed.stderr);
  envelope = readFileSync(join(scratch, 'signed/manifest.json'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(scratch, 'tls-key.pem'), '-out', join(scratch, 'tls-cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  server = createServer({ key: readFileSync(join(scratch, 'tls-key.pem')), cert: readFileSync(join(scratch, 'tls-cert.pem')) }, (request, response) => {
    const url = new URL(request.url, origin); requestedPaths.push(url.pathname);
    if (url.pathname.endsWith('/manifest.json')) response.end(envelope);
    else if (url.pathname.endsWith('/runtime.mjs')) response.end(artifactMode === 'original' ? artifact : Buffer.from('corrupt artifact'));
    else if (url.pathname === '/v1/runner/release-status') {
      // Replay captured public API bodies. Bind only the local real signed artifact's
      // digest, like other recorded fixture IDs. No API shape or auth outcome is invented.
      const captured = statusMode === 'unknown' ? recordedUnknown.body : recordedAllowed.body;
      const body = { ...captured, digest: statusMode === 'mismatch' ? captured.digest : digest };
      response.end(JSON.stringify(body));
    } else if (url.pathname === '/v1/pointer') {
      response.end(JSON.stringify({ protocol_major: 1, manifest_path: `v1/releases/${pointerVersion}/manifest.json` }));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(scratch, { recursive: true, force: true }); });

test('one approval owns signing through exact pointer promotion; rollback shares its lock', () => {
  const release = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const rollback = parse(readFileSync(new URL('../.github/workflows/promote.yml', import.meta.url), 'utf8'));
  assert.equal(release.concurrency, undefined);
  assert.equal(release.jobs.build.concurrency, undefined);
  assert.equal(release.jobs.publish.concurrency.group, 'runtime-pointer');
  assert.equal(rollback.concurrency.group, release.jobs.publish.concurrency.group);
  assert.equal(release.jobs.publish.concurrency['cancel-in-progress'], false);
  assert.equal(rollback.concurrency['cancel-in-progress'], false);
  assert.equal(Object.values(release.jobs).filter(job => job.environment).length, 1);
  const job = release.jobs.publish;
  assert.equal(job.environment.name, 'runtime-signing'); assert.equal(job.needs, 'build');
  assert.equal(job.env.VERSION, '${{ needs.build.outputs.version }}');
  assert.equal(job.env.BUILD_DIGEST, '${{ needs.build.outputs.digest }}');
  const policy = job.steps.findIndex(step => step.with?.path === 'promotion-policy');
  const prepare = job.steps.findIndex(step => step.run?.includes('prepare-promotion'));
  const write = job.steps.findIndex(step => step.run?.includes('--key v1/pointer'));
  const readback = job.steps.findIndex(step => step.run?.includes('verify-pointer'));
  assert.equal(job.steps[policy].with.ref, 'main');
  assert(policy < prepare && prepare < write && write < readback);
  for (const index of [prepare, readback]) assert.match(job.steps[index].run, /--version "\$VERSION" --expected-digest "\$BUILD_DIGEST"/);
  assert.equal(job.steps[write].if, undefined); // default success gate, never always()
});
test('real signature, artifact and recorded allowed status produce only the canonical pointer', async () => {
  const output = join(scratch, 'pointer-success.json');
  const result = await run('prepare-promotion', [...flags(), '--out', output]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output)), { protocol_major: 1, manifest_path: `v1/releases/${version}/manifest.json` });
});
test('different approved digest refuses before API status or pointer preparation', async () => {
  const output = join(scratch, 'pointer-wrong-digest.json'); requestedPaths = [];
  const values = flags(); values[values.length - 1] = 'sha256:' + 'f'.repeat(64);
  const result = await run('prepare-promotion', [...values, '--out', output]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /approved digest/);
  assert(!requestedPaths.includes('/v1/runner/release-status')); assert(!existsSync(output));
});
test('unknown or wrong-digest API reply cannot produce a pointer', async () => {
  for (const mode of ['unknown', 'mismatch']) {
    statusMode = mode; const output = join(scratch, `pointer-${mode}.json`);
    try {
      const result = await run('prepare-promotion', [...flags(), '--out', output]);
      assert.notEqual(result.code, 0); assert(!existsSync(output));
      assert.match(result.stderr, mode === 'unknown' ? /unknown/ : /different digest/);
    } finally { statusMode = 'allowed'; }
  }
});
test('current-main key retirement and corrupt artifact refuse before pointer preparation', async () => {
  for (const mode of ['retired', 'corrupt']) {
    const output = join(scratch, `pointer-${mode}.json`);
    if (mode === 'retired') writeFileSync(join(scratch, 'release-keys.json'), JSON.stringify({ ...keyConfig, retired: [keyConfig.current.key_id] }));
    else artifactMode = 'corrupt';
    try {
      const result = await run('prepare-promotion', [...flags(), '--out', output]);
      assert.notEqual(result.code, 0); assert(!existsSync(output));
      assert.match(result.stderr, mode === 'retired' ? /retired/ : /manifest digest/);
    } finally { writeFileSync(join(scratch, 'release-keys.json'), JSON.stringify(keyConfig)); artifactMode = 'original'; }
  }
});
test('public readback verifies the exact release and refuses a different pointer', async () => {
  assert.equal((await run('verify-pointer', flags())).code, 0);
  pointerVersion = '9.9.8';
  try { const result = await run('verify-pointer', flags()); assert.notEqual(result.code, 0); assert.match(result.stderr, /does not select/); }
  finally { pointerVersion = version; }
});
