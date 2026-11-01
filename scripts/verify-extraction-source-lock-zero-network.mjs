import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXTRACTION_LOCK_MANIFEST,
  REQUIRED_EXTRACTION_LOCK_PATHS,
  verifyExtractionFeatureLock,
} from './verify-extraction-feature-lock.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputBase = path.join(projectRoot, '.codex-evidence/extraction-incident-20261029-9ea52c8d/source-lock-tests-unique');
fs.mkdirSync(outputBase, { recursive: true });
const outputRoot = fs.mkdtempSync(path.join(outputBase, 'run-'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
let fixtureIndex = 0;

function makeFixture() {
  const root = path.join(outputRoot, 'fixture-' + String(++fixtureIndex).padStart(3, '0'));
  fs.mkdirSync(root);
  const files = REQUIRED_EXTRACTION_LOCK_PATHS.map(relative => {
    const filename = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const content = `Zero-network extraction lock fixture: ${relative}\n`;
    fs.writeFileSync(filename, content);
    return { path: relative, sha256: sha256(content) };
  });
  const manifest = {
    schema: 'extraction-feature-lock.v1', locked: true,
    approval: { reference: 'fixture-explicit-owner-request' }, files,
  };
  const manifestPath = path.join(root, EXTRACTION_LOCK_MANIFEST);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { root, manifest, manifestPath };
}
function saveManifest(fixture) {
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest, null, 2) + '\n');
}
function expectLocked(fixture, reason) {
  const before = fs.existsSync(fixture.manifestPath) ? fs.readFileSync(fixture.manifestPath) : null;
  assert.throws(() => verifyExtractionFeatureLock(fixture.root), error => {
    assert.match(error.message, /^EXTRACTION_SOURCE_LOCKED:/u);
    if (reason) assert.match(error.message, reason);
    assert.match(error.message, /禁止自动刷新基线/u);
    return true;
  });
  if (before) assert.deepEqual(fs.readFileSync(fixture.manifestPath), before, 'Verifier must not automatically reseal or normalize the manifest');
  else assert.equal(fs.existsSync(fixture.manifestPath), false, 'Verifier must not create a missing manifest');
}
function test(name, run) {
  const fixture = makeFixture();
  run(fixture);
  results.push({ name, passed: true });
  console.log('PASS ' + name);
}

