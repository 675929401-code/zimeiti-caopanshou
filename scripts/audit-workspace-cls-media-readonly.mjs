#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_ONLY_ORIGIN_REQUIRED');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');
const viewportName = String(process.env.LOCAL_AUDIT_VIEWPORT || 'desktop');
assert.ok(['desktop', 'mobile'].includes(viewportName), 'AUDIT_VIEWPORT_REJECTED');
const viewport = viewportName === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 960 };

const routes = [
  ['voice-workspace', '/voice-studio/workspace'],
  ['digital-human', '/digital-human'],
];
const report = {
  observedAt: new Date().toISOString(), origin,
  policy: { readOnly: true, paidGenerationRequests: 0, executedBusinessWrites: 0 },
  routes: [], blocked: [], pageErrors: [], consoleErrors: [], requestFailures: [],
};
const browser = await chromium.launch({ headless: true });

try {
  const identity = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  const identityBody = await identity.json();
  assert.ok(identity.ok && identityBody.user?.role === 'admin', 'ACTIVE_LOCAL_ADMIN_REQUIRED');

  for (const [id, target] of routes) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        report.blocked.push({ id, method: request.method(), path: url.origin === origin ? url.pathname : 'external' });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await context.addInitScript(({ localToken, user }) => {
      localStorage.setItem('auth_token', localToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
      window.__workspaceAudit = { cls: 0, shifts: [] };
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            window.__workspaceAudit.cls += entry.value;
            window.__workspaceAudit.shifts.push({
              value: Number(entry.value.toFixed(6)),
              timeMs: Math.round(entry.startTime),
              sources: Array.from(entry.sources || []).slice(0, 4).map(source => {
                const node = source.node;
                return {
                  tag: node?.tagName || '',
                  id: node?.id || '',
                  className: typeof node?.className === 'string' ? node.className.slice(0, 160) : '',
                  text: String(node?.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 120),
                  previousRect: source.previousRect,
                  currentRect: source.currentRect,
                };
              }),
            });
          }
        }).observe({ type: 'layout-shift', buffered: true });
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
      if (request.failure()?.errorText === 'net::ERR_BLOCKED_BY_CLIENT') return;
      report.requestFailures.push({ id, method: request.method(), path: new URL(request.url()).pathname, error: request.failure()?.errorText || '' });
    });

    const response = await page.goto(origin + target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(() => document.body?.innerText?.trim().length > 40, null, { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const metrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource').map(entry => ({
        path: new URL(entry.name).pathname,
        initiator: entry.initiatorType,
        transferBytes: Number(entry.transferSize || 0),
        encodedBytes: Number(entry.encodedBodySize || 0),
      }));
      const mediaResources = resources.filter(item => /\.(?:mp3|wav|aac|mp4|mov|webm)(?:$|\?)/iu.test(item.path) || item.initiator === 'video' || item.initiator === 'audio' || /video\/proxy|voice\/preview/iu.test(item.path));
      const modeLabel = Array.from(document.querySelectorAll('span')).find(element => element.textContent?.trim() === '模式');
      const innerScroller = document.querySelector('[aria-label="数字人工作区"]');
      return {
        cls: Number((window.__workspaceAudit?.cls || 0).toFixed(6)),
        shifts: (window.__workspaceAudit?.shifts || []).sort((a, b) => b.value - a.value),
        domNodes: document.querySelectorAll('*').length,
        hiddenDomNodes: Array.from(document.querySelectorAll('[hidden]')).reduce((sum, item) => sum + item.querySelectorAll('*').length + 1, 0),
        controls: document.querySelectorAll('button,a[href],input,textarea,select,[role="button"]').length,
        videos: document.querySelectorAll('video').length,
        audios: document.querySelectorAll('audio').length,
        images: document.querySelectorAll('img').length,
        modeCardHeight: modeLabel?.parentElement?.parentElement?.getBoundingClientRect().height || 0,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
        scrollable: document.documentElement.scrollHeight > innerHeight + 4 || !!innerScroller && innerScroller.scrollHeight > innerScroller.clientHeight + 4,
        resourceCount: resources.length,
        transferBytes: resources.reduce((sum, item) => sum + item.transferBytes, 0),
        mediaRequests: mediaResources,
        text: document.body.innerText.replace(/\s+/gu, ' ').trim().slice(0, 300),
      };
    });
    const interaction = {};
    if (id === 'voice-workspace') {
      const more = page.getByRole('button', { name: /显示更多音色/u }).first();
      interaction.voiceRowsBefore = await page.locator('button[aria-label^="试听 "]').count();
      interaction.voiceMoreAvailable = await more.isVisible().catch(() => false);
      if (interaction.voiceMoreAvailable) {
        await more.click();
        interaction.voiceRowsAfter = await page.locator('button[aria-label^="试听 "]').count();
      }
    }
    if (id === 'digital-human') {
      const history = page.locator('section[aria-label="数字人生成记录"]');
      interaction.historyCardsBefore = await history.locator('article').count();
      interaction.lazyVideoPlaceholders = await history.locator('button[aria-label^="加载并播放"]').count();
      interaction.historyVideosBeforePlay = await history.locator('video').count();
      const moreHistory = history.getByRole('button', { name: /显示更多本页记录/u });
      interaction.historyMoreAvailable = await moreHistory.isVisible().catch(() => false);
      if (interaction.historyMoreAvailable) {
        await moreHistory.click();
        interaction.historyCardsAfter = await history.locator('article').count();
      }
      const imitation = page.getByRole('tab', { name: '音色模仿' });
      if (await imitation.isEnabled().catch(() => false)) {
        await imitation.click();
        interaction.imitationMountedOnDemand = await page.locator('[aria-label="数字人音色模仿"]').count() === 1;
        interaction.speechUnmountedWhenInactive = await page.locator('[aria-label="智音工坊配音"]').count() === 0;
      }
    }
    report.routes.push({ id, target, http: response?.status() || null, ...metrics, interaction });
    await context.close();
  }
} finally {
  await browser.close();
}

assert.equal(report.policy.executedBusinessWrites, 0);
assert.equal(report.pageErrors.length, 0);
assert.equal(report.routes.filter(item => item.http !== 200).length, 0);
assert.equal(report.routes.filter(item => item.horizontalOverflow).length, 0);
const directory = path.resolve('.codex-evidence/workspace-cls-media-20260904');
await fs.mkdir(directory, { recursive: true });
const output = path.join(directory, `audit-${new URL(origin).port}-${viewportName}.json`);
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  output, viewport: viewportName,
  routes: report.routes.map(item => ({
    id: item.id, http: item.http, cls: item.cls, domNodes: item.domNodes,
    hiddenDomNodes: item.hiddenDomNodes, controls: item.controls, videos: item.videos,
    audios: item.audios, images: item.images, mediaRequests: item.mediaRequests.length,
    transferKiB: Math.round(item.transferBytes / 1024), modeCardHeight: item.modeCardHeight,
    horizontalOverflow: item.horizontalOverflow, scrollable: item.scrollable, topShifts: item.shifts.slice(0, 3),
  })),
  blockedWrites: report.blocked.length,
  executedBusinessWrites: report.policy.executedBusinessWrites,
  pageErrors: report.pageErrors.length,
  consoleErrors: report.consoleErrors.length,
  requestFailures: report.requestFailures.length,
}, null, 2));
