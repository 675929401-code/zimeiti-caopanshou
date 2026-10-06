#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const expectedUsername = String(process.env.READONLY_UI_EXPECTED_USERNAME || '').trim();
const outputArgument = process.argv.find(argument => argument.startsWith('--output='));
const output = outputArgument
  ? path.resolve(root, outputArgument.slice('--output='.length))
  : path.resolve(root, '.codex-evidence/voice-tools-desktop-live-readonly/report.json');
const evidenceRoot = `${path.resolve(root, '.codex-evidence')}${path.sep}`;
assert.ok(output.startsWith(evidenceRoot), 'OUTPUT_MUST_BE_LOCAL_EVIDENCE');
assert.ok(token && expectedUsername, 'RUN_WITH_LOCAL_ADMIN_SESSION_REQUIRED');

const viewports = [
  { width: 1440, height: 900, key: '1440x900' },
  { width: 1920, height: 1080, key: '1920x1080' },
];
const report = {
  observedAt: new Date().toISOString(),
  source: 'LIVE_LOCAL_DOM_WITH_UNMODIFIED_GET_RESPONSES',
  policy: {
    responseFixtures: false,
    businessWritesBlocked: true,
    providerCallsAllowed: false,
    screenshotsSaved: true,
  },
  identity: null,
  viewports: [],
  blockedRequests: [],
  httpErrors: [],
  pageErrors: [],
  consoleErrors: [],
  ok: false,
};

