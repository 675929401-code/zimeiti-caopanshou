import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import pg from 'pg';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_PREVIEW_REQUIRED');
const packageId = 'cf44b5b6-18e9-4a5a-8096-8c510f7be1c2', marker = 'local-manju-crud-2d8e3ee5';
const directory = '.codex-evidence/skill-package-archive-20260903';
if (!process.argv.includes('--apply-local')) {
  console.log(JSON.stringify({ ready: true, mode: 'plan-only', origin, packageId, newPackages: 0, steps: ['normal admin and local schema', 'existing lifecycle evidence and package identity', 'validate original payload', 'enabled installation blocks archive, then uninstall own test reference', 'stale CAS refuses', 'archive once through actual UI', 'replay original archive intent', 'archived edit/publish/install/rollback all refuse', 'versions and other packages unchanged'], upstreamCalls: 0 }));
  process.exit(0);
}
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
assert.ok(runtime.localOnly && runtime.ownerConnection?.host === '127.0.0.1' && runtime.ownerConnection.port === 54322 && runtime.ownerConnection.database === 'zimeiti_local', 'LOCAL_DATABASE_REQUIRED');
await mkdir(directory, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const db = new pg.Client(runtime.ownerConnection); await db.connect(); await db.query('set default_transaction_read_only=on');
const checks = [], events = [], pageErrors = [];
let browser, page, userId = '', baseline, originalView, intent, error = null, stage = 'preflight', installAttempted = false, archiveBrowserPosts = 0, normalAdmin = false;
const apiHeaders = { Authorization: `Bearer ${token}` };
const trace = async () => writeFile(`${directory}/progress-${runId}.json`, JSON.stringify({ runId, stage, checks, events, archiveBrowserPosts, pageErrors }, null, 2));
async function api(path, body, { method = body ? 'POST' : 'GET', expected = [200], authenticated = true } = {}) {
  const url = new URL(path, origin); assert.equal(url.origin, origin, 'EXTERNAL_REQUEST_FORBIDDEN');
  assert.ok(['/api/auth/me', '/api/admin/skill-packages', '/api/youcai/skills', '/api/youcai/skills/install', `/api/youcai/skills/${packageId}/uninstall`].includes(url.pathname), 'REQUEST_PATH_FORBIDDEN');
  if (body?.packageId) assert.equal(body.packageId, packageId, 'OTHER_PACKAGE_MUTATION_FORBIDDEN');
  const response = await fetch(url, { method, headers: { ...(authenticated ? apiHeaders : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  const code = /^[A-Z0-9_]+$/u.test(data.code || '') ? data.code : null;
  events.push({ stage, path: url.pathname, method, status: response.status, code });
  assert.ok(expected.includes(response.status), `API_STATUS_${response.status}_${code || 'UNEXPECTED'}`);
  if (response.status >= 400) assert.equal(data.ok, false, 'REFUSAL_BODY_REQUIRED');
  else assert.notEqual(data.ok, false, 'API_REFUSED');
  return { data, status: response.status };
}
async function view() {
  const data = (await api(`/api/admin/skill-packages?q=${marker}&limit=10`)).data;
  const found = data.packages.find(item => item.package.id === packageId);
  assert.ok(found && found.package.slug === marker && found.package.created_by === userId && found.package.visibility === 'private' && found.package.origin === 'custom' && found.package.metadata?.localAcceptanceFixture === true, 'OWN_PRIVATE_FIXTURE_REQUIRED');
  return found;
}
async function snapshot() {
  const row = (await db.query('select id,slug,lifecycle,active_version_id,updated_at from public.skill_packages where id=$1', [packageId])).rows[0];
  const versions = (await db.query('select id,semver,status,payload_hash from public.skill_versions where package_id=$1 order by version_number', [packageId])).rows;
  const counts = (await db.query(`select
    (select count(*)::int from public.skill_release_audit where package_id=$1) audit,
    (select count(*)::int from public.skill_release_audit where package_id=$1 and action='archive') archives,
    (select count(*)::int from public.user_skill_installations where package_id=$1 and user_id=$2) own_installations,
    (select count(*)::int from public.user_skill_installations where package_id=$1 and enabled) active_installations,
    (select count(*)::int from public.agent_skill_installations where package_id=$1 and enabled) active_agent_installations,
    (select count(*)::int from public.skill_invocations where package_id=$1) invocations`, [packageId, userId])).rows[0];
  const otherPackages = (await db.query('select id,lifecycle,active_version_id,latest_version_number,updated_at from public.skill_packages where id<>$1 order by id', [packageId])).rows;
  return { row, versions, counts, otherPackages };
}
function draftFrom(view, action = 'validate') {
  const version = view.versions.find(item => item.id === view.package.active_version_id) || view.versions.find(item => item.semver === '1.0.0');
  assert.ok(version);
  return { action, packageId, baseVersionId: version.id, expectedUpdatedAt: view.package.updated_at,
    slug: view.package.slug, displayName: view.package.display_name, summary: view.package.summary, origin: 'custom', visibility: 'private', runtimeKind: view.package.runtime_kind,
    payload: version.payload, metadata: view.package.metadata, semver: action === 'save-draft' ? '1.0.2' : version.semver, schemaVersion: version.schema_version };
}
try {
  const actor = (await api('/api/auth/me')).data.user; assert.ok(actor?.role === 'admin' && actor.id, 'NORMAL_ADMIN_REQUIRED'); userId = actor.id;
  const owner = (await db.query('select created_by from public.skill_packages where id=$1', [packageId])).rows[0]; assert.equal(owner?.created_by, userId, 'NORMAL_ADMIN_MUST_OWN_FIXTURE'); normalAdmin = true;
  const schema = (await db.query("select to_regprocedure('public.archive_skill_package(uuid,timestamp with time zone,uuid,text)') is not null as ready")).rows[0]; assert.equal(schema.ready, true, 'LOCAL_ARCHIVE_MIGRATION_REQUIRED');
  const prior = JSON.parse(await readFile('.codex-evidence/manju-secondary-20260902/local-manju-crud-2d8e3ee5-continuation-1788356342983.json', 'utf8'));
  assert.equal(prior.completed, true); assert.equal(prior.packageId, packageId);
  originalView = await view(); baseline = await snapshot(); assert.equal(baseline.versions.length, 2); assert.equal(baseline.counts.invocations, 0);
  await writeFile(`${directory}/before-${runId}.json`, JSON.stringify(baseline, null, 2));
  checks.push({ check: 'existing-two-version-lifecycle-evidence', passed: true, newPackages: 0 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(({ sessionToken, user }) => { localStorage.setItem('auth_token', sessionToken); localStorage.setItem('auth_user', JSON.stringify(user)); }, { sessionToken: token, user: actor });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || url.pathname === '/api/health') return route.abort();
    if (['GET', 'HEAD'].includes(request.method())) return route.continue();
    if (url.pathname === '/api/admin/skill-packages' && request.method() === 'POST' && intent && archiveBrowserPosts === 0) {
      let body; try { body = request.postDataJSON(); } catch { return route.abort(); }
      if (body.action === 'archive' && body.packageId === packageId && body.expectedUpdatedAt === intent.expectedUpdatedAt && body.expectedActiveVersionId === intent.expectedActiveVersionId) { archiveBrowserPosts++; return route.continue(); }
    }
    return route.abort();
  });
  page = await context.newPage(); page.on('pageerror', err => pageErrors.push(err.name));
  stage = 'actual-admin-entry';
  await page.goto(`${origin}/admin?tab=manju-workbench#manju-custom-skill-packages`, { waitUntil: 'load', timeout: 60000 });
  const section = page.locator('[data-admin-section="manju-custom-skill-packages"]');
  await section.getByText('可持久化', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  let article = section.locator(`[data-skill-package-id="${packageId}"]`);
  await article.waitFor({ state: 'visible', timeout: 30000 });
  if (baseline.row.lifecycle !== 'archived') {
    await article.getByRole('button', { name: '归档', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(baseline.counts.own_installations, 0, 'NO_PREEXISTING_OWN_INSTALLATION_REQUIRED');
    assert.equal(baseline.counts.active_installations, 0); assert.equal(baseline.counts.active_agent_installations, 0);
    stage = 'validate-original-package'; await api('/api/admin/skill-packages', draftFrom(originalView)); checks.push({ check: 'original-payload-valid', passed: true });
    intent = { action: 'archive', packageId, expectedUpdatedAt: originalView.package.updated_at, expectedActiveVersionId: originalView.package.active_version_id };
    stage = 'active-installation-refusal'; installAttempted = true;
    await api('/api/youcai/skills/install', { packageId, versionId: originalView.package.active_version_id, enabled: true });
    const blocked = await api('/api/admin/skill-packages', intent, { expected: [409] }); assert.equal(blocked.data.code, 'SKILL_CONFLICT');
    assert.equal((await snapshot()).row.lifecycle, 'published');
    await api(`/api/youcai/skills/${packageId}/uninstall`, undefined, { method: 'DELETE' }); installAttempted = false;
    checks.push({ check: 'enabled-installation-refuses-archive-and-own-installation-removed', passed: true });
    stage = 'stale-archive-cas'; const stale = await api('/api/admin/skill-packages', { ...intent, expectedUpdatedAt: new Date(Date.parse(intent.expectedUpdatedAt) - 1000).toISOString() }, { expected: [409] }); assert.equal(stale.data.code, 'SKILL_CONFLICT');
    checks.push({ check: 'stale-archive-cas-refused', passed: true });
    try {
      const savedIntent = JSON.parse(await readFile(`${directory}/archive-intent.json`, 'utf8'));
      assert.equal(savedIntent.marker, marker); assert.deepEqual(savedIntent.intent, intent, 'EXISTING_ARCHIVE_INTENT_CHANGED');
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      await writeFile(`${directory}/archive-intent.json`, JSON.stringify({ origin, marker, intent }, null, 2), { flag: 'wx' });
    }
    await article.screenshot({ path: `${directory}/before-archive.png` });
    await trace(); stage = 'archive-once-through-ui';
    page.once('dialog', async dialog => { if (dialog.message().includes(marker) && dialog.message().includes('归档')) await dialog.accept(); else await dialog.dismiss(); });
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/admin/skill-packages') && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'archive', { timeout: 30000 });
    await article.getByRole('button', { name: '归档', exact: true }).click();
    const response = await responsePromise; const body = await response.json(); assert.equal(response.status(), 200, 'ARCHIVE_UI_REQUEST_FAILED'); assert.equal(body.result?.lifecycle, 'archived');
    checks.push({ check: 'actual-ui-archive', passed: true, requests: archiveBrowserPosts });
  } else {
    const saved = JSON.parse(await readFile(`${directory}/archive-intent.json`, 'utf8')); assert.equal(saved.marker, marker); assert.equal(saved.intent.packageId, packageId); intent = saved.intent;
    checks.push({ check: 'reconciled-existing-archive-intent', passed: true, newArchiveRequest: false });
  }
  stage = 'same-intent-replay'; const replay = await api('/api/admin/skill-packages', intent); assert.equal(replay.data.result.already_archived, true);
  let after = await snapshot(); assert.equal(after.row.lifecycle, 'archived'); assert.equal(after.row.active_version_id, null);
  assert.deepEqual(after.versions, baseline.versions); assert.equal(after.counts.archives, 1); assert.equal(after.counts.invocations, baseline.counts.invocations); assert.equal(after.counts.own_installations, 0); assert.deepEqual(after.otherPackages, baseline.otherPackages);
  checks.push({ check: 'archive-replay-once-versions-and-other-packages-preserved', passed: true, versionCount: after.versions.length, archiveAuditCount: after.counts.archives });
  const archived = await view();
  stage = 'archived-save-refusal'; await api('/api/admin/skill-packages', draftFrom(archived, 'save-draft'), { expected: [400, 409] });
  stage = 'archived-publish-refusal'; await api('/api/admin/skill-packages', { action: 'publish', versionId: baseline.versions[0].id, expectedActiveVersionId: null }, { expected: [409] });
  stage = 'archived-rollback-refusal'; await api('/api/admin/skill-packages', { action: 'rollback', packageId, targetVersionId: baseline.versions[0].id, expectedActiveVersionId: null }, { expected: [400, 409] });
  stage = 'archived-install-refusal'; await api('/api/youcai/skills/install', { packageId, versionId: baseline.versions[0].id, enabled: true }, { expected: [400, 403, 404, 409] });
  checks.push({ check: 'archived-edit-publish-rollback-install-refused', passed: true });
  stage = 'refresh-readonly-history'; await page.reload({ waitUntil: 'load' }); await section.getByText('可持久化', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  article = section.locator(`[data-skill-package-id="${packageId}"]`);
  await article.getByRole('button', { name: '查看历史', exact: true }).click();
  assert.equal(await section.getByRole('button', { name: '保存草稿', exact: true }).isDisabled(), true);
  assert.equal(await article.getByRole('button', { name: '归档', exact: true }).count(), 0); assert.equal(await article.getByRole('button', { name: '回滚到此版本', exact: true }).count(), 0);
  await article.screenshot({ path: `${directory}/archived-history.png` });
  assert.equal(pageErrors.length, 0); const anonymous = await api(`/api/youcai/skills?q=${marker}&limit=10`, undefined, { authenticated: false }); assert.equal(anonymous.data.skills.length, 0);
  after = await snapshot(); assert.deepEqual(after.versions, baseline.versions); assert.deepEqual(after.otherPackages, baseline.otherPackages); assert.equal(after.counts.archives, 1); assert.equal(after.counts.invocations, 0);
  await writeFile(`${directory}/after-${runId}.json`, JSON.stringify(after, null, 2)); checks.push({ check: 'refresh-readonly-history-and-public-absence', passed: true });
} catch (cause) { error = { stage, type: cause.name, code: /^[A-Z0-9_]+$/u.test(cause.message || '') ? cause.message : 'SKILL_ARCHIVE_CHECK_FAILED' }; }
finally {
  if (installAttempted && userId && baseline?.counts.own_installations === 0) {
    try { const state = await snapshot(); if (state.counts.own_installations > 0) await api(`/api/youcai/skills/${packageId}/uninstall`, undefined, { method: 'DELETE' }); } catch { error ||= { stage: 'cleanup-own-installation', code: 'CLEANUP_NOT_CONFIRMED' }; }
  }
  await browser?.close(); await db.end();
  const report = { passed: !error, runId, packageId, marker, origin, normalAdmin, checks, events, pageErrors, archiveBrowserPosts, error, newPackages: 0, upstreamCalls: 0, physicalDeletes: 0 };
  await writeFile(`${directory}/browser-report-${runId}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (error) process.exitCode = 1;
}
