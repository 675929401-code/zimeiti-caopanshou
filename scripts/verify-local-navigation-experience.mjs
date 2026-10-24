import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

export const PRIMARY_ROUTES = [
  { label: '应用广场', path: '/', names: ['应用广场'], ready: '.agent-card-hover' },
  { label: '效率工具', path: '/tools', names: ['效率工具', '打开效率工具'], ready: '[data-page="tools"] [role="tabpanel"] textarea:visible' },
  { label: '视频创作', path: '/video', names: ['视频创作'], ready: '.secondary-workbench textarea' },
  { label: '分镜编排', path: '/storyboard-workbench', names: ['分镜编排'], ready: '.sbw-root textarea' },
  { label: '图像生成', path: '/image-workbench', names: ['图像生成'], ready: '.voice-studio-root textarea' },
  { label: '声音制作', path: '/voice-studio/workspace', names: ['声音制作'], ready: '.secondary-workbench textarea' },
  { label: '封面设计', path: '/cover', names: ['封面设计'], ready: '.cover-rebuild-shell textarea' },
  { label: '漫剧创作', path: '/youcai', names: ['漫剧创作'], ready: 'main textarea' },
  { label: '带货创作', path: '/commerce', names: ['带货创作'], ready: '[data-testid="commerce-workspace"]' },
];
const CONTROL_SELECTOR = 'button,a,[role="button"],[role="link"]';
const ADVANCING_GET = new Set([
  '/api/video/status', '/api/video/poll', '/api/video/stream', '/api/image/status',
  '/api/admin/voice-studio/voices/sync', '/api/commerce/jobs',
  '/api/commerce/workflows', '/api/commerce/agent-plans',
]);
const normalizeLabel = value => String(value || '').replace(/\s+/gu, '');
const SECONDARY_REDIRECTS = new Map([
  ['/commerce/settings', '/admin'],
  ['/tools/chat', '/tools/text/text-chat'],
  ['/tools/text/formal-script', '/tools/text/general-script'],
  ['/voice-studio', '/voice-studio/workspace'],
  ['/voice-studio/clone', '/voice-studio/imitate'],
  ['/voice-studio/design', '/voice-studio/imitate'],
  ['/voice-studio/nest', '/voice-studio/imitate'],
  ['/youcai/voice-studio', '/youcai/voice-studio/workspace'],
  ['/youcai/voice-studio/clone', '/voice-studio/imitate'],
  ['/youcai/voice-studio/design', '/voice-studio/imitate'],
  ['/youcai/voice-studio/nest', '/voice-studio/imitate'],
  ['/youcai/tools/canvas/workspace/new', '/youcai/free-canvas'],
  ['/youcai/creation-center', '/youcai/tools'],
  ['/youcai/image-workbench', '/youcai/tools/image/image-chat'],
  ['/youcai/media-history', '/youcai'],
  ['/youcai/short-drama', '/youcai/tools/film-studio'],
  ['/youcai/tools/chat', '/youcai/tools/text/text-chat'],
  ['/youcai/tools/text/formal-script', '/youcai/tools/text/general-script'],
]);
const RETIRED_SECONDARY_ROUTES = new Set([
  '/youcai/creative-horizon',
  '/youcai/navigation',
]);

/** Wait for the documented redirect before evaluating the destination document. */
export async function waitForSecondaryDestination(page, target, origin) {
  const targetPath = new URL(target, origin).pathname;
  const finalPath = SECONDARY_REDIRECTS.get(targetPath) || targetPath;
  await page.waitForURL(url => url.origin === origin && url.pathname === finalPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return finalPath;
}

export function navigationReportDirectory(runId) {
  const root = '.codex-evidence/navigation-experience-20260903';
  if (!runId) return root;
  assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u, 'Invalid navigation run id');
  return `${root}/${runId}`;
}

/** Select a real rendered control; aria-label takes precedence over its text. */
export function selectNavigationControl(snapshot, entry) {
  const visible = snapshot.filter(item => item.visible && !item.disabled);
  const byHref = visible.filter(item => item.hrefPath === entry.path);
  if (byHref.length === 1) return byHref[0];
  const names = new Set(entry.names.map(normalizeLabel));
  const byName = visible.filter(item => names.has(normalizeLabel(item.ariaLabel || item.text)));
  assert.equal(byName.length, 1, `Navigation control is missing or ambiguous: ${entry.label}`);
  return byName[0];
}

