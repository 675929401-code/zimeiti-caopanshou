import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ownedPublicSource, probeOwnedPublicSource } from './lib/video-operator-retest-plan.mjs';

// Preparation is read-only. An explicit execute command is required for one
// normal business POST per inspected configuration. No provider API is called
// directly and this runner never starts an instance or changes availability.
export const LOCAL_RUNTIME = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
export const EVIDENCE_ROOT = '.codex-evidence/hidden-video-real-e2e-20260902';
const CONFIRMATION = 'AUTHORIZE_ONE_REAL_VIDEO_CANARY';
const DEFAULT_IMAGE = '6eb959db-9957-42cc-acc9-bc5cdd40d28a';
const DEFAULT_SOURCE = 'vt_5c2a48c95b4f47b8567ba43b8338e0ccb3fbf726';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
export const fingerprint = value => sha(JSON.stringify(canonical(value)));

export function parseOptions(argv) {
  const value = key => argv.find(item => item.startsWith(`--${key}=`))?.slice(key.length + 3);
  const operatorRetest = argv.includes('--operator-retest');
  const modes = ['inspect', 'execute', 'reconcile'].filter(mode => argv.includes(`--${mode}`));
  assert.ok(modes.length <= 1, 'Choose one mode');
  const mode = modes[0] || (operatorRetest ? 'operator-retest' : 'plan');
  const origin = value('origin') || 'http://127.0.0.1:5000';
  assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'Only the two local previews are allowed');
  const concurrency = Number(value('concurrency') || 2);
  assert.ok(concurrency === 1 || concurrency === 2, 'Concurrency must be 1 or 2');
  const runId = value('run-id');
  if (mode !== 'plan') assert.match(runId || '', /^[A-Za-z0-9_-]{6,100}$/u, 'An immutable run ID is required');
  if (mode === 'execute') assert.ok(argv.includes('--confirm-hidden-models-authorized'), 'Explicit reviewed-scope execution confirmation is required');
  if (mode === 'operator-retest') assert.ok(argv.includes('--confirm-operator-retest-authorized'), 'Explicit one-model repair-retest confirmation is required');
  const modelIds = value('models')?.split(',').filter(Boolean);
  if (modelIds) {
    assert.equal(new Set(modelIds).size, modelIds.length, 'Duplicate model selection');
    modelIds.forEach(id => assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u));
  }
  const operatorReason = String(value('reason') || '').trim();
  const sourceRun = String(value('source-run') || '').trim();
  if (operatorRetest) {
    assert.equal(modelIds?.length, 1, 'Operator repair retest requires exactly one selected model');
    assert.ok(operatorReason.length > 0 && operatorReason.length <= 500, 'Operator repair retest requires a reason of 1-500 characters');
    assert.doesNotMatch(operatorReason, /https?:\/\/|\bBearer\s|\bsk-[A-Za-z0-9]|\beyJ[A-Za-z0-9_-]+\./iu, 'Retest reason must not contain URLs or credentials');
    assert.match(sourceRun, /^[A-Za-z0-9_-]{6,100}$/u, 'Operator repair retest requires the original failed run ID');
  }
  const maxWaitMs = Number(value('max-wait-ms') || 20 * 60 * 1000);
  assert.ok(Number.isFinite(maxWaitMs) && maxWaitMs >= 1000 && maxWaitMs <= 60 * 60 * 1000, 'Polling window must be between one second and one hour');
  return { mode, origin, concurrency, runId, modelIds, maxWaitMs, operatorRetest, operatorReason, sourceRun,
    imageAssetIds: value('image-assets')?.split(',').filter(Boolean), audioAssetId: value('audio-asset'), publicSourceTask: value('public-source-task') || DEFAULT_SOURCE };
}

/** Compare credential cells only in memory. No standalone credential hash is returned. */
export function selectBindingRepresentatives(rows, selectedIds) {
  const selected = selectedIds ? rows.filter(row => selectedIds.includes(row.id)) : rows.filter(row => row.is_active !== true || row.is_hidden === true);
  if (selectedIds) assert.equal(selected.length, selectedIds.length, 'A selected local model is missing');
  assert.ok(selected.length > 0, 'No local configurations selected');
  const groups = new Map();
  for (const row of selected.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const binding = fingerprint({ protocol: row.protocol_type, model: row.model_name, workflow: row.api_protocol_config?.workflow_id || null,
      endpoint: String(row.api_endpoint || '').replace(/\/+$/u, ''), credentialHash: sha(String(row.api_key || '').trim()) });
    if (!groups.has(binding)) groups.set(binding, []);
    groups.get(binding).push(row);
  }
  return [...groups].map(([bindingHash, candidates]) => ({ bindingHash, representative: candidates[0], aliasIds: candidates.slice(1).map(row => row.id),
    aliasBoundary: candidates.length > 1 ? 'Same current configured supplier binding; differing duration, price and UI contracts are not individually accepted by this one request.' : null }));
}

