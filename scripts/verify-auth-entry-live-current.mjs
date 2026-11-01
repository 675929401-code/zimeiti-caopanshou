#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_APP_ORIGIN || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
assert.equal(origin, 'http://127.0.0.1:5000', 'LOCAL_PREVIEW_ORIGIN_REQUIRED');

const outputDir = path.resolve('.codex-evidence/auth-entry-live-current');
const viewports = [
  { name: '1440x900', width: 1440, height: 900, theme: 'lattice', mode: 'dark' },
  { name: '1920x1080', width: 1920, height: 1080, theme: 'soft-white', mode: 'light' },
];
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  viewports: [],
  writes: [],
  externalRequests: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
};

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await context.addInitScript(({ theme, mode }) => {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      localStorage.setItem('user_theme_preference', theme);
      localStorage.setItem('user_theme_mode_preference', mode);
      localStorage.setItem('user_theme_preference_expires_at', new Date(Date.now() + 60_000).toISOString());
      sessionStorage.removeItem('entered_app');
    }, { theme: viewport.theme, mode: viewport.mode });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        report.externalRequests.push({ viewport: viewport.name, method: request.method(), url: request.url() });
        await route.abort('blockedbyclient');
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        report.writes.push({ viewport: viewport.name, method: request.method(), path: url.pathname });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push({ viewport: viewport.name, message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) {
        report.consoleErrors.push({ viewport: viewport.name, message: message.text().slice(0, 400) });
      }
    });
    page.on('response', response => {
      if (response.status() >= 500) {
        report.serverErrors.push({ viewport: viewport.name, status: response.status(), path: new URL(response.url()).pathname });
      }
    });

    const rootResponse = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    assert.equal(rootResponse?.status(), 200);
    await page.getByTestId('soft-white-premium-home').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.locator('html').getAttribute('data-theme-selection'), viewport.theme, 'PUBLIC_HOME_THEME_MISMATCH');
    await page.locator('.swh-login-button').first().click();
    const drawer = page.locator('.swh-login-drawer[role="dialog"]');
    await drawer.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.locator('html').getAttribute('data-theme-selection'), viewport.theme, 'LOGIN_DRAWER_THEME_MISMATCH');
    const labelledBy = await drawer.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'LOGIN_DRAWER_ACCESSIBLE_NAME_MISSING');
    assert.ok((await page.locator(`#${labelledBy}`).innerText()).trim().length > 0, 'LOGIN_DRAWER_TITLE_EMPTY');
    await drawer.getByRole('tab', { name: '账号登录', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.deepEqual(
      await drawer.getByRole('tab').allTextContents(),
      ['账号登录', '邮箱登录', '注册'],
      'LOGIN_TABS_MISMATCH',
    );
    assert.equal(await drawer.locator('.login-form-footer').count(), 0, 'REGISTRATION_TERMS_VISIBLE_ON_ACCOUNT_LOGIN');

    const loginPassword = drawer.locator('#login-password');
    const loginToggle = drawer.locator('[aria-controls="login-password"]');
    assert.equal(await loginPassword.getAttribute('type'), 'password');
    await loginToggle.click();
    assert.equal(await loginPassword.getAttribute('type'), 'text');
    assert.equal(await loginToggle.getAttribute('aria-label'), '隐藏密码');
    await loginToggle.click();
    assert.equal(await loginPassword.getAttribute('type'), 'password');

    await drawer.getByRole('tab', { name: '邮箱登录', exact: true }).click();
    await drawer.getByPlaceholder('请输入注册邮箱').waitFor({ state: 'visible' });
    await drawer.getByRole('button', { name: '获取验证码', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await drawer.locator('.login-form-footer').count(), 0, 'REGISTRATION_TERMS_VISIBLE_ON_EMAIL_LOGIN');
    await drawer.getByRole('tab', { name: '注册', exact: true }).click();
    for (const placeholder of [
      '例如 123456789@qq.com',
      '6位验证码',
      '请输入11位手机号',
      '至少8位，包含字母和数字',
      '请输入邀请码（联系现有学员获取）',
    ]) {
      await drawer.getByPlaceholder(placeholder).waitFor({ state: 'visible' });
    }
    const registerPassword = drawer.locator('#register-password');
    const registerToggle = drawer.locator('[aria-controls="register-password"]');
    assert.equal(await registerPassword.getAttribute('type'), 'password');
    await registerToggle.click();
    assert.equal(await registerPassword.getAttribute('type'), 'text');
    await registerToggle.click();
    assert.equal(await registerPassword.getAttribute('type'), 'password');

    const registrationTerms = drawer.locator('.login-form-footer');
    await registrationTerms.waitFor({ state: 'visible' });
    assert.match(await registrationTerms.innerText(), /注册即表示同意平台使用条款/u);
    const termsPlacement = await registrationTerms.evaluate(node => {
      const termsRect = node.getBoundingClientRect();
      const form = node.closest('form');
      const panel = node.closest('.login-panel');
      const submit = form?.querySelector('button[type="submit"]');
      const submitRect = submit?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      return {
        insideRegistrationForm: Boolean(form),
        immediatelyAfterSubmit: node.previousElementSibling === submit,
        gapBelowSubmit: submitRect ? termsRect.top - submitRect.bottom : null,
        insideLoginPanel: panelRect
          ? termsRect.left >= panelRect.left && termsRect.right <= panelRect.right && termsRect.bottom <= panelRect.bottom
          : false,
      };
    });
    assert.equal(termsPlacement.insideRegistrationForm, true, 'REGISTRATION_TERMS_OUTSIDE_FORM');
    assert.equal(termsPlacement.immediatelyAfterSubmit, true, 'REGISTRATION_TERMS_NOT_AFTER_SUBMIT');
    assert.ok(
      typeof termsPlacement.gapBelowSubmit === 'number'
        && termsPlacement.gapBelowSubmit >= 8
        && termsPlacement.gapBelowSubmit <= 28,
      'REGISTRATION_TERMS_GAP_INVALID',
    );
    assert.equal(termsPlacement.insideLoginPanel, true, 'REGISTRATION_TERMS_OUTSIDE_LOGIN_PANEL');

    const drawerMetrics = await drawer.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {
        width: rect.width,
        right: rect.right,
        viewportWidth: document.documentElement.clientWidth,
        overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      };
    });
    assert.ok(drawerMetrics.width > 400 && drawerMetrics.width <= 520, 'LOGIN_DRAWER_WIDTH_OUT_OF_RANGE');
    assert.ok(Math.abs(drawerMetrics.right - drawerMetrics.viewportWidth) <= 1, 'LOGIN_DRAWER_NOT_RIGHT_ALIGNED');
    assert.equal(drawerMetrics.overflowX, 0);
    const drawerScreenshot = path.join(outputDir, `login-register-drawer-${viewport.name}.png`);
    await page.screenshot({ path: drawerScreenshot, fullPage: false });
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached', timeout: 10_000 });

    const registerResponse = await page.goto(`${origin}/register?redirect=%2Ftools`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    assert.equal(registerResponse?.status(), 200);
    const registrationPage = page.locator('[data-page="public-auth-register"]');
    await registrationPage.waitFor({ state: 'visible', timeout: 30_000 });
    await registrationPage.getByRole('heading', { name: '创建你的创作账号', exact: true }).waitFor({ state: 'visible' });
    const registrationText = await registrationPage.innerText();
    // Keep this contract semantic rather than tied to a retired sentence. The
    // current register copy explains the same two gates in two short lines.
    assert.match(registrationText, /邮箱验证码/u);
    assert.match(registrationText, /邀请码/u);
    assert.equal(await registrationPage.locator('#register-password').getAttribute('type'), 'password');
    const registrationMetrics = await registrationPage.evaluate(node => ({
      width: node.getBoundingClientRect().width,
      overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    assert.ok(registrationMetrics.width > 0);
    assert.equal(registrationMetrics.overflowX, 0);
    const pageScreenshot = path.join(outputDir, `register-page-${viewport.name}.png`);
    await page.screenshot({ path: pageScreenshot, fullPage: false });

    report.viewports.push({
      viewport,
      loginDrawer: true,
      themePreservedFromHome: true,
      accountLogin: true,
      emailLogin: true,
      registration: true,
      registrationTermsHiddenFromLoginModes: true,
      registrationTermsInsideForm: true,
      loginPasswordToggle: true,
      registrationPasswordToggle: true,
      horizontalOverflow: 0,
      screenshots: [drawerScreenshot, pageScreenshot],
    });
    await context.close();
  }

  assert.deepEqual(report.writes, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.serverErrors, []);
  report.passed = true;
} finally {
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
