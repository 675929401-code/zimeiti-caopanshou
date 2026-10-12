import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

// Run through with-local-customer-session.mjs. Authentication stays in memory;
// Only approved catalog/auth/settings GETs reach the app. Task history/status
// is intercepted because GET handlers may reconcile persistent state.
// Theme overrides live in this browser context; this is not a provider test.
const approvedGets = new Set([
  '/api/version', '/api/auth/me', '/api/member-permissions', '/api/bots',
  '/api/chat-models', '/api/cover-models', '/api/video/models', '/api/settings',
  '/api/settings/appearance', '/api/settings/layout', '/api/branding', '/api/agent-favorites',
]);
function isStaticEntry(url) {
  if (['/', '/video', '/storyboard-workbench'].includes(url.pathname) || url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return false;
  try {
    const root = path.resolve('public');
    const target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    return target.startsWith(`${root}${path.sep}`) && fs.statSync(target).isFile();
  } catch { return false; }
}

async function readApprovedResponse(route) {
  const response = await route.fetch({ maxRedirects: 0 });
  if (!response.ok() || (response.status() >= 300 && response.status() < 400)) throw new Error('APPROVED_READ_FAILED');
  return response;
}
function readOnlyRouteHandler({ origin, report, user, theme, mode }) {
  return async route => {

        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort('blockedbyclient');
        try {
        if (request.method() !== 'GET') {
          report.blockedWrites.push({ method: request.method(), path: url.pathname });
          if (/\/(llm|generate)(\/|$)/.test(url.pathname)) report.paidRequests += 1;
          return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'READ_ONLY_BROWSER_CHECK' }) });
        }
        const emptyHistories = {
          '/api/conversations/history': { conversations: [], messages: [] },
          '/api/video/history': { tasks: [] },
          '/api/storyboard/projects': { projects: [], nextOffset: null },
          '/api/image-workbench/failure-history': { records: [], nextPage: null },
          '/api/credits': { cashBalance: user.cashBalance || 0, credits: user.credits || 0 },
        };
        if (url.pathname in emptyHistories) return route.fulfill({ status: 200, json: emptyHistories[url.pathname] });
        if (url.pathname === '/api/auth/me') {
          const response = await readApprovedResponse(route);
          assert.ok(response.ok(), 'AUTH_GET_FAILED');
          const body = await response.json();
          if (body.user) Object.assign(body.user, { themePreference: theme, theme_preference: theme, themeModePreference: mode, theme_mode_preference: mode });
          return route.fulfill({ response, json: body });
        }
        if (url.pathname === '/api/settings/appearance') {
          const response = await readApprovedResponse(route);
          assert.ok(response.ok(), 'APPEARANCE_GET_FAILED');
          const body = await response.json();
          body.settings = { ...body.settings, theme, theme_mode: mode };
          return route.fulfill({ response, json: body });
        }
        if (approvedGets.has(url.pathname) || isStaticEntry(url)) return route.fulfill({ response: await readApprovedResponse(route) });
        report.blockedReads.push(url.pathname);
        return route.abort('blockedbyclient');
        } catch {
          report.readFailures.push({ path: url.pathname, code: 'APPROVED_READ_FAILED' });
          return route.abort('blockedbyclient');
        }
  };
}
async function waitForDialogEntrance(locator) {
  await locator.evaluate(async dialog => {
    // Only this surface's finite entrance animations; descendants may animate forever.
    const finite = dialog.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)
      && animation.playState !== 'finished' && animation.playState !== 'idle');
    let timeout;
    try {
      await Promise.race([
        Promise.all(finite.map(animation => animation.finished)),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('DIALOG_ENTRANCE_NOT_SETTLED')), 2000); }),
      ]);
    } finally { clearTimeout(timeout); }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function runtimeIdentity(origin) {
  const receipt = JSON.parse(fs.readFileSync('.next/local-source-fingerprint.v1.json', 'utf8'));
  const disk = JSON.parse(fs.readFileSync('public/version.json', 'utf8'));
  const buildId = fs.readFileSync('.next/BUILD_ID', 'utf8').trim();
  const current = computeLocalBuildFingerprint(process.cwd());
  const response = await fetch(`${origin}/api/version`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, 'VERSION_GET_FAILED');
  const version = await response.json();
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'local-production-preview-source-fingerprint');
  assert.equal(receipt.fingerprint, current.fingerprint, 'CURRENT_SOURCE_NOT_BUILT');
  assert.equal(receipt.fileCount, current.fileCount);
  assert.equal(receipt.buildId, version.buildId, 'CURRENT_BUILD_NOT_RUNNING');
  assert.equal(buildId, version.buildId);
  assert.equal(disk.sourceVersion, version.sourceVersion);
  return { runningLatest: true, buildId, sourceVersion: version.sourceVersion, fingerprint: current.fingerprint };
}
export async function main() {
  assert.equal(process.version, 'v24.19.0', 'PINNED_NODE_REQUIRED');
  const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
  assert.equal(origin, 'http://127.0.0.1:5000');
  const token = process.env.R267_CUSTOMER_TOKEN;
  assert.ok(token, 'LOCAL_CUSTOMER_SESSION_REQUIRED');
  const user = JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER || '{}');
  const output = path.resolve(process.env.INTAKE_ACCEPTANCE_OUTPUT || '.codex-evidence/intake-theme-current');
  fs.mkdirSync(output, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), runtime: await runtimeIdentity(origin), runtimeAfter: null, cases: [], adjacentPages: [], blockedWrites: [], blockedReads: [], readFailures: [], pageErrors: [], paidRequests: 0, scope: 'Actual current DOM, account and catalogs; empty task-history fixtures and initial-user credit fixture, not balance verification. Counters cover browser requests, not internal server/session-wrapper writes.' };
  const names = ['商业IP定位', '账号主页包装', '对标账号拆解', '内容选题策划', '短视频文案成稿', '咨询回复与跟进', '运营数据复盘'];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const theme of ['lattice', 'soft-white', 'crystal-aurora']) {
      const mode = theme === 'soft-white' ? 'light' : 'dark';
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
      await context.addInitScript(({ token, user, theme, mode }) => {
        localStorage.setItem('auth_token', token);
        localStorage.setItem('auth_user', JSON.stringify({ ...user, themePreference: theme, themeModePreference: mode }));
        localStorage.setItem('user_theme_preference', theme);
        localStorage.setItem('user_theme_mode_preference', mode);
        localStorage.setItem('active_view', 'marketplace');
        sessionStorage.setItem('entered_app', '1');
      }, { token, user, theme, mode });
      await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await context.route('**/*', readOnlyRouteHandler({ origin, report, user, theme, mode }));
      const page = await context.newPage();
      page.on('pageerror', error => report.pageErrors.push({ theme, name: error.name, messageSha256: createHash('sha256').update(error.message).digest('hex') }));
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.getByLabel('打开智能体：商业IP定位', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      const closeExisting = page.locator('[data-slot="dialog-close"]');
      if (await closeExisting.count() && await closeExisting.last().isVisible()) await closeExisting.last().click();
      for (const name of names) {
        await page.getByLabel(`打开智能体：${name}`, { exact: true }).click();
        const dialog = page.getByTestId('business-ip-intake');
        await dialog.waitFor({ state: 'visible' });
        let result;
        try { result = await measureDialog(dialog); } catch (error) {
          report.cases.push({ theme, name, measurementFailed: true });
          await page.screenshot({ path: path.join(output, theme + '-' + name + '-measurement-failed.png') });
          throw error;
        }
        report.cases.push({ theme, name, ...result });
        if (!(result.insideViewport && result.contrast >= 4.5 && result.opaqueSurfaces && result.scrollableBody && result.visibleActions && result.footerStableAfterScroll && result.refinedControls && result.businessGeometry)) {
          await page.screenshot({ path: path.join(output, theme + '-' + name + '-failed.png') });
        }
        assert.ok(result.insideViewport, `${theme}:${name}:bounds`);
        assert.ok(result.contrast >= 4.5, `${theme}:${name}:helper contrast ${result.contrast}`);
        assert.ok(result.opaqueSurfaces && result.scrollableBody && result.visibleActions && result.footerStableAfterScroll, `${theme}:${name}:controls`);
        assert.ok(result.refinedControls && result.businessGeometry, `${theme}:${name}:intake proportions`);

        if (name === names[0] || name === names[5]) await page.screenshot({ path: path.join(output, `${theme}-${name}.png`) });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      }
      const generic = page.getByRole('button', { name: /打开智能体：.*2D/ }).first();
      await generic.click();
      const dialog = page.getByTestId('agent-preset-intake');
      await dialog.waitFor({ state: 'visible' });
      let genericResult;
      try { genericResult = await measureDialog(dialog); } catch (error) {
        report.cases.push({ theme, name: 'generic-preset', measurementFailed: true });
        await page.screenshot({ path: path.join(output, theme + '-generic-preset-measurement-failed.png') });
        throw error;
      }
      report.cases.push({ theme, name: 'generic-preset', ...genericResult });
      await page.screenshot({ path: path.join(output, theme + '-generic-preset.png') });
      assert.ok(genericResult.insideViewport && genericResult.visibleActions && genericResult.footerStableAfterScroll, `${theme}:generic controls`);
      assert.ok(genericResult.refinedControls, `${theme}:generic scoped borders and radii`);
      assert.equal(genericResult.background, report.cases.find(item => item.theme === theme).background, 'INTAKE_SURFACES_MUST_AGREE');

      await page.keyboard.press('Escape');
      for (const route of ['/video', '/storyboard-workbench']) {
        await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(() => document.body.innerText.length > 100);
        assert.equal(new URL(page.url()).pathname, route, 'ADJACENT_ROUTE_REDIRECTED');
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(overflow <= 1, `${route}:horizontal overflow`);
        await page.screenshot({ path: path.join(output, `${theme}-${route.slice(1)}.png`) });
        report.adjacentPages.push({ theme, route, overflow });
      }
      await context.close();
    }
    assert.deepEqual(report.readFailures, [], 'APPROVED_READS_MUST_SUCCEED_WITHOUT_REDIRECT');
    assert.deepEqual(report.pageErrors, []);
    assert.equal(report.paidRequests, 0);
    report.runtimeAfter = await runtimeIdentity(origin);
    assert.deepEqual(report.runtimeAfter, report.runtime, 'RUNTIME_CHANGED_DURING_ACCEPTANCE');
    report.ok = true;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, adjacentPages: report.adjacentPages.length, paidRequests: report.paidRequests, output }));
}

