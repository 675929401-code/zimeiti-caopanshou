import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
assert.ok(['http://127.0.0.1:5000','http://127.0.0.1:5002'].includes(origin));
if (!process.argv.includes('--inspect')) { console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, generationRequests: 0, command: 'node scripts/verify-storyboard-video-binding-ui.mjs --inspect --run-id=<safe-name>' })); process.exit(0); }
const runId = process.argv.find(value => value.startsWith('--run-id='))?.slice(9);
assert.match(runId || '', /^[a-zA-Z0-9_-]{6,100}$/);
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'Normal admin session required');
const headers = { Authorization: `Bearer ${token}` };
const authResponse = await fetch(`${origin}/api/auth/me`, { headers, signal: AbortSignal.timeout(30000) });
const auth = await authResponse.json(); assert.ok(authResponse.ok && auth.user?.role === 'admin');
const modelResponse = await fetch(`${origin}/api/video/models?surface=storyboard-workbench`, { headers, signal: AbortSignal.timeout(30000) });
const modelData = await modelResponse.json(); assert.ok(modelResponse.ok && Array.isArray(modelData.models));
const candidates = modelData.models.filter(model => model.available !== false && model.capabilities?.supportsImageInput === true
  && !model.capabilities?.requiresSourceVideo && !model.capabilities?.requiresLastFrame
  && Number(model.capabilities?.minReferenceAudios || 0) === 0 && Number(model.capabilities?.minReferenceImages || 0) <= 1);
assert.ok(candidates.length > 0, 'At least one currently verified compatible public model required');
const out = path.resolve('.codex-evidence/storyboard-video-binding-20260902', runId); await fs.mkdir(out, { recursive: true });
const report = { at: new Date().toISOString(), origin, normalAdmin: true, credentialsPersisted: false, realGenerationRequests: 0,
  fixtureDraftOnly: true, publicModels: candidates.map(model => ({ publicId: model.id, displayName: model.displayName })), pageErrors: [], selections: [] };
const currentKey = `storyboard_prompt_workbench_current_v2:user:${encodeURIComponent(auth.user.id)}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ token, user, currentKey }) => {
    localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
    if (!localStorage.getItem(currentKey)) localStorage.setItem(currentKey, JSON.stringify({
      id: 'readonly-ui-draft', title: '模型选择界面检查', createdAt: Date.now(), updatedAt: Date.now(), ratio: '16:9', imageResolution: '2K', videoResolution: '720p', videoDuration: 10,
      imageModelId: '', videoModelId: 'pm_unavailable_saved_fixture', videoContract: { modelId: 'pm_unavailable_saved_fixture', ratio: '16:9', resolution: '720p', duration: 10 }, cards: [{ id: 'readonly-card', order: 1, narration: '', imagePrompt: '', videoPrompt: '', referenceImageUrls: [], imageStatus: 'idle', videoStatus: 'idle' }],
    }));
  }, { token, user: auth.user, currentKey });
  await context.route('**/api/**', async route => {
    const request = route.request(); const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/(?:image|video)\/(?:generate|cancel)$/.test(pathname)) { report.realGenerationRequests++; return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message.replace(/https?:\/\/\S+/g, '[url]').split(token).join('[redacted]').slice(0, 500)));
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const rail = page.locator('.sbw-video-model-section');
  await rail.getByRole('button', { name: /^选择视频模型：/ }).first().waitFor({ state: 'visible', timeout: 45000 });
  await rail.getByRole('status').filter({ hasText: '原视频模型当前不可选' }).waitFor({ state: 'visible', timeout: 15000 });
  const initial = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), currentKey);
  assert.equal(initial.videoModelId, 'pm_unavailable_saved_fixture');
  assert.equal(await rail.locator('button.is-active').count(), 0); report.missingSelectionPreserved = true;
  assert.ok(!(await rail.innerText()).includes('验收推荐'));
  const choices = candidates.slice(0, 2);
  for (const model of choices) {
    const choice = rail.getByRole('button', { name: `选择视频模型：${model.displayName}`, exact: true });
    await choice.click();
    await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) || '{}').videoModelId === id, { key: currentKey, id: model.id }, { timeout: 10000 });
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), currentKey);
    assert.equal(stored.videoModelId, model.id);
    assert.ok(stored.videoDuration >= Number(model.capabilities.minDuration || 1) && stored.videoDuration <= Number(model.capabilities.maxDuration || model.capabilities.defaultDuration));
    const notice = await page.locator('.sbw-notice').innerText(); assert.equal(notice, `已选择 ${model.displayName}`);
    report.selections.push({ publicId: model.id, duration: stored.videoDuration, resolution: stored.videoResolution, noticeMatches: true });
  }
  const selectedId = choices.at(-1).id;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await rail.locator('button.is-active').waitFor({ state: 'visible', timeout: 45000 });
  const restored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), currentKey);
  assert.equal(restored.videoModelId, selectedId); report.refreshSelectionPreserved = true;
  assert.equal(report.realGenerationRequests, 0); assert.deepEqual(report.pageErrors, []);
  await page.locator('.sbw-shell').screenshot({ path: path.join(out, 'model-selection.png') });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { name: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[url]').split(token).join('[redacted]').slice(0, 1200) };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(out, 'inspect.json'), JSON.stringify(report, null, 2));
  await browser?.close(); console.log(JSON.stringify({ passed: report.passed, generationRequests: report.realGenerationRequests, evidence: out, failure: report.failure || null }));
}
