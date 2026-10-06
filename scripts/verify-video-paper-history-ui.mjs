import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';

const origin = String(process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.ok(token);
const out = '.codex-evidence/video-real-e2e-20260902';
await fs.mkdir(out, { recursive: true });
const identity = await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
const me = await identity.json(); assert.equal(me.user?.role, 'admin');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await context.addInitScript(({ token, user, origin }) => {
  if (location.origin !== origin) return;
  try { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); } catch {}
}, { token, user: me.user, origin });
const report = { at: new Date().toISOString(), normalAdmin: true, generatedNewTasks: 0, errors: [], steps: [] };
await context.route('**/api/**', route => {
  const request = route.request();
  if (!['GET', 'HEAD'].includes(request.method())) {
    if (new URL(request.url()).pathname !== '/api/diagnostic-logs') report.errors.push({ method: request.method(), path: new URL(request.url()).pathname, blockedMutation: true });
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const prompt = '黄昏海边，一艘小纸船在浅水中缓慢漂动，暖色逆光，固定镜头，画面安静，无文字。';
try {
  await page.goto(origin + '/video', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => { const select = document.querySelector('[role=combobox]'); return select && /Omni|MiniMax|Grok|Veo/i.test(select.textContent || ''); }, null, {timeout: 60000});
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByText(prompt, { exact: true }).waitFor();
  const row = page.getByText(prompt, { exact: true }).locator('..').locator('..');
  assert.match(await row.innerText(), /Omni Flash/);
  report.steps.push({ name: 'history-original-model', passed: true });
  await row.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2 && video.videoWidth > 0), null, { timeout: 60000 });
  const media = page.locator('video').first();
  await media.evaluate(video => { video.muted = true; return video.play(); });
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.currentTime > 0.2), null, { timeout: 30000 });
  report.playback = await media.evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, duration: video.duration, currentTime: video.currentTime, error: video.error?.code || null }));
  assert.equal(report.playback.error, null);
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await row.getByRole('button', { name: '下载', exact: true }).click();
  const download = await downloadPromise;
  const file = out + '/paper-video.mp4';
  await download.saveAs(file);
  assert.equal(await download.failure(), null);
  const bytes = (await fs.stat(file)).size;
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { timeout: 90000, encoding: 'utf8', windowsHide: true });
  assert.equal(decoded.status, 0); assert.ok(bytes > 1000);
  report.download = { bytes, ffmpegDecodeExit: decoded.status };
  await page.screenshot({ path: out + '/paper-history-playback.png', fullPage: false });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => { const select = document.querySelector('[role=combobox]'); return select && /Omni|MiniMax|Grok|Veo/i.test(select.textContent || ''); }, null, {timeout: 60000});
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByText(prompt, { exact: true }).waitFor();
  report.steps.push({ name: 'history-survives-refresh', passed: true });
  await page.getByRole('button', { name: '历史', exact: true }).click();
  const select = page.getByRole('combobox').first();
  await select.click();
  const options = await page.getByRole('option').allTextContents();
  report.selectableModels = options;
  assert.ok(options.length > 0); assert.ok(options.every(option => !/不可用|已暂停/.test(option)));
  const h3 = page.getByRole('option').filter({ hasText: 'MiniMax H3' }).first();
  if (await h3.count()) {
    await h3.click();
    const chosen = await select.innerText();
    const text = await page.locator('body').innerText();
    assert.ok(!text.includes('AutoDL 托管任务提交后不支持远程取消'));
    assert.ok(!text.includes('纯本地处理，数据不会上传服务器'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(chosen => document.querySelector('[role=combobox]')?.textContent === chosen, chosen);
    report.steps.push({ name: 'model-choice-persists-and-no-pre-submit-warning', passed: true });
    await page.screenshot({ path: out + '/h3-quiet-selection.png', fullPage: false });
  } else await page.keyboard.press('Escape');
  for (const route of ['/tools', '/voice-studio/workspace']) {
    const started = Date.now();
    const response = await page.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.trim().length > 80, null, { timeout: 30000 });
    assert.equal(response.status(), 200);
    report.steps.push({ name: 'unrelated-page', route, http: response.status(), visibleMs: Date.now() - started });
  }
  report.passed = report.errors.length === 0;
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[url]').slice(0, 1000) };
  await page.screenshot({ path: out + '/paper-ui-failure.png' }).catch(() => {});
} finally {
  await fs.writeFile(out + '/paper-history-ui.json', JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
