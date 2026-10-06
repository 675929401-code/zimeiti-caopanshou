#!/usr/bin/env node
// Real local navigation only; credentials stay in memory and no responses are mocked.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5000';
const output = process.argv[2];
if (!output || !process.env.READONLY_UI_EXPECTED_USERNAME) throw new Error('OUTPUT_AND_EXPECTED_USERNAME_REQUIRED');
const evidence = {
  observedAt: new Date().toISOString(),
  source: 'LIVE_LOCAL_READONLY_NAVIGATION',
  policy: { responseFixtures: false, credentialsPersisted: false, businessWritesBlocked: true, stateAdvancingGetBlocked: true, normalGetAllowed: true, browserHttpCacheDisabledByInterception: true },
  pages: [], requests: [], pageErrors: [], blocked: [], failure: null,
};
const advancing = new Set(['/api/video/status', '/api/video/stream', '/api/image/status']);
function safePath(raw) {
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return `external:${url.hostname}/asset`;
    return url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id').replace(/\d{9,}/gu, ':id');
  } catch { return '/invalid'; }
}
let browser;
let stage = 'session';
const pending = new Set();
const requestStages = new WeakMap();
async function snapshot(page, name, started) {
  const ui = await page.evaluate(() => ({
    images: [...document.images].map(image => {
      const rect = image.getBoundingClientRect();
      return { source: image.currentSrc || image.src, complete: image.complete, loaded: image.naturalWidth > 0, visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight, loading: image.loading };
    }),
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|应用程序错误/u.test(document.body.innerText),
  }));
  evidence.pages.push({ name, readyAndSettledMs: Math.round(performance.now() - started), ...ui, images: ui.images.map(image => ({ ...image, source: safePath(image.source) })) });
}
try {
  const login = await fetch(`${origin}/api/auth/dev-session`, { headers: { 'x-local-workbench': 'ai-creation-studio-local' }, signal: AbortSignal.timeout(15000) });
  const session = await login.json();
  if (!login.ok || !session.token || session.user?.username !== process.env.READONLY_UI_EXPECTED_USERNAME || session.user?.role !== 'admin') throw new Error('EXPECTED_ADMIN_SESSION_UNAVAILABLE');
  evidence.authentication = { normalDevSession: true, expectedAdminMatched: true, status: login.status };
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const diagnostic = request.method() === 'POST' && url.origin === origin && url.pathname === '/__nextjs_original-stack-frames';
    if ((request.method() !== 'GET' && !diagnostic) || (url.origin === origin && advancing.has(url.pathname))) {
      evidence.blocked.push({ method: request.method(), path: safePath(url.href) });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
  }, { token: session.token, user: session.user });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('dialog', dialog => dialog.dismiss());
  page.on('pageerror', error => evidence.pageErrors.push({ stage, name: error.name }));
  page.on('request', request => requestStages.set(request, stage));
  page.on('requestfailed', request => evidence.requests.push({ stage: requestStages.get(request), path: safePath(request.url()), type: request.resourceType(), failed: true, reason: request.failure()?.errorText?.replace(/https?:\S+/gu, '[url]') || 'unknown' }));
  page.on('response', response => {
    const task = (async () => {
      const request = response.request();
      const record = { stage: requestStages.get(request), path: safePath(response.url()), status: response.status(), type: request.resourceType() };
      if (request.resourceType() === 'script' && response.ok()) {
        const body = await response.body().catch(() => null);
        if (body) {
          const source = body.toString('utf8');
          record.bytes = body.length;
          record.containsChatViewModule = /function ChatView\(|function findNearestVideoTaskOrderContext\(/u.test(source);
        }
      }
      const timing = request.timing();
      record.responseStartMs = Math.round(timing.responseStart);
      evidence.requests.push(record);
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  let started = performance.now();
  if (!process.argv.includes('--direct-youcai')) {
  stage = 'landing';
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByRole('button', { name: '立即体验', exact: true }).first().waitFor({ state: 'visible' });
  await page.waitForTimeout(2000);
  await snapshot(page, stage, started);
  stage = 'marketplace';
  started = performance.now();
  await page.getByRole('button', { name: '立即体验', exact: true }).first().click();
  await page.locator('.marketplace-shell').waitFor({ state: 'visible' });
  await page.waitForTimeout(4000);
  await snapshot(page, stage, started);
  }
  if (process.argv.includes('--verify-chat')) {
    stage = 'chat';
    started = performance.now();
    await page.locator('.agent-card-hover:not([aria-disabled="true"])').first().click();
    const input = page.locator('textarea[placeholder*="发消息"]');
    const skip = page.getByRole('button', { name: '跳过', exact: true });
    await Promise.race([input.waitFor({ state: 'visible' }), skip.waitFor({ state: 'visible' })]);
    if (await skip.isVisible()) await skip.click();
    await input.waitFor({ state: 'visible' });
    evidence.chatEntry = { emptyComposerVisible: true, editable: await input.isEditable(), submitted: false };
    await snapshot(page, stage, started);
  } else {
  stage = 'youcai';
  started = performance.now();
  if (process.argv.includes('--direct-youcai')) {
    await page.goto(`${origin}/youcai`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } else {
    const navigation = page.locator('.marketplace-shell .nav-pill').filter({ hasText: /^漫剧工作台$/u });
    evidence.marketplaceNavigation = { matchingButtons: await navigation.count() };
    await navigation.first().click();
  }
  await page.locator('[data-testid="official-home-page"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(5000);
  await snapshot(page, stage, started);
  }
  await Promise.allSettled([...pending]);
} catch (error) {
  evidence.failure = { stage, name: error.name, reason: error.message.split('\n')[0].replace(/https?:\S+/gu, '[url]') };
} finally {
  if (browser) await browser.close();
  await Promise.allSettled([...pending]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output, pages: evidence.pages.map(page => ({ name: page.name, readyAndSettledMs: page.readyAndSettledMs, images: page.images.length, brokenVisible: page.images.filter(image => image.visible && image.complete && !image.loaded).length, horizontalOverflowPx: page.horizontalOverflowPx })), errors: evidence.requests.filter(request => request.status >= 400), chatModuleLoads: evidence.requests.filter(request => request.containsChatViewModule).map(request => ({ stage: request.stage, path: request.path, bytes: request.bytes })), pageErrors: evidence.pageErrors, failure: evidence.failure }, null, 2));
}