export function validatePreflight(dto, modelId, previous) {
  assert.ok(dto?.success === true && dto.model?.id === modelId, 'Local selected model validation failed');
  assert.match(dto.validationKey || '', /^vav_[a-f0-9]{64}$/u);
  assert.match(dto.configurationHash || '', /^[a-f0-9]{64}$/u);
  assert.match(dto.healthEpoch || '', /^[a-f0-9]{64}$/u);
  assert.equal(dto.confirmation, CONFIRMATION);
  assert.equal(dto.endpoint, '/api/video/generate');
  if (previous) {
    for (const key of ['validationKey', 'configurationHash', 'healthEpoch']) assert.equal(dto[key], previous[key], 'Inspected configuration or terminal epoch changed; no new task submitted');
    assert.equal(dto.model.publicId, previous.model.publicId, 'Public model identity changed');
  }
  return dto;
}

export function chooseCanaryDuration(validation, billingUnit) {
  return Number(billingUnit === 'output_second' ? validation.minimumInput.durationSeconds
    : validation.capabilities.defaultDuration || validation.minimumInput.durationSeconds);
}

export function buildPayload(plan, assets, runId) {
  const dto = plan.validation, input = dto.minimumInput, caps = dto.capabilities;
  assert.ok(dto.readiness.credentialReady && dto.readiness.endpointConfigured, 'Model credentials or endpoint are not ready');
  assert.ok(input.requiresComputeLifecycle !== true, 'Existing compute requires separate operator verification; no instance startup allowed');
  const images = assets.images || [], audios = assets.audios || [];
  assert.ok(images.length >= input.imageCount, 'Required owned reference images are not prepared');
  assert.ok(audios.length >= input.audioCount, 'Required owned reference audio is not prepared');
  if (input.lastFrameRequired) assert.ok(images[0]?.id !== images[1]?.id, 'First and last frame must be distinct real owned assets');
  if (input.sourceVideoRequired) assert.ok(assets.source?.url, 'A real completed owned source video is required');
  const body = { model_id: dto.model.id, client_request_id: dto.validationKey,
    admin_validation: true, admin_validation_key: dto.validationKey, admin_validation_confirmation: CONFIRMATION,
    surface: 'video-page', task_label: `hidden-e2e:${runId}:${dto.model.id}`, batch_id: `hidden-e2e:${runId}`,
    prompt: input.promptRequired ? input.sourceVideoRequired ? 'Keep the original scene and motion. Apply a subtle warm cinematic color grade. Do not add text.' : 'A small ceramic cup on a wooden table in soft daylight. Gentle camera movement, natural materials, steady composition, no text.' : '',
    duration: plan.durationSeconds, aspect_ratio: input.aspectRatio,
    ...(input.resolution ? { resolution: input.resolution, resolution_tier: input.resolution } : {}) };
  let nextImage = 0;
  if (input.firstFrameRequired || caps.mode === 'flexible_image' && input.imageCount > 0) body.image_url = images[nextImage++].url;
  if (input.lastFrameRequired) body.last_frame_url = images[nextImage++].url;
  if (nextImage < input.imageCount) body.reference_image_urls = images.slice(nextImage, input.imageCount).map(item => item.url);
  if (input.audioCount) {
    if (caps.mode === 'image_audio_lipsync') body.audio_url = audios[0].url;
    else body.reference_audio_urls = audios.slice(0, input.audioCount).map(item => item.url);
  }
  if (input.sourceVideoRequired) body.source_video_url = assets.source.url;
  return body;
}

/** HTTP status is advisory; only a durable owned task row proves terminal state. */
export function durableState(row, responseBody) {
  if (!row) return responseBody?.task_submitted === false ? 'blocked-before-dispatch' : 'unknown-no-business-record';
  if (TERMINAL.has(row.status)) return row.status;
  return 'processing';
}

