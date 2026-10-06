import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// Normal browser only. The app creates its own key; the runner records it before
// allowing exactly one POST. No JWT, password, provider URL, or DB key is saved.
const origin = 'http://127.0.0.1:5000';
const runtimePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const sample = 'https://v.douyin.com/h1wY2hTAbmM/';
const mode = process.argv.includes('--replay-completed') ? 'replay-completed' : process.argv.includes('--submit-once') ? 'submit-once' : process.argv.includes('--inspect') ? 'inspect' : 'plan';
const extractionMode = process.argv.includes('--video') ? 'video' : 'text';
const requestedRecord = process.argv.find(x => x.startsWith('--record-id='))?.slice(12);
const runId = process.argv.find(x => x.startsWith('--run-id='))?.slice(9);
const hash = x => createHash('sha256').update(x).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
if (mode === 'plan') {
  console.log(JSON.stringify({ mode, networkRequests: 0, origin, sample, command: 'node scripts/verify-toolbox-text-e2e.mjs --inspect|--submit-once --run-id=<unique-safe-name>', credentials: 'LOCAL_NAV_ADMIN_TOKEN in process environment only' }));
  process.exit(0);
}
assert.ok(runId && /^[a-zA-Z0-9_-]{6,100}$/.test(runId), 'A fixed safe run-id is required');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.ok(token, 'Normal local admin session required');
const cfg = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).hostname, '127.0.0.1');
assert.equal(new URL(cfg.supabaseUrl).port, '54321');
const dbHeaders = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
const out = path.resolve('.codex-evidence/toolbox-real-e2e-20260902', runId);
await fs.mkdir(out, { recursive: true });
const reportFile = path.join(out, `${mode}.json`);
const marker = path.join(out, 'submission-dispatched.json');
const report = { at: new Date().toISOString(), mode, extractionMode, origin, sample, credentialPersistence: false, privateMediaUrlsPersisted: false, extractionPosts: 0, pageErrors: [], requests: [], failedRequests: [], navigations: [] };
const clean = value => String(value || '').split(token).join('[redacted]').replace(/https?:\/\/\S+/g, '[url]').replace(/\b1[3-9]\d{9}\b/g, '[phone]').slice(0, 700);
const save = async () => fs.writeFile(reportFile, JSON.stringify(report, null, 2));
async function rows(table, select, filters = {}) {
  const url = new URL(`${cfg.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  const response = await fetch(url, { headers: dbHeaders, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  assert.ok(response.ok && Array.isArray(body), `Local ${table} read failed ${response.status}`);
  return body;
}
const me = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
const auth = await me.json();
assert.ok(me.ok && auth.user?.role === 'admin' && auth.user?.is_active !== false, 'Current normal admin required');
const userId = auth.user.id;
const expectedPayload = { links: [sample], extraction_mode: extractionMode, ...(extractionMode === 'text' ? { douyin_share_text: sample } : {}) };
let completed = null;
if (mode === 'replay-completed') {
  assert.ok(requestedRecord && /^[a-f0-9]{64}$/.test(requestedRecord), 'Original completed record required');
  [completed] = await rows('extraction_attempts', 'record_id,client_request_id,payload_fingerprint,state,response,http_status', { record_id: `eq.${requestedRecord}`, user_id: `eq.${userId}`, limit: '1' });
  assert.equal(completed?.state, 'succeeded', 'Only a completed original task may be replayed');
  assert.equal(completed.http_status, 200);
  assert.equal(completed.payload_fingerprint, hash(JSON.stringify({ kind: 'single', payload: canonical(expectedPayload) })));
  report.originalSucceededRecord = completed.record_id;
}
const balance = async () => (await rows('users', 'cash_balance,credits', { id: `eq.${userId}`, limit: '1' }))[0];
async function readAccountHistory() {
  const response = await fetch(`${origin}/api/extract/history`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, 'Account extraction history must be readable');
  assert.ok(Array.isArray(payload.records), 'Account extraction history records are required');
  return payload.records;
}
async function waitForAccountHistory(recordId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const records = await readAccountHistory();
    const record = records.find(item => item?.id === recordId);
    if (record) return record;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Persisted account extraction history did not refresh');
}
report.auth = { normalAdmin: true, localUserMatched: (await rows('users', 'id', { id: `eq.${userId}`, limit: '1' })).length === 1 };
assert.ok(report.auth.localUserMatched);
report.balanceBefore = await balance();
report.plugins = (await rows('plugins', 'id,role,type,price_per_use,config', { is_active: 'eq.true', role: 'in.(extract_workflow,extract_video,extract_text_third_party,coze_multifunction_extract)' })).map(x => ({ id: x.id, role: x.role, type: x.type, pricePerUse: x.price_per_use, provider: x.config?.provider || null, format: x.config?.response_format || null, host: (() => { try { return new URL(x.config?.api_base_url).host; } catch { return null; } })(), credentialsPresent: !!(x.config?.api_token || x.config?.api_key || x.config?.client_secret_key) }));
await save();
let body = null;
let browser;
try {
  if (mode !== 'inspect') {
    try { await fs.access(marker); throw new Error('EXISTING_DISPATCH_MARKER_READ_ONLY_RECONCILIATION_REQUIRED'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(({ session, user, original, extractionMode, fingerprint }) => {
    localStorage.setItem('auth_token', session);
    localStorage.setItem('auth_user', JSON.stringify(user));
    if (original) localStorage.setItem(`production-client-attempt:v1:extract:${user.id}:${extractionMode}`, JSON.stringify({ clientRequestId: original, fingerprint, updatedAt: Date.now() }));
  }, { session: token, user: auth.user, original: completed?.client_request_id || null, extractionMode, fingerprint: hash(JSON.stringify(canonical(expectedPayload))) });
  const page = await context.newPage();
  page.on('pageerror', e => report.pageErrors.push(clean(e.message)));
  page.on('requestfailed', r => report.failedRequests.push({ path: new URL(r.url()).pathname, method: r.method(), navigation: r.isNavigationRequest(), error: clean(r.failure()?.errorText) }));
  page.on('framenavigated', f => { if (f === page.mainFrame()) report.navigations.push({ at: new Date().toISOString(), path: new URL(f.url()).pathname }); });
  page.on('response', r => { const u = new URL(r.url()); if (u.origin === origin && u.pathname.startsWith('/api/')) report.requests.push({ path: u.pathname, status: r.status() }); });
  await context.route('**/api/extract', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    report.extractionPosts++;
    if (mode === 'inspect' || report.extractionPosts !== 1) { await save(); return route.abort(); }
    const payload = route.request().postDataJSON();
    const key = route.request().headers()['idempotency-key'];
    assert.ok(key && key === payload.client_request_id);
    assert.equal(payload.extraction_mode, extractionMode);
    assert.deepEqual(payload.links, [sample]);
    assert.equal(payload.douyin_share_text, extractionMode === 'text' ? sample : undefined);
    report.clientRequestId = key;
    report.recordId = hash(`${userId}\u0000${key}`);
    report.requestFingerprint = hash(JSON.stringify(payload));
    const prior = await rows('extraction_attempts', 'record_id,state', { record_id: `eq.${report.recordId}`, limit: '1' });
    if (completed) { assert.equal(key, completed.client_request_id); assert.equal(prior.length, 1); assert.equal(prior[0].state, 'succeeded'); }
    else assert.equal(prior.length, 0, 'Existing attempt cannot be resubmitted by this runner');
    await fs.writeFile(marker, JSON.stringify({ at: new Date().toISOString(), clientRequestId: key, recordId: report.recordId, extractionMode, replayOfCompleted: !!completed, sample }), { flag: 'wx' });
    report.dispatchMarkedBeforeNetwork = true;
    await save();
    await route.continue();
  });
  await page.goto(`${origin}/tools?tab=${extractionMode}`, { waitUntil: 'load', timeout: 45000 });
  const input = page.getByRole('textbox', { name: extractionMode === 'text' ? '文案分享文本或链接' : '视频分享文本或链接', exact: true });
  await input.waitFor({ timeout: 30000 });
  await input.fill(sample);
  await page.waitForTimeout(600);
  assert.equal(await input.inputValue(), sample);
  const submit = page.getByRole('button', { name: extractionMode === 'text' ? '提取文案' : '开始提取', exact: true });
  report.inputReady = await submit.isEnabled();
  report.ui = { titleShown: await page.getByText(extractionMode === 'text' ? '字幕与文案提取' : '视频链接提取', { exact: true }).isVisible(), submitEnabled: report.inputReady };
  await page.getByRole('tabpanel').screenshot({ path: path.join(out, 'before.png') });
  await save();
  if (mode === 'inspect') {
    report.passed = report.inputReady && report.extractionPosts === 0 && report.pageErrors.length === 0;
  } else {
    const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/extract' && r.request().method() === 'POST', { timeout: 210000 });
    await submit.click();
    const response = await responsePromise;
    try { body = await response.json(); } catch { body = null; }
    report.api = { http: response.status(), success: body?.success === true, source: body?.source || body?.channel || null, mode: body?.mode || null, charged: typeof body?.charged === 'boolean' ? body.charged : null, error: clean(body?.error || body?.message || ''), errorCode: body?.error_code || body?.code || null, replayed: response.headers()['x-extraction-replayed'] || null, attemptHeaderMatches: response.headers()['x-extraction-attempt-id'] === report.recordId, texts: Array.isArray(body?.texts) ? body.texts.map(t => ({ success: t.success, source: t.source || null, content: clean(t.content), originalLength: (t.content || '').length, title: clean(t.title), error: clean(t.error) })) : [] };
    if (completed) { assert.equal(report.api.replayed, 'true'); assert.ok(same(body, completed.response)); report.newProviderSubmissions = 0; }
    if (extractionMode === 'video') {
      const video = body?.videos?.find(v => v.success !== false && (v.temporary_url || v.asset_id || v.download_url || v.url));
      assert.ok(video, 'Original video result required');
      if (video.temporary_url) {
        assert.match(String(video.temporary_url), /^\/api\/extract\/local-video\?/u, 'A signed local temporary video is required');
        assert.ok(Number(video.temporary_expires_at) > Date.now(), 'Temporary video expiry is required');
      } else {
        assert.match(String(video.asset_id || ''), /^[A-Za-z0-9_-]{1,160}$/u, 'A durable owned video asset is required');
      }
      await page.getByRole('button', { name: '下载视频', exact: true }).waitFor({ timeout: 15000 });
      report.ui.videoResultShown = true;
      await page.getByRole('button', { name: '复制链接', exact: true }).click();
      report.ui.clipboardMatches = await page.evaluate(() => navigator.clipboard.readText()) === (video.temporary_url || video.url || video.download_url);
      const downloading = page.waitForEvent('download', { timeout: 60000 });
      await page.getByRole('button', { name: '下载视频', exact: true }).click();
      const download = await downloading;
      const downloadFailure = await download.failure();
      report.download = { completed: downloadFailure === null, failure: downloadFailure };
      if (!downloadFailure) { const file = await download.path(); report.download.bytes = (await fs.stat(file)).size; }
      else {
        // This is the same signed media GET, never another extraction request.
        const get = await context.request.get(download.url(), { timeout: 65000 });
        const bytes = await get.body();
        report.download.sameTicketGet = { status: get.status(), contentType: get.headers()['content-type'] || null, declaredBytes: Number(get.headers()['content-length'] || 0), bytes: bytes.length };
      }
      const saved = await waitForAccountHistory(report.recordId);
      assert.equal(saved.mode, 'video');
      assert.equal(saved.status, 'success');
      const savedVideo = saved.result?.videos?.find(item => video.temporary_url
        ? item.temporary_url === video.temporary_url
        : item.asset_id === video.asset_id);
      assert.ok(savedVideo);
      report.history = { storage: 'account-database', matched: true, id: saved.id, deliveryMatched: true, temporary: Boolean(video.temporary_url) };
      await page.getByRole('button', { name: '历史记录', exact: true }).click();
      const historyRow = page.locator(`[data-extract-history-id="${report.recordId}"]`);
      await historyRow.waitFor({ timeout: 30000 });
      report.history.rowShown = await historyRow.isVisible();
      await historyRow.click();
      report.history.expandedDownloadShown = await historyRow.getByRole('button', { name: '下载视频', exact: true }).isVisible();
      await page.reload({ waitUntil: 'load', timeout: 45000 });
      await page.getByRole('button', { name: '历史记录', exact: true }).click();
      const refreshedRow = page.locator(`[data-extract-history-id="${report.recordId}"]`);
      await refreshedRow.waitFor({ timeout: 30000 });
      report.history.refreshResultMatches = await refreshedRow.isVisible();
      report.history.refreshRecordMatches = (await readAccountHistory()).some(item => item.id === saved.id && item.status === 'success' && item.result?.videos?.some(entry => video.temporary_url
        ? entry.temporary_url === video.temporary_url
        : entry.asset_id === video.asset_id));
      await page.getByRole('tabpanel').screenshot({ path: path.join(out, 'after.png') });
      report.passed = report.ui.clipboardMatches && report.download.completed && report.download.bytes > 0 && report.history.rowShown && report.history.expandedDownloadShown && report.history.refreshRecordMatches && report.history.refreshResultMatches && report.extractionPosts === 1;
    } else {
    const text = body?.texts?.find(t => t.success !== false && typeof t.content === 'string' && t.content.trim())?.content || '';
    report.transcript = { length: text.length, sha256: text ? hash(text) : null, distinctFromTitle: !!text && body.texts.every(t => !t.title || t.content !== t.title), fallbackOrErrorMarkers: /ASR.*失败|兜底|提取失败|无可用音频/.test(text) };
    if (text) await fs.writeFile(path.join(out, 'extracted-body.txt'), text.replace(/\b1[3-9]\d{9}\b/g, '[phone]'));
    await page.waitForTimeout(700);
    report.ui.resultTextShown = !!text && (await page.getByRole('tabpanel').innerText()).includes(text);
    if (report.ui.resultTextShown) {
      await page.getByRole('button', { name: '复制', exact: true }).click();
      report.ui.clipboardMatches = await page.evaluate(() => navigator.clipboard.readText()) === text;
    }
    const records = await readAccountHistory();
    const saved = records.find(x => x.id === report.recordId && x.mode === 'text' && x.result?.texts?.some(t => t.content === text));
    report.history = { storage: 'account-database', matched: !!saved, id: saved?.id || null, status: saved?.status || null };
    if (saved && text) {
      await page.getByRole('button', { name: '历史记录', exact: true }).click();
      const historyRow = page.locator(`[data-extract-history-id="${saved.id}"]`);
      await historyRow.waitFor({ timeout: 30000 });
      await historyRow.click();
      report.history.expandedBodyMatches = (await historyRow.innerText()).includes(text);
      await page.reload({ waitUntil: 'load', timeout: 45000 });
      await page.getByRole('button', { name: '历史记录', exact: true }).click();
      const refreshedRow = page.locator(`[data-extract-history-id="${saved.id}"]`);
      await refreshedRow.waitFor({ timeout: 30000 });
      await refreshedRow.click();
      report.history.refreshResultMatches = (await refreshedRow.innerText()).includes(text);
      report.history.refreshRecordMatches = (await readAccountHistory()).some(x => x.id === saved.id && x.result?.texts?.some(t => t.content === text));
    }
    await page.getByRole('tabpanel').screenshot({ path: path.join(out, 'after.png') });
    report.passed = response.ok() && report.api.success && text.length > 20 && report.transcript.distinctFromTitle && !report.transcript.fallbackOrErrorMarkers && report.ui.resultTextShown && report.ui.clipboardMatches && report.history.refreshRecordMatches && report.history.refreshResultMatches && report.extractionPosts === 1;
    }
  }
} catch (e) { report.passed = false; report.failure = { name: e.name, message: clean(e.message) }; }
finally {
  if (report.recordId) {
    const attempts = await rows('extraction_attempts', 'record_id,state,http_status,response,provider_evidence', { record_id: `eq.${report.recordId}`, limit: '1' }).catch(() => []);
    report.persisted = attempts.map(x => ({ recordId: x.record_id, state: x.state, httpStatus: x.http_status, responseMatches: !!body && same(x.response, body), textCount: x.response?.texts?.length || 0 }));
    const ledger = await rows('wallet_ledger_entries', 'operation_id,delta,balance_before,balance_after', { user_id: `eq.${userId}`, idempotency_key: `like.*${report.clientRequestId}*` }).catch(() => null);
    report.wallet = { ledgerCount: ledger?.length ?? null, deltas: ledger?.map(x => x.delta) || [] };
  }
  report.balanceAfter = await balance().catch(() => null);
  report.finishedAt = new Date().toISOString();
  await save();
  await browser?.close();
  console.log(JSON.stringify({ report: path.relative(process.cwd(), reportFile), passed: report.passed, posts: report.extractionPosts, api: report.api ? { http: report.api.http, success: report.api.success } : null, failure: report.failure || null }));
  if (!report.passed) process.exitCode = 1;
}