async function measureDialog(locator) {
  await waitForDialogEntrance(locator);
  return locator.evaluate(async dialog => {
    const style = getComputedStyle(dialog);
    const box = dialog.getBoundingClientRect();
    const note = [...dialog.querySelectorAll('p,span')].find(node => node.textContent?.includes('系统会先识别')) || dialog.querySelector('[data-slot="dialog-description"]') || dialog.querySelector('label');
    const color = note ? getComputedStyle(note).color : style.color;
    const channels = value => (value.match(/[\d.]+/g) || []).map(Number);
    const rgb = value => channels(value).slice(0, 3).map(channel => { const n = channel / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
    const luminance = value => { const [r, g, b] = rgb(value); return .2126 * r + .7152 * g + .0722 * b; };
    const background = style.backgroundColor;
    const a = luminance(color), b = luminance(background);
    const primary = [...dialog.querySelectorAll('button')].find(button => /^(?:开始定位|发给智能体|进入小助理|加入输入框|加入当前草稿|开始)$/u.test(button.textContent.trim()));
    const body = [...dialog.querySelectorAll('div')].find(node => getComputedStyle(node).overflowY === 'auto');
    const actionBox = primary?.getBoundingClientRect();
    const actionStyle = primary && getComputedStyle(primary);
    const hit = actionBox && document.elementFromPoint(actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2);
    const visibleActions = Boolean(primary && actionBox?.width > 0 && actionBox.top >= 0 && actionBox.bottom <= innerHeight && actionStyle.visibility === 'visible' && Number(actionStyle.opacity) > 0 && (primary.contains(hit) || (actionStyle.pointerEvents === 'none' && hit === primary.parentElement)));
    const originalTop = body?.scrollTop || 0;
    if (body) body.scrollTop = body.scrollHeight;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterBox = primary?.getBoundingClientRect();
    const scrollableBody = Boolean(body && (body.scrollHeight <= body.clientHeight + 1 || body.scrollTop > 0));
    const footerStableAfterScroll = Boolean(actionBox && afterBox && Math.abs(actionBox.top - afterBox.top) <= 1 && afterBox.bottom <= innerHeight);
    if (body) body.scrollTop = originalTop;
    const borders = ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style[`border${side}Width`]));
    const controls = [...dialog.querySelectorAll('button:not([data-slot="dialog-close"]), input, textarea, select')];
    const controlRadii = controls.map(node => parseFloat(getComputedStyle(node).borderTopLeftRadius));
    const refinedControls = borders.every(width => width === 1) && controlRadii.every(radius => radius >= 8);
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    const footerStyle = footer && getComputedStyle(footer);
    const choiceHeights = [...dialog.querySelectorAll('fieldset button')].map(node => node.getBoundingClientRect().height);
    const textarea = dialog.querySelector('textarea[aria-label="照着模板说说你自己"]');
    const textareaHeight = textarea?.getBoundingClientRect().height;
    const businessGeometry = dialog.dataset.testid !== 'business-ip-intake' || (
      box.width >= 720 && box.width <= 760 && box.height <= innerHeight - 64
      && parseFloat(style.paddingTop) === 24
      && footerStyle && parseFloat(footerStyle.paddingTop) >= 16
      && choiceHeights.every(height => height >= 40 && height <= 64)
      && (!textarea || (textareaHeight >= 140 && textareaHeight <= 190))
    );
    return {
      background, color, contrast: Number(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(2)),
      opaqueSurfaces: [background, color].every(value => channels(value).length === 3 || channels(value)[3] === 1),
      insideViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      scrollableBody, visibleActions, footerStableAfterScroll,
      radius: style.borderRadius, borders, controlRadii, refinedControls,
      businessGeometry: Boolean(businessGeometry), width: box.width, height: box.height,
      padding: style.padding, choiceHeights, textareaHeight,
    };
  });
}


