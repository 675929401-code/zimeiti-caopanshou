import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { publicModelDisplayName } from '../src/lib/public-model-dto.ts';
import { getVideoInputContract } from '../src/lib/video-input-contract.ts';
import { getVideoDurationCapabilities, getVideoResolutionCapabilities } from '../src/lib/video-model-capabilities.ts';
import { parseAutodlH3AssetRef } from '../src/lib/autodl-h3-assets.ts';
import { selectOperatorRetest, operatorRetestControls, ownedPublicSource, probeOwnedPublicSource } from './lib/video-operator-retest-plan.mjs';

// Explicitly authorised local canaries. Never invokes a provider directly,
// changes model availability, fabricates health, or creates GPU instances.
const origin = 'http://127.0.0.1:5000';
const runtime = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const providerReceiptPaths = [
  path.resolve('.runtime/canvas-video-generation.ndjson'),
  path.resolve(path.dirname(runtime), '../preview-runtime/canvas-video-generation.ndjson'),
];
const operatorRequested = process.argv.includes('--operator-retest');
assert.ok(!(operatorRequested && (process.argv.includes('--execute') || process.argv.includes('--reconcile'))), 'Operator retest cannot be combined with execute or reconcile; reconcile the saved run separately');
const mode = process.argv.includes('--reconcile') ? 'reconcile' : process.argv.includes('--inspect') ? 'inspect' : operatorRequested ? 'operator-retest' : process.argv.includes('--execute') ? 'execute' : 'plan';
const argument = key => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3);
const concurrency = operatorRequested ? 1 : Number(argument('concurrency') || 2);
assert.ok(concurrency === 1 || concurrency === 2, 'Concurrency must remain 1 or 2');
if (operatorRequested) assert.ok(!argument('concurrency') || argument('concurrency') === '1', 'Operator retest dispatches only one selected model');
const selectedIds = argument('models')?.split(',').filter(Boolean);
const publicSourceTask = argument('public-source-task');
const withReferenceImage = process.argv.includes('--with-reference-image');
const sharedReferenceConfirmed = process.argv.includes('--confirm-shared-reference-image');
assert.ok(!publicSourceTask || operatorRequested, 'Public provider source override is restricted to explicit operator retest');
assert.ok(!withReferenceImage || operatorRequested || (['inspect', 'execute'].includes(mode) && sharedReferenceConfirmed), 'Shared reference image requires explicit inspection/execution confirmation');
if (publicSourceTask) assert.match(publicSourceTask, /^vt_[a-zA-Z0-9]{8,100}$/u, 'Expected a completed local video task ID');
const runId = argument('run-id');
const requestedSurface = argument('surface') || 'video-page';
assert.ok(['video-page', 'storyboard-workbench'].includes(requestedSurface), 'Supported video surface required');
const requestedResolution = argument('resolution');
const requestedDuration = argument('duration') ? Number(argument('duration')) : null;
if (requestedResolution) assert.match(requestedResolution, /^(?:480p|720p|768p|1080p|2K|4K)$/u, 'Supported forced resolution required');
if (requestedDuration !== null) assert.ok(Number.isFinite(requestedDuration) && requestedDuration > 0, 'Positive forced duration required');
const requestedImageAssetId = argument('image-asset-id') || '6eb959db-9957-42cc-acc9-bc5cdd40d28a';
const requestedLastFrameAssetId = argument('last-frame-asset-id') || '9c78de2b-6b2b-4096-982d-15252c565bd6';
const promptFile = argument('prompt-file');
const sharedVideoPrompt = promptFile
  ? (await fs.readFile(path.resolve(promptFile), 'utf8')).trim()
  : 'A small yellow ceramic cup sits on a wooden table in soft daylight. A gentle camera push-in, realistic materials, steady composition, no text.';
