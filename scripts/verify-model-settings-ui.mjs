import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN;
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin, 'http://127.0.0.1:5000');
  assert.ok(token);
  const output = path.resolve('..', '运行日志', '模型设置优化-20260907');
  await fs.mkdir(output, { recursive: true });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const identity = await fetch(`${origin}/api/auth/me`, { headers });
  assert.ok(identity.ok);
  const { user } = await identity.json();
  const invalid = await fetch(`${origin}/api/video/detect-protocol`, {
    method: 'POST', headers,
    body: JSON.stringify({ api_endpoint: 'invalid@example.com', api_key: 'fixture-not-a-secret', model_name: 'fixture' }),
  });
  assert.equal(invalid.status, 400, 'Invalid URL must fail before provider access');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [], blocked = [];
  try {
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
    }, { token, user });
    // UI acceptance never writes models or submits billable tasks.
    await context.route('**/api/**', async route => {
      const req = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
        blocked.push(new URL(req.url()).pathname);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin?tab=models`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /视频模型\s*\d/ }).click({ timeout: 45000 });
    await page.locator('[data-model-card]').first().waitFor();
    assert.equal(await page.locator('[data-model-card] details[open]').count(), 0);
    await page.screenshot({ path: path.join(output, '模型列表.png'), fullPage: false });
    await page.getByRole('button', { name: '添加视频模型', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增模型' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('details[open]').count(), 0);
    assert.equal(await dialog.locator('label').filter({ hasText: /^售价\(/ }).count(), 1);
    assert.equal(await dialog.locator('input[readonly]').inputValue(), '成本未设置');
    const background = await dialog.evaluate(el => getComputedStyle(el).backgroundColor);
    const backgroundAlpha = await dialog.evaluate(el => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    });
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
    await dialog.getByLabel('接入站点 API 地址', { exact: true }).fill('invalid@example.com');
    assert.ok(await dialog.getByRole('alert').isVisible());
    assert.equal(await dialog.getByLabel('API 密钥', { exact: true }).getAttribute('autocomplete'), 'new-password');
    await dialog.getByLabel('接入站点 API 地址', { exact: true }).fill('');
    await dialog.screenshot({ path: path.join(output, '视频模型基础设置.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    await dialog.screenshot({ path: path.join(output, '手机模型设置.png') });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-model-card]').first().getByRole('button', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑模型' });
    await edit.waitFor();
    assert.equal(await edit.getByLabel('API 密钥', { exact: true }).inputValue(), '');
    await edit.getByRole('button', { name: '关闭模型设置' }).click();
    for (const route of ['/video', '/voice-studio/voices']) {
      const response = await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      await page.waitForTimeout(1000);
    }
    assert.deepEqual(errors, [], 'Browser runtime errors');
    assert.ok(!blocked.some(route => /models|generate|detect-protocol/.test(route)), 'Unexpected model mutation');
    assert.equal(backgroundAlpha, 255, 'Dialog must have an opaque surface');
    const report = { passed: true, invalidEndpointStatus: invalid.status, opaqueDialog: background,
      listNotesCollapsed: true, advancedSettingsCollapsed: true, salePriceFields: 1,
      maskedStoredKey: true, mobileWidth: 390, browserErrors: errors,
      preventedBackgroundWrites: [...new Set(blocked)], paidCalls: 0, modelWrites: 0 };
    await fs.writeFile(path.join(output, '验证结果.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
}
