import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Called only after the owning task has completed the authorized permission update.
// This helper never reads credentials, writes business data, or starts automatically.
export async function verifyOwnerNavigation({ origin, token, user, directory, check }) {
  if (origin !== 'http://127.0.0.1:5000') throw new Error('Only the canonical local preview origin is allowed');
  if (!token || !user?.id || user.role !== 'admin' || typeof check !== 'function') throw new Error('Actual owner projection and assertion callback required');
  const output = path.resolve(directory);
  await fs.mkdir(output, { recursive: true });
  const report = { passed: false, checks: [], screenshots: [], errors: [], blockedWrites: [], externalRequestsBlocked: 0, authProjection: true, ownerId: user.id, buildId: null, apiVersion: null };
  const privateValues = [token, user.username, user.displayName, user.display_name].filter(value => typeof value === 'string' && value.length > 1).sort((a, b) => b.length - a.length);
  const safe = value => {
    let result = String(value ?? '');
    for (const value of privateValues) result = result.split(value).join('[redacted]');
    return result.replace(/\b1[3-9]\d{9}\b/g, '[phone-redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email-redacted]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token-redacted]');
  };
  const verify = (name, passed, detail) => {
    const entry = { name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail: safe(typeof detail === 'string' ? detail : JSON.stringify(detail)) }) };
    report.checks.push(entry);
    check(entry.name, entry.passed, entry.detail);
    if (!entry.passed) throw new Error(name);
  };
  let browser, page;
  const screenshot = async name => {
    const file = path.join(output, `${name}.png`);
    // Keep the true account in the runtime; redact only the exported evidence.
    const masks = [page.locator('[data-testid="sidebar-user-menu-trigger"]')];
    for (const value of privateValues.filter(value => value !== token)) masks.push(page.getByText(value, { exact: false }));
    masks.push(page.getByText(/\b1[3-9]\d{9}\b/));
    await page.screenshot({ path: file, fullPage: true, mask: masks });
    report.screenshots.push({ name, file });
  };
  const pathOf = response => new URL(response.url()).pathname;
  const primary = () => page.locator('[data-primary-nav-style="plain-tabs"] [data-nav-key="publish_center"]');
  const sidebar = () => page.locator('.sidebar-shortcut-grid button').filter({ hasText: '发布中心' });
  const verifyEntrances = async suffix => {
    await primary().waitFor({ state: 'visible', timeout: 30000 });
    await sidebar().first().waitFor({ state: 'visible', timeout: 30000 });
    verify(`main navigation publish entry ${suffix}`, await primary().count() >= 1 && await primary().first().isVisible());
    verify(`sidebar publish entry ${suffix}`, await sidebar().count() >= 1 && await sidebar().first().isVisible());
    const order = await page.locator('[data-primary-nav-style="plain-tabs"] [data-nav-key]').evaluateAll(items => items.map(item => item.getAttribute('data-nav-key')));
    verify(`cover publish youcai navigation order ${suffix}`, order.indexOf('cover') >= 0 && order.indexOf('publish_center') > order.indexOf('cover') && order.indexOf('youcai') > order.indexOf('publish_center'), order);
    const shortcuts = await page.locator('.sidebar-shortcut-grid button[title]').evaluateAll(items => items.map(item => item.getAttribute('title')));
    verify(`publish follows cover in sidebar ${suffix}`, shortcuts.indexOf('封面设计') >= 0 && shortcuts.indexOf('发布中心') === shortcuts.indexOf('封面设计') + 1, shortcuts);
  };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript(({ runtimeToken, runtimeUser }) => {
      localStorage.setItem('auth_token', runtimeToken);
      localStorage.setItem('auth_user', JSON.stringify(runtimeUser));
      localStorage.setItem('active_view', 'marketplace');
      sessionStorage.setItem('entered_app', '1');
      sessionStorage.setItem('trial_dialog_dismissed', '1');
    }, { runtimeToken: token, runtimeUser: user });
    await context.route('**/*', async route => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch { await route.abort(); return; }
      if (url.origin !== origin) { report.externalRequestsBlocked += 1; await route.abort(); return; }
      if (request.method() !== 'GET') {
        report.blockedWrites.push({ method: request.method(), pathname: safe(url.pathname) });
        await route.abort(); return;
      }
      if (url.pathname === '/api/auth/me') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user, auth_projection: true }) }); return;
      }
      if (url.pathname === '/api/announcements/inbox') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ announcements: [], cursor: 'owner-navigation-read-fixture', serverTime: new Date().toISOString(), unchanged: false, read_fixture: true }) }); return;
      }
      if (url.pathname === '/api/popup-pushes') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, popups: [], read_fixture: true }) }); return;
      }
      await route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(safe(error.message)));
    const permissionResponsePromise = page.waitForResponse(response => pathOf(response) === '/api/member-permissions' && response.request().method() === 'GET', { timeout: 30000 });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    const permissionResponse = await permissionResponsePromise;
    const permission = (await permissionResponse.json()).permission;
    verify('real member permission response belongs to actual owner', permissionResponse.status() === 200 && permission?.userId === user.id && permission?.integrityValid === true);
    verify('real owner permission includes publish_center', permission?.featureNavigationKeys?.includes('publish_center') === true);
    report.permission = { userId: permission.userId, revision: permission.revision, integrityValid: permission.integrityValid, featureNavigationKeys: permission.featureNavigationKeys };
    await verifyEntrances('on home');
    await primary().first().scrollIntoViewIfNeeded();
    await screenshot('owner-home-publish-entrances');
    const version = await page.evaluate(async () => (await fetch('/api/version', { cache: 'no-store' })).json());
    report.apiVersion = Object.fromEntries(Object.entries(version).filter(([key, value]) => /version|build|revision|commit|fingerprint/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key, typeof value === 'string' ? safe(value) : value]));
    report.buildId = await page.evaluate(() => window.__NEXT_DATA__?.buildId || null);
    if (!report.buildId) report.buildId = version.buildId || version.build_id || null;
    const centerResponsePromise = page.waitForResponse(response => pathOf(response) === '/api/publish-center' && response.request().method() === 'GET', { timeout: 30000 });
    // Exercise the real primary-navigation interaction, not a direct target goto.
    await primary().first().click();
    await page.waitForURL(url => url.pathname === '/publish-center', { timeout: 30000 });
    const centerResponse = await centerResponsePromise;
    const center = await centerResponse.json();
    verify('real publish center GET is allowed', centerResponse.status() === 200 && center.access?.allowed === true);
    verify('external execution and sales remain disabled', center.config?.executionEnabled === false && center.config?.salesEnabled === false);
    await page.locator('[data-publishing-workbench]').waitFor({ state: 'visible', timeout: 30000 });
    verify('publish center heading visible', await page.getByRole('heading', { name: '发布中心', exact: true }).isVisible());
    verify('publish center hero visible', await page.getByRole('heading', { name: '作品准备好，发布就从这里开始', exact: true }).isVisible());
    await page.getByText('先准备，保存草稿', { exact: true }).waitFor({ state: 'visible' });
    verify('closed publish service visible', await page.getByText('先准备，保存草稿', { exact: true }).isVisible());
    await screenshot('owner-publish-center-service-closed');
    for (const route of ['/cover', '/youcai']) {
      await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.body.innerText.trim().length > 100, undefined, { timeout: 30000 });
      const body = await page.locator('body').innerText();
      verify(`adjacent page ${route} remains available`, new URL(page.url()).pathname === route && !/Application error|Internal Server Error|此功能尚未开通/.test(body) && (route === '/cover' ? /封面/.test(body) : /漫剧|有彩/.test(body)));
      await screenshot(`owner-regression-${route.slice(1)}`);
    }
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await verifyEntrances('after return');
    await screenshot('owner-home-return-publish-entrances');
    verify('no browser page errors', report.errors.length === 0, report.errors);
    report.passed = true;
  } catch (error) {
    report.errors.push(safe(error.message));
    if (page && !page.isClosed()) {
      await fs.writeFile(path.join(output, 'owner-navigation-failure-body.txt'), safe(await page.locator('body').innerText().catch(() => 'Body unavailable')));
      await screenshot('owner-navigation-failure').catch(() => {});
    }
  } finally {
    if (browser) await browser.close();
  }
  await fs.writeFile(path.join(output, 'owner-navigation-report.json'), JSON.stringify(report, null, 2));
  return report;
}