assert.ok(sharedVideoPrompt.length >= 20 && sharedVideoPrompt.length <= 8_000, 'Video prompt length is invalid');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
if (mode === 'plan') { console.log(JSON.stringify({ mode, networkRequests: 0, origin, concurrency: 2, command: 'node --import tsx scripts/verify-video-all-models-e2e.mjs --inspect|--execute|--reconcile --run-id=<safe-name>', operatorRetest: '--operator-retest [--inspect] --models=<one-internal-id> --reason=<repair-reason> --run-id=<safe-name> [--public-source-task=<owned-completed-task>] [--with-reference-image] --confirm-operator-retest-authorized', requiredEnvironment: 'LOCAL_NAV_ADMIN_TOKEN (normal session, memory only)', rule: 'One dispatch per model; marked before POST; unknown reserves its slot; reconcile only polls original tasks.' })); process.exit(0); }
assert.ok(runId && /^[a-zA-Z0-9_-]{6,100}$/.test(runId), 'Fixed safe run ID required');
const catalogPath = path.resolve(argument('catalog') || '.codex-evidence/video-all-models-real-e2e-20260902/reviewed-catalog-13.json');
const reviewedCatalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
assert.ok(Array.isArray(reviewedCatalog.models) && reviewedCatalog.models.length > 0 && reviewedCatalog.models.length <= 100, 'Reviewed catalog must contain a bounded model list');
assert.equal(new Set(reviewedCatalog.models.map(model => model.internalId)).size, reviewedCatalog.models.length, 'Reviewed internal model IDs must be unique');
assert.equal(new Set(reviewedCatalog.models.map(model => model.publicId)).size, reviewedCatalog.models.length, 'Reviewed public model IDs must be unique');
const operatorSelection = operatorRequested ? selectOperatorRetest({ modelIds: selectedIds, reason: argument('reason'), reviewedModels: reviewedCatalog.models }) : null;
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.ok(token, 'Normal admin session required');
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || '').trim();
const cfg = JSON.parse((await fs.readFile(runtime, 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).hostname, '127.0.0.1'); assert.equal(new URL(cfg.supabaseUrl).port, '54321');
const authHeaders = {
  Authorization: `Bearer ${token}`,
  ...(stepUpToken ? { 'x-admin-step-up': stepUpToken } : {}),
};
const dbHeaders = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
const evidenceRoot = path.resolve(argument('evidence-root') || path.dirname(catalogPath));
const out = path.resolve(evidenceRoot, runId);
await fs.mkdir(out, { recursive: true });
const clean = value => String(value || '').split(token).join('[redacted]').replace(/https?:\/\/\S+/g, '[url]').replace(/(?:Bearer\s+)\S+/gi, 'Bearer [redacted]').replace(/\b1[3-9]\d{9}\b/g, '[phone]').slice(0, 800);
async function api(route, options = {}) {
  const response = await fetch(`${origin}${route}`, { ...options, headers: { ...authHeaders, ...(options.headers || {}) }, signal: AbortSignal.timeout(options.timeoutMs || 30000) });
  let body = null; try { body = await response.json(); } catch {}
  return { ok: response.ok, status: response.status, body };
}
async function rows(table, select, filters = {}) {
  const url = new URL(`${cfg.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}`);
  url.searchParams.set('select', select); for (const [k,v] of Object.entries(filters)) url.searchParams.set(k,v);
  const response = await fetch(url, { headers: dbHeaders, signal: AbortSignal.timeout(15000) });
  const body = await response.json(); assert.ok(response.ok && Array.isArray(body), `Local read failed ${table}:${response.status}`); return body;
}
const me = await api('/api/auth/me');
assert.ok(me.ok && me.body?.user?.role === 'admin', 'Normal admin verification failed');
const userId = me.body.user.id;
assert.equal((await rows('users', 'id', { id: `eq.${userId}`, limit: '1' })).length, 1);
let savedInventory = null;
if (mode === 'reconcile') {
  try { savedInventory = JSON.parse(await fs.readFile(path.join(out, 'operator-retest-inventory.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; savedInventory = JSON.parse(await fs.readFile(path.join(out, 'execute-inventory.json'), 'utf8')); }
}
const operatorRun = operatorRequested || savedInventory?.operatorRetest === true;
const [catalog, health, modelRows, mappingCatalog] = savedInventory ? [
  { ok: true, body: { models: [] } }, { ok: true, body: { channels: [] } }, [], { ok: true, body: { models: [] } },
] : await Promise.all([
  api(`/api/video/models?surface=${encodeURIComponent(requestedSurface)}`), api('/api/video/channel-health'),
  // A repair retest must be able to address the exact failed hidden row before
  // publication. Normal catalog-wide runs remain restricted to active rows.
  rows('video_models', 'id,name,model_name,protocol_type,price_per_use,cost_price,api_endpoint,api_protocol_config,is_active,is_hidden,supports_image_input,requires_image,duration_seconds', operatorRequested ? {} : { is_active: 'eq.true' }),
  api(`/api/video/models?surface=${encodeURIComponent(requestedSurface)}`),
]);
assert.ok(catalog.ok && Array.isArray(catalog.body?.models)); assert.ok(health.ok && Array.isArray(health.body?.channels));
const healthMap = new Map(health.body.channels.map(x => [x.channelId, x]));
const operatorReason = operatorSelection?.reason || savedInventory?.operatorRetestReason || null;
const plans = savedInventory ? savedInventory.plans : (operatorSelection?.reviewedModels || reviewedCatalog.models).map(reviewed => {
  const matches = modelRows.filter(row => row.id === reviewed.internalId);
  assert.equal(matches.length, 1, `Reviewed model not active in backend: ${reviewed.internalId}`);
  const row = matches[0]; const h = healthMap.get(row.id);
  const currentPublicMapping = mappingCatalog.body?.models?.find(x => x.id === reviewed.publicId);
  // A failed channel is intentionally absent from every public catalog. The
  // reviewed opaque ID remains the only permitted ID for an explicit one-model
  // operator retest; the generate route revalidates its current recovery epoch.
  const authoritativePublic = currentPublicMapping || (operatorRequested
    ? { id: reviewed.publicId, displayName: publicModelDisplayName(row) }
    : null);
  assert.ok(mappingCatalog.ok && authoritativePublic, `Server cannot confirm reviewed public ID: ${reviewed.internalId}`);
  assert.equal(authoritativePublic.displayName, publicModelDisplayName(row));
  assert.equal(modelRows.filter(x => publicModelDisplayName(x) === authoritativePublic.displayName).length, 1, 'Ambiguous current model display mapping');
  const currentlyPublic = catalog.body.models.find(x => x.id === reviewed.publicId);
  if (currentlyPublic) assert.equal(currentlyPublic.displayName, publicModelDisplayName(row));
  const config = row.api_protocol_config || {};
  const input = getVideoInputContract(row);
  const timing = getVideoDurationCapabilities(row);
  const output = getVideoResolutionCapabilities(row);
  const caps = { supportsImageInput: row.supports_image_input === true, requiresImage: row.requires_image === true,
    requiresSourceVideo: input.requiresSourceVideo, requiresFirstFrame: input.requiresFirstFrame, requiresLastFrame: input.requiresLastFrame,
    minReferenceImages: input.minReferenceImages, maxReferenceImages: input.maxReferenceImages, minReferenceAudios: input.minReferenceAudios, maxReferenceAudios: input.maxReferenceAudios,
    workflowInputMode: input.mode, supportsPrompt: input.supportsPrompt, billingUnit: config.billing_unit === 'output_second' ? 'output_second' : 'per_use',
    minDuration: timing.minDuration, maxDuration: timing.maxDuration, defaultDuration: timing.defaultDuration, durationMode: timing.mode,
    resolutionOptions: output.options, resolutionPrices: Object.entries(output.publicPrices).map(([key, value]) => `${key}=${value}`), aspectRatios: config.aspect_ratios || ['16:9', '9:16'] };
  const model = { id: reviewed.publicId, displayName: publicModelDisplayName(row), publicPrice: Number(row.price_per_use) };
  const resolutions = Object.fromEntries((caps.resolutionPrices || []).map(x => { const [key, value] = x.split('='); return [key, Number(value)]; }));
  const resolution = requestedResolution || (caps.resolutionOptions || []).slice().sort((a,b) => (resolutions[a] ?? model.publicPrice) - (resolutions[b] ?? model.publicPrice))[0] || '';
  if (requestedResolution) assert.ok(caps.resolutionOptions.includes(requestedResolution), `${row.id}:FORCED_RESOLUTION_UNSUPPORTED`);
  // Fixed-price range models use their UI default duration; variable-price
  // hosted workflows use the declared minimum (official H3 supports 1–10 s).
  const duration = requestedDuration ?? (caps.billingUnit === 'output_second' ? Number(caps.minDuration) : Number(caps.defaultDuration || caps.minDuration));
  if (requestedDuration !== null) assert.ok(requestedDuration >= caps.minDuration && requestedDuration <= caps.maxDuration, `${row.id}:FORCED_DURATION_UNSUPPORTED`);
  const price = (resolutions[resolution] ?? model.publicPrice) * (caps.billingUnit === 'output_second' ? duration : 1);
  const internalRecovery = h?.productionBlocked && h?.recoveryCanaryEligible;
  const operatorControls = operatorRequested ? operatorRetestControls({ health: h, confirmation: health.body.recoveryPolicy?.confirmation, reason: operatorReason }) : null;
  return { publicId: model.id, internalId: row.id, requestModelId: row.id, currentlyPublic: !!currentlyPublic, executionSurface: 'admin-controlled-canary', displayName: model.displayName, upstreamModel: row.model_name, protocol: row.protocol_type, endpointHost: new URL(row.api_endpoint).host,
    configurationSha256: sha(JSON.stringify(canonical({ id: row.id, model: row.model_name, protocol: row.protocol_type, endpoint: row.api_endpoint, config: row.api_protocol_config }))),
    duration, resolution, aspectRatio: caps.aspectRatios?.includes('16:9') ? '16:9' : caps.aspectRatios?.[0] || '16:9', platformQuotedPrice: Number(price.toFixed(4)), adminPlatformCharge: 0,
    capabilities: caps, health: { present: !!h, state: h?.circuitState || 'unverified', canaryEligible: !!internalRecovery }, recoveryKey: operatorControls?.client_request_id || (internalRecovery ? h.recoveryKey : null) };
});
const expectedModelCount = reviewedCatalog.models.length;
const manifest = { ...(savedInventory || {}), at: new Date().toISOString(), origin, localDatabaseOnly: true, normalAdmin: true, concurrency, expectedModels: operatorRun ? 1 : expectedModelCount, actualModels: plans.length, currentPublicCount: savedInventory ? savedInventory.currentPublicCount : catalog.body.models.length, executionSurface: operatorRun ? 'admin-operator-retest' : 'admin-controlled-canary', scopeManifest: path.relative(out, catalogPath),
  catalogSurface: requestedSurface,
  platformQuotedTotal: Number(plans.reduce((sum, item) => sum + item.platformQuotedPrice, 0).toFixed(4)), supplierTotalCost: 'not-proven-by-platform-quotes', noInstanceCreation: true, credentialsPersisted: false,
  operatorRetest: operatorRun, operatorRetestReason: operatorReason, withReferenceImage: savedInventory?.withReferenceImage ?? withReferenceImage,
  publicSourceTask: savedInventory?.publicSourceTask || publicSourceTask || null,
  promptSource: promptFile ? path.relative(process.cwd(), path.resolve(promptFile)) : 'embedded-default',
  requestedResolution: requestedResolution || null,
  requestedDuration,
  promptSha256: sha(sharedVideoPrompt),
  imageAssetId: savedInventory?.imageAssetId || requestedImageAssetId,
  lastFrameAssetId: savedInventory?.lastFrameAssetId || requestedLastFrameAssetId,
  sourceVideoRecordId: savedInventory?.sourceVideoRecordId || publicSourceTask || 'vt_d48d0d0e2748a271dcc11d8a4e35ad91e8c91297', plans };
await fs.writeFile(path.join(out, `${mode}-inventory.json`), JSON.stringify(manifest, null, 2), mode === 'operator-retest' ? { flag: 'wx' } : undefined);
console.log(JSON.stringify({ phase: 'inventory', mode, modelCount: plans.length, platformQuotedTotal: manifest.platformQuotedTotal, unverified: plans.filter(x => !x.health.present).map(x => x.internalId), evidence: out }));
if (mode !== 'inspect') assert.ok(process.argv.includes(operatorRun ? '--confirm-operator-retest-authorized' : '--confirm-all-models-authorized'), 'Explicit authorization confirmation required for the saved scope');
assert.equal(plans.length, operatorRun ? 1 : expectedModelCount, 'Catalog changed: inspect and review the exact scope before dispatch');
const selected = selectedIds ? plans.filter(x => selectedIds.includes(x.internalId)) : plans;
if (selectedIds) assert.equal(selected.length, selectedIds.length, 'Selected ID not in the reviewed catalog');

let imageUrl = '';
let lastFrameUrl = '';
let sourceVideoUrl = '';
if (mode === 'execute' || mode === 'operator-retest' || mode === 'inspect') {
  const needsImage = selected.some(plan => ['multi_image', 'multi_image_audio'].includes(plan.capabilities.workflowInputMode) || plan.capabilities.requiresImage || plan.capabilities.requiresFirstFrame || plan.capabilities.requiresLastFrame) || withReferenceImage;
  const needsSource = selected.some(plan => plan.capabilities.requiresSourceVideo);
  assert.ok(!publicSourceTask || needsSource, 'Public source override requires a source-video model');
  assert.ok(!withReferenceImage || selected.every(plan => plan.capabilities.supportsImageInput || plan.capabilities.maxReferenceImages > 0), 'Selected model does not support the requested reference image');
  manifest.assets = {};
  if (needsImage) {
  const [image] = await rows('user_files', 'id,storage_key,storage_provider,content_type', { id: `eq.${manifest.imageAssetId}`, user_id: `eq.${userId}`, limit: '1' });
  assert.ok(image?.storage_key && image.content_type.startsWith('image/'), 'Completed owned yellow-cup image required');
  const signedImage = await api(`/api/file?key=${encodeURIComponent(image.storage_key)}`);
  assert.ok(signedImage.ok && signedImage.body?.url, 'Owned image signing failed'); imageUrl = signedImage.body.url;
  const assetRead = await fetch(`${origin}/api/storage/files/${image.id}/content`, { headers: { ...authHeaders, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(30000) });
  assert.ok(assetRead.ok && assetRead.headers.get('content-type')?.startsWith('image/'));
  await assetRead.body?.cancel();
  Object.assign(manifest.assets, { imageOwned: true, imageSignedHttps: new URL(imageUrl).protocol === 'https:', imageReadHttp: assetRead.status });
  }
  if (selected.some(plan => plan.capabilities.requiresLastFrame)) {
  const [lastFrame] = await rows('user_files', 'id,storage_key,storage_provider,content_type', { id: `eq.${manifest.lastFrameAssetId}`, user_id: `eq.${userId}`, limit: '1' });
  assert.ok(lastFrame?.storage_key && lastFrame.content_type.startsWith('image/'), 'A distinct owned last-frame image is required');
  const signedLastFrame = await api(`/api/file?key=${encodeURIComponent(lastFrame.storage_key)}`);
  assert.ok(signedLastFrame.ok && signedLastFrame.body?.url, 'Owned last-frame signing failed');
  lastFrameUrl = signedLastFrame.body.url;
  assert.notEqual(lastFrameUrl, imageUrl, 'First and last frame must be distinct owned images');
  const lastFrameRead = await fetch(`${origin}/api/storage/files/${lastFrame.id}/content`, { headers: { ...authHeaders, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(30000) });
  assert.ok(lastFrameRead.ok && lastFrameRead.headers.get('content-type')?.startsWith('image/'));
  await lastFrameRead.body?.cancel();
  Object.assign(manifest.assets, { lastFrameOwned: true, lastFrameSignedHttps: new URL(lastFrameUrl).protocol === 'https:', lastFrameReadHttp: lastFrameRead.status });
  }
  if (needsSource && publicSourceTask) {
    const [row] = await rows('video_tasks', 'id,user_id,model_id,status,provider_result_url,duration_seconds', { id: `eq.${publicSourceTask}`, user_id: `eq.${userId}`, limit: '1' });
    const publicUrl = ownedPublicSource({ row, userId, taskId: publicSourceTask });
    const probes = await probeOwnedPublicSource(publicUrl, fetch);
    sourceVideoUrl = publicUrl.toString();
    Object.assign(manifest.assets, { sourceVideoOwnedCompleted: true, sourceVideoMode: 'existing-public-provider-result', sourceVideoUrlSha256: sha(sourceVideoUrl), sourceVideoHost: publicUrl.hostname, sourceVideoDuration: row.duration_seconds, sourceVideoProbes: probes });
  } else if (needsSource) {
  const [video] = await rows('video_tasks', 'id,storage_url,status', { id: `eq.${manifest.sourceVideoRecordId}`, user_id: `eq.${userId}`, limit: '1' });
  assert.equal(video?.status, 'completed'); assert.ok(video.storage_url);
  const stableSource = parseAutodlH3AssetRef(video.storage_url);
  assert.ok(stableSource, 'Completed source video must use its stable owned object reference');
  const [videoFile] = await rows('user_files', 'id,storage_key,storage_provider,content_type', { storage_key: `eq.${stableSource.key}`, storage_provider: `eq.${stableSource.provider}`, user_id: `eq.${userId}`, limit: '1' });
  assert.ok(videoFile?.id && videoFile.content_type.startsWith('video/'), 'Source video ownership metadata required');
  const signedVideo = await api(`/api/file?key=${encodeURIComponent(videoFile.storage_key)}`);
  assert.ok(signedVideo.ok && signedVideo.body?.url, 'Owned source video signing failed'); sourceVideoUrl = signedVideo.body.url;
  const videoRead = await fetch(sourceVideoUrl, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(30000) });
  assert.ok(videoRead.ok && /video|octet-stream/.test(videoRead.headers.get('content-type') || ''), 'Signed source video not readable');
  await videoRead.body?.cancel();
  Object.assign(manifest.assets, { sourceVideoOwnedCompleted: true, sourceVideoMode: 'owned-signed-result', sourceVideoSignedHttps: new URL(sourceVideoUrl).protocol === 'https:', sourceVideoReadHttp: videoRead.status });
  }
  await fs.writeFile(path.join(out, `${mode}-inventory.json`), JSON.stringify(manifest, null, 2));
}
if (mode === 'inspect') { console.log(JSON.stringify({ phase: 'assets-ready', ...manifest.assets })); process.exit(0); }
let stopNewDispatches = false;
const outcomes = [];
async function routingReceipts(clientRequestId, plan) {
  const texts = [];
  for (const receiptPath of providerReceiptPaths) {
    try { texts.push(await fs.readFile(receiptPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return texts.join('\n').split(/\r?\n/).flatMap(line => {
    let row; try { row = JSON.parse(line); } catch { return []; }
    if (row.phase !== 'provider_dispatch' || row.clientRequestId !== clientRequestId) return [];
    const receipt = { modelId: row.modelId, protocol: row.protocol, submittedModel: row.submittedModel || null, submittedWorkflow: row.submittedWorkflow || null, endpointHost: row.endpointHost };
    receipt.selectedModelMatches = receipt.modelId === plan.internalId && receipt.protocol === plan.protocol;
    receipt.upstreamModelMatches = (receipt.submittedWorkflow || receipt.submittedModel) === plan.upstreamModel;
    receipt.endpointMatches = receipt.endpointHost === plan.endpointHost;
    return [receipt];
  });
}
async function work(plan) {
  const dir = path.join(out, plan.internalId.replace(/[^a-zA-Z0-9_-]/g, '_')); await fs.mkdir(dir, { recursive: true });
  const markerPath = path.join(dir, 'dispatch.json'); const resultPath = path.join(dir, 'result.json');
  if (mode !== 'reconcile') {
    try {
      await fs.access(markerPath);
      stopNewDispatches = true;
      const prior = JSON.parse(await fs.readFile(resultPath, 'utf8'));
      const outcome = { model: plan.internalId, state: 'existing-dispatch-use-reconcile', slotReserved: true, routingVerified: prior.routingVerified === true, report: path.relative(out, resultPath) };
      outcomes.push(outcome); console.log(JSON.stringify(outcome)); return true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let entry = { at: new Date().toISOString(), selectedModel: plan, posts: 0, polls: [], state: 'prepared' };
  const save = () => fs.writeFile(resultPath, JSON.stringify(entry, null, 2));
  const taskRows = () => rows('video_tasks', 'id,model_id,task_id_external,status,billing_state,billing_exempt,explicitly_free,price_charged,storage_url,video_url,provider_result_url,client_request_id,error_message,duration_seconds,resolution,created_at,completed_at', { user_id: `eq.${userId}`, client_request_id: `eq.${entry.clientRequestId}`, limit: '2' });
  try {
    if (mode === 'reconcile') {
      let marker;
      try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') { entry.state = 'not-previously-dispatched'; return; } throw error; }
      entry = { ...entry, ...JSON.parse(await fs.readFile(resultPath, 'utf8')), reconciliationAt: new Date().toISOString(), newPostsThisRun: 0, clientRequestId: marker.clientRequestId };
    } else {
      if (stopNewDispatches) { entry.state = 'not-dispatched-after-unresolved-task'; await save(); return; }
      try { await fs.access(markerPath); stopNewDispatches = true; throw new Error('EXISTING_DISPATCH_MARKER_USE_RECONCILE'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      entry.clientRequestId = plan.recoveryKey || `all-video-${randomUUID()}`;
      const c = plan.capabilities;
      const operatorControls = operatorRun ? operatorRetestControls({ health: healthMap.get(plan.internalId), confirmation: health.body.recoveryPolicy?.confirmation, reason: operatorReason, expectedKey: plan.recoveryKey }) : {};
      const payload = { model_id: plan.requestModelId, prompt: c.requiresSourceVideo ? 'Keep the existing scene and motion. Apply a subtle warm cinematic color grade. Do not add text.' : sharedVideoPrompt,
        duration: plan.duration, aspect_ratio: plan.aspectRatio, ...(plan.resolution ? { resolution: plan.resolution, resolution_tier: plan.resolution } : {}),
        surface: requestedSurface, task_label: `all-models-e2e:${runId}:${plan.internalId}`, batch_id: `all-models-e2e:${runId}`, client_request_id: entry.clientRequestId,
        ...(c.requiresFirstFrame || c.requiresImage || withReferenceImage
          ? { image_url: imageUrl }
          : c.workflowInputMode === 'multi_image' || c.workflowInputMode === 'multi_image_audio'
            ? { reference_image_urls: [imageUrl] }
            : {}),
        ...(c.requiresLastFrame ? { last_frame_url: lastFrameUrl } : {}), ...(c.requiresSourceVideo ? { source_video_url: sourceVideoUrl } : {}),
        ...(plan.recoveryKey ? { health_recovery_canary: true, health_recovery_key: plan.recoveryKey, health_recovery_confirmation: health.body.recoveryPolicy.confirmation } : {}),
        ...operatorControls,
      };
      assert.equal(Number(c.minReferenceAudios || 0), 0, 'Required audio needs explicitly prepared owned material');
      entry.requestFingerprint = sha(JSON.stringify(canonical(payload)));
      entry.input = { imageAssetId: payload.image_url || payload.reference_image_urls ? manifest.imageAssetId : null, lastFrameAssetId: payload.last_frame_url ? manifest.lastFrameAssetId : null, sourceVideoRecordId: payload.source_video_url ? manifest.sourceVideoRecordId : null, hasLastFrame: !!payload.last_frame_url };
      assert.equal((await taskRows()).length, 0, 'Existing business task requires reconcile only');
      if (operatorRun) {
        const freshHealth = await api('/api/video/channel-health');
        assert.ok(freshHealth.ok && Array.isArray(freshHealth.body?.channels), 'Unable to recheck current retest epoch');
        operatorRetestControls({ health: freshHealth.body.channels.find(channel => channel.channelId === plan.internalId), confirmation: freshHealth.body.recoveryPolicy?.confirmation, reason: operatorReason, expectedKey: entry.clientRequestId });
        assert.ok(freshHealth.body.recoveryPolicy.confirmation === payload.health_recovery_confirmation, 'Recovery policy changed after inspection');
      }
      if (stopNewDispatches) { entry.state = 'not-dispatched-after-unresolved-task'; await save(); return; }
      if (operatorRun) {
        // One local dispatch claim per user/model/health epoch across run IDs.
        // A transport failure never deletes this marker or obtains a new key.
        const claims = path.resolve('.codex-evidence/video-all-models-real-e2e-20260902/operator-retest-claims');
        await fs.mkdir(claims, { recursive: true });
        const claim = path.join(claims, `${sha(`${userId}:${plan.internalId}:${entry.clientRequestId}`)}.json`);
        try { await fs.writeFile(claim, JSON.stringify({ at: new Date().toISOString(), runId, clientRequestId: entry.clientRequestId, internalModelId: plan.internalId, requestFingerprint: entry.requestFingerprint, reason: operatorReason }), { flag: 'wx' }); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('OPERATOR_EPOCH_ALREADY_MARKED_USE_ORIGINAL_RUN_RECONCILE'); throw error; }
      }
      await fs.writeFile(markerPath, JSON.stringify({ at: new Date().toISOString(), clientRequestId: entry.clientRequestId, publicModelId: plan.publicId, internalModelId: plan.internalId, requestFingerprint: entry.requestFingerprint }), { flag: 'wx' });
      entry.state = 'dispatch-marked'; await save();
      let response;
      // There is no await between the final stop check and fetch invocation.
      // Another worker cannot disclose an unknown result during that interval.
      if (stopNewDispatches) { entry.state = 'dispatch-prevented-after-unresolved-task'; await save(); return; }
      entry.posts = 1; entry.state = 'dispatched';
      try { const submitted = api('/api/video/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': entry.clientRequestId, 'X-Request-ID': entry.clientRequestId }, body: JSON.stringify(payload), timeoutMs: 240000 }); await save(); response = await submitted; }
      catch (error) { entry.transportError = clean(error.message); }
      if (response) entry.submission = { http: response.status, taskId: response.body?.task_id || null, businessTaskId: response.body?.business_task_id || null, status: response.body?.status || null, returnedModelId: response.body?.model_id || null, returnedModelName: clean(response.body?.model_name), code: response.body?.error_code || response.body?.code || null, error: clean(response.body?.error), taskSubmitted: response.body?.task_submitted ?? null, replayed: response.body?.replayed === true };
      if (entry.submission?.returnedModelId) assert.equal(entry.submission.returnedModelId, plan.requestModelId);
      await save();
    }
    const started = Date.now();
    const maxWait = Number(argument('max-wait-ms')) || 20 * 60 * 1000;
    while (Date.now() - started < maxWait) {
      const existing = await taskRows(); assert.ok(existing.length <= 1, 'Duplicate business tasks');
      const row = existing[0];
      if (!row) {
        entry.state = entry.submission?.taskSubmitted === false ? 'blocked-before-dispatch' : 'unknown-no-business-record';
        break;
      }
      assert.equal(row.model_id, plan.internalId, 'Selected model differs from persisted business task');
      entry.business = { id: row.id, modelId: row.model_id, providerTaskId: row.task_id_external, status: row.status, billingState: row.billing_state, priceCharged: row.price_charged, hasOwnedStorage: !!row.storage_url, hasDeliverySource: !!(row.storage_url || row.video_url || row.provider_result_url), duration: row.duration_seconds, resolution: row.resolution, error: clean(row.error_message) };
      if (row.status === 'failed' || row.status === 'cancelled') { entry.state = row.status; break; }
      if (!row.task_id_external) { entry.state = 'unknown-provider-acknowledgement'; break; }
      const result = await api(`/api/video/status?${new URLSearchParams({ taskId: row.task_id_external, modelId: plan.publicId })}`, { timeoutMs: 90000 });
      const status = result.body?.status || 'unknown';
      const poll = { at: new Date().toISOString(), http: result.status, status, error: clean(result.body?.errorMessage || result.body?.error), code: result.body?.error_code || result.body?.code || null };
      if (!entry.polls.length || entry.polls.at(-1).status !== status || !result.ok) { entry.polls.push(poll); console.log(JSON.stringify({ model: plan.internalId, phase: 'poll', status, http: result.status })); }
      if (status === 'completed') {
        const finalRows = await taskRows(); const final = finalRows[0];
        assert.equal(final?.model_id, plan.internalId);
        if (final?.status !== 'completed') {
          entry.state = 'terminal-persistence-pending'; await save();
          await new Promise(resolve => setTimeout(resolve, 15000)); continue;
        }
        assert.ok(final.storage_url || final.video_url || final.provider_result_url, 'Completed task missing durable delivery source');
        const billingExempt = final.billing_exempt === true || final.explicitly_free === true;
        assert.ok(billingExempt ? ['not_required', 'legacy_h3_settled', 'settled'].includes(String(final.billing_state)) : String(final.billing_state) === 'settled', 'Completed task billing is not terminal');
        if (billingExempt) assert.equal(Number(final.price_charged), 0);
        else {
          const expectedCashCharge = Math.round((Number(plan.platformQuotedPrice) + Number.EPSILON) * 100) / 100;
          assert.ok(Math.abs(Number(final.price_charged) - expectedCashCharge) < 0.0001, 'Completed task charge differs from cent-rounded reviewed quote');
        }
        entry.business = { ...entry.business, status: final.status, billingState: final.billing_state, priceCharged: final.price_charged, hasOwnedStorage: !!final.storage_url, hasDeliverySource: true, deliveryMode: final.storage_url ? 'owned-storage' : 'authenticated-provider-proxy' };
        const mediaUrl = result.body?.storageUrl || result.body?.videoUrl;
        assert.ok(mediaUrl, 'Completed result missing delivery URL');
        const parsed = new URL(mediaUrl, origin); assert.ok(parsed.protocol === 'https:' || parsed.origin === origin);
        const media = await fetch(parsed, { headers: { ...(parsed.origin === origin ? authHeaders : {}), Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(30000) });
        const bytes = Buffer.from(await media.arrayBuffer());
        entry.media = { http: media.status, contentType: media.headers.get('content-type'), bytes: bytes.length, urlSha256: sha(mediaUrl), host: parsed.host };
        assert.ok(media.ok && bytes.length > 1024 && /video|octet-stream/.test(entry.media.contentType || ''));
        entry.state = 'completed'; break;
      }
      if (status === 'failed' || status === 'cancelled') {
        // Provider-facing status is not durable settlement. The next loop
        // must observe the same terminal state in the owned business row.
        entry.state = 'terminal-persistence-pending'; await save();
        await new Promise(resolve => setTimeout(resolve, 15000)); continue;
      }
      entry.state = 'processing'; await save();
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
    if (entry.state === 'processing' || entry.state === 'dispatched' || entry.state === 'terminal-persistence-pending') entry.state = 'unresolved-poll-window';
  } catch (error) {
    entry.failure = { name: error.name, message: clean(error.message) };
    entry.state = entry.business?.status === 'completed' ? 'delivery-verification-failed' : 'verification-failed';
  }
  finally {
    if (entry.clientRequestId) {
      entry.providerRequests = await routingReceipts(entry.clientRequestId, plan);
      entry.routingVerified = entry.providerRequests.length > 0 && entry.providerRequests.every(x => x.selectedModelMatches && x.upstreamModelMatches && x.endpointMatches);
      if (entry.providerRequests.some(x => !x.selectedModelMatches || !x.upstreamModelMatches || !x.endpointMatches)) { stopNewDispatches = true; entry.routingMismatch = true; }
    }
    entry.slotReserved = entry.posts > 0 && !['completed', 'failed', 'cancelled'].includes(entry.business?.status) && entry.state !== 'blocked-before-dispatch';
    entry.finishedAt = new Date().toISOString(); await save(); outcomes.push({ model: plan.internalId, state: entry.state, slotReserved: entry.slotReserved, routingVerified: entry.routingVerified || false, report: path.relative(out, resultPath) }); console.log(JSON.stringify(outcomes.at(-1)));
  }
  return entry.slotReserved;
}
let cursor = 0;
const queue = selected.slice().sort((a,b) => Number(!a.health.present) - Number(!b.health.present));
await Promise.all(Array.from({ length: concurrency }, async () => { while (cursor < queue.length) { const plan = queue[cursor++]; const slotReserved = await work(plan); if ((mode === 'execute' || mode === 'operator-retest') && slotReserved) break; } }));
await fs.writeFile(path.join(out, `${mode}-summary.json`), JSON.stringify({ at: new Date().toISOString(), modelCount: plans.length, selectedCount: selected.length, stopNewDispatches, notDispatchedWhileSlotsReserved: queue.slice(cursor).map(plan => plan.internalId), outcomes }, null, 2));
