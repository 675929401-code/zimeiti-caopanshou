import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Run through with-local-admin-session.mjs. Credentials remain in memory.
export async function main() {
  const origin = 'http://127.0.0.1:5000';
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}');
  assert.ok(token && identity.user, 'Verified local administrator required');
  const output = path.resolve('.codex-evidence/chunk-recovery-20261109/browser');
  await fs.mkdir(output, { recursive: true });
  const version = await (await fetch(`${origin}/api/version`)).json();
  const chunks = await fs.readdir('.next/static/chunks');
  const marketplaceChunk = chunks.find(file => /^83520\.[a-f0-9]+\.js$/u.test(file));
  assert.ok(marketplaceChunk, 'Reconfirm marketplace chunk identity if webpack changes its ID');
  const browser = await chromium.launch({ headless: true });
  const report = { buildId: version.buildId, sourceVersion: version.sourceVersion, checks: [], errors: [], failedResources: [], blockedWrites: [], unexpectedWrites: [], passed: false };
  try {
    async function contextFor(mode = 'normal') {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', locale: 'zh-CN' });
      const state = { chunkRequests: 0, documents: 0 };
      await context.addInitScript(({ sessionToken, user }) => {
        localStorage.setItem('auth_token', sessionToken);
        localStorage.setItem('auth_user', JSON.stringify(user));
        sessionStorage.setItem('entered_app', '1');
      }, { sessionToken: token, user: identity.user });
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== origin) return route.abort('blockedbyclient');
        if (request.resourceType() === 'document') state.documents++;
        if (url.pathname.endsWith(`/${marketplaceChunk}`)) {
          state.chunkRequests++;
          if (mode === 'persistent' || (mode === 'once' && state.chunkRequests === 1)) {
            return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Deliberate chunk failure for local acceptance' });
          }
        }
        if (url.pathname === '/api/auth/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, ...identity }) });
        if (!['GET', 'HEAD'].includes(request.method())) {
          report.blockedWrites.push(url.pathname);
          if (['/api/announcements/events', '/api/operation-events', '/api/diagnostic-logs', '/api/product-usage/events', '/api/client-error-report'].includes(url.pathname)) {
            return route.fulfill({ status: 202, contentType: 'application/json', body: '{"success":true,"readonlyAcceptance":true}' });
          }
          report.unexpectedWrites.push(url.pathname);
          return route.abort('blockedbyclient');
        }
        if (/^\/api\/(?:image\/status|video\/(?:status|poll|stream)|health)(?:\/|$)/u.test(url.pathname)) return route.abort('blockedbyclient');
        return route.continue({ headers: { ...request.headers(), authorization: `Bearer ${token}` } });
      });
      return { context, state };
    }

    const normal = await contextFor();
    const page = await normal.context.newPage();
    page.on('pageerror', error => report.errors.push(error.message.slice(0, 500)));
    page.on('response', response => {
      if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/_next/')) report.failedResources.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    const routes = [
      ['/', '.marketplace-category-bar', 'home'],
      ['/cover', '[data-cover-workbench]', 'cover'],
      ['/tools', 'section[aria-label="短视频效率工具工作区"]', 'tools'],
    ];
    for (const [route, selector, name] of routes) {
      await page.goto(origin + route, { waitUntil: 'networkidle', timeout: 60000 });
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: 20000 });
      assert.equal(await page.getByText(/模块出现异常|Loading chunk \d+ failed/u).count(), 0);
      await page.screenshot({ path: path.join(output, `${name}.png`) });
      report.checks.push({ id: `render-${name}`, passed: true, route });
    }
    for (const legacy of ['/image-workbench', '/tools/image/image-chat']) {
      await page.goto(origin + legacy, { waitUntil: 'networkidle' });
      assert.equal(new URL(page.url()).pathname, '/');
      await page.locator('.marketplace-category-bar').waitFor();
      report.checks.push({ id: `legacy-redirect-${legacy}`, passed: true });
    }
    await page.goto(origin, { waitUntil: 'networkidle' });
    for (const retiredLabel of ['行业选题', '选题工作台', '发布中心']) {
      assert.equal(await page.getByRole('button', { name: retiredLabel, exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: retiredLabel, exact: true }).count(), 0);
    }
    for (const retiredRoute of ['/topics', '/topics/admin', '/topics/removed-example', '/api/topics/catalog', '/api/topics/workspace', '/api/topics/analyses']) {
      const response = await normal.context.request.get(origin + retiredRoute, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status(), 404, `${retiredRoute} must be removed`);
    }
    report.checks.push({ id: 'topics-navigation-and-routes-removed', passed: true });
    await page.getByRole('button', { name: '打开效率工具', exact: true }).first().click();
    await page.waitForURL(url => url.pathname === '/tools' && url.searchParams.get('tab') === 'text');
    await page.locator('section[aria-label="短视频效率工具工作区"]').waitFor();
    report.checks.push({ id: 'marketplace-tools-navigation', passed: true });
    await normal.context.close();

    for (const mode of ['once', 'persistent']) {
      const test = await contextFor(mode);
      const target = await test.context.newPage();
      await target.goto(origin, { waitUntil: 'networkidle' });
      const recover = target.getByRole('button', { name: '刷新页面恢复', exact: true });
      await recover.waitFor();
      await target.evaluate(() => localStorage.setItem('chunk-recovery-preserve', 'existing-local-state'));
      await target.waitForTimeout(1000);
      assert.equal(test.state.documents, 1, 'Failure must not auto-reload and discard unsaved input');
      await target.screenshot({ path: path.join(output, `failure-${mode}.png`) });
      await Promise.all([target.waitForEvent('load'), recover.click()]);
      if (mode === 'once') {
        await target.locator('.marketplace-category-bar').waitFor({ state: 'visible' });
        await target.screenshot({ path: path.join(output, 'recovered.png') });
      } else {
        await recover.waitFor();
        await target.waitForTimeout(1000);
      }
      assert.equal(test.state.documents, 2, 'Only the explicit click may reload');
      assert.equal(test.state.chunkRequests, 2, 'Reload must request the failed chunk again');
      assert.equal(await target.evaluate(() => localStorage.getItem('chunk-recovery-preserve')), 'existing-local-state');
      report.checks.push({ id: `chunk-${mode}`, passed: true, ...test.state });
      await test.context.close();
    }
    assert.deepEqual(report.errors, [], 'Normal routes must have no uncaught render errors');
    assert.deepEqual(report.failedResources, [], 'Normal routes must have no failed Next resources');
    assert.deepEqual(report.unexpectedWrites, [], 'Read-only navigation must not attempt business writes');
    report.passed = true;
  } finally {
    await browser.close();
    report.blockedWrites = [...new Set(report.blockedWrites)];
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}
