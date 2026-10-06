import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.LOCAL_APP_ORIGIN || 'http://127.0.0.1:5000';
const outputDir = path.resolve(process.env.SEGMENTER_EVIDENCE_DIR || '.codex-evidence/segmenter-local-rules-browser');
const chromiumPath = process.env.LOCAL_CHROMIUM_PATH
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const inputText = '清晨，阳光从窗帘缝隙照进房间。我放下手机，给自己倒了一杯温水，然后换好鞋走出家门。小区里的树叶随风轻轻摇晃，路边有一只猫正在伸懒腰。沿着小河慢慢走了十分钟，原本紧绷的肩膀渐渐放松。回家的路上，我决定明天继续这段短短的散步，让一天从安静和清醒开始。后来我又经过街角的小书店，看见店主正在整理新到的书。窗边的绿植上还挂着细小的水珠，我挑了一本散文坐下慢慢翻阅。';

fs.mkdirSync(outputDir, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  origin,
  mode: 'local_rules',
  nonGetRequests: [],
  modelOrProviderRequests: [],
  externalRequests: [],
  pageErrors: [],
  consoleErrors: [],
};

const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await context.newPage();

  page.on('pageerror', error => report.pageErrors.push({ name: error.name, message: error.message.slice(0, 300) }));
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text().slice(0, 400));
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin) report.externalRequests.push({ method: request.method(), url: request.url() });
    if (request.method() !== 'GET' && request.method() !== 'HEAD' && request.method() !== 'OPTIONS') {
      report.nonGetRequests.push({ method: request.method(), url: request.url() });
    }
    if (/\/api\/(?:segmenter\/semantic|chat|image\/generate|video\/generate)|provider|completion/i.test(url.pathname)) {
      report.modelOrProviderRequests.push({ method: request.method(), url: request.url() });
    }
  });

  const response = await page.goto(`${origin}/segmenter`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  assert.equal(response?.status(), 200, 'Segmenter page must return HTTP 200');
  await page.locator('textarea').fill(inputText, { timeout: 20_000 });
  const button = page.getByRole('button', { name: '开始分段', exact: true });
  await button.waitFor({ timeout: 20_000 });

  // Ignore page bootstrap traffic. The action itself must remain entirely local.
  report.nonGetRequests.length = 0;
  report.modelOrProviderRequests.length = 0;
  report.externalRequests.length = 0;

  await button.click({ timeout: 10_000 });
  await page.getByText('分段结果', { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText(/按所选时长、字数范围和标点规则完成分段/u).first().waitFor({ timeout: 10_000 });

  const resultSection = page.locator('section').filter({ hasText: '分段结果' }).first();
  report.segmentCount = await resultSection.locator('p').count();
  report.renderedText = (await resultSection.innerText()).slice(0, 12_000);
  report.completedAt = new Date().toISOString();

  assert.ok(report.segmentCount >= 2, 'Local rules must render at least two segments for the fixture text');
  assert.equal(report.modelOrProviderRequests.length, 0, 'Smart segmentation must not request a model or provider');
  assert.equal(report.nonGetRequests.length, 0, 'Anonymous local segmentation must not submit or write any request');
  assert.equal(report.pageErrors.length, 0, 'Segmenter page must not raise runtime errors');

  await page.screenshot({ path: path.join(outputDir, 'segmenter-local-rules.png'), fullPage: true });
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: true,
    http: response?.status(),
    mode: report.mode,
    segmentCount: report.segmentCount,
    modelOrProviderRequests: report.modelOrProviderRequests.length,
    nonGetRequests: report.nonGetRequests.length,
    pageErrors: report.pageErrors.length,
  }));
} catch (error) {
  report.failure = { name: error.name, message: error.message.slice(0, 500) };
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
}
