#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_ONLY_ORIGIN_REQUIRED');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');
const expected = [
  '/avatars/optimized/soft-placement-v1-256.jpg',
  '/avatars/optimized/ip-positioning-v1-256.jpg',
  '/avatars/optimized/selling-proof-v1-256.jpg',
  '/avatars/optimized/qianchuan-copy-v1-256.jpg',
];
const legacy = expected.map(item => item.replace('/optimized/', '/').replace('-256.jpg', '.png'));

const me = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
const body = await me.json();
assert.ok(me.ok && body.user?.role === 'admin', 'ACTIVE_LOCAL_ADMIN_REQUIRED');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.abort('blockedbyclient');
    await route.continue();
  });
  await context.addInitScript(({ localToken, user }) => {
    localStorage.setItem('auth_token', localToken);
    localStorage.setItem('auth_user', JSON.stringify(user));
    sessionStorage.setItem('entered_app', '1');
  }, { localToken: token, user: body.user });
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => {
    if (request.method() === 'GET' && request.url().startsWith(origin)) requests.push(new URL(request.url()).pathname);
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('.agent-card-hover').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(700);
  const sources = await page.locator('.marketplace-agent-avatar img').evaluateAll(images => images.map(image => new URL(image.currentSrc || image.src, location.href).pathname));
  const optimizedInDom = expected.filter(item => sources.includes(item));
  const optimizedRequested = expected.filter(item => requests.includes(item));
  const legacyInDom = legacy.filter(item => sources.includes(item));
  const legacyRequested = legacy.filter(item => requests.includes(item));
  assert.deepEqual(optimizedInDom, expected);
  assert.deepEqual(optimizedRequested, expected);
  assert.deepEqual(legacyInDom, []);
  assert.deepEqual(legacyRequested, []);
  console.log(JSON.stringify({ origin, optimizedInDom, optimizedRequested, legacyInDom, legacyRequested, paidGenerationRequests: 0, executedBusinessWrites: 0 }, null, 2));
  await context.close();
} finally {
  await browser.close();
}
