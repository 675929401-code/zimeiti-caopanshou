import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const themes = [{ id: 'lattice', mode: 'dark' }, { id: 'soft-white', mode: 'light' }, { id: 'crystal-aurora', mode: 'dark' }];
const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const name = model => [model.displayName, model.variantLabel].filter(Boolean).join(' ');
function expectedPrice(model) {
  const c = model.capabilities || {}, resolution = c.defaultResolution || '1K';
  const configured = Array.isArray(c.resolutionPrices) ? c.resolutionPrices.map(entry => String(entry).split('=', 2))
    .find(([key]) => key.trim().toUpperCase() === resolution.trim().toUpperCase())?.[1] : undefined;
  return configured !== undefined ? Number(configured) : model.publicPrice;
}
function available(model) { return model.capabilities?.available !== false && model.capabilities?.priceReady !== false; }
async function options(page) {
  return page.getByLabel('生图模型', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => ({
    value: node.value, text: node.textContent.trim(), disabled: node.disabled,
  })));
}
async function assertDirectory(page, models) {
  const actual = await options(page);
  assert.deepEqual(actual.map(option => option.value), models.map(model => model.id), 'All DTO entries retain their backend order and IDs');
  models.forEach((model, index) => {
    assert.ok(actual[index].text.startsWith(name(model)), 'Public backend display names remain visible');
    assert.equal(actual[index].disabled, !available(model));
    if (!available(model)) assert.ok(actual[index].text.includes(model.capabilities?.availabilityMessage || '当前未开放'));
  });
  const selected = models.find(available) || models[0];
  assert.equal(await page.getByLabel('生图模型', { exact: true }).inputValue(), selected?.id || '');
}
async function switchModels(page, models) {
  const checks = [], select = page.getByLabel('生图模型', { exact: true });
  for (const model of models.filter(available)) {
    await select.selectOption(model.id); assert.equal(await select.inputValue(), model.id);
    const price = expectedPrice(model); assert.equal(typeof price, 'number');
    const displayedPrice = await page.locator('.cover-cost-line strong').innerText();
    assert.equal(displayedPrice, `¥${price.toFixed(2)}`);
    checks.push({ publicModelId: model.id, name: name(model), displayedPrice, selectedValue: await select.inputValue() });
  }
  return checks;
}
async function surface(page) {
  return page.locator('aside.cover-director-panel').evaluate(aside => {
    const card = aside.querySelector(':scope > .cover-priority-card'), s = getComputedStyle(aside), c = getComputedStyle(card);
    const a = aside.getBoundingClientRect(), b = card.getBoundingClientRect();
    return { backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage, boxShadow: s.boxShadow,
      gutter: s.scrollbarGutter, cardRadius: c.borderRadius, leftGap: b.left - a.left, rightGap: a.right - b.right };
  });
}
function assertSurface(value) {
  assert.equal(value.backgroundColor, 'rgba(0, 0, 0, 0)'); assert.equal(value.backgroundImage, 'none');
  assert.equal(value.boxShadow, 'none'); assert.equal(value.gutter, 'auto'); assert.equal(value.cardRadius, '13px');
  assert.ok(Math.abs(value.leftGap) <= 1 && Math.abs(value.rightGap) <= 1);
}
export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN, token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token);
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY);
  const versionResponse = await fetch(origin + '/api/version'); assert.equal(versionResponse.status, 200);
  const runtime = await versionResponse.json();
  assert.equal(runtime.buildId, (await readFile('.next/BUILD_ID', 'utf8')).trim());
  assert.equal(runtime.sourceVersion, JSON.parse(await readFile('public/version.json', 'utf8')).sourceVersion);
  const catalogResponse = await fetch(origin + '/api/cover-models?surface=cover-studio', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json();
  assert.ok(Array.isArray(catalog.models)); assert.equal(catalog.models.length, 3, 'The configured current cover catalog has three models');
  const realModels = catalog.models;
  const extra = structuredClone(realModels[0]); extra.id = 'pm_fixture_fourth_cover'; extra.displayName = '验收 fixture 第四款'; delete extra.variantLabel;
  extra.publicPrice = 0.47; extra.capabilities = { ...extra.capabilities, available: true, priceReady: true, availabilityMessage: '',
    resolutionPrices: [`${extra.capabilities.defaultResolution || '1K'}=0.47`] };
  const disabled = structuredClone(realModels[1]); disabled.capabilities = { ...disabled.capabilities, available: false,
    availabilityMessage: '验收 fixture：后台暂停生成' };
  const fixtureModels = [disabled, extra, structuredClone(realModels[2]), structuredClone(realModels[0])];
  const out = path.resolve('../运行日志/封面双层底板修复-20261018/model-select', `visual-${runtime.sourceVersion}-${Date.now()}`);
  await mkdir(out, { recursive: true });
  const report = { runtime, realCatalogModelCount: realModels.length, realCatalog: true, fixtureCasesClearlySeparated: true,
    nativePopupScreenshotLimitation: 'Native select popup visibility is browser/OS dependent; keyboard expansion screenshots do not establish the popup pixels were captured.',
    paidGenerationCalls: 0, serverBusinessWrites: 0, checks: [], blocked: [], errors: [], consoleErrors: [], httpErrors: [], expectedHttpErrors: [], expectedConsoleErrors: [] };
  const browser = await chromium.launch({ headless: true });
  async function contextFor(theme, viewport, fixture = null) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const label = `${theme.id}-${viewport.width}x${viewport.height}${fixture ? '-fixture-' + fixture : ''}`;
    await context.addInitScript(({ token, identity, theme }) => {
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(identity.user));
      localStorage.setItem('entered_app', '1'); sessionStorage.setItem('entered_app', '1');
      localStorage.setItem('platform_theme', theme.id); localStorage.setItem('platform_theme_mode', theme.mode);
    }, { token, identity, theme });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') { report.blocked.push({ label, path: url.pathname, method: request.method() }); return route.fulfill({ status: 204, body: '' }); }
      if (url.origin !== origin && /^https?:$/.test(url.protocol)) return route.abort();
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { ...identity.user,
        themePreference: theme.id, themeModePreference: theme.mode, themePreferenceExpiresAt: '2099-01-01T00:00:00.000Z' } } });
      if (['/api/settings', '/api/settings/appearance'].includes(url.pathname)) return route.fulfill({ json: { settings: { theme: theme.id, theme_mode: theme.mode } } });
      if (fixture && url.pathname === '/api/cover-models') {
        if (fixture === 'loading') await new Promise(resolve => setTimeout(resolve, 3000));
        if (fixture === 'error') return route.fulfill({ status: 503, json: { error: 'Explicit directory error fixture' } });
        return route.fulfill({ json: { ...catalog, models: fixture === 'empty' ? [] : fixtureModels } });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push({ label, message: error.message }));
    page.on('response', response => {
      const url = new URL(response.url()); if (url.origin !== origin || response.status() < 400) return;
      const item = { label, path: url.pathname, status: response.status() };
      (fixture === 'error' && url.pathname === '/api/cover-models' && response.status() === 503 ? report.expectedHttpErrors : report.httpErrors).push(item);
    });
    page.on('console', message => {
      if (message.type() !== 'error') return; const item = { label, message: message.text() };
      (fixture === 'error' && /Failed to load resource.*503/.test(item.message) ? report.expectedConsoleErrors : report.consoleErrors).push(item);
    });
    return { context, page, label };
  }
  try {
    for (const viewport of viewports) for (const theme of themes) {
      const { context, page, label } = await contextFor(theme, viewport);
      await page.goto(origin + '/cover', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const select = page.getByLabel('生图模型', { exact: true }); await select.waitFor({ state: 'visible' });
      await page.waitForFunction(count => document.querySelectorAll('.cover-model-select option').length === count && !document.querySelector('.cover-model-select').disabled, realModels.length);
      await assertDirectory(page, realModels); const switches = await switchModels(page, realModels);
      await select.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert.equal(await select.evaluate(node => document.activeElement === node), true, 'Select is reachable by keyboard focus');
      const selectable = realModels.filter(available); assert.ok(selectable.length >= 2, 'Two real options are required for keyboard switching');
      await select.selectOption(selectable[0].id); await select.focus();
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await select.inputValue(), selectable[1].id, 'ArrowDown/Enter selects the next available backend model');
      assert.equal(await page.locator('.cover-cost-line strong').innerText(), `¥${expectedPrice(selectable[1]).toFixed(2)}`);
      const keyboardSelection = { from: selectable[0].id, to: selectable[1].id,
        displayedPrice: await page.locator('.cover-cost-line strong').innerText(), keys: ['ArrowDown', 'Enter'] };
      const layout = await select.evaluate(node => ({ height: node.getBoundingClientRect().height,
        theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > innerWidth + 2 }));
      assert.equal(layout.height, 44); assert.equal(layout.theme, theme.id); assert.equal(layout.overflow, false);
      const panel = await surface(page); assertSurface(panel);
      const screenshot = `${label}-cover.png`, popup = `${label}-native-expansion-attempt.png`;
      await page.screenshot({ path: path.join(out, screenshot) });
      await select.press('Alt+ArrowDown'); await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(out, popup) }); await page.keyboard.press('Escape');
      report.checks.push({ kind: 'real-catalog', label, switches, options: await options(page), keyboardFocusable: true, keyboardSelection, layout, surface: panel,
        screenshot, popupScreenshot: popup, nativePopupPixelsVerified: false });
      for (const routePath of ['/image-workbench', '/storyboard-workbench']) {
        await page.goto(origin + routePath, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(1500);
        const adjacent = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > innerWidth + 2 }));
        assert.equal(adjacent.theme, theme.id); assert.equal(adjacent.overflow, false);
        const file = `${label}-${routePath.slice(1)}.png`; await page.screenshot({ path: path.join(out, file) });
        report.checks.push({ kind: 'adjacent-route', label, route: routePath, layout: adjacent, screenshot: file });
      }
      await context.close();
    }
    for (const theme of themes) for (const fixture of ['ordered-fourth-unavailable', 'loading', 'empty', 'error']) {
      const { context, page, label } = await contextFor(theme, viewports[0], fixture);
      await page.goto(origin + '/cover', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const select = page.getByLabel('生图模型', { exact: true }); await select.waitFor({ state: 'visible' });
      const status = page.locator('#cover-model-catalog-status');
      if (fixture === 'loading') {
        await status.getByText('正在读取当前封面模型目录…', { exact: true }).waitFor(); assert.equal(await select.isDisabled(), true);
        const loadingScreenshot = `${label}-pending.png`; await page.screenshot({ path: path.join(out, loadingScreenshot) });
        report.checks.push({ kind: 'explicit-GET-loading-fixture', label, fixture: true, disabled: true,
          status: await status.innerText(), screenshot: loadingScreenshot });
      }
      if (fixture === 'empty') {
        await status.getByText('当前封面模型目录为空，请联系管理员配置。', { exact: true }).waitFor();
        assert.equal(await select.isDisabled(), true); assert.equal(await select.inputValue(), '');
      } else if (fixture === 'error') {
        await status.getByText('模型列表暂时不可用，请稍后刷新；仍可先完成封面拆解。', { exact: true }).waitFor();
        assert.equal(await status.getAttribute('role'), 'alert'); assert.equal(await select.isDisabled(), true);
      } else {
        await page.waitForFunction(() => document.querySelectorAll('.cover-model-select option').length === 4 && !document.querySelector('.cover-model-select').disabled);
        await assertDirectory(page, fixtureModels); const switches = await switchModels(page, fixtureModels);
        assert.equal((await options(page)).find(option => option.value === disabled.id).disabled, true);
        report.checks.push({ kind: 'explicit-GET-fixture-switches', label, fixture: true, switches });
      }
      assertSurface(await surface(page));
      const screenshot = `${label}.png`; await page.screenshot({ path: path.join(out, screenshot) });
      report.checks.push({ kind: 'explicit-GET-directory-fixture', label, fixture: true, case: fixture,
        options: await options(page), status: await status.innerText(), screenshot });
      await context.close();
    }
    report.generationRequestAttempts = report.blocked.filter(item => /generate|\/cover\/attempt|payment|recharge|wallet|deduct/.test(item.path)).length;
    assert.equal(report.generationRequestAttempts, 0); assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors)); assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.passed = true;
  } catch (error) { report.passed = false; report.failure = error.stack || error.message; process.exitCode = 1; }
  finally { await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output: out,
      generationRequestAttempts: report.generationRequestAttempts, failure: report.failure })); }
}
