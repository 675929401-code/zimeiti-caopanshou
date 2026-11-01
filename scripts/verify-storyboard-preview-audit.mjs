#!/usr/bin/env node
// Product-read-only audit: the served UI is real; every account, model, API mutation
// and media response below is synthetic and held in this process/browser memory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { installStoryboardBrowserFixture } from './storyboard-browser-fixture.mjs';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

const origin = 'http://127.0.0.1:5000';
const output = path.resolve('.codex-evidence/storyboard-delivery-audit-20261023/preview');
const require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const recordId = hash('preview-audit-synthetic-image');
const assetId = 'preview-audit-owned-image';
const storageKey = 'fixture/storyboard/preview-audit.png';
const imageUrl = 'https://media.storyboard.test/__preview_fixture__/image.png';
const mediaBase = origin + '/__preview_fixture__/video.mp4';
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(data) });
const report = { schema: 'storyboard-preview-audit.v1', checkedAt: new Date().toISOString(), auditCompleted: false,
  scope: 'Read-only product audit of the served build; all browser API/account/provider/media traffic is synthetic. This is not current-source release acceptance.',
  productFilesModified: false, providerCalls: 0, realDatabaseCalls: 0, forwardedBrowserApiRequests: 0, forwardedBrowserWrites: 0, forwardedExternalRequests: 0,
  checks: [], blocked: [], sessions: [] };
const imageModel = { id: 'gpt-image-2-pro', displayName: 'GPT-Image-2 · 渠道A pro', variantLabel: 'A', publicPrice: 0.2,
  capabilities: { family: 'gpt', supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ['1K', '2K', '4K'], defaultResolution: '2K' } };
