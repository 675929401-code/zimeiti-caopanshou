import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { assertStudentIdentity, assessRestoration, assessWorkspaceReadback, resolveWorkspaceCatalogConsumers } from './verify-admin-model-closed-loop-local.mjs';

const checks = [];
const fixtureId = 'fixture-ordinary-student';
assertStudentIdentity({ role: 'student', id: fixtureId }, { user: { role: 'student', id: fixtureId } }, fixtureId);
for (const [wrapper, actual, id] of [
  [{ role: 'admin', id: fixtureId }, { user: { role: 'student', id: fixtureId } }, fixtureId],
  [{ role: 'student', id: fixtureId }, { user: { role: 'admin', id: fixtureId } }, fixtureId],
  [{ role: 'student', id: fixtureId }, { user: { role: 'student', id: 'other' } }, fixtureId],
  [{ role: 'student', id: fixtureId }, {}, fixtureId],
  [{ role: 'student', id: fixtureId }, { user: { role: 'student', id: fixtureId } }, ''],
]) assert.throws(() => assertStudentIdentity(wrapper, actual, id));
checks.push('exact-student-role-and-explicit-id-must-match-real-auth-me');

assert.equal(assessRestoration({ physicalRestored: true, operationReconciled: false, workspaceRestored: true, runtimeRestored: true }).recoveryRequired, true);
assert.equal(assessRestoration({ physicalRestored: true, operationReconciled: true, workspaceRestored: true, runtimeRestored: false }).recoveryRequired, true);
assert.equal(assessRestoration({ physicalRestored: true, operationReconciled: true, workspaceRestored: true, runtimeRestored: true }).recoveryRequired, false);
checks.push('physical-restore-never-implies-unknown-operation-reconciled');

const workspace = { id: 'workspace-1', snapshot: { modelPoolRelease: { releaseId: 'old-pool', snapshotSha256: 'old-hash' }, surfaces: {} } };
const projections = [{ setting_key: 'actual-setting-fixture', setting_value: { assignment: true } }];
const pool = { id: 'restored-new-pool', snapshot_sha256: 'old-hash' };
const historical = assessWorkspaceReadback(workspace, structuredClone(workspace), projections, structuredClone(projections), pool);
assert.equal(historical.workspaceRestored, true); assert.equal(historical.dependencyIdentityHistorical, true);
assert.equal(assessWorkspaceReadback(workspace, { ...workspace, id: 'other' }, projections, projections, pool).workspaceRestored, false);
assert.equal(assessWorkspaceReadback(workspace, workspace, projections, [], pool).workspaceRestored, false);
checks.push('historical-workspace-dependency-recorded-without-fake-rebase-or-failure');
checks.push('workspace-identity-snapshot-and-real-projected-settings-must-remain-exact');

let networkAttempts = 0; const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkAttempts++; throw new Error('REAL_NETWORK_FORBIDDEN'); };
const consumers = await resolveWorkspaceCatalogConsumers();
globalThis.fetch = originalFetch;
assert.equal(networkAttempts, 0); assert.equal(consumers.length, 7);
assert.equal(new Set(consumers.map(row => row.surface)).size, 7);
assert.ok(consumers.every(row => row.path.startsWith('/api/cover-models?surface=') || row.path.startsWith('/api/video/models?surface=')));
assert.ok(consumers.every(row => /^[a-f0-9]{64}$/u.test(row.sourceSha256)));
checks.push('seven-surfaces-derived-from-formal-policy-and-actual-consumer-urls');

const file = 'scripts/verify-admin-model-closed-loop-local.mjs'; const source = await fs.readFile(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let identityFunction;
function find(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'readCanonicalLocalIdentity') identityFunction = node; ts.forEachChild(node, find); }
find(ast); assert.ok(identityFunction);
const statements = [];
class FixtureClient {
  async connect() { statements.push('CONNECT'); }
  async end() { statements.push('END'); }
  async query(sql) {
    statements.push(sql);
    if (sql === 'show transaction_read_only') return { rows: [{ transaction_read_only: 'on' }] };
    if (sql.includes('pg_control_system')) return { rows: [{ value: 'fixture-actual-cluster' }] };
    if (sql.includes('platform_settings')) return { rows: projections };
    return { rows: [] };
  }
}
const context = vm.createContext({ pg: { Client: FixtureClient }, process: { env: { DATABASE_URL: 'fixture-not-a-real-url' } }, assert,
  canonicalDatabaseFingerprint: 'fixture-reviewed-fingerprint',
  readDatabaseTargetIdentity: async () => ({ fingerprint: 'fixture-reviewed-fingerprint', databaseName: 'zimeiti_local' }),
  tsImport: async () => ({ WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY: 'assign', WORKSPACE_MODEL_CANDIDATE_BLOCKS_SETTING_KEY: 'blocked', IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY: 'images', VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY: 'videos' }),
});
// The actual module URL is only the loader anchor; the fixture loader never reads configuration.
vm.runInContext(identityFunction.getText(ast).replace(/^export\s+/u, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url)) + '\nglobalThis.readIdentity=readCanonicalLocalIdentity;', context);
const proof = await context.readIdentity();
assert.equal(proof.cluster, 'fixture-actual-cluster'); assert.equal(proof.workspaceProjection, projections);
assert.ok(statements.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
assert.ok(statements.includes('ROLLBACK')); assert.equal(statements.at(-1), 'END');
context.readDatabaseTargetIdentity = async () => ({ fingerprint: 'other-database' });
await assert.rejects(context.readIdentity(), /CANONICAL_LOCAL_DATABASE_FINGERPRINT_REQUIRED/u);
assert.equal(statements.at(-2), 'ROLLBACK'); assert.equal(statements.at(-1), 'END');
checks.push('actual-identity-helper-uses-read-only-pg-and-rolls-back-success-or-mismatch');
assert.match(source, /computeLocalBuildFingerprint\(process\.cwd\(\)\)/u);
assert.match(source, /assert\.equal\(runningLatest, true/u);
assert.match(source, /assert\.deepEqual\(runtimeAfter, baselineRuntime/u);
assert.match(source, /assert\.deepEqual\(databaseAfter, baselineDatabase/u);
assert.match(source, /unknownPhase === 'stage'[\s\S]*?readPlatform|unknownPhase === 'stage'[\s\S]*?requestId=/u);
assert.match(source, /'Idempotency-Key': mutationRequestId/u);
assert.match(source, /NO_PROVIDER_CREDENTIAL_OR_OTHER_BUSINESS_WRITES/u);
checks.push('current-build-before-after-stable-idempotency-and-readonly-receipt-reconciliation-guards');
const output = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/models/closed-loop-review';
await fs.mkdir(output, { recursive: true });
const report = { passed: true, checks, consumers, mainInvocations: 0, realNetworkCalls: 0, realDatabaseConnections: 0, businessWrites: 0, providerCalls: 0 };
await fs.writeFile(`${output}/zero-network.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
