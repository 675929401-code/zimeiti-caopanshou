import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');

const identity = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const identityBody = await identity.json();
assert.ok(identity.ok && identityBody.user?.role === 'admin', 'ACTIVE_LOCAL_ADMIN_REQUIRED');

const browser = await chromium.launch({ headless: true });
const report = {
  checkedAt: new Date().toISOString(),
  catalogTotal: 0,
  pages: [],
  uniqueVoiceIds: 0,
  oldImageCount: 0,
  portraitWithoutAtlas: [],
  pageErrors: [],
  consoleErrors: [],
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.addInitScript(({ localToken, user }) => {
    localStorage.setItem('auth_token', localToken);
    localStorage.setItem('auth_user', JSON.stringify(user));
    sessionStorage.setItem('entered_app', '1');
  }, { localToken: token, user: identityBody.user });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text().slice(0, 300));
  });

  await page.goto(`${origin}/voice-studio/voices`, { waitUntil: 'networkidle', timeout: 60_000 });
  const totalText = await page.locator('h2', { hasText: '全部' }).first().locator('xpath=following-sibling::span[1]').textContent();
  report.catalogTotal = Number(String(totalText || '').match(/\d+/u)?.[0] || 0);
  assert.equal(report.catalogTotal, 161, 'The current Chinese voice catalog must expose all 161 voices');

  const unique = new Set();
  for (let pageNumber = 1; pageNumber <= Math.ceil(report.catalogTotal / 60); pageNumber += 1) {
    if (pageNumber > 1) {
      const expectedPage = pageNumber;
      const response = page.waitForResponse(candidate => {
        const url = new URL(candidate.url());
        return url.pathname === '/api/voice/list' && url.searchParams.get('page') === String(expectedPage) && candidate.status() === 200;
      }, { timeout: 20_000 });
      await page.getByRole('button', { name: String(pageNumber), exact: true }).last().click();
      await response;
      await page.waitForTimeout(250);
    }
    const cards = page.locator('[data-voice-id]');
    const ids = await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-voice-id')).filter(Boolean));
    ids.forEach(id => unique.add(id));
    const oldImages = await cards.locator('img').count();
    report.oldImageCount += oldImages;
    const missingAtlas = await cards.evaluateAll(elements => elements.flatMap(element => {
      const portrait = element.querySelector('[role="img"][aria-label$="音色示意头像"]');
      if (!portrait) return [element.getAttribute('data-voice-id') || 'unknown:no-portrait'];
      return getComputedStyle(portrait).backgroundImage.includes('/avatars/voice-studio/portraits.webp')
        ? [] : [element.getAttribute('data-voice-id') || 'unknown:no-atlas'];
    }));
    report.portraitWithoutAtlas.push(...missingAtlas);
    report.pages.push({ page: pageNumber, renderedCards: ids.length, uniqueSeen: unique.size, oldImages, missingAtlas: missingAtlas.length });
  }
  report.uniqueVoiceIds = unique.size;
  await context.close();
} finally {
  await browser.close();
}

assert.equal(report.uniqueVoiceIds, report.catalogTotal, 'Every catalog voice must be reachable through pagination');
assert.equal(report.oldImageCount, 0, 'Legacy per-card avatar images must not remain');
assert.deepEqual(report.portraitWithoutAtlas, [], 'Every rendered voice card must use the WebP portrait atlas');
assert.deepEqual(report.pageErrors, [], 'Voice gallery must not produce page errors');
assert.deepEqual(report.consoleErrors, [], 'Voice gallery must not produce console errors');

const output = path.resolve('.codex-evidence/voice-models-real-e2e-20260903/gallery-pagination-live.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: true, output, ...report }, null, 2));
