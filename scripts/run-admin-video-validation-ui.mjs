import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
if (!['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin)) throw new Error('LOCAL_PREVIEW_REQUIRED');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
const reportDirectory = '.codex-evidence/admin-video-validation-ui-20260903'; await mkdir(reportDirectory, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const actorResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
const actor = await actorResponse.json();
if (!actorResponse.ok || actor.user?.role !== 'admin') throw new Error('NORMAL_ADMIN_REQUIRED');
const evidence = '.codex-evidence/hidden-video-real-e2e-20260902/hidden-bindings-canary-v2-20260902';
const cases = [];
for (const name of ['minimax-h3-autodl-hosted-first-last', 'minimax-h3-autodl-hosted-image-audio-v2-15s']) {
  const dispatch = JSON.parse(await readFile(`${evidence}/${name}/dispatch.json`, 'utf8'));
  const params = new URLSearchParams({ modelId: dispatch.modelId, validationKey: dispatch.clientRequestId, configurationHash: dispatch.configurationHash, healthEpoch: dispatch.healthEpoch });
  const response = await fetch(`${origin}/api/admin/video-models/validation?${params}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  const dto = await response.json();
  if (!response.ok || dto.existingTask?.status !== 'completed' || dto.model?.id !== dispatch.modelId) throw new Error('ORIGINAL_COMPLETED_PROOF_REQUIRED');
  assert.equal(dto.existingTask.validationKey, dispatch.clientRequestId);
  cases.push({ name, modelId: dispatch.modelId, dto, attempt: {
    version: 1, userId: actor.user.id, proof: { validationKey: dispatch.clientRequestId, configurationHash: dispatch.configurationHash, healthEpoch: dispatch.healthEpoch,
      confirmation: dto.confirmation, model: { id: dto.model.id, publicId: dto.model.publicId, displayName: dto.model.displayName, upstreamModel: dto.model.upstreamModel } },
    createdAt: dispatch.at, status: 'unknown', taskId: '', businessTaskId: '', error: '', errorCode: '',
  } });
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
await context.addInitScript(({ token: sessionToken, user }) => {
  localStorage.setItem('auth_token', sessionToken); localStorage.setItem('auth_user', JSON.stringify(user));
}, { token, user: actor.user });
const page = await context.newPage();
const events = [], pageErrors = [], results = [], unrelatedPages = [];
let stage = 'admin-navigation';
const saveProgress = async () => writeFile(`${reportDirectory}/browser-progress-${runId}.json`, JSON.stringify({ runId, stage, origin, results, unrelatedPages, pageErrors, additionalGenerationRequests: 0, publishRequests: 0 }, null, 2));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['GET', 'HEAD'].includes(request.method())) { events.push({ type: 'blocked-mutation', path: url.pathname }); return route.abort(); }
  if (url.origin === origin) events.push({ type: 'read', path: url.pathname });
  return route.continue();
});
page.on('pageerror', error => pageErrors.push(error.name));
try {
  await page.goto(`${origin}/admin?tab=models`, { waitUntil: 'load', timeout: 60000 });
  await page.getByPlaceholder('搜索模型...').waitFor({ state: 'visible', timeout: 30000 });
  for (const [index, entry] of cases.entries()) {
    stage = `validation-${index + 1}`;
    const card = page.locator(`[data-model-id="${entry.modelId}"]`);
    await card.getByRole('button', { name: '连接检查（不生成）', exact: true }).waitFor({ state: 'visible' });
    await card.getByRole('button', { name: '真实生成验证', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '视频模型真实验证' });
    await dialog.getByRole('button', { name: '提交一次真实验证', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await dialog.getByRole('button', { name: '提交一次真实验证', exact: true }).isDisabled(), true);
    const { backgroundColor, backgroundAlpha } = await dialog.evaluate(element => {
      const backgroundColor = getComputedStyle(element).backgroundColor;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return { backgroundColor, backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3] };
    });
    assert.equal(backgroundAlpha, 255, 'DIALOG_BACKGROUND_MUST_BE_OPAQUE');
    const uploadButton = dialog.locator('button[aria-label^="上传"]').first();
    await uploadButton.waitFor({ state: 'visible' });
    assert.match(await uploadButton.innerText(), /^选择(图片|音频)上传$/u);
    const required = index === 0 ? ['首帧图片（必填）', '尾帧图片（必填）'] : [`参考音频 1（${entry.dto.minimumInput.audioCount > 0 ? '必填' : '可选'}）`];
    for (const label of required) await dialog.getByLabel(label, { exact: true }).waitFor({ state: 'visible' });
    await dialog.screenshot({ path: `${reportDirectory}/${index + 1}-minimum-inputs.png` });
    await dialog.getByRole('button', { name: '关闭视频验证', exact: true }).click();
    await page.evaluate(attempt => localStorage.setItem(`admin-video-validation:v1:${attempt.userId}:${attempt.proof.model.id}`, JSON.stringify(attempt)), entry.attempt);
    await card.getByRole('button', { name: '真实生成验证', exact: true }).click();
    await dialog.getByText('验证生成已完成', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    await dialog.getByRole('button', { name: '启用此配置', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const video = document.querySelector('[role="dialog"] video'); return video?.readyState >= 1 && video.videoWidth > 0 && !video.error; }, null, { timeout: 30000 });
    const playback = await dialog.locator('video').evaluate(video => ({ readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, duration: video.duration, error: !!video.error }));
    await dialog.screenshot({ path: `${reportDirectory}/${index + 1}-completed-restored.png` });
    let download = null;
    if (index === 0) {
      const pendingDownload = page.waitForEvent('download');
      await dialog.getByRole('button', { name: '下载验证视频', exact: true }).click();
      const file = await pendingDownload; const filePath = `${reportDirectory}/restored-first-last.mp4`; await file.saveAs(filePath);
      const bytes = await readFile(filePath); assert.ok(bytes.length > 10000); download = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    await page.reload({ waitUntil: 'load' });
    await page.getByPlaceholder('搜索模型...').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator(`[data-model-id="${entry.modelId}"]`).getByRole('button', { name: '真实生成验证', exact: true }).click();
    await dialog.getByText('验证生成已完成', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    const state = await page.evaluate(({ userId, modelId }) => JSON.parse(localStorage.getItem(`admin-video-validation:v1:${userId}:${modelId}`)), { userId: actor.user.id, modelId: entry.modelId });
    assert.equal(state.status, 'completed'); assert.equal(state.proof.validationKey, entry.attempt.proof.validationKey); assert.equal(state.businessTaskId, entry.dto.existingTask.businessTaskId);
    results.push({ modelId: entry.modelId, expectedInputsVisible: true, confirmationRequired: true, opaqueBackground: true, backgroundColor, chineseUploadButton: true, originalProofPreserved: true, refreshRestored: true, businessTaskId: state.businessTaskId, playback, download });
    await saveProgress();
    await dialog.getByRole('button', { name: '关闭视频验证', exact: true }).click();
  }
  for (const route of ['/youcai', '/tools']) {
    stage = `unrelated-page:${route}`;
    const response = await page.goto(`${origin}${route}`, { waitUntil: 'load' });
    if (route === '/youcai') await page.getByRole('heading', { name: '热门工具', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    else await page.locator('[data-page="tools"] textarea').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.length > 80 && !/正在加载提取工具|正在加载排版工具|正在加载分段工具/u.test(document.body.innerText), null, { timeout: 30000 });
    const view = await page.evaluate(() => ({ meaningfulText: document.body.innerText.length > 80, overflow: document.documentElement.scrollWidth > innerWidth }));
    assert.equal(response.status(), 200); assert.equal(view.meaningfulText, true); assert.equal(view.overflow, false); unrelatedPages.push({ route, status: response.status(), ...view });
    await saveProgress();
  }
  assert.equal(pageErrors.length, 0);
  assert.equal(events.filter(event => event.type === 'blocked-mutation' && ['/api/video/generate', '/api/admin/video-models/validation/publish', '/api/video/reference-upload'].includes(event.path)).length, 0);
  const report = { passed: true, origin, normalAdmin: true, existingResultsOnly: true, additionalGenerationRequests: 0, publishRequests: 0, results, unrelatedPages, pageErrors, blockedDiagnosticCount: events.filter(event => event.type === 'blocked-mutation').length };
  await writeFile(`${reportDirectory}/browser-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const view = await page.evaluate(() => ({ path: location.pathname, textLength: document.body.innerText.length, loading: /正在加载|加载中/u.test(document.body.innerText), overflow: document.documentElement.scrollWidth > innerWidth })).catch(() => null);
  const report = { passed: false, runId, stage, view, errorType: error.name, error: String(error.message).replace(/Bearer\s+\S+/giu, '[credential-hidden]').slice(0, 700), completedCases: results.length, results, unrelatedPages, pageErrors, additionalGenerationRequests: 0 };
  await writeFile(`${reportDirectory}/browser-failure-${runId}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); process.exitCode = 1;
} finally { await browser.close(); }