export async function dispatchOnce({ claimsDir, modelDir, userHash, plan, payload, runId, claimScope = 'configuration', post, save }) {
  await fs.mkdir(claimsDir, { recursive: true }); await fs.mkdir(modelDir, { recursive: true });
  const marker = { at: new Date().toISOString(), runId, modelId: plan.validation.model.id, publicModelId: plan.validation.model.publicId,
    clientRequestId: plan.validation.validationKey, configurationHash: plan.validation.configurationHash, healthEpoch: plan.validation.healthEpoch,
    bindingHash: plan.bindingHash, requestFingerprint: fingerprint(payload) };
  // Across run IDs, terminal changes cannot silently grant another execution
  // of this configuration. A retest needs a separately reviewed operator flow.
  const claimIdentity = claimScope === 'operator-retest'
    ? { userHash, configurationHash: marker.configurationHash, healthEpoch: marker.healthEpoch, claimScope }
    : { userHash, configurationHash: marker.configurationHash, claimScope };
  const claimFile = path.join(claimsDir, `${fingerprint(claimIdentity)}.json`);
  await fs.writeFile(claimFile, JSON.stringify(marker, null, 2), { flag: 'wx' });
  await fs.writeFile(path.join(modelDir, 'dispatch.json'), JSON.stringify(marker, null, 2), { flag: 'wx' });
  await save({ state: 'dispatch-marked', marker, posts: 0 });
  // Record intended transmission before invoking fetch. A killed process or
  // lost response leaves an immutable marker, never permission to resubmit.
  await save({ state: 'dispatched', marker, posts: 1 });
  return post(payload);
}

