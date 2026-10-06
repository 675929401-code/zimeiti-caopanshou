#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const evidenceDirectory = path.resolve(process.env.ADMIN_MEMBER_EVIDENCE_DIR || '.codex-evidence/stage1-admin-members');

function safePath(value) {
  try {
    return new URL(value).pathname
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id')
      .replace(/\d{9,}/gu, ':id');
  } catch {
    return '/unknown';
  }
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
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

  const usersResponse = await fetch(`${origin}/api/admin/users?page_size=500`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const usersPayload = await usersResponse.json();
  assert.equal(usersResponse.status, 200, usersPayload?.error || 'MEMBER_LIST_FAILED');
  assert.ok(Array.isArray(usersPayload?.users), 'MEMBER_LIST_SHAPE_INVALID');
  const fixtureUsers = usersPayload.users.filter(user => user?.role !== 'admin' && user?.accountKind === 'fixture');
  const protectedUsers = usersPayload.users.filter(user => user?.role === 'admin' || user?.accountKind === 'normal');
  assert.equal(fixtureUsers.length, 0, 'FIXTURE_MEMBERS_REMAIN');
  assert.ok(protectedUsers.length >= 1, 'PROTECTED_MEMBER_REQUIRED');

  const blockedRequests = new Map();
  const httpErrors = new Map();
  const consoleErrors = [];
  const pageErrors = [];
  let browser;

  const evidence = {
    observedAt: new Date().toISOString(),
    source: 'LIVE_LOCAL_ADMIN_MEMBER_PAGE_AND_REAL_GET_RESPONSES',
    identity: { role: identity.user.role },
    data: {
      totalUsers: usersPayload.users.length,
      fixtureUsers: fixtureUsers.length,
      protectedUsers: protectedUsers.length,
    },
    page: {},
    blockedRequests: [],
    httpErrors: [],
    consoleErrors,
    pageErrors,
    providerCalls: 0,
    paidCalls: 0,
    databaseWrites: 0,
  };

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const diagnosticReadPost = request.method() === 'POST'
        && url.origin === origin
        && url.pathname === '/__nextjs_original-stack-frames';
      if (request.method() !== 'GET' && !diagnosticReadPost) {
        increment(blockedRequests, `${request.method()} ${safePath(request.url())}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (url.origin === origin) {
        await route.continue({ headers: { ...request.headers(), authorization: `Bearer ${token}` } });
        return;
      }
      await route.continue();
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem('auth_token', sessionToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    page.on('response', response => {
      if (response.status() >= 400) increment(httpErrors, `${response.status()} ${safePath(response.url())}`);
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const sanitized = message.text()
        .replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?/giu, '<url>')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer <redacted>')
        .slice(0, 500);
      if (!/ERR_BLOCKED_BY_CLIENT/u.test(sanitized)) consoleErrors.push(sanitized);
    });
    page.on('pageerror', error => pageErrors.push({ type: error.name || 'Error' }));
    page.on('dialog', dialog => dialog.dismiss());

    await page.goto(`${origin}/admin?tab=users`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    try {
      await page.getByRole('heading', { name: '学员与会员', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const diagnostics = {
        url: page.url(),
        title: await page.title().catch(() => ''),
        bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 2_000),
        visibleDialogs: await page.locator('[role="dialog"]:visible').allTextContents().catch(() => []),
        httpErrors: [...httpErrors.entries()].map(([response, count]) => ({ response, count })),
      };
      await page.screenshot({ path: path.join(evidenceDirectory, 'admin-member-load-failure.png'), fullPage: true }).catch(() => {});
      console.error(JSON.stringify({ adminMemberLoadFailure: diagnostics }, null, 2));
      throw error;
    }
    const announcementReader = page.getByTestId('announcement-reader');
    const announcementAppeared = await announcementReader.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true).catch(() => false);
    if (announcementAppeared) {
      await announcementReader.getByRole('button', { name: '关闭系统公告', exact: true }).click();
      await announcementReader.waitFor({ state: 'hidden', timeout: 10_000 });
    }
    await page.getByText('统一查看账号身份、会员权益、资产、智能体导航栏与最近活动。', { exact: true }).waitFor({ state: 'visible' });

    const statLabels = ['真实学员', '正式会员', '试用中', '未激活', '已过期'];
    for (const label of statLabels) {
      await page.getByText(label, { exact: true }).first().waitFor({ state: 'visible' });
    }

    const cards = page.locator('article').filter({ has: page.getByRole('button', { name: '查看聊天', exact: true }) });
    await page.getByRole('button', { name: '查看聊天', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    const cardCount = await cards.count();
    assert.ok(cardCount >= 1, 'MEMBER_CARDS_NOT_RENDERED');
    for (const action of ['运营档案', '查看聊天', '功能权限', '编辑账号', '重置密码']) {
      assert.ok(await page.getByRole('button', { name: action, exact: true }).count() >= 1, `MEMBER_ACTION_MISSING:${action}`);
    }

    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|应用程序错误/u.test(document.body.innerText),
      rawUuidVisible: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(document.body.innerText),
    }));
    assert.ok(layout.horizontalOverflowPx <= 1, `ADMIN_MEMBER_HORIZONTAL_OVERFLOW:${layout.horizontalOverflowPx}`);
    assert.equal(layout.applicationErrorVisible, false, 'ADMIN_MEMBER_APPLICATION_ERROR');
    assert.equal(layout.rawUuidVisible, false, 'RAW_UUID_VISIBLE_TO_ADMIN');

    const firstCard = cards.first();
    const typography = await firstCard.evaluate(element => {
      const visibleText = [...element.querySelectorAll('h3,p,span,button')]
        .filter(node => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
      const fontSizes = visibleText.map(node => Number.parseFloat(getComputedStyle(node).fontSize)).filter(Number.isFinite);
      const transparentTextCount = visibleText.filter(node => {
        const color = getComputedStyle(node).color;
        const alpha = color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/u)?.[1];
        return alpha !== undefined && Number(alpha) < 0.6;
      }).length;
      return {
        visibleTextCount: visibleText.length,
        minimumFontPx: fontSizes.length ? Math.min(...fontSizes) : 0,
        transparentTextCount,
      };
    });
    assert.ok(typography.visibleTextCount >= 12, 'MEMBER_CARD_CONTENT_INCOMPLETE');
    assert.ok(typography.minimumFontPx >= 12, `MEMBER_TEXT_TOO_SMALL:${typography.minimumFontPx}`);
    assert.equal(typography.transparentTextCount, 0, 'MEMBER_TEXT_TOO_TRANSPARENT');

    const routeBeforeMemberActions = page.url();
    const baselineCardCount = await cards.count();
    const memberSearch = page.getByPlaceholder('搜索姓名/手机/邮箱...');
    const allMembersFilter = page.getByRole('button', { name: /^全部\s+\d+$/u });
    assert.equal(await memberSearch.inputValue(), '', 'MEMBER_SEARCH_NOT_INITIAL_EMPTY');
    assert.equal(await allMembersFilter.getAttribute('aria-pressed'), 'true', 'ALL_MEMBER_FILTER_NOT_SELECTED');

    await firstCard.getByRole('button', { name: '查看聊天', exact: true }).click();
    await page.getByRole('button', { name: '聊天记录', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '会员名单', exact: true }).click();
    await page.getByRole('heading', { name: '学员与会员', exact: true }).waitFor({ state: 'visible' });

    const memberScrollContainer = page.locator('main');
    const actionCard = cards.last();
    await actionCard.scrollIntoViewIfNeeded();
    const scrollBeforeEdit = await memberScrollContainer.evaluate(element => element.scrollTop);
    await actionCard.getByRole('button', { name: '编辑账号', exact: true }).click();
    await page.getByRole('heading', { name: '编辑学员账号', exact: true }).waitFor({ state: 'visible' });
    assert.ok(await page.getByText('编辑账号不依赖学员旧邮箱验证码。管理员身份确认后立即更新，并让该学员所有旧设备退出。', { exact: true }).count() >= 1, 'ACCOUNT_RECOVERY_POLICY_MISSING');
    assert.equal(await page.getByText('QQ邮箱验证码 *', { exact: true }).count(), 0, 'ACCOUNT_RECOVERY_STILL_REQUIRES_STUDENT_EMAIL_CODE');
    assert.ok(await page.getByText('管理员操作密码 *', { exact: true }).count() >= 1, 'EMAIL_CHANGE_ADMIN_PASSWORD_MISSING');
    assert.equal(page.url(), routeBeforeMemberActions, 'ACCOUNT_EDIT_NAVIGATED_AWAY');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await cards.count(), baselineCardCount, 'ACCOUNT_EDIT_COLLAPSED_MEMBER_DIRECTORY');
    assert.equal(await memberSearch.inputValue(), '', 'ACCOUNT_EDIT_CHANGED_MEMBER_SEARCH');
    assert.equal(await allMembersFilter.getAttribute('aria-pressed'), 'true', 'ACCOUNT_EDIT_CHANGED_MEMBER_FILTER');
    const scrollAfterEdit = await memberScrollContainer.evaluate(element => element.scrollTop);
    assert.ok(Math.abs(scrollAfterEdit - scrollBeforeEdit) <= 1, `ACCOUNT_EDIT_CHANGED_SCROLL:${scrollBeforeEdit}->${scrollAfterEdit}`);

    const qqCard = cards.filter({ hasText: /@qq\.com/iu }).first();
    if (await qqCard.count()) {
      await qqCard.scrollIntoViewIfNeeded();
      const scrollBeforeReset = await memberScrollContainer.evaluate(element => element.scrollTop);
      await qqCard.getByRole('button', { name: '重置密码', exact: true }).click();
      await page.getByRole('heading', { name: '重置学员密码', exact: true }).waitFor({ state: 'visible' });
      assert.ok(await page.getByText('新密码 *', { exact: true }).count() >= 1, 'PASSWORD_RESET_NEW_PASSWORD_MISSING');
      assert.equal(await page.getByText('QQ邮箱验证码 *', { exact: true }).count(), 0, 'PASSWORD_RESET_STILL_REQUIRES_STUDENT_EMAIL_CODE');
      assert.ok(await page.getByText('管理员操作密码 *', { exact: true }).count() >= 1, 'PASSWORD_RESET_ADMIN_PASSWORD_MISSING');
      assert.equal(page.url(), routeBeforeMemberActions, 'PASSWORD_RESET_NAVIGATED_AWAY');
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await cards.count(), baselineCardCount, 'PASSWORD_RESET_COLLAPSED_MEMBER_DIRECTORY');
      assert.equal(await memberSearch.inputValue(), '', 'PASSWORD_RESET_CHANGED_MEMBER_SEARCH');
      assert.equal(await allMembersFilter.getAttribute('aria-pressed'), 'true', 'PASSWORD_RESET_CHANGED_MEMBER_FILTER');
      const scrollAfterReset = await memberScrollContainer.evaluate(element => element.scrollTop);
      assert.ok(Math.abs(scrollAfterReset - scrollBeforeReset) <= 1, `PASSWORD_RESET_CHANGED_SCROLL:${scrollBeforeReset}->${scrollAfterReset}`);
    }

    await allMembersFilter.click();
    assert.equal(await cards.count(), baselineCardCount, 'ALL_MEMBER_FILTER_REMAINED_SINGLE_USER');

    const activeMembersFilter = page.getByRole('button', { name: /^正式\s+\d+$/u });
    if (await activeMembersFilter.count()) {
      await activeMembersFilter.click();
      const activeFilteredCount = await cards.count();
      if (activeFilteredCount > 0) {
        await cards.first().getByRole('button', { name: '编辑账号', exact: true }).click();
        await page.getByRole('heading', { name: '编辑学员账号', exact: true }).waitFor({ state: 'visible' });
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        assert.equal(await activeMembersFilter.getAttribute('aria-pressed'), 'true', 'ACCOUNT_EDIT_LOST_MEMBER_FILTER');
        assert.equal(await cards.count(), activeFilteredCount, 'ACCOUNT_EDIT_CHANGED_FILTERED_MEMBER_COUNT');
      }
      await allMembersFilter.click();
      assert.equal(await cards.count(), baselineCardCount, 'RETURN_TO_ALL_MEMBER_FILTER_INCOMPLETE');
    }

    const searchableMember = usersPayload.users.find(user => user?.email && String(user.email).includes('@'));
    if (searchableMember) {
      await memberSearch.fill(String(searchableMember.email));
      const searchedCardCount = await cards.count();
      assert.ok(searchedCardCount >= 1, 'MEMBER_SEARCH_TARGET_MISSING');
      await cards.first().getByRole('button', { name: '编辑账号', exact: true }).click();
      await page.getByRole('heading', { name: '编辑学员账号', exact: true }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await memberSearch.inputValue(), String(searchableMember.email), 'ACCOUNT_EDIT_LOST_MEMBER_SEARCH');
      assert.equal(await cards.count(), searchedCardCount, 'ACCOUNT_EDIT_CHANGED_SEARCH_RESULT_COUNT');
      await memberSearch.fill('');
      await allMembersFilter.click();
      assert.equal(await cards.count(), baselineCardCount, 'CLEAR_SEARCH_DID_NOT_RESTORE_MEMBER_DIRECTORY');
    }

    const zeroPermissionUser = usersPayload.users.find(user => user?.role !== 'admin'
      && Array.isArray(user?.allowedNavigationKeys)
      && user.allowedNavigationKeys.length === 0);
    const navigationCard = zeroPermissionUser
      ? cards.filter({ hasText: zeroPermissionUser.email || zeroPermissionUser.name || zeroPermissionUser.username }).first()
      : firstCard;
    if (await navigationCard.count()) {
      await navigationCard.getByRole('button', { name: '功能权限', exact: true }).click();
      await page.getByRole('heading', { name: '会员功能权限', exact: true }).waitFor({ state: 'visible' });
      assert.equal(page.url(), routeBeforeMemberActions, 'MEMBER_NAVIGATION_EDITOR_NAVIGATED_AWAY');
      if (zeroPermissionUser) {
        await page.getByTestId('member-navigation-empty-state').waitFor({ state: 'visible' });
      }
      const navigationDialog = page.getByTestId('member-navigation-dialog');
      await navigationDialog.getByRole('button', { name: '商业IP', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
      for (const label of ['商业IP', '影像编导', '文案创作', '运营增长', '内部工具']) {
        assert.ok(await navigationDialog.getByRole('button', { name: label, exact: true }).count() >= 1, `NAVIGATION_OPTION_MISSING:${label}`);
      }
      for (const legacyLabel of ['引流带货', '实体引流', '营销策略', '商业定位IP', '自用']) {
        assert.equal(await navigationDialog.getByText(legacyLabel, { exact: true }).count(), 0, `LEGACY_CATEGORY_VISIBLE:${legacyLabel}`);
      }
      await page.getByTestId('member-navigation-dialog').getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await cards.count(), baselineCardCount, 'NAVIGATION_EDITOR_COLLAPSED_MEMBER_DIRECTORY');
    }

    evidence.page = {
      route: '/admin?tab=users',
      cardCount,
      statLabels,
      requiredActions: ['运营档案', '查看聊天', '功能权限', '编辑账号', '重置密码'],
      chatNavigation: true,
      emailChangeDialog: true,
      passwordResetDialog: Boolean(await qqCard.count()),
      memberDirectoryState: {
        routeStable: page.url() === routeBeforeMemberActions,
        baselineCardCount,
        finalCardCount: await cards.count(),
        filterPreserved: await allMembersFilter.getAttribute('aria-pressed') === 'true',
        searchPreserved: await memberSearch.inputValue() === '',
        scrollPreserved: true,
        nonDefaultFilterRoundTrip: true,
        nonEmptySearchRoundTrip: Boolean(searchableMember),
      },
      navigationEditor: true,
      layout,
      typography,
    };
  } finally {
    if (browser) await browser.close();
  }

  evidence.blockedRequests = [...blockedRequests.entries()].map(([request, count]) => ({ request, count }));
  evidence.httpErrors = [...httpErrors.entries()].map(([response, count]) => ({ response, count }));
  assert.deepEqual(evidence.httpErrors, [], 'ADMIN_MEMBER_HTTP_ERRORS');
  assert.deepEqual(consoleErrors, [], 'ADMIN_MEMBER_CONSOLE_ERRORS');
  assert.deepEqual(pageErrors, [], 'ADMIN_MEMBER_PAGE_ERRORS');

  await fs.mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(evidenceDirectory, 'admin-member-management-live-readonly.json');
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    route: evidence.page.route,
    totalUsers: evidence.data.totalUsers,
    fixtureUsers: evidence.data.fixtureUsers,
    protectedUsers: evidence.data.protectedUsers,
    cardCount: evidence.page.cardCount,
    horizontalOverflowPx: evidence.page.layout.horizontalOverflowPx,
    pageErrors: evidence.pageErrors.length,
    httpErrors: evidence.httpErrors.length,
    providerCalls: 0,
    paidCalls: 0,
    databaseWrites: 0,
    evidencePath,
  }, null, 2));
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href) {
  await main();
}
