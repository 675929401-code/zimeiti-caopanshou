#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const evidenceDirectory = path.resolve(process.env.ADMIN_MEMBER_DELETE_EVIDENCE_DIR || '.codex-evidence/stage1-admin-member-delete');

function fixtureUser(id, name, email, cashBalance) {
  return {
    id,
    name,
    username: name,
    phone: '',
    email,
    role: 'student',
    credits: 0,
    cashBalance,
    memberStatus: 'trial',
    status: 'suspended',
    isActive: false,
    createdAt: '2026-09-01T08:00:00.000Z',
    allowedCategories: null,
    accountKind: 'fixture',
    accountFlags: { isFixture: true, label: '测试/验收账号', reasons: ['browser regression fixture'] },
    accountFlagReasons: ['browser regression fixture'],
  };
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, 'LOCAL_ONLY_ORIGIN_REQUIRED');
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');

  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const identity = await identityResponse.json();
  assert.equal(identityResponse.status, 200, identity?.error || 'ADMIN_IDENTITY_FAILED');
  assert.equal(identity?.user?.role, 'admin', 'ADMIN_ROLE_REQUIRED');

  const adminUser = {
    id: identity.user.id,
    name: identity.user.displayName || identity.user.username || '本地管理员',
    username: identity.user.username || 'admin',
    phone: '',
    email: identity.user.email || '675929401@qq.com',
    role: 'admin',
    credits: 5000,
    cashBalance: 250,
    memberStatus: 'active',
    status: 'active',
    isActive: true,
    createdAt: '2026-05-25T00:00:00.000Z',
    allowedCategories: null,
    accountKind: 'normal',
    accountFlags: { isFixture: false, label: null, reasons: [] },
    accountFlagReasons: [],
  };
  let users = [
    adminUser,
    fixtureUser('11111111-1111-4111-8111-111111111111', '测试删除甲', '', 0.48),
    fixtureUser('22222222-2222-4222-8222-222222222222', '测试删除乙', '', 0.18),
    fixtureUser('33333333-3333-4333-8333-333333333333', '测试保留丙', '', 0),
  ];
  let passwordVerificationCount = 0;
  let deleteCount = 0;
  let usersGetCount = 0;
  let unexpectedWrites = 0;
  const deletionToken = 'fixture-admin-user-delete-reauth';
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === '/api/admin/users') {
        if (request.method() === 'GET') {
          usersGetCount += 1;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ users, totalCount: users.length, page: 1, pageSize: 100 }),
          });
          return;
        }
        if (request.method() === 'DELETE') {
          assert.equal(request.headers()['x-admin-user-delete-reauth'], deletionToken, 'DELETE_REAUTH_HEADER_MISSING');
          const userId = url.searchParams.get('id');
          assert.ok(userId && users.some(user => user.id === userId && user.role !== 'admin'), 'DELETE_TARGET_INVALID');
          users = users.filter(user => user.id !== userId);
          deleteCount += 1;
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
          return;
        }
      }
      if (url.origin === origin && url.pathname === '/api/auth/verify-password' && request.method() === 'POST') {
        const body = request.postDataJSON();
        assert.equal(body.purpose, 'admin_user_delete', 'DELETE_REAUTH_PURPOSE_MISSING');
        assert.equal(body.password, 'regression-password');
        passwordVerificationCount += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            deletionVerification: {
              token: deletionToken,
              expiresAt: Date.now() + 10 * 60 * 1000,
              expiresInSeconds: 600,
            },
          }),
        });
        return;
      }
      if (
        url.origin === origin
        && request.method() !== 'GET'
        && !(request.method() === 'POST' && url.pathname === '/__nextjs_original-stack-frames')
      ) {
        unexpectedWrites += 1;
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem('auth_token', sessionToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      localStorage.setItem('admin_activeTab', JSON.stringify('users'));
      localStorage.setItem('admin_userSubTab', JSON.stringify('members'));
      sessionStorage.setItem('entered_app', '1');
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/admin?tab=users`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByText('测试删除甲', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });

    const search = page.getByPlaceholder('搜索姓名/手机/邮箱...');
    await search.fill('测试删除甲');
    await page.getByText('测试删除乙', { exact: true }).waitFor({ state: 'hidden' });
    const firstCard = page.locator('article').filter({ hasText: '测试删除甲' });
    await firstCard.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByPlaceholder('请输入管理员登录密码或操作密码').fill('regression-password');
    await page.getByRole('button', { name: '确认', exact: true }).click();

    await page.getByText('测试删除甲', { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 });
    await page.getByText('测试删除乙', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('测试保留丙', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await search.inputValue(), '', 'SEARCH_MUST_RESET_AFTER_DELETE');
    assert.equal(passwordVerificationCount, 1, 'FIRST_DELETE_MUST_VERIFY_PASSWORD_ONCE');
    assert.equal(deleteCount, 1, 'FIRST_DELETE_NOT_COMPLETED');

    page.once('dialog', dialog => dialog.accept());
    const secondCard = page.locator('article').filter({ hasText: '测试删除乙' });
    await secondCard.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('测试删除乙', { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 });
    await page.getByText('测试保留丙', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });

    assert.equal(passwordVerificationCount, 1, 'SECOND_DELETE_MUST_REUSE_CURRENT_PAGE_VERIFICATION');
    assert.equal(deleteCount, 2, 'SECOND_DELETE_NOT_COMPLETED');
    assert.ok(usersGetCount >= 3, 'AUTHORITATIVE_MEMBER_REFRESH_MISSING');
    assert.equal(unexpectedWrites, 0, 'UNEXPECTED_BROWSER_WRITES');
    assert.deepEqual(pageErrors, [], 'ADMIN_MEMBER_DELETE_PAGE_ERRORS');

    const evidence = {
      observedAt: new Date().toISOString(),
      source: 'LOCAL_BROWSER_WITH_INTERCEPTED_MEMBER_FIXTURES',
      route: '/admin?tab=users',
      passwordVerificationCount,
      deleteCount,
      usersGetCount,
      remainingVisibleUser: '测试保留丙',
      searchResetAfterDelete: true,
      secondDeleteReusedVerification: true,
      realDatabaseWrites: 0,
      paidCalls: 0,
      providerCalls: 0,
      pageErrors,
    };
    await fs.mkdir(evidenceDirectory, { recursive: true });
    const evidencePath = path.join(evidenceDirectory, 'admin-member-delete-live-mocked.json');
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, ...evidence, evidencePath }, null, 2));
  } finally {
    await browser.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href) {
  await main();
}