async function readBounded(response, maximum) {
  const reader = response.body?.getReader(); assert.ok(reader, 'Media response body is missing');
  const chunks = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; assert.ok(size <= maximum, 'Media exceeds the bounded verification size'); chunks.push(Buffer.from(part.value)); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

async function audioDuration(bytes) {
  const require = createRequire(import.meta.url);
  const binary = require('ffprobe-static').path;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, ['-v', 'error', '-show_entries', 'format=duration:packet=duration_time', '-of', 'json', '-i', 'pipe:0'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let length = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Audio metadata probe timed out')); }, 15000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Audio metadata probe unavailable')); });
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 2_000_000) child.kill(); else output.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); if (code !== 0 || length > 2_000_000) reject(new Error('Audio metadata probe failed')); else resolve(Buffer.concat(output).toString('utf8')); });
    child.stdin.end(bytes);
  });
  const data = JSON.parse(result);
  const duration = Number(data.format?.duration) || (data.packets || []).reduce((sum, packet) => sum + (Number(packet.duration_time) || 0), 0);
  assert.ok(Number.isFinite(duration) && duration > 0, 'Real audio duration could not be measured');
  return duration;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.mode === 'plan') { console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, generationRequests: 0, origin: options.origin,
    command: 'node --import tsx scripts/verify-hidden-video-models-e2e.mjs --inspect|--execute|--reconcile --run-id=<fixed> [--models=<ids>] [--origin=http://127.0.0.1:5002]',
    operatorRetest: '--operator-retest [--inspect] --models=<one-id> --reason=<repair-reason> --source-run=<failed-run> --run-id=<new-run> --confirm-operator-retest-authorized',
    executeConfirmation: '--confirm-hidden-models-authorized', normalSessionEnvironment: 'LOCAL_NAV_ADMIN_TOKEN', scope: 'One representative per current configured supplier binding; unknown requests only reconcile.' })); return; }
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'A normal administrator session is required');
  const cfg = JSON.parse((await fs.readFile(LOCAL_RUNTIME, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.equal(new URL(cfg.supabaseUrl).toString(), 'http://127.0.0.1:54321/', 'Only the exact local REST root is allowed');
  const authHeaders = { Authorization: `Bearer ${token}` };
  const dbHeaders = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
  const clean = value => { let text = String(value || ''); for (const secret of [token, cfg.serviceRoleKey, cfg.anonKey]) if (secret) text = text.split(secret).join('[redacted]'); return text.replace(/https?:\/\/\S+/gu, '[url]').replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/gu, '[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, 500); };
  const api = async (route, init = {}) => {
    const { timeoutMs = 30000, ...requestInit } = init;
    const response = await fetch(`${options.origin}${route}`, { ...requestInit, headers: { ...authHeaders, ...requestInit.headers }, signal: AbortSignal.timeout(timeoutMs) });
    let body = null; try { body = await response.json(); } catch { /* Unknown HTTP content is never safe to replay. */ }
    return { ok: response.ok, status: response.status, body };
  };
  const rows = async (table, select, filters = {}) => {
    const url = new URL(`/rest/v1/${table}`, cfg.supabaseUrl); url.searchParams.set('select', select);
    for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: dbHeaders, signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, `Local table read failed: ${table}:${response.status}`);
    const data = await response.json(); assert.ok(Array.isArray(data), 'Expected a local row array'); return data;
  };
  const me = await api('/api/auth/me'); assert.ok(me.ok && me.body?.user?.role === 'admin', 'Normal administrator verification failed');
  const userId = me.body.user.id, userHash = sha(userId);
  const [dbUser] = await rows('users', 'id,role,is_active,status,cash_balance,credits', { id: `eq.${userId}`, limit: '1' });
  assert.ok(dbUser?.role === 'admin' && dbUser.is_active === true && (!dbUser.status || dbUser.status === 'active'), 'Current local administrator authorization failed');
  const out = path.resolve(EVIDENCE_ROOT, options.runId), planPath = path.join(out, 'plan.json');
  await fs.mkdir(out, { recursive: true });
  const readOperatorSource = async modelId => {
    assert.ok(options.operatorRetest, 'Operator source evidence is restricted to a repair retest');
    const sourceRoot = path.resolve(EVIDENCE_ROOT, options.sourceRun);
    const evidenceRoot = `${path.resolve(EVIDENCE_ROOT)}${path.sep}`;
    assert.ok(`${sourceRoot}${path.sep}`.startsWith(evidenceRoot), 'Original run must stay inside the evidence root');
    const sourcePath = path.join(sourceRoot, modelId.replace(/[^A-Za-z0-9_-]/gu, '_'), 'result.json');
    const prior = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    assert.equal(prior.modelId, modelId, 'Original failed evidence belongs to a different model');
    assert.equal(prior.posts, 1, 'Original evidence must contain exactly one dispatch');
    assert.ok(prior.state === 'failed' && prior.business?.status === 'failed', 'Only a terminal failed business task may enter repair retest');
    return { runId: options.sourceRun, modelId, state: prior.state, businessTaskId: prior.business.id, routingVerified: prior.routingVerified === true };
  };
  const getValidation = async (modelId, old) => {
    const response = await api(`/api/admin/video-models/validation?modelId=${encodeURIComponent(modelId)}`);
    assert.ok(response.ok, `Selected model preflight failed: ${modelId}:${response.status}:${clean(response.body?.code)}`);
    return validatePreflight(response.body, modelId, old);
  };
  const signedAsset = async (id, type, full = false) => {
    const [row] = await rows('user_files', 'id,user_id,storage_key,storage_provider,content_type', { id: `eq.${id}`, user_id: `eq.${userId}`, limit: '1' });
    assert.ok(row?.storage_key && row.user_id === userId && row.content_type?.startsWith(`${type}/`), 'Required owned media metadata is unavailable');
    const signing = await api(`/api/file?key=${encodeURIComponent(row.storage_key)}`);
    assert.ok(signing.ok && typeof signing.body?.url === 'string', 'Owned input signing failed');
    const url = new URL(signing.body.url); assert.equal(url.protocol, 'https:', 'Provider input must be HTTPS');
    const response = await fetch(`${options.origin}/api/storage/files/${encodeURIComponent(id)}/content`, { headers: { ...authHeaders, ...(full ? {} : { Range: 'bytes=0-65535' }) }, signal: AbortSignal.timeout(45000) });
    assert.ok(response.ok && response.headers.get('content-type')?.startsWith(`${type}/`), 'Owned input bytes are unavailable');
    const bytes = await readBounded(response, full ? 16 * 1024 * 1024 : 32 * 1024 * 1024); assert.ok(bytes.length > 128, 'Owned input bytes are incomplete');
    const result = { id, url: url.toString(), contentType: response.headers.get('content-type'), bytes: bytes.length, readHttp: response.status };
    if (type === 'audio') result.durationSeconds = await audioDuration(bytes);
    return result;
  };
  const prepareAssets = async (plan, selection) => {
    const input = plan.validation.minimumInput;
    const images = [], audios = [];
    for (const id of selection.imageIds.slice(0, input.imageCount)) images.push(await signedAsset(id, 'image'));
    for (const id of selection.audioIds.slice(0, input.audioCount)) audios.push(await signedAsset(id, 'audio', true));
    let source = null;
    if (input.sourceVideoRequired) {
      const [row] = await rows('video_tasks', 'id,user_id,model_id,status,provider_result_url,duration_seconds', { id: `eq.${selection.sourceTaskId}`, user_id: `eq.${userId}`, limit: '1' });
      const url = ownedPublicSource({ row, userId, taskId: selection.sourceTaskId });
      const probes = await probeOwnedPublicSource(url, fetch);
      source = { id: row.id, url: url.toString(), probes, durationSeconds: Number(row.duration_seconds) };
    }
    return { images, audios, source };
  };
  const assetSummary = item => ({ id: item.id, contentType: item.contentType, bytes: item.bytes, readHttp: item.readHttp, ...(item.durationSeconds ? { durationSeconds: item.durationSeconds } : {}) });
  const summarizeAssets = assets => ({ images: assets.images.map(assetSummary), audios: assets.audios.map(assetSummary), source: assets.source ? { id: assets.source.id, durationSeconds: assets.source.durationSeconds, probes: assets.source.probes } : null });
  let manifest;
  if (options.mode === 'inspect') {
    try { await fs.access(planPath); throw new Error('A frozen plan already exists; use its execute or reconcile command'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const localModels = await rows('video_models', 'id,model_name,protocol_type,api_endpoint,api_key,api_protocol_config,is_active,is_hidden,price_per_use,cost_price,duration_seconds,max_duration', { order: 'id' });
    const groups = selectBindingRepresentatives(localModels, options.modelIds);
    const owned = await rows('user_files', 'id,content_type', { user_id: `eq.${userId}`, content_type: 'in.(image/png,image/jpeg,image/webp,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/ogg)', order: 'created_at.desc', limit: '100' });
    const availableImages = owned.filter(row => row.content_type.startsWith('image/')).map(row => row.id);
    const imageIds = options.imageAssetIds || [...new Set([...(availableImages.includes(DEFAULT_IMAGE) ? [DEFAULT_IMAGE] : []), ...availableImages])];
    const audioIds = options.audioAssetId ? [options.audioAssetId] : owned.filter(row => row.content_type.startsWith('audio/')).map(row => row.id);
    const selection = { imageIds, audioIds, sourceTaskId: options.publicSourceTask };
    const { resolveVideoCharge } = await import('../src/lib/video-model-capabilities.ts');
    manifest = { schema: 'hidden-video-canary-plan.v1', at: new Date().toISOString(), origin: options.origin, userHash, localDatabaseOnly: true,
      scope: options.modelIds || 'all-current-hidden-or-inactive', selectedConfigurationCount: groups.reduce((n, group) => n + 1 + group.aliasIds.length, 0), bindingCount: groups.length,
      normalAdmin: true, administratorPlatformCharge: 0, assetSelection: selection, noInstanceStartup: true, credentialsOrMediaUrlsPersisted: false,
      operatorRetest: options.operatorRetest, operatorRetestReason: options.operatorRetest ? options.operatorReason : null,
      operatorSourceRun: options.operatorRetest ? options.sourceRun : null, operatorSourceEvidence: [],
      bindingComparison: 'Current configured credential cells compared in memory. Combined binding hash does not independently prove all alias contracts or historical resolved credential values.', plans: [] };
    for (const group of groups) {
      if (options.operatorRetest) manifest.operatorSourceEvidence.push(await readOperatorSource(group.representative.id));
      const validation = await getValidation(group.representative.id);
      const plan = { bindingHash: group.bindingHash, aliasIds: group.aliasIds, aliasBoundary: group.aliasBoundary, validation,
        durationSeconds: chooseCanaryDuration(validation, group.representative.api_protocol_config?.billing_unit) };
      try {
        assert.ok(!validation.minimumInput.requiresComputeLifecycle, 'Existing compute requires separate operator verification; no startup allowed');
        assert.ok(validation.readiness.credentialReady && validation.readiness.endpointConfigured, 'Current credentials or endpoint are not ready');
        const assets = await prepareAssets(plan, selection);
        if (validation.capabilities.mode === 'image_audio_lipsync') {
          const measured = assets.audios[0]?.durationSeconds;
          const requested = Math.ceil(measured);
          assert.ok(Number.isFinite(requested) && requested >= validation.capabilities.minDuration && requested <= validation.capabilities.maxDuration, 'Owned audio duration is outside this workflow contract');
          plan.durationSeconds = requested;
        }
        buildPayload(plan, assets, options.runId);
        plan.assets = summarizeAssets(assets); plan.ready = true;
      } catch (error) { plan.ready = false; plan.preflightError = clean(error.message); }
      const price = resolveVideoCharge(group.representative, validation.minimumInput.resolution, plan.durationSeconds);
      plan.quote = { publicPrice: price.publicPrice, configuredSupplierCost: price.costPrice, billingUnit: price.billingUnit, billingQuantity: price.billingQuantity, actualSupplierCharge: 'not-yet-observed' };
      manifest.plans.push(plan);
      console.log(JSON.stringify({ phase: 'inspect', model: validation.model.id, ready: plan.ready, aliasCount: plan.aliasIds.length, publicPrice: plan.quote.publicPrice, error: plan.preflightError || null }));
    }
    manifest.assetSelection = { ...selection,
      imageIds: selection.imageIds.slice(0, Math.max(...manifest.plans.map(plan => plan.validation.minimumInput.imageCount))),
      audioIds: selection.audioIds.slice(0, Math.max(...manifest.plans.map(plan => plan.validation.minimumInput.audioCount))) };
    await fs.writeFile(planPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ phase: 'inspect-finished', configurations: manifest.selectedConfigurationCount, bindings: manifest.bindingCount, ready: manifest.plans.filter(item => item.ready).length, evidence: planPath })); return;
  }
  manifest = JSON.parse(await fs.readFile(planPath, 'utf8'));
  assert.equal(manifest.schema, 'hidden-video-canary-plan.v1'); assert.equal(manifest.userHash, userHash, 'Use the original normal administrator session');
  assert.equal(manifest.operatorRetest === true, options.operatorRetest, 'Repair-retest mode must match the frozen inspection plan');
  if (options.operatorRetest) {
    assert.equal(manifest.operatorRetestReason, options.operatorReason, 'Repair reason changed after inspection');
    assert.equal(manifest.operatorSourceRun, options.sourceRun, 'Original failed run changed after inspection');
  }
  // Both previews use this same local database. Reconciliation may use the
  // stable preview even if the original development preview was stopped.
  const selected = options.modelIds ? manifest.plans.filter(plan => options.modelIds.includes(plan.validation.model.id)) : manifest.plans;
  if (options.modelIds) assert.equal(selected.length, options.modelIds.length, 'Selected model is not an inspected representative');
  const receiptPaths = [
    path.resolve('.runtime/canvas-video-generation.ndjson'),
    path.resolve(path.dirname(LOCAL_RUNTIME), '../preview-runtime/canvas-video-generation.ndjson'),
  ];
  const routing = async plan => {
    const chunks = [];
    for (const receiptPath of receiptPaths) {
      try { chunks.push(await fs.readFile(receiptPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const raw = chunks.join('\n');
    if (!raw) return [];
    return raw.split(/\r?\n/u).flatMap(line => {
      let row; try { row = JSON.parse(line); } catch { return []; }
      if (row.phase !== 'provider_dispatch' || row.clientRequestId !== plan.validation.validationKey) return [];
      const matched = row.modelId === plan.validation.model.id && row.protocol === plan.validation.model.protocol
        && row.endpointHost === plan.validation.model.endpointHost && (row.submittedWorkflow || row.submittedModel) === (plan.validation.model.workflowId || plan.validation.model.upstreamModel);
      return [{ modelId: row.modelId, protocol: row.protocol, submittedModel: row.submittedModel || null, submittedWorkflow: row.submittedWorkflow || null, endpointHost: row.endpointHost, matchesInspectedModel: matched }];
    });
  };
  const outcomes = [];
  const work = async plan => {
    const id = plan.validation.model.id, modelDir = path.join(out, id.replace(/[^A-Za-z0-9_-]/gu, '_'));
    await fs.mkdir(modelDir, { recursive: true });
    const resultPath = path.join(modelDir, 'result.json'), markerPath = path.join(modelDir, 'dispatch.json');
    let state = { at: new Date().toISOString(), modelId: id, clientRequestId: plan.validation.validationKey, state: 'prepared', posts: 0, polls: [] };
    const save = async patch => { Object.assign(state, patch); await fs.writeFile(resultPath, JSON.stringify(state, null, 2)); };
    const taskRows = () => rows('video_tasks', 'id,model_id,task_id_external,status,billing_state,billing_idempotency_key,price_charged,client_request_id,error_message,duration_seconds,resolution,storage_url', { user_id: `eq.${userId}`, client_request_id: `eq.${state.clientRequestId}`, limit: '2' });
    let unresolved = false;
    try {
      if (options.mode === 'reconcile') {
        let marker; try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') { state.state = 'not-dispatched'; return false; } throw error; }
        assert.equal(marker.clientRequestId, plan.validation.validationKey); assert.equal(marker.modelId, id);
        try { state = { ...state, ...JSON.parse(await fs.readFile(resultPath, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        state.newPostsThisRun = 0; state.reconciledAt = new Date().toISOString();
      } else {
        try {
          await fs.access(markerPath);
          try { state = { ...state, ...JSON.parse(await fs.readFile(resultPath, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          state.executionSkipped = 'already-marked-use-reconcile'; unresolved = !TERMINAL.has(state.business?.status); return unresolved;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!plan.ready) { state.state = 'blocked-preflight'; state.error = plan.preflightError; return false; }
        if (options.operatorRetest) await readOperatorSource(id);
        await getValidation(id, plan.validation);
        assert.equal((await taskRows()).length, 0, 'An existing business request requires reconcile only');
        const assets = await prepareAssets(plan, manifest.assetSelection);
        const payload = buildPayload(plan, assets, options.runId);
        state.input = summarizeAssets(assets);
        await getValidation(id, plan.validation);
        let response;
        try {
          response = await dispatchOnce({
            claimsDir: path.resolve(EVIDENCE_ROOT, options.operatorRetest ? 'operator-retest-claims' : 'configuration-claims'),
            claimScope: options.operatorRetest ? 'operator-retest' : 'configuration',
            modelDir, userHash, plan, payload, runId: options.runId, save,
            post: body => api('/api/video/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': body.client_request_id, 'X-Request-ID': body.client_request_id }, body: JSON.stringify(body), timeoutMs: 240000 }) });
        } catch (error) { if (error.code === 'EEXIST') throw new Error(options.operatorRetest ? 'This repaired health epoch is already marked; reconcile its original retest run' : 'Configuration already marked in an original run; reconcile that run'); state.transportError = clean(error.message); }
        if (response) state.submission = { http: response.status, taskSubmitted: response.body?.task_submitted ?? null, status: response.body?.status || null, code: response.body?.error_code || response.body?.code || null,
          error: clean(response.body?.error), taskId: response.body?.task_id || null, businessTaskId: response.body?.business_task_id || null, returnedModelId: response.body?.model_id || null, replayed: response.body?.replayed === true };
        if (state.submission?.returnedModelId) assert.equal(state.submission.returnedModelId, id, 'Submission used a different model');
        await save({});
      }
      const deadline = Date.now() + options.maxWaitMs;
      while (Date.now() < deadline) {
        const found = await taskRows(); assert.ok(found.length <= 1, 'Duplicate business rows');
        const row = found[0];
        if (!row) { state.state = durableState(null, { task_submitted: state.submission?.taskSubmitted }); break; }
        assert.equal(row.model_id, id, 'Persisted business model differs from inspection');
        state.business = { id: row.id, modelId: row.model_id, providerTaskId: row.task_id_external, status: row.status, billingState: row.billing_state, billingIdempotencyKey: row.billing_idempotency_key, priceCharged: row.price_charged,
          hasOwnedStorage: !!row.storage_url, duration: row.duration_seconds, resolution: row.resolution, error: clean(row.error_message) };
        if (row.status === 'failed' || row.status === 'cancelled') { state.state = row.status; break; }
        if (!row.task_id_external) { state.state = 'unknown-provider-acknowledgement'; break; }
        const taskId = row.task_id_external || row.id;
        let response;
        try {
          response = await api(`/api/video/status?${new URLSearchParams({ taskId, modelId: plan.validation.model.publicId })}`, { timeoutMs: 90000 });
        } catch (error) {
          state.polls.push({ at: new Date().toISOString(), status: 'status-read-unavailable', error: clean(error.message) });
          state.state = 'processing'; await save({}); await new Promise(resolve => setTimeout(resolve, 15000)); continue;
        }
        const poll = { at: new Date().toISOString(), http: response.status, status: response.body?.status || null, code: response.body?.errorCode || response.body?.error_code || response.body?.code || null, error: clean(response.body?.errorMessage || response.body?.error) };
        if (!state.polls.length || state.polls.at(-1).status !== poll.status || !response.ok) state.polls.push(poll);
        const [fresh] = await taskRows();
        state.state = durableState(fresh, null);
        if (fresh?.status === 'completed') {
          assert.equal(fresh.model_id, id); assert.ok(fresh.storage_url, 'Completed task has no owned storage'); assert.equal(Number(fresh.price_charged), 0, 'Administrator charge should be zero');
          state.business = { ...state.business, status: fresh.status, billingState: fresh.billing_state, priceCharged: fresh.price_charged, hasOwnedStorage: true };
          const delivery = response.body?.videoUrl || response.body?.storageUrl;
          assert.ok(delivery, 'Completed task delivery is missing');
          const url = new URL(delivery, options.origin); assert.ok(url.protocol === 'https:' || url.origin === options.origin, 'Unexpected delivery origin');
          // Owned media routes redirect to a signed object URL. Fetch removes
          // Authorization when following a cross-origin redirect.
          const media = await fetch(url, { headers: { ...(url.origin === options.origin ? authHeaders : {}), Range: 'bytes=0-65535' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
          assert.ok(media.ok && /video|octet-stream/u.test(media.headers.get('content-type') || ''), 'Video delivery is not readable');
          const bytes = await readBounded(media, 32 * 1024 * 1024); assert.ok(bytes.length > 1024, 'Video delivery bytes are incomplete');
          state.delivery = { http: media.status, contentType: media.headers.get('content-type'), bytes: bytes.length, host: new URL(media.url).hostname, urlHash: sha(media.url) };
          break;
        }
        if (fresh?.status === 'failed' || fresh?.status === 'cancelled') { state.business.status = fresh.status; break; }
        state.state = 'processing'; await save({}); await new Promise(resolve => setTimeout(resolve, 15000));
      }
      if (state.state === 'processing') state.state = 'unknown-poll-window';
    } catch (error) { state.error = clean(error.message); state.state = state.business?.status === 'completed' ? 'delivery-verification-failed' : state.posts > 0 ? 'unknown-verification-error' : 'blocked-preflight'; }
    finally {
      const receipts = await routing(plan);
      state.providerRequests = receipts; state.routingVerified = receipts.length > 0 && receipts.every(item => item.matchesInspectedModel);
      // No additional diagnostic writes or balance requests can turn a known
      // terminal result into an instruction to resubmit a generation.
      if (state.business?.billingIdempotencyKey) {
        const operations = await rows('wallet_operations', 'id,operation_kind,status,amount', { user_id: `eq.${userId}`, idempotency_key: `eq.${state.business.billingIdempotencyKey}`, limit: '3' }).catch(() => null);
        state.walletOperationRead = operations ? { count: operations.length, amounts: operations.map(row => Number(row.amount)), statuses: operations.map(row => row.status) } : { unavailable: true };
      }
      unresolved = unresolved || (state.posts > 0 && !TERMINAL.has(state.business?.status) && state.state !== 'blocked-before-dispatch');
      state.slotReserved = unresolved; state.finishedAt = new Date().toISOString(); await save({});
      outcomes.push({ modelId: id, state: state.state, slotReserved: unresolved, routingVerified: state.routingVerified, report: path.relative(out, resultPath) });
      console.log(JSON.stringify(outcomes.at(-1)));
    }
    return unresolved;
  };
  let cursor = 0;
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (cursor < selected.length) { const next = selected[cursor++]; const unknown = await work(next); if ((options.mode === 'execute' || options.mode === 'operator-retest') && unknown) break; }
  }));
  const [afterUser] = await rows('users', 'cash_balance,credits', { id: `eq.${userId}`, limit: '1' });
  await fs.writeFile(path.join(out, `${options.mode}-summary.json`), JSON.stringify({ at: new Date().toISOString(), origin: options.origin, selected: selected.length, outcomes,
    notDispatchedWhileSlotsReserved: selected.slice(cursor).map(plan => plan.validation.model.id),
    administratorBalance: { cashBefore: Number(dbUser.cash_balance), cashAfter: Number(afterUser?.cash_balance), creditsBefore: Number(dbUser.credits), creditsAfter: Number(afterUser?.credits), concurrentOtherWorkMayAffectComparison: true },
    noDirectProviderRequests: true, noAvailabilityChanges: true, noInstanceStartup: true }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ failed: true, error: String(error.message || '').replace(/https?:\/\/\S+/gu, '[url]').replace(/\b(?:Bearer|sk-)\S+/giu, '[redacted]').slice(0, 500), generationRequestsAutomaticallyRetried: 0 })); process.exitCode = 1; });
}