test('a complete unchanged source tree passes without rewriting its manifest', fixture => {
  const before = fs.readFileSync(fixture.manifestPath);
  const result = verifyExtractionFeatureLock(fixture.root);
  assert.equal(result.passed, true);
  assert.equal(result.locked, true);
  assert.equal(result.protectedFiles, REQUIRED_EXTRACTION_LOCK_PATHS.length);
  assert.equal(result.manifestSha256, sha256(before));
  assert.deepEqual(fs.readFileSync(fixture.manifestPath), before);
  for (const row of fixture.manifest.files) {
    const bytes = fs.readFileSync(path.join(fixture.root, ...row.path.split('/')));
    assert.equal(bytes.includes(13), false, 'A valid protected text must contain no CR bytes: ' + row.path);
    const canonicalLf = bytes.toString('utf8').replace(/\r\n?/gu, '\n');
    assert.equal(sha256(canonicalLf), row.sha256, 'Canonical LF release content must retain the recorded SHA256: ' + row.path);
    assert.equal(sha256(bytes), row.sha256, 'Raw local content must match the same SHA256: ' + row.path);
  }
});
test('CRLF source is rejected even when its manifest hash is maliciously resealed', fixture => {
  const row = fixture.manifest.files[0];
  const filename = path.join(fixture.root, ...row.path.split('/'));
  const crlf = fs.readFileSync(filename, 'utf8').replace(/\n/gu, '\r\n');
  fs.writeFileSync(filename, crlf);
  row.sha256 = sha256(fs.readFileSync(filename));
  saveManifest(fixture);
  expectLocked(fixture, /受保护文本不符合 LF 换行合同/u);
  assert.equal(fs.readFileSync(filename, 'utf8'), crlf, 'Verifier must not normalize CRLF or repair the source');
});
test('a real content modification fails its hash and is never automatically adopted', fixture => {
  const filename = path.join(fixture.root, REQUIRED_EXTRACTION_LOCK_PATHS[0]);
  fs.appendFileSync(filename, 'unauthorized fixture modification\n');
  const actual = fs.readFileSync(filename);
  expectLocked(fixture, /受保护文件已变更/u);
  assert.deepEqual(fs.readFileSync(filename), actual, 'Verifier must not restore or alter changed source');
  assert.notEqual(fixture.manifest.files[0].sha256, sha256(actual));
  expectLocked(fixture, /受保护文件已变更/u);
});
test('a missing protected file fails closed', fixture => {
  fs.unlinkSync(path.join(fixture.root, REQUIRED_EXTRACTION_LOCK_PATHS[0]));
  expectLocked(fixture, /受保护文件缺失/u);
});
test('a missing manifest fails closed and is not recreated', fixture => {
  fs.unlinkSync(fixture.manifestPath);
  expectLocked(fixture, /保护清单缺失/u);
});
test('invalid JSON fails closed without changing the manifest', fixture => {
  fs.writeFileSync(fixture.manifestPath, '{ invalid fixture JSON');
  expectLocked(fixture, /保护清单无法解析/u);
});
test('locked=false cannot turn off source protection', fixture => {
  fixture.manifest.locked = false;
  saveManifest(fixture);
  expectLocked(fixture, /保护清单合同无效/u);
});
test('missing owner approval reference fails closed', fixture => {
  delete fixture.manifest.approval;
  saveManifest(fixture);
  expectLocked(fixture, /保护清单合同无效/u);
});
test('an unsupported manifest schema fails closed', fixture => {
  fixture.manifest.schema = 'extraction-feature-lock.untrusted';
  saveManifest(fixture);
  expectLocked(fixture, /保护清单合同无效/u);
});
for (const required of REQUIRED_EXTRACTION_LOCK_PATHS) {
  test('removing required manifest entry is blocked: ' + required, fixture => {
    fixture.manifest.files = fixture.manifest.files.filter(file => file.path !== required);
    saveManifest(fixture);
    expectLocked(fixture, /保护范围被缩减/u);
  });
}
test('an exact duplicate path is rejected', fixture => {
  fixture.manifest.files.push({ ...fixture.manifest.files[0] });
  saveManifest(fixture);
  expectLocked(fixture, /重复保护路径/u);
});
test('a duplicate path with changed case is rejected on every platform', fixture => {
  const row = fixture.manifest.files[0];
  fixture.manifest.files.push({ ...row, path: row.path.toLowerCase() });
  saveManifest(fixture);
  expectLocked(fixture, /重复保护路径/u);
});
for (const invalid of [
  '../outside.ts', '/absolute.ts', 'C:/absolute.ts', 'src\\outside.ts',
  'src/../outside.ts', 'src/./outside.ts', 'src//outside.ts', '',
]) {
  test('invalid manifest path is rejected: ' + JSON.stringify(invalid), fixture => {
    fixture.manifest.files.push({ path: invalid, sha256: '0'.repeat(64) });
    saveManifest(fixture);
    expectLocked(fixture, /保护路径或摘要无效/u);
  });
}
test('a malformed SHA256 is rejected', fixture => {
  fixture.manifest.files[0].sha256 = 'not-a-valid-sha256';
  saveManifest(fixture);
  expectLocked(fixture, /保护路径或摘要无效/u);
});
test('a protected directory cannot substitute for a protected file', fixture => {
  const filename = path.join(fixture.root, REQUIRED_EXTRACTION_LOCK_PATHS[0]);
  fs.unlinkSync(filename);
  fs.mkdirSync(filename);
  expectLocked(fixture, /保护路径逃逸或不是文件/u);
});

{
  const fixture = makeFixture();
  const name = 'a symbolic link cannot escape the protected project root';
  const filename = path.join(fixture.root, REQUIRED_EXTRACTION_LOCK_PATHS[0]);
  const outside = path.join(outputRoot, 'outside-symlink-fixture.txt');
  fs.writeFileSync(outside, 'outside source-lock fixture\n');
  fs.unlinkSync(filename);
  let available = true;
  try { fs.symlinkSync(outside, filename, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    available = false;
    results.push({ name, skipped: true, reason: error.code + ': Windows file symlink permission unavailable' });
    console.log('SKIP ' + name + ' (' + error.code + ')');
  }
  if (available) {
    expectLocked(fixture, /保护路径逃逸或不是文件/u);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside source-lock fixture\n');
    results.push({ name, passed: true });
    console.log('PASS ' + name);
  }
}

const report = {
  passed: results.filter(result => result.passed).length,
  skipped: results.filter(result => result.skipped).length,
  failed: 0, requiredPaths: REQUIRED_EXTRACTION_LOCK_PATHS.length,
  realNetworkRequests: 0, realDatabaseWrites: 0, actualProjectManifestWrites: 0,
  outputRoot, results,
};
fs.writeFileSync(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }));
