#!/usr/bin/env node
/** Project-owned test browser only. Fixture UI evidence is not provider/media-generation acceptance. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { installStoryboardBrowserFixture } from './storyboard-browser-fixture.mjs';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

const origin = new URL(process.env.BASE_URL || 'http://127.0.0.1:5000').origin;
assert.equal(origin, 'http://127.0.0.1:5000', 'LOCAL_FIXED_PREVIEW_REQUIRED');
const readonly = process.argv.includes('--readonly');
const outputRoot = path.resolve(process.env.STORYBOARD_HISTORY_BROWSER_OUTPUT || '.codex-evidence/storyboard-history-20261023/browser');
const requestedRunId = process.env.STORYBOARD_HISTORY_BROWSER_RUN_ID?.trim();
const runId = requestedRunId || `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, 'INVALID_EVIDENCE_RUN_ID');
const output = path.join(outputRoot, runId);
const report = { schema: 'storyboard-history-page-browser.v1', passed: false,
  mode: readonly ? 'actual-account-readonly-history' : 'fixture-backed-browser',
  scope: readonly ? 'Real account, read-only history and desktop page screenshots; no paid generation acceptance'
    : 'Real compiled UI with synthetic account/project/catalog/media; all API writes remain RAM fixtures; not provider verification',
  viewport: { width: 1440, height: 900 }, checkedAt: new Date().toISOString(), runId, outputRoot, evidenceDirectory: output,
  forwardedWrites: 0, forwardedExternalRequests: 0, interceptedWrites: [], rejectedRequests: [], checks: [], screenshots: [], pageErrors: [],
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function identity() {
  const dist = process.env.LOCAL_VALIDATION_DIST_DIR || '.next';
  assert.ok(['.next', '.next-local-acceptance', '.next-local-acceptance-next'].includes(dist));
  const [response, versionRaw, buildRaw, receiptRaw] = await Promise.all([
    fetch(origin + '/api/version', { redirect: 'error', signal: AbortSignal.timeout(15000) }),
    readFile('public/version.json', 'utf8'), readFile(path.join(dist, 'BUILD_ID'), 'utf8'),
    readFile(path.join(dist, 'local-source-fingerprint.v1.json'), 'utf8'),
  ]);
  assert.ok(response.ok, 'CURRENT_VERSION_REQUIRED');
  const runtime = await response.json(), version = JSON.parse(versionRaw.replace(/^\uFEFF/u, ''));
  const receipt = JSON.parse(receiptRaw.replace(/^\uFEFF/u, '')), current = computeLocalBuildFingerprint(process.cwd());
  assert.ok(runtime.sourceVersion && runtime.buildId);
  assert.equal(runtime.sourceVersion, version.sourceVersion);
  assert.equal(runtime.buildId, buildRaw.trim());
  assert.equal(receipt.buildId, runtime.buildId);
  assert.equal(receipt.fingerprint, current.fingerprint, 'CURRENT_SOURCE_BUILD_IDENTITY_REQUIRED');
  assert.equal(receipt.fileCount, current.fileCount);
  return { sourceVersion: runtime.sourceVersion, buildId: runtime.buildId, fingerprint: current.fingerprint, runningLatest: true };
}
function staticPath(url) {
  if (['/storyboard-workbench', '/storyboard-workbench/history', '/storyboard-workbench/visual-assets', '/video'].includes(url.pathname)) return true;
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return false;
  try { const root = path.resolve('public'), file = path.resolve(root, '.' + decodeURIComponent(url.pathname)); return file.startsWith(root + path.sep) && statSync(file).isFile(); } catch { return false; }
}
async function until(test, message, timeout = 25000) {
  const end = Date.now() + timeout;
  while (!await test() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(await test(), message);
}
async function screenshot(page, name) {
  const file = name + '.png';
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    route: location.pathname, openDialogs: document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]').length }));
  assert.ok(metrics.scrollWidth <= metrics.width + 2, 'DESKTOP_HORIZONTAL_OVERFLOW');
  await page.screenshot({ path: path.join(output, file), fullPage: false });
  report.screenshots.push({ file, ...metrics });
}
const mediaOrigin = 'https://storyboard-history-fixture.invalid';
const ownerName = '验收人物阿青';
const originalText = '固定人物阿青在窗边转身，保持同一服装与脸部。';
const editedText = '浏览器恢复验收：阿青抬手指向窗外，身份参考保持一致。';
const taskId = 'history-fixture-original-video-001';
const projectId = 'history-fixture-project-001';
const cardId = 'history-fixture-card-001';
const ownerUrl = mediaOrigin + '/owner.svg';
const imageModel = { id: 'gpt-image-2-pro', displayName: 'Fixture GPT Image', publicPrice: 0.2,
  capabilities: { family: 'gpt', supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ['1K', '2K', '4K'], defaultResolution: '2K', aspectRatios: ['16:9', '9:16', '1:1'] } };
const videoModel = { id: 'fixture-history-video-720p', displayName: 'Fixture Video 720p', publicPrice: 0.4,
  capabilities: { type: 'video', durationMode: 'fixed', minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10],
    supportsImageInput: true, requiresImage: true, resolutionTier: '720p', resolutionOptions: ['720p'], defaultResolution: '720p', aspectRatios: ['16:9'], workspaceSurfaces: ['storyboard', 'video-page'] } };
function fixtureDocument() {
  const now = Date.now();
  return { id: projectId, title: '分镜历史页面闭环验收', createdAt: now - 20000, updatedAt: now - 10000, lastSubmittedAt: now - 10000,
    ratio: '16:9', imageRatio: '16:9', imageResolution: '2K', videoResolution: '720p', videoDuration: 10, imageModelId: imageModel.id, videoModelId: videoModel.id,
    visualAssetWorkspace: { drafts: [{ planId: 'fixture_owner', role: 'character', name: ownerName, prompt: '黑发浅蓝上衣女性阿青，固定身份与脸部参考。', tagsText: '主角', customCategory: '' }], candidates: [] },
    visualAssetPlan: { mode: 'selected', assets: [{ id: 'fixture_owner', role: 'character', name: ownerName,
      identityLock: '固定人物身份脸形发型衣服与颜色保持一致', allowedChanges: [],
      referencePrompts: [{ kind: 'identity', purpose: '固定人物身份', prompt: '黑发浅蓝上衣女性阿青，固定身份与脸部参考。' }],
      source: { kind: 'uploaded-image', assetId: 'owned_history_fixture_owner', storageKey: 'fixture/owner.svg' } }],
      defaultAssetIds: ['fixture_owner'], generationPolicy: { maxInitialImages: 2, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' } },
    cards: [{ id: cardId, order: 1, label: '人物转身', narration: '阿青转身看向窗外。', imagePrompt: originalText, imageExactText: '', videoPrompt: '阿青缓缓转身看向窗外，镜头保持稳定。',
      referenceImageUrls: [ownerUrl], visualAssetRefs: [{ assetId: 'fixture_owner', role: 'character', referenceKinds: ['identity'], ownedReferenceUrl: ownerUrl, boundReferenceUrl: ownerUrl }],
      visualAssetRefsMode: 'explicit', visualAssetSelectionMode: 'project', imageStatus: 'done', imageUrl: ownerUrl,
      imageAssetId: 'owned_history_fixture_board', imageStorageKey: 'fixture/board.svg', imageWidth: 320, imageHeight: 180, imageValidatedAt: now - 10000,
      videoStatus: 'running', videoTaskId: taskId, videoTaskModelId: videoModel.id, videoTaskModelName: videoModel.displayName,
      videoClientRequestId: 'history-fixture-original-request-001', videoClientRequestFingerprint: 'history-fixture-original-fingerprint',
      videoStartedAt: now - 10000, videoStatusDetail: 'Fixture 原任务处理中', videoBillingState: 'pending' }],
  };
}
async function fixtureMode(context, page) {
  const document = fixtureDocument(), generatedPosts = [], polls = [];
  let historyReadCount = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/video/history") historyReadCount++; });
  let activeUser;
  // Catch-all registered before specific fixture handlers. It never forwards an API or media write.
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === mediaOrigin && method === 'GET' && url.pathname.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#184d62"/><circle cx="160" cy="70" r="38" fill="#7bdfca"/><path d="M100 180v-45a60 60 0 01120 0v45" fill="#507db9"/></svg>' });
    if (url.origin !== origin) { report.rejectedRequests.push({ method, kind: 'external', path: url.pathname }); return route.abort('blockedbyclient'); }
    if (url.pathname.startsWith('/api/')) return json(route, { error: 'Unconfigured fixture endpoint', tasks: [], records: [], models: [], assets: [], projects: [] }, 404);
    if (method === 'GET' && staticPath(url)) return route.continue();
    report.rejectedRequests.push({ method, kind: 'unapproved-local', path: url.pathname }); return route.abort('blockedbyclient');
  });
  const fixture = await installStoryboardBrowserFixture(page, { origin, resetStorage: false, initialProjects: [document] });
  activeUser = fixture.user;
  let holdAccountB = false, accountBStarted = false, releaseAccountB;
  const accountBGate = new Promise(resolve => { releaseAccountB = resolve; });
  await page.route('**/api/auth/me**', async route => {
    const user = activeUser;
    if (holdAccountB && user.id !== fixture.user.id) { accountBStarted = true; await accountBGate; }
    return json(route, { user });
  });
  await page.route('**/api/member-permissions**', route => json(route, { permission: { userId: activeUser.id, role: activeUser.role,
    featureNavigationKeys: ['marketplace', 'toolbox', 'storyboard_workbench', 'image_workbench', 'create', 'voice', 'cover'], agentNavigationKeys: [],
    revision: 1, checksum: 'history-fixture', integrityValid: true, authorityStatus: 'admin' } }));
  await page.route('**/api/storyboard/projects**', route => activeUser.id === fixture.user.id ? route.fallback() : json(route, { projects: [], nextOffset: null }));
  const recoveryKey = 'storyboard_workspace_recovery_v1:' + encodeURIComponent(fixture.user.id) + ':' + createHash('sha256').update(fixture.token).digest('hex');
  await page.addInitScript(({ expectedOrigin, key, run }) => {
    if (location.origin !== expectedOrigin) return;
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ version: 1, scope: key, savedAt: Date.now(), run }));
  }, { expectedOrigin: origin, key: recoveryKey, run: document });
  await page.route('**/api/cover-models**', route => json(route, { models: [imageModel] }));
  await page.route('**/api/video/models**', route => json(route, { models: [videoModel] }));
  for (const [endpoint, body] of Object.entries({ '/api/storyboard/presets': { presets: [], nextOffset: null },
    '/api/image-workbench/failure-history': { records: [], nextPage: null }, '/api/cash/balance': { balance: 1000 },
    '/api/settings/video-page': { config: {} }, '/api/video/active-tasks': { activeTasks: [] },
    '/api/storyboard/visual-assets': { assets: [{ assetId: 'owned_history_fixture_owner', name: ownerName, role: 'character', storageKey: 'fixture/owner.svg', previewUrl: ownerUrl, projectId }], nextOffset: null },
  })) await page.route('**' + endpoint + '**', route => json(route, body));
  await page.route('**/api/storyboard/image**', route => {
    const q = new URL(route.request().url()).searchParams;
    return json(route, { url: ownerUrl, assetId: q.get('assetId') || 'owned_history_fixture_owner', storageKey: q.get('storageKey') || 'fixture/owner.svg', width: 320, height: 180 });
  });
  const historyTask = { id: taskId, taskIdExternal: taskId, status: 'processing', batchId: projectId, batchTopic: document.title, cardIndex: 1,
    modelName: videoModel.displayName, publicModelId: videoModel.id, durationSeconds: 10, createdAt: new Date(document.lastSubmittedAt).toISOString(), billingState: 'pending', progress: 25 };
  await page.route('**/api/video/history**', route => json(route, { tasks: activeUser.id === fixture.user.id ? [historyTask] : [], nextOffset: null }));
  await page.route('**/api/video/stream**', route => {
    polls.push({ kind: 'stream', taskId: new URL(route.request().url()).searchParams.get('taskId') });
    return json(route, { error: 'Synthetic stream unavailable; read-only status polling fixture' }, 503);
  });
  await page.route('**/api/video/status**', route => {
    polls.push({ kind: 'status', taskId: new URL(route.request().url()).searchParams.get('taskId') });
    return json(route, { status: 'processing', message: 'Fixture 原任务持续处理中', startedAt: new Date(document.lastSubmittedAt).toISOString(), billingState: 'pending' });
  });
  for (const endpoint of ['/api/video/generate', '/api/image/generate']) await page.route('**' + endpoint, route => {
    generatedPosts.push({ path: endpoint, method: route.request().method() });
    return json(route, { error: 'Generation is forbidden in recovery acceptance', upstreamCalled: false, billed: false }, 409);
  });
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) report.interceptedWrites.push({ path: url.pathname, method: request.method() }); });
  // Plain /storyboard-workbench is intentionally a fresh workspace. Reading
  // an existing cloud project requires the explicit projectId contract.
  const projectWorkbenchUrl = `${origin}/storyboard-workbench?projectId=${encodeURIComponent(projectId)}`;
  await page.goto(projectWorkbenchUrl, { waitUntil: 'domcontentloaded' });
  const card = page.locator('[data-sbw-card-id="' + cardId + '"]');
  await card.waitFor();
  await page.getByLabel('分段1生图提示词', { exact: true }).fill(editedText);
  await page.waitForFunction(expected => [...Array(sessionStorage.length).keys()].some(index => {
    const key = sessionStorage.key(index); if (!key?.startsWith('storyboard_workspace_recovery_v1:')) return false;
    try { return JSON.parse(sessionStorage.getItem(key)).run.cards[0].imagePrompt === expected; } catch { return false; }
  }), editedText);
  await until(() => polls.some(item => item.kind === 'status'), 'ORIGINAL_TASK_STATUS_NOT_QUERIED');
  const person = page.locator('.svad-inline .svad-reference-slot[data-role="character"] img').first();
  await person.waitFor();
  await person.evaluate(img => { if (!img.complete || !img.naturalWidth) return new Promise((resolve, reject) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', () => reject(Error('fixture character preview failed')), { once: true }); }); });
  await page.evaluate(id => { window.__historyRetainedCard = document.querySelector('[data-sbw-card-id="' + id + '"]'); }, cardId);
  await screenshot(page, 'workbench-before-history');
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.waitForURL(url => new URL(url).pathname === '/storyboard-workbench/history');
  await page.getByRole('heading', { name: '分镜历史', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回分镜工作台', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'HISTORY_MUST_BE_A_PAGE_NOT_DIALOG');
  assert.equal(await page.evaluate(() => window.__historyRetainedCard?.isConnected), true, 'HISTORY_UNMOUNTED_WORKBENCH');
  assert.equal(await card.isVisible(), false);
  const before = polls.length;
  await until(() => polls.length > before, 'ORIGINAL_TASK_POLLING_STOPPED_IN_HISTORY', 20000);
  await screenshot(page, 'history-independent-page');
  await page.getByRole('button', { name: '返回分镜工作台', exact: true }).click();
  await page.waitForURL(url => new URL(url).pathname === '/storyboard-workbench');
  assert.equal(await page.evaluate(id => window.__historyRetainedCard === document.querySelector('[data-sbw-card-id="' + id + '"]'), cardId), true, 'WORKBENCH_REMOUNTED_ON_HISTORY_RETURN');
  assert.equal(await page.getByLabel('分段1生图提示词', { exact: true }).inputValue(), editedText);
  assert.equal(await person.isVisible(), true);
  report.checks.push('independent-history-url', 'history-has-no-dialog', 'same-dom-and-task-polling-survive-navigation', 'character-and-edited-text-preserved');
  const pollsBeforeReload = polls.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-sbw-card-id="' + cardId + '"]').waitFor();
  assert.equal(await page.getByLabel('分段1生图提示词', { exact: true }).inputValue(), editedText);
  await page.locator('.svad-inline .svad-reference-slot[data-role="character"] img').first().waitFor();
  await until(() => polls.length > pollsBeforeReload, 'REFRESH_DID_NOT_QUERY_ORIGINAL_TASK');
  assert.ok(polls.every(item => item.taskId === taskId), 'REFRESH_QUERIED_A_DIFFERENT_TASK');
  assert.equal(generatedPosts.length, 0, 'REFRESH_OR_NAVIGATION_REPEATED_GENERATION_POST');
  await screenshot(page, 'workbench-after-refresh');
  report.checks.push('refresh-restores-original-card-and-character', 'original-task-only-read-polls', 'zero-generation-posts');
  for (const [route, selector, name] of [['/storyboard-workbench/visual-assets?projectId=' + projectId, '.sbw-assets-page .svad-page', 'adjacent-visual-assets'], ['/video', '[data-video-model-list]', 'adjacent-video']]) {
    await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
    await page.locator(selector).first().waitFor();
    await screenshot(page, name);
    report.checks.push(name + '-desktop-regression');
  }
  await page.goto(projectWorkbenchUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-sbw-card-id="' + cardId + '"]').waitFor();
  // Real compiled-page reproduction of the delayed-GET conflict identified in review.
  // The stale recovery's monitoring timestamp is deliberately in the future.
  const cloudText = '云端新编辑：人物阿青已换成白色外套，保留新提示词。';
  await page.evaluate(key => {
    const envelope = JSON.parse(sessionStorage.getItem(key));
    envelope.run.updatedAt = Date.now() + 1000000;
    envelope.run.title = '旧人物草稿不应覆盖云端';
    envelope.run.cards[0].imagePrompt = '旧人物提示词不应覆盖云端';
    sessionStorage.setItem(key, JSON.stringify(envelope));
  }, recoveryKey);
  const savedRecord = fixture.projects.get(projectId);
  savedRecord.document = { ...savedRecord.document, title: '云端新人物编辑', updatedAt: Date.now(),
    cards: savedRecord.document.cards.map(card => ({ ...card, imagePrompt: cloudText })) };
  let releaseProject;
  const projectGate = new Promise(resolve => { releaseProject = resolve; });
  let projectWaitEntered = false;
  const delayProject = async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.searchParams.get('id') === projectId) {
      projectWaitEntered = true;
      await projectGate;
    }
    return route.fallback();
  };
  await page.route('**/api/storyboard/projects**', delayProject);
  const historyBeforeGate = historyReadCount, pollsBeforeGate = polls.length, writesBeforeGate = fixture.projectWrites.length;
  await page.goto(origin + '/storyboard-workbench/history?projectId=' + encodeURIComponent(projectId), { waitUntil: 'domcontentloaded' });
  await until(() => projectWaitEntered, 'EXPLICIT_PROJECT_GET_NOT_ENTERED');
  await page.waitForTimeout(600);
  assert.equal(historyReadCount, historyBeforeGate, 'HISTORY_READ_BEFORE_OWNED_PROJECT_CONFIRMATION');
  assert.equal(polls.length, pollsBeforeGate, 'TASK_POLL_BEFORE_OWNED_PROJECT_CONFIRMATION');
  assert.equal(fixture.projectWrites.length, writesBeforeGate, 'AUTOSAVE_BEFORE_OWNED_PROJECT_CONFIRMATION');
  releaseProject();
  await page.getByRole('button', { name: '返回分镜工作台', exact: true }).click();
  await page.locator('[data-sbw-card-id="' + cardId + '"]').waitFor();
  assert.equal(await page.getByLabel('分段1生图提示词', { exact: true }).inputValue(), cloudText, 'STALE_MONITOR_TIMESTAMP_OVERWROTE_CLOUD_EDIT');
  await page.unroute('**/api/storyboard/projects**', delayProject);
  await screenshot(page, 'workbench-delayed-project-cloud-edit-preserved');
  report.checks.push('delayed-owned-project-read-gates-history-polls-and-autosave', 'stale-future-monitor-timestamp-cannot-overwrite-cloud-edits');
  // Keep the owned project explicit while switching identity so the old
  // account's mounted card is observable until the new identity takes over.
  await page.goto(projectWorkbenchUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-sbw-card-id="' + cardId + '"]').waitFor();
  holdAccountB = true;
  activeUser = { ...fixture.user, id: 'history-fixture-user-b', username: 'history_fixture_b', displayName: '第二验收账号' };
  await page.evaluate(({ user, markers }) => {
    window.__historyAccountLeaks = [];
    let frames = 0;
    const sample = () => {
      const root = document.querySelector('.sbw-root');
      const visible = root && root.getBoundingClientRect().height > 0;
      if (visible && [...root.querySelectorAll('input,textarea')].some(input => markers.some(marker => String(input.value || '').includes(marker)))) window.__historyAccountLeaks.push(frames);
      if (++frames < 90) requestAnimationFrame(sample);
    };
    const oldValue = localStorage.getItem('auth_token');
    localStorage.setItem('auth_token', 'history-fixture-session-b'); localStorage.setItem('auth_user', JSON.stringify(user));
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', oldValue, newValue: 'history-fixture-session-b' }));
    requestAnimationFrame(sample);
  }, { user: activeUser, markers: [editedText, originalText, cloudText, document.title] });
  await page.waitForFunction(id => !document.querySelector('[data-sbw-card-id="' + id + '"]'), cardId);
  await until(() => accountBStarted, 'NEW_ACCOUNT_AUTHENTICATION_NOT_STARTED');
  await page.waitForTimeout(600);
  assert.deepEqual(await page.evaluate(() => window.__historyAccountLeaks), [], 'PREVIOUS_ACCOUNT_VISIBLE_WHILE_NEW_AUTH_PENDING');
  releaseAccountB();
  await page.locator('.sbw-root').waitFor();
  await page.waitForTimeout(1800);
  assert.deepEqual(await page.evaluate(() => window.__historyAccountLeaks), [], 'PREVIOUS_ACCOUNT_CONTENT_FLASHED_AFTER_SWITCH');
  assert.equal(await page.getByText(ownerName, { exact: true }).count(), 0, 'PREVIOUS_ACCOUNT_CHARACTER_VISIBLE');
  assert.equal(generatedPosts.length, 0);
  report.checks.push('account-switch-hides-previous-account-data-with-frame-observation', 'pending-new-account-auth-never-displays-previous-account');
  report.fixture = { taskId, projectId, originalTaskReadCount: polls.length, inMemoryProjectWrites: fixture.projectWrites.length, generationPosts: generatedPosts.length };
}
async function actualReadonlyMode(context, page) {
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED_FOR_READONLY_MODE');
  const auth = await fetch(origin + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.ok(auth.ok, 'READONLY_ACCOUNT_AUTH_REQUIRED');
  const { user } = await auth.json(); assert.ok(user?.id && user.role === 'admin', 'READONLY_ADMIN_REQUIRED');
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ token, user }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); }, { token, user });
  const reads = new Set(['/api/version', '/api/auth/me', '/api/member-permissions', '/api/credits', '/api/cash/balance', '/api/video/models', '/api/cover-models', '/api/video/history', '/api/storyboard/projects', '/api/storyboard/presets', '/api/storyboard/visual-assets', '/api/storyboard/image', '/api/image-workbench/failure-history', '/api/settings/video-page', '/api/video/access-ticket']);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!['GET', 'HEAD'].includes(method)) { report.interceptedWrites.push({ method, path: url.pathname }); return json(route, { error: 'Read-only browser audit blocks writes' }, 409); }
    if (reads.has(url.pathname) || url.pathname.startsWith('/api/video/thumbnail/') || staticPath(url)) return route.continue();
    report.rejectedRequests.push({ method, kind: 'unapproved-readonly-get', path: url.pathname });
    return json(route, { records: [], assets: [], models: [], items: [] }, 404);
  });
  await page.goto(origin + '/storyboard-workbench/history', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '返回分镜工作台', exact: true }).waitFor();
  await page.getByText('分镜历史', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.waitForTimeout(1500);
  await screenshot(page, 'actual-readonly-history');
  report.checks.push('actual-readonly-history-page-screenshot');
  report.realAccountBoundary = 'Authenticated browser GETs only; no generation, deletion, saving, playback, provider, or charge acceptance claim. No credential or cookie artifacts exported.';
}
let browser, context, page, stage = 'current-build-identity';
await mkdir(outputRoot, { recursive: true });
try { await mkdir(output); } catch (error) {
  if (error?.code === 'EEXIST') throw new Error(`EVIDENCE_RUN_DIRECTORY_EXISTS:${output}`);
  throw error;
}
try {
  report.runtimeBefore = await identity();
  browser = await chromium.launch({ channel: process.env.STORYBOARD_BROWSER_CHANNEL || 'msedge', headless: true });
  context = await browser.newContext({ viewport: report.viewport, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.message.replace(/https?:\/\/[^\s]+/gu, '[url]')));
  stage = readonly ? 'actual-readonly-history' : 'fixture-navigation-refresh-account-isolation';
  if (readonly) await actualReadonlyMode(context, page); else await fixtureMode(context, page);
  assert.deepEqual(report.pageErrors, [], 'BROWSER_APPLICATION_ERRORS');
  stage = 'unchanged-runtime-identity'; report.runtimeAfter = await identity();
  assert.deepEqual(report.runtimeAfter, report.runtimeBefore); report.passed = true;
} catch (error) {
  report.failure = { stage, name: error?.name === 'AssertionError' ? 'AssertionError' : 'ExecutionError', message: String(error?.message || 'unknown').replace(/https?:\/\/[^\s]+/gu, '[url]').slice(0, 400) };
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (context) await context.close(); if (browser) await browser.close();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, mode: report.mode, checks: report.checks, failure: report.failure, output }, null, 2));
}
