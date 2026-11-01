import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CHAT_LOCK_MANIFEST, REQUIRED_CHAT_LOCK_PATHS, verifyChatReliabilityLock } from './verify-chat-reliability-lock.mjs';

// Tiny text fixtures only, never a second runnable product or runtime config.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-lock-fixture-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = [];
let index = 0;
function fixture() {
  const root = path.join(temporary, String(index++));
  const files = REQUIRED_CHAT_LOCK_PATHS.map(relative => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `fixture ${relative}\n`);
    return { path: relative, sha256: hash(fs.readFileSync(target)) };
  });
  const manifest = { schema: 'chat-reliability-lock.v1', locked: true, approval: { reference: 'fixture' }, files };
  const manifestPath = path.join(root, CHAT_LOCK_MANIFEST);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifest, manifestPath };
}
function test(name, mutate, expected = /CHAT_RELIABILITY_LOCKED/u) {
  const f = fixture();
  mutate(f);
  const before = fs.existsSync(f.manifestPath) ? fs.readFileSync(f.manifestPath) : null;
  assert.throws(() => verifyChatReliabilityLock(f.root), expected);
  assert.deepEqual(fs.existsSync(f.manifestPath) ? fs.readFileSync(f.manifestPath) : null, before);
  cases.push(name);
}
const save = f => fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
try {
  const good = fixture();
  const before = fs.readFileSync(good.manifestPath);
  assert.equal(verifyChatReliabilityLock(good.root).protectedFiles, REQUIRED_CHAT_LOCK_PATHS.length);
  assert.deepEqual(fs.readFileSync(good.manifestPath), before);
  cases.push('unchanged passes without write');
  test('byte changed', f => fs.appendFileSync(path.join(f.root, f.manifest.files[0].path), 'x'));
  test('missing file', f => fs.unlinkSync(path.join(f.root, f.manifest.files[0].path)));
  test('missing manifest', f => fs.unlinkSync(f.manifestPath));
  test('bad JSON', f => fs.writeFileSync(f.manifestPath, '{'));
  test('disabled', f => { f.manifest.locked = false; save(f); });
  test('missing approval', f => { delete f.manifest.approval; save(f); });
  test('shrunk scope', f => { f.manifest.files.pop(); save(f); });
  test('duplicate', f => { f.manifest.files.push(f.manifest.files[0]); save(f); });
  test('case conflict', f => { f.manifest.files.push({ ...f.manifest.files[0], path: f.manifest.files[0].path.toUpperCase() }); save(f); });
  for (const relative of ['../outside', '/absolute', 'C:/outside', 'x\\y', 'x//y', 'x/./y']) {
    test('unsafe path ' + relative, f => { f.manifest.files[0].path = relative; save(f); });
  }
  test('invalid hash', f => { f.manifest.files[0].sha256 = 'bad'; save(f); });
  test('CRLF rejected even with matching hash', f => {
    const row = f.manifest.files[0], target = path.join(f.root, row.path);
    fs.writeFileSync(target, 'fixture\r\n');
    row.sha256 = hash(fs.readFileSync(target));
    save(f);
  }, /LF/u);
  for (const kind of ['source', 'manifest', 'manifest-directory']) {
    const f = fixture();
    const candidate = kind === 'source' ? path.join(f.root, f.manifest.files[0].path)
      : kind === 'manifest' ? f.manifestPath : path.dirname(f.manifestPath);
    const destination = candidate + '-physical';
    fs.renameSync(candidate, destination);
    try { fs.symlinkSync(destination, candidate, kind === 'manifest-directory' && process.platform === 'win32' ? 'junction'
      : kind === 'manifest-directory' ? 'dir' : 'file'); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      cases.push({ name: kind + ' link', skipped: 'platform link permission' });
      continue;
    }
    const before = fs.readFileSync(f.manifestPath);
    assert.throws(() => verifyChatReliabilityLock(f.root), /链接/u);
    assert.deepEqual(fs.readFileSync(f.manifestPath), before);
    cases.push(kind + ' link rejected');
  }
  console.log(JSON.stringify({ passed: true, cases, providerCalls: 0, databaseWrites: 0 }));
} finally {
  const resolved = fs.realpathSync(temporary);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('chat-lock-fixture-')) throw Error('FIXTURE_CLEANUP_SCOPE');
  fs.rmSync(resolved, { recursive: true, force: true });
}
