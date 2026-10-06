#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = String(process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const output = path.resolve('.codex-evidence/toolbox-fresh-history-r217');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const typed = '这是不应跨刷新保留的分段输入。'.repeat(3);
const retiredKeys = [
  'app_state_segmenter_input',
  'app_state_segmenter_result',
  'app_state_segmenter_duration',
  'app_state_segmenter_input:anonymous',
  'app_state_segmenter_result:anonymous',
  'app_state_segmenter_duration:anonymous',
];
const formatterRetiredKeys = [
  'app_state_formatter_input',
  'app_state_formatter_output',
  'app_state_formatter_options',
  'app_state_formatter_input:anonymous',
  'app_state_formatter_output:anonymous',
  'app_state_formatter_options:anonymous',
];

try {
  for (const routePath of ['/tools?tab=segment', '/segmenter']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const hydrationErrors = [];
    const blocked = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /hydration|hydrated|server rendered|didn't match/iu.test(message.text())) {
        hydrationErrors.push(message.text().slice(0, 500));
      }
    });
    await page.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method()) || /\/api\/(image|video|segmenter)\/(status|stream|generate|semantic|cancel)/u.test(url.pathname)) {
        blocked.push({ method: request.method(), path: url.pathname });
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(keys => {
      if (sessionStorage.getItem('retired_segmenter_fixture_prepared')) return;
      for (const key of keys) sessionStorage.setItem(key, key.includes('duration') ? '12' : '"retired draft"');
      sessionStorage.setItem('retired_segmenter_fixture_prepared', 'true');
    }, retiredKeys);

    const response = await page.goto(`${baseUrl}${routePath}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    assert.equal(response.status(), 200);
    const field = page.getByRole('textbox', { name: '需要分段的文案' });
    await field.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => {
      const element = document.querySelector('textarea[aria-label="需要分段的文案"]');
      return element && !element.disabled;
    }, undefined, { timeout: 30000 });
    assert.equal(await field.inputValue(), '', 'retired draft must not restore');
    assert.deepEqual(
      await page.evaluate(keys => keys.filter(key => sessionStorage.getItem(key) !== null), retiredKeys),
      [],
      'retired segmenter draft keys must be removed',
    );

    await field.fill(typed);
    assert.equal(await field.inputValue(), typed);
    assert.deepEqual(
      await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('segmenter_') && key !== 'retired_segmenter_fixture_prepared')),
      [],
      'ordinary input must not create draft memory',
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await field.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => {
      const element = document.querySelector('textarea[aria-label="需要分段的文案"]');
      return element && !element.disabled;
    }, undefined, { timeout: 30000 });
    assert.equal(await field.inputValue(), '', 'segmenter must reopen blank after refresh');
    await page.screenshot({ path: path.join(output, routePath.startsWith('/tools') ? 'tools-fresh-after-refresh.png' : 'standalone-fresh-after-refresh.png'), fullPage: false });
    results.push({ kind: 'segmenter', routePath, http: 200, retiredKeysCleared: true, typedLength: typed.length, refreshValue: '', errors, hydrationErrors, blocked });
    await context.close();
  }

  for (const routePath of ['/tools?tab=format', '/formatter']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const hydrationErrors = [];
    const blocked = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /hydration|hydrated|server rendered|didn't match/iu.test(message.text())) hydrationErrors.push(message.text().slice(0, 500));
    });
    await page.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {
        blocked.push({ method: request.method(), path: url.pathname });
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(keys => {
      if (sessionStorage.getItem('retired_formatter_fixture_prepared')) return;
      for (const key of keys) sessionStorage.setItem(key, key.includes('options') ? '{"removeExtraSpaces":false}' : '"retired formatter draft"');
      sessionStorage.setItem('retired_formatter_fixture_prepared', 'true');
    }, formatterRetiredKeys);

    const response = await page.goto(`${baseUrl}${routePath}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    assert.equal(response.status(), 200);
    const input = page.getByPlaceholder(/在此粘贴需要排版的文案/u);
    await input.waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await input.inputValue(), '', 'retired formatter draft must not restore');
    assert.deepEqual(
      await page.evaluate(keys => keys.filter(key => sessionStorage.getItem(key) !== null), formatterRetiredKeys),
      [],
      'retired formatter draft keys must be removed',
    );
    await input.fill(typed);
    await page.getByRole('button', { name: '开始排版', exact: true }).click();
    const outputField = page.locator('textarea[readonly]');
    await outputField.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await outputField.inputValue()).length > 0, 'formatter result must be visible before refresh');
    assert.deepEqual(
      await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('formatter_') && key !== 'retired_formatter_fixture_prepared')),
      [],
      'formatter input and output must not create draft memory',
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await input.waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await input.inputValue(), '', 'formatter must reopen blank after refresh');
    assert.equal(await page.locator('textarea[readonly]').count(), 0, 'formatter result must not restore outside history');
    await page.screenshot({ path: path.join(output, routePath.startsWith('/tools') ? 'tools-formatter-fresh-after-refresh.png' : 'standalone-formatter-fresh-after-refresh.png'), fullPage: false });
    results.push({ kind: 'formatter', routePath, http: 200, retiredKeysCleared: true, typedLength: typed.length, refreshValue: '', errors, hydrationErrors, blocked });
    await context.close();
  }

  const report = {
    passed: results.every(item => item.errors.length === 0 && item.hydrationErrors.length === 0 && item.blocked.length === 0),
    authenticated: false,
    generationRequests: 0,
    businessDatabaseWrites: 0,
    results,
  };
  await fs.writeFile(path.join(output, 'browser-fresh-start.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.passed, true);
} finally {
  await browser.close();
}
