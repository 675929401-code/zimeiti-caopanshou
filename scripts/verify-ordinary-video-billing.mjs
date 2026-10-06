import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';
const origin = 'http://127.0.0.1:5000';
const token = process.env.LOCAL_NAV_USER_TOKEN;
assert.ok(token);
const resume = process.argv.includes('--resume-original');
const dir = '.codex-evidence/ordinary-video-billing-20260903';
const fixture = JSON.parse(await fs.readFile(dir + '/fixture.json', 'utf8'));
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const get = async path => { const r = await fetch(origin + path, { headers, signal: AbortSignal.timeout(60000) }); return { http: r.status, body: await r.json() }; };
const identity = await get('/api/auth/me');
assert.equal(identity.body.user.id, fixture.userId); assert.equal(identity.body.user.role, 'student');
const forbidden = await get('/api/admin/plugins'); assert.ok([401,403].includes(forbidden.http));
const before = await get('/api/cash/balance');
if (!resume) assert.equal(Number(before.body.balance), 2);
const modelId = 'pm_O31GjpRvlTXjWUM1Ha9FG0N2';
const payload = { model_id: modelId, prompt: '一只白色纸船漂浮在宁静湖面，晨光柔和，固定镜头，无文字。', duration: 10, resolution: '720p', resolution_tier: '720p', aspect_ratio: '16:9', task_label: fixture.run, client_request_id: fixture.run, surface: 'video-page' };
const report = resume ? JSON.parse(await fs.readFile(dir + '/result.json', 'utf8')) : { at: new Date().toISOString(), origin, userId: fixture.userId, role: 'student', administratorAccessDenied: true, administratorDenialHttp: forbidden.http, initialCash: 2, expectedPrice: 0.5, fixtureBalanceIsNotRechargeEvidence: true, providerSubmissionAttempts: 0, observations: [] };
const save = () => fs.writeFile(dir + '/result.json', JSON.stringify(report, null, 2));
try {
  let body;
  if (resume) {
    assert.ok(report.submission?.taskId && report.submission?.businessTaskId, 'Original task receipt required');
    assert.equal(report.userId, fixture.userId);
    body = { task_id: report.submission.taskId, business_task_id: report.submission.businessTaskId };
    report.originalTaskResumedAt = new Date().toISOString();
    delete report.error;
  } else {
  const claim = await fs.open(dir + '/dispatch.json', 'wx');
  await claim.writeFile(JSON.stringify({ userId: fixture.userId, clientRequestId: fixture.run, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), started: new Date().toISOString() })); await claim.close();
  report.providerSubmissionAttempts = 1;
  const submitted = await fetch(origin + '/api/video/generate', { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(210000) });
  body = await submitted.json(); report.submission = { http: submitted.status, taskId: body.task_id, businessTaskId: body.business_task_id, status: body.status, code: body.error_code };
  await save(); assert.ok(body.task_id, body.error || 'No task receipt; keep original key');
  }
  let done = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    let status;
    try { status = await get('/api/video/status?' + new URLSearchParams({ taskId: body.task_id, modelId })); }
    catch (error) {
      report.observations.push({ at: new Date().toISOString(), status: 'status-read-unavailable', error: String(error.message).replace(/https?:\/\/\S+/g, '[url]').slice(0,160) });
      await save(); await new Promise(resolve => setTimeout(resolve,12000)); continue;
    }
    if (!report.observations.length || report.observations.at(-1).status !== status.body.status) report.observations.push({ at: new Date().toISOString(), http: status.http, status: status.body.status, code: status.body.errorCode });
    await save();
    if (status.body.status === 'failed') throw new Error(status.body.errorMessage || 'Provider failed');
    if (status.body.status === 'completed') {
      done = true; report.priceCharged = status.body.priceCharged;
      const finalCash = await get('/api/cash/balance'); report.finalCash = Number(finalCash.body.balance);
      assert.equal(report.finalCash, 1.5); assert.equal(report.priceCharged, 0.5);
      const response = await fetch(new URL(status.body.storageUrl || status.body.videoUrl, origin), { headers, signal: AbortSignal.timeout(90000) }); assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); const file = dir + '/owned-video.mp4'; await fs.writeFile(file, bytes);
      report.download = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      assert.equal(spawnSync(ffmpeg, ['-v','error','-i',file,'-f','null','-'], { windowsHide: true, timeout: 90000 }).status, 0); report.fullDecode = true;
      const history = await get('/api/video/history?limit=100'); assert.ok(history.body.tasks.some(t => t.id === body.business_task_id)); report.historyPresent = true;
      const replay = await fetch(origin + '/api/video/generate', { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
      const replayBody = await replay.json(); assert.equal(replayBody.replayed, true); assert.equal(replayBody.business_task_id, body.business_task_id); report.completedReplay = true;
      assert.equal(Number((await get('/api/cash/balance')).body.balance), 1.5); report.replayDidNotChargeAgain = true;
      const browser = await chromium.launch({ headless: true });
      try { const page = await browser.newPage(); await page.goto(origin + '/api/health'); await page.setContent('<video controls muted></video>'); await page.locator('video').evaluate((v, url) => { v.src = url; v.load(); }, new URL(status.body.videoUrl, origin).toString()); await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2); await page.locator('video').evaluate(v => v.play()); await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1); report.playback = await page.locator('video').evaluate(v => ({ width:v.videoWidth,height:v.videoHeight,duration:v.duration,error:v.error?.code||null })); } finally { await browser.close(); }
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 12000));
  }
  assert.ok(done, 'Original task still unresolved; do not generate again'); report.passed = true;
} catch (error) { report.passed = false; report.error = error.message.replace(/https?:\/\/\S+/g, '[url]').slice(0,500); }
finally { await save(); console.log(JSON.stringify(report)); }
