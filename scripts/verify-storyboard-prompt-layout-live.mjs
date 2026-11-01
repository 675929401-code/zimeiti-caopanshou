import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const themes = [{ id: 'lattice', mode: 'dark' }, { id: 'soft-white', mode: 'light' }, { id: 'crystal-aurora', mode: 'dark' }];
const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const evidenceRoot = path.resolve('../运行日志/分镜提示词等高-20261018');
async function previousBaseline() {
  const explicit = process.argv.find(arg => arg.startsWith('--baseline-report='));
  if (explicit) return { path: path.resolve(explicit.slice('--baseline-report='.length)), report: JSON.parse(await readFile(explicit.slice('--baseline-report='.length), 'utf8')) };
  const entries = await readdir(evidenceRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter(item => item.isDirectory() && item.name.startsWith('baseline-')).sort((a, b) => b.name.localeCompare(a.name))) {
    const file = path.join(evidenceRoot, entry.name, 'report.json');
    const report = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    if (report.passed && report.baseline) return { path: file, report };
  }
  return null;
}
async function measure(page) {
  return page.locator('.sbw-shot-card').evaluateAll(cards => cards.map((card, index) => {
    const header = card.querySelector('.sbw-card-header');
    const label = card.querySelector('.sbw-image-flow > .sbw-stage-label');
    const image = card.querySelector('.sbw-image-flow .sbw-flow-prompt textarea');
    const video = card.querySelector('.sbw-video-flow .sbw-flow-prompt textarea');
    const media = card.querySelector('.sbw-shared-media-frame');
    const style = node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return {
      height: r.height, width: r.width, minHeight: s.minHeight, maxHeight: s.maxHeight,
      background: s.background, color: s.color, borderColor: s.borderColor,
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
    }; };
    return { index, cardId: card.dataset.sbwCardId, headerGap: label.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
      card: style(card), image: style(image), video: style(video), media: style(media) };
  }));
}
function verifyDimensions(cards, baselineCards, compareColors = false) {
  assert.equal(cards.length, 3, 'The fresh workbench must show the three default segment cards');
  for (const card of cards) {
    for (const input of [card.image, card.video]) {
      assert.ok(Math.abs(input.height - 120) <= 0.5, `card ${card.index + 1}: textarea height ${input.height}`);
      assert.equal(input.minHeight, '120px'); assert.equal(input.maxHeight, '320px');
    }
    assert.ok(card.headerGap >= 0 && card.headerGap <= 8, `card ${card.index + 1}: header gap ${card.headerGap}`);
    assert.equal(card.media.minHeight, '118px'); assert.equal(card.media.maxHeight, '190px');
    assert.ok(card.media.height >= 118 - 0.5 && card.media.height <= 190 + 0.5);
    const old = baselineCards?.[card.index];
    if (old) {
      assert.ok(Math.abs(card.media.height - old.media.height) <= 1, 'Existing media preview height must be preserved');
      if (compareColors) for (const part of ['card', 'image', 'video', 'media']) for (const property of ['background', 'color', 'borderColor']) {
        assert.equal(card[part][property], old[part][property], `Existing theme ${part}.${property} must be preserved`);
      }
    }
  }
}
export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN, token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token);
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY);
  const baseline = process.argv.includes('--baseline');
  const identityResponse = await fetch(origin + '/api/version'); assert.equal(identityResponse.status, 200);
  const runtime = await identityResponse.json();
  const diskBuildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  const diskVersion = JSON.parse(await readFile('public/version.json', 'utf8')).sourceVersion;
  if (!baseline) { assert.equal(runtime.buildId, diskBuildId); assert.equal(runtime.sourceVersion, diskVersion); }
  const prior = baseline ? null : await previousBaseline();
  const out = path.join(evidenceRoot, `${baseline ? 'baseline' : 'visual'}-${runtime.sourceVersion}-${Date.now()}`);
  await mkdir(out, { recursive: true });
  const report = { baseline, runtime, diskBuildId, diskVersion, baselineReport: prior?.path || null,
    targetDimensionsAsserted: !baseline, runningLatestClaimed: false,
    identityNote: baseline ? 'Measures the served old UI; a new verifier source does not establish runningLatest.' : 'Served identity matches disk build/version; runningLatest remains the coordinator launcher check.',
    realCatalog: true, localThemePreview: true, paidGenerationCalls: 0, serverBusinessWrites: 0,
    checks: [], errors: [], consoleErrors: [], httpErrors: [], blocked: [] };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) for (const theme of themes) {
      const label = `${theme.id}-${viewport.width}x${viewport.height}`;
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.addInitScript(({ token, identity, theme }) => {
        localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(identity.user));
        localStorage.setItem('entered_app', '1'); sessionStorage.setItem('entered_app', '1');
        localStorage.setItem('platform_theme', theme.id); localStorage.setItem('platform_theme_mode', theme.mode);
      }, { token, identity, theme });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') {
          report.blocked.push({ theme: theme.id, viewport, path: url.pathname, method: request.method() });
          return route.fulfill({ status: 204, body: '' });
        }
        if (url.origin !== origin && /^https?:$/.test(url.protocol)) return route.abort();
        if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { ...identity.user,
          themePreference: theme.id, themeModePreference: theme.mode, themePreferenceExpiresAt: '2099-01-01T00:00:00.000Z' } } });
        if (['/api/settings', '/api/settings/appearance'].includes(url.pathname)) return route.fulfill({ json: { settings: { theme: theme.id, theme_mode: theme.mode } } });
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ label, message: error.message }));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ label, message: message.text() }); });
      page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin && response.status() >= 400) report.httpErrors.push({ label, path: url.pathname, status: response.status() }); });
      const catalogResponse = await context.request.get(origin + '/api/video/models?surface=storyboard-workbench', { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(catalogResponse.status(), 200); const catalog = await catalogResponse.json();
      assert.ok(Array.isArray(catalog.models), 'Use the real catalog DTO');
      report.checks.push({ kind: 'catalog', label, modelCount: catalog.models.length, models: catalog.models.map(m => ({ id: m.id, displayName: m.displayName, available: m.capabilities?.available })) });
      await page.goto(origin + '/storyboard-workbench', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('.sbw-shot-card').nth(2).waitFor({ state: 'visible' });
      await page.waitForTimeout(1800);
      const initial = await measure(page);
      const old = prior?.report.checks.find(check => check.kind === 'storyboard-initial' && check.label === label);
      if (!baseline) verifyDimensions(initial, old?.cards, true);
      const field = await page.locator('.sbw-root').first().evaluate(node => ({ background: getComputedStyle(node).background,
        attachment: getComputedStyle(node).backgroundAttachment, theme: document.documentElement.dataset.theme,
        overflow: document.documentElement.scrollWidth > innerWidth + 2 }));
      assert.equal(field.theme, theme.id); if (!baseline) assert.equal(field.overflow, false);
      const initialScreenshot = `${label}-storyboard-initial.png`, cardScreenshot = `${label}-card-initial.png`;
      await page.screenshot({ path: path.join(out, initialScreenshot) });
      await page.locator('.sbw-shot-card').first().screenshot({ path: path.join(out, cardScreenshot) });
      report.checks.push({ kind: 'storyboard-initial', label, viewport, theme: theme.id, cards: initial, field, initialScreenshot, cardScreenshot });
      if (!baseline) {
        const longText = Array.from({ length: 100 }, (_, i) => `第${i + 1}行：动作与画面节奏保持清晰，长提示词只在输入框内部滚动。`).join('\n');
        for (const textarea of await page.locator('.sbw-shot-card .sbw-flow-prompt textarea').all()) {
          assert.equal(await textarea.isEditable(), true); await textarea.fill(longText);
          const scroll = await textarea.evaluate(node => { node.scrollTop = node.scrollHeight; return { top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight }; });
          assert.ok(scroll.height > scroll.client && scroll.top > 0, 'Long prompt scrolls inside the textarea');
        }
        const filled = await measure(page); verifyDimensions(filled, old?.cards);
        const first = page.locator('.sbw-shot-card').first();
        await first.locator('.sbw-video-expand').click();
        const expanded = await measure(page); verifyDimensions(expanded, old?.cards);
        const longScreenshot = `${label}-card-long-prompt.png`; await first.screenshot({ path: path.join(out, longScreenshot) });
        const generate = page.locator('.sbw-shot-card').last().locator('.sbw-media-actions .is-video-command');
        await generate.scrollIntoViewIfNeeded();
        const reachable = await generate.evaluate(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.width > 0; });
        assert.equal(reachable, true, 'The bottom generation control is reachable by scrolling');
        report.checks.push({ kind: 'storyboard-long-input', label, filled, expanded, bottomGenerationReachable: reachable, longScreenshot });
      }
      for (const routePath of ['/image-workbench', '/video']) {
        await page.goto(origin + routePath, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(1800);
        const layout = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > innerWidth + 2 }));
        assert.equal(layout.theme, theme.id); if (!baseline) assert.equal(layout.overflow, false);
        const screenshot = `${label}-${routePath.slice(1)}.png`; await page.screenshot({ path: path.join(out, screenshot) });
        report.checks.push({ kind: 'adjacent-route', label, route: routePath, layout, screenshot });
      }
      await context.close();
    }
    report.generationRequestAttempts = report.blocked.filter(r => /generate|payment|recharge|wallet|deduct/.test(r.path)).length;
    assert.equal(report.generationRequestAttempts, 0, 'Generation and payment must never be attempted');
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors));
    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.passed = true;
  } catch (error) { report.passed = false; report.failure = error.stack || error.message; process.exitCode = 1; }
  finally {
    await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, baseline, targetDimensionsAsserted: !baseline,
      checks: report.checks.length, output: out, failure: report.failure, generationRequestAttempts: report.generationRequestAttempts }));
  }
}
