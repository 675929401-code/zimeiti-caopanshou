import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeLocalBuildFingerprint, verifyLocalBuildFingerprintReceipt } from './local-build-fingerprint.mjs';
import { assertLocalReadinessChecklist, verifiedEvidenceFile } from './local-readiness-checklist.mjs';

const VERSION_PATH = 'public/version.json';
const ACCEPTANCE_PATH = '.codex-evidence/local-release-acceptance.v1.json';
const OMIT_IDENTITY = [VERSION_PATH, '.release/source-files.v1.json', '.release/source-repo.json', '.env', '.env.local', '.env.production', '.env.production.local'];
const requiredChecks = ['types', 'changed-flow', 'related-pages', 'console', 'release-checklist'];
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function currentSourceVersion(root = process.cwd()) {
  const value = readJson(path.join(root, VERSION_PATH));
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !/^R\d{6,}-\d{8}-[a-f0-9]{8}$/.test(value.sourceVersion || '') || !/^[a-f0-9]{64}$/.test(value.sourceDigest || '')) {
    throw new Error('SOURCE_VERSION_MISSING: run node scripts/local-revision.mjs update');
  }
  const source = computeLocalBuildFingerprint(root, { omitFiles: OMIT_IDENTITY });
  if (source.fingerprint !== value.sourceDigest) throw new Error('SOURCE_VERSION_STALE: source changed; update version and rebuild');
  return value;
}

export function ensureSourceVersion(rootInput = process.cwd()) {
  const root = path.resolve(rootInput);
  const lock = path.join(root, '.codex-version.lock');
  // A concurrent editor/build must finish first; never silently clear another process's lock.
  const fd = fs.openSync(lock, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const file = path.join(root, VERSION_PATH);
    const old = fs.existsSync(file) ? readJson(file) : {};
    if (old.schemaVersion !== undefined && (old.schemaVersion !== 1 || !Number.isSafeInteger(old.revision) || old.revision < 1)) {
      throw new Error('INVALID_REVISION: restore the last complete version record before continuing');
    }
    const source = computeLocalBuildFingerprint(root, { omitFiles: OMIT_IDENTITY });
    if (old.schemaVersion === 1 && old.sourceDigest === source.fingerprint) return currentSourceVersion(root);
    const revision = (old.revision || 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('REVISION_OVERFLOW');
    const timestamp = new Date().toISOString();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
    const sourceVersion = `R${String(revision).padStart(6, '0')}-${date}-${source.fingerprint.slice(0, 8)}`;
    const value = { schemaVersion: 1, sourceVersion, revision, sourceDigest: source.fingerprint, version: sourceVersion, hash: sourceVersion, timestamp };
    if (fs.existsSync(file)) {
      const backup = path.join(root, '.codex-backups/version-history');
      fs.mkdirSync(backup, { recursive: true });
      fs.copyFileSync(file, path.join(backup, `${revision}-${crypto.randomUUID()}.json`), fs.constants.COPYFILE_EXCL);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = path.join(root, `.codex-version-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return value;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export function assertLocalReleaseAccepted(rootInput = process.cwd()) {
  const root = path.resolve(rootInput);
  const version = currentSourceVersion(root);
  const build = verifyLocalBuildFingerprintReceipt(root, '.next/local-source-fingerprint.v1.json');
  const file = path.join(root, ACCEPTANCE_PATH);
  if (!fs.existsSync(file)) throw new Error('LOCAL_ACCEPTANCE_MISSING: finish local release acceptance before syncing the release repository');
  const receipt = readJson(file);
  if (receipt.schemaVersion !== 1 || receipt.scope !== 'release' || receipt.sourceVersion !== version.sourceVersion
    || receipt.fingerprint !== build.fingerprint || receipt.buildId !== build.buildId) throw new Error('LOCAL_ACCEPTANCE_STALE');
  if (!Number.isFinite(Date.parse(receipt.acceptedAt)) || Date.parse(receipt.acceptedAt) > Date.now() + 60000) {
    throw new Error('LOCAL_ACCEPTANCE_TIME_INVALID');
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== requiredChecks.length
    || new Set(receipt.checks.map(item => item.id)).size !== requiredChecks.length) {
    throw new Error('LOCAL_ACCEPTANCE_CHECKS_INVALID');
  }
  for (const id of requiredChecks) {
    const check = receipt.checks?.find((item) => item.id === id);
    if (!check || check.passed !== true) throw new Error(`LOCAL_ACCEPTANCE_INCOMPLETE: ${id}`);
    let evidence;
    try { evidence = verifiedEvidenceFile(root, check); }
    catch { throw new Error(`LOCAL_ACCEPTANCE_INCOMPLETE: ${id}`); }
    if (id === 'release-checklist') {
      assertLocalReadinessChecklist(root, readJson(evidence), { sourceVersion: version.sourceVersion, buildId: build.buildId });
    }
  }
  return { sourceVersion: version.sourceVersion, buildId: build.buildId, acceptedAt: receipt.acceptedAt };
}

// No "accept all" switch: an operator must supply actual, hashed test evidence.
// A scoped regression is useful evidence but cannot mark the complete release accepted.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(process.argv[3] || process.cwd());
    const action = process.argv[2] || 'status';
    if (!['update', 'status', 'gate'].includes(action)) throw new Error('Expected update, status, or gate');
    console.log(JSON.stringify(action === 'update' ? ensureSourceVersion(root) : action === 'gate' ? assertLocalReleaseAccepted(root) : currentSourceVersion(root), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
