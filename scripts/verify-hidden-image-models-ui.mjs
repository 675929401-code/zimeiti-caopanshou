import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import sharp from 'sharp';
import pg from 'pg';
import { validateLocalPreviewRuntime, LOCAL_PREVIEW_RUNTIME_FILE, LOCAL_PREVIEW_DATA_ROOT } from './start-local-data-preview.mjs';

// One deliberate UI dispatch per invocation. Resume is GET-only unless root
// explicitly requests original-result persistence; there is no raw generator.
const CANDIDATES = ['cover-model-qwen-edit', 'cover-model-seedream-5', 'cover-model-seedream-5-pro', 'gpt-image-2-chA-1', 'qwen-image-2512-hq-selfhost-pro6000'];
const SELFHOST = CANDIDATES[4], KEY = /^iav_[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
export function validateSelectedImageRequest(body, dto, modelId, previousBody = null) {
  if (!CANDIDATES.includes(modelId) || modelId === SELFHOST) fail('MODEL_NOT_ADMITTED_FOR_DISPATCH');
  if (!body || body.modelId !== modelId || body.mode !== 'local' || body.noRetry !== true || body.strictSingleSubmit !== true) fail('SELECTED_MODEL_SINGLE_SUBMIT_REQUIRED');
  const proof = body.adminValidation;
  if (!proof || !KEY.test(proof.validationKey) || proof.validationKey !== body.clientIdempotencyKey || proof.validationKey !== body.clientTraceId
    || proof.clientIdempotencyKey !== proof.validationKey || proof.clientTraceId !== proof.validationKey
    || proof.confirmation !== 'RUN_SINGLE_REAL_IMAGE_VALIDATION' || proof.validationKey !== dto.validationKey
    || proof.configurationHash !== dto.configurationHash || proof.epoch !== dto.epoch) fail('ORIGINAL_PROOF_BINDING_REQUIRED');
  if (previousBody && JSON.stringify(body) !== JSON.stringify(previousBody)) fail('RECOVERY_BODY_CHANGED');
  if (modelId === CANDIDATES[0] && (!Array.isArray(body.referenceImageUrls) || body.referenceImageUrls.length !== 1)) fail('QWEN_EDIT_REFERENCE_REQUIRED');
  return true;
}
export function consumeMutationPermit(state, kind, body, dto, modelId, previousBody) {
  if (kind === 'generate') {
    if (state.generateConsumed || !state.generateAllowed) fail('SECOND_OR_UNAUTHORIZED_GENERATION_BLOCKED');
    validateSelectedImageRequest(body, dto, modelId, previousBody);
    state.generateConsumed = true;
  } else if (kind === 'publish') {
    if (!state.publishAllowed || state.publishConsumed || !state.fullProof) fail('PUBLICATION_REQUIRES_COMPLETE_PROOF');
    if (body.modelId !== modelId || body.imageRecordId !== state.imageRecordId || body.confirmation !== 'PUBLISH_VALIDATED_IMAGE_MODEL') fail('PUBLICATION_IDENTITY_CHANGED');
    if (body.proof?.validationKey !== dto.validationKey || body.proof?.configurationHash !== dto.configurationHash || body.proof?.epoch !== dto.epoch) fail('PUBLICATION_PROOF_CHANGED');
    state.publishConsumed = true;
  } else if (kind === 'upload') {
    if (!state.uploadAllowed || state.uploadConsumed) fail('REFERENCE_UPLOAD_BLOCKED');
    state.uploadConsumed = true;
  } else fail('UNAUTHORIZED_MUTATION');
}

async function selfTest() {
  const dto = { validationKey: `iav_${'a'.repeat(64)}`, configurationHash: 'b'.repeat(64), epoch: 0 };
  const proof = { ...dto, clientIdempotencyKey: dto.validationKey, clientTraceId: dto.validationKey, confirmation: 'RUN_SINGLE_REAL_IMAGE_VALIDATION' };
  const body = { modelId: CANDIDATES[1], mode: 'local', noRetry: true, strictSingleSubmit: true, clientIdempotencyKey: dto.validationKey, clientTraceId: dto.validationKey, adminValidation: proof };
  let passed = 0;
  const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
  test('valid signed selected model', () => assert.equal(validateSelectedImageRequest(body, dto, body.modelId), true));
  test('no silent model substitution', () => assert.throws(() => validateSelectedImageRequest({ ...body, modelId: CANDIDATES[2] }, dto, body.modelId)));
  test('same original key and trace', () => assert.throws(() => validateSelectedImageRequest({ ...body, clientTraceId: 'changed' }, dto, body.modelId)));
  test('configuration change invalidates dispatch', () => assert.throws(() => validateSelectedImageRequest(body, { ...dto, configurationHash: 'c'.repeat(64) }, body.modelId)));
  test('selfhost cannot start compute', () => assert.throws(() => validateSelectedImageRequest({ ...body, modelId: SELFHOST }, dto, SELFHOST)));
  test('existing public Gemini/Nano cannot dispatch', () => assert.throws(() => validateSelectedImageRequest({ ...body, modelId: 'gemini-3-1-flash-image-chA' }, dto, 'gemini-3-1-flash-image-chA')));
  test('second POST blocked synchronously', () => { const state = { generateAllowed: true }; consumeMutationPermit(state, 'generate', body, dto, body.modelId); assert.throws(() => consumeMutationPermit(state, 'generate', body, dto, body.modelId)); });
  test('inspect/resume default cannot POST', () => assert.throws(() => consumeMutationPermit({}, 'generate', body, dto, body.modelId)));
  test('recovery body cannot change', () => assert.throws(() => validateSelectedImageRequest({ ...body, prompt: 'new' }, dto, body.modelId, body)));
  test('incomplete result cannot publish', () => assert.throws(() => consumeMutationPermit({ publishAllowed: true }, 'publish', {}, dto, body.modelId)));
  test('publication stays original proof and one write', () => { const state = { publishAllowed: true, fullProof: true, imageRecordId: 'd'.repeat(64) }; const input = { modelId: body.modelId, imageRecordId: state.imageRecordId, proof, confirmation: 'PUBLISH_VALIDATED_IMAGE_MODEL' }; consumeMutationPermit(state, 'publish', input, dto, body.modelId); assert.throws(() => consumeMutationPermit(state, 'publish', input, dto, body.modelId)); });
  console.log(JSON.stringify({ passed, networkRequests: 0, databaseConnections: 0 }));
}

async function run() {
  const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
  if (!['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin)) fail('EXACT_LOCAL_ORIGIN_REQUIRED');
  const args = process.argv.slice(2), mode = args.find(arg => ['inspect', 'submit-once', 'resume'].includes(arg)) || 'inspect';
  const modelId = args.find(arg => arg.startsWith('--model-id='))?.slice(11);
  const publishRequested = args.includes('--publish'), recoveryRequested = args.includes('--recover-original');
  for (const arg of args) if (!['inspect', 'submit-once', 'resume', '--publish', '--recover-original'].includes(arg) && !arg.startsWith('--model-id=')) fail('UNSUPPORTED_ARGUMENT');
  if (modelId && !CANDIDATES.includes(modelId)) fail('MODEL_OUTSIDE_REMAINING_FIVE');
  if (mode !== 'inspect' && !modelId) fail('EXACT_SINGLE_MODEL_REQUIRED');
  if (mode === 'inspect' && (publishRequested || recoveryRequested)) fail('INSPECT_IS_READ_ONLY');
  if (recoveryRequested && mode !== 'resume') fail('RECOVERY_REQUIRES_RESUME');
  if (mode !== 'inspect' && modelId === SELFHOST) fail('SELFHOST_READ_ONLY_NO_COMPUTE_START');
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN; if (!token) fail('NORMAL_ADMIN_SESSION_ENV_REQUIRED');
  const runtime = JSON.parse(await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8')); validateLocalPreviewRuntime(runtime);
  if (runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') fail('EXACT_LOCAL_DATABASE_REQUIRED');
  const out = '.codex-evidence/image-hidden-real-e2e-20260903'; await fs.mkdir(out, { recursive: true });
  const reportFile = `${out}/${mode}-${modelId || 'five'}-${Date.now()}.json`;
  const report = { at: new Date().toISOString(), origin, mode, modelId: modelId || null, stage: 'identity', generationPosts: 0, uploadPosts: 0, publishPosts: 0,
    httpErrors: [], requestFailures: [], pageErrors: [], blocked: [], inspection: [], stages: [], normalAdministratorSession: true, passed: false };
  const safeCode = value => String(value || '').replaceAll(token, '[redacted]').replace(/https?:\/\/\S+/gi, '[url]').replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').slice(0, 260);
  const persistReport = async () => fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  const stage = async value => { report.stage = value; report.stages.push({ name: value, at: new Date().toISOString() }); await persistReport(); console.log(JSON.stringify({ stage: value, modelId: modelId || null })); };
  const api = async (pathname, { binary = false } = {}) => {
    if (!pathname.startsWith('/api/') || pathname.startsWith('//')) fail('API_PATH_REJECTED');
    const response = await fetch(origin + pathname, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(binary ? 60000 : 30000) });
    if (!binary) return { status: response.status, body: await response.json() };
    const reader = response.body?.getReader(); if (!reader) fail('ASSET_BODY_MISSING');
    const chunks = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 30 * 1024 * 1024) { await reader.cancel(); fail('ASSET_TOO_LARGE'); } chunks.push(Buffer.from(part.value)); } }
    finally { reader.releaseLock(); }
    return { status: response.status, bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type')?.split(';')[0] || '' };
  };
  let browser, context, page, original, dto, checkpointFile, actorId, saveQueue = Promise.resolve();
  const permit = { generateAllowed: false, generateConsumed: false, uploadAllowed: false, uploadConsumed: false, publishAllowed: publishRequested, publishConsumed: false, fullProof: false };
  const savePrivate = value => {
    if (original?.body && value.body && JSON.stringify(original.body) !== JSON.stringify(value.body)) fail('ORIGINAL_CHECKPOINT_BODY_CHANGED');
    saveQueue = saveQueue.then(async () => { const tmp = checkpointFile + '.next'; await fs.writeFile(tmp, JSON.stringify(value)); await fs.rename(tmp, checkpointFile); });
    return saveQueue;
  };
  try {
    const actor = await api('/api/auth/me'); if (actor.status !== 200 || actor.body.user?.role !== 'admin' || !actor.body.user.id) fail('CURRENT_ADMINISTRATOR_REQUIRED');
    const user = actor.body.user; actorId = String(user.id);
    if (modelId) {
      const privateDirectory = path.join(LOCAL_PREVIEW_DATA_ROOT, 'e2e-private', 'image-governance', modelId); await fs.mkdir(privateDirectory, { recursive: true });
      const execute = promisify(execFile), sid = (await execute('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })).stdout.match(/S-1-[0-9-]+/)?.[0];
      if (!sid) fail('WINDOWS_IDENTITY_REQUIRED');
      await execute('icacls.exe', [privateDirectory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
      checkpointFile = path.join(privateDirectory, 'original-attempt.json');
      try { original = JSON.parse(await fs.readFile(checkpointFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') fail('ORIGINAL_CHECKPOINT_UNREADABLE'); }
      if (mode === 'submit-once' && original) fail('ORIGINAL_ATTEMPT_EXISTS_USE_RESUME');
      if (mode === 'resume' && !original) fail('ORIGINAL_ATTEMPT_REQUIRED');
      if (original && (original.userId !== actorId || original.model.id !== modelId || JSON.stringify(original).includes(token))) fail('ORIGINAL_ATTEMPT_ACCOUNT_MISMATCH');
      report.privateCheckpoint = path.relative(LOCAL_PREVIEW_DATA_ROOT, checkpointFile).replaceAll('\\', '/');
    }
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });
    await context.addInitScript(({ origin, token, user, original }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
      if (original) localStorage.setItem(`admin-image-validation:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(original.model.id)}`, JSON.stringify(original));
    }, { origin, token, user, original: original || null });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      // Diagnostic telemetry is suppressed locally; every business mutation still requires its original permit.
      if (url.origin === origin && url.pathname === '/api/diagnostic-logs' && request.method() === 'POST') return route.fulfill({ status: 204, body: '' });
      if (['GET', 'HEAD'].includes(request.method())) {
        if (url.origin === origin && /\/api\/video\/(?:status|cancel)/.test(url.pathname)) { report.blocked.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        return route.continue();
      }
      try {
        if (url.origin !== origin) fail('CROSS_ORIGIN_MUTATION');
        if (url.pathname === '/api/image/generate' && request.method() === 'POST') {
          const body = request.postDataJSON();
          consumeMutationPermit(permit, 'generate', body, dto, modelId, mode === 'resume' ? original.body : null);
          if (JSON.stringify(body).includes(token)) fail('TOKEN_IN_BODY_FORBIDDEN');
          const attempt = await page.evaluate(({ userId, modelId }) => JSON.parse(localStorage.getItem(`admin-image-validation:v1:${encodeURIComponent(userId)}:${encodeURIComponent(modelId)}`) || 'null'), { userId: actorId, modelId });
          if (!attempt || JSON.stringify(attempt.body) !== JSON.stringify(body)) fail('UI_DURABLE_ORIGINAL_BODY_REQUIRED');
          if (mode === 'submit-once') {
            const marker = await fs.open(path.join(path.dirname(checkpointFile), 'dispatch-once.json'), 'wx');
            await marker.writeFile(JSON.stringify({ at: new Date().toISOString(), modelId, clientKey: body.clientIdempotencyKey, configurationHash: dto.configurationHash, bodySha256: sha(JSON.stringify(body)) })); await marker.close();
          } else {
            const marker = await fs.open(path.join(path.dirname(checkpointFile), `recovery-${Date.now()}.json`), 'wx');
            await marker.writeFile(JSON.stringify({ at: new Date().toISOString(), clientKey: body.clientIdempotencyKey, originalBodySha256: sha(JSON.stringify(body)) })); await marker.close();
          }
          original = attempt; await savePrivate(attempt);
          report.original = { clientKey: body.clientIdempotencyKey, traceId: body.clientTraceId, configurationHash: dto.configurationHash,
            epoch: dto.epoch, bodySha256: sha(JSON.stringify(body)), referenceCount: body.referenceImageUrls.length, resolution: body.resolution, aspectRatio: body.aspectRatio };
          report.generationPosts++; await persistReport(); return route.continue();
        }
        if (url.pathname === '/api/upload' && request.method() === 'POST') { consumeMutationPermit(permit, 'upload'); report.uploadPosts++; return route.continue(); }
        if (url.pathname === '/api/admin/cover-models/validation/publish' && request.method() === 'POST') { consumeMutationPermit(permit, 'publish', request.postDataJSON(), dto, modelId); report.publishPosts++; return route.continue(); }
        fail('UNAUTHORIZED_MUTATION');
      } catch (error) {
        report.blocked.push({ method: request.method(), path: url.pathname, code: safeCode(error.message) }); await persistReport(); return route.abort();
      }
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.pageErrors.push({ name: error.name, message: safeCode(error.message) }));
    page.on('requestfailed', request => report.requestFailures.push({ path: new URL(request.url()).pathname, failure: safeCode(request.failure()?.errorText) }));
    page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    async function openDialog(id, reload = false) {
      if (reload) await page.reload({ waitUntil: 'load' }); else if (!page.url().startsWith(origin + '/admin')) await page.goto(origin + '/admin?tab=models', { waitUntil: 'load' });
      await page.getByRole('button', { name: /绘图模型/ }).filter({ hasNotText: '添加' }).first().click();
      const card = page.locator(`[data-model-id="${id}"]`); await card.getByRole('button', { name: '真实生成验证', exact: true }).click();
      const dialog = page.getByTestId('admin-image-validation-dialog'); await dialog.waitFor();
      await page.waitForFunction(() => { const dialog = document.querySelector('[data-testid="admin-image-validation-dialog"]'); return Boolean(dialog?.querySelector('[data-testid="image-validation-form"],[data-testid="image-validation-attempt"],[role="alert"]')); }, null, { timeout: 35000 });
      return dialog;
    }
    const readAttempt = async () => page.evaluate(({ userId, modelId }) => JSON.parse(localStorage.getItem(`admin-image-validation:v1:${encodeURIComponent(userId)}:${encodeURIComponent(modelId)}`) || 'null'), { userId: actorId, modelId });
    if (mode === 'inspect') {
      await stage('inspect-existing-five');
      for (const id of modelId ? [modelId] : CANDIDATES) {
        const result = await api('/api/admin/cover-models/validation?' + new URLSearchParams({ modelId: id }));
        const current = result.body, dialog = await openDialog(id);
        const inputCount = await dialog.locator('textarea').count(), submit = dialog.getByRole('button', { name: '提交一次真实验证', exact: true });
        report.inspection.push({ modelId: id, http: result.status, code: current.code || null, dialogVisible: await dialog.isVisible(),
          credentialReady: current.credentialReady === true, priceReady: current.priceReady === true, active: current.active === true, hidden: current.hidden === true,
          busy: current.busy === true, acceptance: current.acceptance, requiresComputeReadiness: current.requiresComputeReadiness === true,
          resolutionOptions: current.capabilities?.resolutionOptions, supportsReferenceInput: current.capabilities?.supportsReferenceInput === true,
          inputCount, submitVisible: await submit.count() > 0, submitDisabledBeforeConfirmation: await submit.count() ? !await submit.isEnabled() : null,
          existingRequestState: current.existingAttempt?.requestState || null, generationDispatched: false });
        await dialog.getByRole('button', { name: '关闭生图验证', exact: true }).click(); await persistReport();
      }
      report.passed = report.inspection.every(item => item.http === 200 && item.dialogVisible) && report.generationPosts === 0 && !report.pageErrors.length
        && !report.blocked.some(item => !['GET', 'HEAD'].includes(item.method)) && !report.httpErrors.some(item => item.path.startsWith('/api/'));
      return;
    }
    await stage('read-original-configuration');
    const preflight = await api('/api/admin/cover-models/validation?' + new URLSearchParams({ modelId }));
    if (preflight.status !== 200 || preflight.body.modelId !== modelId) fail('MODEL_PREFLIGHT_UNAVAILABLE'); dto = preflight.body;
    if (mode === 'submit-once' && (dto.requiresComputeReadiness || !dto.credentialReady || !dto.priceReady || dto.busy)) fail('MODEL_NOT_READY_FOR_CONTROLLED_VALIDATION');
    if (mode === 'submit-once' && dto.existingAttempt) fail('SERVER_ORIGINAL_ATTEMPT_EXISTS_USE_RECONCILIATION');
    let dialog = await openDialog(modelId);
    if (mode === 'submit-once') {
      await dialog.getByLabel('验证图片描述', { exact: true }).fill(modelId === CANDIDATES[0]
        ? '将参考图片中的黄色圆形改成蓝色圆形，保持简洁构图，不添加文字。'
        : '一只黄色陶瓷杯放在浅灰色桌面上，纯白背景，柔和自然光，简洁静物摄影，没有文字、商标或人物。');
      const resolution = dto.capabilities.resolutionOptions.includes('1K') ? '1K' : dto.capabilities.resolutionOptions[0];
      await dialog.getByLabel(/^清晰度/).selectOption(resolution); await dialog.getByLabel(/^画面比例/).selectOption('1:1');
      if (modelId === CANDIDATES[0]) {
        await dialog.getByLabel('使用参考图验证', { exact: true }).check();
        const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f2f4f8'; ctx.fillRect(0, 0, 256, 256); ctx.fillStyle = '#f3c632'; ctx.beginPath(); ctx.arc(128, 128, 65, 0, Math.PI * 2); ctx.fill(); return canvas.toDataURL('image/png').split(',')[1]; });
        permit.uploadAllowed = true;
        const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/upload' && response.request().method() === 'POST', { timeout: 65000 }); waiting.catch(() => {});
        const [uploaded] = await Promise.all([waiting, dialog.locator('#image-validation-upload-0').setInputFiles({ name: 'own-simple-circle.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') })]);
        if (uploaded.status() !== 200) fail('REFERENCE_UPLOAD_NOT_CONFIRMED');
        await dialog.getByRole('status').filter({ hasText: '正在上传参考图' }).waitFor({ state: 'hidden' });
      }
      await dialog.getByRole('checkbox', { name: /确认使用当前模型生成一张验证图片/ }).check();
      permit.generateAllowed = true; await stage('single-ui-submit');
      await dialog.getByRole('button', { name: '提交一次真实验证', exact: true }).click();
    } else if (recoveryRequested) {
      if (!original.body || original.proof.validationKey !== dto.validationKey || original.proof.configurationHash !== dto.configurationHash || original.proof.epoch !== dto.epoch) fail('ORIGINAL_RECOVERY_CONFIG_CHANGED');
      const status = await api('/api/image/status?' + new URLSearchParams({ clientIdempotencyKey: original.proof.validationKey, clientTraceId: original.proof.clientTraceId }));
      if (status.status !== 200 || status.body.state !== 'provider_completed_pending_delivery' || status.body.canRecover !== true) fail('ORIGINAL_PROVIDER_RESULT_NOT_CONFIRMED');
      permit.generateAllowed = true; await stage('manual-original-persistence');
      await dialog.getByRole('button', { name: '恢复原结果保存', exact: true }).click();
    } else { await stage('resume-get-only'); await dialog.getByRole('button', { name: '检查原任务', exact: true }).click(); }
    const deadline = Date.now() + 240000;
    let attempt;
    while (Date.now() < deadline) {
      attempt = await readAttempt();
      if (attempt) { if (original && (attempt.proof.validationKey !== original.proof.validationKey || attempt.model.id !== modelId)) fail('UI_REPLACED_ORIGINAL_ATTEMPT'); await savePrivate(attempt); }
      if (attempt && ['completed', 'published', 'rejected', 'unknown', 'finalizing'].includes(attempt.status)) break;
      await page.waitForTimeout(2500);
    }
    if (!attempt) fail('UI_ORIGINAL_ATTEMPT_MISSING');
    report.outcome = { state: attempt.status, code: attempt.errorCode || null, imageRecordId: attempt.imageRecordId || null, assetId: attempt.assetId || null,
      clientKey: attempt.proof.validationKey, configurationHash: attempt.proof.configurationHash, epoch: attempt.proof.epoch, canRecover: attempt.canRecover === true };
    if (!['completed', 'published'].includes(attempt.status)) { report.requiresReconciliation = true; await stage('original-retained-no-auto-retry'); return; }
    await stage('owned-asset-and-billing-readback');
    // The dialog may receive the image before its immediate metadata GET finishes.
    if (!attempt.imageRecordId) { await dialog.getByRole('button', { name: '检查原任务', exact: true }).click(); await page.waitForFunction(({ userId, modelId }) => Boolean(JSON.parse(localStorage.getItem(`admin-image-validation:v1:${encodeURIComponent(userId)}:${encodeURIComponent(modelId)}`) || 'null')?.imageRecordId), { userId: actorId, modelId }); attempt = await readAttempt(); }
    const client = new pg.Client(runtime.ownerConnection);
    try {
      await client.connect(); await client.query('BEGIN READ ONLY'); await client.query("SET LOCAL statement_timeout = '10s'");
      const record = (await client.query(`SELECT v.state AS validation_state,v.quoted_price_yuan,v.cost_price_yuan,v.configuration_hash,
        r.record_id,r.user_id,r.client_idempotency_key,r.client_trace_id,r.state,r.delivery_state,r.delivery_asset_id,
        r.response->>'selectedModelId' AS selected_model,r.response->>'selectedCostPrice' AS actual_cost,
        r.response->>'fileSize' AS result_size,r.response->>'contentType' AS result_type,
        r.response->>'width' AS width,r.response->>'height' AS height,
        f.id AS asset_id,f.user_id AS asset_user,f.storage_provider,f.file_size,f.content_type,f.meta
        FROM public.image_model_validations v JOIN public.image_generation_requests r ON r.record_id=v.image_record_id
        LEFT JOIN public.user_files f ON f.id=r.delivery_asset_id::uuid WHERE r.record_id=$1 AND r.user_id=$2`, [attempt.imageRecordId, actorId])).rows[0];
      if (!record || record.selected_model !== modelId || record.state !== 'completed' || record.delivery_state !== 'delivered' || record.asset_id !== attempt.assetId || String(record.asset_user) !== actorId || record.configuration_hash !== attempt.proof.configurationHash) fail('OWNED_PERSISTED_RESULT_MISMATCH');
      const billingKey = `image:h3_${sha(`${actorId}:${attempt.proof.validationKey}`).slice(0, 48)}`;
      if (record.meta?.billingReferenceId !== billingKey || record.meta?.billingExempt !== 'true' || record.meta?.billingExemptionReason !== 'admin' || record.meta?.billingOperationId !== ''
        || Number(record.meta?.quotedPriceYuan) !== Number(record.quoted_price_yuan) || Number(record.meta?.actualCostPriceYuan) !== Number(record.cost_price_yuan)
        || Number(record.actual_cost) !== Number(record.cost_price_yuan)) fail('ADMIN_ZERO_CHARGE_OR_COST_EVIDENCE_MISMATCH');
      const ledger = (await client.query('SELECT (SELECT count(*) FROM public.wallet_operations WHERE user_id::text=$1 AND idempotency_key=$2) AS operations,(SELECT count(*) FROM public.wallet_ledger_entries WHERE user_id::text=$1 AND idempotency_key=$2) AS entries', [actorId, billingKey])).rows[0];
      if (Number(ledger.operations) || Number(ledger.entries)) fail('UNEXPECTED_ADMIN_CHARGE');
      const file = await api(`/api/storage/files/${encodeURIComponent(attempt.assetId)}/content?download=1`, { binary: true });
      if (file.status !== 200 || file.bytes.length !== Number(record.file_size) || file.bytes.length !== Number(record.result_size) || file.contentType !== record.content_type || file.contentType !== record.result_type) fail('ASSET_BYTES_MISMATCH');
      const decoder = sharp(file.bytes, { failOn: 'error', limitInputPixels: 40000000 }), metadata = await decoder.metadata(); await decoder.raw().toBuffer();
      if (metadata.width !== Number(record.width) || metadata.height !== Number(record.height)) fail('DECODED_DIMENSIONS_MISMATCH');
      report.fullProof = { imageRecordId: attempt.imageRecordId, assetId: attempt.assetId, selectedModel: record.selected_model, owned: true,
        state: record.state, deliveryState: record.delivery_state, storageProvider: record.storage_provider, contentType: file.contentType,
        bytes: file.bytes.length, sha256: sha(file.bytes), width: metadata.width, height: metadata.height, fullDecoded: true,
        quotedPriceYuan: Number(record.quoted_price_yuan), configuredCostYuan: Number(record.cost_price_yuan), recordedSupplierCostYuan: Number(record.actual_cost),
        adminExempt: true, walletOperations: Number(ledger.operations), walletEntries: Number(ledger.entries) };
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
    const image = dialog.getByRole('img', { name: /的原验证图片$/ }); await image.waitFor();
    await image.evaluate(async element => { await element.decode(); if (!element.naturalWidth || !element.naturalHeight) throw new Error('UI_IMAGE_DECODE_FAILED'); });
    const downloaded = page.waitForEvent('download', { timeout: 30000 }); downloaded.catch(() => {});
    const [download] = await Promise.all([downloaded, dialog.getByRole('button', { name: '下载验证图片', exact: true }).click()]);
    const suffix = report.fullProof.contentType === 'image/jpeg' ? 'jpg' : report.fullProof.contentType === 'image/webp' ? 'webp' : 'png';
    const mediaFile = `${out}/${modelId}-${attempt.assetId}.${suffix}`; await download.saveAs(mediaFile);
    if (sha(await fs.readFile(mediaFile)) !== report.fullProof.sha256) fail('UI_DOWNLOAD_DIFFERS_FROM_OWNED_ASSET');
    report.uiDownloadedOriginal = true; report.mediaFile = mediaFile;
    await stage('refresh-original-result'); dialog = await openDialog(modelId, true);
    await dialog.getByRole('img', { name: /的原验证图片$/ }).waitFor();
    const refreshed = await readAttempt(); if (refreshed?.assetId !== attempt.assetId || refreshed?.proof.validationKey !== attempt.proof.validationKey) fail('REFRESH_ORIGINAL_IDENTITY_LOST');
    report.refreshedSameOriginal = true; await savePrivate(refreshed);
    await dialog.screenshot({ path: `${out}/${modelId}-${attempt.assetId}-dialog.png` });
    if (publishRequested && refreshed.status !== 'published') {
      permit.fullProof = true; permit.imageRecordId = attempt.imageRecordId; await stage('publish-completed-original');
      const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/cover-models/validation/publish' && response.request().method() === 'POST', { timeout: 70000 }); waiting.catch(() => {});
      const [response] = await Promise.all([waiting, dialog.getByRole('button', { name: '启用此配置', exact: true }).click()]);
      const result = await response.json(); report.publication = { status: response.status(), success: result.success === true, code: result.code || null, imageRecordId: result.imageRecordId, assetId: result.assetId };
      if (response.status() !== 200 || result.success !== true || result.imageRecordId !== attempt.imageRecordId || result.assetId !== attempt.assetId) fail('PUBLICATION_NOT_CONFIRMED');
      await page.waitForFunction(({ userId, modelId }) => JSON.parse(localStorage.getItem(`admin-image-validation:v1:${encodeURIComponent(userId)}:${encodeURIComponent(modelId)}`) || 'null')?.status === 'published', { userId: actorId, modelId });
      await savePrivate(await readAttempt());
    }
    const catalog = await api('/api/cover-models?surface=image-workbench');
    report.publicCatalog = { status: catalog.status, selectedVisible: Array.isArray(catalog.body.models) && catalog.body.models.some(item => item.id === dto.publicModelId) };
    if (publishRequested && !report.publicCatalog.selectedVisible) fail('PUBLISHED_MODEL_NOT_IN_PUBLIC_CATALOG');
    report.passed = !report.pageErrors.length && !report.blocked.some(item => item.method === 'POST');
  } catch (error) { report.failure = safeCode(error.message); }
  finally {
    if (page && modelId && checkpointFile) {
      try { const last = await page.evaluate(({ userId, modelId }) => JSON.parse(localStorage.getItem(`admin-image-validation:v1:${encodeURIComponent(userId)}:${encodeURIComponent(modelId)}`) || 'null'), { userId: actorId, modelId }); if (last && (!original || last.proof.validationKey === original.proof.validationKey)) await savePrivate(last); } catch { /* Original disk checkpoint remains intact. */ }
    }
    await saveQueue.catch(() => {}); if (browser) await browser.close(); await persistReport();
    console.log(JSON.stringify({ report: reportFile, passed: report.passed, stage: report.stage, failure: report.failure || null, generationPosts: report.generationPosts, publishPosts: report.publishPosts, outcome: report.outcome?.state || null }));
  }
}

if (process.argv.includes('--self-test')) await selfTest(); else await run();