export function classifyNavigationRequest(method, pathname) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'mutation';
  if (method === 'GET' && (ADVANCING_GET.has(pathname) || /\/api\/voice-studio\/jobs\/[^/]+\/(?:status|poll)$/u.test(pathname))) return 'advancing-get';
  return 'read';
}

export async function collectStaticSecondaryRoutes(appRoot = path.resolve('src/app')) {
  const roots = ['tools', 'video', 'storyboard-workbench', 'image-workbench', 'voice-studio', 'cover', 'youcai', 'commerce'];
  const routes = [];
  async function walk(directory, segments) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (item.name.includes('[') || item.name.startsWith('@') || item.name.startsWith('_')) continue;
        await walk(path.join(directory, item.name), item.name.startsWith('(') ? segments : [...segments, item.name]);
      } else if (/^page\.(?:tsx|jsx|ts|js)$/u.test(item.name)) routes.push('/' + segments.join('/'));
    }
  }
  for (const root of roots) { try { await walk(path.join(appRoot, root), [root]); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const primary = new Set(PRIMARY_ROUTES.map(entry => entry.path));
  return [...new Set(routes)].filter(route => !primary.has(route) && !RETIRED_SECONDARY_ROUTES.has(route)).sort().concat(['segment', 'text', 'video', 'format'].map(tab => `/tools?tab=${tab}`));
}

export async function main(argv = process.argv.slice(2)) {
  const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
  assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002', 'http://127.0.0.1:5010'].includes(origin));
  const mode = argv.find(value => value.startsWith('--scope='))?.slice(8) || 'primary';
  assert.ok(['primary', 'secondary', 'all', 'inspect'].includes(mode));
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'Normal administrator session required');
  const authResponse = await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  const auth = await authResponse.json(); assert.ok(authResponse.ok && auth.user?.role === 'admin');
  const output = navigationReportDirectory(argv.find(value => value.startsWith('--run-id='))?.slice(9)); await fs.mkdir(output, { recursive: true });
  const reportPath = `${output}/${mode}-report.json`;
  const clean = value => String(value || '').split(token).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, 350);
  const inventory = await collectStaticSecondaryRoutes();
  const requestedRoutes = argv.find(value => value.startsWith('--routes='))?.slice(9).split(',');
  if (requestedRoutes) assert.ok(requestedRoutes.length > 0 && requestedRoutes.every(route => inventory.includes(route)), 'Unknown secondary route');
  const routesToVisit = requestedRoutes ? [...new Set(requestedRoutes)] : inventory;
  const report = { origin, mode, at: new Date().toISOString(), normalAdmin: true, firstVisit: null, navDom: [], transitions: [], secondary: [], secondaryRouteInventory: inventory,
    errors: [], httpErrors: [], commerceSessionChallenges: [], blockedWrites: [], blockedAdvancingGets: [], allowedSessionBridges: [], telemetryWrites: [], generationRequests: 0, purpose: 'Read-only navigation and rendered page checks; only passive product telemetry and the same-origin Commerce main-session bridge are allowed; no generation acceptance claim.' };
  // Preserve prior real acceptance evidence, including failures.
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ origin, token, user }) => { if (location.origin === origin) { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); } }, { origin, token, user: auth.user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const passiveTelemetry = request.method() === 'POST' && url.origin === origin && url.pathname === '/api/product-usage/events';
    const sessionBridge = request.method() === 'POST' && url.origin === origin && url.pathname === '/api/commerce/session'
      && (() => { try { return request.postDataJSON()?.action === 'main-bind'; } catch { return false; } })();
    if (passiveTelemetry) {
      report.telemetryWrites.push({ path: url.pathname, method: request.method() });
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, source: 'LOCAL_NAV_READONLY_TELEMETRY' }) });
      return;
    }
    if (sessionBridge) {
      report.allowedSessionBridges.push({ path: url.pathname, method: request.method(), action: 'main-bind' });
      await route.continue();
      return;
    }
    const kind = classifyNavigationRequest(request.method(), url.pathname);
    if (kind !== 'read') {
      (kind === 'mutation' ? report.blockedWrites : report.blockedAdvancingGets).push({ path: url.origin === origin ? url.pathname : 'external', method: request.method() });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  const page = await context.newPage(); let activeRoute = '/';
  const initiatingRoutes = new WeakMap();
  page.on('request', request => initiatingRoutes.set(request, activeRoute));
  page.on('pageerror', error => report.errors.push({ route: activeRoute, name: error.name, message: clean(error.message) }));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== origin || response.status() < 400) return;
    const issue = { route: initiatingRoutes.get(response.request()) || activeRoute, path: url.pathname, status: response.status() };
    if (url.pathname === '/api/commerce/session' && response.request().method() === 'GET' && response.status() === 401) {
      report.commerceSessionChallenges.push(issue);
      return;
    }
    report.httpErrors.push(issue);
  });
  const waitForCommerceSession = async targetPage => {
    await targetPage.waitForFunction(async () => {
      try {
        const response = await fetch('/api/commerce/session', { cache: 'no-store' });
        return response.ok;
      } catch {
        return false;
      }
    }, null, { timeout: 30000 });
    return true;
  };
  const navSnapshot = () => page.locator('.nav-bar-container').locator(CONTROL_SELECTOR).evaluateAll(elements => elements.map((element, index) => {
    const box = element.getBoundingClientRect(), rawHref = element.getAttribute('href'); let hrefPath = null;
    try { if (rawHref) hrefPath = new URL(rawHref, location.href).pathname; } catch {}
    return { index, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), ariaLabel: element.getAttribute('aria-label'), text: element.textContent?.trim(), hrefPath,
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true', visible: box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden' };
  }));
  const measure = async (targetPage, ready) => {
    if (ready) await targetPage.locator(ready).first().waitFor({ state: 'visible', timeout: 30000 });
    else await targetPage.waitForFunction(() => document.readyState !== 'loading' && document.body.innerText.trim().length > 100 && document.querySelector('main, [data-page], .secondary-workbench, h1,h2'), null, { timeout: 30000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await targetPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return await targetPage.evaluate(() => ({ path: location.pathname, search: location.search, overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
          viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, fatal: /Application error|Unhandled Runtime Error|This page could not be found/u.test(document.body.innerText),
          headings: [...document.querySelectorAll('h1,h2')].slice(0, 4).map(node => node.textContent?.trim()), controls: document.querySelectorAll('button,input,textarea,select,a[href]').length }));
      } catch (error) {
        if (attempt > 0 || !/Execution context was destroyed/u.test(String(error?.message || error))) throw error;
        await targetPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await targetPage.waitForTimeout(250);
      }
    }
    throw new Error('Unable to inspect rendered page');
  };
  try {
    const started = Date.now(); await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('.agent-card-hover').first().waitFor({ timeout: 30000 }); const cardsMs = Date.now() - started;
    const avatar = await page.locator('.agent-card-hover img').first().evaluate(async image => { try { await image.decode(); return { width: image.naturalWidth, complete: true }; } catch { return { width: image.naturalWidth, complete: false }; } }).catch(() => null);
    report.firstVisit = { cardsMs, avatarMs: Date.now() - started, avatar, count: await page.locator('.agent-card-hover').count() };
    report.navDom = await navSnapshot(); await save();
    if (mode === 'primary' || mode === 'all') for (const entry of PRIMARY_ROUTES) {
      const result = { label: entry.label, expectedPath: entry.path, interaction: 'real-dom-click' };
      try {
        activeRoute = '/'; await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('.nav-bar-container').waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForFunction(({ expectedPath, expectedNames }) => {
          const normalizedNames = new Set(expectedNames.map(value => String(value || '').replace(/\s+/gu, '')));
          return [...document.querySelectorAll('.nav-bar-container button,.nav-bar-container a,.nav-bar-container [role="button"],.nav-bar-container [role="link"]')].some(element => {
            const box = element.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0 || getComputedStyle(element).visibility === 'hidden') return false;
            const label = String(element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/gu, '');
            const href = element.getAttribute('href');
            let hrefPath = '';
            try { if (href) hrefPath = new URL(href, location.href).pathname; } catch { /* ignore invalid navigation metadata */ }
            return hrefPath === expectedPath || normalizedNames.has(label);
          });
        }, { expectedPath: entry.path, expectedNames: entry.names }, { timeout: 10000 });
        const control = selectNavigationControl(await navSnapshot(), entry); result.control = control;
        const locator = page.locator('.nav-bar-container').locator(CONTROL_SELECTOR).nth(control.index);
        await locator.waitFor({ state: 'visible', timeout: 30000 }); await locator.scrollIntoViewIfNeeded();
        const began = Date.now(); activeRoute = entry.path;
        const popupPromise = entry.opensNewTab ? context.waitForEvent('page', { timeout: 30000 }) : null;
        await locator.click();
        const targetPage = popupPromise ? await popupPromise : page;
        // These controls use Next's client router. Waiting for a new document's
        // DOMContentLoaded can hang after the URL has already committed.
        await targetPage.waitForURL(url => url.origin === origin && (url.pathname === entry.path || url.pathname.startsWith(entry.path + '/')), { timeout: 30000 });
        if (entry.path === '/commerce') result.commerceSessionReady = await waitForCommerceSession(targetPage);
        result.routeCommitMs = Date.now() - began; Object.assign(result, await measure(targetPage, entry.ready)); result.firstContentMs = Date.now() - began;
        assert.equal(result.fatal, false, 'Fatal page content'); assert.equal(result.overflow, false, 'Document horizontal overflow'); assert.ok(result.controls > 0, 'No rendered controls');
        result.passed = true; await targetPage.screenshot({ path: `${output}/primary-${entry.path.replaceAll('/', '_') || 'marketplace'}.png` });
        if (targetPage !== page) await targetPage.close();
      } catch (error) { result.passed = false; result.failure = clean(error.message); }
      report.transitions.push(result); await save(); console.log(JSON.stringify({ stage: 'primary', ...result }));
    }
    if (mode === 'secondary' || mode === 'all') for (const target of routesToVisit) {
      const result = { expectedPath: target, interaction: 'read-only-direct-navigation' };
      try {
        activeRoute = target; const began = Date.now(); const response = await page.goto(origin + target, { waitUntil: 'domcontentloaded', timeout: 45000 }); result.http = response?.status() || null;
        result.finalExpectedPath = await waitForSecondaryDestination(page, target, origin);
        if (new URL(target, origin).pathname.startsWith('/commerce')) result.commerceSessionReady = await waitForCommerceSession(page);
        Object.assign(result, await measure(page, null)); result.firstContentMs = Date.now() - began; result.redirected = new URL(target, origin).pathname !== result.path;
        assert.ok(result.http && result.http < 400, 'Static route HTTP error'); assert.equal(result.path, result.finalExpectedPath, 'Unexpected final route'); assert.equal(result.fatal, false, 'Fatal page content'); assert.equal(result.overflow, false, 'Document horizontal overflow'); result.passed = true;
      } catch (error) { result.passed = false; result.failure = clean(error.message); await page.screenshot({ path: `${output}/secondary-failure-${report.secondary.length}.png` }).catch(() => {}); }
      report.secondary.push(result); await save(); console.log(JSON.stringify({ stage: 'secondary', ...result }));
    }
    report.passed = report.transitions.every(result => result.passed) && report.secondary.every(result => result.passed) && report.errors.length === 0 && report.httpErrors.length === 0;
  } catch (error) { report.passed = false; report.failure = clean(error.message); }
  finally { await browser.close(); report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ report: reportPath, passed: report.passed, primaryCount: report.transitions.length, secondaryCount: report.secondary.length, pageErrors: report.errors.length, generationRequests: 0 })); }
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error(JSON.stringify({ failed: true, code: 'NAVIGATION_RUNNER_START_FAILED', generationRequests: 0 })); process.exitCode = 1; });
}
