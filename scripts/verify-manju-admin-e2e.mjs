import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { manjuConfigSemanticHash } from './lib/manju-config-semantic-hash.mjs';

const origin = process.env.LOCAL_NAV_ORIGIN?.trim() || 'http://127.0.0.1:5000';
if (origin !== 'http://127.0.0.1:5000' && origin !== 'http://127.0.0.1:5002') throw new Error('LOCAL_NAV_ORIGIN_MUST_BE_LOOPBACK_PREVIEW');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
const output = process.argv[2];
const mode = process.argv[3] || 'assets';
if (!token || !output || !['inspect', 'assets', 'assets-resume', 'prompt'].includes(mode)) throw new Error('NORMAL_SESSION_OUTPUT_AND_MODE_REQUIRED');
const resume = mode === 'assets-resume' ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) : null;
if (resume && (!/^e2e-manju-\d+-[a-z0-9]+$/u.test(resume.marker) || !/^manju-[a-z0-9_-]+$/u.test(resume.assetId))) throw new Error('OWN_ASSET_EVIDENCE_REQUIRED');
const marker = resume?.marker || `e2e-manju-${Date.now()}-${randomUUID().slice(0, 8)}`;
const report = { observedAt: new Date().toISOString(), origin, mode, marker, authentication: 'normal-login-token-verified-via-auth-me', responseFixtures: false, generationSubmitted: false, secretsSaved: false, steps: [], httpErrors: [], pageErrors: [], requestFailures: [], blocked: [] };
const headers = { Authorization: `Bearer ${token}` };
const assetsPath = '/api/admin/manju-workbench/assets';
const configPath = '/api/admin/manju-config';
const configQuery = `${configPath}?environment=development&domain=prompt`;
const advancingGet = new Set(['/api/video/status', '/api/video/poll', '/api/video/stream', '/api/image/status', '/api/admin/voice-studio/voices/sync']);
const safePath = (value) => { const url = new URL(value, origin); return url.origin === origin ? url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id') : 'external-asset'; };
const check = (value, reason) => { if (!value) throw new Error(reason); };
const hash = manjuConfigSemanticHash;
const releaseId = (record) => record?.release_id || record?.active_release_id || record?.pointer?.active_release_id || record?.release?.id || '';
const revision = (record) => record?.revision || record || {};
let browser;
let page;
let frontPage;
let ownAssetId = resume?.assetId || '';
let assetCleaned = false;
let promptBasePayload;
let promptOwnKey = '';
let promptCleaned = false;
let stage = 'authenticate';
async function api(endpoint, options = {}) {
  const response = await fetch(`${origin}${endpoint}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) report.httpErrors.push({ stage, path: safePath(endpoint), status: response.status, code: typeof body.code === 'string' ? body.code : undefined });
  check(response.ok, `API_${response.status}`);
  return body;
}
async function waitMutation(action, pathname, method) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === pathname && response.request().method() === method, { timeout: 45000 }),
    Promise.resolve().then(action),
  ]);
  const body = await response.json().catch(() => ({}));
  report.steps.push({ stage, status: response.status(), code: typeof body.code === 'string' ? body.code : undefined });
  check(response.ok() && body.ok !== false, `MUTATION_${response.status()}`);
  return body;
}
try {
  const auth = await api('/api/auth/me');
  check(auth.user?.username === '18685178259' && auth.user?.role === 'admin', 'EXPECTED_ADMIN_REQUIRED');
  const initialAssets = await api(assetsPath);
  const initialConfig = await api(configQuery);
  report.preflight = { assetCount: initialAssets.assets?.length || 0, prompt: { environment: initialConfig.environment, domain: initialConfig.domain, storageMode: initialConfig.storage_mode, activePresent: Boolean(initialConfig.active), activeReleaseId: releaseId(initialConfig.active) || null, activePayloadHash: initialConfig.active ? hash(revision(initialConfig.active).payload) : null, draftCount: initialConfig.drafts?.length || 0, historyCount: initialConfig.history?.length || 0 } };
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(({ tokenValue, user, expectedOrigin }) => { if (location.origin !== expectedOrigin) return; localStorage.setItem('auth_token', tokenValue); localStorage.setItem('auth_user', JSON.stringify(user)); }, { tokenValue: token, user: auth.user, expectedOrigin: origin });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let allowed = method === 'GET' && !(url.origin === origin && advancingGet.has(url.pathname));
    if (method === 'POST' && url.origin === origin && url.pathname === '/__nextjs_original-stack-frames') allowed = true;
    if ((mode === 'assets' || mode === 'assets-resume') && url.origin === origin && url.pathname === assetsPath) {
      if (method === 'POST') allowed = mode === 'assets' && request.postDataBuffer()?.includes(Buffer.from(marker)) === true;
      if (method === 'PATCH') { try { allowed = Boolean(ownAssetId) && JSON.parse(request.postData() || '{}').id === ownAssetId; } catch { allowed = false; } }
      if (method === 'DELETE') allowed = Boolean(ownAssetId) && url.searchParams.get('id') === ownAssetId;
    }
    if (mode === 'prompt' && method === 'POST' && url.origin === origin && url.pathname === configPath) {
      try { const body = JSON.parse(request.postData() || '{}'); allowed = body.environment === 'development' && body.domain === 'prompt' && ['validate', 'save-draft', 'publish'].includes(body.action); } catch { allowed = false; }
    }
    if (allowed) await route.continue();
    else { report.blocked.push({ stage, path: safePath(url.href), method }); await route.abort('blockedbyclient'); }
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('dialog', async (dialog) => { if (dialog.type() === 'confirm' && (stage === 'asset-ui-delete' || stage === 'prompt-ui-publish' || stage === 'prompt-ui-remove-publish')) await dialog.accept(); else await dialog.dismiss(); });
  page.on('pageerror', (error) => report.pageErrors.push({ stage, name: error.name, category: /localStorage|sessionStorage/u.test(error.message) ? 'browser-storage' : /History|history|pushState|replaceState/u.test(error.message) ? 'browser-history' : 'other' }));
  page.on('requestfailed', (request) => report.requestFailures.push({ stage, path: safePath(request.url()), method: request.method(), reason: request.failure()?.errorText.match(/(?:net::)?ERR_[A-Z_]+/u)?.[0] || 'REQUEST_FAILED' }));
  page.on('response', (response) => { if (response.status() >= 400) report.httpErrors.push({ stage, path: safePath(response.url()), status: response.status() }); });
  stage = 'admin-navigation';
  const navigation = await page.goto(`${origin}/admin?tab=manju-workbench`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  report.steps.push({ stage, status: navigation?.status() });
  const manager = page.locator('[data-admin-section="manju-showcase-catalog"]');
  await manager.getByRole('button', { name: '上传并登记到素材池', exact: true }).waitFor({ state: 'visible', timeout: 45000 });
  report.steps.push({ stage, assetManagerVisible: true, uploadInputCount: await manager.locator('input[type="file"]').count(), promptConfigVisible: await page.locator('[data-admin-section="manju-config-center"]').count() === 1 });
  if (mode === 'assets' || mode === 'assets-resume') {
    const editedTitle = `${marker}-edited`;
    const originalRegistry = initialAssets.assets.filter((asset) => asset.id !== ownAssetId);
    if (!resume) {
    stage = 'asset-ui-upload';
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4f46e5'; ctx.fillRect(0, 0, 96, 96); ctx.fillStyle = '#fde047'; ctx.beginPath(); ctx.arc(48, 48, 24, 0, Math.PI * 2); ctx.fill(); return canvas.toDataURL('image/png').split(',')[1]; });
    await manager.locator('input[type="file"]').setInputFiles({ name: `${marker}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await manager.getByLabel('展示标题', { exact: true }).fill(marker);
    await manager.getByLabel('展示摘要', { exact: true }).fill('本地端到端验收自绘几何测试图，非 AI 生成。');
    const upload = await waitMutation(() => manager.getByRole('button', { name: '上传并登记到素材池', exact: true }).click(), assetsPath, 'POST');
    ownAssetId = upload.asset?.id || '';
    check(/^manju-[a-z0-9_-]+$/u.test(ownAssetId), 'UPLOAD_RECEIPT_MISSING');
    report.assetId = ownAssetId;
    check(!initialAssets.assets?.some((asset) => asset.id === ownAssetId), 'ASSET_OWNERSHIP_COLLISION');
    const row = manager.locator('article').filter({ has: page.getByText(ownAssetId, { exact: false }) }).first();
    await row.getByRole('button', { name: '保存素材信息', exact: true }).waitFor({ state: 'visible' });
    const uploaded = (await api(assetsPath)).assets.find((asset) => asset.id === ownAssetId);
    check(uploaded?.title === marker && uploaded.enabled === true, 'UPLOAD_READBACK_MISMATCH');
    report.steps.push({ stage: 'asset-upload-readback', persisted: true, contentType: uploaded.contentType, size: uploaded.size });
    stage = 'asset-ui-edit';
    await row.getByLabel('标题', { exact: true }).fill(editedTitle);
    await waitMutation(() => row.getByRole('button', { name: '保存素材信息', exact: true }).click(), assetsPath, 'PATCH');
    const edited = (await api(assetsPath)).assets.find((asset) => asset.id === ownAssetId);
    check(edited?.title === editedTitle, 'EDIT_READBACK_MISMATCH');
    } else {
      const retained = initialAssets.assets.find((asset) => asset.id === ownAssetId);
      check(retained?.title === editedTitle && retained.enabled === true && !retained.deletedAt, 'RETAINED_OWN_ASSET_REQUIRED');
      report.assetId = ownAssetId;
      report.steps.push({ stage: 'asset-resume', originalAssetReused: true, uploadSubmitted: false, editSubmitted: false });
    }
    const row = manager.locator('article').filter({ has: page.getByText(ownAssetId, { exact: false }) }).first();
    const publicResult = await api(`/api/inspiration?search=${encodeURIComponent(marker)}&limit=20`);
    const publicItem = publicResult.data?.find((item) => item.id === ownAssetId);
    check(publicItem?.metadata?.title === editedTitle, 'PUBLIC_API_EDIT_MISMATCH');
    report.steps.push({ stage: 'asset-public-api-readback', found: true, editedTitleMatched: true });
    stage = 'asset-frontend';
    const front = await context.newPage();
    frontPage = front;
    report.frontDocumentEvents = [];
    report.frontHotReloadEvents = [];
    front.on('framenavigated', (frame) => { if (frame === front.mainFrame()) report.frontDocumentEvents.push({ stage, at: new Date().toISOString(), path: safePath(frame.url()), cssRecovery: new URL(frame.url(), origin).searchParams.has('_nocache') }); });
    front.on('console', (message) => { const text = message.text(); if (/\[Fast Refresh\]|\[HMR\]|CSS健康检测/u.test(text)) report.frontHotReloadEvents.push({ stage, at: new Date().toISOString(), event: /CSS健康检测/u.test(text) ? 'css-recovery' : /rebuilding/u.test(text) ? 'rebuilding' : /done/u.test(text) ? 'done' : 'hmr-event' }); });
    front.on('pageerror', (error) => report.pageErrors.push({ stage, name: error.name, page: 'inspiration' }));
    front.on('response', (response) => {
      const pathname = safePath(response.url());
      if (pathname.startsWith('/api/youcai/public-assets/')) report.steps.push({ stage: 'asset-image-response', status: response.status(), contentType: response.headers()['content-type'], contentLength: response.headers()['content-length'] });
      if (response.status() >= 400) report.httpErrors.push({ stage, path: pathname, status: response.status(), page: 'inspiration' });
    });
    front.on('requestfailed', (request) => report.requestFailures.push({ stage, page: 'inspiration', path: safePath(request.url()), method: request.method(), reason: request.failure()?.errorText.match(/(?:net::)?ERR_[A-Z_]+/u)?.[0] || 'REQUEST_FAILED' }));
    await front.goto(`${origin}/youcai/inspiration`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await front.getByPlaceholder('搜索提示词或文件名...').fill(marker);
    const found = await front.getByText(editedTitle, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    report.steps.push({ stage, titleVisible: found });
    if (found) {
      stage = 'asset-frontend-image';
      const img = front.getByRole('img', { name: editedTitle, exact: true }).first();
      await img.waitFor({ state: 'visible' });
      const decoded = await img.evaluate(async (image) => { try { await image.decode(); return { success: true, naturalWidth: image.naturalWidth, connected: image.isConnected }; } catch (error) { return { success: false, errorName: error.name, complete: image.complete, naturalWidth: image.naturalWidth, connected: image.isConnected, sourcePath: new URL(image.currentSrc || image.src, location.href).pathname }; } });
      report.steps.push({ stage: 'asset-image-decode', ...decoded });
      if (!decoded.success) {
        try {
          const response = await fetch(`${origin}/api/youcai/public-assets/${ownAssetId}`, { signal: AbortSignal.timeout(15000) });
          const bytes = Buffer.from(await response.arrayBuffer());
          report.steps.push({ stage: 'asset-direct-readback', status: response.status, contentType: response.headers.get('content-type'), bytes: bytes.length, pngSignature: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) });
        } catch (error) { report.steps.push({ stage: 'asset-direct-readback', errorName: error.name }); }
      }
      check(decoded.success, 'PUBLIC_ASSET_IMAGE_DECODE_FAILED');
      report.steps.push({ stage: 'asset-frontend-image', decoded: true, naturalWidth: await img.evaluate((image) => image.naturalWidth) });
    }
    await front.close();
    frontPage = undefined;
    stage = 'asset-ui-delete';
    await waitMutation(() => row.getByRole('button', { name: '下线素材', exact: true }).click(), assetsPath, 'DELETE');
    const removed = (await api(assetsPath)).assets.find((asset) => asset.id === ownAssetId);
    const publicAfter = await api(`/api/inspiration?search=${encodeURIComponent(marker)}&limit=20`);
    check(Boolean(removed?.deletedAt) && removed.enabled === false && !publicAfter.data?.some((item) => item.id === ownAssetId), 'CLEANUP_READBACK_MISMATCH');
    assetCleaned = true;
    const originalsAfter = (await api(assetsPath)).assets.filter((asset) => asset.id !== ownAssetId);
    report.steps.push({ stage: 'asset-cleanup-readback', deletedAtPresent: true, publicAbsent: true, originalRegistryUnchanged: hash(originalsAfter) === hash(originalRegistry) });
    check(found, 'FRONTEND_ASSET_NOT_VISIBLE');
  }
  if (mode === 'prompt') {
    stage = 'prompt-ui-development';
    const config = page.locator('[data-admin-section="manju-config-center"]');
    const environmentSelect = config.getByRole('combobox', { name: '运行环境', exact: true });
    await environmentSelect.waitFor({ state: 'visible' });
    if (await environmentSelect.inputValue() !== 'development') {
      await Promise.all([
        page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === configPath && url.searchParams.get('environment') === 'development' && response.request().method() === 'GET'; }),
        environmentSelect.selectOption('development'),
      ]);
    }
    check(await environmentSelect.inputValue() === 'development', 'PROMPT_ENVIRONMENT_MISMATCH');
    report.steps.push({ stage, environmentSelected: 'development' });
    stage = 'prompt-ui-baseline';
    const baseline = config.getByRole('button', { name: '载入服务端基线', exact: true });
    await baseline.waitFor({ state: 'visible' });
    if (initialConfig.active) {
      await config.getByRole('button', { name: '载入线上版本作为草稿起点', exact: true }).click();
      promptBasePayload = structuredClone(revision(initialConfig.active).payload);
    } else {
      const [baselineResponse] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/manju-workbench/prompts' && response.request().method() === 'GET'),
        Promise.resolve().then(() => baseline.click()),
      ]);
      check(baselineResponse.ok(), 'PROMPT_BASELINE_HTTP_FAILED');
      await page.waitForFunction(() => {
        const editor = document.querySelector('[data-admin-section="manju-config-center"] textarea');
        try { const payload = JSON.parse(editor?.value || '{}'); return typeof payload.runtime_prompts?.manga_virtual_agent_prompt?.content === 'string' && payload.runtime_prompts.manga_virtual_agent_prompt.content.length > 0; } catch { return false; }
      }, undefined, { timeout: 15000 });
      const baselineEditor = JSON.parse(await config.getByLabel('JSON 配置草稿', { exact: false }).inputValue());
      promptBasePayload = { version: '2026-08-29', policy: 'private-server-runtime-prompts', verification_scope: 'local-development-e2e', verification_run: marker, runtime_prompts: { manga_virtual_agent_prompt: baselineEditor.runtime_prompts?.manga_virtual_agent_prompt } };
    }
    check(promptBasePayload?.runtime_prompts?.manga_virtual_agent_prompt?.content, 'PROMPT_BASELINE_UNAVAILABLE');
    report.steps.push({ stage, baselineLoadedIntoEditor: true });
    promptOwnKey = marker.replaceAll('-', '_');
    const editedPayload = structuredClone(promptBasePayload);
    const testContent = '这是本地 development 环境的端到端验收测试条目，仅验证草稿、编辑、发布与删除映射，不调用任何模型，不包含个人信息，不替换生产提示词。'.repeat(4);
    editedPayload.runtime_prompts[promptOwnKey] = { version: 'test-v1', content: testContent };
    const editor = config.getByLabel('JSON 配置草稿', { exact: false });
    await editor.fill(JSON.stringify(editedPayload, null, 2));
    stage = 'prompt-ui-create';
    const created = await waitMutation(() => config.getByRole('button', { name: '保存草稿', exact: true }).click(), configPath, 'POST');
    const ownRevisionId = revision(created.revision).id;
    check(ownRevisionId && !initialConfig.drafts?.some((record) => revision(record).id === ownRevisionId), 'PROMPT_NEW_REVISION_REQUIRED');
    let readback = await api(configQuery);
    check(readback.drafts?.some((record) => revision(record).id === ownRevisionId && revision(record).payload?.runtime_prompts?.[promptOwnKey]?.version === 'test-v1'), 'PROMPT_CREATE_READBACK_MISMATCH');
    report.steps.push({ stage: 'prompt-create-readback', ownRevisionId, persisted: true });
    stage = 'prompt-ui-edit';
    editedPayload.runtime_prompts[promptOwnKey] = { version: 'test-v2', content: `${testContent}\n测试条目第二版。` };
    await editor.fill(JSON.stringify(editedPayload, null, 2));
    const updated = await waitMutation(() => config.getByRole('button', { name: '保存草稿', exact: true }).click(), configPath, 'POST');
    check(revision(updated.revision).id === ownRevisionId, 'PROMPT_EDIT_REVISION_CHANGED');
    readback = await api(configQuery);
    check(readback.drafts?.some((record) => revision(record).id === ownRevisionId && revision(record).payload?.runtime_prompts?.[promptOwnKey]?.version === 'test-v2'), 'PROMPT_EDIT_READBACK_MISMATCH');
    report.steps.push({ stage: 'prompt-edit-readback', sameRevision: true, editedVersionMatched: true });
    stage = 'prompt-ui-publish';
    await waitMutation(() => config.getByRole('button', { name: '发布所选草稿', exact: true }).click(), configPath, 'POST');
    readback = await api(configQuery);
    check(revision(readback.active).payload?.runtime_prompts?.[promptOwnKey]?.version === 'test-v2', 'PROMPT_PUBLISH_READBACK_MISMATCH');
    report.steps.push({ stage: 'prompt-published-readback', environment: 'development', ownEntryActive: true, releaseId: releaseId(readback.active), payloadHash: hash(revision(readback.active).payload), productionRuntimeTested: false });
    stage = 'prompt-ui-remove';
    await config.getByRole('button', { name: '载入线上版本作为草稿起点', exact: true }).click();
    await editor.fill(JSON.stringify(promptBasePayload, null, 2));
    await waitMutation(() => config.getByRole('button', { name: '保存草稿', exact: true }).click(), configPath, 'POST');
    stage = 'prompt-ui-remove-publish';
    await waitMutation(() => config.getByRole('button', { name: '发布所选草稿', exact: true }).click(), configPath, 'POST');
    readback = await api(configQuery);
    check(!Object.hasOwn(revision(readback.active).payload?.runtime_prompts || {}, promptOwnKey) && hash(revision(readback.active).payload) === hash(promptBasePayload), 'PROMPT_REMOVE_READBACK_MISMATCH');
    promptCleaned = true;
    report.steps.push({ stage: 'prompt-removal-readback', ownEntryInactive: true, finalPayloadMatchesBaseline: true, initiallyUnpublished: !initialConfig.active, auditHistoryRetained: true, originalDraftsPreserved: initialConfig.drafts.every((item) => readback.drafts.some((current) => hash(current) === hash(item))) });
  }
  report.passed = true;
} catch (error) {
  report.failure = { stage, name: error.name, reason: /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'BROWSER_STEP_FAILED' };
  if (frontPage) report.frontDomState = await frontPage.evaluate(() => ({ imageCount: document.images.length, imageWidths: [...document.images].map((image) => ({ complete: image.complete, width: image.naturalWidth })), previewErrorCount: document.querySelectorAll('[aria-label$="素材预览加载失败"]').length, alertCount: document.querySelectorAll('[role="alert"]').length })).catch(() => ({ inaccessible: true }));
  if (page) report.domState = await page.evaluate(() => ({
    path: location.pathname,
    readyState: document.readyState,
    adminPanelCount: document.querySelectorAll('[data-admin-panel="manju-workbench"]').length,
    managerCount: document.querySelectorAll('[data-admin-section="manju-showcase-catalog"]').length,
    configCount: document.querySelectorAll('[data-admin-section="manju-config-center"]').length,
    visibleHeadingCount: [...document.querySelectorAll('h1,h2,h3')].filter((node) => node.getBoundingClientRect().height > 0).length,
    loadingTextPresent: /正在读取|正在载入|加载中/u.test(document.body.textContent || ''),
    loginRequiredTextPresent: /请先登录|登录已过期|登录状态无效/u.test(document.body.textContent || ''),
    alertCount: document.querySelectorAll('[role="alert"]').length,
    authPresent: Boolean(localStorage.getItem('auth_token')),
  })).catch(() => ({ inaccessible: true }));
  report.passed = false;
} finally {
  if (promptOwnKey && !promptCleaned) report.promptCleanupRequired = { environment: 'development', domain: 'prompt', ownEntryKey: promptOwnKey };
  if (ownAssetId && !assetCleaned) {
    report.cleanupRequired = { assetId: ownAssetId, retainedForStableResume: true };
  }
  try { if (browser) await browser.close(); } catch (error) { report.browserCloseError = { name: error.name }; }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
