import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildDestinationFixture } from './lib/chat-prompt-destination-fixtures.mjs';

const ORIGIN = 'http://127.0.0.1:5000';
const directory = path.resolve('.codex-evidence/admin-full-acceptance-20261030-9592a6d0/agent-push-target-browser');
// Enumerated passive configuration/account reads, shared with the reviewed
// admin read-only harness. Task recovery/history is isolated separately below.
const passiveReads = new Set([
  '/api/version', '/api/auth/me', '/api/member-permissions', '/api/credits', '/api/cash/balance',
  '/api/conversations', '/api/conversations/history', '/api/bots', '/api/categories', '/api/agent-categories',
  '/api/settings', '/api/settings/brand', '/api/settings/ui', '/api/settings/appearance', '/api/settings/layout',
  '/api/settings/video-page', '/api/notifications/user', '/api/settings/admin', '/api/settings/operation-password',
  '/api/admin/access-control/self', '/api/admin/categories', '/api/admin/agents', '/api/cover-models', '/api/llm-models',
  '/api/video/models', '/api/announcements/inbox', '/api/announcements', '/api/announcements/active', '/api/avatars',
]);
const ramReads = new Set(['/api/video/tasks', '/api/video/active-tasks', '/api/video/history', '/api/storyboard/projects', '/api/storyboard/visual-assets', '/api/storyboard/presets']);
const manifest = JSON.parse(await fs.readFile('deploy/manifests/public-assets.v1.json', 'utf8'));
const publicAssets = new Set(manifest.files.map(file => '/' + file.path.replace(/^public\//u, '')));
const known = [
  ['boom', 'agent-1793171231055-r9qzu6', 'storyboard-workbench'],
  ['movie', 'agent-1786633444187-594spj', 'storyboard-workbench'],
  ['high-energy', 'agent-1786843330392-emdjv2', 'storyboard-workbench'],
  ['original-refinement', 'agent-1793173660476-ci8pl8', 'storyboard-workbench'],
  ['architecture-2d', 'agent-1785658026345-k6yy99', 'video'],
  ['architecture-3d', 'agent-1785688061259-4xww99', 'video'],
];
const style = target => ({ fontSize: 17, fixture_unrelated: 'preserve', storyboardPromptHandoff: { enabled: target === 'storyboard-workbench', target } });
const synthetic = target => ({ id: `agent-fixture-destination-${target}`, bot_id: `agent-fixture-destination-${target}`, name: `RAM推送验收-${target}`, description: '仅内存目录验收，不持久化', source: 'llm', category: 'fixture', is_active: true, user_access: 'available', config_revision: 1, preset_fields: [], output_style: style(target), system_prompt: 'RAM synthetic fixture only', model_id: '00000000-0000-4000-8000-000000000001', model: 'fixture' });
const images = ['DEST_IMAGE_1：阳光下的小狗站在门边。', 'DEST_IMAGE_2：小狗回头看向主人。'];
const videos = ['DEST_VIDEO_1：0-5秒小狗向前走，5-10秒停住。', 'DEST_VIDEO_2：0-5秒主人挥手，5-10秒小狗回头。'];
const pair = (i, image = images[i - 1], video = videos[i - 1]) => `## 段落 ${i}\n\n### 生图 Prompt\n\`\`\`text\n${image}\n\`\`\`\n\n### 图生视频 Prompt\n\`\`\`text\n${video}\n\`\`\``;
const output = [pair(1), pair(2)].join('\n\n');
const digest = value => createHash('sha256').update(value).digest('hex');

export function requestDecision(urlText, method, context = {}) {
  const url = new URL(urlText);
  if (url.origin !== ORIGIN) return 'external-block';
  if (!['GET', 'HEAD'].includes(method)) {
    if (url.pathname === '/api/admin/agents' && ['POST', 'PUT'].includes(method)) return 'admin-fixture-write';
    if (url.pathname.startsWith('/api/conversations') || ['/api/operation-events', '/api/announcements/events', '/api/diagnostic-logs'].includes(url.pathname)) return 'fixture-write';
    return 'unknown-write-block';
  }
  if (ramReads.has(url.pathname)) return 'ram-read';
  if (/^\/api\/(?:llm|generate|payment|chat)(?:\/|$)/u.test(url.pathname)) return 'provider-block';
  if (url.pathname === '/api/settings/admin' && !['brand', 'models', 'prompts'].includes(url.searchParams.get('scope'))) return 'unknown-read-block';
  if (passiveReads.has(url.pathname)) return 'local-read';
  if (url.pathname.startsWith('/_next/static/') && /^\/_next\/static\/[A-Za-z0-9_./-]+$/u.test(url.pathname) && !url.pathname.includes('/../')) return 'local-read';
  if (publicAssets.has(url.pathname)) return 'local-read';
  if (['/', '/video', '/storyboard-workbench'].includes(url.pathname)) return 'local-read';
  if (url.pathname === '/admin' && url.searchParams.get('tab') === 'agents') return 'local-read';
  if (url.pathname === '/admin/extraction-reconciliation' && context.resourceType === 'fetch' && context.headers?.rsc === '1' && context.headers?.['next-router-prefetch'] === '1') return 'ram-prefetch';
  return 'unknown-read-block';
}

export function selfTest() {
  let positive = 0, negative = 0;
  for (const method of ['GET', 'HEAD']) { assert.equal(requestDecision(ORIGIN + '/api/bots?shape=agents', method), 'local-read'); positive++; }
  for (const method of ['POST', 'PUT']) { assert.equal(requestDecision(ORIGIN + '/api/admin/agents', method), 'admin-fixture-write'); positive++; }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(requestDecision(ORIGIN + '/api/video/generate', method), 'unknown-write-block'); negative++;
    assert.equal(requestDecision('https://provider.invalid/api/admin/agents', method), 'external-block'); negative++;
    assert.equal(requestDecision(ORIGIN + '/api/admin/agents/unknown', method), 'unknown-write-block'); negative++;
  }
  for (const endpoint of ['/api/llm', '/api/generate/x', '/api/payment/x', '/api/chat']) { assert.equal(requestDecision(ORIGIN + endpoint, 'GET'), 'provider-block'); negative++; }
  for (const endpoint of ['/api/video/status', '/api/video/request-status', '/api/video/stream', '/api/image/status', '/api/unknown', '/admin/unknown', '/api/settings/admin?scope=unknown']) for (const method of ['GET', 'HEAD']) { assert.equal(requestDecision(ORIGIN + endpoint, method), 'unknown-read-block'); negative++; }
  for (const endpoint of ramReads) { assert.equal(requestDecision(ORIGIN + endpoint, 'GET'), 'ram-read'); positive++; }
  assert.equal(requestDecision(ORIGIN + '/admin/extraction-reconciliation', 'GET'), 'unknown-read-block'); negative++;
  assert.equal(requestDecision(ORIGIN + '/admin/extraction-reconciliation', 'GET', { resourceType: 'fetch', headers: { rsc: '1', 'next-router-prefetch': '1' } }), 'ram-prefetch'); positive++;
  assert.equal((output.match(/```text/gu) || []).length, 4); positive++;
  assert.equal(known.length, 6); positive++;
  assert.notEqual(synthetic('video').id, synthetic('storyboard-workbench').id); positive++;
  for (const reference of [false, true]) {
    const fixture = buildDestinationFixture({ reference, segments: 12 });
    assert.equal(fixture.narrations.length, 12); assert.equal(fixture.videoPrompts.length, 12);
    assert.equal((fixture.replyText.match(/三视图生图 Prompt/gu) || []).length, reference ? 2 : 0); positive++;
  }
  return { passed: true, positive, negative, networkRequests: 0, browserLaunched: false };
}

export async function main(args = [], options = {}) {
  if (args.includes('--self-test')) { assert.deepEqual(args, ['--self-test']); console.log(JSON.stringify(selfTest())); return; }
  if (args.length === 0 || args.includes('--plan')) {
    assert.ok(args.length === 0 || args.length === 1);
    console.log(JSON.stringify({ mode: 'plan', execute: false, origin: ORIGIN, known, viewport: { width: 1440, height: 900 },
      requirements: ['ROOT runningLatest exact build receipt', 'LOCAL_NAV_ADMIN_TOKEN and LOCAL_NAV_READONLY_IDENTITY in RAM', 'independent browser contexts', 'no business POST reaches network'],
      cases: ['6 current-catalog default target labels', '2 RAM-only target agents', 'actual admin create/edit select and intercepted save body', 'video whole reply + second code block same-tab task-card readback', 'storyboard popup owned-envelope receiver preview', 'shared contract fixture boom ordinary/reference 12-pair + 2 assets'],
      evidenceBoundary: 'Real rendered local application and current directory. Auth, output SSE, conversation writes, synthetic admin agent writes are explicitly RAM fixtures; not DB/provider/billing evidence.', directory }, null, 2)); return;
  }
  assert.deepEqual(args, ['--execute'], 'EXPLICIT_EXECUTE_REQUIRED');
  assert.equal(process.env.LOCAL_NAV_ORIGIN || ORIGIN, ORIGIN, 'EXACT_LOOPBACK_REQUIRED');
  const token = options.token || process.env.LOCAL_NAV_ADMIN_TOKEN;
  let identity = options.identity;
  if (!identity) { try { identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}'); } catch { throw Error('INVALID_IDENTITY'); } }
  assert.ok(token && identity?.user?.id && identity.user.role === 'admin', 'CONTROLLED_ADMIN_WRAPPER_REQUIRED');
  assert.ok(options.runningLatest === true || process.env.LOCAL_NAV_RUNNING_LATEST === 'true', 'ROOT_CURRENT_BUILD_PROOF_REQUIRED');
  await fs.mkdir(directory, { recursive: true });
  const report = { kind: 'agent-prompt-destination-browser.v1', startedAt: new Date().toISOString(), passed: false, providerCalls: 0, realBusinessWrites: 0, actualDirectoryReads: 0, ramAuthReads: 0, interceptedWrites: 0, deniedWrites: 0, deniedReads: 0, ramRecoveryReads: 0, ramPrefetches: 0, blockedExternal: 0, browserErrors: 0, cases: [], evidenceBoundary: 'RAM auth/SSE/conversation/agent-write/task-recovery fixtures; real directory, rendered controls, browser transfer storage and receiver preview. No generation/payment or DB persistence proof.' };
  const browser = await chromium.launch({ headless: true });
  async function contextFor(target, { admin = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce', locale: 'zh-CN' });
    await context.addCookies([{ name: 'auth_token', value: token, url: ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => { report.deniedReads++; socket.close(); });
    const state = { captures: [], unexpected: [], directorySeen: false };
    const fixtureAgent = synthetic(target?.target || 'video');
    await context.addInitScript(({ tokenValue, user, targetId }) => {
      localStorage.setItem('auth_token', tokenValue); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1');
      const native = window.fetch.bind(window); const encoder = new TextEncoder();
      window.__destinationFixture = { submissions: 0, controller: null,
        emit(text) { const value = this.controller; if (!value) throw Error('FIXTURE_STREAM_NOT_OPEN'); value.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`)); },
        finish() { this.controller.enqueue(encoder.encode('data: {"billing_complete":true}\n\ndata: [DONE]\n\n')); this.controller.close(); } };
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (url.origin !== location.origin || url.pathname !== '/api/llm' || method !== 'POST') return native(input, init);
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : await input.clone().text());
        if (body.agentId !== targetId || ++window.__destinationFixture.submissions !== 1) throw Error('EXACT_SINGLE_FIXTURE_REQUEST_REQUIRED');
        return new Response(new ReadableStream({ start(controller) { window.__destinationFixture.controller = controller; controller.enqueue(encoder.encode('data: {"type":"stream_delivery","stream_delivery":"live"}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
      };
    }, { tokenValue: token, user: identity.user, targetId: target?.id });
    await context.route('**/*', async route => {
      const req = route.request(); const url = new URL(req.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      const decision = requestDecision(req.url(), req.method(), { resourceType: req.resourceType(), headers: req.headers() });
      if (decision === 'external-block') { report.blockedExternal++; return route.abort('blockedbyclient'); }
      if (decision === 'unknown-write-block' || decision === 'provider-block') { state.unexpected.push({ path: url.pathname, method: req.method() }); report.deniedWrites++; return route.abort('blockedbyclient'); }
      if (decision === 'unknown-read-block') { state.unexpected.push({ path: url.pathname, method: req.method() }); report.deniedReads++; return route.abort('blockedbyclient'); }
      if (decision === 'ram-prefetch') { report.ramPrefetches++; return route.fulfill({ status: 204 }); }
      if (decision === 'ram-read' && url.pathname !== '/api/storyboard/projects') {
        report.ramRecoveryReads++;
        return route.fulfill({ status: 200, json: { tasks: [], activeTasks: [], assets: [], presets: [], nextOffset: null, fixtureOnly: true } });
      }
      if (decision === 'fixture-write') { report.interceptedWrites++; return route.fulfill({ status: 200, json: { success: true, fixtureOnly: true } }); }
      if (decision === 'admin-fixture-write') {
        assert.ok(admin, 'UNEXPECTED_ADMIN_WRITE');
        const body = req.postDataJSON(); state.captures.push({ method: req.method(), body }); report.interceptedWrites++;
        Object.assign(fixtureAgent, body, { output_style: { ...style('video'), ...(body.output_style || body.outputStyle || fixtureAgent.output_style) }, config_revision: fixtureAgent.config_revision + 1 });
        return route.fulfill({ status: 200, json: { success: true, agent: fixtureAgent, fixtureOnly: true } });
      }
      if (url.pathname === '/api/auth/me') { report.ramAuthReads++; return route.fulfill({ status: 200, json: { success: true, user: identity.user } }); }
      if (url.pathname === '/api/admin/agents') return route.fulfill({ status: 200, json: { agents: [fixtureAgent], fixtureOnly: true } });
      if (url.pathname === '/api/storyboard/projects') {
        // Keep receiver inspection at its real preview stage. A synthetic
        // unknown lookup blocks automatic cloud import; it proves no save.
        return route.fulfill({ status: url.searchParams.has('id') ? 503 : 200, json: url.searchParams.has('id') ? { code: 'BROWSER_FIXTURE_PREVIEW_ONLY' } : { projects: [], fixtureOnly: true } });
      }
      if (url.pathname === '/api/bots' && url.searchParams.get('shape') === 'agents') {
        const response = await route.fetch({ headers: { ...req.headers(), authorization: `Bearer ${token}` }, maxRedirects: 0, maxRetries: 0 });
        assert.equal(response.status(), 200, 'CURRENT_DIRECTORY_READ_REQUIRED');
        const data = await response.json(); assert.ok(Array.isArray(data.agents), 'CURRENT_DIRECTORY_SHAPE_REQUIRED');
        for (const [, id] of known) assert.ok(data.agents.some(bot => bot.id === id || bot.bot_id === id), 'CATALOG_STABLE_ID_MISSING');
        report.actualDirectoryReads++; state.directorySeen = true;
        data.agents.push(synthetic('video'), synthetic('storyboard-workbench'));
        return route.fulfill({ response, json: data });
      }
      return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } });
    });
    context.on('page', opened => { opened.on('pageerror', () => { report.browserErrors++; }); });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    return { context, page, state };
  }
  async function openChat(page, target) {
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    const card = page.locator(`[data-agent-card-id="${target.id}"]`); await card.waitFor({ state: 'attached' }); await card.scrollIntoViewIfNeeded();
    const button = card.getByRole('button', { name: /^打开智能体：/u });
    const name = (await button.getAttribute('aria-label')).replace(/^打开智能体：/u, ''); await button.click();
    const skip = page.getByRole('button', { name: '跳过', exact: true });
    await page.getByTestId('chat-agent-name').filter({ hasText: name }).or(skip).first().waitFor({ state: 'visible' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    return page.getByRole('textbox', { name: `向 ${name} 发送消息`, exact: true });
  }
  async function deliver(page, input, content = output, userText = '仅浏览器RAM提示词草稿验收') {
    await input.fill(userText); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(() => window.__destinationFixture?.controller !== null);
    await page.evaluate(text => { window.__destinationFixture.emit(text); window.__destinationFixture.finish(); }, content);
    await page.getByTestId('chat-output-status').filter({ hasText: /^已完成$/u }).last().waitFor({ state: 'visible' });
  }
  try {
    for (const [key, id, target] of known) {
      const fixture = await contextFor({ id, target });
      try {
        const input = await openChat(fixture.page, { id }); await deliver(fixture.page, input);
        const button = fixture.page.getByRole('button', { name: target === 'video' ? '推送回复至视频创作' : '推送至分镜工作台', exact: true }).last();
        await button.waitFor({ state: 'visible' });
        report.cases.push({ key, target, currentDirectory: fixture.state.directorySeen, defaultButtonVisible: true, clickAttempted: false, contentIsSynthetic: true });
      } finally { await fixture.context.close(); }
    }
    for (const click of ['whole-reply', 'second-code']) {
      const target = { id: synthetic('video').id, target: 'video' }; const fixture = await contextFor(target);
      try {
        await deliver(fixture.page, await openChat(fixture.page, target));
        const beforePages = fixture.context.pages().length;
        const button = click === 'whole-reply' ? fixture.page.getByRole('button', { name: '推送回复至视频创作', exact: true }) : fixture.page.locator('[data-message-role="assistant"] .render-layer-final .code-block-wrapper').nth(1).locator('.send-video-task-button');
        await button.click(); await fixture.page.waitForURL(ORIGIN + '/video');
        const fields = fixture.page.locator('textarea[placeholder="描述你想要的视频内容..."]');
        await fields.first().waitFor({ state: 'visible' });
        const values = await fields.evaluateAll(nodes => nodes.map(node => node.value));
        const expected = click === 'whole-reply' ? videos : [videos[0]];
        for (const value of expected) assert.ok(values.some(text => text.trim() === value), 'EXACT_VIDEO_PROMPT_CARD_READBACK_REQUIRED');
        for (const image of images) assert.ok(!values.some(text => text.includes(image)), 'IMAGE_PROMPT_MUST_NOT_ENTER_VIDEO');
        assert.equal(fixture.context.pages().length, beforePages, 'VIDEO_SAME_TAB_REQUIRED');
        report.cases.push({ key: `video-${click}`, sameTab: true, expectedPrompts: expected.map(digest), readbackExact: true });
      } finally { await fixture.context.close(); }
    }
    {
      const target = { id: synthetic('storyboard-workbench').id, target: 'storyboard-workbench' }; const fixture = await contextFor(target);
      try {
        await deliver(fixture.page, await openChat(fixture.page, target));
        const popupPromise = fixture.context.waitForEvent('page');
        await fixture.page.getByRole('button', { name: '推送至分镜工作台', exact: true }).last().click();
        const popup = await popupPromise;
        await popup.waitForURL(/\/storyboard-workbench\?entry=agent&handoff=storyboard&autoImport=1&handoffId=/u);
        await popup.getByTestId('agent-storyboard-handoff-preview').waitFor({ state: 'visible' });
        assert.equal(await popup.evaluate(() => window.opener === null), true, 'POPUP_OPENER_MUST_BE_SEVERED');
        const body = await popup.getByTestId('agent-storyboard-handoff-preview').innerText(); assert.ok(body.includes('确认') && body.includes('提示词草稿'), 'DRAFT_WARNING_AND_CONFIRMATION_REQUIRED');
        report.cases.push({ key: 'explicit-storyboard-popup', receiverPreviewVisible: true, unverifiedDraftLabel: true, openerSevered: true, cloudImportPreventedByRamUnknownLookup: true, realProjectPersistenceProven: false });
      } finally { await fixture.context.close(); }
    }
    for (const reference of [false, true]) {
      const supplied = buildDestinationFixture({ reference, segments: 12 });
      const target = { id: known[0][1], target: 'storyboard-workbench' }; const fixture = await contextFor(target);
      try {
        await deliver(fixture.page, await openChat(fixture.page, target), supplied.replyText, supplied.cardText);
        const popupPromise = fixture.context.waitForEvent('page');
        await fixture.page.getByRole('button', { name: '推送至分镜工作台', exact: true }).last().click();
        const popup = await popupPromise;
        await popup.waitForURL(/\/storyboard-workbench\?entry=agent&handoff=storyboard&autoImport=1&handoffId=/u);
        const preview = popup.getByTestId('agent-storyboard-handoff-preview'); await preview.waitFor({ state: 'visible' });
        const text = await preview.innerText();
        assert.ok(text.includes('12 个生产段'), 'ALL_TWELVE_SEGMENTS_IN_RECEIVER_REQUIRED');
        assert.equal(text.includes('含 2 个视觉资产'), reference, 'REFERENCE_ASSETS_RECEIVER_COUNT_REQUIRED');
        const payloadProof = await popup.evaluate(({ imagePrompts, videoPrompts, sourceScript }) => {
          const id = new URL(location.href).searchParams.get('handoffId');
          const matches = Object.keys(localStorage).map(key => { try { return { key, value: JSON.parse(localStorage.getItem(key)) }; } catch { return null; } }).filter(row => row?.value?.handoff_id === id);
          if (matches.length !== 1) return { matched: false };
          const raw = JSON.stringify(matches[0].value.payload);
          return { matched: true, allImages: imagePrompts.every(prompt => raw.includes(JSON.stringify(prompt).slice(1, -1))), allVideos: videoPrompts.every(prompt => raw.includes(JSON.stringify(prompt).slice(1, -1))), originalCard: raw.includes(JSON.stringify(sourceScript).slice(1, -1)) };
        }, { imagePrompts: supplied.imagePrompts, videoPrompts: supplied.videoPrompts, sourceScript: supplied.input.segmented_script });
        assert.deepEqual(payloadProof, { matched: true, allImages: true, allVideos: true, originalCard: true });
        report.cases.push({ key: reference ? 'boom-reference-assets-12-pairs' : 'boom-ordinary-12-pairs', receiverPreviewVisible: true, segments: 12, assets: reference ? 2 : 0, payloadProof, syntheticNotProviderOutput: true, cloudImportPreventedByRamUnknownLookup: true });
      } finally { await fixture.context.close(); }
    }
    // The real editor is exercised against a RAM-only agent. Never open or save
    // existing agents: all admin-list reads here are the single synthetic row.
    {
      const fixture = await contextFor({ target: 'video' }, { admin: true });
      try {
        await fixture.page.goto(ORIGIN + '/admin?tab=agents', { waitUntil: 'domcontentloaded' });
        await fixture.page.getByRole('button', { name: '+ 添加智能体', exact: true }).click();
        const selector = fixture.page.getByRole('combobox', { name: '提示词推送目标', exact: true });
        await selector.selectOption('storyboard-workbench'); assert.equal(await selector.inputValue(), 'storyboard-workbench');
        await selector.selectOption('video'); assert.equal(await selector.inputValue(), 'video');
        await fixture.page.getByPlaceholder('请填写App名称', { exact: true }).fill(synthetic('video').name);
        await fixture.page.getByRole('button', { name: '确认新增', exact: true }).click();
        await fixture.page.waitForFunction(() => !document.querySelector('[aria-label="提示词推送目标"]'));
        assert.equal(fixture.state.captures.length, 1, 'ONE_SYNTHETIC_CREATE_CAPTURE_REQUIRED');
        assert.equal(fixture.state.captures[0].method, 'POST');
        const createdStyle = fixture.state.captures[0].body.output_style || fixture.state.captures[0].body.outputStyle;
        assert.deepEqual(createdStyle.storyboardPromptHandoff, { enabled: false, target: 'video' });
        const row = fixture.page.locator('tr').filter({ hasText: synthetic('video').name });
        await row.getByRole('button', { name: '编辑', exact: true }).click();
        await selector.selectOption('storyboard-workbench');
        await fixture.page.getByRole('button', { name: '保存修改', exact: true }).click();
        await fixture.page.waitForFunction(() => !document.querySelector('[aria-label="提示词推送目标"]'));
        assert.equal(fixture.state.captures.length, 2, 'ONE_SYNTHETIC_EDIT_CAPTURE_REQUIRED');
        const captured = fixture.state.captures[1]; const saved = captured.body.output_style || captured.body.outputStyle;
        assert.equal(captured.method, 'PUT'); assert.deepEqual(saved, style('storyboard-workbench'));
        report.cases.push({ key: 'admin-create-select-edit-save', createBothOptionsSelected: true, createSaveBodyCaptured: true, editSaveBodyCaptured: true, unrelatedStylePreserved: true, fixtureOnly: true });
      } finally { await fixture.context.close(); }
    }
    assert.equal(report.deniedWrites, 0, 'UNEXPECTED_REQUEST_BLOCKED');
    assert.equal(report.deniedReads, 0, 'UNKNOWN_READ_BLOCKED');
    assert.equal(report.blockedExternal, 0, 'EXTERNAL_REQUEST_BLOCKED');
    assert.equal(report.browserErrors, 0, 'APPLICATION_PAGE_ERRORS');
    report.passed = true;
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = /^[A-Z][A-Z0-9_]+$/u.test(error?.message || '') ? error.message : 'DESTINATION_BROWSER_ASSERTION_FAILED'; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await browser.close(); console.log(JSON.stringify({ passed: report.passed, status: report.status, cases: report.cases.length, report: path.join(directory, 'report.json'), providerCalls: 0, realBusinessWrites: 0 })); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(() => { console.error('AGENT_DESTINATION_BROWSER_FAILED'); process.exitCode = 1; });
