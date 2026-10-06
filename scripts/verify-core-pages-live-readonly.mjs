#!/usr/bin/env node
// Real local pages and real GET responses only. No response fixtures, screenshots,
// tracing, storageState, generation submission, or configuration save.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = String(process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const expectedUsername = process.env.READONLY_UI_EXPECTED_USERNAME || '';
const injectedAdminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const statefulGetPaths = new Set([
  '/api/video/status', '/api/video/stream', '/api/image/status',
]);
const evidence = {
  observedAt: new Date().toISOString(),
  source: 'LIVE_LOCAL_PAGES_AND_UNMODIFIED_GET_RESPONSES',
  viewport: { width: 1440, height: 1000 },
  authentication: { normalDevSession: false, expectedUserMatched: false },
  policy: {
    businessNonGetRequestsAborted: true, stateAdvancingGetRequestsAborted: true,
    normalGetRequestsAllowed: true, developerStackFrameReadPostAllowed: true, responseFixtures: false,
    storageStateSaved: false, screenshotsSaved: false,
    normalAuthMeFlowAllowed: true,
  },
  pages: [], blockedRequests: [], httpErrors: [], consoleErrorCount: 0, blockedNetworkConsoleErrorCount: 0,
  consoleErrors: [], pageErrors: [], modelMetadata: [], failure: null,
};
let browser;
let session;
let activePage;
let stage = 'session';
const blocked = new Map();
const errors = new Map();

function safePath(url) {
  try {
    return new URL(url).pathname
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id')
      .replace(/\d{9,}/gu, ':id');
  } catch { return '/unknown'; }
}

function increment(map, key) { map.set(key, (map.get(key) || 0) + 1); }

async function layout(page) {
  return page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|应用程序错误/u.test(document.body.innerText),
  }));
}

async function checkInput(input) {
  if (!(await input.count())) return { present: false, enabled: false, editable: false };
  const enabled = await input.isEnabled();
  const editable = await input.isEditable();
  if (!enabled || !editable) return { present: true, enabled, editable, fillAndClear: false };
  const original = await input.inputValue();
  const marker = '只读界面验收，不提交生成。';
  await input.fill(marker);
  const filled = await input.inputValue() === marker;
  await input.fill(original);
  return { present: true, enabled, editable, fillAndClear: filled && await input.inputValue() === original };
}

async function pluginSection(page, heading) {
  const title = page.getByRole('heading', { name: heading, exact: true });
  await title.waitFor({ state: 'visible', timeout: 20000 });
  const card = title.locator('xpath=../../..');
  const select = card.locator('select');
  await select.waitFor({ state: 'visible', timeout: 20000 });
  return select.evaluate(element => {
    const options = [...element.options];
    return {
      optionCount: options.length,
      enabled: !element.disabled,
      selectedValuePresent: Boolean(element.value),
      chineseLabelCount: options.filter(option => /[\u3400-\u9fff]/u.test(option.textContent || '')).length,
      suspiciousEncodingCount: options.filter(option => /\uFFFD|锟斤|鏂囨|鎻愬|鈹€|瀵硅/u.test(option.textContent || '')).length,
      zeroPriceLabelCount: options.filter(option => /¥0\.00\/次/u.test(option.textContent || '')).length,
      priceLabelCount: options.filter(option => /¥\d+\.\d{2}\/次/u.test(option.textContent || '')).length,
    };
  });
}

