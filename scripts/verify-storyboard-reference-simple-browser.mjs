#!/usr/bin/env node
// Real UI; every API and external request is intercepted. Project writes are RAM only.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { installStoryboardBrowserFixture } from './storyboard-browser-fixture.mjs';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

const origin = 'http://127.0.0.1:5000';
const output = path.resolve(process.env.STORYBOARD_REFERENCE_BROWSER_OUTPUT_DIR || '.codex-evidence/storyboard-reference-ui-20261021/browser');
const report = { schema: 'storyboard-reference-simple-browser.v1', passed: false, scope: 'Current-build browser UI, synthetic account/catalog/media, RAM project writes; no paid provider calls', checkedAt: new Date().toISOString(), forwardedWrites: 0, externalRequestsForwarded: 0, scenarios: [], visuals: [], blocked: [] };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const imageModel = { id: 'gpt-image-2-pro', displayName: 'GPT-Image-2 · 渠道A pro', variantLabel: 'A', publicPrice: 0.2, capabilities: { family: 'gpt', supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ['1K', '2K', '4K'], defaultResolution: '2K' } };
// Generic synthetic capabilities exercise UI normalization, not any real channel's support.
const limitedModel = { id: 'fixture-image-limited', displayName: '合成模型A 单规格', publicPrice: 0.1, capabilities: { family: 'gpt', supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ['1K'], defaultResolution: '1K', aspectRatios: ['1:1'] } };
const wideModel = { id: 'fixture-image-wide', displayName: '合成模型B 多规格', publicPrice: 0.2, capabilities: { family: 'gpt', supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ['1K', '2K', '4K'], defaultResolution: '2K', aspectRatios: ['1:1', '16:9', '9:16'] } };
const videoModel = { id: 'video-720p', displayName: '图生视频 720p', publicPrice: 0.4, capabilities: { type: 'video', durationMode: 'fixed', minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10], supportsImageInput: true, requiresImage: true, resolutionTier: '720p', resolutionOptions: ['720p'], defaultResolution: '720p', aspectRatios: ['16:9', '9:16', '1:1'], workspaceSurfaces: ['storyboard', 'video-page'] } };
const mediaOrigin = 'https://media.storyboard.test';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#327d76"/><circle cx="160" cy="90" r="45" fill="#d6e7cf"/></svg>';
async function identity() {
  const dist = process.env.LOCAL_VALIDATION_DIST_DIR || '.next';
  assert.ok(['.next', '.next-local-acceptance', '.next-local-acceptance-next'].includes(dist));
  const [response, diskRaw, build, receiptRaw] = await Promise.all([fetch(`${origin}/api/version`, { redirect: 'error', signal: AbortSignal.timeout(15000) }), readFile('public/version.json', 'utf8'), readFile(path.join(dist, 'BUILD_ID'), 'utf8'), readFile(path.join(dist, 'local-source-fingerprint.v1.json'), 'utf8')]);
  assert.ok(response.ok, 'VERSION_READ_FAILED');
  const runtime = await response.json(), disk = JSON.parse(diskRaw.replace(/^\uFEFF/u, '')), receipt = JSON.parse(receiptRaw.replace(/^\uFEFF/u, '')), current = computeLocalBuildFingerprint(process.cwd());
  assert.ok(runtime.sourceVersion && runtime.buildId, 'BUILD_ID_REQUIRED');
  assert.equal(runtime.sourceVersion, disk.sourceVersion); assert.equal(runtime.buildId, build.trim()); assert.equal(receipt.buildId, runtime.buildId);
  assert.equal(receipt.fingerprint, current.fingerprint, 'CURRENT_SOURCE_FINGERPRINT_MISMATCH'); assert.equal(receipt.fileCount, current.fileCount);
  return { sourceVersion: runtime.sourceVersion, buildId: runtime.buildId, fingerprint: current.fingerprint, runningLatest: true };
}
function isStatic(url) {
  if (['/storyboard-workbench', '/storyboard-workbench/visual-assets', '/video', '/tools'].includes(url.pathname) || url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return false;
  try { const root = path.resolve('public'), file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`); return file.startsWith(`${root}${path.sep}`) && statSync(file).isFile(); } catch { return false; }
}
let browser;
async function prepare(name, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  const state = { name, context, page, images: [], receipts: [], mutations: [], pageErrors: [], consoleErrors: [], dialogs: [], rejectedSaves: [], rejectedAutoSaves: [], failRemoval: options.failRemoval === true };
  // Registered first; fixture routes override this guard, never the network.
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === mediaOrigin && method === 'GET' && url.pathname.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (url.origin !== origin) { report.blocked.push({ scenario: name, kind: 'external', method, path: url.pathname }); return route.abort('blockedbyclient'); }
    if (url.pathname.startsWith('/api/')) { report.blocked.push({ scenario: name, kind: 'api', method, path: url.pathname }); return json(route, { error: 'Unconfigured synthetic fixture endpoint', tasks: [], records: [], models: [], assets: [], projects: [] }, 404); }
    if (method === 'GET' && isStatic(url)) return route.continue();
    report.blocked.push({ scenario: name, kind: 'other', method, path: url.pathname }); return route.abort('blockedbyclient');
  });
  state.fixture = await installStoryboardBrowserFixture(page, { origin, initialProjects: options.document ? [options.document] : [] });
  if (options.pending) await page.addInitScript(pending => localStorage.setItem('storyboard-asset-pending:v1:user:storyboard-browser-fixture-user', JSON.stringify([pending])), options.pending);
  await page.route('**/api/cover-models**', route => json(route, { models: options.capabilityModels ? [limitedModel, wideModel] : [imageModel] }));
  await page.route('**/api/video/models**', route => json(route, { models: [videoModel] }));
  for (const [endpoint, body] of Object.entries({
    '/api/storyboard/presets': { presets: [], nextOffset: null }, '/api/video/history': { tasks: [] }, '/api/image-workbench/failure-history': { records: [], nextPage: null }, '/api/storyboard/visual-assets': { assets: [], nextOffset: null }, '/api/cash/balance': { balance: 1000 }, '/api/settings/video-page': { config: {} }, '/api/video/active-tasks': { activeTasks: [] }, '/api/extract/history': { history: [] },
    '/api/tools/runtime-catalog': { items: Object.fromEntries([...['video', 'text', 'batch', 'search'].map(key => [key, { available: true, pricingReady: true, service: 'Synthetic extraction', provider: 'Fixture', model: 'Fixture', unitPrice: 0.1, currency: 'CNY', unit: '条' }]), ...['formatter', 'segmenter'].map(key => [key, { available: true, service: key, unitPrice: 0, currency: 'CNY', unit: '次', processingMode: 'local_rules' }])]) },
  })) await page.route(`**${endpoint}**`, route => json(route, body));
  await page.route('**/api/storyboard/image**', route => {
    const query = new URL(route.request().url()).searchParams;
    const receipt = state.receipts.find(item => query.get('assetId') === item.assetId || query.get('storageKey') === item.storageKey);
    return json(route, receipt || { url: `${mediaOrigin}/owned.svg`, assetId: query.get('assetId') || 'owned_fixture_owner', storageKey: query.get('storageKey') || 'fixture/owned.svg', width: 320, height: 180 });
  });
  if (options.upload) await page.route('**/api/storage/upload', route => {
    const receipt = { url: `${mediaOrigin}/uploaded.svg`, assetId: 'owned_fixture_uploaded', storageKey: 'fixture/uploaded.svg', width: 320, height: 180 }; state.receipts.push(receipt);
    return json(route, { success: true, file: { key: receipt.storageKey } });
  });
  await page.route('**/api/image/generate', route => {
    state.images.push(route.request().postDataJSON());
    if (options.ownedGeneration) {
      const index = state.images.length, suffix = index === 1 ? '' : `-${index}`;
      const receipt = { recordId: index.toString(16).padStart(64, '0'), assetId: index === 1 ? 'owned_fixture_owner' : `owned_fixture_owner_${index}`, storageKey: `fixture/owned${suffix}.svg`, url: `${mediaOrigin}/owned${suffix}.svg`, width: 320, height: 180, deliveryMode: 'provider_url' }; state.receipts.push(receipt);
      return json(route, { recordId: receipt.recordId, state: 'completed', cashCharged: 0, billed: false, upstreamCalled: false, images: [receipt] });
    }
    return json(route, { error: 'Synthetic pre-provider rejection; no charge', code: 'REFERENCE_BROWSER_FIXTURE_REJECTION', upstreamCalled: false, billed: false, taskSubmitted: false, state: 'rejected', canResubmit: true }, 400);
  });
  await page.route('**/api/image/status**', route => json(route, { state: 'processing', billed: false, canResubmit: false }));
  if (options.document || options.failAutoBinding) await page.route('**/api/storyboard/projects**', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = route.request().postDataJSON();
    if (options.failAutoBinding && payload.document.visualAssetPlan?.assets.some(asset => asset.source) && payload.document.cards.some(card => card.visualAssetRefs?.length)) { state.rejectedAutoSaves.push(payload.document); return json(route, { error: 'Synthetic first auto-binding save failed' }, 503); }
    if (state.failRemoval && !payload.document.visualAssetWorkspace?.drafts.some(draft => draft.planId === 'fixture_owner')) { state.rejectedSaves.push(payload.document); return json(route, { error: 'Synthetic removal save failed' }, 503); }
    return route.fallback();
  });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) state.mutations.push({ path: new URL(request.url()).pathname, method: request.method() }); });
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) state.consoleErrors.push(message.text()); });
  page.on('dialog', async dialog => { state.dialogs.push(dialog.message()); await dialog.accept(); });
  await page.goto(`${origin}/storyboard-workbench${options.document ? `?projectId=${options.document.id}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.sbw-shot-card').first().waitFor();
  await page.locator('.sbw-image-model-list button[data-model-selectable="true"]').first().click();
  await page.getByRole('button', { name: '角色参考', exact: true }).click();
  await page.locator('.svad-inline .svad-reference-slot').first().waitFor();
  return state;
}
async function until(test, message) { const end = Date.now() + 15000; while (!test() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(test(), message); }
function done(state, details = {}) { assert.deepEqual(state.pageErrors, [], 'BROWSER_APPLICATION_ERRORS'); assert.deepEqual(state.consoleErrors, [], 'APPLICATION_CONSOLE_ERRORS'); assert.equal(state.mutations.filter(item => item.method === 'DELETE').length, 0, 'REFERENCE_DELETION_MUST_NOT_DELETE_MEDIA'); report.scenarios.push({ name: state.name, passed: true, interceptedGenerationPosts: state.images.length, projectWrites: state.fixture.projectWrites.length, pageErrors: state.pageErrors, ...details }); }
async function assertPromptOnlyDraft(card) {
  const fields = await card.evaluate(node => { const visible = element => !element.closest('details:not([open])') && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0; return { visibleExtraFields: [...node.querySelectorAll('input, select')].filter(visible).map(element => ({ type: element.type, label: element.getAttribute('aria-label') })), visiblePrompts: [...node.querySelectorAll('textarea')].filter(visible).length }; });
  assert.deepEqual(fields.visibleExtraFields, [], 'REFERENCE_MAIN_AREA_HAS_EXTRA_METADATA_FIELDS');
  assert.equal(fields.visiblePrompts, 1, 'REFERENCE_MAIN_AREA_MUST_SHOW_PROMPT');
}
async function visuals(state, route, theme, width, align = false) {
  const { page } = state; await page.setViewportSize({ width, height: 1080 });
  if (new URL(page.url()).pathname !== route) { await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' }); await page.locator('main').first().waitFor(); }
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.mode = theme === 'soft-white' ? 'light' : 'dark'; }, theme);
  await page.waitForTimeout(300);
  const metrics = await page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, background: s.backgroundColor, color: s.color, border: s.borderColor }; };
    return { route: location.pathname, theme: document.documentElement.dataset.theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('.svad-inline .svad-reference-slot')].map(rect), shots: [...document.querySelectorAll('.sbw-shot-card')].slice(0, 3).map(rect) };
  });
  assert.ok(metrics.scrollWidth <= width + 2, 'HORIZONTAL_OVERFLOW');
  if (align) { assert.equal(metrics.cards.length, 2); assert.equal(metrics.shots.length, 3); assert.ok(Math.abs(metrics.cards[0].width - metrics.cards[1].width) < 2, 'REFERENCE_EQUAL_HALVES'); assert.ok(Math.abs(metrics.cards[0].x - metrics.shots[0].x) < 3, 'REFERENCE_ROW_LEFT_EDGE'); assert.ok(Math.abs(metrics.cards[1].x + metrics.cards[1].width - metrics.shots[2].x - metrics.shots[2].width) < 3, 'REFERENCE_ROW_RIGHT_EDGE'); assert.ok(Math.abs(metrics.cards[0].y - metrics.cards[1].y) < 2, 'REFERENCE_TOP_ALIGNMENT'); assert.ok(Math.abs(metrics.cards[0].bottom - metrics.cards[1].bottom) < 2, 'REFERENCE_BOTTOM_ALIGNMENT'); }
  if (align) await page.locator('.svad-inline').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${state.name}-${route.replaceAll('/', '_')}-${theme}-${width}.png`), fullPage: false }); report.visuals.push(metrics);
}
function boundDocument(base, unknown = false) {
  const document = structuredClone(base); document.id = unknown ? 'fixture-reference-pending' : 'fixture-reference-bound'; document.title = '参考卡删除验收';
  const planId = 'fixture_owner', url = `${mediaOrigin}/owned.svg`;
  document.visualAssetWorkspace = { drafts: [{ planId, role: 'character', name: '测试人物', prompt: '同一位黑色短发穿浅蓝上衣的女性完整身份参考与外观。', tagsText: '主角', customCategory: '' }], candidates: [] };
  document.visualAssetPlan = { mode: 'selected', assets: [{ id: planId, role: 'character', name: '测试人物', identityLock: '固定人物身份脸形发型衣服与颜色保持一致', allowedChanges: [], referencePrompts: [{ kind: 'identity', purpose: '固定人物身份', prompt: '同一位黑色短发穿浅蓝上衣的女性完整身份参考与外观。' }], source: { kind: 'uploaded-image', assetId: 'owned_fixture_owner', storageKey: 'fixture/owned.svg' } }], defaultAssetIds: [planId], generationPolicy: { maxInitialImages: 2, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' } };
  document.cards.forEach((card, index) => { card.visualAssetRefs = [{ assetId: planId, role: 'character', referenceKinds: ['identity'], ownedReferenceUrl: url, boundReferenceUrl: url }]; card.visualAssetRefsMode = 'explicit'; card.visualAssetSelectionMode = index === 0 ? 'custom' : 'project'; card.referenceImageUrls = [url]; card.imageStatus = 'done'; card.imageUrl = url; card.imageAssetId = 'owned_fixture_board'; card.imageStorageKey = 'fixture/board.svg'; card.imageWidth = 320; card.imageHeight = 180; card.videoStatus = 'done'; card.videoUrl = `${mediaOrigin}/old.mp4`; });
  return document;
}

await mkdir(output, { recursive: true });
try {
  report.runtimeBefore = await identity(); browser = await chromium.launch({ channel: 'msedge', headless: true });
  let base;
  {
    const state = await prepare('delete-untouched-default-persists'); const { page } = state;
    await page.locator('.svad-reference-slot[data-role="character"] .svad-delete-draft').click();
    await page.waitForFunction(() => document.querySelectorAll('.svad-inline .svad-reference-slot').length === 1);
    await until(() => state.fixture.latestDocument()?.visualAssetWorkspace?.drafts.length === 1, 'UNTOUCHED_DEFAULT_DELETE_NOT_SAVED');
    const saved = state.fixture.latestDocument(); assert.equal(saved.visualAssetWorkspace.drafts[0].role, 'pet');
    await page.goto(`${origin}/storyboard-workbench?projectId=${saved.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.sbw-shot-card').first().waitFor();
    await page.getByRole('button', { name: '角色参考', exact: true }).click();
    await page.locator('.svad-reference-slot[data-role="pet"]').waitFor();
    assert.equal(await page.locator('.svad-inline .svad-reference-slot').count(), 1, 'DELETED_DEFAULT_REAPPEARED_ON_RELOAD');
    assert.equal(await page.locator('.svad-reference-slot[data-role="character"]').count(), 0);
    assert.equal(await page.locator('.svad-role-group[data-role="environment"]').count(), 0);
    assert.equal(state.images.length, 0); done(state, { untouchedDefaultDeletionPersisted: true, reloadDoesNotRecreateDefaults: true }); await state.context.close();
  }
  {
    const state = await prepare('defaults-add-delete-and-prompt'); const { page } = state;
    const cards = page.locator('.svad-inline .svad-reference-slot'); assert.equal(await cards.count(), 2);
    assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.role)), ['character', 'pet']);
    await assertPromptOnlyDraft(cards.first()); await assertPromptOnlyDraft(cards.last());
    assert.equal(await page.getByLabel('宠物三视图年龄状态').count(), 0); assert.equal(await page.locator('.svad-role-group[data-role="environment"]').count(), 0);
    for (const theme of ['lattice', 'soft-white', 'crystal-aurora']) for (const width of [1440, 1880]) await visuals(state, '/storyboard-workbench', theme, width, true);
    for (const theme of ['lattice', 'soft-white']) {
      await visuals(state, '/storyboard-workbench', theme, 390);
      await cards.first().scrollIntoViewIfNeeded(); await assertPromptOnlyDraft(cards.first()); const prompt = cards.first().locator('textarea'); await prompt.fill('移动端提示词输入验收，保持人物身份与服装。'); assert.equal(await prompt.inputValue(), '移动端提示词输入验收，保持人物身份与服装。'); await prompt.fill('');
      const mobile = await cards.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, buttons: [...node.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0).map(button => { const b = button.getBoundingClientRect(); return { label: button.textContent, x: b.x, right: b.right }; }) }; }));
      for (const card of mobile) { assert.ok(card.x >= -1 && card.right <= 391, 'MOBILE_REFERENCE_OUTSIDE_VIEWPORT'); assert.ok(card.scrollWidth <= card.clientWidth + 2, 'MOBILE_REFERENCE_OVERFLOW'); for (const button of card.buttons) assert.ok(button.x >= -1 && button.right <= 391, 'MOBILE_BUTTON_OUTSIDE_VIEWPORT'); }
      await page.screenshot({ path: path.join(output, `mobile-reference-${theme}.png`), fullPage: false }); report.visuals.push({ mobileInteraction: true, theme, width: 390, cards: mobile });
    }
    await page.setViewportSize({ width: 1440, height: 1080 });
    for (const role of ['prop', 'product']) { await page.getByLabel('添加参考卡类别', { exact: true }).selectOption(role); await page.getByRole('button', { name: '＋添加参考卡', exact: true }).click(); }
    assert.equal(await cards.count(), 4); assert.equal(await page.locator('.svad-role-group').count(), 0);
    for (let index = 0; index < await cards.count(); index++) await assertPromptOnlyDraft(cards.nth(index));
    const added = cards.last(); await assertPromptOnlyDraft(added); await added.locator('textarea').fill('金色包装的产品主图，保留产品外形与材质。'); assert.ok(await added.getByRole('button', { name: '生成参考图', exact: true }).isEnabled(), 'PROMPT_ONLY_PRODUCT_GENERATION_NOT_READY');
    const before = state.images.length; await added.locator('.svad-delete-draft').click(); await page.waitForFunction(() => document.querySelectorAll('.svad-inline .svad-reference-slot').length === 3); assert.equal(state.images.length, before);
    await cards.last().locator('.svad-delete-draft').click(); await page.waitForFunction(() => document.querySelectorAll('.svad-inline .svad-reference-slot').length === 2);
    const shotCount = await page.locator('.sbw-shot-card').count(); await page.getByRole('button', { name: '添加分镜', exact: true }).click(); await page.waitForFunction(count => document.querySelectorAll('.sbw-shot-card').length === count, shotCount + 1); assert.equal(await cards.count(), 2);
    const pet = cards.filter({ has: page.locator('[aria-label="宠物参考提示词"]') });
    for (const prompt of ['一只幼年橘猫，白色胸口，圆眼睛，软短毛，保持幼年体态。', '一只成年蓝色虎皮鹦鹉，短喙双翼，蓝白羽毛，保持成年阶段。', '同一只猫从幼年到老年的两个阶段，按描述保留年龄变化。']) {
      await pet.locator('textarea').fill(prompt); const expected = state.images.length + 1; await pet.getByRole('button', { name: '生成三视图', exact: true }).click(); await until(() => state.images.length === expected, 'PROMPT_NOT_DISPATCHED'); const body = state.images.at(-1); assert.ok(body.prompt.includes(prompt), 'USER_SPECIES_AND_STAGE_CHANGED'); assert.doesNotMatch(body.prompt, /犬类|狗|四足站立|只选取.*(?:青年|老年)|忽略.*(?:青年|老年)/u); assert.equal(body.strictSingleSubmit, true); assert.equal(body.noRetry, true); await page.locator('.svad-error').filter({ hasText: 'Synthetic pre-provider rejection' }).waitFor();
    }
    await until(() => Boolean(state.fixture.latestDocument()), 'NO_BASE_PROJECT'); base = state.fixture.latestDocument();
    // Library navigation preserves target slot and never invokes generation.
    const count = state.images.length; await cards.first().getByRole('button', { name: '从图库选择', exact: true }).click(); await page.waitForURL('**/storyboard-workbench/visual-assets?**'); await page.getByRole('heading', { name: '参考图库', exact: true }).waitFor(); assert.equal(state.images.length, count);
    done(state, { defaultCards: 2, mainAreaPromptOnly: true, promptOnlyProductGenerationReady: true, independentlyAddedAndRemoved: true, addShotLeavesReferencesUnchanged: true, promptCases: state.images.map(body => ({ prompt: body.prompt, noRetry: body.noRetry, strictSingleSubmit: body.strictSingleSubmit })), libraryZeroGeneration: true }); await state.context.close();
  }
  {
    const state = await prepare('first-reference-auto-binds-and-second-generation-stays-candidate', { ownedGeneration: true }); const { page } = state;
    const character = page.locator('.svad-reference-slot[data-role="character"]');
    await assertPromptOnlyDraft(character);
    await character.locator('textarea').fill('一位黑色短发穿浅蓝上衣的年轻女性，保留五官脸型与服装。');
    await character.getByRole('button', { name: '生成三视图', exact: true }).click();
    await until(() => state.fixture.latestDocument()?.cards.every(card => card.visualAssetRefs?.length === 1), 'FIRST_REFERENCE_NOT_AUTOMATICALLY_BOUND');
    const saved = state.fixture.latestDocument(), planId = await character.getAttribute('data-plan-id');
    assert.equal(saved.visualAssetPlan.assets.length, 1); assert.equal(saved.visualAssetPlan.assets[0].id, planId); assert.equal(saved.visualAssetPlan.assets[0].source.assetId, 'owned_fixture_owner'); assert.ok(saved.visualAssetPlan.generationPolicy, 'FIRST_ADOPTION_GENERATION_POLICY_MISSING');
    for (const card of saved.cards) { assert.equal(card.visualAssetRefs[0].assetId, planId); assert.ok(card.referenceImageUrls.includes(`${mediaOrigin}/owned.svg`)); }
    assert.equal(await character.getByRole('button', { name: '使用这张', exact: true }).count(), 0, 'FIRST_REFERENCE_STILL_REQUIRES_MANUAL_ADOPTION');
    await page.goto(`${origin}/storyboard-workbench?projectId=${saved.id}`, { waitUntil: 'domcontentloaded' }); await page.locator('.sbw-shot-card').first().waitFor(); await page.getByRole('button', { name: '角色参考', exact: true }).click();
    await character.locator('.svad-slot-result').waitFor();
    const reloaded = state.fixture.projects.get(saved.id).document; assert.ok(reloaded.cards.every(card => card.visualAssetRefs.some(ref => ref.assetId === planId)), 'AUTO_BINDING_NOT_RESTORED');
    await character.getByRole('button', { name: '重新生成三视图', exact: true }).click(); await until(() => state.images.length === 2, 'SECOND_GENERATION_NOT_SUBMITTED');
    await character.locator('.svad-slot-result[data-asset-id="owned_fixture_owner_2"]').waitFor();
    await character.getByRole('button', { name: /使用这张|替换/u }).waitFor();
    const second = state.fixture.latestDocument(); assert.equal(second.visualAssetPlan.assets[0].source.assetId, 'owned_fixture_owner', 'SECOND_CANDIDATE_REPLACED_CONFIRMED_SOURCE'); assert.ok(second.cards.every(card => card.referenceImageUrls.includes(`${mediaOrigin}/owned.svg`) && !card.referenceImageUrls.includes(`${mediaOrigin}/owned-2.svg`)), 'SECOND_CANDIDATE_CHANGED_BOUND_URLS');
    assert.notEqual(state.receipts[0].assetId, state.receipts[1].assetId); assert.notEqual(state.receipts[0].storageKey, state.receipts[1].storageKey); assert.notEqual(state.receipts[0].recordId, state.receipts[1].recordId);
    assert.equal(state.images.length, 2); assert.equal(state.mutations.filter(item => item.path === '/api/image-workbench/persist').length, 0);
    done(state, { promptOnlyFirstReferenceAutoBound: true, allSegmentsBound: saved.cards.length, reloadPreservesBindings: true, regenerationRequiresExplicitReplacement: true, syntheticCompletionOnly: true }); await state.context.close();
  }
  {
    const document = structuredClone(base); document.id = 'fixture-auto-custom-empty'; document.title = '自动绑定保留独立空选择'; document.visualAssetPlan = { mode: 'off', assets: [] };
    document.cards.forEach((card, index) => { card.visualAssetRefs = []; card.referenceImageUrls = []; card.visualAssetSelectionMode = index === 0 ? 'custom' : 'project'; });
    const state = await prepare('first-auto-binding-preserves-custom-empty', { document, ownedGeneration: true }); const character = state.page.locator('.svad-reference-slot[data-role="character"]');
    await character.locator('textarea').fill('同一位黑色短发女性，浅蓝外衣，保持面部与服装身份。'); await character.getByRole('button', { name: '生成三视图', exact: true }).click();
    await until(() => state.fixture.latestDocument()?.cards.slice(1).every(card => card.visualAssetRefs?.length === 1), 'PROJECT_CARDS_NOT_AUTO_BOUND');
    const saved = state.fixture.latestDocument(); assert.equal(saved.cards[0].visualAssetSelectionMode, 'custom'); assert.deepEqual(saved.cards[0].visualAssetRefs, []); assert.deepEqual(saved.cards[0].referenceImageUrls, []);
    assert.equal(state.images.length, 1); assert.equal(state.mutations.filter(item => item.path === '/api/image-workbench/persist').length, 0);
    done(state, { projectCardsAutoBound: saved.cards.length - 1, customExplicitEmptyPreserved: true, syntheticCompletionOnly: true }); await state.context.close();
  }
  {
    const state = await prepare('uploaded-first-reference-auto-binds', { upload: true }); const pet = state.page.locator('.svad-reference-slot[data-role="pet"]');
    await assertPromptOnlyDraft(pet); await pet.locator('textarea').fill('一只成年橘猫，白色胸口，保持现有毛色与配饰。');
    await pet.locator('input[data-testid="reference-native-upload"]').setInputFiles({ name: 'synthetic-owned-reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1kAAAAASUVORK5CYII=', 'base64') });
    await until(() => state.fixture.latestDocument()?.visualAssetPlan?.assets.some(asset => asset.source?.assetId === 'owned_fixture_uploaded') && state.fixture.latestDocument().cards.every(card => card.visualAssetRefs?.length === 1), 'UPLOADED_FIRST_REFERENCE_NOT_AUTO_BOUND');
    assert.equal(state.images.length, 0); assert.equal(state.mutations.filter(item => item.path === '/api/storage/upload').length, 1); assert.equal(await pet.getByRole('button', { name: '使用这张', exact: true }).count(), 0);
    done(state, { uploadedFirstReferenceAutoBound: true, syntheticUploadOnly: true }); await state.context.close();
  }
  {
    const state = await prepare('auto-binding-save-failure-retains-candidate-without-paid-retry', { ownedGeneration: true, failAutoBinding: true }); const { page } = state; const character = page.locator('.svad-reference-slot[data-role="character"]');
    await character.locator('textarea').fill('黑色短发浅蓝外衣女性，面部服装身份保持一致。'); await character.getByRole('button', { name: '生成三视图', exact: true }).click();
    await until(() => state.rejectedAutoSaves.length > 0, 'AUTO_BINDING_SAVE_FAILURE_NOT_EXERCISED'); await character.getByRole('button', { name: /使用这张|替换/u }).waitFor();
    assert.ok(state.fixture.latestDocument().cards.every(card => !card.visualAssetRefs?.length), 'UNCONFIRMED_AUTO_BINDING_SAVED'); assert.ok(state.fixture.latestDocument().visualAssetWorkspace.candidates.some(candidate => candidate.assetId === 'owned_fixture_owner'), 'GENERATED_CANDIDATE_LOST_AFTER_AUTO_SAVE_FAILURE');
    const shot = page.locator('.sbw-shot-card').first(); await shot.locator('textarea[aria-label$="生图提示词"]').fill('保持人物服装身份，制作连续故事板。'); await shot.locator('.is-image-command').click(); await page.locator('.sbw-notice').filter({ hasText: /参考|采用|未确认/u }).waitFor(); await page.waitForTimeout(500);
    assert.equal(state.images.length, 1, 'AUTO_BINDING_FAILURE_TRIGGERED_NEW_PAID_REQUEST');
    done(state, { autoSaveRejected: state.rejectedAutoSaves.length, candidateRetained: true, downstreamBoardBlocked: true, noAutomaticGenerationRetry: true, syntheticCompletionOnly: true }); await state.context.close();
  }
  {
    const state = await prepare('generic-model-capability-switching', { capabilityModels: true }); const { page } = state;
    const model = page.getByLabel('参考图生图模型', { exact: true }), resolution = page.getByLabel('参考图清晰度', { exact: true }), ratio = page.getByLabel('参考图比例', { exact: true });
    await model.selectOption(limitedModel.id); assert.equal(await resolution.inputValue(), '1K'); assert.equal(await ratio.inputValue(), '1:1');
    assert.deepEqual(await resolution.locator('option').evaluateAll(nodes => nodes.filter(node => !node.disabled).map(node => node.value)), ['1K']); assert.deepEqual(await ratio.locator('option').evaluateAll(nodes => nodes.filter(node => !node.disabled).map(node => node.value)), ['1:1']);
    const character = page.locator('.svad-reference-slot[data-role="character"]'); await character.locator('textarea').fill('黑色短发、浅蓝外衣的女性身份参考，保持服装和面部。'); await character.getByRole('button', { name: '生成三视图', exact: true }).click(); await until(() => state.images.length === 1, 'SQUARE_THREE_VIEW_NOT_SUBMITTED'); assert.equal(state.images[0].resolution, '1K'); assert.equal(state.images[0].aspectRatio, '1:1'); await page.locator('.svad-error').waitFor();
    await model.selectOption(wideModel.id); await resolution.selectOption('2K'); await ratio.selectOption('16:9');
    assert.ok(await resolution.locator('option[value="4K"]').isEnabled()); assert.ok(await ratio.locator('option[value="16:9"]').isEnabled());
    await character.getByRole('button', { name: '生成三视图', exact: true }).click(); await until(() => state.images.length === 2, 'WIDE_2K_THREE_VIEW_NOT_SUBMITTED'); assert.equal(state.images[1].modelId, wideModel.id); assert.equal(state.images[1].resolution, '2K'); assert.equal(state.images[1].aspectRatio, '16:9'); await page.locator('.svad-error').waitFor();
    await resolution.selectOption('4K'); await character.getByRole('button', { name: '生成三视图', exact: true }).click(); await until(() => state.images.length === 3, 'WIDE_4K_THREE_VIEW_NOT_SUBMITTED'); assert.equal(state.images[2].modelId, wideModel.id); assert.equal(state.images[2].resolution, '4K'); assert.equal(state.images[2].aspectRatio, '16:9'); await page.locator('.svad-error').waitFor();
    const settings = state.fixture.latestDocument().visualAssetWorkspace.generationSettings; assert.deepEqual(settings, { modelId: wideModel.id, resolution: '4K', ratio: '16:9' });
    done(state, { syntheticCapabilitiesOnly: true, channelCapabilitiesVerified: false, interceptedSettings: state.images.map(body => ({ modelId: body.modelId, resolution: body.resolution, aspectRatio: body.aspectRatio })), persistedSettings: settings }); await state.context.close();
  }
  for (const kind of ['active-image', 'unknown-video']) {
    const document = structuredClone(base); document.id = `fixture-first-adopt-${kind}`; document.title = `首次采用保护 ${kind}`; document.visualAssetPlan = { mode: 'selected', assets: [] };
    document.cards.forEach(card => { card.visualAssetRefs = []; card.referenceImageUrls = []; card.visualAssetSelectionMode = 'project'; });
    if (kind === 'active-image') { document.cards[0].imageStatus = 'queued'; document.cards[0].imageRetryBlocked = true; }
    else { document.cards[0].videoStatus = 'failed'; document.cards[0].videoRetryable = false; document.cards[0].videoClientRequestId = 'fixture-unknown-original-video-key'; }
    const state = await prepare(`first-adoption-protects-${kind}`, { document, ownedGeneration: true }); const { page } = state;
    const character = page.locator('.svad-reference-slot[data-role="character"]'); await character.locator('textarea').fill('黑色短发的女性角色，浅蓝外衣，保持同一五官与服装。');
    await character.getByRole('button', { name: '生成三视图', exact: true }).click(); await character.getByRole('button', { name: '使用这张', exact: true }).waitFor();
    const writeCount = state.fixture.projectWrites.length; await character.getByRole('button', { name: '使用这张', exact: true }).click(); await page.locator('.svad-error').waitFor(); await page.waitForTimeout(200);
    assert.equal(state.fixture.latestDocument().visualAssetPlan.assets.length, 0, 'NEWLY_AFFECTED_TASK_REFERENCE_CHANGED'); assert.ok(state.fixture.projectWrites.slice(writeCount).every(write => write.document.cards.every(card => !card.visualAssetRefs.length)), 'UNKNOWN_OR_ACTIVE_TASK_ADOPTION_SAVED'); assert.equal(state.images.length, 1);
    done(state, { finalAffectedTaskProtected: kind, syntheticCompletionOnly: true }); await state.context.close();
  }
  {
    const document = boundDocument(base), state = await prepare('bound-delete-rollback-and-commit', { document, failRemoval: true }); const { page } = state;
    const card = page.locator('.svad-reference-slot[data-plan-id="fixture_owner"]'); await card.locator('.svad-delete-draft').click(); await until(() => state.rejectedSaves.length > 0, 'REMOVAL_SAVE_NOT_EXERCISED'); await page.waitForTimeout(300); assert.equal(await card.count(), 1, 'FAILED_SAVE_REMOVED_REFERENCE');
    state.failRemoval = false; await card.locator('.svad-delete-draft').click(); await page.waitForFunction(() => !document.querySelector('.svad-reference-slot[data-plan-id="fixture_owner"]'));
    const saved = state.fixture.latestDocument(); assert.ok(saved.cards.every(item => !item.visualAssetRefs.some(ref => ref.assetId === 'fixture_owner')), 'CUSTOM_OR_PROJECT_BINDING_REMAINS');
    for (let i = 0; i < saved.cards.length; i++) { assert.equal(saved.cards[i].imageAssetId, document.cards[i].imageAssetId); assert.equal(saved.cards[i].videoUrl, document.cards[i].videoUrl); assert.equal(saved.cards[i].imageReferenceState, 'stale', 'MEDIA_NOT_MARKED_STALE'); }
    assert.equal(state.images.length, 0); done(state, { failedSaveRetainsCard: true, customAndProjectUnbound: true, oldMediaRetained: true, rejectedSaves: state.rejectedSaves.length }); await state.context.close();
  }
  {
    const document = boundDocument(base, true); const pending = { projectId: document.id, planId: 'fixture_owner', role: 'character', name: '测试人物', prompt: '未知任务原始提示词', modelId: imageModel.id, modelName: imageModel.displayName, resolution: '2K', ratio: '16:9', quotedPrice: 0.2, clientTraceId: 'fixture-unknown-trace', clientIdempotencyKey: 'fixture-unknown-key', createdAt: new Date().toISOString() };
    const state = await prepare('unknown-task-delete-protection', { document, pending }); const card = state.page.locator('.svad-reference-slot[data-plan-id="fixture_owner"]');
    if (await card.locator('.svad-delete-draft').isEnabled()) { await card.locator('.svad-delete-draft').click(); await state.page.locator('.svad-error').waitFor(); }
    assert.equal(await card.count(), 1, 'UNKNOWN_TASK_CARD_REMOVED'); assert.ok(state.fixture.projectWrites.every(write => write.document.visualAssetWorkspace.drafts.some(draft => draft.planId === 'fixture_owner')), 'UNKNOWN_TASK_REFERENCE_DELETED'); assert.equal(state.images.length, 0); done(state, { unknownTaskRetainsCard: true }); await state.context.close();
  }
  {
    const state = await prepare('neighbor-pages'); for (const route of ['/video', '/tools']) for (const theme of ['lattice', 'soft-white', 'crystal-aurora']) await visuals(state, route, theme, 1440); assert.equal(state.images.length, 0); done(state); await state.context.close();
  }
  report.runtimeAfter = await identity(); assert.deepEqual(report.runtimeAfter, report.runtimeBefore, 'BUILD_CHANGED_DURING_ACCEPTANCE'); report.passed = true;
} catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await browser?.close(); await writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, visuals: report.visuals.length, output, error: report.error?.message })); }
