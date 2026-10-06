import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { safeCanvasMutation } from './verify-canvas-persistence-local-e2e.mjs';

const args = process.argv.slice(2);
if (!args.includes('--resume-cleanup')) {
  console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, command: 'node scripts/verify-canvas-persistence-local-resume.mjs --resume-cleanup --run-id=<original-run> --attempt=1', scope: 'Resume deletion of the original 3 test canvases only; no create, copy, generation or unknown mutation replay.' }));
  process.exit(0);
}
const runId = args.find(value => value.startsWith('--run-id='))?.slice(9);
const attempt = Number(args.find(value => value.startsWith('--attempt='))?.slice(10) || 1);
assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId));
assert.ok(Number.isSafeInteger(attempt) && attempt > 0 && attempt < 10);
const out = path.resolve('.codex-evidence/canvas-persistence-real-e2e-20260903', runId);
const original = JSON.parse(await fs.readFile(path.join(out, 'execute.json'), 'utf8'));
const oldJournal = JSON.parse(await fs.readFile(path.join(out, 'mutations.json'), 'utf8'));
assert.ok(original.stages.length >= 6 && original.stages.every(stage => stage.passed), 'ORIGINAL_SIX_STAGES_REQUIRED');
assert.equal(original.generationRequests, 0); assert.equal(oldJournal.runId, runId);
assert.ok(oldJournal.mutations.every(entry => entry.state === 'responded'), 'UNKNOWN_ORIGINAL_WRITE_REQUIRES_READ_ONLY_RECONCILIATION');
for (const name of await fs.readdir(out)) {
  if (!/^resume-cleanup-\d+\.mutations\.json$/u.test(name)) continue;
  const previous = JSON.parse(await fs.readFile(path.join(out, name), 'utf8'));
  assert.ok(previous.every(entry => entry.state === 'responded'), 'UNKNOWN_RESUME_WRITE_REQUIRES_READ_ONLY_RECONCILIATION');
}
const origin = process.env.LOCAL_NAV_ORIGIN || original.origin;
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin));
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'NORMAL_LOCAL_ADMIN_SESSION_REQUIRED');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.supabaseUrl.replace(/\/$/u, ''), 'http://127.0.0.1:54321');
const ownIds = new Set(original.ownIds); assert.equal(ownIds.size, 3);
const seedId = original.stages[0].canvasId;
assert.ok([seedId, original.uiCanvasId, original.copyCanvasId].every(id => ownIds.has(id)));
const reportPath = path.join(out, `resume-cleanup-${attempt}.json`), mutationPath = path.join(out, `resume-cleanup-${attempt}.mutations.json`);
const report = { at: new Date().toISOString(), runId, origin, attempt, passed: false, originalPassedStages: original.stages.length,
  generationRequests: 0, createdCanvases: 0, replayedUnknownWrites: 0, deletedViaUi: [], alreadyDeleted: [], blocked: [], pageErrors: [], ownIds: [...ownIds] };
