#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { assertToolboxPanelAlignment } from './lib/toolbox-panel-alignment.mjs';

const origin = String(process.env.LOCAL_NAV_ORIGIN || process.env.LOCAL_APP_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const parsedOrigin = new URL(origin);
assert.equal(parsedOrigin.protocol, 'http:', 'Live acceptance is restricted to the local HTTP runtime');
assert.ok(['127.0.0.1', 'localhost'].includes(parsedOrigin.hostname), 'Refusing to send the local admin session to a non-local host');
assert.equal(parsedOrigin.port || '80', '5000', 'Live acceptance is restricted to the fixed local port 5000');
const outputBaseDir = path.resolve('.codex-evidence/toolbox-format-segment-current-20260930');
const chromiumPath = process.env.LOCAL_CHROMIUM_PATH
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const themes = [
  { id: 'lattice', mode: 'dark' },
  { id: 'soft-white', mode: 'light' },
  { id: 'crystal-aurora', mode: 'dark' },
];
const viewports = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const expectedRanges = new Map([
  ['8', '40-48字/段'], ['10', '50-60字/段'], ['12', '60-72字/段'], ['15', '75-90字/段'],
  ['16', '80-96字/段'], ['20', '100-120字/段'], ['25', '125-150字/段'],
]);
const expectedSegmentCounts = new Map([['8', 9], ['10', 7], ['12', 6], ['15', 5], ['16', 5], ['20', 4], ['25', 3]]);

assert.ok(token, 'Run through scripts/with-local-admin-session.mjs');
const localVersion = JSON.parse(await fs.readFile('public/version.json', 'utf8'));
const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) });
const runtimeVersion = await versionResponse.json();
assert.equal(versionResponse.ok, true, 'Runtime version endpoint must be healthy');
assert.equal(runtimeVersion.sourceVersion, localVersion.sourceVersion, 'Runtime source version does not match the F-drive source');
assert.equal(runtimeVersion.sourceDigest, localVersion.sourceDigest, 'Runtime source digest does not match the F-drive source');
assert.ok(Number(runtimeVersion.revision) >= 473, `Expected revision 473 or newer, received ${runtimeVersion.revision}`);
const runId = `${runtimeVersion.sourceVersion}-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
const outputDir = path.join(outputBaseDir, runId);
await fs.mkdir(outputDir, { recursive: true });
const identityResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user?.id, 'Local authenticated identity is required');

const report = {
  at: new Date().toISOString(),
  runId,
  origin,
  runtimeVersion,
  themes,
  viewports,
  visual: [],
  formatter: null,
  segmenter: null,
  video: [],
  history: { formatter: null, segmenter: null, cleanup: [] },
  adjacent: [],
  pageErrors: [],
  httpErrors: [],
  unexpectedWrites: [],
  externalApiRequests: [],
};

async function attachDiagnostics(page, label, { allowHistoryWrites = false, allowedMockWrites = [] } = {}) {
  const mockedWritePaths = new Set(allowedMockWrites);
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== origin && ['fetch', 'xhr', 'eventsource', 'websocket'].includes(request.resourceType())) {
      report.externalApiRequests.push({ label, method, url: request.url(), blocked: true });
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const isHistory = /^\/api\/(?:formatter|segmenter)\/history$/u.test(url.pathname);
      if (!((isHistory && allowHistoryWrites) || mockedWritePaths.has(url.pathname))) {
        report.unexpectedWrites.push({ label, method, path: url.pathname, blocked: true });
        return route.abort('blockedbyclient');
      }
    }
    return route.fallback();
  });
  page.on('pageerror', error => report.pageErrors.push({ label, message: String(error.message).slice(0, 500) }));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) {
      report.httpErrors.push({ label, method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (['fetch', 'xhr'].includes(request.resourceType()) && url.origin !== origin) {
      report.externalApiRequests.push({ label, method: request.method(), url: request.url() });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const isHistory = /^\/api\/(?:formatter|segmenter)\/history$/u.test(url.pathname);
      if (!(isHistory && allowHistoryWrites) && !mockedWritePaths.has(url.pathname)) {
        report.unexpectedWrites.push({ label, method: request.method(), path: url.pathname });
      }
    }
  });
}

async function installIdentity(page, theme, { mockHistory = true } = {}) {
  const themedUser = { ...identity.user, themePreference: theme.id, theme_preference: theme.id };
  await page.addInitScript(({ tokenValue, userValue, themeId }) => {
    localStorage.setItem('auth_token', tokenValue);
    localStorage.setItem('auth_user', JSON.stringify(userValue));
    localStorage.setItem('user_theme_preference', themeId);
  }, { tokenValue: token, userValue: themedUser, themeId: theme.id });
  await page.route('**/api/auth/me**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/auth/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: themedUser }) });
    }
    return route.fallback();
  });
  if (mockHistory) {
    await page.route('**/api/formatter/history**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname !== '/api/formatter/history') return route.fallback();
      if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [], history: [] }) });
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        assert.deepEqual(body.rules, { removeExtraSpaces: true, removeEmptyLines: true, trimIndent: true, mergeParagraphs: true });
        assert.equal(body.result_text.includes('\n'), false, 'formatter history must store the fixed merged result');
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ record: { id: `mock-format-${Date.now()}`, title: 'fixture', char_count: body.char_count, line_count: body.line_count, created_at: new Date().toISOString() } }) });
      }
      return route.fallback();
    });
    await page.route('**/api/segmenter/history**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname !== '/api/segmenter/history') return route.fallback();
      if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) });
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        const parsed = JSON.parse(body.result_text);
        assert.equal(body.rules?.engine, 'local_rule_v2');
        assert.equal(body.rules?.duration, Number(String(body.mode).match(/\d+/u)?.[0]));
        assert.equal(body.segment_count, parsed.segments.length);
        assert.equal(parsed.counts.length, parsed.segments.length);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ record: { id: `mock-segment-${Date.now()}`, title: 'fixture', mode: body.mode, char_count: body.char_count, segment_count: body.segment_count, created_at: new Date().toISOString() } }) });
      }
      return route.fallback();
    });
  }
}

async function waitForTheme(page, theme) {
  await page.waitForFunction(({ id, mode }) => document.documentElement.dataset.theme === id && document.documentElement.dataset.mode === mode, theme, { timeout: 30_000 });
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}
function contrast(foreground, background) {
  const parse = input => (String(input).match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
  const fg = parse(foreground); const bg = parse(background);
  if (fg.length !== 3 || bg.length !== 3) return 0;
  const lum = rgb => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const [high, low] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

async function visualAudit(browser, theme, viewport, tab) {
  const context = await browser.newContext({ viewport, colorScheme: theme.mode, serviceWorkers: 'block' });
  const page = await context.newPage();
  await attachDiagnostics(page, `visual-${tab}-${theme.id}-${viewport.width}`);
  await installIdentity(page, theme);
  const response = await page.goto(`${origin}/tools?tab=${tab}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  assert.equal(response?.status(), 200);
  await waitForTheme(page, theme);
  const panel = page.locator(tab === 'text' || tab === 'video' ? '#tool-panel-extract' : `#tool-panel-${tab}`);
  await panel.getByRole('textbox').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const metrics = await panel.evaluate((root, tabId) => {
    const visibleElement = selector => [...root.querySelectorAll(selector)].find((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    // Text and video extraction stay mounted together so an in-flight task is
    // not interrupted when the user switches tabs. Always measure the visible
    // pane instead of the first matching node, which may belong to display:none.
    const primary = visibleElement('.toolbox-primary-pane')?.getBoundingClientRect();
    const result = visibleElement('.toolbox-result-pane')?.getBoundingClientRect();
    const toolbar = visibleElement(tabId === 'text' ? '.toolbox-operation-options' : '.toolbox-embedded-toolbar')?.getBoundingClientRect();
    const textarea = visibleElement('textarea');
    const surface = textarea?.closest('.toolbox-input-surface');
    const surfaceRect = surface?.getBoundingClientRect();
    const expectedAction = tabId === 'format'
      ? '开始排版'
      : tabId === 'segment'
        ? '开始分段'
        : tabId === 'video'
          ? '开始提取'
          : '提取文案';
    const action = [...root.querySelectorAll('button')].find(button => button.textContent?.trim().includes(expectedAction));
    const durationButtons = [...root.querySelectorAll('.toolbox-duration-chip')];
    const topValues = durationButtons.map(button => Math.round(button.getBoundingClientRect().top));
    return {
      tab: tabId,
      primary: primary && { width: primary.width, height: primary.height, top: primary.top, bottom: primary.bottom },
      result: result && { width: result.width, height: result.height, top: result.top, bottom: result.bottom },
      surface: surfaceRect && { width: surfaceRect.width, height: surfaceRect.height, top: surfaceRect.top, bottom: surfaceRect.bottom },
      toolbarHeight: toolbar?.height || 0,
      durationCount: durationButtons.length,
      durationRows: new Set(topValues).size,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelOverflow: root.scrollWidth - root.clientWidth,
      textColor: textarea ? getComputedStyle(textarea).color : '',
      textFontSize: textarea ? Number.parseFloat(getComputedStyle(textarea).fontSize) : 0,
      textFontFamily: textarea ? getComputedStyle(textarea).fontFamily : '',
      surfaceColor: surface ? getComputedStyle(surface).backgroundColor : '',
      actionInsideSurface: Boolean(surface && action && surface.contains(action)),
      ruleButtonCount: root.querySelectorAll('.toolbox-option-chip').length,
      correctionCount: root.querySelectorAll('.toolbox-check-chip').length,
      textResultHeadingCount: root.querySelectorAll('.toolbox-text-result-pane > .toolbox-result-pane-heading').length,
      fixedRuleVisible: Boolean(root.querySelector('.toolbox-fixed-rule')),
    };
  }, tab);
  const shot = `tools-${tab}-${theme.id}-${viewport.width}.png`;
  await page.screenshot({ path: path.join(outputDir, shot), fullPage: false });
  const panelEdges = await assertToolboxPanelAlignment(page);
  report.visual.push({ theme, viewport, tab, metrics, panelEdges, screenshot: shot });
  assert.ok(metrics.primary && metrics.result, `${tab} panes missing`);
  assert.ok(Math.abs(metrics.primary.width - metrics.result.width) <= 2, `${tab} operation and result cards do not share one width: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.result.top >= metrics.primary.bottom + 8, `${tab} result must start below the operation card: ${JSON.stringify(metrics)}`);
  // Extraction includes the quote status row plus its platform or correction
  // controls; 350px keeps the complete card compact without hiding a control.
  assert.ok(metrics.primary.height <= 350, `${tab} operation card is too tall: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.result.height >= 220, `${tab} result card is too short: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.actionInsideSurface, true, `${tab} primary action must stay inside the operation card`);
  assert.ok(metrics.textFontSize >= 16, `${tab} input type is too small: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.pageOverflow <= 1 && metrics.panelOverflow <= 1, `${tab} has horizontal overflow: ${JSON.stringify(metrics)}`);
  assert.ok(contrast(metrics.textColor, metrics.surfaceColor) >= 4.5, `${tab} text contrast is too low: ${JSON.stringify(metrics)}`);
  if (tab === 'segment') {
    assert.equal(metrics.durationCount, 7);
    assert.equal(metrics.durationRows, 1);
    assert.ok(metrics.toolbarHeight <= 66, `segment toolbar is too tall: ${metrics.toolbarHeight}`);
  } else if (tab === 'format') {
    assert.equal(metrics.ruleButtonCount, 0);
    assert.equal(metrics.fixedRuleVisible, true);
    assert.ok(metrics.toolbarHeight <= 62, `formatter toolbar is too tall: ${metrics.toolbarHeight}`);
  } else {
    assert.equal(metrics.correctionCount, 4);
    assert.equal(metrics.textResultHeadingCount, 1);
    assert.ok(metrics.toolbarHeight <= 52, `text extraction option row is too tall: ${metrics.toolbarHeight}`);
  }
  await context.close();
}

async function verifyFormatter(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  const page = await context.newPage();
  await attachDiagnostics(page, 'formatter-functional', { allowHistoryWrites: true });
  await installIdentity(page, themes[1]);
  await page.goto(`${origin}/tools?tab=format`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForTheme(page, themes[1]);
  const panel = page.locator('#tool-panel-format');
  const input = panel.getByRole('textbox', { name: '原始文案' });
  const fixture = '  清 晨 的 书 店。\n\n\t读 者 走 进 店 里。\nOpen\tAI   Studio';
  const expected = '清晨的书店。读者走进店里。Open AI Studio';
  await page.evaluate(text => navigator.clipboard.writeText(text), fixture);
  await panel.getByRole('button', { name: '粘贴', exact: true }).click();
  assert.equal(await input.inputValue(), fixture);
  await panel.getByRole('button', { name: '开始排版', exact: true }).click();
  const output = panel.getByRole('textbox', { name: '排版结果' });
  await output.waitFor({ state: 'visible' });
  assert.equal(await output.inputValue(), expected);
  await panel.getByRole('button', { name: '一键复制', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  await input.fill('修改后的新输入');
  assert.equal(await panel.getByRole('textbox', { name: '排版结果' }).count(), 0, 'editing input must invalidate the old formatter result');
  await panel.getByRole('button', { name: '开始排版', exact: true }).click();
  assert.equal(await panel.getByRole('textbox', { name: '排版结果' }).inputValue(), '修改后的新输入');
  await panel.getByRole('button', { name: '清空', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await panel.getByRole('textbox', { name: '排版结果' }).count(), 0);
  report.formatter = { passed: true, expected, clipboardCopied: true, staleResultInvalidated: true, cleared: true };
  await page.screenshot({ path: path.join(outputDir, 'formatter-functional-final.png'), fullPage: false });
  await context.close();

  const deniedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const deniedPage = await deniedContext.newPage();
  await attachDiagnostics(deniedPage, 'formatter-clipboard-denied', { allowHistoryWrites: true });
  await installIdentity(deniedPage, themes[1]);
  await deniedPage.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => Promise.reject(new Error('denied')), writeText: () => Promise.reject(new Error('denied')) } });
    Object.defineProperty(Document.prototype, 'execCommand', { configurable: true, value: () => false });
  });
  await deniedPage.goto(`${origin}/tools?tab=format`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const deniedPanel = deniedPage.locator('#tool-panel-format');
  await deniedPanel.getByRole('button', { name: '粘贴', exact: true }).click();
  await deniedPanel.getByText('浏览器未授予剪贴板读取权限，请使用 Ctrl+V 粘贴。', { exact: true }).waitFor();
  await deniedPanel.getByRole('textbox', { name: '原始文案' }).fill('复制失败反馈验收');
  await deniedPanel.getByRole('button', { name: '开始排版', exact: true }).click();
  await deniedPanel.getByRole('button', { name: '一键复制', exact: true }).click();
  await deniedPanel.getByText('复制失败，请选中结果后手动复制。', { exact: true }).waitFor();
  report.formatter.clipboardDeniedFeedback = true;
  report.formatter.copyDeniedFeedback = true;
  await deniedContext.close();
}

async function verifySegmenter(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  const page = await context.newPage();
  await attachDiagnostics(page, 'segmenter-functional', { allowHistoryWrites: true });
  await installIdentity(page, themes[1]);
  await page.goto(`${origin}/tools?tab=segment`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForTheme(page, themes[1]);
  const panel = page.locator('#tool-panel-segment');
  const input = panel.getByRole('textbox', { name: '需要分段的文案' });
  await input.waitFor({ state: 'visible' });
  const fixture = '长'.repeat(400);
  await page.evaluate(text => navigator.clipboard.writeText(text), fixture);
  await panel.getByRole('button', { name: '粘贴', exact: true }).click();
  assert.equal(await input.inputValue(), fixture);
  const counts = {};
  for (const duration of expectedRanges.keys()) {
    await panel.locator(`[data-duration="${duration}"]`).click();
    assert.equal(await panel.locator('[data-segmenter-result="true"]').count(), 0, 'duration selection must not bypass the primary action');
    await panel.getByText(expectedRanges.get(duration), { exact: false }).first().waitFor({ state: 'visible' });
    await panel.getByRole('button', { name: '开始分段', exact: true }).click();
    const result = panel.locator('[data-segmenter-result="true"]');
    await result.waitFor({ state: 'visible' });
    const count = await result.locator('[data-segment-index]').count();
    counts[duration] = count;
    assert.equal(count, expectedSegmentCounts.get(duration), `${duration}s preset did not change unpunctuated segmentation`);
  }
  assert.ok(new Set(Object.values(counts)).size >= 5);
  const copy = panel.getByRole('button', { name: '复制结果', exact: true });
  await copy.click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^1\.【/u);
  await input.fill('输入已修改');
  assert.equal(await panel.locator('[data-segmenter-result="true"]').count(), 0);
  assert.equal(await panel.getByRole('button', { name: '复制结果', exact: true }).count(), 0, 'copy action must disappear with the invalidated result');
  await input.fill('快捷键分段。'.repeat(50));
  await input.press('Control+Enter');
  await panel.locator('[data-segmenter-result="true"]').waitFor({ state: 'visible' });
  await panel.getByRole('button', { name: '清空', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await panel.locator('[data-segmenter-result="true"]').count(), 0);
  report.segmenter = { passed: true, counts, durationNeedsPrimaryAction: true, clipboardCopied: true, staleResultInvalidated: true, ctrlEnter: true, cleared: true };
  await page.screenshot({ path: path.join(outputDir, 'segmenter-functional-final.png'), fullPage: false });
  await context.close();
}

async function verifyVideoWorkbench(browser, theme, viewport) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme.mode,
    permissions: ['clipboard-read', 'clipboard-write'],
    serviceWorkers: 'block',
  });
  const label = `video-ui-${theme.id}-${viewport.width}`;
  const page = await context.newPage();
  await attachDiagnostics(page, label, { allowedMockWrites: ['/api/extract'] });
  await installIdentity(page, theme);
  const expires = Date.now() + 30 * 60 * 1000;
  const temporaryUrl = `/api/extract/local-video?file=${'a'.repeat(24)}&owner=${encodeURIComponent(identity.user.id)}&expires=${expires}&sig=${'b'.repeat(64)}`;
  const requests = [];
  await page.route('**/api/tools/runtime-catalog**', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: {
          video: { available: true, service: 'coze_multifunction_extract', provider: 'coze', unitPrice: 0.02, currency: 'CNY', unit: '条' },
          text: { available: true, service: 'coze_multifunction_extract', provider: 'coze', unitPrice: 0.02, currency: 'CNY', unit: '条' },
        },
      }),
    });
  });
  await page.route('**/api/extract', async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const payload = request.postDataJSON();
    requests.push(payload);
    assert.equal(payload.extraction_mode, 'video');
    assert.deepEqual(payload.links, ['https://v.douyin.com/fixture']);
    assert.ok(payload.client_request_id);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: 'fixture success',
        videos: [{
          row: 1,
          col: 1,
          platform: '抖音',
          success: true,
          title: '桌面端竖屏视频提取结果验收',
          cover: '/help/storyboard-video-poster.png',
          temporary_url: temporaryUrl,
          temporary_expires_at: expires,
        }],
        texts: [],
        summary: '零成本界面夹具',
      }),
    });
  });

  const response = await page.goto(`${origin}/tools?tab=video`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  assert.equal(response?.status(), 200);
  await waitForTheme(page, theme);
  const panel = page.locator('#tool-panel-extract');
  const input = panel.getByRole('textbox', { name: '视频分享文本或链接' });
  await input.fill('https://v.douyin.com/fixture');
  await panel.getByRole('button', { name: '开始提取', exact: true }).click();
  const card = panel.locator('.toolbox-video-card[data-video-status="success"]');
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(requests.length, 1, 'video primary action must submit exactly one request');
  await assertToolboxPanelAlignment(page);
  const metrics = await panel.evaluate(root => {
    const rect = selector => root.querySelector(selector)?.getBoundingClientRect();
    const primary = rect('.toolbox-primary-pane');
    const result = rect('.toolbox-result-pane');
    const grid = rect('.toolbox-video-grid');
    const cardRect = rect('.toolbox-video-card');
    const media = root.querySelector('.toolbox-video-media');
    const mediaRect = media?.getBoundingClientRect();
    const image = root.querySelector('.toolbox-video-media img');
    return {
      primary: primary && { width: primary.width, height: primary.height, top: primary.top, bottom: primary.bottom },
      result: result && { width: result.width, height: result.height, top: result.top, bottom: result.bottom },
      gridWidth: grid?.width || 0,
      cardWidth: cardRect?.width || 0,
      mediaRatio: mediaRect ? mediaRect.height / mediaRect.width : 0,
      imageFit: image ? getComputedStyle(image).objectFit : '',
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelOverflow: root.scrollWidth - root.clientWidth,
      resultHeaderTop: rect('.toolbox-video-results-heading')?.top || 0,
      actionInsideSurface: Boolean(root.querySelector('.toolbox-input-surface')?.contains(root.querySelector('.toolbox-primary-actions button:nth-child(2)'))),
      inputFontSize: Number.parseFloat(getComputedStyle(root.querySelector('textarea')).fontSize),
      platformSummary: root.querySelector('.toolbox-platform-summary')?.textContent?.trim() || '',
      actionLabels: [...root.querySelectorAll('.toolbox-video-actions button')].map(button => button.textContent?.trim()),
    };
  });
  const screenshot = `tools-video-${theme.id}-${viewport.width}.png`;
  await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: false });
  assert.ok(metrics.primary && metrics.result);
  assert.ok(Math.abs(metrics.primary.width - metrics.result.width) <= 2, `video operation and result cards do not share one width: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.result.top >= metrics.primary.bottom + 8, `video result must start below the operation card: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.primary.height <= 350, `video operation card is too tall: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.actionInsideSurface, true, 'video primary action must stay inside the operation card');
  assert.ok(metrics.inputFontSize >= 16, `video input type is too small: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.cardWidth / metrics.gridWidth >= 0.9, `single video result must use the result width: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.mediaRatio >= 1.75 && metrics.mediaRatio <= 1.8, `video media is not 9:16: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.imageFit, 'contain');
  assert.ok(metrics.pageOverflow <= 1 && metrics.panelOverflow <= 1, `video workbench overflows: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.platformSummary, '抖音 · 小红书 · 快手 · B站 · 微博');
  assert.deepEqual(metrics.actionLabels, ['下载视频', '播放', '复制链接']);
  await input.fill('https://v.douyin.com/changed');
  assert.equal(await panel.locator('.toolbox-video-card').count(), 0, 'editing the link must invalidate the stale result');
  assert.equal(await panel.locator('.toolbox-video-results-heading').count(), 1, 'the result heading must remain stable in the empty state');
  report.video.push({ theme, viewport, requests: requests.length, staleResultInvalidated: true, metrics, screenshot });
  await context.close();
}

async function verifyRealHistory(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const created = [];
  const authHeaders = { Authorization: `Bearer ${token}` };
  try {
    const formatterPage = await context.newPage();
    await attachDiagnostics(formatterPage, 'formatter-history-real', { allowHistoryWrites: true });
    await installIdentity(formatterPage, themes[1], { mockHistory: false });
    await formatterPage.goto(`${origin}/tools?tab=format`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const formatterPanel = formatterPage.locator('#tool-panel-format');
    const marker = `验收排版${Date.now()}`;
    await formatterPanel.getByRole('textbox', { name: '原始文案' }).fill(`  ${marker}  清 晨。`);
    const [formatResponse] = await Promise.all([
      formatterPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/formatter/history'),
      formatterPanel.getByRole('button', { name: '开始排版', exact: true }).click(),
    ]);
    assert.equal(formatResponse.status(), 200);
    const formatBody = await formatResponse.json();
    assert.ok(formatBody.record?.id);
    created.push({ kind: 'formatter', id: formatBody.record.id });
    const expectedFormatOutput = await formatterPanel.getByRole('textbox', { name: '排版结果' }).inputValue();
    await formatterPage.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    const reloadedFormatterPanel = formatterPage.locator('#tool-panel-format');
    assert.equal(await reloadedFormatterPanel.getByRole('textbox', { name: '原始文案' }).inputValue(), '');
    const [formatListResponse] = await Promise.all([
      formatterPage.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/formatter/history'),
      reloadedFormatterPanel.getByRole('button', { name: '历史记录', exact: true }).click(),
    ]);
    assert.equal(formatListResponse.status(), 200);
    const formatRow = reloadedFormatterPanel.locator(`[data-formatter-history-id="${formatBody.record.id}"]`);
    await formatRow.waitFor({ state: 'visible' });
    const [formatDetailResponse] = await Promise.all([
      formatterPage.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/formatter/history/detail'),
      formatRow.click(),
    ]);
    assert.equal(formatDetailResponse.status(), 200);
    await formatterPage.waitForFunction(expected => document.querySelector('textarea[aria-label="原始文案"]')?.value === expected, `  ${marker}  清 晨。`);
    assert.equal(await reloadedFormatterPanel.getByRole('textbox', { name: '排版结果' }).inputValue(), expectedFormatOutput);
    const [formatListForDelete] = await Promise.all([
      formatterPage.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/formatter/history'),
      reloadedFormatterPanel.getByRole('button', { name: '历史记录', exact: true }).click(),
    ]);
    assert.equal(formatListForDelete.status(), 200);
    const [formatDelete] = await Promise.all([
      formatterPage.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/formatter/history'),
      reloadedFormatterPanel.getByRole('button', { name: `删除排版历史 ${formatBody.record.id}`, exact: true }).click(),
    ]);
    assert.equal(formatDelete.status(), 200);
    await reloadedFormatterPanel.locator(`[data-formatter-history-id="${formatBody.record.id}"]`).waitFor({ state: 'detached' });
    const deletedFormatDetail = await fetch(`${origin}/api/formatter/history/detail?id=${encodeURIComponent(formatBody.record.id)}`, { headers: authHeaders, signal: AbortSignal.timeout(15_000) });
    assert.equal(deletedFormatDetail.status, 404);
    report.history.formatter = { passed: true, saved: true, listed: true, restored: true, deleted: true };
    await formatterPage.close();

    const segmentPage = await context.newPage();
    await attachDiagnostics(segmentPage, 'segmenter-history-real', { allowHistoryWrites: true });
    await installIdentity(segmentPage, themes[1], { mockHistory: false });
    await segmentPage.goto(`${origin}/tools?tab=segment`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const segmentPanel = segmentPage.locator('#tool-panel-segment');
    const segmentMarker = `验收分段${Date.now()}`;
    const segmentInput = `${segmentMarker}。${'这是一段用于验证历史保存恢复与删除的完整口播文案。'.repeat(12)}`;
    await segmentPanel.getByRole('textbox', { name: '需要分段的文案' }).fill(segmentInput);
    const [segmentResponse] = await Promise.all([
      segmentPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/segmenter/history'),
      segmentPanel.getByRole('button', { name: '开始分段', exact: true }).click(),
    ]);
    assert.equal(segmentResponse.status(), 200);
    const segmentBody = await segmentResponse.json();
    assert.ok(segmentBody.record?.id);
    created.push({ kind: 'segmenter', id: segmentBody.record.id });
    const expectedSegmentCount = await segmentPanel.locator('[data-segment-index]').count();
    await segmentPage.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    const reloadedSegmentPanel = segmentPage.locator('#tool-panel-segment');
    assert.equal(await reloadedSegmentPanel.getByRole('textbox', { name: '需要分段的文案' }).inputValue(), '');
    const [segmentListResponse] = await Promise.all([
      segmentPage.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/segmenter/history'),
      reloadedSegmentPanel.getByRole('button', { name: '历史记录', exact: true }).click(),
    ]);
    assert.equal(segmentListResponse.status(), 200);
    const segmentRow = reloadedSegmentPanel.locator(`[data-segmenter-history-id="${segmentBody.record.id}"]`);
    await segmentRow.waitFor({ state: 'visible' });
    const [segmentDetailResponse] = await Promise.all([
      segmentPage.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/segmenter/history/detail'),
      segmentRow.click(),
    ]);
    assert.equal(segmentDetailResponse.status(), 200);
    await segmentPage.waitForFunction(expected => document.querySelector('textarea[aria-label="需要分段的文案"]')?.value === expected, segmentInput);
    assert.equal(await reloadedSegmentPanel.locator('[data-segment-index]').count(), expectedSegmentCount);
    assert.equal(await reloadedSegmentPanel.locator('[data-duration="8"]').getAttribute('aria-pressed'), 'true');
    const [segmentListForDelete] = await Promise.all([
      segmentPage.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/segmenter/history'),
      reloadedSegmentPanel.getByRole('button', { name: '历史记录', exact: true }).click(),
    ]);
    assert.equal(segmentListForDelete.status(), 200);
    const [segmentDelete] = await Promise.all([
      segmentPage.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/segmenter/history'),
      reloadedSegmentPanel.getByRole('button', { name: `删除分段历史 ${segmentBody.record.id}`, exact: true }).click(),
    ]);
    assert.equal(segmentDelete.status(), 200);
    await reloadedSegmentPanel.locator(`[data-segmenter-history-id="${segmentBody.record.id}"]`).waitFor({ state: 'detached' });
    const deletedSegmentDetail = await fetch(`${origin}/api/segmenter/history/detail?id=${encodeURIComponent(segmentBody.record.id)}`, { headers: authHeaders, signal: AbortSignal.timeout(15_000) });
    assert.equal(deletedSegmentDetail.status, 404);
    report.history.segmenter = { passed: true, saved: true, listed: true, restored: true, deleted: true };
    await segmentPage.close();
  } finally {
    const cleanupFailures = [];
    for (const item of created) {
      const endpoint = item.kind === 'formatter' ? '/api/formatter/history' : '/api/segmenter/history';
      const detailEndpoint = `${endpoint}/detail`;
      try {
        const response = await fetch(`${origin}${endpoint}?id=${encodeURIComponent(item.id)}`, {
          method: 'DELETE', headers: authHeaders, signal: AbortSignal.timeout(15_000),
        });
        const detail = await fetch(`${origin}${detailEndpoint}?id=${encodeURIComponent(item.id)}`, {
          headers: authHeaders, signal: AbortSignal.timeout(15_000),
        });
        const cleaned = response.ok && detail.status === 404;
        report.history.cleanup.push({ ...item, status: response.status, detailStatus: detail.status, cleaned });
        if (!cleaned) cleanupFailures.push(`${item.kind}:${item.id}`);
      } catch (error) {
        report.history.cleanup.push({ ...item, cleaned: false, error: String(error.message || error) });
        cleanupFailures.push(`${item.kind}:${item.id}`);
      }
    }
    await context.close();
    assert.deepEqual(cleanupFailures, [], `History cleanup failed: ${cleanupFailures.join(', ')}`);
  }
}

async function verifyAdjacent(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  for (const tab of ['text', 'video']) {
    const page = await context.newPage();
    await attachDiagnostics(page, `adjacent-${tab}`);
    await installIdentity(page, themes[1]);
    const response = await page.goto(`${origin}/tools?tab=${tab}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(response?.status(), 200);
    await page.getByRole('tab', { name: tab === 'text' ? /文案提取/u : /视频提取/u, selected: true }).waitFor({ state: 'visible' });
    const bodyText = await page.locator('body').innerText();
    assert.ok(bodyText.includes(tab === 'text' ? '文案提取' : '视频提取'));
    report.adjacent.push({ tab, http: response?.status(), visible: true });
    await page.close();
  }
  await context.close();
}

