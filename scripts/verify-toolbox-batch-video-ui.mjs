import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const mode = args.includes('--submit-once') ? 'submit-once' : args.includes('--reconcile') ? 'reconcile' : args.includes('--inspect') ? 'inspect' : 'plan';
const arg = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const originalUnknownRunId = 'toolbox-batch-dedup-20260903-01';
const originalSample = 'https://v.douyin.com/h1wY2hTAbmM/';
const caseId = arg('case') || 'ppt6-pinned-public-02';
assert.equal(caseId, 'ppt6-pinned-public-02', 'ONLY_THE_NEW_REVIEWED_PUBLIC_SAMPLE_IS_ELIGIBLE');
// A different genuine public work, verified against its publisher's public Douyin page.
const sample = 'https://www.douyin.com/video/7534269514251373881';
const links = [sample, sample];
if (mode === 'plan') {
  console.log(JSON.stringify({ mode, networkRequests: 0, command: 'node scripts/verify-toolbox-batch-video-ui.mjs --inspect|--submit-once|--reconcile --run-id=<unique-run>',
    actions: 'One normal UI batch with two duplicate lines of a different genuine public video. Existing PPT6 zero-price configuration and one-address one-GET transport are required. Same-run successful inspection is mandatory. The original failed_unknown run is reconciliation-only.', caseId, sample, inputCount: links.length }, null, 2)); process.exit(0);
}
const runId = arg('run-id');
assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId));
assert.ok(mode === 'reconcile' || runId !== originalUnknownRunId, 'ORIGINAL_UNKNOWN_RUN_IS_RECONCILIATION_ONLY');
const inspectionId = arg('inspection-id');
assert.ok(!inspectionId || (['inspect', 'submit-once'].includes(mode) && /^[A-Za-z0-9_-]{1,40}$/u.test(inspectionId)), 'VALID_INSPECTION_ID_REQUIRED');
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000'; assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin));
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'NORMAL_ADMIN_SESSION_REQUIRED');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.supabaseUrl.replace(/\/$/u, ''), 'http://127.0.0.1:54321');
const out = path.resolve('.codex-evidence/toolbox-batch-real-e2e-20260903', runId); await fs.mkdir(out, { recursive: true });
const reportStem = mode === 'inspect' && inspectionId ? `inspect-${inspectionId}` : mode;
const reportPath = path.join(out, `${reportStem}.json`), markerPath = path.join(out, 'batch.dispatch.json');
const report = { runId, mode, origin, at: new Date().toISOString(), passed: false, caseId, inputCount: 2, distinctInputContents: 1, sample,
  extractionPosts: 0, generationRequests: 0, downloadTicketPosts: 0, pageErrors: [], blocked: [], historyStorage: 'browser-localStorage', downloads: [] };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clean = value => String(value || '').split(token).join('[redacted]').split(runtime.serviceRoleKey).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').slice(0, 600);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value;
