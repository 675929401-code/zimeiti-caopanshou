#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002', 'http://127.0.0.1:5010'].includes(origin), 'LOCAL_ONLY_ORIGIN_REQUIRED');

const observedAt = new Date().toISOString();
const defaultDirectory = `.codex-evidence/commerce-final-ui-live-${observedAt.replace(/[:.]/gu, '-')}`;
const outputArgument = process.argv.find((value) => value.startsWith('--output='));
const output = path.resolve(projectRoot, outputArgument?.slice('--output='.length) || `${defaultDirectory}/report.json`);
const evidenceRoot = `${path.join(projectRoot, '.codex-evidence')}${path.sep}`;
assert.ok(output.startsWith(evidenceRoot), 'OUTPUT_MUST_BE_LOCAL_EVIDENCE');
const outputDirectory = path.dirname(output);
await fs.mkdir(outputDirectory, { recursive: true });

const pages = [
  {
    id: 'hot-video-remix',
    path: '/commerce/toolbox/hot-video-remix',
    root: '[aria-label="爆款视频二创工作台"]',
    heading: '爆款视频二创',
    requiredText: ['本机处理', '源视频与顺序', '成片设置', '任务与成片'],
    disabledAction: '生成 0 元处理报价',
  },
  {
    id: 'voice-synthesis',
    path: '/commerce/toolbox/voice-synthesis',
    root: '[data-testid="commerce-voice-synthesis"]',
    heading: '语音合成',
    requiredText: ['报价与确认分离', '文字与音色', '声音参数', '任务与结果'],
    disabledAction: '获取准确报价',
  },
  {
    id: 'digital-human',
    path: '/commerce/toolbox/digital-human',
    root: '[aria-label="数字人工作区"]',
    heading: 'AI 数字人',
    requiredText: ['人物视频', '台词与声音', '生成设置', '作品与任务'],
    disabledAction: '生成数字人视频',
    revealCommerceAudio: true,
  },
  {
    id: 'image-generation-adjacent',
    path: '/commerce/toolbox/image-generation',
    root: '[data-testid="commerce-workspace"][data-tab="image"]',
    heading: null,
    requiredText: ['图片设置'],
    inputLabel: '图片创作要求',
  },
  {
    id: 'video-generation-adjacent',
    path: '/commerce/toolbox/video-generation',
    root: '[data-testid="commerce-workspace"][data-tab="video"]',
    heading: null,
    requiredText: ['视频设置'],
    inputLabel: '视频创作要求',
  },
];

const report = {
  schemaVersion: 'commerce-final-ui-live-readonly/v1',
  observedAt,
  origin,
  policy: {
    localOnly: true,
    browserAllowsMethods: ['GET', 'HEAD', 'OPTIONS'],
    businessWritesExecuted: 0,
    paidGenerationRequests: 0,
    benchmarkVideoSubmissions: 0,
    productionWrites: 0,
    deployment: 0,
  },
  authentication: {},
  pages: [],
  blockedNonGet: [],
  paidMutationAttempts: [],
  benchmarkBatchAttempts: [],
  httpErrors: [],
  consoleErrors: [],
  pageErrors: [],
};

let browser;
let page;

function safePath(value) {
  try { return new URL(value).pathname; } catch { return '/unknown'; }
}

async function localSession() {
  const injectedToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
  if (injectedToken) {
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${injectedToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    assert.ok(response.ok && payload?.user?.role === 'admin', 'INJECTED_ADMIN_SESSION_UNAVAILABLE');
    return { token: injectedToken, user: payload.user, source: 'short-lived-local-admin-token' };
  }
  const response = await fetch(`${origin}/api/auth/dev-session`, {
    headers: { 'x-local-workbench': 'ai-creation-studio-local' },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  assert.ok(response.ok && payload?.token && payload?.user?.role === 'admin', 'LOCAL_ADMIN_SESSION_UNAVAILABLE');
  return { token: payload.token, user: payload.user, source: 'local-dev-session' };
}

async function launchBrowser() {
  const bundled = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
  try {
    await fs.access(bundled);
    return chromium.launch({ headless: true, executablePath: bundled });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function measure(rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return null;
    const visible = (node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const rootBox = root.getBoundingClientRect();
    const textNodes = [...root.querySelectorAll('button,label,input,select,textarea,p,small,strong,h1,h2,h3')]
      .filter(visible)
      .map((node) => Number.parseFloat(getComputedStyle(node).fontSize || '0'))
      .filter((value) => Number.isFinite(value) && value > 0);
    const controls = [...root.querySelectorAll('button,input,select,textarea')]
      .filter(visible)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          label: node.getAttribute('aria-label') || node.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 80) || '',
          disabled: Boolean(node.disabled),
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
        };
      });
    return {
      pathname: location.pathname,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      rootBox: {
        left: Math.round(rootBox.left),
        right: Math.round(rootBox.right),
        width: Math.round(rootBox.width),
      },
      rootOverflowsViewport: rootBox.left < -2 || rootBox.right > innerWidth + 2 || root.scrollWidth > root.clientWidth + 2,
      minimumVisibleTextPx: textNodes.length ? Math.min(...textNodes) : 0,
      controlCount: controls.length,
      controlsOutsideViewport: controls.filter((item) => item.left < -2 || item.right > innerWidth + 2),
      applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|应用程序错误/u.test(document.body.innerText),
    };
  }, rootSelector);
}

