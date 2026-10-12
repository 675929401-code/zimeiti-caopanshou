import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/u;
const reject = (message) => { throw new Error(`RELEASE_RUN_PROVENANCE_REJECTED: ${message}`); };
export function validateRequest({ eventName, event, repository, primaryRepository, ref, phase = 'candidate', baseSha, routes }) {
  if (!primaryRepository || repository !== primaryRepository || event.repository?.full_name !== primaryRepository || event.repository?.fork !== false) reject('repository is not the policy primary repository');
  if (eventName === 'pull_request') {
    if (phase !== 'candidate') reject('PR cannot finalize');
    return;
  }
  if (!['push', 'workflow_dispatch', 'workflow_run'].includes(eventName)) reject('unsupported event');
  if (eventName !== 'workflow_run' && ref !== 'refs/heads/main') reject('main branch required');
  if (eventName === 'push' && (phase !== 'candidate' || event.ref !== 'refs/heads/main' || event.deleted === true)) reject('push is candidate-only on main');
  if (eventName === 'workflow_run' && phase !== 'candidate') reject('automatic browser evidence cannot finalize');
  if (eventName === 'push' && !shaPattern.test(baseSha || '')) reject('explicit RELEASE_BASE_SHA repository variable must be a full SHA');
  if (eventName === 'push') {
    if (!routes) reject('explicit RELEASE_ACCEPTANCE_ROUTES_JSON repository variable required');
    let parsed; try { parsed = JSON.parse(routes); } catch { reject('routes must be JSON'); }
    if (!Array.isArray(parsed) || parsed.some((route) => typeof route !== 'string' || !route.startsWith('/') || /[\r\n]/u.test(route))) reject('routes must be a reviewed path array');
  }
}
export function validateRun(run, { kind, primaryRepository, runId, subjectSha, toolchainSha, automatic = false }) {
  if (!['candidate', 'acceptance'].includes(kind)) reject('unknown run kind');
  if (!primaryRepository || run.repository?.full_name !== primaryRepository || run.repository?.fork !== false || run.head_repository?.full_name !== primaryRepository || run.head_repository?.fork !== false) reject('fork or foreign run repository');
  if (!/^[0-9]+$/u.test(String(runId)) || String(run.id) !== String(runId)) reject('run ID mismatch');
  if (run.status !== 'completed' || run.conclusion !== 'success') reject('run is not completed successfully');
  if (run.head_branch !== 'main' || !shaPattern.test(run.head_sha || '')) reject('run is not an exact main commit');
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length) reject('PR-associated or missing PR provenance');
  const candidate = kind === 'candidate';
  const workflowPath = candidate ? '.github/workflows/release-vnext.yml' : '.github/workflows/release-browser-acceptance.yml';
  const workflowName = candidate ? 'Release vNext staged candidate' : 'Release browser acceptance evidence';
  if (run.path !== workflowPath || run.name !== workflowName) reject('workflow identity mismatch');
  if (!(candidate ? ['push', 'workflow_dispatch'] : ['workflow_run', 'workflow_dispatch']).includes(run.event)) reject('untrusted event');
  if (automatic && (!candidate || run.event !== 'push')) reject('automatic evidence requires main push candidate');
  if (subjectSha && candidate && run.head_sha !== subjectSha) reject('candidate head mismatch');
  if (!candidate && run.head_sha !== toolchainSha) reject('acceptance toolchain mismatch');
  return run.head_sha;
}

export function validateAutomaticTrigger(event, candidate, options) {
  if (event.action !== 'completed') reject('workflow_run action must be completed');
  const subject = validateRun(candidate, { ...options, kind: 'candidate', automatic: true });
  const triggerSubject = validateRun(event.workflow_run || {}, { ...options, subjectSha: undefined, kind: 'candidate', automatic: true });
  if (String(event.workflow_run.id) !== String(candidate.id)) reject('trigger run identity mismatch');
  if (triggerSubject !== subject || options.toolchainSha !== subject) reject('AUTOMATIC_ACCEPTANCE_HEAD_DRIFT');
  validateAcceptanceExecution({ eventName: 'workflow_run', executedCommit: options.toolchainSha, eventCommit: options.eventCommit, candidateCommit: subject });
  return subject;
}

export const reviewedAcceptanceToolchainPaths = Object.freeze([
  '.github/workflows/release-browser-acceptance.yml', '.github/workflows/release-vnext.yml', '.release/source-files.v1.json',
  'scripts/run-release-browser-acceptance.mjs', 'scripts/release-run-provenance.mjs', 'scripts/verify-release-run-provenance.mjs',
  'scripts/verify-release-workflow.mjs', 'scripts/verify-release-change-scope-zero-network.mjs', 'scripts/fixtures/release-browser-assets/portraits.webp',
]);

export function validateAcceptanceExecution({ eventName, executedCommit, eventCommit, candidateCommit, candidateAncestor = false, changedPaths = [] }) {
  if (![executedCommit, eventCommit, candidateCommit].every(value => shaPattern.test(value || ''))) reject('acceptance commit identity missing');
  if (eventName === 'workflow_run') {
    if (executedCommit !== candidateCommit || eventCommit !== candidateCommit) reject('AUTOMATIC_ACCEPTANCE_HEAD_DRIFT');
  } else if (eventName === 'workflow_dispatch') {
    if (eventCommit !== executedCommit || !candidateAncestor || !Array.isArray(changedPaths)
      || changedPaths.some(name => !reviewedAcceptanceToolchainPaths.includes(name))) reject('candidate reuse rejected because runtime source changed');
  } else reject('unsupported acceptance execution event');
  return { executedCommit, eventCommit, candidateCommit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const policy = JSON.parse(fs.readFileSync('deploy/policies/release-policy.json', 'utf8'));
    const primaryRepository = policy.git?.primaryRepository;
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    validateRequest({ eventName: process.env.GITHUB_EVENT_NAME, event, repository: process.env.GITHUB_REPOSITORY, primaryRepository, ref: process.env.GITHUB_REF, phase: process.env.REQUESTED_PHASE || 'candidate', baseSha: process.env.CONTROLLED_BASE_SHA, routes: process.env.CONTROLLED_ROUTES });
    if (process.argv[2] !== 'request') {
      const run = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
      const subject = validateRun(run, { kind: process.argv[2], primaryRepository, runId: process.env.PROVENANCE_RUN_ID, subjectSha: process.env.PROVENANCE_SUBJECT_SHA, toolchainSha: process.env.RELEASE_TOOLCHAIN_SHA, automatic: process.env.GITHUB_EVENT_NAME === 'workflow_run' });
      if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
        validateAutomaticTrigger(event, run, { primaryRepository, runId: process.env.PROVENANCE_RUN_ID, toolchainSha: process.env.RELEASE_TOOLCHAIN_SHA, eventCommit: process.env.GITHUB_SHA });
      } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.argv[2] === 'candidate') {
        const executeGit = args => {
          const result = spawnSync('git', args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
          if (result.status !== 0 || result.error) reject('candidate ancestry or diff observation failed');
          return result.stdout;
        };
        const executedCommit = executeGit(['rev-parse', 'HEAD']).trim();
        executeGit(['merge-base', '--is-ancestor', subject, executedCommit]);
        const changedPaths = executeGit(['diff', '--name-only', '-z', `${subject}..${executedCommit}`]).split('\0').filter(Boolean);
        validateAcceptanceExecution({ eventName: 'workflow_dispatch', executedCommit, eventCommit: process.env.GITHUB_SHA, candidateCommit: subject, candidateAncestor: true, changedPaths });
      }
      process.stdout.write(`${subject}\n`);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
