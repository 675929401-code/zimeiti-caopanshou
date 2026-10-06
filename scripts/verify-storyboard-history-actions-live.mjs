import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'Local preview origin required');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'Normal administrator session required');
const runId = process.argv.find(value => value.startsWith('--run-id='))?.slice(9);
assert.match(runId || '', /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u, 'Fresh --run-id required');
const taskId = 'vt_db4004162c95a2b86cddc682c33a1239052e3d65';
const imageAssetId = '3b9927b2-a7f7-4731-8727-5a7687c47a5f';
let currentKey, historyKey;
const output = `.codex-evidence/storyboard-history-actions-20260903/${runId}`;
await fs.mkdir(output, { recursive: true });
const reportPath = `${output}/report.json`;
const report = { at: new Date().toISOString(), origin, source: 'Existing completed owned video task and its owned reference image; reconstructed single-card browser draft, not a recovered server project.',
  originalTaskId: taskId, originalImageAssetId: imageAssetId, originalImagePromptAvailable: false,
  persistenceScope: 'Same isolated browser context and origin only; no server storyboard history endpoint exists.',
  stages: [], apiErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], imageReuseReads: [], generationRequests: 0, unexpectedMutations: 0, passed: false };
await fs.writeFile(reportPath, JSON.stringify(report), { flag: 'wx' });
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const safeError = error => ({ name: String(error?.name || 'Error').slice(0, 50), message: String(error?.message || error).split(token).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, 220) });
let browser, context, page, run, originalCard, allowedImageKey, activeStage = 'prepare';
let badNavigation = false;
async function stage(name, work) {
  activeStage = name; const started = Date.now();
  const result = { name, passed: false };
  try { Object.assign(result, await work()); result.passed = true; }
  catch (error) { result.error = safeError(error); }
  result.elapsedMs = Date.now() - started; report.stages.push(result); await save();
  console.log(JSON.stringify({ stage: name, passed: result.passed, elapsedMs: result.elapsedMs }));
  return result.passed;
}
async function current() { return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), currentKey); }
async function waitSaved(cardCount, secondPrompt) {
  await page.waitForFunction(({ key, cardCount, secondPrompt }) => {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value?.cards?.length === cardCount && (secondPrompt === undefined || value.cards[1]?.videoPrompt === secondPrompt);
  }, { key: currentKey, cardCount, secondPrompt }, { timeout: 10000 });
}
const card = () => page.locator('.sbw-shot-card').first();
async function loadPage() {
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('.sbw-shot-card').first().waitFor({ timeout: 30000 });
  await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) || 'null')?.id === id, { key: currentKey, id: run.id }, { timeout: 15000 });
}
async function expectOriginalMedia() {
  const image = card().getByAltText('镜头1故事板'); await image.waitFor({ state: 'visible', timeout: 30000 });
  const pixels = await image.evaluate(async element => { await element.decode(); return { width: element.naturalWidth, height: element.naturalHeight }; });
  assert.ok(pixels.width > 0 && pixels.height > 0);
  assert.equal(await card().getByRole('textbox', { name: '镜头1视频提示词', exact: true }).inputValue(), originalCard.videoPrompt);
  return pixels;
}
async function ensureExpanded() {
  const expand = card().getByRole('button', { name: '展开镜头1视频区域', exact: true });
  if (await expand.count()) await expand.click();
  await card().locator('video').waitFor({ state: 'visible', timeout: 20000 });
}
async function downloadFromButton(title, extension) {
  const pending = page.waitForEvent('download', { timeout: 25000 }).then(value => ({ download: value }), error => ({ error }));
  await card().getByTitle(title, { exact: true }).click();
  const outcome = await pending;
  assert.equal(new URL(page.url()).origin, origin, 'Download navigated away from the workbench');
  if (outcome.error) throw outcome.error;
  const failure = await outcome.download.failure(); assert.equal(failure, null, 'Browser download failed');
  const destination = path.resolve(output, `existing-${extension}.${extension}`);
  await outcome.download.saveAs(destination);
  const bytes = await fs.readFile(destination); assert.ok(bytes.length > 1000, 'Downloaded file is empty');
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), artifact: destination, suggestedExtension: path.extname(outcome.download.suggestedFilename()), stayedOnWorkbench: true };
}

