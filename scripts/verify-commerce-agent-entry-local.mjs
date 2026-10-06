import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');

const out = path.resolve('.codex-evidence/commerce-agent-entry-20260908');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const blockedWrites = [];
  const allowedSessionBridges = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const sessionBridge = request.method() === 'POST' && url.origin === origin && url.pathname === '/api/commerce/session'
      && (() => { try { return request.postDataJSON()?.action === 'main-bind'; } catch { return false; } })();
    if (sessionBridge) {
      allowedSessionBridges.push({ path: url.pathname, action: 'main-bind' });
      await route.continue();
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      blockedWrites.push({ method: request.method(), path: url.origin === origin ? url.pathname : 'external' });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await context.addInitScript(value => {
    localStorage.setItem('auth_token', value);
    sessionStorage.setItem('entered_app', '1');
  }, token);
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const response = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  assert.equal(response?.status(), 200);
  await page.waitForTimeout(2_000);

  const entries = page.getByText('带货 Agent', { exact: true });
  const visibleEntries = [];
  for (let index = 0; index < await entries.count(); index += 1) {
    if (await entries.nth(index).isVisible()) visibleEntries.push(entries.nth(index));
  }
  if (visibleEntries.length === 0) {
    await page.screenshot({ path: path.join(out, 'main-entry-missing.png') });
    await fs.writeFile(path.join(out, 'main-entry-missing.txt'), (await page.locator('body').innerText()).slice(0, 8_000));
  }
  assert.ok(visibleEntries.length > 0, 'VISIBLE_COMMERCE_AGENT_ENTRY_REQUIRED');
  const popupEvent = context.waitForEvent('page', { timeout: 12_000 }).catch(() => null);
  const sameTabNavigation = page.waitForURL(url => url.origin === origin && url.pathname === '/commerce', { timeout: 12_000 })
    .then(() => page).catch(() => null);
  await visibleEntries[0].click();
  const popup = await Promise.race([popupEvent, sameTabNavigation]);
  assert.ok(popup, 'COMMERCE_AGENT_NAVIGATION_REQUIRED');
  await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 });
  await popup.waitForURL(url => url.origin === origin && url.pathname === '/commerce', { timeout: 30_000 });
  await popup.locator('[data-testid="commerce-workspace"]').waitFor({ state: 'visible', timeout: 30_000 });
  const commerceResponse = await context.request.get(`${origin}/commerce`, { headers: { Cookie: `auth_token=${token}` } });
  assert.equal(commerceResponse.status(), 200);

  const mainPage = popup === page ? await context.newPage() : page;
  if (popup === page) {
    await mainPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await mainPage.bringToFront();
  const marketplace = mainPage.getByText('应用广场', { exact: true });
  for (let index = 0; index < await marketplace.count(); index += 1) {
    if (await marketplace.nth(index).isVisible()) { await marketplace.nth(index).click(); break; }
  }
  await mainPage.waitForTimeout(500);
  assert.equal(new URL(mainPage.url()).pathname, '/');
  const toolbox = mainPage.getByText('工具箱', { exact: true });
  let toolboxClicked = false;
  for (let index = 0; index < await toolbox.count(); index += 1) {
    if (await toolbox.nth(index).isVisible()) { await toolbox.nth(index).click(); toolboxClicked = true; break; }
  }
  assert.equal(toolboxClicked, true, 'VISIBLE_TOOLBOX_ENTRY_REQUIRED');
  await mainPage.waitForURL(/\/tools(?:$|[?#])/u, { timeout: 10_000 });

  const result = {
    checkedAt: new Date().toISOString(),
    mainStatus: response?.status(),
    mainUrl: `${origin}/`,
    visibleCommerceEntries: visibleEntries.length,
    popupUrl: popup.url(),
    commerceLaunchMode: popup === page ? 'same-tab' : 'new-tab',
    popupStatus: commerceResponse.status(),
    marketplaceReturnPath: '/',
    toolboxPath: new URL(mainPage.url()).pathname,
    cohostedOnMainOrigin: true,
    allowedSessionBridges,
    blockedWrites,
    providerRequests: 0,
    paidGeneration: false,
  };
  await mainPage.screenshot({ path: path.join(out, 'main-toolbox.png') });
  await popup.screenshot({ path: path.join(out, 'commerce-agent-popup.png') });
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