async function main() {
  if (!expectedUsername) throw new Error('EXPECTED_USERNAME_REQUIRED');
  if (injectedAdminToken) {
    const response = await fetch(`${origin}/api/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${injectedAdminToken}` },
      signal: AbortSignal.timeout(15000),
    });
    evidence.authentication.identityStatus = response.status;
    const payload = await response.json();
    session = { token: injectedAdminToken, user: payload?.user };
    evidence.authentication.source = 'short-lived-local-admin-token';
    if (!response.ok || !session.user) throw new Error('INJECTED_ADMIN_SESSION_UNAVAILABLE');
  } else {
    const response = await fetch(`${origin}/api/auth/dev-session`, {
      method: 'GET', headers: { 'x-local-workbench': 'ai-creation-studio-local' },
      signal: AbortSignal.timeout(15000),
    });
    evidence.authentication.devSessionStatus = response.status;
    session = await response.json();
    evidence.authentication.source = 'legacy-dev-session';
    if (!response.ok || !session.token || !session.user) throw new Error('NORMAL_DEV_SESSION_UNAVAILABLE');
  }
  if (session.user.username !== expectedUsername || session.user.role !== 'admin') throw new Error('EXPECTED_ADMIN_MISMATCH');
  evidence.authentication.normalDevSession = true;
  evidence.authentication.expectedUserMatched = true;

  stage = 'browser';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: evidence.viewport, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = safePath(url.href);
    let reason = null;
    const diagnosticReadPost = request.method() === 'POST' && url.origin === origin && url.pathname === '/__nextjs_original-stack-frames';
    if (request.method() !== 'GET' && !diagnosticReadPost) reason = 'business_non_get';
    else if (url.origin === origin && statefulGetPaths.has(url.pathname)) reason = 'state_advancing_get';
    if (reason) {
      increment(blocked, `${request.method()} ${pathname} ${reason}`);
      await route.abort('blockedbyclient');
    } else if (url.origin === origin) {
      await route.continue({ headers: { ...request.headers(), authorization: `Bearer ${session.token}` } });
    } else await route.continue();
  });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
  }, { token: session.token, user: session.user });
  const page = await context.newPage();
  activePage = page;
  page.on('console', message => {
    if (message.type() !== 'error') return;
    evidence.consoleErrorCount += 1;
    const safeMessage = message.text()
      .replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?/giu, '<url>')
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer <redacted>')
      .slice(0, 500);
    evidence.consoleErrors.push({ page: safePath(page.url()), message: safeMessage });
    if (/ERR_BLOCKED_BY_CLIENT/u.test(safeMessage)) evidence.blockedNetworkConsoleErrorCount += 1;
  });
  page.on('pageerror', error => evidence.pageErrors.push({ page: safePath(page.url()), type: error.name || 'Error' }));
  page.on('response', async response => {
    if (response.status() >= 400) increment(errors, `${response.status()} ${safePath(response.url())}`);
    if (['/api/cover-models', '/api/video/models'].includes(safePath(response.url())) && response.ok()) {
      const payload = await response.json().catch(() => null);
      if (Array.isArray(payload?.models)) evidence.modelMetadata.push({ path: safePath(response.url()), count: payload.models.length, zeroPublicPriceCount: payload.models.filter(model => model.publicPrice === 0).length });
    }
  });
  page.on('dialog', dialog => dialog.dismiss());

  if (!process.argv.includes('--only-video')) {
  stage = 'admin_navigation';
  await page.goto(`${origin}/admin?tab=models`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByRole('heading', { name: '模型资源池', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  stage = 'admin_extract';
  await page.getByRole('button', { name: /文案提取/u }).first().click();
  stage = 'admin_single_text';
  const singleText = await pluginSection(page, '单条文案提取插件');
  stage = 'admin_batch_text';
  const batchText = await pluginSection(page, '批量文案提取插件');
  stage = 'admin_video_extract';
  const videoExtract = await pluginSection(page, '视频提取插件');
  evidence.pages.push({ page: '/admin', modelManagementNavigated: true, extractionTabNavigated: true, singleText, batchText, videoExtract, layout: await layout(page) });

  stage = 'image_workbench';
  await page.goto(`${origin}/image-workbench`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const imageModels = page.locator('#image-workbench-model');
  await imageModels.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#image-workbench-model')?.options.length > 0, undefined, { timeout: 25000 });
  const imageSelector = await imageModels.evaluate(element => ({ optionCount: element.options.length, enabled: !element.disabled, selectedValuePresent: Boolean(element.value) }));
  const imageValues = await imageModels.locator('option').evaluateAll(options => options.map(option => option.value));
  const imageOriginal = await imageModels.inputValue();
  if (imageValues.length > 1) {
    await imageModels.selectOption(imageValues.find(value => value !== imageOriginal));
    imageSelector.selectionChanged = await imageModels.inputValue() !== imageOriginal;
    await imageModels.selectOption(imageOriginal);
  }
  evidence.pages.push({ page: '/image-workbench', modelSelector: imageSelector, promptInput: await checkInput(page.getByRole('textbox', { name: '第 1 张图片提示词', exact: true })), layout: await layout(page) });
  }

  stage = 'video';
  const videoCatalogResponse = page.waitForResponse(response => safePath(response.url()) === '/api/video/models' && response.ok(), { timeout: 20000 });
  await page.goto(`${origin}/video`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const videoCatalog = await (await videoCatalogResponse).json();
  const availableVideoModel = videoCatalog.models?.find(model => model.capabilities?.available !== false);
  stage = 'video_selector_visible';
  const videoModelList = page.locator('[data-video-model-list]');
  await videoModelList.waitFor({ state: 'visible', timeout: 10000 });
  const videoModelButtons = videoModelList.locator('button[data-video-model-id]');
  await videoModelButtons.first().waitFor({ state: 'visible', timeout: 10000 });
  stage = 'video_options';
  const videoSelector = await videoModelList.evaluate((list, expectedId) => {
    const buttons = [...list.querySelectorAll('button[data-video-model-id]')];
    return {
      optionCount: buttons.length,
      enabledOptionCount: buttons.filter(button => !button.disabled).length,
      disabledOptionCount: buttons.filter(button => button.disabled).length,
      avatarCount: list.querySelectorAll('[data-video-model-avatar]').length,
      expectedModelPresent: buttons.some(button => button.getAttribute('data-video-model-id') === expectedId),
      unavailableButtonsDisabled: buttons.filter(button => /未通过生成准入|当前未开放|渠道恢复中/u.test(button.textContent || '')).every(button => button.disabled),
    };
  }, availableVideoModel?.id || '');
  const selectable = videoModelList.locator('button[data-video-model-id]:not([disabled])');
  const selectedTarget = videoModelList.locator(`button[data-video-model-id="${availableVideoModel?.id || ''}"]`);
  assert.equal(await selectedTarget.count(), 1, 'AVAILABLE_VIDEO_MODEL_CARD_MISSING');
  stage = 'video_option_selection';
  await selectedTarget.click();
  videoSelector.pointerSelectionAccepted = true;
  videoSelector.selectionAccepted = (await selectedTarget.getAttribute('class'))?.includes('shadow-[inset_3px_0_var(--primary)]') || false;
  videoSelector.selectedModelId = await selectedTarget.getAttribute('data-video-model-id');
  videoSelector.allModelsHaveAvatars = videoSelector.avatarCount === videoSelector.optionCount;
  videoSelector.catalogCountMatches = videoSelector.optionCount === (videoCatalog.models?.length || 0);
  videoSelector.enabled = (await selectable.count()) > 0;
  stage = 'video_input';
  evidence.pages.push({ page: '/video', modelSelector: videoSelector, promptInput: await checkInput(page.locator('textarea[aria-label^="任务"][aria-label$="提示词"]').first()), layout: await layout(page) });
  await context.close();
  stage = 'complete';
}

try { await main(); }
catch (error) {
  evidence.failure = { stage, type: error?.name || 'Error', code: 'LIVE_UI_CHECK_INCOMPLETE', message: String(error?.message || error).slice(0, 500) };
  if (activePage && !activePage.isClosed()) evidence.failure.dom = await activePage.evaluate(() => ({
    page: window.location.pathname,
    comboboxCount: document.querySelectorAll('[role="combobox"]').length,
    textareaCount: document.querySelectorAll('textarea').length,
    noModelsNotice: /暂无可用模型|没有可用模型/u.test(document.body.innerText),
    authenticationNotice: /请先登录/u.test(document.body.innerText),
  })).catch(() => null);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  session = null;
  evidence.blockedRequests = [...blocked].map(([request, count]) => ({ request, count }));
  evidence.httpErrors = [...errors].map(([response, count]) => ({ response, count }));
  evidence.completed = stage === 'complete';
  const outputArg = process.argv.find(argument => argument.startsWith('--output='));
  if (outputArg) {
    const output = path.resolve(root, outputArg.slice('--output='.length));
    const evidenceRoot = `${path.join(root, '.codex-evidence')}${path.sep}`;
    if (!output.startsWith(evidenceRoot)) throw new Error('OUTPUT_MUST_BE_LOCAL_EVIDENCE');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(evidence, null, 2));
}
