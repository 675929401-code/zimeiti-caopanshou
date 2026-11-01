// Execute current hook/controller branches with local files and command substitutes.
// This checks adoption behavior, not Linux ownership, flock, PM2 or production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const hookSource = fs.readFileSync(new URL('./media-worker-transaction-hook-vnext.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const controller = fs.readFileSync(new URL('./deploy-artifact-vnext.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prestop-regression-'));
const savedArtifact = process.env.DIRECT_HOOK_ARTIFACT_SHA256;
const savedAdoption = process.env.DIRECT_HOOK_PRESTOP_ADOPTION;
let checks = 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function section(source, first, next) {
  const i = source.indexOf(first), j = source.indexOf(next, i + first.length);
  assert.ok(i >= 0 && j > i, `source boundary missing: ${first}`);
  assert.equal(source.indexOf(first, i + first.length), -1, `ambiguous boundary: ${first}`);
  return source.slice(i, j);
}
function bashPath(value) {
  return process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):\//u, (_, drive) => `/${drive.toLowerCase()}/`) : value;
}
function findBash() {
  if (process.env.GIT_BASH_PATH) return process.env.GIT_BASH_PATH;
  if (process.platform !== 'win32') return 'bash';
  const candidates = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, 'bash.exe'), path.resolve(entry, '..', 'bin', 'bash.exe'), path.resolve(entry, '..', 'usr', 'bin', 'bash.exe'));
  }
  const found = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(found, 'System Bash or Git Bash is required; set GIT_BASH_PATH when it is not on PATH');
  return found;
}