async function audit(target, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${origin}${target.path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator(target.root).waitFor({ state: 'visible', timeout: 45_000 });
  if (target.heading) await page.getByRole('heading', { name: target.heading, exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (target.inputLabel) await page.getByRole('textbox', { name: target.inputLabel, exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  if (target.revealCommerceAudio) {
    const uploadTab = page.getByRole('tab', { name: '上传现成音频', exact: true });
    await uploadTab.waitFor({ state: 'visible', timeout: 30_000 });
    await uploadTab.click();
    await page.locator('[aria-label="带货 Agent 配音资产"]').waitFor({ state: 'visible', timeout: 30_000 });
  }
  await page.waitForTimeout(800);
  const bodyText = (await page.locator('body').innerText()).replace(/\s+/gu, ' ');
  for (const text of target.requiredText) assert.match(bodyText, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `${target.id} 缺少可见文案：${text}`);
  let disabledAction = null;
  if (target.disabledAction) {
    const action = page.getByRole('button', { name: new RegExp(target.disabledAction, 'u') }).first();
    await action.waitFor({ state: 'visible', timeout: 30_000 });
    disabledAction = { label: target.disabledAction, disabled: await action.isDisabled() };
    assert.equal(disabledAction.disabled, true, `${target.id} 在缺少必填素材时仍可提交`);
  }
  const layout = await measure(target.root);
  assert.ok(layout, `${target.id} 根容器不存在`);
  assert.equal(layout.pathname, target.path, `${target.id} 精确路径不一致`);
  assert.equal(layout.applicationErrorVisible, false, `${target.id} 显示应用错误`);
  assert.equal(layout.horizontalOverflowPx, 0, `${target.id} 页面横向溢出`);
  assert.equal(layout.rootOverflowsViewport, false, `${target.id} 根容器或内部内容横向溢出`);
  assert.equal(layout.controlsOutsideViewport.length, 0, `${target.id} 存在视口外控件`);
  assert.ok(layout.minimumVisibleTextPx >= (viewport.width === 390 ? 11 : 12), `${target.id} 可见文字过小`);
  const viewportId = viewport.width === 390 ? 'mobile-390' : 'desktop-1440';
  const screenshot = path.join(outputDirectory, `${target.id}-${viewportId}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  return { id: target.id, path: target.path, viewport: viewportId, layout, disabledAction, screenshot };
}

try {
  const session = await localSession();
  report.authentication = { source: session.source, role: session.user.role, userIdPresent: Boolean(session.user.id) };
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'auth_token', value: session.token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ expectedOrigin, token, user }) => {
    if (location.origin !== expectedOrigin) return;
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
    sessionStorage.setItem('entered_app', '1');
  }, { expectedOrigin: origin, token: session.token, user: session.user });

  const commerceSession = await context.request.get(`${origin}/api/commerce/session`, {
    headers: { Authorization: `Bearer ${session.token}` },
    timeout: 15_000,
  });
  report.authentication.commerceSessionStatus = commerceSession.status();
  assert.ok(commerceSession.ok(), 'COMMERCE_SESSION_GET_UNAVAILABLE');

  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method();
    const requestUrl = new URL(request.url());
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      await route.continue();
      return;
    }
    const record = { method, origin: requestUrl.origin === origin ? 'local' : 'external', path: requestUrl.pathname };
    report.blockedNonGet.push(record);
    if (requestUrl.pathname === '/api/v1/batches') report.benchmarkBatchAttempts.push(record);
    if (/\/(generate|confirm|jobs|quotes?|batches|submit)(?:\/|$)/u.test(requestUrl.pathname)) report.paidMutationAttempts.push(record);
    await route.abort('blockedbyclient');
  });

  page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push({ path: safePath(page.url()), message: String(error.message).slice(0, 400) }));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text().slice(0, 500);
    if (/ERR_BLOCKED_BY_CLIENT/u.test(text)) return;
    report.consoleErrors.push({ path: safePath(page.url()), message: text });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    report.httpErrors.push({ method: response.request().method(), path: safePath(response.url()), status: response.status() });
  });
  page.on('dialog', (dialog) => dialog.dismiss());

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const target of pages) report.pages.push(await audit(target, viewport));
  }

  assert.equal(report.paidMutationAttempts.length, 0, '只读浏览器验收期间出现生成、报价、确认或任务提交请求');
  assert.equal(report.benchmarkBatchAttempts.length, 0, '对标视频批次提交必须保持为 0');
  assert.equal(report.pageErrors.length, 0, '页面存在运行时错误');
  assert.equal(report.consoleErrors.length, 0, '页面存在控制台错误');
  assert.equal(report.httpErrors.length, 0, '页面存在 HTTP 错误');
  report.passed = true;
  await context.close();
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}

console.log(JSON.stringify({
  passed: report.passed,
  pages: report.pages.length,
  blockedNonGet: report.blockedNonGet.length,
  paidMutationAttempts: report.paidMutationAttempts.length,
  benchmarkVideoSubmissions: report.benchmarkBatchAttempts.length,
  pageErrors: report.pageErrors.length,
  consoleErrors: report.consoleErrors.length,
  httpErrors: report.httpErrors.length,
  evidence: output,
}, null, 2));
