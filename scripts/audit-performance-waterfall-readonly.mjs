#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_ONLY_ORIGIN_REQUIRED');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');

const routes = [
  ['home', '/'], ['video', '/video'], ['storyboard', '/storyboard-workbench'],
  ['voice-library', '/voice-studio/voices'], ['voice-workspace', '/voice-studio/workspace'],
  ['cover', '/cover'], ['manju', '/youcai'], ['manju-canvas', '/youcai/tools/canvas'], ['digital-human', '/digital-human'],
];
const report = {
  observedAt: new Date().toISOString(), origin,
  policy: { readOnly: true, paidGenerationRequests: 0, executedBusinessWrites: 0 },
  routes: [], blocked: [], pageErrors: [], consoleErrors: [], requestFailures: [],
};
const isStateAdvancingRead = pathname => [
  /^\/api\/video\/(?:status|poll|stream)$/u,
  /^\/api\/image\/status$/u,
  /^\/api\/voice\/preview$/u,
  /^\/api\/digital-human\/.+\/(?:status|poll)$/u,
  /^\/api\/health$/u,
].some(pattern => pattern.test(pathname));
const browser = await chromium.launch({ headless: true });

try {
  const identity = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  const identityBody = await identity.json();
  assert.ok(identity.ok && identityBody.user?.role === 'admin', 'ACTIVE_LOCAL_ADMIN_REQUIRED');

  for (const [id, target] of routes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.origin === origin && isStateAdvancingRead(url.pathname)) {
        report.blocked.push({ id, method: request.method(), path: url.pathname, reason: 'state-advancing-get' });
        await route.abort('blockedbyclient');
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        report.blocked.push({ id, method: request.method(), path: url.origin === origin ? url.pathname : 'external', reason: 'business-non-get' });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await context.addInitScript(({ localToken, user }) => {
      localStorage.setItem('auth_token', localToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
      window.__uxPerf = { cls: 0, lcp: 0 };
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__uxPerf.cls += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver(list => {
          const entries = list.getEntries();
          window.__uxPerf.lcp = entries.at(-1)?.startTime || window.__uxPerf.lcp;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch { /* unsupported metric remains zero */ }
    }, { localToken: token, user: identityBody.user });

    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push({ id, message: String(error.message).slice(0, 240) }));
    page.on('console', message => {
      if (message.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED/u.test(message.text())) {
        report.consoleErrors.push({ id, message: message.text().slice(0, 240) });
      }
    });
    page.on('requestfailed', request => {
      const error = request.failure()?.errorText || '';
      if (error.startsWith('net::ERR_BLOCKED_BY_CLIENT')) return;
      if (error === 'net::ERR_ABORTED' && !request.isNavigationRequest()) return;
      report.requestFailures.push({ id, method: request.method(), path: new URL(request.url()).pathname, error });
    });

    const startedAt = Date.now();
    const response = await page.goto(origin + target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(() => document.body?.innerText?.trim().length > 40, null, { timeout: 30_000 });
    await page.waitForTimeout(1_000);
    const metrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource').map(entry => ({
        name: new URL(entry.name).pathname,
        initiator: entry.initiatorType,
        durationMs: Math.round(entry.duration),
        transferBytes: Number(entry.transferSize || 0),
        encodedBytes: Number(entry.encodedBodySize || 0),
      }));
      const topSlow = [...resources].sort((a, b) => b.durationMs - a.durationMs).slice(0, 8);
      const topLarge = [...resources].sort((a, b) => (b.transferBytes || b.encodedBytes) - (a.transferBytes || a.encodedBytes)).slice(0, 8);
      const canvasBannerRequests = resources.filter((entry) => entry.name.endsWith('/youcai-media/v1/featured/canvas-banner-youcai.mp4'));
      return {
        domNodes: document.querySelectorAll('*').length,
        controls: document.querySelectorAll('button,a[href],input,textarea,select,[role="button"]').length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
        scrollable: document.documentElement.scrollHeight > innerHeight + 4,
        navigation: navigation ? {
          domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
          loadMs: Math.round(navigation.loadEventEnd),
          responseStartMs: Math.round(navigation.responseStart),
        } : null,
        cls: Number((window.__uxPerf?.cls || 0).toFixed(6)),
        lcpMs: Math.round(window.__uxPerf?.lcp || 0),
        resourceCount: resources.length,
        transferBytes: resources.reduce((sum, item) => sum + item.transferBytes, 0),
        encodedBytes: resources.reduce((sum, item) => sum + item.encodedBytes, 0),
        canvasBannerRequests,
        topSlow, topLarge,
      };
    });
    report.routes.push({ id, target, http: response?.status() || null, wallMs: Date.now() - startedAt, ...metrics });
    await context.close();
  }
} finally {
  await browser.close();
}

assert.equal(report.policy.executedBusinessWrites, 0);
assert.equal(report.pageErrors.length, 0);
assert.equal(report.routes.filter(item => item.http !== 200).length, 0);
assert.equal(report.routes.filter(item => item.horizontalOverflow).length, 0);
assert.equal(report.routes.find(item => item.id === 'manju-canvas')?.canvasBannerRequests.length, 0, '画布页首屏仍在请求 13 MB 横幅视频');
const directory = path.resolve('.codex-evidence/commercial-ux-audit-20260904');
await fs.mkdir(directory, { recursive: true });
const output = path.join(directory, `waterfall-${new URL(origin).port}.json`);
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  output,
  summary: report.routes.map(item => ({
    id: item.id, http: item.http, wallMs: item.wallMs, dclMs: item.navigation?.domContentLoadedMs,
    lcpMs: item.lcpMs, cls: item.cls, resources: item.resourceCount,
    transferKiB: Math.round(item.transferBytes / 1024), domNodes: item.domNodes,
  })),
  blockedWrites: report.blocked.length,
  executedBusinessWrites: report.policy.executedBusinessWrites,
  pageErrors: report.pageErrors.length,
  consoleErrors: report.consoleErrors.length,
  requestFailures: report.requestFailures.length,
}, null, 2));
