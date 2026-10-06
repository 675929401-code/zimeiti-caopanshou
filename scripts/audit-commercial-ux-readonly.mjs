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
const output = path.join(outputDirectory, 'report.json');
const routes = [
  ['home', '/'], ['tools-text', '/tools?tab=text'], ['tools-video', '/tools?tab=video'],
  ['video', '/video'], ['storyboard', '/storyboard-workbench'], ['image', '/image-workbench'],
  ['voice-workspace', '/voice-studio/workspace'], ['voice-voices', '/voice-studio/voices'],
  ['voice-imitate', '/voice-studio/imitate'], ['cover', '/cover'], ['manju', '/youcai'],
  ['digital-human', '/digital-human'], ['history', '/media-history'],
];

const report = {
  observedAt: new Date().toISOString(), origin,
  policy: { readOnly: true, paidGenerationRequests: 0, executedBusinessWrites: 0 },
  desktop: [], manjuTransition: {}, network: {}, errors: [], consoleErrors: [], blocked: [],
};
const active = { role: 'desktop', route: '/' };
const reads = new Map();
const isDiagnosticRead = pathname => pathname === '/__nextjs_original-stack-frames';
const isStateAdvancingRead = pathname => [
  /^\/api\/video\/(?:status|poll|stream)$/u,
  /^\/api\/image\/status$/u,
  /^\/api\/voice\/preview$/u,
  /^\/api\/digital-human\/.+\/(?:status|poll)$/u,
  /^\/api\/health$/u,
].some(pattern => pattern.test(pathname));
const compact = value => String(value || '').replace(/https?:\/\/\S+/gu, '[url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, 280);

function attach(page) {
  page.on('pageerror', error => report.errors.push({ ...active, message: compact(error.message) }));
  page.on('console', message => {
    if (message.type() !== 'error' || /ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED|React DevTools/u.test(message.text())) return;
    report.consoleErrors.push({ ...active, message: compact(message.text()) });
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET') return;
    const signature = `${active.role} ${active.route} ${url.pathname}${url.search}`;
    reads.set(signature, (reads.get(signature) || 0) + 1);
  });
}

async function installReadOnlyPolicy(context) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && url.origin === origin && isStateAdvancingRead(url.pathname)) {
      report.blocked.push({ role: active.role, route: active.route, method, path: url.pathname, reason: 'state-advancing-get' });
      await route.abort('blockedbyclient');
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !(method === 'POST' && url.origin === origin && isDiagnosticRead(url.pathname))) {
      report.blocked.push({ role: active.role, route: active.route, method, path: url.origin === origin ? url.pathname : 'external', reason: 'business-non-get' });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}

async function newContext(browser, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await installReadOnlyPolicy(context);
  const me = await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const body = await me.json();
  assert.ok(me.ok && body.user?.role === 'admin', `ACTIVE_LOCAL_ADMIN_REQUIRED status=${me.status} code=${compact(body?.code || body?.error || '')}`);
  await context.addInitScript(({ token: localToken, user }) => {
    localStorage.setItem('auth_token', localToken);
    localStorage.setItem('auth_user', JSON.stringify(user));
    sessionStorage.setItem('entered_app', '1');
  }, { token, user: body.user });
  return context;
}

