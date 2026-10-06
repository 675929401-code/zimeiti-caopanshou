import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const mode = args.includes('--submit-once') ? 'submit-once' : args.includes('--reconcile') ? 'reconcile' : args.includes('--inspect') ? 'inspect' : 'plan';
const arg = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const selectedModel = arg('model') || 'catalog';
const knownVivi = { clientRequestId: 'voice-single-47142ced-7afe-40b9-a1d7-a8446a2d216b', generationId: '224991ae-bfa3-4ba3-857f-9f93a9c787c9', assetId: '2c8be5f7-cfb0-4ec8-8608-176e45ac88fa', bytes: 34221, storageHost: 'ai-agent-main-storage-1434868362.cos.ap-guangzhou.myqcloud.com', model: 'seed-tts-2.0-expressive' };
const products = [
  { model: 'seed-tts-2.0-standard', product: 'seed-tts-2.0', phase: 'tts', scope: 'single', ui: '单人模式', requirement: 'Select an actual official voice, explicitly select the standard model, one short text.' },
  { model: 'seed-tts-2.0-expressive', product: 'seed-tts-2.0', phase: 'tts', scope: 'single', ui: '单人模式', requirement: 'Already genuinely completed with Vivi 2.0. Read original lifecycle/history only; never regenerate.' },
  { model: 'seed-tts-1.0', product: 'seed-tts-1.0', phase: 'mix', scope: 'mix', ui: '混音合成', requirement: 'Use the two officially documented MIX 1.0 voices at 0.7/0.3. The authorized real canary verifies tenant permission; never substitute 2.0 voices.' },
  { model: 'seed-audio-1.0', product: 'seed-audio-1.0', phase: 'seed-audio', scope: 'seed-audio', ui: '音频生成', requirement: 'Use the administrator-owned existing Vivi audio, read via history API in memory; no upload or link extraction.' },
  { model: 'seed-icl-2.0', product: 'seed-icl-2.0', ui: '/voice-studio/clone', requirement: 'Separate training product; needs owned reference and training permission. Not a TTS model selection.' },
  { model: 'seed-icl-2.0-design', product: 'seed-icl-2.0-design', ui: '/voice-studio/design', requirement: 'Separate voice design product; inspect its page only until a specific design is scheduled.' },
];
if (mode === 'plan') {
  console.log(JSON.stringify({ mode, networkRequests: 0, products, executable: 'node scripts/verify-voice-models-ui.mjs --inspect --run-id=<unique> [--model=<model>]',
    submit: '--submit-once --run-id=<inspected> --model=seed-tts-2.0-standard|seed-audio-1.0|seed-tts-1.0',
    safeguards: 'Normal token environment only; one model, one persisted dispatch; unknown is read-only reconciliation, never a new key; no previews/training or other writes.' }, null, 2)); process.exit(0);
}
const plan = products.find(item => item.model === selectedModel);
assert.ok(selectedModel === 'catalog' || plan, 'KNOWN_VOICE_MODEL_REQUIRED');
assert.ok(mode !== 'submit-once' || ['seed-tts-2.0-standard', 'seed-audio-1.0', 'seed-tts-1.0'].includes(selectedModel), 'EXPLICIT_UNTESTED_SYNTHESIS_MODEL_REQUIRED');
const runId = arg('run-id'), evidenceId = arg('evidence-id');
assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId), 'UNIQUE_RUN_ID_REQUIRED');
assert.ok(!evidenceId || /^[A-Za-z0-9_-]{1,40}$/u.test(evidenceId));
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin));
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'NORMAL_ADMIN_SESSION_REQUIRED');
const secondaryToken = process.env.LOCAL_NAV_SECOND_TOKEN?.trim() || '';
if (secondaryToken) assert.notEqual(secondaryToken, token, 'DISTINCT_ACCOUNT_SESSIONS_REQUIRED');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.supabaseUrl.replace(/\/$/u, ''), 'http://127.0.0.1:54321');
const out = path.resolve('.codex-evidence/voice-models-real-e2e-20260903', runId); await fs.mkdir(out, { recursive: true });
const reportStem = `${mode}${evidenceId ? `-${evidenceId}` : ''}`, reportPath = path.join(out, `${reportStem}.json`), markerPath = path.join(out, 'voice.dispatch.json');
const report = { runId, mode, model: selectedModel, origin, at: new Date().toISOString(), passed: false, ttsPosts: 0, unrelatedWrites: [], pageErrors: [], products };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clean = value => String(value || '').split(token).join('[redacted]').split(runtime.serviceRoleKey).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').slice(0, 500);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value;
const api = async (pathname, sessionToken = token) => { const response = await fetch(origin + pathname, { headers: { Authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(30000) }); return { status: response.status, body: await response.json() }; };
const rows = async (table, select, filters) => { const url = new URL(`${runtime.supabaseUrl}/rest/v1/${table}`); url.searchParams.set('select', select); for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` }, signal: AbortSignal.timeout(20000) }); const body = await response.json(); assert.ok(response.ok && Array.isArray(body), `LOCAL_READ_${table}_FAILED`); return body; };
const findHistory = async (generationId, sessionToken = token) => { for (let number = 1; number <= 20; number++) { const response = await api(`/api/voice/history?page=${number}&pageSize=100`, sessionToken); assert.equal(response.status, 200); const item = response.body.data?.items?.find(row => row.id === generationId); if (item) return item; if (number * 100 >= response.body.data?.total) break; } return null; };
let browser, page, marker, fatal, responseBody, reference, user;
const wait = async (test, label, timeout = 45000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (fatal) throw fatal; if (await test()) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw Error(`WAIT_FAILED_${label}`); };
const synthText = '语音验收。';
try {
  const me = await api('/api/auth/me'); assert.ok(me.status === 200 && me.body.user?.role === 'admin'); user = me.body.user;
  const balance = async () => (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0]; report.balanceBefore = await balance();
  const pricing = await api('/api/voice/pricing'); assert.equal(pricing.status, 200); report.pricing = pricing.body.data.map(item => ({ modelId: item.modelId, name: item.name, unit: item.unit, sellPrice: item.sellPrice }));
  assert.equal(report.pricing.length, 5, 'FIVE_BILLING_PRODUCTS_EXPECTED');
  const original = await api(`/api/voice/generation-status?clientRequestId=${knownVivi.clientRequestId}&phase=tts`);
  report.originalVivi = { status: original.status, state: original.body.data?.state, generationId: original.body.data?.generationId, chargedCredits: original.body.data?.chargedCredits, reusedOnly: true };
  assert.ok(original.status === 200 && original.body.data?.state === 'completed' && original.body.data?.generationId === knownVivi.generationId);
  reference = await findHistory(knownVivi.generationId); assert.ok(reference?.outputAudioUrl, 'OWNED_ORIGINAL_VIVI_HISTORY_AUDIO_REQUIRED');
  report.reference = { generationId: knownVivi.generationId, historyStatus: reference.status, urlPresent: true };
  if (selectedModel === 'seed-audio-1.0' && mode !== 'reconcile') {
    assert.equal(original.body.data?.assetId, knownVivi.assetId, 'ORIGINAL_VIVI_ASSET_REQUIRED');
    const [asset] = await rows('user_files', 'id,file_size,content_type,storage_key,storage_provider', { id: `eq.${knownVivi.assetId}`, user_id: `eq.${user.id}`, limit: '1' });
    assert.ok(asset && asset.storage_key && asset.storage_provider === 'tencent_cos', 'ORIGINAL_OWNED_COS_ASSET_REQUIRED');
    assert.equal(Number(asset.file_size), knownVivi.bytes); assert.equal(asset.content_type, 'audio/mpeg');
    const mediaUrl = new URL(reference.outputAudioUrl);
    assert.ok(mediaUrl.protocol === 'https:' && mediaUrl.host === knownVivi.storageHost && !mediaUrl.username && !mediaUrl.password && !mediaUrl.hash, 'ORIGINAL_STORAGE_HOST_REQUIRED');
    // Read the signed GET as issued by the normal owned-history API; never HEAD a GET signature,
    // attach application credentials, follow a redirect, change ACLs, upload, or copy the asset.
    const media = await fetch(mediaUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert.equal(media.status, 200, 'ORIGINAL_VIVI_REFERENCE_GET_REQUIRED');
    const contentType = (media.headers.get('content-type') || '').split(';')[0].trim(); assert.equal(contentType, 'audio/mpeg');
    const contentLength = Number(media.headers.get('content-length')); assert.equal(contentLength, knownVivi.bytes, 'ORIGINAL_REFERENCE_LENGTH_REQUIRED');
    const reader = media.body?.getReader(); assert.ok(reader); const chunks = []; let total = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; assert.ok(total <= knownVivi.bytes, 'ORIGINAL_REFERENCE_SIZE_LIMIT'); chunks.push(Buffer.from(next.value)); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    assert.equal(total, knownVivi.bytes, 'ORIGINAL_REFERENCE_MUST_BE_COMPLETE');
    report.reference = { ...report.reference, assetId: asset.id, owned: true, storageProvider: asset.storage_provider, getStatus: media.status, contentType, bytes: total, sha256: sha(Buffer.concat(chunks)), signedQueryPresent: Boolean(mediaUrl.search), uploadedOrCopied: false, bucketAclChanged: false };
  }
  if (mode === 'reconcile') { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); assert.equal(marker.runId, runId); assert.ok(products.some(item => item.model === marker.model)); }
  if (mode === 'submit-once') {
    const inspected = JSON.parse(await fs.readFile(path.join(out, 'inspect.json'), 'utf8')); assert.ok(inspected.passed && inspected.model === selectedModel && inspected.submitReady, 'SAME_MODEL_SUCCESSFUL_INSPECTION_REQUIRED');
    try { await fs.access(markerPath); throw Error('ORIGINAL_DISPATCH_EXISTS_RECONCILE_ONLY'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1520, height: 1080 }, acceptDownloads: true, serviceWorkers: 'block' });
  await context.addInitScript(({ origin, token, user }) => { if (location.origin === origin) { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); } }, { origin, token, user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
    if (url.origin === origin && url.pathname === '/api/diagnostic-logs' && request.method() === 'POST') { report.suppressedDiagnosticPosts = (report.suppressedDiagnosticPosts || 0) + 1; return route.fulfill({ status: 204, body: '' }); }
    try {
      assert.ok(mode === 'submit-once' && url.origin === origin && url.pathname === '/api/voice/tts' && request.method() === 'POST', 'ONLY_ONE_EXPLICIT_VOICE_SUBMISSION_ALLOWED');
      assert.equal(report.ttsPosts, 0, 'ONE_VOICE_POST_ONLY'); assert.equal(request.headers().authorization, `Bearer ${token}`); const body = request.postDataJSON();
      assert.equal(body.model, selectedModel, 'VISIBLE_AND_SUBMITTED_MODEL_MUST_MATCH');
      const key = request.headers()['idempotency-key']; assert.ok(key && key === body.client_request_id);
      assert.equal((await rows('voice_generation_requests', 'request_id', { user_id: `eq.${user.id}`, client_request_id: `eq.${key}`, phase: `eq.${plan.phase}` })).length, 0, 'NEW_CLIENT_KEY_REQUIRED');
      if (selectedModel === 'seed-audio-1.0') { assert.equal(body.textPrompt, '@音频1 ' + synthText); assert.deepEqual(body.references, [{ audioUrl: reference.outputAudioUrl }]); assert.equal(body.text, undefined); }
      else { assert.equal(body.text, synthText); if (selectedModel === 'seed-tts-1.0') { assert.deepEqual(body.mixSpeakers, [{ speaker: 'zh_female_shuangkuaisisi_moon_bigtts', factor: 0.7 }, { speaker: 'zh_male_wennuanahu_moon_bigtts', factor: 0.3 }]); }
        else assert.equal(body.speaker, arg('speaker') || 'zh_female_vv_uranus_bigtts'); }
      marker = { runId, model: selectedModel, phase: plan.phase, clientRequestId: key, state: 'dispatch-intent', at: new Date().toISOString(), payloadSha256: sha(canonical(body)), selectedSpeakerIds: body.mixSpeakers?.map(item => item.speaker) || (body.speaker ? [body.speaker] : []), referenceGenerationId: selectedModel === 'seed-audio-1.0' ? knownVivi.generationId : null };
      const indexDirectory = path.resolve('.codex-evidence/voice-models-real-e2e-20260903/dispatch-index'); await fs.mkdir(indexDirectory, { recursive: true });
      await fs.writeFile(path.join(indexDirectory, `${selectedModel}-${runId}.json`), JSON.stringify(marker, null, 2), { flag: 'wx' }); await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), { flag: 'wx' });
      report.ttsPosts++; await save();
      try { const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 360000 }); responseBody = await response.json();
        marker.state = 'responded'; marker.httpStatus = response.status(); marker.generationId = responseBody.data?.generationId || null;
        report.api = { status: response.status(), success: responseBody.success === true, providerModelId: responseBody.data?.providerModelId, billingModelId: responseBody.data?.billingModelId, generationId: marker.generationId, code: responseBody.code, message: clean(responseBody.message) };
        await fs.writeFile(markerPath, JSON.stringify(marker, null, 2)); await save(); return route.fulfill({ response });
      } catch (error) { marker.state = 'unknown'; marker.error = clean(error.message); await fs.writeFile(markerPath, JSON.stringify(marker, null, 2)); throw Error('VOICE_OUTCOME_UNKNOWN_RECONCILE_ORIGINAL_KEY_ONLY'); }
    } catch (error) { report.unrelatedWrites.push({ path: url.origin === origin ? url.pathname : '[external]', reason: clean(error.message) }); fatal = Error(clean(error.message)); await save(); await route.abort(); }
  });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
  await page.goto(origin + '/voice-studio/workspace', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByLabel('模型版本', { exact: true }).waitFor({ timeout: 45000 });
  if (mode !== 'reconcile') {
    report.modelOptions = await page.getByLabel('模型版本', { exact: true }).locator('option').evaluateAll(items => items.map(item => ({ value: item.value, label: item.textContent })));
    if (selectedModel === 'seed-audio-1.0') {
      await page.getByRole('button', { name: 'seed-audio 1.0', exact: true }).click();
      await page.getByPlaceholder('粘贴抖音/小红书链接或输入音频URL...').fill(reference.outputAudioUrl);
      await page.getByRole('button', { name: '添加', exact: true }).click();
      await page.locator('textarea').fill('@音频1 ' + synthText); report.submitReady = true;
      assert.equal(await page.getByLabel('模型版本', { exact: true }).inputValue(), selectedModel);
    } else if (selectedModel === 'seed-tts-1.0' || selectedModel === 'catalog') {
      await page.getByRole('button', { name: /混音合成/u }).click();
      const selects = page.locator('select[aria-label^="混音音色 "]'); await wait(async () => await selects.count() >= 2, 'mix-slots');
      const options = await selects.first().locator('option').evaluateAll(items => items.filter(item => item.value).map(item => ({ value: item.value, label: item.textContent })));
      const requestedSpeakers = (arg('mix-speakers') || 'zh_female_shuangkuaisisi_moon_bigtts,zh_male_wennuanahu_moon_bigtts').split(',').filter(Boolean);
      report.mix = { slots: await selects.count(), selectableCount: options.length, legacyCandidates: options.filter(item => /_(mars|moon)_/u.test(item.value)), voicesChosen: requestedSpeakers };
      report.submitReady = selectedModel === 'seed-tts-1.0' && requestedSpeakers.length === 2 && requestedSpeakers.every(id => options.some(item => item.value === id));
      if (report.submitReady) {
        assert.deepEqual(requestedSpeakers, ['zh_female_shuangkuaisisi_moon_bigtts', 'zh_male_wennuanahu_moon_bigtts']);
        for (let index = 0; index < 2; index++) { await selects.nth(index).selectOption(requestedSpeakers[index]); const range = page.getByLabel(`混音音色 ${index + 1} 比例`, { exact: true }); await range.press('Home'); for (let step = 0; step < (index === 0 ? 14 : 6); step++) await range.press('ArrowRight'); }
        await page.getByPlaceholder('输入要混音合成的文本内容...').fill(synthText);
      } else report.inputBlocker = 'The two officially MIX-supported 1.0 voice options are not yet present in this build; 2.0 voices are not substituted.';
    } else if (selectedModel === 'seed-tts-2.0-standard') {
      const speaker = arg('speaker') || 'zh_female_vv_uranus_bigtts';
      assert.equal(speaker, 'zh_female_vv_uranus_bigtts', 'INSPECT_NEW_SPEAKER_BEFORE_EXTENDING_RUNNER');
      await page.getByLabel('选择音色搜索', { exact: true }).fill('Vivi 2.0'); await page.getByText('Vivi 2.0', { exact: true }).click();
      await page.getByLabel('模型版本', { exact: true }).selectOption(selectedModel); await page.getByPlaceholder('输入要合成的文本内容...').fill(synthText); report.submitReady = true;
    } else { report.submitReady = false; report.inputBlocker = plan?.requirement || 'Catalog inspection does not authorize a model request.'; }
    await page.screenshot({ path: path.join(out, `${reportStem}-ready.png`), fullPage: true });
    if (mode === 'submit-once') {
      assert.ok(report.submitReady, 'MODEL_INPUTS_NOT_READY');
      const label = selectedModel === 'seed-audio-1.0' ? /生成音频/u : selectedModel === 'seed-tts-1.0' ? /开始混音合成/u : /开始合成/u;
      const submit = page.getByRole('button', { name: label }); assert.ok(await submit.isEnabled(), 'NORMAL_UI_SUBMIT_MUST_BE_ENABLED'); await submit.click();
      await wait(() => marker?.state === 'responded', 'voice-response', 380000);
    }
  }
  if (mode === 'inspect') { report.passed = true; assert.equal(report.ttsPosts, 0); }
  else {
    const lifecycle = await api(`/api/voice/generation-status?clientRequestId=${encodeURIComponent(marker.clientRequestId)}&phase=${marker.phase}`);
    const data = lifecycle.body.data; report.lifecycle = { status: lifecycle.status, requestId: data?.requestId, state: data?.state, modelId: data?.modelId, chargedCredits: data?.chargedCredits, quotedCredits: data?.quotedCredits, assetId: data?.assetId, generationId: data?.generationId, error: clean(data?.error) };
    assert.ok(lifecycle.status === 200 && data?.state === 'completed', 'ORIGINAL_VOICE_NOT_COMPLETED_NO_NEW_SUBMISSION'); assert.equal(data.chargedCredits, 0);
    assert.ok(data.assetId && data.generationId); const history = await findHistory(data.generationId); assert.ok(history?.outputAudioUrl && history.status === 'success', 'STABLE_OWNED_HISTORY_REQUIRED');
    const [durable] = await rows('voice_generation_requests', 'request_id,state,model_id,charge_credits,wallet_operation_id,asset_id,generation_id', { user_id: `eq.${user.id}`, client_request_id: `eq.${marker.clientRequestId}`, phase: `eq.${marker.phase}`, limit: '1' });
    assert.ok(durable?.state === 'completed' && durable.asset_id === data.assetId && durable.generation_id === data.generationId); assert.equal(Number(durable.charge_credits), 0);
    report.durable = { requestId: durable.request_id, state: durable.state, modelId: durable.model_id, chargedCredits: Number(durable.charge_credits), walletOperationId: durable.wallet_operation_id };
    const ledger = durable.wallet_operation_id ? await rows('wallet_ledger_entries', 'operation_id,delta', { user_id: `eq.${user.id}`, operation_id: `eq.${durable.wallet_operation_id}` }) : [];
    report.walletDeltas = ledger.map(row => Number(row.delta)); assert.ok(report.walletDeltas.every(value => value === 0));
    const asset = await rows('user_files', 'id,file_size,content_type,storage_key,storage_provider', { id: `eq.${data.assetId}`, user_id: `eq.${user.id}`, limit: '1' });
    assert.ok(asset.length === 1 && asset[0].storage_key && Number(asset[0].file_size) > 0); report.asset = { id: data.assetId, bytes: Number(asset[0].file_size), contentType: asset[0].content_type, storageProvider: asset[0].storage_provider, owned: true };
    const ownedContentPath = `/api/storage/files/${encodeURIComponent(data.assetId)}/content`;
    const ownedHead = await fetch(origin + ownedContentPath, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    report.asset.head = { status: ownedHead.status, contentType: ownedHead.headers.get('content-type'), contentLength: Number(ownedHead.headers.get('content-length')) };
    assert.equal(ownedHead.status, 200); assert.match(report.asset.head.contentType || '', /^audio\//u); assert.equal(report.asset.head.contentLength, report.asset.bytes);
    if (secondaryToken) {
      const secondaryLifecycle = await api(`/api/voice/generation-status?clientRequestId=${encodeURIComponent(marker.clientRequestId)}&phase=${marker.phase}`, secondaryToken);
      const secondaryHistory = await findHistory(data.generationId, secondaryToken);
      const secondaryHead = await fetch(origin + ownedContentPath, { method: 'HEAD', headers: { Authorization: `Bearer ${secondaryToken}` }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      report.accountIsolation = { mode: 'second-account-http', lifecycleStatus: secondaryLifecycle.status, historyVisible: Boolean(secondaryHistory), assetHeadStatus: secondaryHead.status };
      assert.equal(secondaryLifecycle.status, 404); assert.equal(secondaryHistory, null); assert.ok([403, 404].includes(secondaryHead.status));
    } else {
      const foreignUserId = '00000000-0000-4000-a000-000000000919';
      const foreignLifecycle = await rows('voice_generation_requests', 'request_id', { user_id: `eq.${foreignUserId}`, client_request_id: `eq.${marker.clientRequestId}`, phase: `eq.${marker.phase}` });
      const foreignAsset = await rows('user_files', 'id', { user_id: `eq.${foreignUserId}`, id: `eq.${data.assetId}` });
      const anonymousLifecycle = await fetch(origin + `/api/voice/generation-status?clientRequestId=${encodeURIComponent(marker.clientRequestId)}&phase=${marker.phase}`, { signal: AbortSignal.timeout(30000) });
      const anonymousHead = await fetch(origin + ownedContentPath, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30000) });
      report.accountIsolation = { mode: 'database-owner-scope-plus-anonymous-http', foreignLifecycleRows: foreignLifecycle.length, foreignAssetRows: foreignAsset.length, anonymousLifecycleStatus: anonymousLifecycle.status, anonymousAssetHeadStatus: anonymousHead.status };
      assert.deepEqual(foreignLifecycle, []); assert.deepEqual(foreignAsset, []);
      assert.equal(anonymousLifecycle.status, 401); assert.equal(anonymousHead.status, 401);
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); await page.getByRole('button', { name: '生成历史', exact: true }).click();
    const card = page.locator(`[data-generation-id="${data.generationId}"]`); for (let number = 1; number <= 40; number++) { await page.locator('#voice-generation-history-content[aria-busy="false"]').waitFor({ timeout: 25000 }); if (await card.count()) break; const next = page.getByRole('button', { name: '下一页', exact: true }); if (!await next.isEnabled()) break; await next.click(); }
    await card.waitFor({ timeout: 25000 }); report.historyRefresh = true;
    const audio = card.getByLabel('历史生成音频', { exact: true });
    report.playback = await audio.evaluate(async element => { element.load(); const end = Date.now() + 30000; while (Date.now() < end && !(element.readyState >= 2 && element.duration > 0)) { if (element.error) throw Error('AUDIO_DECODE_FAILED'); await new Promise(resolve => setTimeout(resolve, 100)); } await element.play(); await new Promise(resolve => setTimeout(resolve, 300)); const result = { duration: element.duration, played: element.currentTime > 0, readyState: element.readyState }; element.pause(); return result; });
    assert.ok(report.playback.played && report.playback.duration > 0);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 45000 }),
      card.getByRole('button', { name: '下载历史音频', exact: true }).click(),
    ]);
    const filename = path.join(out, `${reportStem}-audio.mp3`); await download.saveAs(filename); assert.equal(await download.failure(), null); const bytes = await fs.readFile(filename);
    assert.ok(bytes.length > 100); report.download = { bytes: bytes.length, sha256: sha(bytes) };
    const run = promisify(execFile), probe = path.resolve('node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe');
    const parsed = await run(probe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,duration', '-of', 'json', filename], { timeout: 30000, windowsHide: true });
    report.download.probe = JSON.parse(parsed.stdout); assert.ok(report.download.probe.streams.some(stream => stream.codec_type === 'audio')); assert.ok(Number(report.download.probe.format.duration) > 0);
    report.balanceAfter = await balance(); assert.deepEqual(report.balanceAfter, report.balanceBefore); assert.equal(report.pageErrors.length, 0);
    await page.screenshot({ path: path.join(out, `${reportStem}-history.png`), fullPage: true }); report.passed = true;
  }
} catch (error) { report.failure = clean(error.message); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(out, `${reportStem}-failure.png`), fullPage: true }).catch(() => undefined); }
finally { if (marker) report.originalAttempt = { clientRequestId: marker.clientRequestId, phase: marker.phase, model: marker.model, state: marker.state }; if (browser) await browser.close(); await save(); }
console.log(JSON.stringify({ passed: report.passed, mode, model: selectedModel, ttsPosts: report.ttsPosts, report: reportPath, failure: report.failure }));
