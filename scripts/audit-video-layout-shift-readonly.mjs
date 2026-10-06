#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002', 'http://127.0.0.1:5010'].includes(origin), 'LOCAL_ONLY_ORIGIN_REQUIRED');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');

const outputDirectory = path.resolve('.codex-evidence/commercial-ux-audit-20260904');
await fs.mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/__nextjs_original-stack-frames') {
    await route.abort('blockedbyclient');
    return;
  }
  await route.continue();
});
const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
});
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user?.role === 'admin', 'ACTIVE_LOCAL_ADMIN_REQUIRED');
await context.addInitScript(({ sessionToken, user }) => {
  localStorage.setItem('auth_token', sessionToken);
  localStorage.setItem('auth_user', JSON.stringify(user));
  sessionStorage.setItem('entered_app', '1');
  window.__layoutShiftAudit = [];
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      window.__layoutShiftAudit.push({
        value: entry.value,
        time: Math.round(entry.startTime),
        sources: (entry.sources || []).map(source => {
          const node = source.node;
          return {
            tag: node?.tagName || '',
            id: node?.id || '',
            className: typeof node?.className === 'string' ? node.className.slice(0, 180) : '',
            text: String(node?.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 120),
            previousRect: source.previousRect,
            currentRect: source.currentRect,
          };
        }),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}, { sessionToken: token, user: identity.user });

const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const response = await page.goto(`${origin}/video`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
assert.equal(response?.status(), 200);
await page.waitForFunction(() => document.body?.innerText?.includes('视频模型'), null, { timeout: 30_000 });
await page.waitForTimeout(5_000);
const result = await page.evaluate(() => {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const textOverflow = [...document.querySelectorAll('body *')].filter(element => {
    if (!visible(element) || !element.textContent?.trim() || element.children.length > 0) return false;
    const style = getComputedStyle(element);
    return element.scrollWidth > element.clientWidth + 1 && !['hidden', 'clip'].includes(style.overflowX);
  }).slice(0, 30).map(element => ({
    tag: element.tagName,
    className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
    text: element.textContent.replace(/\s+/gu, ' ').trim().slice(0, 180),
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  const shifts = window.__layoutShiftAudit || [];
  return {
    cls: shifts.reduce((total, entry) => total + Number(entry.value || 0), 0),
    shifts,
    textOverflow,
    body: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
  };
});
await page.screenshot({ path: path.join(outputDirectory, 'video-after-settle.png'), fullPage: true });
const report = { observedAt: new Date().toISOString(), origin, readOnly: true, errors, ...result };
await fs.writeFile(path.join(outputDirectory, 'video-layout-shift.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
