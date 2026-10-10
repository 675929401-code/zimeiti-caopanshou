#!/usr/bin/env node
import assert from 'node:assert/strict';
import process from 'node:process';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();

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

  const blockedWrites = [];
  const pageErrors = [];
  const consoleErrors = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.addCookies([{
      name: 'auth_token',
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    }]);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const nextDiagnostic = request.method() === 'POST'
        && url.origin === origin
        && url.pathname === '/__nextjs_original-stack-frames';
      if (request.method() !== 'GET' && !nextDiagnostic) {
        blockedWrites.push(`${request.method()} ${url.pathname}`);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem('auth_token', sessionToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
      sessionStorage.setItem('app_state_admin_activeTab', JSON.stringify('manju-workbench'));
      sessionStorage.setItem('app_state_admin_userSubTab', JSON.stringify('chats'));
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.name || 'Error'));
    page.on('console', message => {
      if (message.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });

    await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByRole('heading', { name: '学员与会员', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'users', 'NAKED_ADMIN_MUST_CANONICALIZE_TO_USERS');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('app_state_admin_activeTab')), null, 'LEGACY_ADMIN_TAB_CACHE_NOT_CLEARED');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('app_state_admin_userSubTab')), null, 'LEGACY_MEMBER_SUBTAB_CACHE_NOT_CLEARED');
    assert.equal(await page.getByRole('button', { name: '会员名单', exact: true }).getAttribute('aria-current'), 'page');

    const nav = page.getByRole('navigation', { name: '管理后台功能导航' });
    await nav.waitFor({ state: 'visible' });
    for (const group of ['学员与经营', '内容与模型', '平台与界面', '安全与数据']) {
      await nav.getByRole('heading', { name: group, exact: true }).waitFor({ state: 'visible' });
    }
    assert.equal(await page.getByRole('button', { name: '漫剧后台', exact: true }).count(), 0, 'INDEPENDENT_MANJU_HEADER_ENTRY_REMAINS');
    assert.equal(await nav.getByRole('button', { name: '漫剧工作台', exact: true }).count(), 0, 'DUPLICATE_MANJU_GLOBAL_NAV_ENTRY_REMAINS');
    assert.equal(await nav.getByRole('button', { name: '工作台配置', exact: true }).count(), 1, 'WORKSPACE_CONFIG_GLOBAL_NAV_ENTRY_INVALID');
    assert.equal(await page.getByRole('button', { name: '部署到线上', exact: true }).count(), 0, 'DEAD_GLOBAL_DEPLOY_ACTION_REMAINS');
    assert.equal(await nav.getByRole('button', { name: '学员管理', exact: true }).getAttribute('aria-current'), 'page');

    await nav.getByRole('button', { name: '模型资源池', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('tab') === 'models');
    assert.equal(await nav.getByRole('button', { name: '模型资源池', exact: true }).getAttribute('aria-current'), 'page');
    await nav.getByRole('button', { name: '学员管理', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('tab') === 'users');
    assert.equal(await page.getByRole('button', { name: '会员名单', exact: true }).getAttribute('aria-current'), 'page');

    await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByRole('heading', { name: '学员与会员', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'users', 'OLD_TAB_MUST_NOT_RECLAIM_NAKED_ADMIN');

    await page.goto(`${origin}/admin?tab=manju-workbench`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForURL(url => url.searchParams.get('tab') === 'workspace-models' && url.searchParams.get('project') === 'manju');
    await page.locator('[data-workspace-project="manju"]').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await nav.getByRole('button', { name: '工作台配置', exact: true }).getAttribute('aria-current'), 'page', 'LEGACY_MANJU_ROUTE_NOT_MIGRATED');

    await page.goto(`${origin}/admin?tab=digital-human`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForURL(url => url.searchParams.get('tab') === 'workspace-models' && url.searchParams.get('project') === 'video');
    await page.locator('[data-workspace-project="video"]').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.locator('[data-workspace-project-button="digital-human"]').count(), 0, 'RETIRED_DIGITAL_HUMAN_PROJECT_REMAINS');

    await page.goto(`${origin}/admin?tab=workspace-models&project=digital-human`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForURL(url => url.searchParams.get('tab') === 'workspace-models' && url.searchParams.get('project') === 'video');
    await page.locator('[data-workspace-project="video"]').waitFor({ state: 'visible', timeout: 30_000 });

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileNav = page.getByRole('navigation', { name: '移动端管理后台功能导航' });
    await mobileNav.waitFor({ state: 'visible' });
    const layout = await mobileNav.evaluate(element => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      viewport: window.innerWidth,
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      minimumNavFont: Math.min(...[...element.querySelectorAll('button')].map(node => Number.parseFloat(getComputedStyle(node).fontSize))),
    }));
    assert.ok(layout.left >= -1 && layout.right <= layout.viewport + 1, `ADMIN_NAV_OUTSIDE_VIEWPORT:${JSON.stringify(layout)}`);
    assert.ok(layout.pageOverflow <= 1, `ADMIN_PAGE_HORIZONTAL_OVERFLOW:${layout.pageOverflow}`);
    assert.ok(layout.minimumNavFont >= 14, `ADMIN_NAV_FONT_TOO_SMALL:${layout.minimumNavFont}`);

    assert.deepEqual(pageErrors, [], 'ADMIN_NAV_PAGE_ERRORS');
    assert.deepEqual(consoleErrors, [], 'ADMIN_NAV_CONSOLE_ERRORS');
    console.log(JSON.stringify({
      passed: true,
      defaultRoute: '/admin?tab=users',
      legacyStoredTabIgnored: true,
      explicitTabsRespected: ['models', 'legacy-manju-to-workspace', 'retired-digital-human-to-video'],
      groupedNavigation: true,
      responsiveLayout: layout,
      blockedWrites: blockedWrites.length,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href) {
  await main();
}