try {
  const headers = { Authorization: `Bearer ${token}` };
  const identity = await fetch(`${origin}/api/auth/me`, { headers, signal: AbortSignal.timeout(30000) });
  const auth = await identity.json(); assert.ok(identity.ok && auth.user?.role === 'admin', 'Normal administrator session required');
  assert.ok(typeof auth.user.id === 'string' && auth.user.id, 'Normal session user id required');
  currentKey = `storyboard_prompt_workbench_current_v2:user:${encodeURIComponent(auth.user.id)}`;
  historyKey = `storyboard_prompt_workbench_history_v2:user:${encodeURIComponent(auth.user.id)}`;
  report.normalAdmin = true;
  const historyResponse = await fetch(`${origin}/api/video/history?limit=200`, { headers, signal: AbortSignal.timeout(30000) });
  const history = await historyResponse.json(); assert.ok(historyResponse.ok && Array.isArray(history.tasks), 'Owned video history unavailable');
  const task = history.tasks.find(value => value.id === taskId);
  assert.ok(task && task.status === 'completed' && task.batchTopic === 'storyboard-workbench' && task.videoUrl && task.prompt, 'Original completed storyboard task missing from owned history');
  const reference = new URL(task.firstFrameUrl || task.referenceImageUrl);
  assert.equal(reference.protocol, 'https:'); assert.equal(reference.username, ''); assert.equal(reference.password, '');
  allowedImageKey = decodeURIComponent(reference.pathname.replace(/^\//u, '')); assert.ok(allowedImageKey && !allowedImageKey.split('/').includes('..'));
  originalCard = { id: `restored-${taskId}`, order: 1, imagePrompt: '', videoPrompt: task.prompt, referenceImageUrls: [],
    imageStatus: 'done', imageStorageKey: allowedImageKey, videoStatus: 'done', videoUrl: task.videoUrl, videoTaskId: task.id,
    videoTaskModelId: task.publicModelId || task.modelId, videoTaskModelName: task.modelName, videoTaskDuration: task.durationSeconds, videoProgress: 100 };
  run = { id: `restored-${task.batchId || taskId}`, title: '黄杯分镜', createdAt: Date.parse(task.createdAt), updatedAt: Date.parse(task.completedAt || task.createdAt),
    ratio: task.aspectRatio || '16:9', imageResolution: '1K', videoResolution: task.resolution || '720p', videoDuration: task.durationSeconds,
    imageModelId: '', videoModelId: task.publicModelId || task.modelId, cards: [originalCard] };
  report.originalTask = { completed: true, duration: task.durationSeconds, promptChars: task.prompt.length, promptSha256: createHash('sha256').update(task.prompt).digest('hex') };
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true, serviceWorkers: 'block' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await context.addInitScript(({ origin, token, user, run, currentKey, historyKey }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1');
    if (!sessionStorage.getItem('storyboard-existing-project-loaded')) {
      localStorage.setItem(currentKey, JSON.stringify(run)); localStorage.setItem(historyKey, JSON.stringify([run]));
      sessionStorage.setItem('storyboard-existing-project-loaded', '1');
    }
  }, { origin, token, user: auth.user, run, currentKey, historyKey });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const isGeneration = /\/api\/(?:image|video)\/generate(?:\/|$)|\/api\/(?:llm|storyboard\/compile|storyboard\/agent)$/u.test(url.pathname);
    let allowedReuse = false;
    if (url.origin === origin && url.pathname === '/api/image-workbench/persist' && method === 'POST') {
      try { const body = request.postDataJSON(); allowedReuse = Object.keys(body).length === 1 && body.storageKey === allowedImageKey; } catch {}
    }
    const advancing = ['/api/video/status', '/api/video/poll', '/api/video/stream', '/api/video/h3-lifecycle', '/api/image/status'].includes(url.pathname);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method) && !allowedReuse;
    if (isGeneration || advancing || mutation || (url.origin !== origin && request.headers().authorization?.includes(token))) {
      if (isGeneration) report.generationRequests++;
      if (mutation) report.unexpectedMutations++;
      report.blockedRequests.push({ stage: activeStage, method, path: url.origin === origin ? url.pathname : 'external' }); await route.abort('blockedbyclient');
    } else await route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push({ stage: activeStage, ...safeError(error) }));
  page.on('requestfailed', request => { const url = new URL(request.url()); report.failedRequests.push({ stage: activeStage, path: url.origin === origin ? url.pathname : 'external-media', code: request.failure()?.errorText?.slice(0, 80) }); });
  page.on('response', async response => {
    const url = new URL(response.url());
    if (response.status() >= 400) report.apiErrors.push({ stage: activeStage, path: url.origin === origin ? url.pathname : 'external-media', status: response.status() });
    if (url.origin === origin && url.pathname === '/api/image-workbench/persist' && response.request().method() === 'POST') {
      try { const body = await response.json(); report.imageReuseReads.push({ status: response.status(), reused: body.reused === true, originalAssetMatched: body.assetId === imageAssetId }); } catch {}
    }
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame() && /^https?:/u.test(frame.url()) && new URL(frame.url()).origin !== origin) badNavigation = true; });
  const loaded = await stage('owned media loaded from reconstructed original references', async () => {
    await loadPage(); const image = await expectOriginalMedia();
    await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) || 'null')?.cards[0]?.id === id, { key: currentKey, id: originalCard.id });
    return { image, cardCount: await page.locator('.sbw-shot-card').count(), originalPromptMatched: true };
  });
  if (!loaded) throw new Error('Initial original media read failed');
  await stage('open history and restore the same original media card', async () => {
    await page.getByRole('button', { name: '历史', exact: true }).click();
    const drawer = page.getByRole('complementary', { name: '分镜工作台历史' }); await drawer.waitFor({ state: 'visible' });
    assert.equal(await drawer.locator('.sbw-history-list article').count(), 1);
    await drawer.getByRole('button', { name: '恢复', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' }); await expectOriginalMedia(); return { historyEntries: 1, sameTask: (await current()).cards[0].videoTaskId === taskId };
  });
  await stage('copy the original video prompt', async () => {
    await card().getByTitle('复制视频 Prompt', { exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    // Windows clipboard transport converts LF to CRLF; preserve every other byte of text.
    const normalized = copied.replace(/\r\n/gu, '\n');
    const expected = originalCard.videoPrompt.replace(/\r\n/gu, '\n');
    assert.ok(normalized === expected, 'Copied prompt content differs beyond native line endings');
    return { exactTextAndParagraphs: true, nativeLineEndingsNormalized: copied !== normalized, copiedCharacters: copied.length, normalizedCharacters: normalized.length };
  });
  await stage('expand play and collapse the original completed video', async () => {
    await ensureExpanded();
    const video = card().locator('video'); await video.evaluate(element => { element.muted = true; });
    await page.waitForFunction(() => { const video = document.querySelector('.sbw-shot-card video'); return video && video.readyState >= 2 && video.videoWidth > 0; }, null, { timeout: 35000 });
    await video.evaluate(element => element.play());
    await page.waitForFunction(() => document.querySelector('.sbw-shot-card video')?.currentTime > 0.2, null, { timeout: 15000 });
    const playback = await video.evaluate(element => ({ width: element.videoWidth, height: element.videoHeight, duration: element.duration, currentTime: element.currentTime, readyState: element.readyState }));
    await video.evaluate(element => element.pause());
    await card().getByRole('button', { name: '收起镜头1视频区域', exact: true }).click(); assert.equal(await card().locator('video').count(), 0);
    await ensureExpanded(); return { ...playback, collapsedAndReopened: true };
  });
  await stage('add a blank card autosave refresh and reopen', async () => {
    await page.getByRole('button', { name: '添加镜头', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sbw-shot-card').length === 2);
    const text = '本次空镜头保存回读'; await page.getByRole('textbox', { name: '镜头2视频提示词', exact: true }).fill(text);
    await waitSaved(2, text);
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('textbox', { name: '镜头2视频提示词', exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByRole('textbox', { name: '镜头2视频提示词', exact: true }).inputValue(), text);
    await expectOriginalMedia();
    await page.goto(`${origin}/tools`, { waitUntil: 'domcontentloaded' }); await loadPage();
    assert.equal(await page.getByRole('textbox', { name: '镜头2视频提示词', exact: true }).inputValue(), text);
    return { automaticSave: true, refreshRetained: true, navigateAwayAndReopenRetained: true, originalMediaRetained: true };
  });
  await stage('delete only the newly added card and clear only new empty cards', async () => {
    assert.equal(await page.locator('.sbw-shot-card').count(), 2);
    await page.locator('.sbw-shot-card').nth(1).getByTitle('删除镜头', { exact: true }).click();
    await waitSaved(1);
    await page.getByRole('button', { name: '添加镜头', exact: true }).click(); await page.getByRole('button', { name: '添加镜头', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sbw-shot-card').length === 3);
    await page.getByRole('button', { name: '清理空卡', exact: true }).click(); await waitSaved(1);
    assert.equal((await current()).cards[0].videoTaskId, taskId); return { onlyOwnNewCardsRemoved: true, originalCardRetained: true };
  });
  await stage('download original video through the real button', async () => { await ensureExpanded(); return downloadFromButton('下载视频', 'mp4'); });
  await stage('download original storyboard image through the real button', async () => downloadFromButton('下载故事板', 'jpg'));
  if (badNavigation) await loadPage();
  await stage('final refresh and history retain only the original completed card', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' }); await expectOriginalMedia();
    const saved = await current(); assert.equal(saved.cards.length, 1); assert.equal(saved.cards[0].videoTaskId, taskId);
    await page.getByRole('button', { name: '历史', exact: true }).click();
    const drawer = page.getByRole('complementary', { name: '分镜工作台历史' });
    await drawer.getByRole('button', { name: '恢复', exact: true }).click(); await expectOriginalMedia();
    assert.equal(await page.locator('.sbw-shot-card').count(), 1, 'History restored stale deleted cards');
    await waitSaved(1);
    return { sameOriginalTask: true, cardCount: 1, historyRestored: true };
  });
  report.originalImageOwnedReuseConfirmed = report.imageReuseReads.some(result => result.status === 200 && result.reused && result.originalAssetMatched);
  report.unexpectedMainFrameNavigation = badNavigation;
  report.passed = report.stages.every(result => result.passed) && report.originalImageOwnedReuseConfirmed && report.generationRequests === 0 && report.unexpectedMutations === 0 && report.pageErrors.length === 0;
} catch (error) { report.failure = safeError(error); }
finally {
  if (page && new URL(page.url()).origin === origin) await page.screenshot({ path: `${output}/final.png`, fullPage: true }).catch(() => {});
  await browser?.close(); report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ reportPath, passed: report.passed, stages: report.stages.map(({ name, passed }) => ({ name, passed })), generationRequests: report.generationRequests }));
}
if (!report.passed) process.exitCode = 1;
