import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN;
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token);
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY);
  const buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  const version = JSON.parse(await readFile('public/version.json', 'utf8')).sourceVersion;
  const out = path.resolve('../运行日志/Seedance-Token修复-20261018', `visual-${version}-${Date.now()}`);
  await mkdir(out, { recursive: true });
  const report = { version, buildId, viewport: { width: 1440, height: 900 }, realCatalog: true,
    localThemePreview: true, paidGenerationCalls: 0, serverBusinessWrites: 0, checks: [], errors: [], blocked: [], httpErrors: [], consoleErrors: [] };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of [{id:'lattice',mode:'dark'},{id:'soft-white',mode:'light'},{id:'crystal-aurora',mode:'dark'}]) {
      const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: 'block' });
      await context.addInitScript(({ token, identity, theme }) => {
        localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(identity.user));
        localStorage.setItem('entered_app','1'); sessionStorage.setItem('entered_app','1');
        localStorage.setItem('platform_theme', theme.id); localStorage.setItem('platform_theme_mode', theme.mode);
      }, { token, identity, theme });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin && /^https?:$/.test(url.protocol)) return route.abort();
        if (request.method() !== 'GET') {
          report.blocked.push({ path: url.pathname, method: request.method() });
          return route.fulfill({ status: 204, body: '' });
        }
        if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { ...identity.user,
          themePreference: theme.id, themeModePreference: theme.mode, themePreferenceExpiresAt:'2099-01-01T00:00:00.000Z' } } });
        if (['/api/settings','/api/settings/appearance'].includes(url.pathname)) return route.fulfill({ json: { settings: {theme: theme.id,theme_mode:theme.mode} } });
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === origin && response.status() >= 400) report.httpErrors.push({ path: url.pathname, status: response.status() });
      });
      for (const routePath of ['/storyboard-workbench','/video','/image-workbench','/tools']) {
        await page.goto(origin + routePath, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2200);
        if (['/storyboard-workbench','/video'].includes(routePath)) {
          const response = await context.request.get(origin + '/api/video/models?surface=' + (routePath === '/video' ? 'video-page' : 'storyboard-workbench'), { headers: { Authorization: `Bearer ${token}` } });
          assert.equal(response.status(), 200);
          const body = await response.json();
          const models = body.models.filter(model => model.capabilities?.billingUnit === 'token');
          // These existing models are assigned to storyboard/free-canvas/film-studio.
          // The adjacent video page keeps its original catalog assignment.
          assert.equal(models.length, routePath === '/storyboard-workbench' ? 3 : 0);
          report.checks.push({ theme: theme.id, route: routePath, catalogModels: body.models.length,
            tokenModels: models.length, originalWorkspaceAssignmentPreserved: true });
          for (const model of models) {
            assert.equal(model.capabilities.available, true, model.displayName); assert.equal(model.capabilities.priceReady, true, model.displayName);
            assert.ok(model.tokenPricing?.priceVersion); assert.ok(!JSON.stringify(model).includes('token_cost_prices'));
            const button = page.locator(routePath === '/video' ? `[data-video-model-id="${model.id}"]` : `.sbw-video-model-list [data-model-id="${model.id}"]`);
            await button.waitFor({state:'visible'}); assert.notEqual(await button.getAttribute('aria-disabled'), 'true'); assert.equal(await button.isEnabled(), true);
            assert.match(await button.innerText(), /百万Token/);
            assert.doesNotMatch(await button.innerText(), /Token结算适配中|价格待配置|暂时不可用/);
            await button.click();
            const limit = page.getByLabel('每条视频本次最多自动扣款金额');
            await limit.waitFor({state:'visible'}); assert.equal(await limit.inputValue(), '');
            await limit.fill('5.00'); assert.equal(await limit.inputValue(), '5.00');
            report.checks.push({ theme: theme.id, route: routePath, model: model.displayName, selectable: true, explicitLimit: true });
          }
        }
        const layout = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
          overflow: document.documentElement.scrollWidth > innerWidth + 2,
          heading: document.title }));
        assert.equal(layout.theme, theme.id); assert.equal(layout.overflow, false);
        const screenshot = `${theme.id}-${routePath.slice(1)}.png`;
        await page.screenshot({path:path.join(out,screenshot),fullPage:false});
        report.checks.push({theme:theme.id,route:routePath,layout,screenshot});
      }
      await context.close();
    }
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
    report.generationRequestAttempts = report.blocked.filter(request => /generate|payment|recharge|wallet|deduct/.test(request.path)).length;
    assert.equal(report.generationRequestAttempts, 0, 'No paid request may be attempted');
    assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors));
    report.passed = true;
  } catch (error) { report.passed = false; report.failure = error.message; process.exitCode = 1; }
  finally { await browser.close(); await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failure:report.failure,output:out,paidGenerationCalls:0})); }
}
