#!/usr/bin/env node
// --self-test is offline. --execute needs LOCAL_NAV_ADMIN_TOKEN in memory for protected HTML GET only; all business data and role identities remain RAM fixtures.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';
import { createEvidenceDirectory, createUsersRouteHarness, projectRoot, sourceIdentity } from './verify-admin-self-concealment-zero-network.mjs';

const origin = 'http://127.0.0.1:5000';
const adminLoginPath = '/admin/superzhujunguo';
const protectedHtmlPaths = new Set(['/admin', '/admin/extraction-reconciliation']);

function protectedHtmlHeaders(request, actorKey, token) {
  const url = new URL(request.url);
  return actorKey !== 'student' && url.origin === origin && protectedHtmlPaths.has(url.pathname) && request.method === 'GET'
    ? { ...request.headers, Authorization: `Bearer ${token}` } : null;
}

const permissions = ['members.view', 'billing.view', 'wallet.adjust'];

function accessSnapshot(actorKey) {
  return {
    access: { authorityStatus: 'ready', integrityValid: true, adminLevel: actorKey === 'owner' ? 'super_admin' : 'admin', permissionKeys: permissions, revision: 1, profileActive: true, updatedAt: null },
    stepUp: { status: 'ready', expiresAt: new Date(Date.now() + 600_000).toISOString(), authMethod: 'login_password' },
    maintenanceLock: { status: 'disabled', enabled: false, revision: 1, enabledAt: null, expiresAt: null, enableReason: '', disabledAt: null, disableReason: '', maxDurationMinutes: 20 },
    tabAccess: { users: true, credits: true }, managementPasswordSet: false,
    catalog: permissions.map(key => ({ key, group: '内存快照', label: key, description: 'Synthetic browser permission', risk: 'high', stepUpRequired: key === 'wallet.adjust' })),
  };
}

function staticResource(url) {
  if (['/', '/admin', '/admin/extraction-reconciliation', '/profile', '/storyboard-workbench', '/image-workbench', adminLoginPath].includes(url.pathname)) return true;
  if (url.pathname.startsWith('/_next/static/')) return true;
  try {
    const publicRoot = path.join(projectRoot, 'public');
    const file = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
    return file.startsWith(`${publicRoot}${path.sep}`) && statSync(file).isFile();
  } catch { return false; }
}