try {
  let code = hookSource;
  function replaceFunction(first, next, replacement) {
    code = code.replace(section(code, first, next), `${replacement}\n\n`);
  }
  // Replace only OS/command boundaries. Keep marker decoding, hashes, identity
  // comparisons, both observations and the actual prepare adoption branch.
  replaceFunction('function assertInheritedWindowLock(root) {', 'function readWindowFile(', 'function assertInheritedWindowLock() { globalThis.__prestopRegression.lock(); }');
  replaceFunction('function assertTrustedFile(filePath, expectedSha256, label) {', 'function assertRootControlledParentChain(', 'function assertTrustedFile(filePath, expectedSha256, label) { if (sha256File(filePath) !== expectedSha256) fail(`${label}_CHANGED`); return filePath; }');
  replaceFunction('function assertRootControlledParentChain(target, stopAt) {', 'function readJson(', 'function assertRootControlledParentChain() {}');
  replaceFunction('function run(command, args, options = {}) {', 'function pm2Entries(', 'function run(command, args) { if (command !== "ss") throw Error("UNEXPECTED_COMMAND:" + command); return globalThis.__prestopRegression.ss(args); }');
  replaceFunction('function pm2Entries() {', 'function workerIdentity(', 'function pm2Entries() { return globalThis.__prestopRegression.pm2(); }');
  replaceFunction('function identityFromCurrent(root) {', 'function stopWorkers(', 'function identityFromCurrent() { return globalThis.__prestopRegression.identity(); }');
  const metadata = 'a.uid !== 0 || a.gid !== 0 || (a.mode & 0o777) !== 0o600';
  assert.equal(code.split(metadata).length, 2, 'window metadata check changed');
  code = code.replace(metadata, 'false /* host ownership/mode substituted only */');
  const prepare = section(code, '  if (phase === "prepare") {', '\n  if (!fs.existsSync(statePath))');
  code += `\nexport async function regressionPrepare(root, controlRoot, transactionRoot, statePath, configPath) {\nconst phase = 'prepare';\n${prepare}\nthrow Error('PREPARE_FELL_THROUGH');\n}\n`;
  // Capture only the branch acknowledgement; no raw production output exists.
  const ack = 'process.stdout.write(`${JSON.stringify({ ok: true, phase, releaseId: previous.releaseId, ports: WORKER_PORTS })}\\n`);';
  assert.ok(code.includes(ack), 'prepare acknowledgement missing');
  code = code.replaceAll(ack, 'globalThis.__prestopRegression.ack++;');
  const modulePath = path.join(temp, 'hook.mjs');
  fs.writeFileSync(modulePath, code);
  const { regressionPrepare } = await import(pathToFileURL(modulePath).href);
  const artifact = 'a'.repeat(64), tx = `fixture-release-${artifact.slice(0, 12)}`;
  const transaction = path.join(temp, tx); fs.mkdirSync(transaction);
  const statePath = path.join(transaction, 'media-worker-state.json');
  const markerPath = path.join(transaction, 'migration-confirmed.json');
  const config = path.join(temp, 'ecosystem.config.cjs');
  const identity = { cwd: '/fixture/old', releaseId: 'fixture-old-release', commitSha: 'b'.repeat(40), buildId: 'fixture-build', sourceVersion: 'fixture-source', buildOutputDigest: 'c'.repeat(64), assetDigest: 'd'.repeat(64), assetManifestSha256: 'e'.repeat(64), ports: [5102, 5103] };
  const jsonWrite = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  function reset() {
    fs.writeFileSync(config, 'fixture config');
    const configSha256 = hash(fs.readFileSync(config));
    const state = { schemaVersion: 'zimeiti-media-worker-transaction.v1', workerName: 'agent-hub-media-worker', preparedAt: 'fixture', configPath: config, configSha256, previous: identity, status: 'prepared' };
    jsonWrite(statePath, state);
    const marker = { schemaVersion: 1, transactionId: tx, artifactSha256: artifact, batchId: '11111111-1111-4111-8111-111111111111', scriptSha256: 'b'.repeat(64), wireSha256: 'c'.repeat(64), commitReceiptSha256: 'd'.repeat(64), stateSha256: hash(fs.readFileSync(statePath)), configSha256 };
    jsonWrite(markerPath, marker);
    process.env.DIRECT_HOOK_ARTIFACT_SHA256 = artifact;
    process.env.DIRECT_HOOK_PRESTOP_ADOPTION = '1';
    globalThis.__prestopRegression = { ack: 0, locks: 0, slots: 0, ports: 0, lock() { this.locks++; }, pm2() { this.slots++; return []; }, ss() { this.ports++; return ''; }, identity() { return { ...identity }; } };
    return { state, marker };
  }
  const execute = () => regressionPrepare(temp, temp, transaction, statePath, config);
  reset();
  const before = fs.readFileSync(statePath);
  await execute();
  assert.deepEqual(fs.readFileSync(statePath), before, 'adoption must not rewrite or prepare workers again');
  assert.equal(globalThis.__prestopRegression.ack, 1);
  assert.equal(globalThis.__prestopRegression.locks, 2);
  assert.equal(globalThis.__prestopRegression.slots, 2);
  assert.equal(globalThis.__prestopRegression.ports, 4);
  checks++;
  async function reject(mutate, error) {
    const fixture = reset(); mutate(fixture);
    await assert.rejects(execute, error);
    assert.equal(globalThis.__prestopRegression.ack, 0); checks++;
  }
  await reject(() => fs.unlinkSync(markerPath), /ENOENT|WINDOW_MARKER/u);
  await reject(() => fs.writeFileSync(markerPath, '{"schemaVersion":1,"schemaVersion":1}\n'), /NONCANONICAL/u);
  await reject(({ marker }) => { marker.transactionId = 'wrong-transaction'; jsonWrite(markerPath, marker); }, /WINDOW_MARKER_INVALID/u);
  await reject(({ marker }) => { marker.artifactSha256 = 'f'.repeat(64); jsonWrite(markerPath, marker); }, /WINDOW_MARKER_INVALID/u);
  await reject(({ marker }) => { marker.commitReceiptSha256 = 'invalid'; jsonWrite(markerPath, marker); }, /WINDOW_MARKER_INVALID/u);
  await reject(() => fs.appendFileSync(statePath, ' '), /WINDOW_BINDING_CHANGED/u);
  await reject(() => fs.appendFileSync(config, 'changed'), /WINDOW_BINDING_CHANGED/u);
  await reject(({ state, marker }) => { state.status = 'activated'; jsonWrite(statePath, state); marker.stateSha256 = hash(fs.readFileSync(statePath)); jsonWrite(markerPath, marker); }, /WINDOW_STATE_INVALID/u);
  await reject(() => { globalThis.__prestopRegression.identity = () => ({ ...identity, buildId: 'changed' }); }, /WINDOW_PREVIOUS_IDENTITY_CHANGED/u);
  await reject(() => { globalThis.__prestopRegression.pm2 = () => [{ name: 'agent-hub-media-worker' }]; }, /MEDIA_WORKER_SLOT_STILL_EXISTS/u);
  await reject(() => { globalThis.__prestopRegression.ss = () => 'LISTEN *:5102'; }, /MEDIA_WORKER_PORT_STILL_BOUND/u);
  await reject(() => { globalThis.__prestopRegression.lock = function () { if (++this.locks === 2) throw Error('LOCK_LOST'); }; }, /LOCK_LOST/u);
  await reject(() => { globalThis.__prestopRegression.pm2 = function () { return ++this.slots === 2 ? [{ name: 'agent-hub-media-worker' }] : []; }; }, /MEDIA_WORKER_SLOT_STILL_EXISTS/u);

  const bash = findBash();
  function shellFunction(name) {
    const first = `${name}() {`, i = controller.indexOf(first), j = controller.indexOf('\n}\n', i);
    assert.ok(i >= 0 && j > i, `missing shell function ${name}`);
    return controller.slice(i, j + 3);
  }
  const rollback = shellFunction('rollback_release'), cleanup = shellFunction('final_cleanup');
  const script = path.join(temp, 'failure.sh');
  // Run real rollback_release and final_cleanup. All side-effect boundaries
  // below are substitutes; no controller CLI or live hook is launched.
  fs.writeFileSync(script, `set +e
PRESTOP_ADOPT="$1"; SWITCH_STARTED="$2"; MODE="$3"; DIRECT_TRANSACTION_ROOT="$4"
DEPLOY_COMPLETE=0; DIRECT_PREPARED=1; DIRECT_ROLLBACK_COMPLETE=0
ROLLBACK_ATTEMPTED=0; ROLLBACK_SUCCEEDED=0; IN_ROLLBACK=0; FAILURE_CONTEXT=''
APP_TEMP_LINK=''; ASSET_TEMP_LINK=''; HISTORY_FD=''; STAGING_DIR=''; AUDIT_DIR=''; candidate_unit=''
cleanup_candidate(){ echo CLEANUP; return 1; }
direct_hook(){ echo "HOOK:$1"; return 0; }
unexpected_error(){ :; }
pm2(){ echo UNEXPECTED_PM2; return 97; }
systemctl(){ echo UNEXPECTED_SYSTEMCTL; return 97; }
${rollback}
${cleanup}
if [[ "$MODE" == rollback ]]; then rollback_release fixture; exit $?; fi
false; final_cleanup
`);
  for (const adoption of [0, 1]) {
    for (const switched of [0, 1]) {
      const result = spawnSync(bash, [bashPath(script), String(adoption), String(switched), 'exit', bashPath(transaction)], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, cwd: temp });
      assert.equal(result.error, undefined); assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /UNEXPECTED_/u);
      for (const phase of ['rollback-before', 'rollback-after', 'rollback-persisted']) {
        assert.equal(result.stdout.includes(`HOOK:${phase}`), adoption === 0, `EXIT adoption=${adoption} switched=${switched} ${phase}`);
      }
      checks++;
    }
    const result = spawnSync(bash, [bashPath(script), String(adoption), '1', 'rollback', bashPath(transaction)], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, cwd: temp });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
    assert.equal(result.stdout.includes('CLEANUP'), adoption === 0);
    assert.equal(result.stderr.includes('ROLLBACK DISABLED'), adoption === 1);
    assert.doesNotMatch(result.stdout, /HOOK:|UNEXPECTED_/u); checks++;
  }
  console.log(JSON.stringify({ ok: true, checks, hookPrepareExecuted: true, controllerFailureBranchesExecuted: true, productionOperations: 0, linuxLockOrOwnershipProven: false }));
} finally {
  if (savedArtifact === undefined) delete process.env.DIRECT_HOOK_ARTIFACT_SHA256; else process.env.DIRECT_HOOK_ARTIFACT_SHA256 = savedArtifact;
  if (savedAdoption === undefined) delete process.env.DIRECT_HOOK_PRESTOP_ADOPTION; else process.env.DIRECT_HOOK_PRESTOP_ADOPTION = savedAdoption;
  delete globalThis.__prestopRegression;
  fs.rmSync(temp, { recursive: true, force: true });
}
