#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { tsImport } from 'tsx/esm/api';
import { readDatabaseTargetIdentity } from './lib/database-target-identity.mjs';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

// REVIEW BEFORE EXECUTION. Default mode is read-only planning.
// Expected wrappers (root alone may authorize the final --execute invocation):
// with-local-admin-session -> with-local-admin-step-up-session ->
// with-local-customer-session -> this script.
// This is a reversible inactive TEXT MODEL SORT test, not provider acceptance
// or proof that a newly added/activated model can generate successfully.
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const sha = /^[a-f0-9]{64}$/u;
const canonicalDatabaseFingerprint = 'f182534099e8496efcf791f5ff09470500b0d3d320ad801992056f183a32ca35';
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const argument = (args, name) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const rowIdentity = row => ({ id: row?.id, version: row?.release_version, sha256: row?.snapshot_sha256 });
const stableModels = rows => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(row => {
  const copy = { ...row };
  for (const key of ['updated_at', 'validation', 'usage_count', 'total_tokens_used']) delete copy[key];
  assert.equal('api_key' in copy, false, 'ADMIN_RESPONSE_MUST_NOT_INCLUDE_SECRET');
  return copy;
});

export function assertStudentIdentity(wrapperIdentity, actualIdentity, expectedUserId) {
  assert.ok(typeof expectedUserId === 'string' && expectedUserId.trim(), 'EXPLICIT_ORDINARY_USER_ID_REQUIRED');
  assert.equal(wrapperIdentity?.role, 'student', 'WRAPPER_STUDENT_ROLE_REQUIRED');
  assert.equal(wrapperIdentity?.id, expectedUserId, 'WRAPPER_ORDINARY_USER_ID_MISMATCH');
  assert.equal(actualIdentity?.user?.role, 'student', 'REAL_AUTH_ME_STUDENT_ROLE_REQUIRED');
  assert.equal(String(actualIdentity?.user?.id || ''), expectedUserId, 'REAL_AUTH_ME_ORDINARY_USER_ID_MISMATCH');
}

export function assessRestoration({ physicalRestored, operationReconciled, workspaceRestored, runtimeRestored }) {
  return { physicalRestored, operationReconciled, workspaceRestored, runtimeRestored,
    recoveryRequired: !physicalRestored || !operationReconciled || !workspaceRestored || !runtimeRestored };
}

export function assessWorkspaceReadback(beforeWorkspace, afterWorkspace, beforeProjection, afterProjection, currentPool) {
  const sameWorkspace = canonical(beforeWorkspace) === canonical(afterWorkspace);
  const sameProjection = canonical(beforeProjection) === canonical(afterProjection);
  const dependency = afterWorkspace?.snapshot?.modelPoolRelease;
  return { workspaceRestored: sameWorkspace && sameProjection, workspaceIdentityAndSnapshotUnchanged: sameWorkspace,
    projectedSettingsUnchanged: sameProjection,
    dependencyIdentityHistorical: !!dependency && (dependency.releaseId !== currentPool?.id || dependency.snapshotSha256 !== currentPool?.snapshot_sha256),
    dependencyPolicy: 'historical identity is provenance; runtime uses unchanged projected assignment/order settings; no automatic workspace publication' };
}

export async function resolveWorkspaceCatalogConsumers() {
  const policy = await tsImport('../src/lib/workspace-model-policy.ts', import.meta.url);
  const consumers = ['src/components/cover-studio.tsx', 'src/components/storyboard-workbench.tsx', 'src/components/free-canvas-shell.tsx', 'src/app/video/page.tsx'];
  const found = new Map();
  for (const file of consumers) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/["'](\/api\/(?:cover-models|video\/models)\?surface=[a-z-]+)["']/gu)) {
      const url = new URL(match[1], 'http://127.0.0.1:5000');
      const surface = (url.pathname === '/api/cover-models' ? policy.imageWorkspaceSurfaceFromRequest : policy.videoWorkspaceSurfaceFromRequest)(url.searchParams.get('surface'));
      const definition = policy.WORKSPACE_MODEL_SURFACES.find(row => row.id === surface);
      assert.ok(definition, 'ACTUAL_CONSUMER_SURFACE_MUST_EXIST_IN_FORMAL_POLICY');
      found.set(surface, { surface, kind: definition.kind, path: match[1], source: file, sourceSha256: crypto.createHash('sha256').update(source).digest('hex') });
    }
  }
  assert.equal(found.size, 7, 'SEVEN_NONEXCLUDED_ACTUAL_WORKSPACE_CONSUMERS_REQUIRED');
  return [...found.values()].sort((a, b) => a.surface.localeCompare(b.surface));
}