async function selfTest() {
  const origin = 'http://127.0.0.1:5000'; let checks = 0;
  const report = { blockedWrites: [], blockedReads: [], readFailures: [], paidRequests: 0 };
  const invoke = async (pathname, method = 'GET', status = 200) => {
    let outcome, reads = 0;
    await readOnlyRouteHandler({ origin, report, user: { credits: 0 }, theme: 'lattice', mode: 'dark' })({
      request: () => ({ url: () => pathname.startsWith('http') ? pathname : origin + pathname, method: () => method }),
      fetch: async options => { reads++; assert.deepEqual(options, { maxRedirects: 0 }); return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => ({ user: { role: 'student' }, settings: {} }) }; },
      fulfill: async value => { outcome = { kind: 'fulfilled', ...value }; },
      abort: async () => { outcome = { kind: 'blocked' }; },
      continue: async () => { throw new Error('UNCONTROLLED_FORWARD_FORBIDDEN'); },
    });
    return { ...outcome, reads };
  };
  for (const pathname of [...approvedGets, '/', '/video', '/_next/static/fixture.js']) {
    const result = await invoke(pathname); assert.equal(result.kind, 'fulfilled'); assert.equal(result.reads, 1); checks++;
  }
  for (const pathname of ['/api/auth/me', '/api/settings/appearance', '/api/member-permissions', '/', '/_next/static/fixture.js']) {
    for (const status of [301, 302, 307, 308, 403, 500]) {
      const before = report.readFailures.length, result = await invoke(pathname, 'GET', status);
      assert.equal(result.kind, 'blocked'); assert.equal(result.reads, 1); assert.equal(report.readFailures.length, before + 1); checks++;
    }
  }
  for (const [pathname, method] of [['https://external.invalid', 'GET'], ['/api/unknown', 'GET'], ['/api/image/generate', 'POST']]) {
    const result = await invoke(pathname, method); assert.equal(result.reads, 0); checks++;
  }
  const auth = await invoke('/api/auth/me'); assert.equal(auth.json.user.role, 'student'); assert.equal(auth.json.user.themePreference, 'lattice'); checks++;
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { queueMicrotask(() => callback(0)); return 0; };
  try {
  const events = [];
  await waitForDialogEntrance({ evaluate: callback => callback({ getAnimations: () => [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: 400 }) }, finished: Promise.resolve().then(() => { events.push('finished'); }) }] }) });
  assert.ok(events.includes('finished')); checks++;
  await waitForDialogEntrance({ evaluate: callback => callback({ getAnimations: () => [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) }, finished: new Promise(() => {}) }] }) }); checks++;
  await assert.rejects(waitForDialogEntrance({ evaluate: callback => callback({ getAnimations: () => [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: 400 }) }, finished: new Promise(() => {}) }] }) }), /DIALOG_ENTRANCE_NOT_SETTLED/u); checks++;
  } finally { if (previousFrame) globalThis.requestAnimationFrame = previousFrame; else delete globalThis.requestAnimationFrame; }
  console.log(JSON.stringify({ passed: true, checks, scope: 'Actual route callback and entrance wait offline; no browser or network' }));
}
if (process.argv.includes('--self-test')) await selfTest();