const videoModel = { id: 'video-720p', displayName: '图生视频 720p', publicPrice: 0.4,
  capabilities: { type: 'video', durationMode: 'fixed', minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10],
    supportsImageInput: true, requiresImage: true, resolutionTier: '720p', resolutionOptions: ['720p'], defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1'], workspaceSurfaces: ['storyboard', 'video-page'] } };
let browser;
let media;

async function identity() {
  const response = await fetch(origin + '/api/version', { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, 'VERSION_READ_FAILED');
  const served = await response.json();
  const current = computeLocalBuildFingerprint(process.cwd());
  const diskVersion = JSON.parse((await readFile('public/version.json', 'utf8')).replace(/^\uFEFF/u, ''));
  const candidates = [];
  for (const dist of ['.next', '.next-local-acceptance', '.next-local-acceptance-next']) {
    try {
      const buildId = (await readFile(path.join(dist, 'BUILD_ID'), 'utf8')).trim();
      const receipt = JSON.parse((await readFile(path.join(dist, 'local-source-fingerprint.v1.json'), 'utf8')).replace(/^\uFEFF/u, ''));
      candidates.push({ dist, buildId, receiptBuildId: receipt.buildId, receiptFingerprint: receipt.fingerprint,
        currentFingerprintMatches: receipt.fingerprint === current.fingerprint && receipt.fileCount === current.fileCount });
    } catch { /* A missing alternate build is recorded by its absence. */ }
  }
  const runningLatest = served.sourceVersion === diskVersion.sourceVersion && candidates.some(candidate => candidate.buildId === served.buildId && candidate.receiptBuildId === served.buildId && candidate.currentFingerprintMatches);
  return { served: { sourceVersion: served.sourceVersion, buildId: served.buildId }, diskSourceVersion: diskVersion.sourceVersion,
    currentFingerprint: current.fingerprint, currentFileCount: current.fileCount, candidates, runningLatest,
    interpretation: runningLatest ? 'Served build matches disk source fingerprint.' : 'Behavior evidence applies only to served BuildID. Current source acceptance is not claimed.' };
}
function isStatic(url) {
  if (url.pathname === '/storyboard-workbench' || url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return false;
  try { const root = path.resolve('public'); const file = path.resolve(root, '.' + decodeURIComponent(url.pathname)); return file.startsWith(root + path.sep) && statSync(file).isFile(); } catch { return false; }
}
async function save() { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
async function check(id, page, run) {
  const result = { id, reproduced: false, startedAt: new Date().toISOString() };
  try { Object.assign(result, await run()); } catch (error) { result.auditError = { name: error.name, message: String(error.message).slice(0, 1800) }; }
  result.screenshot = id + '.png';
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, result.screenshot), fullPage: false }).catch(error => { result.screenshotError = error.message; });
  report.checks.push(result); await save(); console.log(JSON.stringify(result));
}
async function until(test, label) {
  const end = Date.now() + 20000;
  while (!test() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 75));
  assert.ok(test(), label);
}
async function prepare(name, { generateImage = true, holdImage = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const state = { name, tickets: [], mediaRequests: [], images: [], videos: [], pageErrors: [], consoleErrors: [],
    expireMedia: false, failDownload: false, holdImage, imageGate: null, imageRelease: null };
  if (holdImage) state.imageGate = new Promise(resolve => { state.imageRelease = resolve; });
  await page.addInitScript(() => { window.__previewAuditRejections = []; window.addEventListener('unhandledrejection', event => { window.__previewAuditRejections.push(String(event.reason?.message || event.reason)); }); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.href === imageUrl) return route.fulfill({ contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: state.png });
    if (url.origin === origin && url.pathname === '/__preview_fixture__/video.mp4') {
      state.mediaRequests.push({ query: url.search, range: request.headers().range || null, expired: state.expireMedia, at: Date.now() });
      if (state.expireMedia) return json(route, { error: 'Synthetic expired media ticket' }, 401);
      const headers = { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
      const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers().range || '');
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || media.length - 1), media.length - 1);
        if (start >= media.length) return route.fulfill({ status: 416, headers: { ...headers, 'content-range': `bytes */${media.length}` }, body: '' });
        return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${media.length}`, 'content-length': String(end - start + 1) }, body: media.subarray(start, end + 1) });
      }
      return route.fulfill({ status: 200, headers: { ...headers, 'content-length': String(media.length) }, body: media });
    }
    if (url.origin === origin && method === 'GET' && isStatic(url)) return route.continue();
    report.blocked.push({ session: name, path: url.pathname, method, kind: url.origin !== origin ? 'external' : url.pathname.startsWith('/api/') ? 'unconfigured-api' : 'other' });
    if (url.origin === origin && url.pathname.startsWith('/api/')) return json(route, { error: 'Unconfigured synthetic endpoint', tasks: [], records: [], models: [], assets: [], projects: [] }, 404);
    return route.abort('blockedbyclient');
  });
  const fixture = await installStoryboardBrowserFixture(page, { origin });
  await page.route('**/api/cover-models**', route => json(route, { models: [imageModel] }));
  await page.route('**/api/video/models**', route => json(route, { models: [videoModel] }));
  for (const [endpoint, data] of Object.entries({ '/api/video/history': { tasks: [] }, '/api/image-workbench/failure-history': { records: [], nextPage: null },
    '/api/storyboard/visual-assets': { assets: [], nextOffset: null }, '/api/cash/balance': { balance: 1000 }, '/api/video/active-tasks': { activeTasks: [] },
    '/api/settings/video-page': { config: {} } })) await page.route(`**${endpoint}**`, route => json(route, data));
  await page.route('**/api/image/generate', async route => {
    const body = route.request().postDataJSON(); state.images.push(body);
    const [width, height] = ({ '16:9': [320, 180], '9:16': [180, 320], '1:1': [256, 256] })[body.aspectRatio];
    state.png = await sharp({ create: { width, height, channels: 3, background: '#7054d8' } }).png().toBuffer();
    if (state.imageGate) await state.imageGate;
    return json(route, { recordId, state: 'completed', cashCharged: 0.2, billed: true,
      images: [{ recordId, width, height, url: imageUrl, assetId, storageKey, mediaAvailable: true, canRecover: false, dimensionsVerified: true }] }).catch(() => undefined);
  });
  await page.route('**/api/storyboard/image**', route => json(route, { assetId, storageKey, url: imageUrl }));
  await page.route('**/api/video/generate', route => { state.videos.push(route.request().postDataJSON()); return json(route, { status: 'completed', task_id: 'fixture-preview-video', video_url: mediaBase + '?ticket=initial', price: 0.4, billing_state: 'settled' }); });
  await page.route('**/api/video/access-ticket**', route => {
    const url = new URL(route.request().url());
    state.tickets.push({ scope: url.searchParams.get('scope'), source: url.searchParams.get('source'), at: Date.now() });
    if (state.failDownload && url.searchParams.get('scope') === 'download') return json(route, { error: 'Synthetic download ticket unavailable' }, 503);
    return json(route, { url: mediaBase + '?ticket=' + state.tickets.length });
  });
  page.on('pageerror', error => state.pageErrors.push({ name: error.name, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text().slice(0, 250)); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin + '/storyboard-workbench', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.sbw-shot-card').first(); await card.waitFor();
  await page.locator('.sbw-image-model-list button[data-model-selectable="true"]').first().click();
  await page.locator('.sbw-video-model-list button').first().click();
  for (const label of ['图片比例', '视频比例']) await page.locator(`.sbw-ratio-control[aria-label="${label}"] button`).filter({ hasText: /^16:9$/u }).click();
  await card.locator('textarea[aria-label$="生图提示词"]').fill('Synthetic preview audit: purple background and one subject.');
  await card.locator('textarea[aria-label$="视频提示词"]').fill('The subject turns slowly while the camera remains still.');
  if (generateImage) {
    await card.locator('.is-image-command').click();
    await card.locator('.sbw-shared-media-frame.has-result img').waitFor();
    await card.locator('.sbw-shared-media-frame img').evaluate(image => image.decode());
  }
  return { context, page, card, state, fixture };
}
async function mediaState(page) { return page.locator('video').evaluateAll(nodes => nodes.map(video => ({ scope: video.closest('.sbw-lightbox') ? 'lightbox' : 'card', paused: video.paused, currentTime: video.currentTime, ended: video.ended, readyState: video.readyState, errorCode: video.error?.code || null, currentSrc: video.currentSrc }))); }

await mkdir(output, { recursive: true });
try {
  report.runtimeBefore = await identity();
  report.sourceHashes = Object.fromEntries(await Promise.all(['src/components/storyboard-workbench.tsx', 'src/lib/video-access-ticket.ts', 'scripts/storyboard-browser-fixture.mjs', 'scripts/verify-storyboard-preview-audit.mjs'].map(async file => [file, hash(await readFile(file))])));
  const rendered = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  assert.equal(rendered.status, 0, 'SYNTHETIC_MEDIA_RENDER_FAILED'); media = rendered.stdout;
  report.syntheticMedia = { codec: 'H264/AAC', seconds: 20, bytes: media.length, sha256: hash(media), memoryOnly: true };
  browser = await chromium.launch({ channel: 'msedge', headless: true }); report.browser = { name: 'Edge', version: browser.version() };
  const session = await prepare('completed-video');
  const { page, card, state, context } = session;
  try {
    await card.locator('.is-video-command').click();
    await until(() => state.videos.length === 1, 'SYNTHETIC_VIDEO_SUBMIT_MISSING');
    await card.locator('video').waitFor();
    await page.waitForFunction(() => document.querySelector('.sbw-shot-card video')?.readyState >= 2);
    await page.waitForTimeout(400);
    await check('card-and-lightbox-play-simultaneously', page, async () => {
      await card.locator('video').evaluate(async video => { video.currentTime = 2; video.muted = false; await video.play(); });
      await card.getByRole('button', { name: '放大播放视频', exact: true }).click();
      await page.waitForFunction(() => (document.querySelector('.sbw-lightbox video')?.currentTime || 0) > 0.2);
      const videos = await mediaState(page); const active = videos.filter(video => !video.paused && !video.ended);
      return { reproduced: active.length === 2, videos, expected: 'Only the enlarged player remains active.' };
    });
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await card.locator('video').evaluate(video => video.pause());
    await check('expired-lightbox-ticket-has-no-recovery', page, async () => {
      state.expireMedia = true; const ticketsBefore = state.tickets.length, mediaBefore = state.mediaRequests.length;
      await card.getByRole('button', { name: '放大播放视频', exact: true }).click();
      await until(() => state.mediaRequests.slice(mediaBefore).some(request => request.expired), 'INJECTED_401_NOT_REQUESTED');
      await page.waitForFunction(() => Boolean(document.querySelector('.sbw-lightbox video')?.error));
      await page.waitForTimeout(1500);
      const dialogText = await page.locator('.sbw-lightbox').innerText();
      const errorFeedback = /失败|错误|不可用|过期|重试|重新加载/u.test(dialogText);
      return { reproduced: state.tickets.length === ticketsBefore && !errorFeedback, ticketsBefore, ticketsAfter: state.tickets.length,
        injectedMediaResponses: state.mediaRequests.slice(mediaBefore), dialogText, errorFeedback, videos: await mediaState(page),
        expected: 'Expired playback access is renewed or a visible actionable error is shown.' };
    });
    await page.getByRole('button', { name: '关闭预览', exact: true }).click(); state.expireMedia = false;
    await check('download-ticket-failure-is-unhandled', page, async () => {
      state.failDownload = true; const noticesBefore = await page.locator('.sbw-notice').allTextContents();
      const rejectionsBefore = await page.evaluate(() => window.__previewAuditRejections.length);
      await card.locator('button[title="下载视频"]').click();
      await until(() => state.tickets.some(ticket => ticket.scope === 'download'), 'DOWNLOAD_TICKET_REQUEST_MISSING');
      await page.waitForTimeout(800);
      const noticesAfter = await page.locator('.sbw-notice').allTextContents();
      const rejections = await page.evaluate(start => window.__previewAuditRejections.slice(start), rejectionsBefore);
      return { reproduced: rejections.some(message => message.includes('Synthetic download ticket unavailable')) && JSON.stringify(noticesBefore) === JSON.stringify(noticesAfter),
        noticesBefore, noticesAfter, rejections, expected: 'A failed download is handled and surfaced to the user.' };
    });
  } finally { report.sessions.push({ name: state.name, imageRequests: state.images.length, videoRequests: state.videos.length, tickets: state.tickets, pageErrors: state.pageErrors }); await context.close(); }
  const pending = await prepare('image-pending-paste', { generateImage: false, holdImage: true });
  try {
    await check('paste-bypasses-pending-image-input-lock', pending.page, async () => {
      const input = pending.card.locator('textarea[aria-label$="生图提示词"]');
      const before = await input.inputValue();
      await pending.page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'Changed clipboard prompt while image generation is running.' } }); });
      await pending.card.locator('.is-image-command').click();
      await until(() => pending.state.images.length === 1, 'PENDING_IMAGE_SUBMIT_MISSING');
      await pending.page.waitForFunction(() => document.querySelector('textarea[aria-label$="生图提示词"]')?.disabled === true);
      const disabledBefore = await input.isDisabled();
      const button = pending.card.getByRole('button', { name: /粘贴分段\d+生图提示词/u });
      const pasteDisabled = await button.isDisabled();
      if (!pasteDisabled) await button.click();
      await pending.page.waitForTimeout(350);
      const after = await input.inputValue();
      return { reproduced: disabledBefore && !pasteDisabled && before !== after, disabledBefore, pasteDisabled, before, after, submittedPrompt: pending.state.images[0].prompt,
        expected: 'Pending request prompt cannot be changed through the paste button while its editor is locked.' };
    });
  } finally { pending.state.imageRelease?.(); await pending.context.close(); report.sessions.push({ name: pending.state.name, imageRequests: pending.state.images.length, pageErrors: pending.state.pageErrors }); }
  report.runtimeAfter = await identity();
  report.servedBuildUnchanged = report.runtimeBefore.served.buildId === report.runtimeAfter.served.buildId;
  report.auditCompleted = report.checks.length === 4 && report.checks.every(result => !result.auditError);
} catch (error) { report.fatal = { name: error.name, message: String(error.message).slice(0, 2000) }; process.exitCode = 1; }
finally { await browser?.close(); await save(); console.log(JSON.stringify({ auditCompleted: report.auditCompleted, checks: report.checks.map(({ id, reproduced, auditError }) => ({ id, reproduced, auditError })), fatal: report.fatal, report: path.join(output, 'report.json') })); }