export async function readCanonicalLocalIdentity() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 10_000, statement_timeout: 15_000, application_name: 'codex-model-closed-loop-readonly-identity' });
  let transaction = false;
  try {
    await client.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    assert.equal((await client.query('show transaction_read_only')).rows[0]?.transaction_read_only, 'on');
    const identity = await readDatabaseTargetIdentity(client, '127.0.0.1');
    assert.equal(identity.fingerprint, canonicalDatabaseFingerprint, 'CANONICAL_LOCAL_DATABASE_FINGERPRINT_REQUIRED');
    const cluster = (await client.query('select system_identifier::text value from pg_control_system()')).rows[0]?.value;
    assert.ok(cluster, 'ACTUAL_DATABASE_CLUSTER_REQUIRED');
    const assignment = await tsImport('../src/lib/workspace-model-assignment-settings.ts', import.meta.url);
    const imageOrder = await tsImport('../src/lib/image-model-surface-order.ts', import.meta.url);
    const videoOrder = await tsImport('../src/lib/video-model-surface-order.ts', import.meta.url);
    const projectedSettingKeys = [assignment.WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY, assignment.WORKSPACE_MODEL_CANDIDATE_BLOCKS_SETTING_KEY, imageOrder.IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY, videoOrder.VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY];
    const workspaceProjection = (await client.query('select setting_key,setting_value from public.platform_settings where setting_key=any($1::text[]) order by setting_key', [projectedSettingKeys])).rows;
    return { identity, cluster, workspaceProjection, projectedSettingKeys };
  } finally { if (transaction) await client.query('ROLLBACK'); await client.end(); }
}

export async function readCurrentLocalBuild(origin) {
  const response = await fetch(`${origin}/api/version`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, 'ACTUAL_RUNTIME_VERSION_REQUIRED'); const actual = await response.json();
  const [version, buildId, receipt] = await Promise.all([fs.readFile('public/version.json', 'utf8').then(JSON.parse), fs.readFile('.next/BUILD_ID', 'utf8').then(value => value.trim()), fs.readFile('.next/local-source-fingerprint.v1.json', 'utf8').then(JSON.parse)]);
  const fingerprint = computeLocalBuildFingerprint(process.cwd());
  const runningLatest = actual.sourceVersion === version.sourceVersion && actual.buildId === buildId && receipt.buildId === buildId
    && receipt.fingerprint === fingerprint.fingerprint && receipt.fileCount === fingerprint.fileCount;
  assert.equal(runningLatest, true, 'RUNNING_LATEST_REQUIRED');
  return { sourceVersion: actual.sourceVersion, buildId, sourceFingerprint: fingerprint.fingerprint, fileCount: fingerprint.fileCount, runningLatest };
}

