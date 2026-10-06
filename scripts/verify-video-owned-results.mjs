import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
assert.ok(['http://127.0.0.1:5000','http://127.0.0.1:5002'].includes(origin));
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.ok(token);
const run = process.argv.find(arg=>arg.startsWith('--run='))?.slice(6) || 'all13-real-canary-20260902';
assert.match(run, /^[a-z0-9-]+$/);
const base = '.codex-evidence/video-all-models-real-e2e-20260902/' + run;
const output = '.codex-evidence/video-all-models-real-e2e-20260902/owned-results';
await fs.mkdir(output, { recursive: true });
const identity = await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
assert.equal((await identity.json()).user?.role, 'admin');
const histories = await fetch(origin + '/api/video/history?limit=200', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
const historyIds = new Set((histories.tasks || []).map(t => t.id));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(origin + '/api/health', { waitUntil: 'domcontentloaded' });
const summaries = [];
try {
  for (const entry of await fs.readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let prior;
    try { prior = JSON.parse(await fs.readFile(path.join(base, entry.name, 'result.json'), 'utf8')); } catch { continue; }
    if (!prior.business?.id || prior.state !== 'completed') continue;
    const reportFile = path.join(output, entry.name + '.json');
    try { const done = JSON.parse(await fs.readFile(reportFile, 'utf8')); if (done.passed) { summaries.push(done); continue; } } catch {}
    const report = { model: prior.selectedModel.internalId, taskId: prior.business.id, at: new Date().toISOString(), newGenerationRequests: 0 };
    try {
      assert.ok(historyIds.has(report.taskId), 'Owned task missing from refreshed history'); report.historyPresent = true;
      const status = await fetch(origin + '/api/video/status?' + new URLSearchParams({ taskId: prior.business.providerTaskId, modelId: report.model }), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
      const result = await status.json(); assert.equal(result.status, 'completed');
      const url = new URL(result.storageUrl || result.videoUrl, origin); assert.equal(url.origin, origin, 'Use owned same-origin result proxy');
      const file = path.join(output, entry.name + '.mp4');
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 1000);
      await fs.writeFile(file, bytes);
      report.download = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
      assert.equal(decoded.status, 0); report.fullDecode = true;
      await page.setContent('<video muted controls style="width:640px;max-width:100%"></video>');
      await page.locator('video').evaluate((video, url) => { video.src = url; video.load(); }, url.toString());
      await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 2 && video.videoWidth > 0; }, null, { timeout: 60000 });
      await page.locator('video').evaluate(video => video.play());
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.15, null, { timeout: 20000 });
      report.playback = await page.locator('video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, duration: video.duration, currentTime: video.currentTime, error: video.error?.code || null }));
      assert.equal(report.playback.error, null);
      if (report.model === 'minimax-h3-2k-lc') assert.ok(Math.max(report.playback.width, report.playback.height) >= 1920, '2K channel must not deliver 768P');
      await page.screenshot({ path: path.join(output, entry.name + '.png') });
      report.passed = true;
    } catch (error) { report.passed = false; report.failure = { name: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[url]').slice(0,600) }; }
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2)); summaries.push(report);
    console.log(JSON.stringify(report));
  }
} finally { await browser.close(); await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summaries, null, 2)); }
if (summaries.some(r => !r.passed)) process.exitCode = 1;
