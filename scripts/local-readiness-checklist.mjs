import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Only local release criteria belong here. Git, candidate deployment and the
// public-domain acceptance happen later and must not create a circular gate.
export const LOCAL_READINESS_DOMAINS = Object.freeze([
  'source-runtime', 'digital-human', 'voice-studio', 'video-storyboard',
  'models-and-routing', 'chat-images-cover', 'toolbox-manju-admin',
  'accounts-billing', 'storage-history', 'ux-navigation',
  'concurrency-workers', 'security-recovery',
]);

export function verifiedEvidenceFile(root, check) {
  if (typeof check?.evidence !== 'string' || !check.evidence.startsWith('.codex-evidence/')
    || !/^[a-f0-9]{64}$/.test(check.sha256 || '')) throw new Error('EVIDENCE_PATH_INVALID');
  const evidenceRoot = fs.realpathSync(path.resolve(root, '.codex-evidence'));
  const target = fs.realpathSync(path.resolve(root, check.evidence));
  const inside = path.relative(evidenceRoot, target);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
    || !fs.statSync(target).isFile()) throw new Error('EVIDENCE_PATH_INVALID');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (hash !== check.sha256) throw new Error('EVIDENCE_HASH_MISMATCH');
  return target;
}

export function assertLocalReadinessChecklist(root, checklist, identity) {
  if (checklist?.schemaVersion !== 1 || checklist.stage !== 'local-release'
    || checklist.sourceVersion !== identity.sourceVersion || checklist.buildId !== identity.buildId) {
    throw new Error('LOCAL_READINESS_SCOPE_OR_VERSION_MISMATCH');
  }
  if (!Array.isArray(checklist.checks) || checklist.checks.length !== LOCAL_READINESS_DOMAINS.length
    || new Set(checklist.checks.map(item => item.id)).size !== LOCAL_READINESS_DOMAINS.length) {
    throw new Error('LOCAL_READINESS_DOMAINS_INCOMPLETE');
  }
  for (const id of LOCAL_READINESS_DOMAINS) {
    const check = checklist.checks.find(item => item.id === id);
    if (!check || check.status !== 'passed' || !Array.isArray(check.evidence) || !check.evidence.length) {
      throw new Error(`LOCAL_READINESS_PENDING: ${id}`);
    }
    for (const reference of check.evidence) verifiedEvidenceFile(root, reference);
  }
  if (!Array.isArray(checklist.openIssues) || checklist.openIssues.length) {
    throw new Error('LOCAL_READINESS_OPEN_ISSUES: finish recorded local release issues first');
  }
}
