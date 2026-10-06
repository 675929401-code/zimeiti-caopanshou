import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5000';
const output = process.argv[2];
if (!output) throw new Error('OUTPUT_REQUIRED');
const report = { observedAt: new Date().toISOString(), authentication: 'existing-local-development-session', responseFixtures: false, credentialsSaved: false, generationSubmitted: false, pages: [], endpoints: [], blocked: [], httpErrors: [], pageErrors: [], requestFailures: [], historyRequests: [] };
const advancingGet = new Set(['/api/video/status', '/api/video/poll', '/api/video/stream', '/api/image/status', '/api/admin/voice-studio/voices/sync']);
const safePath = (value) => {
  const url = new URL(value, origin);
  return url.origin === origin ? url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id').replace(/\d{9,}/gu, ':id') : 'external-asset';
};
let browser;
let stage = 'development-session';
try {
  const suppliedToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  const auth = suppliedToken
    ? await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${suppliedToken}` }, signal: AbortSignal.timeout(15000) })
    : await fetch(`${origin}/api/auth/dev-session`, { headers: { 'x-local-workbench': 'ai-creation-studio-local' }, signal: AbortSignal.timeout(15000) });
  const authBody = await auth.json();
  const session = suppliedToken ? { token: suppliedToken, user: authBody.user } : authBody;
  const expectedUsername = process.env.READONLY_UI_EXPECTED_USERNAME?.trim() || session.user?.username;
  if (suppliedToken) report.authentication = 'normal-login-token-verified-via-auth-me';
  if (!auth.ok || !session.token || !expectedUsername || session.user?.username !== expectedUsername || session.user?.role !== 'admin') throw new Error('EXPECTED_ADMIN_SESSION_UNAVAILABLE');
  const headers = { Authorization: `Bearer ${session.token}` };
  for (const endpoint of process.env.READONLY_UI_SKIP_ENDPOINTS === '1' ? [] : ['/api/voice/status', '/api/voice/list?page=1&limit=1', '/api/voice/favorites', '/api/voice/user-voices', '/api/voice/license', '/api/voice/nest', '/api/voice/history?page=1&pageSize=1', '/api/voice/generation-status?requestId=readonly-voice-secondary-20260902', '/api/admin/voice-studio/dashboard', '/api/admin/voice-studio/configs', '/api/admin/voice-studio/models', '/api/admin/voice-studio/voices?page=1&limit=1', '/api/admin/voice-studio/licenses']) {
    stage = safePath(endpoint);
    const response = await fetch(`${origin}${endpoint}`, { headers, signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => ({}));
    const item = { path: stage, status: response.status, ...(body.code ? { code: body.code } : {}) };
    if (stage === '/api/voice/status') item.readiness = { configured: body.data?.available === true, canSubmit: body.data?.canSubmit === true, schemaReady: body.data?.schemaReady === true };
    if (stage === '/api/voice/list') item.catalog = { total: body.data?.total ?? body.total ?? null, returned: body.data?.voices?.length ?? body.voices?.length ?? null };
    if (stage === '/api/voice/favorites') item.count = body.favorites?.length ?? null;
    if (stage === '/api/voice/user-voices') item.count = body.voices?.length ?? null;
    if (stage === '/api/voice/license') item.hasActiveLicense = body.data?.hasActiveLicense === true;
    if (stage === '/api/voice/history') item.count = body.data?.total ?? null;
    report.endpoints.push(item);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const diagnostic = request.method() === 'POST' && url.origin === origin && url.pathname === '/__nextjs_original-stack-frames';
    if ((request.method() !== 'GET' && !diagnostic) || (url.origin === origin && advancingGet.has(url.pathname))) {
      report.blocked.push({ method: request.method(), path: safePath(url.href) });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
  }, { token: session.token, user: session.user });
  const page = await context.newPage();
  let historyGets = 0;
  const historyRequestState = new Map();
  page.setDefaultTimeout(8000);
  page.on('request', (request) => {
    if (request.method() !== 'GET' || safePath(request.url()) !== '/api/voice/history') return;
    const entry = { stage, path: '/api/voice/history', method: 'GET', startedAt: new Date().toISOString(), outcome: 'pending' };
    historyRequestState.set(request, { entry, started: Date.now() });
    report.historyRequests.push(entry);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || '';
    const reason = failure.match(/(?:net::)?ERR_[A-Z_]+/u)?.[0] || 'REQUEST_FAILED';
    report.requestFailures.push({ stage, path: safePath(request.url()), method: request.method(), reason });
    const state = historyRequestState.get(request);
    if (state) Object.assign(state.entry, { outcome: 'failed', reason, elapsedMs: Date.now() - state.started });
  });
  page.on('requestfinished', (request) => {
    const state = historyRequestState.get(request);
    if (state) Object.assign(state.entry, { outcome: 'finished', elapsedMs: Date.now() - state.started });
  });
  page.on('pageerror', (error) => report.pageErrors.push({ stage, name: error.name }));
  page.on('response', (response) => {
    const state = historyRequestState.get(response.request());
    if (state) Object.assign(state.entry, { status: response.status(), headersAfterMs: Date.now() - state.started });
    if (safePath(response.url()) === '/api/voice/history' && response.status() === 200) historyGets++;
    if (response.status() >= 400) report.httpErrors.push({ stage, path: safePath(response.url()), status: response.status() });
  });
  const states = ['workspace', 'imitate', 'clone', 'design', 'voices'];
  const paths = [...states.map((name) => `/voice-studio/${name}`), '/voice-studio/admin', ...states.map((name) => `/youcai/voice-studio/${name}`), '/voice-studio', '/voice-studio/nest', '/youcai/voice-studio/nest', '/voice'];
  const selectedPaths = process.env.READONLY_UI_PATHS?.split(',') || paths;
  if (selectedPaths.some((value) => !paths.includes(value))) throw new Error('UNSUPPORTED_READONLY_PATH');
  for (const routePath of selectedPaths) {
    stage = routePath;
    const started = Date.now();
    const response = await page.goto(`${origin}${routePath}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const item = { path: routePath, status: response?.status(), renderedPath: safePath(page.url()), controls: [] };
    try {
      item.browserCapabilities = await page.evaluate(() => ({
        abortSignalAny: typeof AbortSignal.any,
        abortSignalTimeout: typeof AbortSignal.timeout,
        abortController: typeof AbortController,
        fetchType: typeof window.fetch,
        fetchNative: Function.prototype.toString.call(window.fetch).includes('[native code]'),
      }));
      if (routePath !== '/voice') {
        await page.locator('.vs-studio-header').waitFor({ state: 'visible' });
        if (routePath.endsWith('/admin')) await page.getByText('模型配置', { exact: true }).first().waitFor({ state: 'visible' });
        else if (/\/(?:clone|design|nest)$/u.test(routePath)) await page.getByRole('heading', { name: /^音色模仿$/u }).first().waitFor({ state: 'visible' });
        else await page.locator('h1:visible').first().waitFor({ state: 'visible' });
      }
      item.renderedPath = safePath(page.url());
      item.licenseRequired = false;
      if (routePath === '/voice-studio/workspace') {
        await page.getByRole('textbox', { name: '选择音色搜索', exact: true }).waitFor({ state: 'visible' });
        const preview = page.locator('button[title="点击试听"]');
        await preview.first().waitFor({ state: 'visible' });
        item.publicVoiceCardCount = await preview.count();
        item.fileFormats = await page.locator('select[aria-label="音频格式"] option').evaluateAll((options) => options.map((option) => option.value));
        await preview.first().locator('xpath=..').locator('div.flex-1').first().click();
        item.voiceSelection = /shadow-\[0_0_14px/u.test(await preview.first().locator('xpath=..').getAttribute('class') || '');
        for (const label of ['单人模式', '双人对话', '长文本合成', '混音合成', '音频生成']) {
          await page.getByRole('button', { name: new RegExp(label, 'u') }).click();
          const fields = page.locator('textarea:visible');
          const count = await fields.count();
          if (count) {
            const field = fields.first();
            const original = await field.inputValue();
            await field.fill('只读页面验收，不提交。');
            const editable = await field.inputValue() === '只读页面验收，不提交。';
            await field.fill(original);
            item.controls.push({ label, textareaCount: count, editable, maxLength: await field.getAttribute('maxlength') });
          } else item.controls.push({ label, textareaCount: count });
        }
        if (process.env.READONLY_UI_CHECK_HISTORY === '1') {
          item.browserCapabilities = await page.evaluate(() => ({
            abortSignalAny: typeof AbortSignal.any,
            abortSignalTimeout: typeof AbortSignal.timeout,
            abortController: typeof AbortController,
            fetchType: typeof window.fetch,
            fetchNative: Function.prototype.toString.call(window.fetch).includes('[native code]'),
          }));
          const generationId = process.env.READONLY_UI_EXPECTED_GENERATION_ID;
          if (!generationId || !/^[0-9a-f-]{36}$/iu.test(generationId)) throw new Error('EXPECTED_GENERATION_ID_REQUIRED');
          const history = page.getByRole('region', { name: '生成历史', exact: true });
          await history.getByRole('button', { name: '生成历史', exact: true }).click();
          const record = history.locator(`[data-generation-id="${generationId}"]`);
          await record.waitFor({ state: 'visible', timeout: 20000 });
          const player = record.locator('audio');
          await player.evaluate((audio) => audio.load());
          await page.waitForFunction((id) => {
            const audio = document.querySelector(`[data-generation-id="${id}"] audio`);
            return audio && audio.readyState >= 2;
          }, generationId, { timeout: 20000 });
          await player.evaluate((audio) => audio.play());
          await page.waitForFunction((id) => document.querySelector(`[data-generation-id="${id}"] audio`)?.currentTime > 0.15, generationId, { timeout: 10000 });
          item.history = { expectedGenerationFound: true, audioReadyState: await player.evaluate((audio) => audio.readyState), durationSeconds: await player.evaluate((audio) => audio.duration), playbackAdvanced: await player.evaluate((audio) => audio.currentTime > 0.15), downloadLinkPresent: await record.getByRole('link', { name: '下载历史音频', exact: true }).count() === 1 };
          await player.evaluate((audio) => audio.pause());
          item.history.stage = 'refresh-button';
          const refreshedHistory = page.waitForResponse((response) => safePath(response.url()) === '/api/voice/history' && response.status() === 200, { timeout: 20000 });
          await history.getByRole('button', { name: '刷新历史', exact: true }).click();
          await refreshedHistory;
          await record.waitFor({ state: 'visible', timeout: 20000 });
          item.history.refreshButtonRetainsRecord = true;
          item.history.stage = 'reload';
          await page.reload({ waitUntil: 'domcontentloaded' });
          // The voice cards are loaded by a client effect. Wait for hydration
          // before clicking the server-rendered history button after a reload.
          await page.locator('button[title="点击试听"]').first().waitFor({ state: 'visible' });
          item.history.stage = 'reopen';
          await history.getByRole('button', { name: '生成历史', exact: true }).click();
          item.history.stage = 'refreshed-record';
          await record.waitFor({ state: 'visible', timeout: 20000 });
          item.history.refreshRetainsRecord = true;
          item.history.successfulHistoryGetCount = historyGets;
        }
      }
      if (routePath === '/voice-studio/imitate') item.pcmOptionCount = await page.getByRole('button', { name: /^PCM(?:\s|$)/u }).count();
      if (routePath === '/voice-studio/voices') {
        const search = page.getByPlaceholder('搜索音色名称或 speaker_id...');
        await search.fill('Vivi');
        item.controls.push({ label: '目录搜索', editable: await search.inputValue() === 'Vivi' });
        await search.fill('');
        await page.getByRole('button', { name: /我的定制/u }).click();
        item.controls.push({ label: '我的定制', opened: true });
      }
      Object.assign(item, await page.evaluate(() => ({
        overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        inputCount: document.querySelectorAll('input,textarea,select').length,
        navigationCount: document.querySelectorAll('.vs-studio-nav a').length,
        brokenImageCount: [...document.images].filter((image) => image.complete && image.naturalWidth === 0 && image.getBoundingClientRect().width > 0).length,
      })));
    } catch (error) {
      item.error = { name: error.name, type: 'control-or-render-verification' };
      item.domState = {
        visibleHeadings: await page.locator('h1:visible,h2:visible').count(),
        licenseInput: await page.getByPlaceholder('ZY-XXXX-XXXX').count(),
        licenseCheckLoading: await page.getByText('正在检查授权状态...', { exact: true }).count(),
        successfulHistoryGets: historyGets,
        historyExpanded: await page.locator('button[aria-controls="voice-generation-history-content"]').getAttribute('aria-expanded').catch(() => null),
        historyLoading: await page.getByText('正在读取生成历史...', { exact: true }).count(),
        historyError: await page.locator('[data-history-error]').count(),
        historyErrorKind: await page.locator('[data-history-error]').getAttribute('data-history-error').catch(() => null),
        historyErrorName: await page.locator('[data-history-error]').getAttribute('data-history-error-name').catch(() => null),
        historyErrorStage: await page.locator('[data-history-error]').getAttribute('data-history-error-stage').catch(() => null),
        historyErrorElapsedMs: await page.locator('[data-history-error]').getAttribute('data-history-error-ms').catch(() => null),
      };
    }
    item.elapsedMs = Date.now() - started;
    report.pages.push(item);
    console.log(JSON.stringify({ checked: routePath, status: item.status, controlError: Boolean(item.error) }));
  }
} catch (error) {
  report.failure = { stage, name: error.name, reason: error.message.split('\n')[0].replace(/https?:\S+/gu, '[url]') };
} finally {
  if (browser) await browser.close();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