const safePath = value => {
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}` : 'external-resource';
  } catch {
    return 'invalid-url';
  }
};

async function dismissUnreadAnnouncement(page) {
  const close = page.locator('[role="dialog"] button[aria-label*="关闭"], [role="dialog"] button[title*="关闭"]').first();
  // The account inbox is restored asynchronously after hydration. While the
  // Radix dialog is open it correctly hides the workspace from the
  // accessibility tree, so the verifier must wait for that delayed modal
  // instead of racing past it and reporting missing controls.
  const appeared = await close.waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) {
    await close.click();
    await close.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function pageGeometry(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    bodyHorizontalOverflowPx: Math.max(0, document.body.scrollWidth - window.innerWidth),
    applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|应用程序错误/u.test(document.body.innerText),
  }));
}

async function verifyVoice(page, screenshotDir, viewport) {
  await page.goto(`${origin}/voice-studio/workspace`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await dismissUnreadAnnouncement(page);
  const workspace = page.locator('[data-voice-workspace="synthesis"]');
  await workspace.waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[data-voice-editor]').waitFor({ state: 'visible', timeout: 30_000 });

  const input = page.getByRole('textbox', { name: '输入文本', exact: true });
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  const original = await input.inputValue();
  const marker = '零成本界面检查，不提交语音生成。';
  await input.fill(marker);
  const inputAccepted = await input.inputValue() === marker;
  await input.fill(original);

  const historyToggle = page.getByRole('button', { name: /生成历史/u }).first();
  await historyToggle.waitFor({ state: 'visible', timeout: 30_000 });
  const historyInitiallyOpen = await historyToggle.getAttribute('aria-expanded') === 'true';
  if (!historyInitiallyOpen) await historyToggle.click();
  await page.waitForFunction(() => document.querySelector('button[aria-controls="voice-generation-history-content"]')?.getAttribute('aria-expanded') === 'true');
  await page.waitForTimeout(300);
  const history = await page.locator('.vs-history-flyout > section').evaluate(element => {
    const style = getComputedStyle(element);
    const content = element.querySelector('#voice-generation-history-content');
    return {
      visible: style.display !== 'none' && element.getBoundingClientRect().height > 0,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
      contentVisible: Boolean(content && getComputedStyle(content).display !== 'none' && content.getBoundingClientRect().height > 0),
    };
  });
  await historyToggle.click();

  const shell = await page.locator('.voice-studio-root.vs-studio-shell').evaluate(element => {
    const style = getComputedStyle(element);
    const before = element.scrollTop;
    element.scrollTop = Math.min(420, Math.max(0, element.scrollHeight - element.clientHeight));
    const after = element.scrollTop;
    element.scrollTop = before;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      ownsVerticalScroll: element.scrollHeight <= element.clientHeight || after > 0,
    };
  });
  const outputRegionVisible = await page.locator('[data-voice-output-region]').isVisible();
  const durableOutputCardCount = await page.locator('[data-voice-output-card="ready"]').count();
  const pricingStatusCount = await page.locator('.vs-pricing-status').count();
  const geometry = await pageGeometry(page);
  await page.screenshot({ path: path.join(screenshotDir, `voice-${viewport.key}.png`), fullPage: false });
  return {
    path: '/voice-studio/workspace',
    inputAcceptedAndRestored: inputAccepted && await input.inputValue() === original,
    history,
    shell,
    outputRegionVisible,
    durableOutputCardAbsentBeforeGeneration: durableOutputCardCount === 0,
    pricingStatusPresent: pricingStatusCount === 1,
    geometry,
  };
}

async function verifyTools(page, screenshotDir, viewport) {
  await page.goto(`${origin}/tools?tab=text`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await dismissUnreadAnnouncement(page);
  const textTab = page.getByRole('tab', { name: /文案提取/u });
  const videoTab = page.getByRole('tab', { name: /视频提取/u });
  await textTab.waitFor({ state: 'visible', timeout: 30_000 });
  const textInput = page.getByRole('textbox', { name: '文案分享文本或链接', exact: true });
  await textInput.waitFor({ state: 'visible', timeout: 30_000 });
  const textOriginal = await textInput.inputValue();
  const textMarker = 'https://v.douyin.com/readonly-text-fixture/';
  await textInput.fill(textMarker);

  const textGeometry = await pageGeometry(page);
  const textLayout = await page.evaluate(() => {
    const rail = document.querySelector('aside[aria-label="工具功能"]');
    const workbench = document.querySelector('section[aria-label="短视频效率工具工作区"]');
    const activePanel = document.querySelector('[role="tabpanel"]:not([hidden])');
    const scrollPort = activePanel?.parentElement;
    return {
      railWidth: rail?.getBoundingClientRect().width || 0,
      workbenchWidth: workbench?.getBoundingClientRect().width || 0,
      activePanelId: activePanel?.id || null,
      scrollOverflowY: scrollPort ? getComputedStyle(scrollPort).overflowY : null,
    };
  });
  await page.screenshot({ path: path.join(screenshotDir, `tools-text-${viewport.key}.png`), fullPage: false });

  await videoTab.click();
  await page.waitForURL(url => url.pathname === '/tools' && url.searchParams.get('tab') === 'video');
  const videoInput = page.getByRole('textbox', { name: '视频分享文本或链接', exact: true });
  await videoInput.waitFor({ state: 'visible', timeout: 20_000 });
  const videoOriginal = await videoInput.inputValue();
  const videoMarker = 'https://v.douyin.com/readonly-video-fixture/';
  await videoInput.fill(videoMarker);
  const videoInputAccepted = await videoInput.inputValue() === videoMarker;
  const videoGeometry = await pageGeometry(page);
  await page.screenshot({ path: path.join(screenshotDir, `tools-video-${viewport.key}.png`), fullPage: false });

  await textTab.click();
  await page.waitForURL(url => url.pathname === '/tools' && url.searchParams.get('tab') === 'text');
  const textPreservedAcrossTabSwitch = await textInput.inputValue() === textMarker;
  const extractPanelCount = await page.locator('#tool-panel-extract').count();
  const activeText = await textTab.getAttribute('aria-selected') === 'true';
  await textInput.fill(textOriginal);
  await videoTab.click();
  await videoInput.fill(videoOriginal);

  return {
    paths: ['/tools?tab=text', '/tools?tab=video'],
    railWidth: textLayout.railWidth,
    workbenchWidth: textLayout.workbenchWidth,
    activePanelId: textLayout.activePanelId,
    workspaceOverflowY: textLayout.scrollOverflowY,
    textTabSelected: activeText,
    textInputAccepted: textPreservedAcrossTabSwitch,
    textInputPreservedAcrossTabSwitch: textPreservedAcrossTabSwitch,
    videoInputAccepted,
    extractPanelKeptMounted: extractPanelCount === 1,
    textGeometry,
    videoGeometry,
  };
}

let browser;
try {
  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const identityPayload = await identityResponse.json();
  assert.ok(identityResponse.ok && identityPayload?.user?.username === expectedUsername, 'LOCAL_ADMIN_IDENTITY_MISMATCH');
  report.identity = { status: identityResponse.status, expectedUsernameMatched: true, role: identityPayload.user.role };

  const screenshotDir = path.join(path.dirname(output), 'screenshots');
  await fs.mkdir(screenshotDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await context.addInitScript(({ authToken, user }) => {
      localStorage.setItem('auth_token', authToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
    }, { authToken: token, user: identityPayload.user });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const diagnosticReadPost = request.method() === 'POST'
        && url.origin === origin
        && url.pathname === '/__nextjs_original-stack-frames';
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !diagnosticReadPost) {
        report.blockedRequests.push({ viewport: viewport.key, method: request.method(), path: safePath(url.href) });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', error => report.pageErrors.push({ viewport: viewport.key, page: safePath(page.url()), name: error.name, message: error.message.slice(0, 300) }));
    page.on('console', message => {
      if (message.type() !== 'error' || /ERR_BLOCKED_BY_CLIENT/u.test(message.text())) return;
      report.consoleErrors.push({ viewport: viewport.key, page: safePath(page.url()), message: message.text().replace(/https?:\/\/\S+/gu, '[url]').slice(0, 300) });
    });
    page.on('response', response => {
      if (response.status() >= 500) report.httpErrors.push({ viewport: viewport.key, path: safePath(response.url()), status: response.status() });
    });
    const voice = await verifyVoice(page, screenshotDir, viewport);
    const tools = await verifyTools(page, screenshotDir, viewport);
    report.viewports.push({ viewport, voice, tools });
    await context.close();
  }

  const badGeometry = report.viewports.some(item => [
    item.voice.geometry,
    item.tools.textGeometry,
    item.tools.videoGeometry,
  ].some(value => value.horizontalOverflowPx > 1 || value.bodyHorizontalOverflowPx > 1 || value.applicationErrorVisible));
  const badBehavior = report.viewports.some(item => !(
    item.voice.inputAcceptedAndRestored
    && item.voice.history.visible
    && item.voice.history.contentVisible
    && item.voice.shell.ownsVerticalScroll
    && item.voice.shell.overflowY === 'auto'
    && item.voice.outputRegionVisible
    && item.voice.durableOutputCardAbsentBeforeGeneration
    && item.voice.pricingStatusPresent
    && item.tools.textTabSelected
    && item.tools.textInputPreservedAcrossTabSwitch
    && item.tools.videoInputAccepted
    && item.tools.extractPanelKeptMounted
    && item.tools.workspaceOverflowY === 'auto'
    && item.tools.railWidth >= 306
    && item.tools.railWidth <= 318
  ));
  const forbiddenRequest = report.blockedRequests.some(item => /\/api\/(?:voice\/tts|extract|video\/generate)/u.test(item.path));
  report.ok = !badGeometry && !badBehavior && !forbiddenRequest
    && report.httpErrors.length === 0
    && report.pageErrors.length === 0
    && report.consoleErrors.length === 0;
} finally {
  if (browser) await browser.close().catch(() => {});
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}

assert.equal(report.ok, true, 'VOICE_TOOLS_DESKTOP_LIVE_READONLY_FAILED');
