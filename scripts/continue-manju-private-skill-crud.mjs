import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:5000';
const packageId = 'cf44b5b6-18e9-4a5a-8096-8c510f7be1c2';
const marker = 'local-manju-crud-2d8e3ee5';
const versionOne = 'ea91cf44-6672-461e-b02f-0168cfad26cb';
const apply = process.argv.includes('--apply-local');
const report = { marker, packageId, mode: apply ? 'continue-existing-local-package' : 'plan-only', checks: [], providerCalls: 0, newPackages: 0 };
let token;

async function api(stage, route, body, method = body ? 'POST' : 'GET', authenticated = true) {
  report.lastStage = stage;
  const response = await fetch(`${base}${route}`, { method, cache: 'no-store',
    headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(`API_${response.status}_${/^[A-Z_]+$/u.test(result.code || '') ? result.code : 'FAILED'}`);
  return result;
}

async function view() {
  const result = await api('read-existing-private-package', `/api/admin/skill-packages?q=${marker}&limit=10`);
  const found = result.packages.find((item) => item.package?.id === packageId);
  assert.ok(found && found.package.slug === marker && found.package.visibility === 'private' && found.package.metadata.localAcceptanceFixture === true);
  assert.ok(found.versions.length >= 1 && found.versions.length <= 2);
  assert.ok(found.versions.some((version) => version.id === versionOne && version.status === 'released'));
  return found;
}

async function main() {
  assert.ok(process.argv.slice(2).every((arg) => arg === '--apply-local' || arg === '--plan'));
  if (!apply) {
    report.plan = ['Continue only the named existing private fixture; never create a package.',
      'Check actual composite installation identity and created_at through install/replay, then uninstall.',
      'Create at most missing 1.0.1 draft using package updated_at CAS; reuse it if already present.',
      'Publish this draft, rollback to original 1.0.0, check private package absent anonymously.',
      'Stop on unknown responses; a later continuation reads existing versions before deciding a write.'];
    report.completed = true; return;
  }
  token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
  const local = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
  assert.ok(local.localOnly && local.ownerConnection?.host === '127.0.0.1' && local.ownerConnection?.port === 54322 && local.ownerConnection?.database === 'zimeiti_local');
  let current = await view();
  if (current.package.active_version_id === versionOne) {
    const installed = (await api('install-known-private-version', '/api/youcai/skills/install', { packageId, versionId: versionOne, enabled: true })).installation;
    try {
      assert.ok(installed.user_id && installed.package_id === packageId && installed.version_id === versionOne && installed.created_at);
      const replay = (await api('replay-known-private-installation', '/api/youcai/skills/install', { packageId, versionId: versionOne, enabled: true })).installation;
      for (const key of ['user_id', 'package_id', 'version_id', 'created_at']) assert.equal(replay[key], installed[key]);
      report.checks.push('composite-installation-and-created-at-replay');
    } finally { await api('uninstall-only-known-private-package', `/api/youcai/skills/${packageId}/uninstall`, undefined, 'DELETE'); }
    report.checks.push('known-private-package-uninstalled');
  }
  current = await view();
  let second = current.versions.find((version) => version.semver === '1.0.1');
  if (!second) {
    assert.equal(current.versions.length, 1);
    assert.equal(current.package.active_version_id, versionOne);
    const original = current.versions.find((version) => version.id === versionOne);
    const result = (await api('create-successor-with-package-cas', '/api/admin/skill-packages', {
      action: 'save-draft', packageId, baseVersionId: versionOne, expectedUpdatedAt: current.package.updated_at,
      slug: current.package.slug, displayName: current.package.display_name, summary: current.package.summary,
      origin: current.package.origin, visibility: 'private', runtimeKind: current.package.runtime_kind,
      payload: original.payload, metadata: current.package.metadata, semver: '1.0.1', schemaVersion: original.schema_version,
    })).result;
    assert.equal(result.package_id, packageId);
    assert.ok(result.version_id && result.version_id !== versionOne);
    current = await view();
    second = current.versions.find((version) => version.id === result.version_id);
  }
  assert.ok(second && second.id !== versionOne);
  report.secondVersionId = second.id;
  report.checks.push('existing-package-successor-draft-created-or-reconciled');
  if (second.status === 'draft') {
    assert.equal(current.package.active_version_id, versionOne);
    await api('publish-only-successor', '/api/admin/skill-packages', { action: 'publish', versionId: second.id, expectedActiveVersionId: versionOne });
  }
  current = await view();
  if (current.package.active_version_id === second.id) {
    await api('rollback-only-successor-to-original', '/api/admin/skill-packages', {
      action: 'rollback', packageId, targetVersionId: versionOne, expectedActiveVersionId: second.id,
    });
  } else assert.equal(current.package.active_version_id, versionOne);
  current = await view();
  assert.equal(current.package.active_version_id, versionOne);
  assert.equal(current.versions.filter((version) => version.status === 'released').length, 2);
  const anonymous = await api('anonymous-private-package-absent', `/api/youcai/skills?q=${marker}&limit=10`, undefined, 'GET', false);
  assert.equal(anonymous.skills.length, 0);
  report.checks.push('second-version-publish-rollback-and-private-readback');
  report.completed = true;
}

main().catch((error) => { report.completed = false; report.errorType = error.name || 'Error'; report.errorCode = /^[A-Z0-9_]+$/u.test(error.message || '') ? error.message : 'VALIDATION_ASSERTION_FAILED'; process.exitCode = 1; }).finally(async () => {
  await mkdir('.codex-evidence/manju-secondary-20260902', { recursive: true });
  await writeFile(`.codex-evidence/manju-secondary-20260902/${marker}-continuation-${apply ? Date.now() : 'plan'}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
});
