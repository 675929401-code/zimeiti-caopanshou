import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:5000';
const report = { observedAt: new Date().toISOString(), mode: 'read-only', api: {}, pages: [], browserErrorCount: 0, blockedMutations: 0 };
let browser;
async function main() {
  const response = await fetch(`${base}/api/auth/dev-session`, { headers: { 'x-local-workbench': 'ai-creation-studio-local' }, signal: AbortSignal.timeout(20_000) });
  const session = await response.json();
  assert.ok(response.ok && session.token && session.user?.role === 'admin', 'normal local session required; no token fabrication');
  const api = await fetch(`${base}/api/admin/skill-packages?limit=5`, { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await api.json();
  report.api = { status: api.status, code: body.code || null, count: Array.isArray(body.packages) ? body.packages.length : null };
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(({ token, user }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); }, { token: session.token, user: session.user });
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) { report.blockedMutations++; return route.abort(); }
    if ((/^https?:$/.test(url.protocol) && url.origin !== base) || url.pathname === '/api/health') return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => { report.browserErrorCount++; });
  const admin = await page.goto('/admin?tab=manju-workbench#manju-custom-skill-packages', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const component = page.locator('[data-admin-section="manju-custom-skill-packages"]');
  await component.waitFor({ state: 'visible', timeout: 40_000 });
  if (body.code === 'MIGRATION_NOT_READY') await component.getByText('等待数据库迁移', { exact: true }).waitFor({ timeout: 30_000 });
  const save = component.getByRole('button', { name: /^保存草稿/ });
  report.pages.push({ route: '/admin?tab=manju-workbench#manju-custom-skill-packages', status: admin?.status(), componentVisible: await component.isVisible(),
    canValidate: await component.getByRole('button', { name: '校验结构', exact: true }).isEnabled(),
    saveDisabled: await save.isDisabled(), instructionsEditorPresent: await component.locator('textarea[rows="14"]').count() === 1,
    horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2) });
  if (body.code === 'MIGRATION_NOT_READY') assert.equal(report.pages[0].saveDisabled, true);
  for (const route of ['/youcai', '/youcai/assets']) {
    const pageResponse = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    report.pages.push({ route, status: pageResponse?.status(), bodyVisible: await page.locator('body').isVisible(), horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2) });
  }
  assert.ok(report.pages.every((entry) => entry.status === 200 && entry.horizontalOverflow === false));
  assert.equal(report.pages[0].canValidate, true);
  assert.equal(report.pages[0].instructionsEditorPresent, true);
  assert.equal(report.browserErrorCount, 0);
}
main().then(() => { report.passed = true; }).catch((error) => { report.passed = false; report.failureName = error instanceof Error ? error.name : 'UnknownError'; process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await mkdir('.codex-evidence/manju-skill-package-edit-20260902', { recursive: true });
  await writeFile('.codex-evidence/manju-skill-package-edit-20260902/runtime-readonly.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
});
