import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// Browser regression only: all video submissions/history/status/stream responses
// are isolated fixtures. Normal JWT only initializes the existing page/account.
// This does not prove a real generated asset, upstream success, or billing.
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
if (!['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin)) throw new Error('EXACT_LOCAL_ORIGIN_REQUIRED');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
if (!token) throw new Error('NORMAL_SESSION_REQUIRED');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = '.codex-evidence/video-explicit-retry-20260903'; await fs.mkdir(directory, { recursive: true });
const output = `${directory}/browser-fixtures-${Date.now()}.json`;
const report = { at: new Date().toISOString(), origin, scope: 'real-browser-isolated-api-fixtures', realGenerationRequests: 0,
  realStatusOrStreamRequests: 0, databaseWrites: 0, cases: [], passed: false,
  sourceSha256: sha(await fs.readFile('src/app/video/page.tsx')) };
const read = async pathname => {
  const response = await fetch(origin + pathname, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`READ_HTTP_${response.status}`); return response.json();
};
const me = await read('/api/auth/me');
if (me.user?.role !== 'admin' || !me.user.id) throw new Error('CURRENT_ADMIN_REQUIRED');
const catalog = await read('/api/video/models?surface=video-page');
const model = catalog.models?.find(item => item.capabilities?.available === true && item.capabilities.supportsPrompt === true
  && !item.capabilities.requiresImage && !item.capabilities.requiresFirstFrame && !item.capabilities.requiresLastFrame
  && !item.capabilities.requiresSourceVideo && !item.capabilities.minReferenceAudios && !item.capabilities.minReferenceImages);
if (!model?.id) throw new Error('PUBLIC_TEXT_VIDEO_MODEL_REQUIRED');
report.publicModelId = model.id;
const scenarios = [
  { name: 'completed-whole-event', kind: 'stream', terminal: 'completed', chunks: 'whole' },
  { name: 'completed-each-utf8-byte', kind: 'stream', terminal: 'completed', chunks: 'byte' },
  { name: 'completed-cr-lf-boundaries', kind: 'stream', terminal: 'completed', chunks: 'crlf' },
  { name: 'completed-final-event-at-eof', kind: 'stream', terminal: 'completed', chunks: 'eof' },
  { name: 'failed-retry-flag-omitted-no-second-post', kind: 'stream', terminal: 'failed', chunks: 'byte' },
  { name: 'failed-retry-flag-false-no-second-post', kind: 'stream', terminal: 'failed', chunks: 'byte', retryable: false },
  { name: 'failed-retry-flag-true-no-second-post', kind: 'stream', terminal: 'failed', chunks: 'byte', retryable: true },
  { name: 'wallet-402-requests-recharge', kind: 'http', code: 'INSUFFICIENT_CASH_BALANCE', recharge: true },
  { name: 'upstream-402-does-not-request-recharge', kind: 'http', code: 'UPSTREAM_QUOTA_EXHAUSTED', recharge: false },
  { name: 'untyped-402-does-not-request-recharge', kind: 'http', recharge: false },
];
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    const result = { name: scenario.name, passed: false, pageErrors: [], escapedMutations: [], escapedVideoReads: [] };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    await context.addInitScript(({ origin, token, user, modelId, scenario }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem(`app_state_video_selected_model:user:${encodeURIComponent(user.id)}`, JSON.stringify(modelId));
      const state = { posts: [], streamGets: 0, statusGets: 0, rechargeEvents: 0, chunkSizes: [], taskId: `fixture_${scenario.name}`, originalStreamModel: '', cancelledStream: false };
      window.__videoStreamFixture = state;
      window.addEventListener('insufficient-balance', () => { state.rechargeEvents++; });
      const native = window.fetch.bind(window), encode = new TextEncoder();
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, options) => {
        const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(address, location.href), method = String(options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (url.origin !== origin) return native(input, options);
        if (url.pathname === '/api/video/history') return json({ tasks: [], total: 0, hasMore: false });
        if (url.pathname === '/api/video/generate' && method === 'POST') {
          const body = JSON.parse(String(options?.body || '{}'));
          state.posts.push({ modelId: body.model_id, clientKey: body.client_request_id });
          if (state.posts.length > 1) return json({ error: 'Fixture detected automatic duplicate submission', code: 'FIXTURE_SECOND_POST_BLOCKED' }, 409);
          if (scenario.kind === 'http') return json({ error: '隔离回归：请求被拒绝', ...(scenario.code ? { code: scenario.code } : {}) }, 402);
          return json({ task_id: state.taskId, business_task_id: state.taskId, model_id: body.model_id, status: 'queued' });
        }
        if (url.pathname === '/api/video/status') { state.statusGets++; return json({ taskId: state.taskId, status: 'processing' }); }
        if (url.pathname === '/api/video/stream') {
          state.streamGets++; state.originalStreamModel = url.searchParams.get('modelId');
          const common = { taskId: state.taskId, status: scenario.terminal };
          const terminal = scenario.terminal === 'failed'
            ? { ...common, errorMessage: '隔离回归：原模型明确失败，中文字符保持完整', ...(scenario.retryable === undefined ? {} : { retryable: scenario.retryable }) }
            : { ...common, videoUrl: '', storageUrl: '', message: '隔离回归：中文完成终态' };
          const terminalJson = JSON.stringify(terminal), split = terminalJson.indexOf(',') + 1;
          const wire = ': fixture comment\r\nevent: heartbeat\r\ndata: {}\r\n\r\n'
            + `id: fixture-progress\r\nevent: progress\r\ndata: ${JSON.stringify({ taskId: state.taskId, status: 'processing', progress: 25 })}\r\n\r\n`
            + `id: fixture-terminal\r\nevent: ${scenario.terminal}\r\ndata: ${terminalJson.slice(0, split)}\r\ndata: ${terminalJson.slice(split)}`
            + (scenario.chunks === 'eof' ? '' : '\r\n\r\n');
          const bytes = encode.encode(wire), chunks = [];
          if (scenario.chunks === 'byte') for (let i = 0; i < bytes.length; i++) chunks.push(bytes.slice(i, i + 1));
          else if (scenario.chunks === 'crlf') { let start = 0; for (let i = 0; i < bytes.length; i++) if (bytes[i] === 13) { chunks.push(bytes.slice(start, i + 1)); start = i + 1; } if (start < bytes.length) chunks.push(bytes.slice(start)); }
          else chunks.push(bytes);
          return new Response(new ReadableStream({
            start(controller) { for (const chunk of chunks) { state.chunkSizes.push(chunk.length); controller.enqueue(chunk); } controller.close(); },
            cancel() { state.cancelledStream = true; },
          }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return native(input, options);
      };
    }, { origin, token, user: me.user, modelId: model.id, scenario });
    // A second independent guard prevents any fixture escape from invoking real
    // generation or polling/settlement, even if fetch instrumentation is broken.
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {
        result.escapedMutations.push({ path: url.pathname, method: request.method() });
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated browser fixture blocks real writes', code: 'FIXTURE_REAL_WRITE_BLOCKED' }) });
      }
      if (/^\/api\/video\/(?:generate|stream|status|cancel)/.test(url.pathname)) {
        result.escapedVideoReads.push(url.pathname);
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated fixture blocks real status advancement' }) });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => result.pageErrors.push({ name: error.name, message: String(error.message).replaceAll(token, '[redacted]').replace(/https?:\/\/\S+/g, '[url]').slice(0, 220) }));
    try {
      await page.goto(origin + '/video', { waitUntil: 'load', timeout: 60000 });
      // The current video workbench renders the model catalogue as explicit
      // cards rather than a combobox. Bind the fixture to the public model id
      // so ratio/resolution/duration comboboxes cannot be mistaken for model
      // selection as the page evolves.
      const modelButton = page.locator(`[data-video-model-id="${model.id}"]`);
      await modelButton.waitFor({ state: 'visible' });
      if (!(await modelButton.isEnabled())) throw new Error('PUBLIC_TEXT_VIDEO_MODEL_DISABLED');
      await modelButton.evaluate(element => element.click());
      await page.getByLabel('任务1提示词', { exact: true }).fill('隔离浏览器回归：一片树叶缓缓落下，保持原模型。');
      const card = page.getByLabel('任务1提示词', { exact: true }).locator('xpath=ancestor::*[@data-video-task-card][1]');
      await card.getByRole('button', { name: '生成视频', exact: true }).click();
      await page.waitForFunction(() => window.__videoStreamFixture.posts.length > 0);
      await card.getByText(scenario.terminal === 'completed' ? '已完成' : '失败', { exact: true }).waitFor({ timeout: 20000 });
      // Prior automatic retry used a timer. Observe beyond that timer without
      // clicking any retry button, then assert the original model is intact.
      await page.waitForTimeout(4500);
      const state = await page.evaluate(() => window.__videoStreamFixture);
      const selectedCardRetained = await modelButton.evaluate(element => element.className.includes('shadow-[inset_3px_0_var(--primary)]'));
      result.fixturePostCount = state.posts.length; result.originalModelRetained = state.posts[0]?.modelId === model.id && selectedCardRetained;
      result.streamGets = state.streamGets; result.statusGets = state.statusGets; result.chunkCount = state.chunkSizes.length;
      result.maximumChunkBytes = Math.max(0, ...state.chunkSizes); result.rechargeEvents = state.rechargeEvents;
      result.terminalRendered = true;
      if (state.posts.length !== 1 || !result.originalModelRetained) throw new Error('AUTOMATIC_RETRY_OR_MODEL_LOSS');
      if (scenario.kind === 'stream' && (state.streamGets !== 1 || state.originalStreamModel !== model.id || state.statusGets !== 0)) throw new Error('STREAM_TERMINAL_LOST_OR_FALLBACK_POLLED');
      if (scenario.kind === 'http' && state.rechargeEvents !== (scenario.recharge ? 1 : 0)) throw new Error('RECHARGE_CLASSIFICATION_MISMATCH');
      if (result.pageErrors.length || result.escapedVideoReads.length || result.escapedMutations.some(item => item.path === '/api/video/generate')) throw new Error('FIXTURE_ESCAPE_OR_PAGE_ERROR');
      result.passed = true;
    } catch (error) { result.failure = String(error.message).replaceAll(token, '[redacted]').replace(/https?:\/\/\S+/g, '[url]').slice(0, 400); }
    finally { await context.close(); report.cases.push(result); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ name: result.name, passed: result.passed, failure: result.failure || null })); }
  }
  report.passed = report.cases.length === scenarios.length && report.cases.every(item => item.passed);
} finally {
  await browser.close(); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: output, passed: report.passed, scenarios: report.cases.length, realGenerationRequests: 0, realStatusOrStreamRequests: 0 }));
}
if (!report.passed) process.exitCode = 1;
