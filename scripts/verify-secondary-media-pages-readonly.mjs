#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = String(process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
assert.match(base, /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u, 'LOCAL_BASE_URL_REQUIRED');
const checkHome = process.argv.includes('--check-home');
const output = path.resolve('.codex-evidence/secondary-media-pages-20260902');
await fs.mkdir(output, { recursive: true });

const publicCatalogs = [];
for (const route of ['/api/cover-models', '/api/video/models?surface=video-page', '/api/video/models?surface=storyboard-workbench']) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({}));
  const models = Array.isArray(payload) ? payload : payload.models || payload.data || [];
  assert.equal(response.status, 200, `公开模型目录不可用：${route}`);
  assert.ok(Array.isArray(models) && models.length > 0, `公开模型目录为空：${route}`);
  publicCatalogs.push({ route, status: response.status, count: models.length });
}

const allowedApi = [
  '/api/cover-models', '/api/video/models', '/api/chat-models', '/api/site-config', '/api/settings', '/api/version',
  '/api/auth/me', '/api/bots', '/api/categories', '/api/agents', '/api/plugins/active', '/api/notifications', '/api/announcements',
];
const loginWallPattern = /请登录后使用|请先登录后查看自己的草稿和历史/u;
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const slug of ['cover', 'image-workbench', 'video', 'storyboard-workbench']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    const blocked = [];
    const externalRequests = [];
    const models = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method().toUpperCase();
      if (url.origin !== base && /^https?:$/u.test(url.protocol)) {
        externalRequests.push({ method, url: url.href });
        return route.abort('blockedbyclient');
      }
      if (!['GET', 'HEAD'].includes(method)
        || (url.pathname.startsWith('/api/') && !allowedApi.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)))) {
        blocked.push({ method, path: url.pathname });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (['/api/cover-models', '/api/video/models'].includes(url.pathname)) {
        const data = await response.json().catch(() => ({}));
        models.push({
          path: url.pathname,
          status: response.status(),
          count: data.models?.length || 0,
          labels: (data.models || []).map((model) => [model.displayName, model.variantLabel].filter(Boolean).join(' ')),
        });
      }
    });

    const response = await page.goto(`${base}/${slug}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(response?.status(), 200);
    if (slug === 'cover') {
      await page.locator('.cover-rebuild-shell').waitFor({ timeout: 25_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('select option')].some((option) => option.value.startsWith('pm_')), { timeout: 25_000 });
    } else {
      await page.getByText(loginWallPattern).first().waitFor({ state: 'visible', timeout: 25_000 });
    }
    await page.waitForTimeout(300);
    const view = await page.evaluate((loginPatternSource) => ({
      textLength: document.body.innerText.length,
      headings: [...document.querySelectorAll('h1, h2')].map((node) => node.textContent),
      homeLinks: document.querySelectorAll('a[href="/"]').length,
      modelOptions: [...document.querySelectorAll('select option')].filter((option) => option.value.startsWith('pm_')).map((option) => ({ value: option.value, label: option.textContent })),
      loginWallVisible: new RegExp(loginPatternSource, 'u').test(document.body.innerText),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    }), loginWallPattern.source);
    assert.ok(view.textLength > (slug === 'cover' ? 40 : 10), `${slug} did not render`);
    if (slug === 'cover') {
      assert.equal(view.loginWallVisible, false, '公开封面页不应误显示登录墙');
      assert.ok(view.modelOptions.length > 0 && view.modelOptions.every((option) => option.label.trim()));
    } else {
      assert.equal(view.loginWallVisible, true, `${slug} 未显示匿名登录墙`);
      assert.equal(models.length, 0, `${slug} 登录墙后不应发出模型目录请求`);
    }
    assert.equal(errors.length, 0, `${slug} raised browser errors: ${errors.join('; ')}`);
    assert.equal(blocked.length, 0, `${slug} attempted unexpected API or write requests: ${JSON.stringify(blocked)}`);
    await page.screenshot({ path: path.join(output, `${slug}.png`), fullPage: false });

    let returnedHome = null;
    let navigationError = null;
    if (checkHome) {
      try {
        await page.locator('a[href="/"], [title="返回主页"]').first().click();
        await page.waitForURL(`${base}/`, { timeout: 45_000, waitUntil: 'domcontentloaded' });
        returnedHome = true;
      } catch {
        returnedHome = false;
        navigationError = 'Return-home navigation was not confirmed within 45 seconds';
      }
    }
    results.push({ page: `/${slug}`, http: response?.status() || null, returnedHome, navigationError, view, models, errors, blocked, externalRequestsBlocked: externalRequests.length });
    await context.close();
  }
} finally {
  await browser.close();
}

const result = {
  pass: results.every((item) => item.errors.length === 0 && item.blocked.length === 0 && (!checkHome || item.returnedHome)),
  authenticated: false,
  modelCatalogMode: 'public-get',
  publicCatalogs,
  navigationChecked: checkHome,
  upstreamGenerationRequests: 0,
  results,
};
await fs.writeFile(path.join(output, 'readonly-pages.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
assert.equal(result.pass, true, 'One or more pages raised a runtime exception or attempted an unexpected request');
