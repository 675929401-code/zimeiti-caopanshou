import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ensureSourceVersion, currentSourceVersion, assertLocalReleaseAccepted } from './local-revision.mjs';
import { writeLocalBuildFingerprintReceipt } from './local-build-fingerprint.mjs';
import { LOCAL_READINESS_DOMAINS } from './local-readiness-checklist.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-revision-'));
const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, value); };
try {
  assert.equal(spawnSync('git', ['init', '--quiet'], {cwd:root,windowsHide:true}).status, 0);
  write('.gitignore', '.next/\n.codex-*\n');
  write('app.js', 'initial');
  const first = ensureSourceVersion(root);
  assert.equal(first.revision, 1);
  assert.equal(ensureSourceVersion(root).sourceVersion, first.sourceVersion, 'same content must not bump');
  write('.release/source-files.v1.json', '{}');
  write('.env.local', 'TEST_ONLY=first');
  assert.equal(ensureSourceVersion(root).sourceVersion, first.sourceVersion, 'metadata/environment must not alter public source identity');
  write('app.js', 'changed');
  assert.throws(() => currentSourceVersion(root), /STALE/);
  const second = ensureSourceVersion(root);
  assert.equal(second.revision, 2);
  write('.codex-version.lock', '{}');
  assert.throws(() => ensureSourceVersion(root), /EEXIST/);
  fs.unlinkSync(path.join(root, '.codex-version.lock'));
  write('.next/BUILD_ID', 'fixture-build');
  const build = writeLocalBuildFingerprintReceipt(root, '.next/local-source-fingerprint.v1.json');
  assert.throws(() => assertLocalReleaseAccepted(root), /MISSING/);
  write('.codex-evidence/fixture.json', 'isolated regression fixture, not production acceptance');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'.codex-evidence/fixture.json'))).digest('hex');
  const receipt = { schemaVersion:1, scope:'release', sourceVersion:second.sourceVersion, buildId:build.buildId, fingerprint:build.fingerprint, acceptedAt:new Date().toISOString(),
    checks:['types','changed-flow','related-pages','console','release-checklist'].map(id=>({id,passed:true,evidence:'.codex-evidence/fixture.json',sha256})) };
  write('.codex-evidence/local-release-acceptance.v1.json', JSON.stringify(receipt));
  assert.throws(() => assertLocalReleaseAccepted(root), SyntaxError, 'an arbitrary text file must not pass as the release checklist');
  const checklist = {schemaVersion:1,stage:'local-release',sourceVersion:second.sourceVersion,buildId:build.buildId,openIssues:[],
    checks:LOCAL_READINESS_DOMAINS.map(id=>({id,status:'passed',evidence:[{evidence:'.codex-evidence/fixture.json',sha256}]})),
    subsequentStages:{git:'pending',candidate:'pending',production:'pending'}};
  const saveChecklist = () => {
    write('.codex-evidence/checklist.json', JSON.stringify(checklist));
    receipt.checks.find(c=>c.id==='release-checklist').evidence='.codex-evidence/checklist.json';
    receipt.checks.find(c=>c.id==='release-checklist').sha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'.codex-evidence/checklist.json'))).digest('hex');
    write('.codex-evidence/local-release-acceptance.v1.json', JSON.stringify(receipt));
  };
  saveChecklist();
  assert.equal(assertLocalReleaseAccepted(root).sourceVersion, second.sourceVersion);
  checklist.stage='production';saveChecklist();
  assert.throws(()=>assertLocalReleaseAccepted(root), /SCOPE_OR_VERSION/, 'production evidence cannot masquerade as local acceptance');
  checklist.stage='local-release';checklist.buildId='old-build';saveChecklist();
  assert.throws(()=>assertLocalReleaseAccepted(root), /SCOPE_OR_VERSION/);
  checklist.buildId=build.buildId;checklist.checks[1].status='pending';saveChecklist();
  assert.throws(()=>assertLocalReleaseAccepted(root), /PENDING: digital-human/);
  checklist.checks[1].status='passed';checklist.openIssues=['fixture-unresolved-bug'];saveChecklist();
  assert.throws(()=>assertLocalReleaseAccepted(root), /OPEN_ISSUES/);
  checklist.openIssues=[];checklist.checks[1].evidence[0].sha256='0'.repeat(64);saveChecklist();
  assert.throws(()=>assertLocalReleaseAccepted(root), /HASH_MISMATCH/);
  checklist.checks[1].evidence[0].sha256=sha256;
  checklist.checks.push(checklist.checks[0]);saveChecklist();
  assert.throws(()=>assertLocalReleaseAccepted(root), /DOMAINS_INCOMPLETE/);
  checklist.checks.pop();receipt.acceptedAt='invalid';saveChecklist();
  assert.throws(()=>assertLocalReleaseAccepted(root), /TIME_INVALID/);
  receipt.acceptedAt=new Date().toISOString();saveChecklist();
  assert.equal(assertLocalReleaseAccepted(root).sourceVersion, second.sourceVersion, 'later deployment stages stay pending until after Git publication');
  write('.codex-evidence/fixture.json', 'tampered');
  assert.throws(() => assertLocalReleaseAccepted(root), /INCOMPLETE/);
  write('.env.local', 'TEST_ONLY=second');
  assert.throws(() => assertLocalReleaseAccepted(root), /stale/);
  write('app.js', 'initial');
  assert.equal(ensureSourceVersion(root).revision, 3, 'rollback creates a new revision, never reuses an old number');
  console.log('PASS revision idempotency, concurrent lock, rollback, local-only acceptance scope, pending domains, open issues, nested evidence tamper, duplicate domains, timestamps, later-stage independence and environment invalidation');
} finally {
  const resolved = fs.realpathSync(root);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('local-revision-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved, {recursive:true,force:true});
}
