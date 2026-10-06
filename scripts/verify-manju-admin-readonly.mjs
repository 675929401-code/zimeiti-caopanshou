import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const base = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const evidenceDir = '.codex-evidence/manju-draft-preservation-20260902';
const report = { observedAt: new Date().toISOString(), mode: 'read-only', session: {}, api: [], pages: [], blockedMutations: 0, blockedHealthProbes: 0, browserErrorCount: 0 };
let browser;

async function runAcceptance() {
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  const sessionResponse = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
  });
  const session = await sessionResponse.json();
  report.session = { status: sessionResponse.status, authenticated: Boolean(sessionResponse.ok && session.user), role: session.user?.role || null };
  assert.ok(report.session.authenticated, 'a normal local developer session is required; no synthetic JWT fallback');
  assert.equal(report.session.role, 'admin');
  for (const route of [
    '/api/admin/manju-config?environment=production&domain=prompt',
    '/api/admin/manju-config?environment=production&domain=media',
    '/api/admin/manju-workbench/assets',
  ]) {
    const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const payload = await response.json();
    report.api.push({ route, status: response.status, ok: payload.ok !== false && response.ok,
      storageMode: payload.storage_mode || null, activePresent: Boolean(payload.active),
      draftCount: Array.isArray(payload.drafts) ? payload.drafts.length : null,
      assetCount: Array.isArray(payload.assets) ? payload.assets.length : null,
      code: typeof payload.code === 'string' ? payload.code : null });
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
  }, { token, user: session.user });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base && /^https?:$/.test(url.protocol)) return route.abort();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      report.blockedMutations += 1;
      return route.abort();
    }
    if (url.pathname === '/api/health' && !url.searchParams.has('logs') && !url.searchParams.has('liveness')) {
      report.blockedHealthProbes += 1;
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => { report.browserErrorCount += 1; });
  let response = await page.goto('/admin?tab=manju-workbench', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const panel = page.locator('[data-admin-panel="manju-workbench"]');
  const config = page.locator('[data-admin-section="manju-config-center"]');
  const showcase = page.locator('[data-admin-section="manju-showcase-catalog"]');
  await panel.waitFor({ state: 'visible', timeout: 40_000 });
  await config.waitFor({ state: 'visible', timeout: 40_000 });
  await showcase.waitFor({ state: 'visible', timeout: 40_000 });
  // Wait for data loading to settle without clicking save/publish/upload controls.
  await page.waitForFunction(() => !document.querySelector('[data-admin-section="manju-config-center"]')?.textContent?.includes('正在读取配置控制平面'), undefined, { timeout: 30_000 });
  const publish = config.getByRole('button', { name: '发布所选草稿', exact: true });
  const showcasePublish = showcase.getByRole('button', { name: '发布所选草稿', exact: true });
  report.pages.push({ route: '/admin?tab=manju-workbench', status: response?.status() || null,
    panelVisible: await panel.isVisible(), configVisible: await config.isVisible(), showcaseVisible: await showcase.isVisible(),
    configEditorPresent: await config.locator('textarea').count() > 0,
    configPublishButtonPresent: await publish.count() === 1, showcasePublishButtonPresent: await showcasePublish.count() === 1,
    unsavedHintPresentInitially: await config.getByText('当前编辑尚未保存。保存草稿后，即可发布这次修改。', { exact: true }).count() > 0,
    horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2) });
  for (const route of ['/youcai', '/youcai/assets']) {
    response = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('body').waitFor({ state: 'visible', timeout: 20_000 });
    report.pages.push({ route, status: response?.status() || null,
      bodyVisible: await page.locator('body').isVisible(),
      horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2) });
  }
  assert.ok(report.pages.every((entry) => entry.status === 200));
  assert.ok(report.pages.every((entry) => entry.horizontalOverflow === false));
  assert.equal(report.pages[0].configEditorPresent, true);
  assert.equal(report.pages[0].unsavedHintPresentInitially, false);
  assert.equal(report.browserErrorCount, 0);
}

export async function main() {
  let failure;
  try {
    await runAcceptance();
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failureName = error instanceof Error ? error.name : 'UnknownError';
    // Error text can include page/user content; retain only a safe diagnostic class.
    failure = error;
  } finally {
    await browser?.close();
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(`${evidenceDir}/runtime-readonly.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(() => { process.exitCode = 1; });
}
