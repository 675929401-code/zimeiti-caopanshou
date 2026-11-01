import assert from 'node:assert/strict';
import { validateRequest, validateRun, validateAutomaticTrigger, validateAcceptanceExecution } from './release-run-provenance.mjs';
const primaryRepository = 'controlled/example';
const repository = { full_name: primaryRepository, fork: false };
const sha = 'a'.repeat(40);
const candidate = { id: 12, repository, head_repository: repository, status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: sha, pull_requests: [], path: '.github/workflows/release-vnext.yml', name: 'Release vNext staged candidate', event: 'push' };
const options = { kind: 'candidate', primaryRepository, runId: '12', subjectSha: sha, toolchainSha: sha, eventCommit: sha };
const event = { action: 'completed', repository, workflow_run: candidate };
let count = 0;
function check(label, run) { run(); count++; }
function rejects(label, run) { check(label, () => assert.throws(run, /RELEASE_RUN_PROVENANCE_REJECTED/u, label)); }
check('valid automatic candidate', () => assert.equal(validateAutomaticTrigger(event, candidate, options), sha));
check('valid manual candidate', () => assert.equal(validateRun({ ...candidate, event: 'workflow_dispatch' }, options), sha));
const request = { eventName: 'push', event: { repository, ref: 'refs/heads/main' }, repository: primaryRepository, primaryRepository, ref: 'refs/heads/main', baseSha: 'b'.repeat(40), routes: '["/chat"]' };
check('explicit controlled main push', () => validateRequest(request));
for (const [label, changes] of [
 ['PR run', { event: 'pull_request' }], ['fork', { head_repository: { ...repository, fork: true } }],
 ['foreign head', { head_repository: { ...repository, full_name: 'foreign/repo' } }],
 ['foreign repo', { repository: { ...repository, full_name: 'foreign/repo' } }],
 ['non-main', { head_branch: 'feature' }], ['failure', { conclusion: 'failure' }],
 ['unfinished', { status: 'in_progress' }], ['wrong workflow', { path: '.github/workflows/other.yml' }],
 ['spoofed name', { name: 'other' }], ['PR association', { pull_requests: [{ number: 1 }] }],
 ['missing PR provenance', { pull_requests: undefined }], ['wrong ID', { id: 13 }], ['short head', { head_sha: 'abc' }],
]) rejects(label, () => validateRun({ ...candidate, ...changes }, options));
rejects('head mismatch', () => validateRun(candidate, { ...options, subjectSha: 'c'.repeat(40) }));
rejects('missing policy primary repository', () => validateRun(candidate, { ...options, primaryRepository: undefined }));
rejects('manual run cannot trigger automatic chain', () => validateAutomaticTrigger({ ...event, workflow_run: { ...candidate, event: 'workflow_dispatch' } }, { ...candidate, event: 'workflow_dispatch' }, options));
rejects('trigger ID differs', () => validateAutomaticTrigger({ ...event, workflow_run: { ...candidate, id: 99 } }, candidate, options));
rejects('trigger head differs', () => validateAutomaticTrigger({ ...event, workflow_run: { ...candidate, head_sha: 'c'.repeat(40) } }, candidate, options));
rejects('trigger is not completed', () => validateAutomaticTrigger({ ...event, action: 'requested' }, candidate, options));
rejects('checked out a different head', () => validateAutomaticTrigger(event, candidate, { ...options, toolchainSha: 'c'.repeat(40) }));
check('automatic event head drift before side effects', () => {
 let installed = false, mounted = false, secretRead = false;
 assert.throws(() => {
   validateAutomaticTrigger(event, candidate, { ...options, eventCommit: 'b'.repeat(40) });
   installed = true; mounted = true; secretRead = true;
 }, /AUTOMATIC_ACCEPTANCE_HEAD_DRIFT/u);
 assert.deepEqual([installed, mounted, secretRead], [false, false, false]);
});
const manualExecution = { eventName: 'workflow_dispatch', candidateCommit: sha, executedCommit: 'b'.repeat(40), eventCommit: 'b'.repeat(40), candidateAncestor: true, changedPaths: ['scripts/run-release-browser-acceptance.mjs', '.github/workflows/release-browser-acceptance.yml'] };
check('manual reviewed toolchain recovery', () => validateAcceptanceExecution(manualExecution));
for (const name of ['storyboard-video-captions.vtt', 'storyboard-modes-manifest.json', 'storyboard-modes-exaggerated.webp', 'storyboard-modes-cinematic.webp', 'storyboard-modes-lyrical.webp']) {
  check('reviewed browser fixture ' + name, () => validateAcceptanceExecution({ ...manualExecution, changedPaths: ['scripts/fixtures/release-browser-assets/' + name] }));
}
rejects('unreviewed browser fixture rejected', () => validateAcceptanceExecution({ ...manualExecution, changedPaths: ['scripts/fixtures/release-browser-assets/other.webp'] }));
rejects('manual runtime diff needs new candidate', () => validateAcceptanceExecution({ ...manualExecution, changedPaths: ['src/app/page.tsx'] }));
rejects('manual nonancestor candidate', () => validateAcceptanceExecution({ ...manualExecution, candidateAncestor: false }));
rejects('manual event and checkout mismatch', () => validateAcceptanceExecution({ ...manualExecution, eventCommit: sha }));
for (const [label, changes] of [
 ['missing accepted base', { baseSha: undefined }], ['short base', { baseSha: 'abc' }],
 ['missing routes variable', { routes: undefined }], ['malformed routes', { routes: '{' }],
 ['routes object', { routes: '{}' }], ['route newline', { routes: '["/chat\\nINJECT=1"]' }],
 ['push finalize', { phase: 'finalize' }], ['push branch', { ref: 'refs/heads/feature' }],
 ['missing policy', { primaryRepository: undefined }], ['wrong repo', { repository: 'foreign/repo' }],
]) rejects(label, () => validateRequest({ ...request, ...changes }));
const acceptance = { ...candidate, id: 22, event: 'workflow_run', path: '.github/workflows/release-browser-acceptance.yml', name: 'Release browser acceptance evidence' };
const acceptanceOptions = { ...options, kind: 'acceptance', runId: '22' };
check('acceptance exact toolchain', () => assert.equal(validateRun(acceptance, acceptanceOptions), sha));
rejects('acceptance different toolchain', () => validateRun(acceptance, { ...acceptanceOptions, toolchainSha: 'b'.repeat(40) }));
for (const [label, changes] of [['PR acceptance', { event: 'pull_request' }], ['fork acceptance', { head_repository: { ...repository, fork: true } }], ['non-main acceptance', { head_branch: 'feature' }], ['wrong workflow acceptance', { path: candidate.path }]]) rejects(label, () => validateRun({ ...acceptance, ...changes }, acceptanceOptions));
process.stdout.write(JSON.stringify({ ok: true, checks: count, networkAccess: false, gitWrites: false }, null, 2) + '\n');
