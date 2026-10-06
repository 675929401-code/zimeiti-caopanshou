import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.LOCAL_APP_ORIGIN || 'http://127.0.0.1:5000';
const out = path.resolve('.codex-evidence/toolbox-format-segment-r473-20260927');
const chromiumPath = process.env.LOCAL_CHROMIUM_PATH
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
fs.mkdirSync(out, { recursive: true });
const report = { at: new Date().toISOString(), path: '/tools?tab=segment', nonGetRequests: [], pageErrors: [] };
const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.nonGetRequests.push({ method: request.method(), url: request.url() });
  });
  await page.goto(`${origin}${report.path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const input = page.getByRole('textbox', { name: '需要分段的文案' });
  await input.fill('刷新后不应保留的临时文案。'.repeat(20));
  await page.getByRole('button', { name: '开始分段', exact: true }).click();
  await page.locator('[data-segmenter-result="true"]').waitFor({ state: 'visible' });
  report.beforeRefresh = { inputLength: (await input.inputValue()).length, resultVisible: true };
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  const refreshedInput = page.getByRole('textbox', { name: '需要分段的文案' });
  await refreshedInput.waitFor({ state: 'visible' });
  report.afterRefresh = {
    input: await refreshedInput.inputValue(),
    resultCount: await page.locator('[data-segmenter-result="true"]').count(),
  };
  assert.equal(report.afterRefresh.input, '');
  assert.equal(report.afterRefresh.resultCount, 0);
  assert.equal(report.nonGetRequests.length, 0);
  assert.equal(report.pageErrors.length, 0);
  report.passed = true;
  await page.screenshot({ path: path.join(out, 'segment-refresh-clears-draft.png'), fullPage: false });
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'segment-refresh-contract.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
}