const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
try {
  for (const theme of themes) {
    for (const viewport of viewports) {
      await visualAudit(browser, theme, viewport, 'format');
      await visualAudit(browser, theme, viewport, 'segment');
      await visualAudit(browser, theme, viewport, 'text');
      await verifyVideoWorkbench(browser, theme, viewport);
    }
  }
  await verifyFormatter(browser);
  await verifySegmenter(browser);
  await verifyRealHistory(browser);
  await verifyAdjacent(browser);
  assert.equal(report.pageErrors.length, 0, `page errors: ${JSON.stringify(report.pageErrors)}`);
  assert.equal(report.httpErrors.length, 0, `HTTP errors: ${JSON.stringify(report.httpErrors)}`);
  assert.equal(report.unexpectedWrites.length, 0, `unexpected writes: ${JSON.stringify(report.unexpectedWrites)}`);
  assert.equal(report.externalApiRequests.length, 0, `external API requests: ${JSON.stringify(report.externalApiRequests)}`);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, message: String(error.message).slice(0, 1200), stack: String(error.stack || '').slice(0, 3000) };
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(outputDir, 'live-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: report.passed,
    visualCases: report.visual.length,
    formatter: report.formatter,
    segmenter: report.segmenter,
    videoCases: report.video.length,
    history: report.history,
    adjacent: report.adjacent,
    pageErrors: report.pageErrors.length,
    httpErrors: report.httpErrors.length,
    unexpectedWrites: report.unexpectedWrites.length,
    externalApiRequests: report.externalApiRequests.length,
    failure: report.failure,
  }, null, 2));
  await browser.close();
}