export function createRamInterceptor(actorKey) {
  const harness = createUsersRouteHarness();
  const account = harness.byKey[actorKey];
  assert.ok(account, 'UNKNOWN_SYNTHETIC_ACTOR');
  const user = { ...account, displayName: account.display_name, name: account.display_name, memberStatus: 'active', allowedCategories: account.allowed_categories, hasPassword: true };
  const trace = { apiReads: [], interceptedWrites: [], blockedExternal: [], unknownReads: [], forwardedStatic: [], forwardedIdentityReads: [], abortedStatic: [], pageErrors: [], consoleErrors: [] };
  const json = (body, status = 200) => ({ action: 'fulfill', status, contentType: 'application/json', body: JSON.stringify(body) });
  async function respond(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      trace.interceptedWrites.push({ method, path: url.pathname, telemetryOnly: ['/api/product-usage/events', '/api/operation-events'].includes(url.pathname) });
      if (['/api/product-usage/events', '/api/operation-events'].includes(url.pathname)) return json({ accepted: false, stored: false, fixtureOnly: true, code: 'FIXTURE_TELEMETRY_SUPPRESSED' });
      return json({ error: '本次验收禁止业务写入', code: 'FIXTURE_WRITE_BLOCKED' }, 409);
    }
    if (url.origin !== origin) {
      trace.blockedExternal.push({ method, host: url.hostname, path: url.pathname });
      return json({ error: 'External request blocked', code: 'FIXTURE_EXTERNAL_BLOCKED' }, 451);
    }
    if (url.pathname.startsWith('/api/')) {
      trace.apiReads.push(url.pathname + url.search);
      if (url.pathname === '/api/version') { trace.forwardedIdentityReads.push(url.pathname); return { action: 'continue' }; }
      if (url.pathname.startsWith('/api/branding/assets/')) return { action: 'fulfill', status: 200, contentType: 'image/webp', body: readFileSync(path.join(projectRoot, 'public/brand/platform-logo-display-256.webp')) };
      if (url.pathname === '/api/announcements/inbox') return json({ announcements: [], items: [], unreadCount: 0 });
      if (url.pathname === '/api/notifications/user') return json({ notifications: [], items: [], unreadCount: 0 });
      if (url.pathname === '/api/conversations/history') return json({ conversations: [], history: [], hasMore: false });
      if (url.pathname === '/api/shortcuts') return json({ shortcuts: [] });
      if (url.pathname === '/api/agent-favorites') return json({ favorites: [], count: 0 });
      if (url.pathname === '/api/settings/ui-preferences') return json({ preferences: null });
      if (url.pathname === '/api/nav-items') return json({ navItems: [] });
      if (url.pathname === '/api/categories') return json({ categories: [] });
      if (url.pathname === '/api/user/assets') return json({ credits: { balance: user.credits, totalRecharged: user.credits, totalConsumed: 0 }, cash: { balance: user.cash_balance, totalRecharged: user.cash_balance, totalConsumed: 0 }, recentCreditTransactions: [], recentCashTransactions: [] });
      if (url.pathname === '/api/user/transactions') return json({ transactions: [], totalCount: 0 });
      if (url.pathname === '/api/auth/me') return json({ user });
      if (url.pathname === '/api/admin/access-control/self') return account.role === 'admin' ? json(accessSnapshot(actorKey)) : json({ error: '无管理员权限' }, 403);
      if (url.pathname === '/api/admin/users') {
        const result = await harness.get(actorKey, url.searchParams.toString());
        return json(result.body, result.status);
      }
      if (url.pathname === '/api/member-permissions') return json({ permission: {
        userId: user.id, role: user.role, featureNavigationKeys: ['marketplace', 'storyboard_workbench', 'image_workbench'], agentNavigationKeys: ['task:文案创作'],
        revision: 1, checksum: 'synthetic-ram-only', sourceProfileKey: null, sourceProfileVersion: null, updatedAt: null, updatedBy: null,
        reason: 'Synthetic RAM snapshot', integrityValid: true, authorityStatus: user.role === 'admin' ? 'admin' : 'ready',
      } });
      if (url.pathname === '/api/credits') return json({ credits: user.credits, cashBalance: user.cash_balance, transactions: [] });
      if (url.pathname === '/api/bots') return json({ agents: [], bots: [], categories: [], navigationKeys: ['task:文案创作'] });
      if (url.pathname === '/api/settings/appearance' || url.pathname === '/api/settings') return json({ settings: { theme: 'soft-white', theme_mode: 'system', platform_name: '自媒体操盘手' } });
      if (url.pathname === '/api/settings/layout') return json({ layout: null });
      if (url.pathname === '/api/branding') return json({ branding: {
        displayScope: 'platform', hostname: '127.0.0.1', source: 'legacy', generation: 0, revisionId: null, revisionVersion: null, publishedAt: null,
        brand: { schema: 'platform-brand/v1', name: '自媒体操盘手', shortName: '操盘手', slogan: '', welcomeMessage: '', description: '', seo: { title: '自媒体操盘手', description: '' }, colors: { primary: '#168D7A', accent: '#2F80FF' }, contact: { name: '', wechat: '', phone: '', email: '' }, assetIds: {} }, assets: {},
      } });
      if (['/api/conversations', '/api/announcements', '/api/favorites'].includes(url.pathname)) return json({ conversations: [], announcements: [], favorites: [] });
      trace.unknownReads.push({ method, path: url.pathname });
      return json({ error: 'Unconfigured RAM endpoint', code: 'FIXTURE_ENDPOINT_UNCONFIGURED' }, 404);
    }
    if (staticResource(url, request.resourceType)) { trace.forwardedStatic.push(url.pathname); return { action: 'continue' }; }
    trace.abortedStatic.push({ path: url.pathname, search: url.search, resourceType: request.resourceType });
    return { action: 'abort' };
  }
  return { harness, user, trace, respond };
}

