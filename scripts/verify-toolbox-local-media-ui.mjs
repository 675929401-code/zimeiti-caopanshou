import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const mode = args.includes('--execute') ? 'execute' : args.includes('--inspect') ? 'inspect' : 'plan';
const allActions = [
  { id: 'trim', label: '裁剪', button: '裁剪并导出', type: 'video/mp4' },
  { id: 'concat', label: '拼接', button: '拼接并导出', type: 'video/mp4' },
  { id: 'mute', label: '静音', button: '静音并导出', type: 'video/mp4' },
  { id: 'extract-audio', label: '提取音频', button: '提取音频并导出', type: 'audio/mpeg' },
  { id: 'replace-audio', label: '音视频合成', button: '音视频合成并导出', type: 'video/mp4' },
  { id: 'gif', label: 'GIF', button: 'GIF并导出', type: 'image/gif' },
  { id: 'subtitle-region', button: '🧹 开始去除固定区域字幕', type: 'video/mp4' },
];
const selected = args.find(value => value.startsWith('--actions='))?.slice(10).split(',');
assert.ok(!selected || (selected.length > 0 && new Set(selected).size === selected.length && selected.every(id => allActions.some(action => action.id === id))), 'KNOWN_UNIQUE_ACTIONS_REQUIRED');
const actions = allActions.filter(action => selected ? selected.includes(action.id) : (action.id !== 'gif' || args.includes('--include-gif')));
if (mode === 'plan') {
  console.log(JSON.stringify({ mode, networkRequests: 0, actions: actions.map(({ id }) => id),
    command: 'node scripts/verify-toolbox-local-media-ui.mjs --execute --run-id=<unique-run>',
    scope: 'Real file inputs and button clicks only. Existing synthetic 2-second FFmpeg video/WAV; no model requests or history deletion. GIF requires its visible UI first.',
    session: 'LOCAL_NAV_ADMIN_TOKEN in memory; LOCAL_NAV_ORIGIN only 127.0.0.1:5000 or :5002' }, null, 2));
  process.exit(0);
}
const runId = args.find(value => value.startsWith('--run-id='))?.slice(9);
assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId), 'UNIQUE_RUN_ID_REQUIRED');
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_PREVIEW_ONLY');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.ok(token, 'NORMAL_ADMIN_SESSION_REQUIRED');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.supabaseUrl.replace(/\/$/u, ''), 'http://127.0.0.1:54321', 'LOCAL_DATABASE_ONLY');
const out = path.resolve('.codex-evidence/toolbox-local-media-real-e2e-20260903', runId);
await fs.mkdir(out, { recursive: true });
const reportPath = path.join(out, `${mode}.json`);
const report = { runId, mode, origin, at: new Date().toISOString(), passed: false, actions: [],
  source: 'Existing synthetic FFmpeg testsrc and sine fixtures from 2026-09-02; no private or new remote media',
  generationRequests: 0, localProcessRequests: 0, blockedRequests: [], pageErrors: [], uiIssues: [], mutations: [] };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
