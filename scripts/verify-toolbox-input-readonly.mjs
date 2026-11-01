#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { installStoryboardBrowserFixture } from './storyboard-browser-fixture.mjs';
const output = path.resolve('.codex-evidence/toolbox-input-20260902');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const after = process.argv.includes('--after');
const results = [];
try {
 for (const routePath of after ? ['/tools?tab=segment', '/segmenter'] : ['/tools?tab=segment']) {
  const blocked = []; const telemetry = []; const errors = []; const samples = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'POST' && ['/api/product-usage/events', '/api/operation-events'].includes(url.pathname)) {
      telemetry.push({ method: request.method(), path: url.pathname });
      return route.fulfill({ status: 204, body: '' });
    }
    if (!['GET', 'HEAD'].includes(request.method()) || /\/api\/(?:image|video|segmenter)\/(?:status|stream|generate|semantic|cancel)/.test(url.pathname)) {
      blocked.push({ method: request.method(), path: url.pathname }); return route.abort();
    }
    return route.continue();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.inputEvents = [];
    for (const name of ['input', 'change']) document.addEventListener(name, (event) => {
      if (event.target?.tagName === 'TEXTAREA') globalThis.inputEvents.push({ type: name, trusted: event.isTrusted, length: event.target.value.length });
    }, true);
  });
  // Use the repository-owned browser fixture so route guards do not redirect
  // the toolbox before the input retention contract can be observed. The
  // fixture token is synthetic and never represents real admin credentials.
  await installStoryboardBrowserFixture(page, { origin: 'http://127.0.0.1:5000', resetStorage: true });
  const response = await page.goto(`http://127.0.0.1:5000${routePath}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  assert.equal(response.status(), 200);
  const serverText = await response.text();
  const serverTextarea = serverText.match(/<textarea\b[^>]*aria-label="需要分段的文案"[^>]*>/u)?.[0] || '';
  const serverTextareaDisabled = /\bdisabled(?:\s|=|>)/u.test(serverTextarea);
  if (after && routePath === '/segmenter') {
    const routedToToolbox = response.url().includes('/tools?tab=segment');
    assert.ok(serverTextarea || routedToToolbox, 'standalone segmenter must render or route to the toolbox segment panel');
    if (serverTextarea) assert.equal(serverTextareaDisabled, true, 'SSR segmenter textarea must not accept text before hydration');
  }
  const field = page.locator('textarea').first(); await field.waitFor({ timeout: 30000 });
  const capture = async (phase) => samples.push(await page.evaluate((label) => {
    const textarea = document.querySelector('textarea');
    const props = Object.keys(textarea).find((key) => key.startsWith('__reactProps$'));
    const button = [...document.querySelectorAll('button')].find((item) => ['开始分段', '规则预览', '正在恢复登录...'].some((label) => item.innerText.includes(label)));
    return { phase: label, valueLength: textarea.value.length, disabled: textarea.disabled, reactValueLength: props ? textarea[props].value?.length : null,
      segmenterStorageKeys: Object.keys(sessionStorage).filter(key => key.includes('segmenter_')).sort(),
      buttonDisabled: button?.disabled, events: globalThis.inputEvents.slice(), readyState: document.readyState };
  }, phase));
  await capture('before');
  const text = '这是工具箱输入验证文本。'.repeat(10) + '测试文';
  await field.fill(text); await capture('immediately-after-fill');
  await page.waitForTimeout(1000); await capture('one-second-after-fill');
  await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('键盘追加');
  await page.waitForTimeout(1000); await capture('after-keyboard-insert');
  if (after) {
    await page.getByRole('button', { name: '开始分段', exact: true }).waitFor();
    assert.equal(blocked.filter((request) => request.method === 'POST' && request.path.startsWith('/api/')).length, 0);
  }
  await page.screenshot({ path: path.join(output, `${routePath.startsWith('/tools') ? 'tools' : 'standalone'}-segment-input${after ? '-after' : ''}.png`), fullPage: false });
  if (after) {
    assert.equal(samples[2].valueLength, text.length);
    assert.equal(samples[2].reactValueLength, text.length);
    assert.deepEqual(samples[2].segmenterStorageKeys, []);
    assert.equal(samples[2].buttonDisabled, false);
    assert.equal(samples[3].valueLength, text.length + 4);
    assert.equal(samples[3].reactValueLength, text.length + 4);
    assert.deepEqual(samples[3].segmenterStorageKeys, []);
    assert.equal(samples[3].buttonDisabled, false);
  }
  results.push({ routePath, serverTextareaDisabled, blocked, telemetry, errors, samples });
  await context.close();
 }
 const result = { ...(after ? { pass: true } : {}), authenticated: false, browserFixture: true, realGenerationRequests: 0, results };
 await fs.writeFile(path.join(output, after ? 'after-input.json' : 'readonly-input.json'), JSON.stringify(result, null, 2));
 console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