const rows = async (table, select, filters) => {
  const url = new URL(`${runtime.supabaseUrl}/rest/v1/${table}`); url.searchParams.set('select', select);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` }, signal: AbortSignal.timeout(20000) });
  const body = await response.json(); assert.ok(response.ok && Array.isArray(body), `LOCAL_READ_${table}_FAILED`); return body;
};
const api = async pathname => { const response = await fetch(origin + pathname, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) }); return { status: response.status, body: await response.json() }; };
let browser, page, fatal, responseBody, marker;
const expectedMedia = new Set();
const wait = async (fn, label, timeout = 45000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (fatal) throw fatal; if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw Error(`WAIT_FAILED_${label}`); };
try {
  const me = await api('/api/auth/me'); assert.ok(me.status === 200 && me.body.user?.role === 'admin'); const user = me.body.user;
  const balance = async () => (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0];
  report.balanceBefore = await balance();
  const getOriginal = id => rows('extraction_attempts', 'record_id,client_request_id,state,http_status,response', { record_id: `eq.${id}`, user_id: `eq.${user.id}`, limit: '1' });
  if (mode === 'reconcile') {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); assert.equal(marker.runId, runId);
    report.caseId = marker.caseId || 'original-public-01'; report.sample = marker.sample || originalSample;
    assert.equal(marker.recordId, sha(`${user.id}\u0000${marker.clientRequestId}`), 'ORIGINAL_OWNER_REQUIRED');
    const [record] = await getOriginal(marker.recordId);
    report.persisted = record ? { recordId: record.record_id, state: record.state, httpStatus: record.http_status, resultCount: record.response?.videos?.length || 0,
      perItemSuccess: (record.response?.videos || []).map(item => item.success !== false && Boolean(item.url || item.download_url)), responseSha256: sha(canonical(record.response)) } : null;
    report.passed = Boolean(record?.state === 'succeeded' && report.persisted.resultCount === 2 && report.persisted.perItemSuccess.every(Boolean));
    report.balanceAfter = await balance(); report.reconciliationOnly = true;
  } else {
    const pluginResponse = await api('/api/plugins/active?role=extract_video'); assert.equal(pluginResponse.status, 200);
    const plugin = pluginResponse.body.plugin; assert.ok(plugin && Number(plugin.price_per_use) === 0, 'ZERO_PRICE_VIDEO_PLUGIN_REQUIRED');
    assert.equal(plugin.id, 'c143a392-4e2c-4b22-b03a-8d76f2022bbb', 'ORIGINAL_VERIFIED_PPT6_PLUGIN_REQUIRED');
    const [privatePlugin] = await rows('plugins', 'id,config,cost_price,price_per_use', { id: `eq.${plugin.id}`, is_active: 'eq.true', limit: '1' });
    assert.ok(privatePlugin && privatePlugin.config?.provider === 'ppt6' && privatePlugin.config?.response_format === 'ppt6', 'EXISTING_PPT6_CONFIGURATION_REQUIRED');
    const pluginConfig = privatePlugin.config;
    const endpoint = new URL(pluginConfig.api_base_url);
    assert.equal(endpoint.origin, 'https://apis.ppt6.top', 'SECURE_CONFIGURED_PPT6_ORIGIN_REQUIRED');
    assert.equal(endpoint.pathname, '/', 'ORIGINAL_CONFIGURED_PPT6_PATH_REQUIRED');
    assert.ok(!endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password, 'PPT6_BASE_URL_MUST_NOT_EMBED_CREDENTIALS_OR_QUERY');
    assert.ok(pluginConfig.client_id && pluginConfig.client_secret_key, 'CONFIGURED_PPT6_CREDENTIALS_REQUIRED');
    assert.ok(privatePlugin.cost_price !== null && privatePlugin.cost_price !== undefined, 'EXPLICIT_CONFIGURED_COST_REQUIRED');
    assert.equal(Number(privatePlugin.cost_price), 0, 'EXPECTED_ZERO_CONFIGURED_COST');
    report.plugin = { id: plugin.id, name: plugin.name, pricePerUse: Number(plugin.price_per_use), configuredCost: Number(privatePlugin.cost_price), responseFormat: 'ppt6', endpointOrigin: endpoint.origin, credentialsReady: true, totalConfiguredPrice: 0 };
    report.configurationFingerprint = sha(canonical(privatePlugin));
    const extractSource = await fs.readFile('src/app/api/extract/route.ts', 'utf8');
    const transportSource = await fs.readFile('src/lib/extract-provider-get-once.ts', 'utf8');
    assert.ok(extractSource.includes('withDistinctExtractionLinks') && extractSource.includes('fetchExtractionProviderGetOnce(ppt6Url'), 'BATCH_AND_SINGLE_TRANSPORT_SOURCE_REQUIRED');
    report.localSource = { routeSha256: sha(extractSource), transportSha256: sha(transportSource), runtimeBuildStillRequiresOperatorConfirmation: true };
    if (mode === 'submit-once') {
      const inspected = JSON.parse(await fs.readFile(path.join(out, inspectionId ? `inspect-${inspectionId}.json` : 'inspect.json'), 'utf8'));
      assert.ok(inspected.passed && inspected.uiReady && inspected.caseId === caseId && inspected.sample === sample && inspected.origin === origin, 'SAME_CASE_SUCCESSFUL_INSPECTION_REQUIRED');
      assert.equal(inspected.configurationFingerprint, report.configurationFingerprint, 'PPT6_CONFIGURATION_CHANGED_AFTER_INSPECTION');
      assert.deepEqual(inspected.localSource, report.localSource, 'SOURCE_CHANGED_AFTER_INSPECTION');
      try { await fs.access(markerPath); throw Error('ORIGINAL_MARKER_EXISTS_USE_RECONCILE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true, serviceWorkers: 'block' });
    await context.addInitScript(({ origin, token, user }) => { if (location.origin === origin) { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); } }, { origin, token, user });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
      try {
        assert.equal(mode, 'submit-once', 'INSPECTION_CANNOT_WRITE'); assert.equal(url.origin, origin, 'LOCAL_API_ONLY');
        assert.equal(request.headers().authorization, `Bearer ${token}`, 'NORMAL_SESSION_REQUIRED');
        const body = request.postDataJSON();
        if (url.pathname === '/api/extract' && method === 'POST') {
          assert.equal(report.extractionPosts, 0, 'ONE_BATCH_POST_ONLY'); report.extractionPosts++;
          assert.deepEqual(body.links, links); assert.equal(body.extraction_mode, 'video'); assert.equal(body.douyin_share_text, undefined);
          const key = request.headers()['idempotency-key']; assert.ok(key && body.client_request_id === key);
          const id = sha(`${user.id}\u0000${key}`); assert.equal((await getOriginal(id)).length, 0, 'NEW_UNIQUE_ATTEMPT_REQUIRED');
          marker = { runId, caseId, sample, at: new Date().toISOString(), state: 'dispatched', clientRequestId: key, recordId: id, inputCount: 2, payloadSha256: sha(canonical(body)) };
          const indexDirectory = path.resolve('.codex-evidence/toolbox-batch-real-e2e-20260903/dispatch-index'); await fs.mkdir(indexDirectory, { recursive: true });
          await fs.writeFile(path.join(indexDirectory, `${caseId}.json`), JSON.stringify(marker, null, 2), { flag: 'wx' });
          await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), { flag: 'wx' }); await save();
          const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 190000 }); responseBody = await response.json();
          for (const item of responseBody?.videos || []) for (const value of [item.url, item.download_url]) if (value) expectedMedia.add(value);
          Object.assign(marker, { state: 'responded', status: response.status(), responseSha256: sha(canonical(responseBody)) });
          report.api = { status: response.status(), success: responseBody.success === true, charged: responseBody.charged ?? null, resultCount: responseBody.videos?.length || 0, inputCount: responseBody.input_count, uniqueCount: responseBody.unique_count, duplicateCount: responseBody.duplicate_count, error: clean(responseBody.error) };
          await fs.writeFile(markerPath, JSON.stringify(marker, null, 2)); await save(); return route.fulfill({ response });
        }
        if (url.pathname === '/api/extract/download-ticket' && method === 'POST') {
          assert.ok(expectedMedia.has(body.url) && body.mode === 'download', 'ONLY_BATCH_RETURNED_MEDIA_ALLOWED');
          assert.ok(report.downloadTicketPosts < 2, 'TWO_DOWNLOAD_TICKETS_MAX'); report.downloadTicketPosts++; return route.continue();
        }
        if (/generate|chat|llm|semantic/u.test(url.pathname)) report.generationRequests++;
        throw Error('UNEXPECTED_WRITE_BLOCKED');
      } catch (error) { report.blocked.push({ method, path: url.origin === origin ? url.pathname : '[external]' }); fatal = Error(clean(error.message)); await route.abort(); }
    });
    page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
    await page.goto(origin + '/extract?tab=batch', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.getByRole('heading', { name: '批量提取', exact: true }).waitFor({ timeout: 45000 });
    const settings = page.getByRole('heading', { name: '批量提取', exact: true }).locator('..');
    await settings.getByRole('button', { name: '视频提取', exact: true }).click();
    await settings.locator('textarea').fill(links.join('\n'));
    const submit = settings.getByRole('button', { name: '开始批量提取', exact: true }); assert.ok(await submit.isEnabled());
    report.uiReady = true; await page.screenshot({ path: path.join(out, `${reportStem}-before.png`), fullPage: true });
    if (mode === 'inspect') report.passed = true;
    else {
      await submit.click(); await wait(() => marker?.state === 'responded', 'batch-response', 200000); assert.equal(report.api.status, 200);
      const [persisted] = await getOriginal(marker.recordId); assert.ok(persisted?.state === 'succeeded', 'PERSISTED_SUCCEEDED_REQUIRED');
      assert.equal(sha(canonical(persisted.response)), sha(canonical(responseBody)), 'DURABLE_RESPONSE_MATCH');
      assert.equal(responseBody.videos?.length, 2); assert.ok(responseBody.videos.every(item => item.success !== false && (item.url || item.download_url)), 'BOTH_ITEMS_SUCCESS_REQUIRED');
      assert.equal(responseBody.input_count, 2); assert.equal(responseBody.unique_count, 1); assert.equal(responseBody.duplicate_count, 1);
      assert.deepEqual(responseBody.input_to_unique, [0, 0]);
      await page.getByRole('status').filter({ hasText: '已合并 1 条重复链接，仅处理 1 个唯一链接' }).waitFor({ timeout: 10000 });
      report.duplicateNoticeVisible = true;
      report.persisted = { recordId: persisted.record_id, state: persisted.state, responseMatches: true };
      await wait(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('extract_history') || '[]'))).filter(item => item.id.startsWith('b-') && item.status === 'success').length === 2, 'two-history-items');
      const history = await page.evaluate(() => JSON.parse(localStorage.getItem('extract_history') || '[]'));
      report.historyIds = history.map(item => item.id); assert.equal(new Set(report.historyIds).size, 2);
      await page.getByRole('button', { name: '历史记录', exact: true }).click();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      const selectAll = page.getByRole('checkbox', { name: /^全选/u }); await selectAll.waitFor({ timeout: 45000 });
      const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('extract_history') || '[]'));
      assert.deepEqual(restored.map(item => item.id), report.historyIds); report.historyRefresh = true;
      await selectAll.check();
      const pendingDownloads = [];
      page.on('download', download => {
        const index = pendingDownloads.length;
        pendingDownloads.push((async () => { const filename = path.join(out, `batch-item-${index + 1}.mp4`); await download.saveAs(filename);
          assert.equal(await download.failure(), null); const bytes = await fs.readFile(filename); assert.ok(bytes.length > 1000);
          report.downloads.push({ index: index + 1, bytes: bytes.length, sha256: sha(bytes) }); })());
      });
      await page.getByRole('button', { name: /下载选中/u }).click();
      await wait(() => pendingDownloads.length === 2, 'two-download-events', 75000); await Promise.all(pendingDownloads);
      assert.equal(report.downloads.length, 2); report.balanceAfter = await balance(); assert.deepEqual(report.balanceAfter, report.balanceBefore);
      const ledger = await rows('wallet_ledger_entries', 'operation_id,delta', { user_id: `eq.${user.id}`, idempotency_key: `like.*${marker.clientRequestId}*` });
      report.walletLedgerCount = ledger.length; report.walletDeltas = ledger.map(item => Number(item.delta)); assert.equal(ledger.length, 0);
      await page.screenshot({ path: path.join(out, 'after.png'), fullPage: true });
      assert.equal(report.extractionPosts, 1); assert.equal(report.generationRequests, 0); assert.equal(report.pageErrors.length, 0); report.passed = true;
    }
  }
} catch (error) {
  report.failure = clean(error.message); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
} finally {
  if (marker) report.originalAttempt = { clientRequestId: marker.clientRequestId, recordId: marker.recordId, state: marker.state };
  if (browser) await browser.close(); await save();
}
console.log(JSON.stringify({ passed: report.passed, mode, report: reportPath, extractionPosts: report.extractionPosts, failure: report.failure }));
