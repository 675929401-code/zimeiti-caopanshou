#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5000';
const output = process.argv[2];
if (!output || !process.env.READONLY_UI_EXPECTED_USERNAME) throw new Error('OUTPUT_AND_EXPECTED_USERNAME_REQUIRED');
const report = { observedAt: new Date().toISOString(), source: 'LIVE_UNMODIFIED_GET_AND_LOCAL_UI', responseFixtures: false, credentialsSaved: false, generationSubmitted: false, endpoints: [], pages: [], blocked: [], httpErrors: [], pageErrors: [], failure: null };
const advancingGet = new Set(['/api/video/status', '/api/video/stream', '/api/image/status']);
const safePath = value => {
  const url = new URL(value, origin);
  return url.origin === origin ? url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id').replace(/\d{9,}/gu, ':id') : 'external-asset';
};
let browser;
let stage = 'login';
try {
  const response = await fetch(`${origin}/api/auth/dev-session`, { headers: { 'x-local-workbench': 'ai-creation-studio-local' }, signal: AbortSignal.timeout(15000) });
  const session = await response.json();
  if (!response.ok || !session.token || session.user?.username !== process.env.READONLY_UI_EXPECTED_USERNAME || session.user?.role !== 'admin') throw new Error('EXPECTED_ADMIN_SESSION_UNAVAILABLE');
  report.authentication = { normalDevSession: true, expectedAdminMatched: true };
  for (const endpoint of ['/api/voice/status', '/api/voice/history?page=1&pageSize=1', '/api/voice/generation-status?requestId=readonly-voice-readiness-20260902']) {
    const result = await fetch(`${origin}${endpoint}`, { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(15000) });
    const data = await result.json().catch(() => null);
    const item = { path: safePath(endpoint), status: result.status, success: data?.success === true };
    if (data?.code) item.code = data.code;
    if (endpoint.startsWith('/api/voice/status')) item.provider = { configured: data?.data?.available === true, canSubmitReportedByConfigEndpoint: data?.data?.canSubmit === true, upstreamCalls: data?.data?.upstreamCalls, creditsCharged: data?.data?.creditsCharged };
    if (endpoint.startsWith('/api/voice/history')) item.history = { total: Number(data?.data?.total ?? 0), sampleCount: data?.data?.items?.length ?? 0, playableUrlCount: data?.data?.items?.filter(item => /^https?:\/\/|^\/|^data:audio\//u.test(item.outputAudioUrl || '')).length ?? 0 };
    report.endpoints.push(item);
  }
  stage = 'browser';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const diagnostic = request.method() === 'POST' && url.origin === origin && url.pathname === '/__nextjs_original-stack-frames';
    if ((request.method() !== 'GET' && !diagnostic) || (url.origin === origin && advancingGet.has(url.pathname))) {
      report.blocked.push({ method: request.method(), path: safePath(url.href) });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
  }, { token: session.token, user: session.user });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.pageErrors.push({ stage, name: error.name }));
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ stage, path: safePath(response.url()), status: response.status() }); });
  stage = 'workspace';
  await page.goto(`${origin}/voice-studio/workspace`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const search = page.getByRole('textbox', { name: '选择音色搜索', exact: true });
  await search.waitFor({ state: 'visible' });
  const preview = page.locator('button[title="点击试听"]');
  await preview.first().waitFor({ state: 'visible' });
  const voiceCount = await preview.count();
  const chosen = preview.nth(Math.min(1, voiceCount - 1)).locator('xpath=..');
  await chosen.locator('div.flex-1').first().click();
  const selected = /shadow-\[0_0_14px/u.test(await chosen.getAttribute('class') || '');
  const input = page.getByPlaceholder('输入要合成的文本内容...', { exact: true });
  const original = await input.inputValue();
  await input.fill('只读界面验收，不提交语音生成。');
  const editable = await input.inputValue() === '只读界面验收，不提交语音生成。';
  await input.fill(original);
  const layout = await page.evaluate(() => ({ overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth), imageCount: document.images.length, brokenImages: [...document.images].filter(image => image.complete && image.naturalWidth === 0 && image.getBoundingClientRect().width > 0).length }));
  report.pages.push({ path: '/voice-studio/workspace', voiceCount, categoryCount: await page.getByRole('combobox', { name: '选择音色分类', exact: true }).locator('option').count(), pointerSelection: selected, inputFillAndRestore: editable && await input.inputValue() === original, ...layout });
  stage = 'voices';
  await page.getByRole('link', { name: '音色库', exact: true }).first().click();
  await page.waitForURL('**/voice-studio/voices', { timeout: 20000 });
  await page.getByPlaceholder(/搜索/u).first().waitFor({ state: 'visible' });
  report.pages.push({ path: '/voice-studio/voices', navigated: true, ...(await page.evaluate(() => ({ overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth), inputCount: document.querySelectorAll('input').length, imageCount: document.images.length }))) });
} catch (error) {
  report.failure = { stage, name: error.name, reason: error.message.split('\n')[0].replace(/https?:\S+/gu, '[url]') };
} finally {
  if (browser) await browser.close();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