async function inspect(page, id, target) {
  active.route = target;
  const began = Date.now();
  const response = await page.goto(origin + target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(() => document.body?.innerText?.trim().length > 40, null, { timeout: 30_000 });
  await page.waitForTimeout(650);
  const values = await page.evaluate(({ id: routeId, beganAt }) => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const controls = [...document.querySelectorAll('button,a[href],[role="button"],[role="link"]')].filter(visible);
    const fields = [...document.querySelectorAll('input:not([type="hidden"]),textarea,select')].filter(visible);
    const nameOf = element => {
      const labelledBy = element.getAttribute('aria-labelledby');
      const referenced = labelledBy ? labelledBy.split(/\s+/u).map(id => document.getElementById(id)?.textContent || '').join(' ') : '';
      const wrappingLabel = element.closest('label')?.textContent || '';
      return (element.getAttribute('aria-label') || referenced || element.getAttribute('title') || element.textContent || wrappingLabel || '').trim();
    };
    const labelled = element => Boolean(
      element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') ||
      (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)) || element.closest('label')
    );
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    const duplicateIds = [...new Set(ids.filter((value, index) => value && ids.indexOf(value) !== index))];
    const nativeImages = [...document.images].filter(visible);
    const portraits = [...document.querySelectorAll('[role="img"]')].filter(visible).map(element => ({
      label: element.getAttribute('aria-label') || '',
      backgroundImage: getComputedStyle(element).backgroundImage,
      width: Math.round(element.getBoundingClientRect().width),
      height: Math.round(element.getBoundingClientRect().height),
    }));
    const scrollers = [document.scrollingElement, ...document.querySelectorAll('*')].filter(Boolean).filter(element => {
      const style = getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 4 && /(auto|scroll)/u.test(style.overflowY);
    });
    const returnControl = controls.find(element => /返回(?:主页|首页)|返回应用广场|主站首页/u.test(nameOf(element)));
    const topRegion = document.querySelector('header,.nav-bar-container,[data-route-header]');
    return {
      id: routeId, path: location.pathname + location.search, http: 200, elapsedMs: Date.now() - beganAt,
      domNodes: document.querySelectorAll('*').length, controls: controls.length, fields: fields.length,
      unnamedControls: controls.filter(element => !nameOf(element)).length,
      unnamedControlSamples: controls.filter(element => !nameOf(element)).slice(0, 12).map(element => ({
        tag: element.tagName, className: String(element.className).slice(0, 120),
        html: element.outerHTML.replace(/\s+/gu, ' ').slice(0, 240),
      })),
      unlabelledFields: fields.filter(element => !labelled(element)).map(element => ({ tag: element.tagName, type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder') || '' })).slice(0, 20),
      duplicateIds, nativeImageCount: nativeImages.length,
      missingAltImages: nativeImages.filter(image => !image.hasAttribute('alt')).length,
      eagerImages: nativeImages.filter(image => image.loading !== 'lazy').length,
      brokenImages: nativeImages.filter(image => image.complete && image.naturalWidth === 0).length,
      portraitCount: portraits.length,
      portraitAtlasCount: portraits.filter(item => item.backgroundImage.includes('/avatars/voice-studio/portraits.webp')).length,
      emptyPortraits: portraits.filter(item => !item.backgroundImage || item.backgroundImage === 'none').length,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
      scrollable: scrollers.length > 0,
      returnTop: returnControl ? Math.round(returnControl.getBoundingClientRect().top) : null,
      header: topRegion ? { tag: topRegion.tagName, top: Math.round(topRegion.getBoundingClientRect().top), height: Math.round(topRegion.getBoundingClientRect().height), className: String(topRegion.className).slice(0, 120) } : null,
      bodyText: document.body.innerText.length,
    };
  }, { id, beganAt: began });
  values.http = response?.status() || null;
  return values;
}

async function inspectViewport(browser, role, viewport, selectedRoutes) {
  active.role = role;
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  attach(page);
  const rows = [];
  for (const [id, target] of selectedRoutes) rows.push(await inspect(page, id, target));
  await context.close();
  return rows;
}

async function inspectManjuTransition(browser) {
  active.role = 'transition'; active.route = '/';
  const context = await newContext(browser, { width: 1440, height: 960 });
  const page = await context.newPage(); attach(page);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('.agent-card-hover').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(() => {
    window.__commercialUxFrames = [];
    const started = performance.now();
    const sample = () => {
      const shell = document.querySelector('[class*="app-route-shell"],.app-route-shell');
      const main = document.querySelector('main');
      const rect = main?.getBoundingClientRect();
      window.__commercialUxFrames.push({
        at: Math.round(performance.now() - started), path: location.pathname,
        shell: Boolean(shell), mainLeft: rect ? Math.round(rect.left) : null,
        mainWidth: rect ? Math.round(rect.width) : null, textLength: document.body.innerText.length,
      });
      if (performance.now() - started < 2200) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const nav = page.locator('.nav-bar-container').locator('button,a,[role="button"],[role="link"]').filter({ hasText: /漫剧工作台|漫剧创作|有彩创作|有彩视界/u }).first();
  const navVisible = await nav.isVisible().catch(() => false);
  const clickedAt = Date.now(); active.route = '/youcai';
  if (navVisible) await nav.click();
  else await page.goto(origin + '/youcai', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForURL(url => url.pathname === '/youcai' || url.pathname.startsWith('/youcai/'), { timeout: 30_000 });
  await page.waitForTimeout(1600);
  const frames = await page.evaluate(() => window.__commercialUxFrames || []);
  const manjuFrames = frames.filter(frame => frame.path.startsWith('/youcai'));
  const widths = [...new Set(manjuFrames.map(frame => `${frame.mainLeft}:${frame.mainWidth}`))];
  await page.screenshot({ path: path.join(outputDirectory, 'manju-after-spa.png'), fullPage: false });
  await context.close();
  return { entrySource: navVisible ? 'authorized-primary-navigation' : 'direct-route-fallback', routeCommitMs: Date.now() - clickedAt - 1600, frames: manjuFrames, geometryVariants: widths, stableGeometry: widths.length <= 2 };
}

await fs.mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  report.desktop = await inspectViewport(browser, 'desktop', { width: 1440, height: 960 }, routes);
  report.manjuTransition = await inspectManjuTransition(browser);
  report.network.reads = [...reads].map(([request, count]) => ({ request, count }));
  report.network.duplicates = report.network.reads.filter(item => item.count > 1);
  const portraitResponse = await fetch(origin + '/avatars/voice-studio/portraits.webp', { signal: AbortSignal.timeout(10_000) });
  report.portraitAsset = { status: portraitResponse.status, bytes: Number(portraitResponse.headers.get('content-length') || 0), type: portraitResponse.headers.get('content-type') };
  report.summary = {
    routes: report.desktop.length,
    pageErrors: report.errors.length, consoleErrors: report.consoleErrors.length,
    horizontalOverflows: report.desktop.filter(row => row.horizontalOverflow).length,
    brokenImages: report.desktop.reduce((sum, row) => sum + row.brokenImages, 0),
    missingAltImages: report.desktop.reduce((sum, row) => sum + row.missingAltImages, 0),
    unnamedControls: report.desktop.reduce((sum, row) => sum + row.unnamedControls, 0),
    unlabelledFields: report.desktop.reduce((sum, row) => sum + row.unlabelledFields.length, 0),
    voicePortraits: report.desktop.find(row => row.id === 'voice-voices')?.portraitCount || 0,
    voicePortraitAtlases: report.desktop.find(row => row.id === 'voice-voices')?.portraitAtlasCount || 0,
    paidGenerationRequests: 0, executedBusinessWrites: 0,
  };
} finally {
  await browser.close();
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ output, summary: report.summary, voiceReads: report.network.reads.filter(item => item.request.includes('/voice-studio/voices /api/voice/list')), manju: report.manjuTransition }, null, 2));