const mutations = [];
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
await fs.writeFile(mutationPath, '[]', { flag: 'wx' });
const clean = value => String(value || '').split(token).join('[redacted]').split(runtime.serviceRoleKey).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').slice(0, 500);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (pathname, init = {}) => {
  const response = await fetch(origin + pathname, { ...init, headers, signal: AbortSignal.timeout(25000) });
  return { status: response.status, body: await response.json() };
};
let queue = Promise.resolve();
const saveMutations = () => { queue = queue.then(() => fs.writeFile(mutationPath, JSON.stringify(mutations, null, 2))); return queue; };
const rows = async (table, select, filters, count = false) => {
  const url = new URL(`${runtime.supabaseUrl}/rest/v1/${table}`); url.searchParams.set('select', select);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}`, ...(count ? { Prefer: 'count=exact' } : {}) }, signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert.ok(response.ok && Array.isArray(value), `LOCAL_READ_FAILED_${table}`);
  return count ? Number(response.headers.get('content-range')?.split('/').at(-1)) : value;
};
let browser, page, fatal, lastMutationAt = 0;
const waitFor = async (callback, label) => {
  const start = Date.now(); while (Date.now() - start < 30000) { if (fatal) throw fatal; if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw Error(`WAIT_FAILED_${label}`);
};
try {
  const me = await api('/api/auth/me'); assert.ok(me.status === 200 && me.body.user?.role === 'admin'); const user = me.body.user;
  const existing = await rows('canvas_documents', 'id,name,revision,deleted', { owner_id: `eq.${user.id}`, id: `in.(${[...ownIds].join(',')})` });
  assert.equal(existing.length, 3, 'ORIGINAL_TEST_OWNERSHIP_REQUIRED');
  assert.ok(existing.every(row => row.name.startsWith(runId)), 'ORIGINAL_TEST_NAME_REQUIRED');
  report.before = existing.map(({ id, revision, deleted }) => ({ id, revision, deleted }));
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1060 }, serviceWorkers: 'block' });
  await context.addInitScript(({ origin, token, user }) => { if (location.origin === origin) { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); } }, { origin, token, user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    if (url.origin !== origin || url.pathname !== '/api/canvas' || !['POST', 'DELETE'].includes(method)) {
      if (/generate|compile-script|chat|llm|\/extract/u.test(url.pathname)) report.generationRequests++;
      report.blocked.push({ path: url.origin === origin ? url.pathname : '[external]', method }); return route.abort();
    }
    try {
      const body = request.postDataJSON();
      assert.ok(body.action !== 'copy' && safeCanvasMutation(method, body, ownIds), 'ONLY_ORIGINAL_TEST_CANVAS_WRITES_ALLOWED');
      const entry = { method, body, at: new Date().toISOString(), state: 'dispatched' }; mutations.push(entry); lastMutationAt = Date.now(); await saveMutations();
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 25000 });
      entry.status = response.status(); entry.result = await response.json(); entry.state = 'responded'; lastMutationAt = Date.now(); await saveMutations();
      if (method === 'DELETE' && response.status() >= 400) fatal = Error(`DELETE_REJECTED_${response.status()}_${entry.result.code || 'UNKNOWN'}`);
      await route.fulfill({ response });
    } catch (error) { fatal = Error(clean(error.message)); await route.abort().catch(() => undefined); }
  });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
  await page.goto(origin + '/free-canvas', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('.free-tool-rail button[title="当前画布"]').waitFor({ timeout: 35000 });
  const menu = async () => { if (!await page.locator('.free-canvas-menu').isVisible()) await page.locator('.free-tool-rail button[title="当前画布"]').click(); await page.locator('.free-canvas-menu article.active').waitFor(); };
  for (const id of [original.copyCanvasId, original.uiCanvasId]) {
    const current = await api(`/api/canvas?canvasId=${encodeURIComponent(id)}`);
    if (current.status === 404) { report.alreadyDeleted.push(id); continue; }
    assert.equal(current.status, 200); assert.ok(current.body.canvas.name.startsWith(runId));
    await menu();
    const title = current.body.canvas.name;
    const row = page.locator('.free-canvas-menu article').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u') }) });
    await row.waitFor(); assert.equal(await row.count(), 1);
    await row.locator('button').first().click();
    await page.locator('.free-canvas-menu').waitFor({ state: 'hidden', timeout: 30000 });
    await menu();
    assert.equal(await page.locator('.free-canvas-menu article.active input').inputValue(), title, 'WRONG_CANVAS_ACTIVE');
    const selectedAt = Date.now();
    await waitFor(() => Date.now() - Math.max(selectedAt, lastMutationAt) > 1200 && mutations.every(entry => entry.state === 'responded'), 'autosave-settled');
    // Bind the intended row once more after the async switch and its autosave have settled.
    assert.equal(await page.locator('.free-canvas-menu article.active input').inputValue(), title, 'DELETE_TARGET_CHANGED');
    const deletionStart = mutations.length;
    await page.locator('.free-canvas-menu article.active button[title="删除画布"]').click();
    await waitFor(() => mutations.slice(deletionStart).some(entry => entry.method === 'DELETE' && entry.body.canvasId === id && entry.state === 'responded' && entry.status === 200), 'intended-ui-delete-receipt');
    await waitFor(async () => (await api(`/api/canvas?canvasId=${encodeURIComponent(id)}`)).status === 404, 'deleted-readback');
    report.deletedViaUi.push(id); await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  }
  await page.close(); page = null;
  const seed = await api(`/api/canvas?canvasId=${encodeURIComponent(seedId)}`);
  if (seed.status === 200) {
    const body = { canvasId: seedId, expectedRevision: seed.body.canvas.revision, idempotencyKey: `canvas-e2e:${runId}:resume-delete-seed-r${seed.body.canvas.revision}` };
    const entry = { method: 'DELETE', body, at: new Date().toISOString(), state: 'dispatched' }; mutations.push(entry); await saveMutations();
    const result = await api('/api/canvas', { method: 'DELETE', body: JSON.stringify(body) });
    entry.status = result.status; entry.result = result.body; entry.state = 'responded'; await saveMutations(); assert.equal(result.status, 200);
  } else assert.equal(seed.status, 404);
  const after = await rows('canvas_documents', 'id,name,revision,document,deleted', { owner_id: `eq.${user.id}`, order: 'id.asc' });
  assert.equal(hash(after.filter(row => !ownIds.has(row.id))), original.originalCanvasDigest, 'OTHER_ACCOUNT_CANVASES_CHANGED');
  assert.ok(after.filter(row => ownIds.has(row.id)).every(row => row.deleted));
  report.balanceAfter = (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0];
  report.walletOperationsAfter = await rows('wallet_operations', 'id', { user_id: `eq.${user.id}`, limit: '0' }, true);
  assert.deepEqual(report.balanceAfter, original.balanceBefore); assert.equal(report.walletOperationsAfter, original.walletOperationsBefore);
  assert.equal(report.generationRequests, 0); assert.equal(report.pageErrors.length, 0);
  report.otherCanvasesUnchanged = true; report.ownCanvasesDeleted = true; report.walletOperationDelta = 0; report.passed = true;
} catch (error) {
  report.failure = clean(error.message); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(out, `resume-cleanup-${attempt}-failure.png`), fullPage: true }).catch(() => undefined);
} finally {
  if (browser) await browser.close(); await queue; await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, report: reportPath, failure: report.failure, deletedViaUi: report.deletedViaUi.length, generationRequests: report.generationRequests }));
