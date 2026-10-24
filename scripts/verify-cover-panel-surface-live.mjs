import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('../运行日志/封面双层底板修复-20261018');
const themes = [{ id: 'lattice', mode: 'dark' }, { id: 'soft-white', mode: 'light' }, { id: 'crystal-aurora', mode: 'dark' }];
const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
async function baselineReport() {
  const argument = process.argv.find(value => value.startsWith('--baseline-report='));
  if (argument) { const file = path.resolve(argument.slice('--baseline-report='.length)); return { file, data: JSON.parse(await readFile(file, 'utf8')) }; }
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs.filter(item => item.isDirectory() && item.name.startsWith('baseline-')).sort((a, b) => b.name.localeCompare(a.name))) {
    const file = path.join(root, dir.name, 'report.json'), data = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    if (data.passed && data.baseline) return { file, data };
  }
  return null;
}
async function measure(page) {
  return page.locator('aside.cover-director-panel').evaluate(aside => {
    const card = aside.querySelector(':scope > .cover-priority-card');
    const properties = node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      clientWidth: node.clientWidth, offsetWidth: node.offsetWidth,
      backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage, color: s.color,
      boxShadow: s.boxShadow, borderRadius: s.borderRadius, scrollbarGutter: s.scrollbarGutter,
      border: s.border, borderLeftWidth: s.borderLeftWidth, borderRightWidth: s.borderRightWidth,
      padding: s.padding, overflow: s.overflow, overflowX: s.overflowX, overflowY: s.overflowY,
    }; };
    return { aside: properties(aside), card: properties(card) };
  });
}
function verify(surface, old) {
  assert.equal(surface.aside.backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(surface.aside.backgroundImage, 'none'); assert.equal(surface.aside.boxShadow, 'none');
  assert.equal(surface.aside.scrollbarGutter, 'auto'); assert.equal(surface.card.borderRadius, '13px');
  assert.ok(Math.abs(surface.aside.rect.left - surface.card.rect.left) <= 1, 'Card left edge aligns with the layout column');
  assert.ok(Math.abs(surface.aside.rect.right - surface.card.rect.right) <= 1, 'Card right edge aligns without an empty scrollbar strip');
  if (old) for (const key of ['backgroundColor', 'backgroundImage', 'color', 'border', 'boxShadow']) {
    assert.equal(surface.card[key], old.card[key], `Existing card theme ${key} stays unchanged`);
  }
}
export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN, token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token);
  const actor = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY);
  const baseline = process.argv.includes('--baseline');
  const versionResponse = await fetch(origin + '/api/version'); assert.equal(versionResponse.status, 200);
  const runtime = await versionResponse.json(), diskBuildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  const diskVersion = JSON.parse(await readFile('public/version.json', 'utf8')).sourceVersion;
  if (!baseline) { assert.equal(runtime.buildId, diskBuildId); assert.equal(runtime.sourceVersion, diskVersion); }
  const previous = baseline ? null : await baselineReport();
  const out = path.join(root, `${baseline ? 'baseline' : 'visual'}-${runtime.sourceVersion}-${Date.now()}`);
  await mkdir(out, { recursive: true });
  const report = { baseline, runtime, diskBuildId, diskVersion, runningLatestClaimed: false,
    targetSurfaceAsserted: !baseline, baselineReport: previous?.file || null, localThemePreview: true,
    paidGenerationCalls: 0, serverBusinessWrites: 0, checks: [], errors: [], consoleErrors: [], httpErrors: [], blocked: [] };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) for (const theme of themes) {
      const label = `${theme.id}-${viewport.width}x${viewport.height}`;
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.addInitScript(({ token, actor, theme }) => {
        localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(actor.user));
        localStorage.setItem('entered_app', '1'); sessionStorage.setItem('entered_app', '1');
        localStorage.setItem('platform_theme', theme.id); localStorage.setItem('platform_theme_mode', theme.mode);
      }, { token, actor, theme });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') {
          report.blocked.push({ label, path: url.pathname, method: request.method() });
          return route.fulfill({ status: 204, body: '' });
        }
        if (url.origin !== origin && /^https?:$/.test(url.protocol)) return route.abort();
        if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { ...actor.user,
          themePreference: theme.id, themeModePreference: theme.mode, themePreferenceExpiresAt: '2099-01-01T00:00:00.000Z' } } });
        if (['/api/settings', '/api/settings/appearance'].includes(url.pathname)) return route.fulfill({ json: { settings: { theme: theme.id, theme_mode: theme.mode } } });
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ label, message: error.message }));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ label, message: message.text() }); });
      page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin && response.status() >= 400) report.httpErrors.push({ label, path: url.pathname, status: response.status() }); });
      await page.goto(origin + '/cover', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByLabel('输入文案', { exact: true }).waitFor({ state: 'visible' }); await page.waitForTimeout(1800);
      const surface = await measure(page), old = previous?.data.checks.find(check => check.kind === 'cover-surface' && check.label === label);
      if (!baseline) verify(surface, old?.surface);
      const layout = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > innerWidth + 2 }));
      assert.equal(layout.theme, theme.id); assert.equal(layout.overflow, false);
      const screenshots = { page: `${label}-cover.png`, panel: `${label}-left-panel.png`, card: `${label}-left-card.png`, corner: `${label}-topcorner.png` };
      await page.screenshot({ path: path.join(out, screenshots.page), fullPage: true });
      await page.locator('aside.cover-director-panel').screenshot({ path: path.join(out, screenshots.panel) });
      await page.locator('aside.cover-director-panel > .cover-priority-card').screenshot({ path: path.join(out, screenshots.card) });
      const corner = surface.aside.rect;
      await page.screenshot({ path: path.join(out, screenshots.corner), clip: {
        x: Math.max(0, corner.x - 4), y: Math.max(0, corner.y - 4), width: Math.min(corner.width + 8, viewport.width - Math.max(0, corner.x - 4)), height: 110,
      } });
      const input = page.getByLabel('输入文案', { exact: true }); assert.equal(await input.isEditable(), true);
      await input.focus(); assert.equal(await input.evaluate(node => document.activeElement === node), true);
      const text = '只读本地验收：输入文案可以编辑；不点击拆解文案或生成封面。';
      await input.fill(text); assert.equal(await input.inputValue(), text);
      const button = page.locator('.cover-generate-submit'); await button.scrollIntoViewIfNeeded();
      const reachable = await button.evaluate(node => {
        const r = node.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { inViewport: r.top >= 0 && r.bottom <= innerHeight + 1,
          unoccluded: hit === node || node.contains(hit), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
      });
      assert.equal(reachable.inViewport, true); assert.equal(reachable.unoccluded, true, 'Generation control must not be clipped or covered');
      report.checks.push({ kind: 'cover-surface', label, viewport, theme: theme.id, surface, layout,
        editable: true, focusable: true, generateButton: reachable, screenshots });
      for (const routePath of ['/image-workbench', '/storyboard-workbench']) {
        await page.goto(origin + routePath, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(1800);
        const adjacent = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > innerWidth + 2 }));
        assert.equal(adjacent.theme, theme.id); assert.equal(adjacent.overflow, false);
        const screenshot = `${label}-${routePath.slice(1)}.png`; await page.screenshot({ path: path.join(out, screenshot) });
        report.checks.push({ kind: 'adjacent-route', label, route: routePath, layout: adjacent, screenshot });
      }
      await context.close();
    }
    report.generationRequestAttempts = report.blocked.filter(item => /generate|\/cover\/attempt|payment|recharge|wallet|deduct/.test(item.path)).length;
    assert.equal(report.generationRequestAttempts, 0);
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors));
    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.passed = true;
  } catch (error) { report.passed = false; report.failure = error.stack || error.message; process.exitCode = 1; }
  finally {
    await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, baseline, targetSurfaceAsserted: !baseline,
      checks: report.checks.length, output: out, failure: report.failure, generationRequestAttempts: report.generationRequestAttempts }));
  }
}
