import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const base = 'http://127.0.0.1:5000';
const runtimeFile = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const evidence = '.codex-evidence/manju-secondary-20260902';
const apply = process.argv.includes('--apply-local');
const marker = `local-manju-crud-${randomUUID().slice(0, 8)}`;
const report = { marker, mode: apply ? 'apply-local' : 'plan-only', checks: [], providerCalls: 0, externalStorageWrites: 0, databaseMutations: 0 };
let token;

async function api(route, body, { method = body ? 'POST' : 'GET', expectedStatus = 200, authenticated = true } = {}) {
  if (method !== 'GET' && !apply) throw new Error('WRITE_NOT_AUTHORIZED_IN_PLAN');
  const response = await fetch(`${base}${route}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (response.status !== expectedStatus) throw new Error(`API_STATUS_${response.status}_${typeof data.code === 'string' && /^[A-Z_]+$/u.test(data.code) ? data.code : 'UNKNOWN'}`);
  if (expectedStatus === 200) assert.notEqual(data.ok, false);
  if (method !== 'GET' && body?.action !== 'validate') report.databaseMutations += 1;
  return data;
}

function skillDraft() {
  return {
    action: 'save-draft', slug: marker, displayName: marker, summary: 'Local CRUD fixture; no generation.',
    origin: 'custom', visibility: 'private', runtimeKind: 'prompt', semver: '1.0.0', schemaVersion: '1.0.0',
    metadata: { localAcceptanceFixture: true },
    payload: {
      manifest: { commandName: `/${marker}`, displayName: marker, description: 'Local CRUD fixture; no generation.',
        category: 'local-validation', author: 'local-validation', autoInvoke: false, priceCredits: 0 },
      instructions: 'This is an inert local persistence fixture. It is never invoked.',
      input_schema: { type: 'object' }, output_schema: { type: 'object' }, execution_type: 'prompt',
      sanitized_config: {}, routing: { explicitCommands: [`/${marker}`], autoInvoke: false },
      orchestration: { stages: [{ id: 'result', type: 'output', title: 'No execution' }], maxModelCalls: 0, maxToolCalls: 0 },
      tools: [], resources: [], provenance: { kind: 'internal_original', sourceName: 'Local validation fixture', license: 'Internal' },
    },
  };
}

async function configLifecycle() {
  const route = '/api/admin/manju-config?environment=production&domain=content';
  const before = await api(route);
  assert.ok(before.active?.release?.id && before.active?.revision?.payload && Number.isInteger(before.storage_generation));
  const baseline = before.active;
  const baselinePublic = await api('/api/youcai/runtime-config', undefined, { authenticated: false });
  assert.deepEqual(baselinePublic.domains.content, baseline.revision.payload);
  const payload = { ...baseline.revision.payload, brand: marker };
  let saved;
  try {
    await api('/api/admin/manju-config', { action: 'validate', environment: 'production', domain: 'content', schema_version: '1.1.0', payload });
    saved = (await api('/api/admin/manju-config', { action: 'save-draft', environment: 'production', domain: 'content',
      schema_version: '1.1.0', expected_storage_generation: before.storage_generation, payload })).revision;
    assert.ok(saved?.id && saved?.updated_at);
    const firstUpdatedAt = saved.updated_at;
    const editedPayload = { ...payload, brand: `${marker}-edited` };
    saved = (await api('/api/admin/manju-config', { action: 'save-draft', environment: 'production', domain: 'content',
      schema_version: '1.1.0', expected_storage_generation: before.storage_generation,
      revision_id: saved.id, expected_updated_at: saved.updated_at, payload: editedPayload })).revision;
    await api('/api/admin/manju-config', { action: 'save-draft', environment: 'production', domain: 'content',
      schema_version: '1.1.0', expected_storage_generation: before.storage_generation,
      revision_id: saved.id, expected_updated_at: firstUpdatedAt, payload }, { expectedStatus: 409 });
    const draftPublic = await api('/api/youcai/runtime-config', undefined, { authenticated: false });
    assert.deepEqual(draftPublic.domains.content, baselinePublic.domains.content);
    report.checks.push('config-draft-create-edit-cas-and-not-public');
    await api('/api/admin/manju-config', { action: 'publish', environment: 'production', domain: 'content',
      expected_storage_generation: before.storage_generation, revision_id: saved.id,
      expected_active_release_id: baseline.release.id });
    const published = await api('/api/youcai/runtime-config', undefined, { authenticated: false });
    assert.equal(published.domains.content.brand, editedPayload.brand);
    assert.ok(!('prompt' in published.domains) && !('skill' in published.domains));
    report.checks.push('config-published-public-read-and-private-domains-absent');
  } finally {
    // Roll back only our own active revision; never overwrite a concurrent edit.
    const current = await api(route);
    if (saved?.id && current.active?.revision?.id === saved.id) {
      await api('/api/admin/manju-config', { action: 'rollback', environment: 'production', domain: 'content',
        expected_storage_generation: current.storage_generation, target_release_id: baseline.release.id,
        expected_active_release_id: current.active.release.id });
      const restored = await api('/api/youcai/runtime-config', undefined, { authenticated: false });
      assert.deepEqual(restored.domains.content, baselinePublic.domains.content);
      report.checks.push('config-baseline-restored-by-reviewed-rollback');
    } else if (current.active?.revision?.id !== baseline.revision.id) {
      report.concurrentConfigChange = true;
      throw new Error('CONFIG_CONCURRENT_CHANGE_NO_AUTOMATIC_ROLLBACK');
    }
  }
}

async function skillLifecycle() {
  const draft = skillDraft();
  await api('/api/admin/skill-packages', { ...draft, action: 'validate' });
  let saved = (await api('/api/admin/skill-packages', draft)).result;
  const packageId = saved.package_id;
  const versionOne = saved.version_id;
  assert.ok(packageId && versionOne && saved.updated_at);
  report.retainedPrivateFixturePackageId = packageId;
  const firstUpdatedAt = saved.updated_at;
  const edited = { ...draft, packageId, versionId: versionOne, baseVersionId: versionOne,
    expectedUpdatedAt: saved.updated_at, displayName: `${marker}-edited` };
  saved = (await api('/api/admin/skill-packages', edited)).result;
  assert.equal(saved.package_id, packageId);
  assert.equal(saved.version_id, versionOne);
  await api('/api/admin/skill-packages', { ...edited, expectedUpdatedAt: firstUpdatedAt }, { expectedStatus: 409 });
  report.checks.push('skill-create-two-saves-same-draft-and-cas');
  await api('/api/admin/skill-packages', { action: 'publish', versionId: versionOne, expectedActiveVersionId: null });
  const installation = await api('/api/youcai/skills/install', { packageId, versionId: versionOne, enabled: true });
  try {
    const replay = await api('/api/youcai/skills/install', { packageId, versionId: versionOne, enabled: true });
    assert.ok(installation.installation.user_id && installation.installation.package_id && installation.installation.created_at);
    for (const field of ['user_id', 'package_id', 'version_id', 'created_at']) {
      assert.equal(replay.installation[field], installation.installation[field]);
    }
    report.checks.push('skill-publish-and-install-replay');
  } finally {
    await api(`/api/youcai/skills/${packageId}/uninstall`, undefined, { method: 'DELETE' });
  }
  const current = await api(`/api/admin/skill-packages?q=${marker}&limit=10`);
  const currentPackage = current.packages.find((item) => item.package?.id === packageId)?.package;
  assert.ok(currentPackage?.updated_at);
  const second = (await api('/api/admin/skill-packages', { ...draft, packageId, baseVersionId: versionOne,
    expectedUpdatedAt: currentPackage.updated_at, semver: '1.0.1' })).result;
  assert.notEqual(second.version_id, versionOne);
  await api('/api/admin/skill-packages', { action: 'publish', versionId: second.version_id, expectedActiveVersionId: versionOne });
  await api('/api/admin/skill-packages', { action: 'rollback', packageId, targetVersionId: versionOne, expectedActiveVersionId: second.version_id });
  const adminReadback = await api(`/api/admin/skill-packages?q=${marker}&limit=10`);
  assert.equal(adminReadback.packages.find((item) => item.package?.id === packageId)?.package.active_version_id, versionOne);
  const anonymous = await api(`/api/youcai/skills?q=${marker}&limit=10`, undefined, { authenticated: false });
  assert.equal(anonymous.skills.length, 0);
  report.checks.push('skill-uninstall-version-rollback-private-not-anonymous');
}

async function main() {
  assert.ok(process.argv.slice(2).every((arg) => arg === '--apply-local' || arg === '--plan'));
  if (!apply) {
    report.plan = [
      'Require the fixed existing local runtime and normal administrator session; no remote fallback.',
      'Read readiness for migrated package store and existing published content.',
      'Content: create and edit one draft, reject stale edit, prove draft is not public, publish, read public payload, rollback only own active revision.',
      'Private inert Skill: create, edit same draft, reject stale edit, publish, install twice once, uninstall, publish second version, rollback.',
      'Retain only the explicitly marked private fixture Skill and immutable configuration audit history; no whole-package DELETE API exists.',
      'No generation, wallet calls, object upload, server access or deployment.',
    ];
    report.completed = true;
    return;
  }
  const local = JSON.parse(await readFile(runtimeFile, 'utf8'));
  assert.ok(local.localOnly && local.ownerConnection?.host === '127.0.0.1' && local.ownerConnection?.port === 54322
    && local.ownerConnection?.database === 'zimeiti_local' && local.supabaseUrl === 'http://127.0.0.1:54321');
  token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
  await api('/api/admin/skill-packages?limit=1');
  const prompt = await api('/api/admin/manju-config?environment=production&domain=prompt');
  assert.ok(prompt.active?.revision?.payload);
  await api('/api/admin/manju-config', { action: 'validate', environment: 'production', domain: 'prompt', schema_version: '1.1.0', payload: prompt.active.revision.payload });
  report.checks.push('current-published-private-prompt-contract-valid');
  await configLifecycle();
  await skillLifecycle();
  report.completed = true;
}

main().catch((error) => {
  report.completed = false;
  report.errorType = error?.name || 'UnknownError';
  report.errorCode = /^[A-Z0-9_]{1,180}$/u.test(error?.message || '') ? error.message : 'VALIDATION_ASSERTION_FAILED';
  process.exitCode = 1;
}).finally(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/${apply ? marker : 'crud-plan'}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
});
