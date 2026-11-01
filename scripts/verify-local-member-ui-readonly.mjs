import assert from 'node:assert/strict';
import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

export async function main(args = []) {
  const origin = process.env.LOCAL_NAV_ORIGIN, token = process.env.R267_CUSTOMER_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:5000', 'EXACT_LOCAL_PREVIEW_REQUIRED');
  assert.ok(token, 'EXISTING_CUSTOMER_WRAPPER_REQUIRED');
  const argument = args.find(value => value.startsWith('--output-dir='));
  const output = path.resolve(argument?.slice(13) || '.codex-evidence/local-member-ui-missing-output');
  const boundary = path.resolve('.codex-evidence') + path.sep;
  assert.ok(argument && output.startsWith(boundary), 'NEW_EVIDENCE_DIRECTORY_REQUIRED');
  let ancestor = path.parse(output).root;
  for (const part of path.relative(ancestor, path.dirname(output)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    const metadata = await lstat(ancestor);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && path.relative(ancestor, await realpath(ancestor)) === '', 'PHYSICAL_OUTPUT_PARENT_REQUIRED');
  }
  await mkdir(output);
  const headers = { Authorization: `Bearer ${token}` };
  const report = { at: new Date().toISOString(), scope: 'ordinary-local-member-readonly', viewport: { width: 1440, height: 900 }, pages: [], checks: [], requests: [], errors: [], blockedWrites: [], blockedReads: [], fixtureReads: [], providerCalls: 0 };
  const passiveReads = new Set(['/api/version', '/api/member-permissions', '/api/user/assets', '/api/user/transactions', '/api/media-history', '/api/video/history', '/api/video/models', '/api/settings/video-page', '/api/cash/balance', '/api/settings', '/api/settings/appearance', '/api/settings/layout', '/api/settings/ui-preferences', '/api/announcements/inbox', '/api/announcements', '/api/notifications/user', '/api/avatars', '/api/product-usage/events']);
  let browser;
  const check = (name, passed) => { report.checks.push({ name, passed }); assert.ok(passed, name); };
  try {
    const identityResponse = await fetch(origin + '/api/auth/me', { headers, signal: AbortSignal.timeout(15000) });
    const identity = await identityResponse.json();
    const wrapperIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER || '{}');
    check('ordinary-member-identity', identityResponse.ok && identity.user?.role === 'student' && identity.user.id === wrapperIdentity.id && identity.user.id !== '00000000-0000-0000-0000-000000000001');
    report.role = identity.user.role;
    report.version = await (await fetch(origin + '/api/version')).json();
    const denied = await fetch(origin + '/api/admin/video-models', { headers, signal: AbortSignal.timeout(15000) });
    check('admin-catalog-denied', [401,403,404].includes(denied.status));
    const other = await fetch(origin + '/api/credits?user_id=00000000-0000-0000-0000-000000000001&include_transactions=0', { headers, signal: AbortSignal.timeout(15000) });
    check('other-account-credits-denied', [400,403,404].includes(other.status));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: 'block' });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
    }, { token, user: identity.user });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (!['GET','HEAD','OPTIONS'].includes(req.method())) {
        report.blockedWrites.push({ path: url.pathname, method: req.method() });
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"READ_ONLY_ACCEPTANCE"}' });
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/auth/me') {
        report.fixtureReads.push(url.pathname);
        return route.fulfill({ status: 200, json: { success: true, user: identity.user } });
      }
      if (url.pathname === '/api/credits') {
        report.fixtureReads.push(url.pathname);
        return route.fulfill({ status: 200, json: { credits: 0, reservedCredits: 0, cashBalance: 0, transactions: [], fixtureOnly: true } });
      }
      if (url.pathname === '/api/video/active-tasks') {
        report.fixtureReads.push(url.pathname);
        return route.fulfill({ status: 200, json: { activeTasks: [], recentlyCompleted: [], fixtureOnly: true } });
      }
      if (url.pathname === '/api/conversations/history') {
        report.fixtureReads.push(url.pathname);
        return route.fulfill({ status: 200, json: { conversations: [], messages: [], fixtureOnly: true } });
      }
      if (url.pathname.startsWith('/api/video/thumbnail/') || url.pathname === '/api/media-history/content') {
        report.fixtureReads.push(url.pathname === '/api/media-history/content' ? url.pathname : '/api/video/thumbnail/:id');
        return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64') });
      }
      if (url.pathname.startsWith('/api/') && !passiveReads.has(url.pathname) && !url.pathname.startsWith('/api/branding/assets/')) {
        report.blockedReads.push(url.pathname);
        return route.abort();
      }
      if ((['/api/video/models', '/api/video/history'].includes(url.pathname) && url.searchParams.get('surface') !== 'video-page') || (url.pathname.startsWith('/api/announcements') && url.searchParams.has('admin'))) {
        report.blockedReads.push(url.pathname);
        return route.abort();
      }
      if (!url.pathname.startsWith('/api/') && !['/profile', '/media-history', '/video'].includes(url.pathname) && !url.pathname.startsWith('/_next/static/')) {
        const publicRoot = path.resolve('public'), publicFile = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
        const relative = path.relative(publicRoot, publicFile);
        const safeFile = relative && !relative.startsWith('..') && !path.isAbsolute(relative) && await lstat(publicFile).then(info => info.isFile() && !info.isSymbolicLink()).catch(() => false);
        const physicalFile = safeFile && path.relative(publicRoot, await realpath(publicFile));
        if (!physicalFile || physicalFile.startsWith('..') || path.isAbsolute(physicalFile)) return route.abort();
      }
      return route.fulfill({ response: await route.fetch({ maxRedirects: 0, maxRetries: 0 }) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.name));
    page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) report.requests.push({ path: url.pathname, status: response.status() }); });
    for (const route of ['/profile', '/media-history', '/video']) {
      const response = await page.goto(origin + route, { waitUntil: 'networkidle' });
      check(`${route}-page-ok`, response.ok() && new URL(page.url()).pathname === route);
      if (route === '/profile') {
        await page.getByTestId('profile-identity-card').waitFor();
        const transactionResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/user/transactions');
        await page.getByTestId('profile-tab-navigation').getByRole('button', { name: '充值与消费记录', exact: true }).click();
        check('transactions-read', (await transactionResponse).ok());
        await page.getByTestId('profile-tab-navigation').getByRole('button', { name: '总览', exact: true }).click();
      }
      report.pages.push({ route, currentPath: new URL(page.url()).pathname, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) });
    }
    check('assets-read', report.requests.some(row => row.path === '/api/user/assets' && row.status === 200));
    check('credits-read-isolated-in-ram', report.fixtureReads.includes('/api/credits'));
    check('history-read', report.requests.some(row => row.path === '/api/media-history' && row.status === 200));
    check('no-page-errors-or-overflow', report.errors.length === 0 && report.pages.every(row => !row.overflow));
    check('no-business-write-attempts', report.blockedWrites.every(row => ['/api/announcements/events', '/api/diagnostic-logs', '/api/operation-events'].includes(row.path)));
    check('no-unreviewed-api-reads', report.blockedReads.length === 0);
    report.passed = true;
  } catch (error) { report.passed = false; report.failureCode = error.code || error.name; process.exitCode = 1; }
  finally {
    await browser?.close();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failureCode: report.failureCode, errors: report.errors, blockedWrites: report.blockedWrites }));
  }
}
