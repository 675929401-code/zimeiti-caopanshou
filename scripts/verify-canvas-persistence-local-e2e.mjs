import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const RUNTIME_PATH = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const CHROMIUM_PATH = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const CANVAS_ID = /^canvas:[0-9a-f-]{36}$/iu;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function makeTextDocument(canvasId, name, text = '') {
  const now = new Date().toISOString();
  return { schemaVersion: 1, session: { id: canvasId, name, createdAt: now, updatedAt: now,
    nodes: text ? [{ id: `text:${randomUUID()}`, type: 'workflow', position: { x: 120, y: 100 },
      data: { kind: 'text', title: '持久化验收文本', prompt: text, outputText: text, outputUrl: '', status: 'idle', history: [] } }] : [], edges: [] },
  viewport: { x: 0, y: 0, zoom: 1 }, runHistory: [], diagnostics: [] };
}

export function safeCanvasMutation(method, body, ownIds, allowNew = false) {
  if (method === 'POST' && body?.action === 'save') {
    if (!CANVAS_ID.test(body.canvasId) || body.document?.session?.id !== body.canvasId) return false;
    if (!ownIds.has(body.canvasId) && !(allowNew && body.expectedRevision === 0 && body.document.session.name === '新会话')) return false;
    return body.document.session.nodes.every(node => node?.data?.kind === 'text')
      && body.document.runHistory.length === 0 && body.document.diagnostics.length === 0;
  }
  if (method === 'POST' && body?.action === 'copy') return ownIds.has(body.sourceCanvasId);
  return method === 'DELETE' && ownIds.has(body?.canvasId);
}