const clean = value => String(value || '').split(token).join('[redacted]').split(runtime.serviceRoleKey).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').slice(0, 600);
const sha = value => createHash('sha256').update(value).digest('hex');
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const run = promisify(execFile);
const ffmpeg = path.resolve('node_modules/ffmpeg-static/ffmpeg.exe');
const ffprobe = path.resolve('node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe');
const fixtureRoot = path.resolve('.tmp-e2e/local-media-real-e2e/2026-09-02T05-30-25-701Z');
const [videoBytes, audioBytes] = await Promise.all([fs.readFile(path.join(fixtureRoot, 'input.mp4')), fs.readFile(path.join(fixtureRoot, 'input.wav'))]);
const probe = async filename => {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,duration', '-of', 'json', filename], { timeout: 30000, windowsHide: true });
  return JSON.parse(stdout);
};
const sourceMetadata = await probe(path.join(fixtureRoot, 'input.mp4'));
assert.ok(sourceMetadata.streams.some(item => item.codec_type === 'video') && sourceMetadata.streams.some(item => item.codec_type === 'audio'), 'FIXTURE_REQUIRES_VIDEO_AND_AUDIO');
assert.ok(Number(sourceMetadata.format.duration) >= 1.9 && Number(sourceMetadata.format.duration) <= 2.2, 'EXPECTED_TWO_SECOND_FIXTURE');
report.fixture = { videoSha256: sha(videoBytes), audioSha256: sha(audioBytes), videoBytes: videoBytes.length, audioBytes: audioBytes.length, metadata: sourceMetadata };
const localRows = async (table, select, filters, count = false) => {
  const url = new URL(`${runtime.supabaseUrl}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}`, ...(count ? { Prefer: 'count=exact' } : {}) }, signal: AbortSignal.timeout(20000) });
  const body = await response.json(); assert.ok(response.ok && Array.isArray(body), `LOCAL_READ_FAILED_${table}`);
  return count ? Number(response.headers.get('content-range')?.split('/').at(-1)) : body;
};
let browser, page, activeAction = null, activeResult = null, fatal;
const waitFor = async (callback, label, timeout = 45000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fatal) throw fatal;
    if (await callback()) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw Error(`WAIT_FAILED_${label}`);
};
try {
  const auth = await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  const authBody = await auth.json();
  assert.ok(auth.status === 200 && authBody.user?.role === 'admin' && authBody.user.status !== 'disabled', 'CURRENT_ADMIN_REQUIRED');
  const user = authBody.user;
  report.balanceBefore = (await localRows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0];
  report.walletOperationsBefore = await localRows('wallet_operations', 'id', { user_id: `eq.${user.id}`, limit: '0' }, true);
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true, serviceWorkers: 'block' });
  await context.addInitScript(({ origin, token, user }) => {
    if (location.origin === origin) {
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1');
      globalThis.__mediaRevocations = [];
      const revoke = URL.revokeObjectURL;
      URL.revokeObjectURL = url => { globalThis.__mediaRevocations.push(url); revoke(url); };
    }
  }, { origin, token, user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    if (mode !== 'execute' || url.origin !== origin || url.pathname !== '/api/video/local-media/process' || method !== 'POST') {
      if (/generate|compile-script|chat|llm|\/extract/u.test(url.pathname)) report.generationRequests++;
      report.blockedRequests.push({ method, path: url.origin === origin ? url.pathname : '[external]' });
      fatal = Error('UNEXPECTED_WRITE_BLOCKED'); return route.abort();
    }
    try {
      assert.ok(activeAction && !activeResult, 'UNEXPECTED_OR_DUPLICATE_LOCAL_SUBMIT');
      const headers = request.headers();
      assert.equal(headers.authorization, `Bearer ${token}`, 'NORMAL_SESSION_HEADER_REQUIRED');
      const form = await new Request(origin + url.pathname, { method: 'POST', headers: { 'Content-Type': headers['content-type'] }, body: request.postDataBuffer() }).formData();
      assert.equal(form.get('action'), activeAction.id, 'UI_ACTION_REQUEST_MISMATCH');
      const videos = form.getAll('videos');
      assert.equal(videos.length, activeAction.id === 'concat' ? 2 : 1);
      for (const file of videos) assert.equal(sha(Buffer.from(await file.arrayBuffer())), sha(videoBytes), 'ONLY_EXISTING_TEST_VIDEO_ALLOWED');
      if (activeAction.id === 'replace-audio') assert.equal(sha(Buffer.from(await form.get('audio').arrayBuffer())), sha(audioBytes));
      const entry = { action: activeAction.id, at: new Date().toISOString(), state: 'dispatched', videoCount: videos.length,
        startSeconds: form.get('startSeconds'), endSeconds: form.get('endSeconds'), subtitleRegion: form.get('subtitleRegion') };
      activeResult = entry; report.mutations.push(entry); report.localProcessRequests++;
      const marker = path.join(out, `${activeAction.id}.dispatch.json`);
      await fs.writeFile(marker, JSON.stringify(entry, null, 2), { flag: 'wx' });
      await save();
      const started = Date.now();
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 120000 });
      const bytes = await response.body();
      entry.status = response.status(); entry.contentType = response.headers()['content-type']; entry.contentLength = response.headers()['content-length'];
      entry.disposition = Boolean(response.headers()['content-disposition']?.startsWith('attachment;'));
      entry.bytes = bytes.length; entry.sha256 = sha(bytes); entry.durationMs = Date.now() - started; entry.state = 'responded';
      if (response.status() !== 200) entry.error = clean(bytes.toString('utf8'));
      await fs.writeFile(marker, JSON.stringify(entry, null, 2)); await save();
      await route.fulfill({ response });
    } catch (error) { fatal = Error(clean(error.message)); await route.abort().catch(() => undefined); }
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
  for (const action of actions) {
    activeAction = action; activeResult = null;
    const actionReport = { action: action.id, passed: false }; report.actions.push(actionReport);
    try {
      const subtitle = action.id === 'subtitle-region';
      const pathname = subtitle ? '/tools/video/aliyun-erase-subtitles' : '/tools/video/video-edit';
      const navStarted = Date.now();
      // Each action starts with a new document, so a prior object URL cannot be mistaken for its result.
      await page.goto(origin + pathname, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const main = page.locator(`[data-testid="${subtitle ? 'subtitle-remover-workbench' : 'local-video-editor'}"]:visible`);
      await main.waitFor({ timeout: 45000 }); actionReport.openMs = Date.now() - navStarted;
      if (!subtitle) await main.getByRole('button', { name: action.label, exact: true }).click();
      const fileInput = main.locator('input[type="file"][accept^="video/"]');
      await fileInput.setInputFiles(action.id === 'concat'
        ? [{ name: 'fixture-a.mp4', mimeType: 'video/mp4', buffer: videoBytes }, { name: 'fixture-b.mp4', mimeType: 'video/mp4', buffer: videoBytes }]
        : { name: 'fixture-a.mp4', mimeType: 'video/mp4', buffer: videoBytes });
      await waitFor(() => main.locator('video').first().evaluate(element => element.readyState >= 1 && Number.isFinite(element.duration) && element.duration > 0), 'source-metadata');
      if (action.id === 'trim' || action.id === 'gif') {
        await main.locator('input[type="number"]').nth(0).fill('0.2');
        await main.locator('input[type="number"]').nth(1).fill('1.2');
      }
      if (action.id === 'replace-audio') await main.locator('input[type="file"][accept="audio/*"]').setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: audioBytes });
      if (subtitle) await main.getByRole('button', { name: /底部 1\/4/u }).click();
      const submit = main.getByRole('button', { name: action.button, exact: true });
      assert.equal(await submit.isEnabled(), true, 'VISIBLE_ACTION_NOT_ENABLED');
      if (mode === 'inspect') {
        actionReport.passed = true; actionReport.submitReady = true; await save(); continue;
      }
      await submit.click();
      await waitFor(() => activeResult?.state === 'responded', 'local-process-response', 130000);
      assert.equal(activeResult.status, 200, activeResult.error || 'LOCAL_PROCESS_FAILED');
      assert.ok(activeResult.contentType?.startsWith(action.type), 'OUTPUT_CONTENT_TYPE');
      assert.equal(Number(activeResult.contentLength), activeResult.bytes, 'COMPLETE_RESPONSE_LENGTH');
      assert.ok(activeResult.bytes > 100 && activeResult.disposition, 'NONEMPTY_DOWNLOAD_REQUIRED');
      const link = main.getByRole('link', { name: subtitle ? '下载处理后视频' : '下载真实处理结果', exact: true });
      await link.waitFor();
      const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
      await link.click(); const download = await downloadPromise;
      const extension = action.type === 'audio/mpeg' ? 'mp3' : action.type === 'image/gif' ? 'gif' : 'mp4';
      const outputPath = path.join(out, `${action.id}.${extension}`);
      await download.saveAs(outputPath); assert.equal(await download.failure(), null);
      const downloaded = await fs.readFile(outputPath);
      assert.equal(sha(downloaded), activeResult.sha256, 'BROWSER_DOWNLOAD_MATCHES_HTTP_BYTES');
      const metadata = await probe(outputPath), streams = metadata.streams;
      let duration = Number(metadata.format.duration);
      if (action.id === 'gif') {
        const { stdout } = await run(ffprobe, ['-v', 'error', '-show_frames', '-select_streams', 'v:0', '-show_entries', 'frame=pkt_duration_time', '-of', 'json', outputPath], { timeout: 30000, windowsHide: true });
        const frames = JSON.parse(stdout).frames;
        assert.ok(Array.isArray(frames) && frames.length > 1, 'ANIMATED_GIF_FRAMES_REQUIRED');
        duration = frames.reduce((total, frame) => total + Number(frame.pkt_duration_time), 0);
        metadata.gifFrames = frames.length; metadata.gifDuration = duration;
      }
      assert.ok(Number.isFinite(duration) && duration > 0);
      if (action.id === 'trim' || action.id === 'gif') assert.ok(duration >= 0.85 && duration <= 1.25, 'TRIM_DURATION');
      else if (action.id === 'concat') {
        assert.ok(duration >= 3.9 && duration <= 4.3, 'CONCAT_DURATION');
        const stream = streams.find(item => item.codec_type === 'video'); assert.equal(stream.width, 1280); assert.equal(stream.height, 720);
      } else assert.ok(duration >= 1.8 && duration <= 2.3, 'DURATION_PRESERVED');
      if (action.id === 'mute' || action.id === 'gif') assert.equal(streams.some(item => item.codec_type === 'audio'), false, 'NO_AUDIO_EXPECTED');
      else assert.ok(streams.some(item => item.codec_type === 'audio'), 'AUDIO_REQUIRED');
      if (action.id === 'extract-audio') assert.equal(streams.some(item => item.codec_type === 'video'), false);
      else assert.ok(streams.some(item => item.codec_type === 'video'));
      await run(ffmpeg, ['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      if (action.id !== 'gif') {
        const player = main.locator(action.id === 'extract-audio' ? 'audio' : 'video').last();
        await waitFor(() => player.evaluate(element => element.readyState >= 2 && element.duration > 0), 'result-player-loaded');
        await player.evaluate(async element => { element.muted = true; element.currentTime = 0; await element.play(); });
        await waitFor(() => player.evaluate(element => element.currentTime >= 0.1), 'result-playing');
        await player.evaluate(element => element.pause()); actionReport.played = true;
      } else {
        assert.ok(await main.locator('img').last().evaluate(element => element.complete && element.naturalWidth > 0));
        await main.locator('img').last().evaluate(element => new Promise((resolve, reject) => {
          const freshImage = new Image();
          freshImage.onload = () => freshImage.naturalWidth > 0 ? resolve(true) : reject(Error('GIF_EMPTY_IMAGE'));
          freshImage.onerror = () => reject(Error('GIF_FRESH_IMAGE_LOAD_FAILED'));
          freshImage.src = element.src;
        }));
        actionReport.imageLoaded = true; actionReport.freshImageLoaded = true;
      }
      const sourcePlayer = main.locator('video').first();
      actionReport.sourcePreviewNotRevoked = await sourcePlayer.evaluate(element => !globalThis.__mediaRevocations.includes(element.src));
      assert.equal(actionReport.sourcePreviewNotRevoked, true, 'SOURCE_PREVIEW_BLOB_REVOKED_WHILE_DISPLAYED');
      // fetch(blob:) is disallowed by the app's connect-src policy. Exercise the
      // actual allowed media-src path, including a new load after result creation.
      await sourcePlayer.evaluate(element => { element.load(); });
      await waitFor(() => sourcePlayer.evaluate(element => element.readyState >= 2 && !element.error && element.duration > 0), 'source-reload-after-result');
      await sourcePlayer.evaluate(async element => { element.muted = true; element.currentTime = 0; await element.play(); });
      await waitFor(() => sourcePlayer.evaluate(element => element.currentTime >= 0.1), 'source-playing-after-result');
      await sourcePlayer.evaluate(element => element.pause());
      actionReport.sourcePreviewReadableAfterResult = true;
      Object.assign(actionReport, { passed: true, httpStatus: activeResult.status, bytes: downloaded.length, sha256: sha(downloaded), download: true, decodes: true, metadata, durationMs: activeResult.durationMs });
      await page.screenshot({ path: path.join(out, `${action.id}.png`), fullPage: true });
    } catch (error) {
      actionReport.error = clean(error.message);
      await page.screenshot({ path: path.join(out, `${action.id}-failure.png`), fullPage: true }).catch(() => undefined);
      if (fatal || activeResult?.state === 'dispatched') throw error;
    }
    await save();
  }
  report.balanceAfter = (await localRows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0];
  report.walletOperationsAfter = await localRows('wallet_operations', 'id', { user_id: `eq.${user.id}`, limit: '0' }, true);
  assert.deepEqual(report.balanceAfter, report.balanceBefore, 'ACCOUNT_BALANCE_CHANGED');
  assert.equal(report.walletOperationsAfter, report.walletOperationsBefore, 'WALLET_OPERATION_COUNT_CHANGED');
  assert.equal(report.generationRequests, 0); assert.equal(report.blockedRequests.length, 0); assert.equal(report.pageErrors.length, 0);
  assert.ok(report.actions.every(action => action.passed), 'ONE_OR_MORE_UI_ACTIONS_FAILED');
  assert.equal(report.uiIssues.length, 0, 'VISIBLE_SOURCE_PREVIEW_REVOKED');
  assert.equal(report.localProcessRequests, mode === 'execute' ? actions.length : 0);
  report.walletOperationDelta = 0; report.passed = true;
} catch (error) { report.failure = clean(error.message); process.exitCode = 1; }
finally { if (browser) await browser.close(); await save(); }
console.log(JSON.stringify({ passed: report.passed, mode, report: reportPath, actionsPassed: report.actions.filter(action => action.passed).length, localProcessRequests: report.localProcessRequests, generationRequests: report.generationRequests, failure: report.failure }));