export async function selfTest() {
  const output = createEvidenceDirectory('browser-self-test');
  const fixture = createRamInterceptor('operator');
  const invoke = (pathname, method = 'GET', resourceType = 'fetch') => fixture.respond({ url: new URL(pathname, origin).href, method, resourceType });
  const users = JSON.parse((await invoke('/api/admin/users?role=admin')).body);
  assert.deepEqual(users.users.map(user => user.id), [fixture.user.id]);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const result = await invoke('/api/admin/credits', method);
    assert.equal(result.status, 409); assert.equal(result.action, 'fulfill');
  }
  assert.equal((await fixture.respond({ url: 'https://example.invalid/api/admin/credits', method: 'POST', resourceType: 'fetch' })).status, 409);
  assert.equal((await fixture.respond({ url: 'https://example.invalid/image.png', method: 'GET', resourceType: 'image' })).status, 451);
  assert.equal((await invoke('/api/unconfigured')).status, 404);
  assert.equal((await invoke('/admin', 'GET', 'document')).action, 'continue');
  assert.equal((await invoke('/api/admin/credits')).action, 'fulfill');
  assert.equal((await invoke('/api/version')).action, 'continue');
  assert.equal((await invoke('/admin?_rsc=synthetic', 'GET', 'fetch')).action, 'continue');
  assert.equal((await invoke('/api/branding/assets/any')).contentType, 'image/webp');
  const syntheticToken = 'synthetic-html-session';
  const protectedRequest = { url: `${origin}/admin`, method: 'GET', headers: {} };
  assert.equal(protectedHtmlHeaders(protectedRequest, 'owner', syntheticToken).Authorization, `Bearer ${syntheticToken}`);
  assert.equal(protectedHtmlHeaders({ ...protectedRequest, url: `${origin}/admin?_rsc=synthetic` }, 'operator', syntheticToken).Authorization, `Bearer ${syntheticToken}`);
  assert.equal(protectedHtmlHeaders(protectedRequest, 'student', syntheticToken), null);
  assert.equal(protectedHtmlHeaders({ ...protectedRequest, url: `${origin}/api/admin/users` }, 'owner', syntheticToken), null);
  assert.equal(protectedHtmlHeaders({ ...protectedRequest, url: 'https://example.invalid/admin' }, 'owner', syntheticToken), null);
  assert.equal(protectedHtmlHeaders({ ...protectedRequest, method: 'POST' }, 'owner', syntheticToken), null);
  const student = createRamInterceptor('student');
  assert.equal((await student.respond({ url: `${origin}/api/admin/users`, method: 'GET', resourceType: 'fetch' })).status, 403);
  assert.equal((await student.respond({ url: `${origin}/api/admin/access-control/self`, method: 'GET', resourceType: 'fetch' })).status, 403);
  const result = { status: 'PASS', evidenceLayer: 'fixture-only browser interceptor self-test; browser not executed',
    checksPassed: 21, blockedMutationMethods: ['POST', 'PUT', 'PATCH', 'DELETE'], realRouteQueryFiltersApplied: true,
    forwardedBusinessApiRequests: 0, forwardedBusinessWrites: 0, realRoleSessionsVerified: false, sourceIdentity: sourceIdentity() };
  writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, output }, null, 2));
}

async function verifyCurrentRuntime() {
  const dist = process.env.LOCAL_VALIDATION_DIST_DIR || '.next';
  assert.ok(['.next', '.next-local-acceptance', '.next-local-acceptance-next'].includes(dist), 'CONTROLLED_DIST_REQUIRED');
  const response = await fetch(`${origin}/api/version`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, 'VERSION_READ_FAILED');
  const runtime = await response.json();
  const readJson = relative => JSON.parse(readFileSync(path.join(projectRoot, relative), 'utf8').replace(/^\uFEFF/u, ''));
  const version = readJson('public/version.json');
  const receipt = readJson(`${dist}/local-source-fingerprint.v1.json`);
  const buildId = readFileSync(path.join(projectRoot, dist, 'BUILD_ID'), 'utf8').trim();
  const current = computeLocalBuildFingerprint(projectRoot);
  assert.ok(runtime.sourceVersion && runtime.buildId, 'RUNTIME_IDENTITY_REQUIRED');
  assert.equal(runtime.sourceVersion, version.sourceVersion, 'SERVED_SOURCE_VERSION_STALE');
  assert.equal(runtime.buildId, buildId, 'SERVED_BUILD_STALE');
  assert.equal(receipt.buildId, buildId, 'BUILD_RECEIPT_MISMATCH');
  assert.equal(receipt.fingerprint, current.fingerprint, 'SOURCE_FINGERPRINT_STALE');
  assert.equal(receipt.fileCount, current.fileCount, 'SOURCE_FILE_COUNT_STALE');
  return { sourceVersion: runtime.sourceVersion, buildId, fingerprint: current.fingerprint, runningLatest: true, sourceFingerprintCurrent: true };
}