export async function main(argv = process.argv.slice(2)) {
  const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
  assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_ORIGIN_REQUIRED');
  const mode = argv.includes('--execute') ? 'execute' : argv.includes('--inspect') ? 'inspect' : 'plan';
  if (mode === 'plan') {
    console.log(JSON.stringify({ mode, origin, networkRequests: 0, generationRequests: 0,
      command: 'node scripts/verify-canvas-persistence-local-e2e.mjs --execute --run-id=<new-unique-id>',
      credentials: 'LOCAL_NAV_ADMIN_TOKEN in process environment only',
      scope: 'Own temporary text-only canvases: UI create/edit/reload/copy/delete; API revision and idempotency; cleanup own records only.' }));
    return;
  }
  const runId = argv.find(value => value.startsWith('--run-id='))?.slice(9);
  assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId), 'UNIQUE_RUN_ID_REQUIRED');
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.ok(token, 'NORMAL_LOCAL_ADMIN_SESSION_REQUIRED');
  const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.equal(runtime.supabaseUrl.replace(/\/$/u, ''), 'http://127.0.0.1:54321', 'LOCAL_DATABASE_REQUIRED');
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const dbHeaders = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };
  const out = path.resolve('.codex-evidence/canvas-persistence-real-e2e-20260903', runId);
  await fs.mkdir(out, { recursive: true });
  const reportPath = path.join(out, `${mode}.json`), journalPath = path.join(out, 'mutations.json');
  const clean = value => String(value || '').split(token).join('[redacted]').split(runtime.serviceRoleKey).join('[redacted]')
    .replace(/https?:\/\/\S+/gu, '[url]').replace(/\beyJ[A-Za-z0-9_.-]+/gu, '[redacted]').replace(/\b1[3-9]\d{9}\b/gu, '[phone]').slice(0, 600);
  const report = { at: new Date().toISOString(), mode, runId, origin, passed: false, stages: [], ownIds: [],
    generationRequests: 0, blockedRequests: [], pageErrors: [], httpErrors: [], canvasRequests: [], credentialsPersisted: false };
  const journal = { runId, mutations: [], ownIds: [] };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  if (mode === 'execute') await fs.writeFile(journalPath, JSON.stringify(journal, null, 2), { flag: 'wx' });
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  let journalQueue = Promise.resolve();
  const saveJournal = () => { journalQueue = journalQueue.then(() => fs.writeFile(journalPath, JSON.stringify(journal, null, 2))); return journalQueue; };
  const ownIds = new Set(); let allowNew = false; let browser; let page; let routeFailure;
  const api = async (pathname, init = {}) => {
    const response = await fetch(origin + pathname, { ...init, headers: { ...authHeaders, ...init.headers }, signal: AbortSignal.timeout(30000) });
    const body = await response.json(); return { status: response.status, body };
  };
  const rows = async (table, select, filters = {}, count = false) => {
    const url = new URL(`${runtime.supabaseUrl}/rest/v1/${table}`);
    url.searchParams.set('select', select); for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { ...dbHeaders, ...(count ? { Prefer: 'count=exact' } : {}) }, signal: AbortSignal.timeout(15000) });
    const data = await response.json(); assert.ok(response.ok && Array.isArray(data), `LOCAL_READ_FAILED_${table}_${response.status}`);
    return count ? Number(response.headers.get('content-range')?.split('/').at(-1)) : data;
  };
  const stage = async (name, action) => { const started = Date.now(); const detail = await action(); report.stages.push({ name, passed: true, ms: Date.now() - started, ...detail }); await save(); };
  const detail = async id => { const response = await api(`/api/canvas?canvasId=${encodeURIComponent(id)}`); assert.equal(response.status, 200, 'OWN_CANVAS_DETAIL_REQUIRED'); return response.body.canvas; };
  const waitFor = async (predicate, label, timeout = 25000) => {
    const started = Date.now(); while (Date.now() - started < timeout) { if (routeFailure) throw routeFailure; const value = await predicate(); if (value) return value; await sleep(250); }
    throw Error(`WAIT_FAILED_${label}`);
  };
  const register = async id => { assert.match(id, CANVAS_ID); ownIds.add(id); journal.ownIds = [...ownIds]; report.ownIds = [...ownIds]; if (mode === 'execute') await saveJournal(); };
  const mutate = async (label, method, body) => {
    assert.ok(safeCanvasMutation(method, body, ownIds), 'OUT_OF_SCOPE_CANVAS_MUTATION');
    const entry = { label, method, body: clone(body), dispatchedAt: new Date().toISOString(), state: 'dispatched' };
    journal.mutations.push(entry); await saveJournal();
    const result = await api('/api/canvas', { method, body: JSON.stringify(body) });
    entry.state = 'responded'; entry.status = result.status; entry.result = clone(result.body); await saveJournal(); return result;
  };
  try {
    const me = await api('/api/auth/me'); assert.ok(me.status === 200 && me.body.user?.role === 'admin', 'NORMAL_CURRENT_ADMIN_REQUIRED');
    const user = me.body.user;
    const localUsers = await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' });
    assert.equal(localUsers.length, 1, 'LOCAL_ADMIN_MATCH_REQUIRED');
    const baseline = await rows('canvas_documents', 'id,name,revision,document,deleted', { owner_id: `eq.${user.id}`, order: 'id.asc' });
    const baselineIds = new Set(baseline.map(row => row.id));
    report.balanceBefore = localUsers[0]; report.originalCanvasCount = baseline.length; report.originalCanvasDigest = hash(baseline);
    report.walletOperationsBefore = await rows('wallet_operations', 'id', { user_id: `eq.${user.id}`, limit: '0' }, true);
    const list = await api('/api/canvas'); assert.equal(list.status, 200); assert.equal(list.body.pagination.limit, 50);
    report.listDefaultLimit = list.body.pagination.limit;
    if (mode === 'inspect') { report.passed = true; await save(); console.log(JSON.stringify({ passed: true, mode, report: reportPath })); return; }

    const seedId = `canvas:${randomUUID()}`, name = `${runId} 文本画布`, renamed = `${name} 改名`, prompt = `${runId} 本轮只验证画布保存。这是一段手动输入的文本，不调用模型，不生成图片或视频。`;
    await register(seedId);
    await stage('seed-isolates-existing-account-canvases', async () => {
      const body = { action: 'save', canvasId: seedId, expectedRevision: 0, idempotencyKey: `canvas-e2e:${runId}:seed`, document: makeTextDocument(seedId, `${runId} 隔离种子`) };
      const response = await mutate('seed', 'POST', body); assert.equal(response.status, 200); assert.equal(response.body.canvas.id, seedId); return { canvasId: seedId };
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1060 }, serviceWorkers: 'block' });
    await context.addInitScript(({ origin, token, user }) => { if (location.origin === origin) { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); } }, { origin, token, user });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (/^\/api\/(?:video\/(?:status|stream|poll)|image\/status|voice-studio\/jobs\/[^/]+\/(?:status|poll))$/u.test(url.pathname)) {
          report.blockedRequests.push({ path: url.pathname, method, reason: 'stateful-status' }); return route.abort();
        }
        return route.continue();
      }
      if (url.origin !== origin || url.pathname !== '/api/canvas' || !['POST', 'DELETE'].includes(method)) {
        if (/generate|compile-script|chat|\/extract/u.test(url.pathname)) report.generationRequests++;
        report.blockedRequests.push({ path: url.origin === origin ? url.pathname : '[external]', method, reason: 'non-canvas-mutation' }); return route.abort();
      }
      try {
        const body = request.postDataJSON();
        if (!safeCanvasMutation(method, body, ownIds, allowNew) || baselineIds.has(body.canvasId) || baselineIds.has(body.sourceCanvasId)) {
          report.blockedRequests.push({ path: '/api/canvas', method, reason: 'not-owned-test-canvas' }); return route.abort();
        }
        if (!ownIds.has(body.canvasId) && body.action === 'save') { assert.ok(allowNew); allowNew = false; await register(body.canvasId); report.uiCanvasId = body.canvasId; }
        const entry = { label: 'browser', method, body: clone(body), dispatchedAt: new Date().toISOString(), state: 'dispatched' };
        journal.mutations.push(entry); await saveJournal();
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
        const result = await response.json(); entry.status = response.status(); entry.state = 'responded'; entry.result = clone(result);
        report.canvasRequests.push({ method, action: body.action || 'delete', canvasId: body.canvasId || body.sourceCanvasId, status: response.status(), code: result.code });
        if (body.action === 'copy' && response.ok() && result.canvas?.id) { assert.ok(!baselineIds.has(result.canvas.id)); await register(result.canvas.id); report.copyCanvasId = result.canvas.id; }
        await saveJournal(); await route.fulfill({ response });
      } catch (error) { routeFailure = Error(clean(error.message)); await route.abort().catch(() => undefined); }
    });
    const openPage = async () => {
      page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
      page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin && url.pathname.startsWith('/api/') && response.status() >= 400) report.httpErrors.push({ path: url.pathname, status: response.status() }); });
      await page.goto(origin + '/free-canvas', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('.free-tool-rail button[title="当前画布"]').waitFor({ timeout: 35000 });
    };
    const menu = async () => { if (!await page.locator('.free-canvas-menu').isVisible()) await page.locator('.free-tool-rail button[title="当前画布"]').click(); await page.locator('.free-canvas-menu article.active').waitFor(); };
    const select = async canvasName => {
      await menu();
      const row = page.locator('.free-canvas-menu article').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${canvasName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u') }) });
      assert.equal(await row.count(), 1, 'UNIQUE_OWN_CANVAS_ROW');
      await row.locator('button').first().click();
      // switchCanvas awaits saving the old canvas before changing activeCanvasId.
      await page.locator('.free-canvas-menu').waitFor({ state: 'hidden', timeout: 25000 });
      await menu();
      assert.equal(await page.locator('.free-canvas-menu article.active input').inputValue(), canvasName, 'REQUESTED_CANVAS_NOT_ACTIVE');
    };
    await openPage();
    await stage('ui-create-text-save', async () => {
      await menu(); await page.locator('.free-canvas-menu article.active input').waitFor();
      await waitFor(async () => await page.locator('.free-canvas-menu article.active input').inputValue() === `${runId} 隔离种子`, 'seed-hydration');
      allowNew = true; await page.getByRole('button', { name: '新建画布', exact: true }).click();
      await waitFor(() => report.uiCanvasId, 'ui-create-dispatch');
      await menu(); await page.locator('.free-canvas-menu article.active input[aria-label="画布名称"]').fill(name);
      await page.locator('.free-tool-rail button[title="当前画布"]').click();
      await page.locator('.free-tool-rail button[title="添加文本节点"]').click();
      await page.locator('.free-node-shell.kind-text textarea').fill(prompt);
      await waitFor(async () => { const canvas = await detail(report.uiCanvasId); return canvas.name === name && canvas.document.session.nodes.some(node => node.data.prompt === prompt); }, 'text-durable');
      return { canvasId: report.uiCanvasId, textPersisted: true };
    });
    await stage('ui-refresh-opens-saved-text', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.free-tool-rail').waitFor();
      await waitFor(async () => await page.locator('.free-node-shell.kind-text textarea').count() && await page.locator('.free-node-shell.kind-text textarea').inputValue() === prompt, 'text-after-refresh');
      await page.screenshot({ path: path.join(out, 'saved-text-refresh.png'), fullPage: true }); return { textMatches: true };
    });
    await stage('ui-rename-copy', async () => {
      await menu(); await page.locator('.free-canvas-menu article.active input[aria-label="画布名称"]').fill(renamed);
      await waitFor(async () => (await detail(report.uiCanvasId)).name === renamed, 'rename-durable');
      await page.locator('.free-canvas-menu article.active button[title="复制账号画布"]').click();
      await waitFor(() => report.copyCanvasId, 'copy-receipt');
      const copied = await detail(report.copyCanvasId); assert.equal(copied.name, `${renamed} 副本`); assert.equal(copied.document.session.nodes[0].data.prompt, prompt);
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.free-tool-rail').waitFor();
      await waitFor(async () => await page.locator('.free-node-shell.kind-text textarea').count() && await page.locator('.free-node-shell.kind-text textarea').inputValue() === prompt, 'copy-after-refresh');
      await menu(); assert.equal(await page.locator('.free-canvas-menu article.active input').inputValue(), `${renamed} 副本`);
      await page.close(); page = null; return { copyCanvasId: report.copyCanvasId, officialCopyApiUsed: true, refreshed: true };
    });
    let winningName;
    await stage('api-concurrent-revision-and-idempotent-save', async () => {
      const before = await detail(report.uiCanvasId), payloads = ['A', 'B'].map(suffix => {
        const document = clone(before.document); document.session.name = `${renamed} 版本${suffix}`;
        return { action: 'save', canvasId: before.id, expectedRevision: before.revision, idempotencyKey: `canvas-e2e:${runId}:race-${suffix}`, document };
      });
      const results = await Promise.all(payloads.map((body, index) => mutate(`race-${index}`, 'POST', body)));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      const winner = results.findIndex(result => result.status === 200), loser = 1 - winner;
      assert.equal(results[loser].body.code, 'REVISION_CONFLICT'); winningName = payloads[winner].document.session.name;
      const after = await detail(before.id); assert.equal(after.revision, before.revision + 1); assert.equal(after.name, winningName);
      const replays = await Promise.all([0, 1].map(index => mutate(`save-replay-${index}`, 'POST', payloads[winner])));
      replays.forEach(result => { assert.equal(result.status, 200); assert.equal(result.body.idempotentReplay, true); assert.equal(result.body.canvas.revision, after.revision); });
      assert.equal((await detail(before.id)).revision, after.revision);
      const changed = clone(payloads[winner]); changed.document.session.name += ' 错误复用';
      const conflict = await mutate('different-payload-same-key', 'POST', changed); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
      return { beforeRevision: before.revision, afterRevision: after.revision, oneWinner: true, staleRejected: true, sameKeyReplay: true, changedPayloadRejected: true };
    });
    await stage('api-copy-replay-creates-no-extra-copy', async () => {
      const original = journal.mutations.find(entry => entry.label === 'browser' && entry.body.action === 'copy'); assert.ok(original?.result?.canvas?.id);
      const response = await mutate('copy-replay', 'POST', original.body); assert.equal(response.status, 200); assert.equal(response.body.idempotentReplay, true); assert.equal(response.body.canvas.id, report.copyCanvasId);
      const current = await rows('canvas_documents', 'id', { owner_id: `eq.${user.id}`, deleted: 'eq.false' });
      assert.equal(current.filter(row => !baselineIds.has(row.id)).length, 3); return { sameCopyId: true, newCanvasCount: 3 };
    });
    await openPage();
    await stage('ui-delete-both-created-canvases', async () => {
      for (const [id, title] of [[report.copyCanvasId, `${renamed} 副本`], [report.uiCanvasId, winningName]]) {
        await select(title); await menu(); await page.locator('.free-canvas-menu article.active button[title="删除画布"]').click();
        await waitFor(async () => (await api(`/api/canvas?canvasId=${encodeURIComponent(id)}`)).status === 404, 'ui-delete');
      }
      await page.close(); page = null; return { deletedViaUi: [report.copyCanvasId, report.uiCanvasId] };
    });
    await stage('cleanup-seed-and-verify-originals-wallet', async () => {
      const seed = await detail(seedId); const result = await mutate('cleanup-seed', 'DELETE', { canvasId: seedId, expectedRevision: seed.revision, idempotencyKey: `canvas-e2e:${runId}:delete-seed` }); assert.equal(result.status, 200);
      const after = await rows('canvas_documents', 'id,name,revision,document,deleted', { owner_id: `eq.${user.id}`, order: 'id.asc' });
      assert.equal(hash(after.filter(row => baselineIds.has(row.id))), report.originalCanvasDigest, 'ORIGINAL_CANVASES_CHANGED');
      assert.ok(after.filter(row => ownIds.has(row.id)).every(row => row.deleted), 'OWN_TEST_CANVAS_NOT_DELETED');
      const afterList = await api('/api/canvas'); assert.equal(afterList.body.pagination.total, list.body.pagination.total);
      report.balanceAfter = (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0];
      report.walletOperationsAfter = await rows('wallet_operations', 'id', { user_id: `eq.${user.id}`, limit: '0' }, true);
      assert.deepEqual(report.balanceAfter, report.balanceBefore, 'BALANCE_CHANGED_DURING_ZERO_COST_RUN');
      assert.equal(report.walletOperationsAfter, report.walletOperationsBefore, 'WALLET_OPERATION_COUNT_CHANGED');
      return { originalCanvasesUnchanged: true, ownTestCanvasesDeleted: true, balancesUnchanged: true, walletOperationDelta: 0 };
    });
    assert.equal(report.generationRequests, 0, 'GENERATION_REQUEST_ATTEMPTED'); assert.equal(report.pageErrors.length, 0, 'BROWSER_PAGE_ERROR');
    report.passed = true;
  } catch (error) {
    report.failure = clean(error.message); report.remainingOwnedCanvasIds = [...ownIds];
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close(); await journalQueue; await save();
  }
  console.log(JSON.stringify({ passed: report.passed, report: reportPath, stages: report.stages.length, generationRequests: report.generationRequests, failure: report.failure }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