export async function main(args = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/+$/u, '');
  assert.equal(origin, 'http://127.0.0.1:5000', 'EXACT_LOCAL_PREVIEW_REQUIRED');
  const localDb = new URL(String(process.env.DATABASE_URL || ''));
  assert.equal(localDb.hostname, '127.0.0.1'); assert.equal(localDb.port, '54322'); assert.equal(localDb.pathname, '/zimeiti_local');
  const adminToken = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const stepUp = process.env.LOCAL_ADMIN_STEP_UP_TOKEN;
  const customerToken = process.env.R267_CUSTOMER_TOKEN;
  const customer = JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER || '{}');
  assert.ok(adminToken && stepUp && customerToken, 'ADMIN_STEPUP_AND_ORDINARY_SESSION_WRAPPERS_REQUIRED');
  const expectedUserId = argument(args, 'user-id');
  assert.ok(expectedUserId && customer.role === 'student' && customer.id === expectedUserId, 'EXPLICIT_WRAPPER_STUDENT_ID_REQUIRED');
  const execute = args.includes('--execute');
  if (execute) assert.equal(process.env.MODEL_CLOSED_LOOP_ROOT_AUTHORIZED, '1', 'ROOT_REVIEW_AND_EXECUTION_AUTHORIZATION_REQUIRED');
  const runId = crypto.randomUUID();
  const output = path.resolve(argument(args, 'output') || `.codex-evidence/admin-full-acceptance-20261030-9592a6d0/models/local-closed-loop-${runId}`);
  const relativeOutput = path.relative(path.resolve('.codex-evidence'), output);
  assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), 'OUTPUT_MUST_BE_UNIQUE_EVIDENCE_SUBDIRECTORY');
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
  const events = [];
  const owned = new Set();
  let unknownWrite = false;
  let mutationStarted = false;
  let physicalRestored = false; let operationReconciled = true; let workspaceRestored = false; let runtimeRestored = false;
  const mutationRequestId = crypto.randomUUID();
  let unknownPhase = ''; let operationCandidateId = '';
  const record = async () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ runId, mode: execute ? 'execute' : 'read-only-plan', events, ownedCandidates: [...owned], mutationRequestId, unknownWrite, unknownPhase, mutationStarted,
    ...assessRestoration({ physicalRestored, operationReconciled, workspaceRestored, runtimeRestored }),
    recoveryRequired: execute && mutationStarted && assessRestoration({ physicalRestored, operationReconciled, workspaceRestored, runtimeRestored }).recoveryRequired,
    providerCalls: 0, billingCalls: 0,
    proofBoundary: 'inactive text-model sort staging/publication and ordinary catalog preservation only; no added-model provider or billing proof' }, null, 2));
  const request = async (pathname, { method = 'GET', body, ordinary = false } = {}) => {
    assert.ok(pathname.startsWith('/api/'), 'RELATIVE_API_ONLY');
    const allowedReads = ['/api/admin/model-pool-releases', '/api/admin/workspace-model-releases', '/api/admin/models', '/api/chat-models', '/api/llm-models', '/api/cover-models', '/api/video/models', '/api/auth/me'];
    assert.ok(allowedReads.includes(pathname.split('?')[0]), 'UNEXPECTED_ROUTE');
    if (method !== 'GET') {
      assert.ok(execute && !ordinary && !unknownWrite, 'MUTATION_GUARD');
      assert.ok((pathname === '/api/admin/models' && method === 'PATCH') || (pathname === '/api/admin/model-pool-releases' && method === 'POST'), 'NO_PROVIDER_CREDENTIAL_OR_OTHER_BUSINESS_WRITES');
      if (body?.action === 'publish' || body?.action === 'validate') assert.ok(owned.has(body.releaseId), 'ONLY_THIS_RUN_CANDIDATE_ALLOWED');
      mutationStarted = true;
    }
    try {
      const response = await fetch(`${origin}${pathname}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${ordinary ? customerToken : adminToken}`, ...(!ordinary ? { 'x-admin-step-up': stepUp } : {}), ...(method === 'PATCH' ? { 'Idempotency-Key': mutationRequestId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      const result = await response.json();
      events.push({ method, pathname: pathname.split('?')[0], status: response.status, action: body?.action || null });
      if (!response.ok) {
        // A write can commit before an application/readback failure. Never retry.
        if (method !== 'GET' && (response.status >= 500 || /READBACK|UNKNOWN/u.test(String(result.code || '')))) { unknownWrite = true; operationReconciled = false; unknownPhase = method === 'PATCH' ? 'stage' : body?.action || 'write'; }
        throw new Error(`HTTP_${response.status}_${String(result.code || 'REJECTED')}`);
      }
      return result;
    } catch (error) {
      // Explicit HTTP rejection is known; transport/JSON loss after a write is unknown.
      if (method !== 'GET' && !/^HTTP_/u.test(String(error?.message || ''))) { unknownWrite = true; operationReconciled = false; unknownPhase = method === 'PATCH' ? 'stage' : body?.action || 'write'; }
      throw error;
    } finally { await record(); }
  };
  const overview = () => request('/api/admin/model-pool-releases');
  const currentIs = async (id, expectedSnapshot) => {
    const state = await overview();
    assert.equal(state.current?.id, id, 'CURRENT_RELEASE_CHANGED');
    assert.equal(canonical(state.current?.snapshot), canonical(expectedSnapshot), 'CURRENT_SNAPSHOT_MISMATCH');
    return state;
  };
  const surfaceConsumers = await resolveWorkspaceCatalogConsumers();
  const readCatalogs = async () => {
    const result = { chat: await request('/api/chat-models', { ordinary: true }), llm: await request('/api/llm-models', { ordinary: true }), surfaces: {} };
    for (const consumer of surfaceConsumers) result.surfaces[consumer.surface] = await request(consumer.path, { ordinary: true });
    return result;
  };
  const workspaceOverview = () => request('/api/admin/workspace-model-releases');
  const workspaceIdentity = row => row ? { ...rowIdentity(row), snapshot: row.snapshot } : null;
  const workspaceDependency = (workspace, pool) => !workspace?.snapshot?.modelPoolRelease
    || (workspace.snapshot.modelPoolRelease.releaseId === pool?.id && workspace.snapshot.modelPoolRelease.snapshotSha256 === pool?.snapshot_sha256);
  const ownRelease = (result, phase = 'stage') => {
    const row = result?.release;
    if (!uuid.test(String(row?.id || ''))) { unknownWrite = true; operationReconciled = false; unknownPhase = phase; throw new Error('MISSING_CANDIDATE_RECEIPT_DO_NOT_RETRY'); }
    assert.ok(!baselineIds.has(row.id), 'EXISTING_CANDIDATE_MUST_NOT_BE_USED');
    owned.add(row.id); return row;
  };
  const validatePreviewPublish = async (row, expectedCurrent, expectedSnapshot) => {
    await currentIs(expectedCurrent.id, expectedCurrent.snapshot);
    await request('/api/admin/model-pool-releases', { method: 'POST', body: { action: 'validate', releaseId: row.id } });
    const { preview } = await request(`/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(row.id)}`);
    assert.equal(preview?.current?.releaseId, expectedCurrent.id);
    assert.equal(preview?.candidate?.releaseId, row.id);
    assert.ok(sha.test(String(preview?.previewSha256 || '')));
    const fresh = await currentIs(expectedCurrent.id, expectedCurrent.snapshot);
    const candidate = fresh.releases.find(entry => entry.id === row.id);
    assert.equal(canonical(candidate?.snapshot), canonical(expectedSnapshot), 'CANDIDATE_MUST_CONTAIN_ONLY_EXPECTED_SORT_CHANGE');
    assert.equal(candidate?.snapshot_sha256, preview.candidate.snapshotSha256);
    await request('/api/admin/model-pool-releases', { method: 'POST', body: { action: 'publish', releaseId: row.id, previewSha256: preview.previewSha256 } });
    return (await currentIs(row.id, expectedSnapshot)).current;
  };
  let baseline; let baselineIds; let baselinePhysical; let baselinePublic; let changedSnapshot; let published; let baselineWorkspace; let baselineDatabase; let baselineRuntime;
  try {
    baselineDatabase = await readCanonicalLocalIdentity(); baselineRuntime = await readCurrentLocalBuild(origin);
    assertStudentIdentity(customer, await request('/api/auth/me', { ordinary: true }), expectedUserId);
    const state = await overview();
    assert.equal(state.runtimeEnforcement?.ready, true, 'DATABASE_PUBLICATION_GATES_REQUIRED');
    baseline = state.current;
    assert.ok(uuid.test(String(baseline?.id || '')) && sha.test(String(baseline?.snapshot_sha256 || '')) && Array.isArray(baseline?.snapshot?.models), 'VALID_PUBLISHED_BASELINE_REQUIRED');
    baselineIds = new Set(state.releases.map(row => row.id));
    baselinePhysical = stableModels((await request('/api/admin/models')).models || []);
    baselinePublic = await readCatalogs();
    await fs.writeFile(path.join(output, 'ordinary-catalogs.before.json'), JSON.stringify(baselinePublic, null, 2));
    baselineWorkspace = (await workspaceOverview()).current;
    const modelId = argument(args, 'model-id');
    assert.ok(modelId, 'EXPLICIT_REVIEWED_INACTIVE_TEXT_MODEL_ID_REQUIRED');
    const physical = baselinePhysical.find(row => row.id === modelId && row.model_type === 'text' && row.is_active === false);
    assert.ok(physical, 'ONLY_EXISTING_INACTIVE_TEXT_MODEL_SORT_ALLOWED');
    const selected = baseline.snapshot.models.find(row => row.kind === 'agent' && String(row.configuration?.legacyId || '') === modelId);
    assert.ok(selected, 'INACTIVE_MODEL_MUST_EXIST_IN_CURRENT_POOL');
    const selectedPublic = JSON.stringify(baselinePublic);
    assert.equal(selectedPublic.includes(JSON.stringify(modelId)), false, 'INACTIVE_MODEL_MUST_NOT_BE_EXPOSED');
    assert.equal(Number(physical.sort_order), Number(selected.sortOrder), 'PHYSICAL_AND_PUBLISHED_SORT_BASELINE_MUST_AGREE');
    const newOrder = Math.max(...baseline.snapshot.models.map(row => Number(row.sortOrder))) + 1;
    assert.ok(Number.isSafeInteger(newOrder) && newOrder <= 2_000_000_000);
    changedSnapshot = structuredClone(baseline.snapshot);
    changedSnapshot.models.find(row => row.id === selected.id).sortOrder = newOrder;
    // Save only immutable snapshots and safe hashes. Never dump admin rows or credentials.
    await fs.writeFile(path.join(output, 'baseline.json'), JSON.stringify({ baseline: rowIdentity(baseline), snapshot: baseline.snapshot, workspace: workspaceIdentity(baselineWorkspace), workspaceDependencyCurrent: workspaceDependency(baselineWorkspace, baseline),
      database: baselineDatabase, runtime: baselineRuntime, ordinaryUser: { id: expectedUserId, role: 'student' }, surfaceConsumers,
      oldCandidates: state.releases.map(rowIdentity), physicalHash: digest(baselinePhysical), ordinaryCatalogHash: digest(baselinePublic), target: { modelId, poolId: selected.id, beforeOrder: selected.sortOrder, afterOrder: newOrder } }, null, 2));
    if (!execute) { events.push({ plan: 'review required; no writes performed', baseline: rowIdentity(baseline), modelId, expectedMutation: 'one inactive text model sortOrder', restore: 'new rollback candidate targeting exact baseline, validate, preview, atomic publish, full snapshot and physical/public readback',
      workspaceDependencyRisk: !!baselineWorkspace, workspaceWritesAuthorized: false, warning: baselineWorkspace ? 'Pool publication and rollback create new release identities. A historical workspace dependency is recorded as provenance, while exact workspace identity/snapshot, projected assignment/order settings and seven ordinary surface catalogs must remain unchanged.' : null }); await record(); return; }
    assert.equal(argument(args, 'baseline-release'), baseline.id, 'REVIEWED_BASELINE_ID_REQUIRED');
    assert.equal(argument(args, 'baseline-sha'), baseline.snapshot_sha256, 'REVIEWED_BASELINE_SHA_REQUIRED');
    const staged = await request('/api/admin/models', { method: 'PATCH', body: { model_type: 'text', orders: [{ id: modelId, sort_order: newOrder }] } });
    if (staged.staged !== true || staged.published !== false) { unknownWrite = true; operationReconciled = false; unknownPhase = 'stage'; throw new Error('STAGING_RECEIPT_INVALID_DO_NOT_RETRY'); }
    const candidate = ownRelease(staged.result);
    operationCandidateId = candidate.id;
    published = await validatePreviewPublish(candidate, baseline, changedSnapshot);
    const workspaceDuring = (await workspaceOverview()).current;
    events.push({ phase: 'pool-published-workspace-observation', workspace: workspaceIdentity(workspaceDuring), dependencyCurrent: workspaceDependency(workspaceDuring, published), workspaceMutationPerformed: false });
    const after = stableModels((await request('/api/admin/models')).models || []);
    const expected = structuredClone(baselinePhysical); expected.find(row => row.id === modelId).sort_order = newOrder;
    assert.equal(canonical(after), canonical(expected), 'ONLY_REVIEWED_SORT_MAY_CHANGE_PHYSICALLY');
    const catalogsAfter = await readCatalogs();
    await fs.writeFile(path.join(output, 'ordinary-catalogs.after.json'), JSON.stringify(catalogsAfter, null, 2));
    assert.equal(canonical(catalogsAfter), canonical(baselinePublic), 'INACTIVE_SORT_MUST_NOT_CHANGE_ORDINARY_CATALOG');
  } finally {
    let recoveryError = null;
    // Restore only when fresh current identity is exactly our candidate. A lost
    // publish response is resolved by a READ; no write is blindly replayed.
    if (execute && mutationStarted && baseline) {
      try {
        const fresh = await overview();
        if (fresh.current?.id === baseline.id) {
          assert.equal(canonical(fresh.current.snapshot), canonical(baseline.snapshot));
        } else if (owned.has(fresh.current?.id) && canonical(fresh.current?.snapshot) === canonical(changedSnapshot)) {
          published = fresh.current;
          // Unknown operation has now been resolved by exact immutable identity.
          if (unknownPhase === 'publish') { unknownWrite = false; operationReconciled = true; unknownPhase = ''; }
          const rollback = ownRelease(await request('/api/admin/model-pool-releases', { method: 'POST', body: { action: 'rollback', targetId: baseline.id, changeNote: `local-closed-loop-${runId}:restore-exact-baseline` } }), 'rollback');
          await validatePreviewPublish(rollback, published, baseline.snapshot);
        } else throw new Error('CONCURRENT_OR_UNKNOWN_CURRENT_NO_AUTOMATIC_RESTORE');
        assert.equal(canonical(stableModels((await request('/api/admin/models')).models || [])), canonical(baselinePhysical), 'EXACT_PHYSICAL_RESTORE_REQUIRED');
        const catalogsRestored = await readCatalogs();
        await fs.writeFile(path.join(output, 'ordinary-catalogs.restored.json'), JSON.stringify(catalogsRestored, null, 2));
        assert.equal(canonical(catalogsRestored), canonical(baselinePublic), 'ORDINARY_CATALOG_RESTORE_REQUIRED');
        physicalRestored = true;
        const finalPool = (await overview()).current; const finalWorkspace = (await workspaceOverview()).current;
        const databaseWorkspaceAfter = await readCanonicalLocalIdentity();
        const workspaceAssessment = assessWorkspaceReadback(workspaceIdentity(baselineWorkspace), workspaceIdentity(finalWorkspace), baselineDatabase.workspaceProjection, databaseWorkspaceAfter.workspaceProjection, finalPool);
        workspaceRestored = workspaceAssessment.workspaceRestored;
        events.push({ phase: 'workspace-final-readback', workspace: workspaceIdentity(finalWorkspace), ...workspaceAssessment, workspaceMutationPerformed: false });
        if (unknownPhase === 'stage') {
          const original = await request(`/api/admin/model-pool-releases?requestId=${encodeURIComponent(mutationRequestId)}`);
          // No receipt still means unknown. A baseline current release cannot prove that staging never committed.
          if (uuid.test(String(original.receipt?.candidateId || ''))) {
            const originalCandidate = (await overview()).releases.find(row => row.id === original.receipt.candidateId);
            if (originalCandidate && !baselineIds.has(originalCandidate.id) && canonical(originalCandidate.snapshot) === canonical(changedSnapshot)) {
              operationCandidateId = originalCandidate.id; owned.add(originalCandidate.id); operationReconciled = true; unknownWrite = false; unknownPhase = '';
            }
          }
        }
        events.push({ phase: 'operation-reconciliation', operationReconciled, operationCandidateId: operationCandidateId || null });
        if (!workspaceRestored || !operationReconciled) throw new Error('PHYSICAL_RESTORED_BUT_ROOT_RECOVERY_REQUIRED');
      } catch (error) {
        events.push({ restoration: 'requires-root-inspection', reason: String(error?.message || 'RESTORE_FAILED').slice(0, 180), baseline: rowIdentity(baseline) });
        recoveryError = error;
      }
    }
    if (baselineDatabase && baselineRuntime) {
      try {
        const databaseAfter = await readCanonicalLocalIdentity(); const runtimeAfter = await readCurrentLocalBuild(origin);
        assert.deepEqual(databaseAfter, baselineDatabase, 'DATABASE_IDENTITY_CHANGED'); assert.deepEqual(runtimeAfter, baselineRuntime, 'CURRENT_BUILD_CHANGED');
        assertStudentIdentity(customer, await request('/api/auth/me', { ordinary: true }), expectedUserId);
        runtimeRestored = true;
      } catch (error) { recoveryError ||= error; } finally { await record(); }
    } else await record();
    if (recoveryError) throw recoveryError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(String(error?.message || 'LOCAL_MODEL_CLOSED_LOOP_FAILED')); process.exitCode = 1; });