export async function executeBrowser() {
  const output = createEvidenceDirectory('browser');
  const report = { status: 'RUNNING', evidenceLayer: 'fixture-only current-build browser UI; RAM accounts and permissions',
    realRoleSessionsVerified: false, forwardedBusinessApiRequests: 0, forwardedBusinessWrites: 0, scenarios: [], sourceIdentity: sourceIdentity() };
  let browser;
  let diagnosticPage;
  let diagnosticActor;
  try {
    report.runtime = await verifyCurrentRuntime();
    const pageAccessToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
    assert.ok(pageAccessToken, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED_FOR_PROTECTED_HTML_ONLY');
    report.serverHtmlAccess = { existingControlledAdministratorSession: true, roleData: 'RAM fixtures only', authorizationInjectedOnlyFor: 'owner/operator GET /admin HTML/RSC and its extraction-reconciliation link prefetch', studentServerAuthorization: 'none; no auth cookie', tokenPersisted: false };
    const browserTemp = path.join(output, 'chromium-temp');
    mkdirSync(browserTemp, { recursive: true });
    process.env.TEMP = browserTemp; process.env.TMP = browserTemp;
    report.chromiumTemporaryDirectory = browserTemp;
    const { chromium } = await import('playwright');
    const bundled = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
    browser = await chromium.launch({ headless: true, env: { ...process.env, TEMP: browserTemp, TMP: browserTemp }, ...(existsSync(bundled) ? { executablePath: bundled } : {}) });
    for (const actorKey of ['owner', 'operator', 'student']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      diagnosticPage = page; diagnosticActor = actorKey;
      page.setDefaultTimeout(25000);
      const fixture = createRamInterceptor(actorKey);
      const scenario = { actor: actorKey, fixtureOnly: true, trace: fixture.trace, passed: false };
      report.scenarios.push(scenario);
      page.on('pageerror', error => fixture.trace.pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') fixture.trace.consoleErrors.push(message.text()); });
      await context.addInitScript(({ expectedOrigin, user, actor }) => {
        if (location.origin !== expectedOrigin) return;
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem('auth_token', `synthetic-session:${actor}`);
        localStorage.setItem('auth_user', JSON.stringify(user));
        sessionStorage.setItem('entered_app', '1');
      }, { expectedOrigin: origin, user: fixture.user, actor: actorKey });
      await context.route('**/*', async route => {
        const request = route.request();
        const decision = await fixture.respond({ url: request.url(), method: request.method(), resourceType: request.resourceType() });
        if (decision.action === 'continue') {
          const headers = protectedHtmlHeaders({ url: request.url(), method: request.method(), headers: request.headers() }, actorKey, pageAccessToken);
          if (headers) return route.continue({ headers });
          return route.continue();
        }
        if (decision.action === 'abort') return route.abort('blockedbyclient');
        return route.fulfill({ status: decision.status, contentType: decision.contentType, body: decision.body });
      });
      if (actorKey === 'student') {
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        const menu = page.getByTestId('sidebar-user-menu-trigger');
        await menu.waitFor(); await menu.click();
        await page.getByRole('menuitem', { name: '个人中心', exact: true }).waitFor();
        await page.getByRole('menu').evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
        assert.equal(await page.getByTestId('sidebar-admin-entry').count(), 0, 'STUDENT_ADMIN_ENTRY_EXPOSED');
        await page.screenshot({ path: path.join(output, 'student-account-menu.png'), fullPage: false });
        scenario.adminEntryVisible = false;
        await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
        await page.waitForURL(url => url.pathname === adminLoginPath);
        assert.equal(await page.getByRole('navigation', { name: '管理后台一级导航', exact: true }).count(), 0, 'STUDENT_ADMIN_NAVIGATION_EXPOSED');
        scenario.directAdminRedirect = new URL(page.url()).pathname;
        scenario.serverGateEvidence = 'unauthenticated browser request rejected before admin React; RAM auth/me remains student';
        assert.equal((await context.cookies()).filter(cookie => cookie.name === 'auth_token').length, 0);
        await page.screenshot({ path: path.join(output, 'student-admin-redirect.png'), fullPage: false });
      } else {
        await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
        assert.equal(new URL(page.url()).pathname, '/admin', 'PROTECTED_HTML_SESSION_REJECTED');
        const expected = await fixture.harness.get(actorKey);
        try { await page.waitForFunction(count => document.querySelectorAll('[data-testid="admin-member-card"]').length === count, expected.body.users.length); } catch(error) { scenario.failureDOM = await page.locator('body').innerText(); scenario.failureURL = page.url(); await page.screenshot({path: path.join(output, actorKey+'-failure.png')}); throw error; }
        const names = await page.getByTestId('admin-member-card').locator('h3').allTextContents();
        assert.deepEqual(names.map(name => name.trim()).sort(), expected.body.users.map(user => user.name).sort(), 'MEMBER_ROWS_DIFFER_FROM_FILTERED_REAL_ROUTE');
        scenario.memberNames = names;
        await page.screenshot({ path: path.join(output, `${actorKey}-member-list.png`), fullPage: false });
        await page.getByRole('navigation', { name: '管理后台一级导航', exact: true }).getByRole('button', { name: '财务与账单', exact: true }).click();
        await page.getByRole('heading', { name: '积分充值', exact: true }).waitFor();
        scenario.adminNavigation = await page.getByRole('navigation', { name: '管理后台一级导航', exact: true }).getByRole('button').evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.testid, current: node.getAttribute('aria-current'), label: node.textContent.trim(), backgroundColor: getComputedStyle(node).backgroundColor, borderLeft: getComputedStyle(node).borderLeft })));
        assert.deepEqual(scenario.adminNavigation.filter(item => item.current === 'page').map(item => item.key), ['admin-primary-nav-credits']);
        const select = page.locator('select').filter({ has: page.locator(`option[value="${fixture.user.id}"]`) });
        assert.equal(await select.count(), 1, 'INTERNAL_RECHARGE_SELF_OPTION_MISSING_OR_AMBIGUOUS');
        await select.selectOption(fixture.user.id);
        scenario.recharge = await select.evaluate(node => ({ selectedId: node.value, options: [...node.options].filter(option => option.value).map(option => ({ id: option.value, label: option.text })), geometry: { x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height } }));
        assert.equal(scenario.recharge.selectedId, fixture.user.id);
        assert.deepEqual(scenario.recharge.options.map(option => option.id).sort(), expected.body.users.map(user => user.id).sort());
        assert.ok(scenario.recharge.options.find(option => option.id === fixture.user.id)?.label.includes('（管理员）'));
        await page.screenshot({ path: path.join(output, `${actorKey}-self-recharge-selected.png`), fullPage: false });
      }
      if (actorKey === 'operator') {
        scenario.adjacentPages = [];
        for (const adjacentPath of ['/', '/profile']) {
          await page.goto(`${origin}${adjacentPath}`, { waitUntil: 'domcontentloaded' });
          if (adjacentPath === '/') await page.getByTestId('sidebar-user-menu-trigger').waitFor();
          else await page.getByTestId('profile-identity-card').waitFor();
          const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 }));
          assert.equal(geometry.horizontalOverflow, false, 'ADJACENT_PAGE_HORIZONTAL_OVERFLOW');
          const filename = adjacentPath === '/' ? 'operator-adjacent-home.png' : 'operator-adjacent-profile.png';
          await page.screenshot({ path: path.join(output, filename), fullPage: false });
          scenario.adjacentPages.push({ path: adjacentPath, geometry, screenshot: filename });
        }
      }
      assert.deepEqual(fixture.trace.pageErrors, [], 'BROWSER_APPLICATION_ERRORS');
      assert.deepEqual(fixture.trace.consoleErrors, [], 'BROWSER_CONSOLE_ERRORS');
      assert.deepEqual(fixture.trace.unknownReads, [], 'BROWSER_FIXTURE_ENDPOINT_MISSING');
      assert.equal(fixture.harness.state.writeAttempts, 0);
      scenario.passed = true;
      await context.close();
    }
    assert.deepEqual(await verifyCurrentRuntime(), report.runtime, 'RUNTIME_CHANGED_DURING_BROWSER_CHECK');
    report.status = 'PASS';
  } catch (error) {
    if (diagnosticPage && !diagnosticPage.isClosed()) { report.failureDOM = await diagnosticPage.locator('body').innerText().catch(() => ''); report.failureURL = diagnosticPage.url(); await diagnosticPage.screenshot({ path: path.join(output, `${diagnosticActor}-failure.png`), fullPage: false }).catch(() => {}); }
    report.status = 'FAIL'; report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, evidenceLayer: report.evidenceLayer, scenarios: report.scenarios.map(item => ({ actor: item.actor, passed: item.passed })), realRoleSessionsVerified: false, forwardedBusinessWrites: 0, error: report.error, output }, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.every(argument => ['--execute', '--self-test'].includes(argument)), 'Only --execute or --self-test is supported');
  assert.ok(!(args.includes('--execute') && args.includes('--self-test')), 'Choose one verification mode');
  if (args.includes('--execute')) await executeBrowser();
  else await selfTest();
}
