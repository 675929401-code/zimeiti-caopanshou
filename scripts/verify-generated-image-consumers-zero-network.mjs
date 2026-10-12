import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import sharp from 'sharp';
assert.equal(process.version, 'v24.19.0');
function load(file, deps = {}, extra = '', globals = {}) {
  const source = readFileSync(file, 'utf8');
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(match => match[1]);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source + extra, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Buffer, URL, Request, Response, Headers, Blob, AbortSignal, structuredClone, console, setTimeout, clearTimeout, crypto: crypto.webcrypto, atob,
      require: name => { if (name in deps) return deps[name]; if (imports.includes(name)) return {}; throw Error('Unmocked dependency: ' + name); }, ...globals });
  return module.exports;
}
const refs = load('src/lib/generated-image-reference.ts', { zod: { z } });
const client = load('src/lib/generated-image-client-delivery.ts', { '@/lib/generated-image-reference': refs });
const readiness = load('src/lib/image-generation-readiness.ts');
const input = load('src/lib/image-generation-request.ts', {}, '\nexports.testNormalize = value => normalizeImageGenerationInput(JSON.parse(JSON.stringify(value)));');
assert.equal(input.testNormalize({ prompt: 'test', deliveryRequirement: 'recoverable_reference' }).deliveryRequirement, 'recoverable_reference');
assert.throws(() => input.testNormalize({ prompt: 'test', deliveryRequirement: 'inline' }), error => error.code === 'IMAGE_DELIVERY_REQUIREMENT_INVALID');
const capability = (protocol, options = {}) => readiness.imageRecoverableReferenceCapability({ contract: { requestProtocol: protocol, source: 'configured', referenceTransport: 'none', ...options.contract }, referenceCount: options.references || 0, boundH3: false, volcengine: options.volcengine || false });
assert.equal(capability('google_generate_content', { volcengine: true }), 'inline_only');
assert.equal(capability('chat_completions', { volcengine: true }), 'unknown');
assert.equal(capability('images_generations_async'), 'unknown');
assert.equal(capability('images_generations'), 'url_requested');
assert.equal(capability('images_edits'), 'unknown');
assert.equal(capability('images_edits', { references: 1, contract: { referenceTransport: 'edits_multipart_single' } }), 'url_requested');
assert.equal(capability('images_generations', { references: 1, contract: { referenceTransport: 'none' } }), 'unknown');
const recordId = 'a'.repeat(64);
const png = await sharp({ create: { width: 32, height: 18, channels: 3, background: 'red' } }).png().toBuffer();
const ephemeral = load('src/lib/image-ephemeral-delivery.ts', { 'node:crypto': crypto });
const pair = ephemeral.createImageEphemeralDelivery({ recordId, buffer: png, contentType: 'image/png', width: 32, height: 18, selectedModelId: 'fixture', selectedCostPrice: 0.5 });
const ownedRecord = { recordId, clientIdempotencyKey: 'fixture_key', state: 'completed', deliveryState: 'delivered', response: { ...pair.receipt, cashCharged: 0.5 }, requestSnapshot: {} };
const failureHistory = load('src/lib/image-failure-history.ts', { 'node:crypto': crypto });
let reads = 0, compositions = 0;
const cover = load('src/lib/cover-generated-delivery.ts', { 'node:crypto': crypto, '@/lib/image-ephemeral-delivery': ephemeral,
  '@/lib/image-failure-history': failureHistory,
  '@/lib/server/generated-image-reference': { readGeneratedImageMaterial: async ({ userId, reference }) => { assert.equal(userId, 'owner'); assert.equal(reference.recordId, recordId); reads++; return { buffer: png }; } },
  '@/lib/cover-composition-server': { renderCoverComposition: async bytes => { assert.deepEqual(bytes, png); compositions++; return { bytes: png, width: 32, height: 18 }; } } });
const first = { success: true, status: 'completed', recordId, cashCharged: 0.5, deliveryMode: 'inline_ephemeral', images: [{ recordId, deliveryMode: 'inline_ephemeral', url: pair.transientDelivery.dataUrl }] };
const composed = await cover.composeGeneratedCover({ userId: 'owner', record: ownedRecord, response: first, plan: {} });
assert.equal(composed.generationCompleted, true); assert.equal(composed.cashCharged, 0.5); assert.equal(compositions, 1); assert.equal(reads, 0);
await assert.rejects(cover.composeGeneratedCover({ userId: 'owner', record: ownedRecord, response: { ...first, recordId: 'b'.repeat(64) }, plan: {} }));
assert.equal(cover.coverGeneratedReceipt({ ...ownedRecord, state: 'failed_unknown' }), null);
assert.equal(cover.coverGeneratedReceipt({ ...ownedRecord, response: { deliveryMode: 'provider_url', cashCharged: 0.5, sourceExpiredAt: '2026-10-12' } }).cashCharged, 0.5);
assert.equal(cover.coverGeneratedReceipt({ ...ownedRecord, response: { ...ownedRecord.response, cashCharged: NaN } }), null);
await cover.composeGeneratedCover({ userId: 'owner', record: { ...ownedRecord, response: { deliveryMode: 'provider_url', cashCharged: 0.5 } }, response: { recordId }, plan: {} });
assert.equal(reads, 1);
const task = { id: 'fixture-task', ratio: '16:9', title: '标题', subtitle: '', prompt: 'Draw label data: value ' + 'A long valid English prompt. '.repeat(100), source: '生成', createdAt: new Date().toISOString(), taskNo: 1, status: 'done', url: 'blob:https://fixture.invalid/a', imageDeliveryReceipt: client.projectGeneratedImageClientReceipt(composed), unknown: { bytes: [1, 2, 3] }, transientDelivery: { base64: 'fixture' } };
const attempts = load('src/lib/cover-generation-attempt.ts', { '@/lib/generated-image-client-delivery': client }, '\nexports.persistedCoverReceipt = persistedCoverReceipt;');
const map = new Map(), storage = { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value) };
attempts.saveCoverEphemeralReceipt(storage, 'owner', task);
const saved = [...map.values()][0]; assert.equal(saved.includes('blob:'), false); assert.equal(saved.includes('base64'), false); assert.equal(saved.includes('unknown'), false);
const restored = attempts.readCoverGenerationState(storage, 'owner').history[0];
assert.equal(restored.imageDeliveryReceipt.recordId, recordId); assert.equal(restored.billing.chargedAmount, 0.5); assert.equal(restored.status, 'done'); assert.equal(restored.url, undefined); assert.equal(restored.prompt, task.prompt);
let settled = 0, updated, videoBody, jobsCreated = 0, storageCalls = 0, verified = 0, ledgerReference, selectedId = '', legacyAssets = [];
class ProductionError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const imageJob = { id: 'image-job', publicJobId: 'image-public', stage: 'image_generation', state: 'result_staging', shotId: 'shot', createdAt: '2026-10-12T00:00:00Z', requestPayload: {}, billingSnapshot: {}, resultPayload: {} };
const repository = { createSettlement: async value => { settled++; ledgerReference = value.ledgerReference; }, updateJob: async (_user, _project, _id, patch) => { updated = { ...imageJob, ...patch }; return updated; },
  assertProductionMigrationReady: async () => {}, getShot: async () => ({ id: 'shot', videoPrompt: 'animate', negativePrompt: '', metadata: selectedId ? { selectedImageAssetId: selectedId } : {}, aspectRatio: '16:9', sequence: 1, title: 'shot' }),
  findLatestShotAsset: async () => legacyAssets.at(-1) || null, listProduction: async () => ({ jobs: [{ ...updated, createdAt: imageJob.createdAt }], assets: legacyAssets, shots: [] }),
  getOrCreatePromptSnapshot: async () => 'prompt', createJob: async (_user, value) => { jobsCreated++; assert.equal(JSON.stringify(value.requestPayload).includes('https://'), false); return { replayed: false, job: { ...imageJob, id: 'video-job', stage: 'video_generation', requestPayload: value.requestPayload } }; },
  updateShotStatus: async () => {} };
class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const production = load('src/lib/short-drama/production-service.ts', {
  'node:crypto': crypto, 'next/server': { NextRequest }, '@/lib/generated-image-reference': refs, '@/lib/generated-image-client-delivery': client,
  '@/lib/server/generated-image-reference': { validateOwnedGeneratedImageReference: async ({ userId, reference }) => { assert.equal(userId, 'owner'); assert.equal(reference.recordId, recordId); verified++; }, resolveGeneratedImageReference: async ({ userId, reference }) => { assert.equal(userId, 'owner'); assert.equal(reference.recordId, recordId); verified++; return 'https://fixture.invalid/image?sig=current'; } },
  './production-repository': { ShortDramaProductionError: ProductionError, ShortDramaProductionRepository: { fromAuth: () => repository } },
  './repository': { ShortDramaProjectRepository: class { async getProject() { return { status: 'draft' }; } } },
  './idempotency': { hashShortDramaRequest: value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') },
  '@/storage/object': { storageManager: { getSignedUrl: key => { storageCalls++; assert.equal(key, 'owned-A'); return 'https://fixture.invalid/explicit-owned-A'; } } },
  '@/app/api/video/generate/route': { POST: async request => { videoBody = await request.json(); return Response.json({ task_id: 'task', status: 'pending' }); } },
}, '\nexports.imageGenerationSnapshot = imageGenerationSnapshot; exports.completeReferencedImageJob = completeReferencedImageJob;');
const inlineSnapshot = production.imageGenerationSnapshot({ ...first, unknown: { bytes: [1, 2, 3] } });
assert.equal(inlineSnapshot.images.length, 0); assert.equal(inlineSnapshot.blockedOnInput, true); assert.equal(JSON.stringify(inlineSnapshot).includes('data:image'), false);
let sourceExpired = false, ownedImageExists = true;
const auth = { userId: 'owner', db: { from: name => { assert.equal(name, 'image_generation_requests'); const conditions = {}; const q = { select: () => q, eq: (key, value) => { conditions[key] = value; return q; }, maybeSingle: async () => { verified++; return { data: ownedImageExists && conditions.user_id === 'owner' && conditions.record_id === recordId ? { state: 'completed', delivery_state: 'delivered', response: { deliveryMode: 'provider_url', ...(sourceExpired ? { sourceExpiredAt: '2026-10-12' } : {}) } } : null }; } }; return q; } } };
const inlineDone = await production.completeReferencedImageJob({ auth, projectId: 'project', job: { ...imageJob, resultPayload: { generation: inlineSnapshot } }, repository });
assert.equal(inlineDone.body.job.state, 'succeeded'); assert.equal(inlineDone.body.blockedOnInput, true); assert.equal(inlineDone.body.assets.length, 0); assert.equal(settled, 1);
const imageRouteSource = readFileSync('src/app/api/image/generate/route.ts', 'utf8');
const httpStart = imageRouteSource.indexOf('    return NextResponse.json({', imageRouteSource.indexOf('    let currentCashRemaining: number | null'));
const httpEnd = imageRouteSource.indexOf('    }, { headers: { "Cache-Control": "private, no-store" } });', httpStart) + '    }, { headers: { "Cache-Control": "private, no-store" } });'.length;
assert.ok(httpStart > 0 && httpEnd > httpStart);
const h3OperationId = `h3_${crypto.createHash('sha256').update('owner:fixture-key').digest('hex').slice(0, 48)}`;
const billingReferenceId = `image:${h3OperationId}`;
const httpContext = { NextResponse: { json: value => value }, traceId: 'fixture-trace', h3OperationId, billingReferenceId,
  imageUrl: 'https://fixture.invalid/image?sig=current', delivery: {}, directProviderUrl: true, exactResult: { record: { recordId } }, ratio: '16:9', width: 32, height: 18,
  verifiedDimensions: { width: 32, height: 18 }, autodlH3StoredObjectKey: '', userVisibleModelLabel: 'Fixture', modelId: 'pm_fixture', effectiveResolution: '1K', outputPixelSize: '32x18', IMAGE_FIXED_OUTPUT_COUNT: 1,
  providerProtocol: 'images_generations', generationFingerprint: 'f'.repeat(64), idempotencyReplayed: false, sellingPrice: 0.5, currentCashRemaining: null };
const providerHTTP = runInNewContext('(function(){' + ts.transpileModule(imageRouteSource.slice(httpStart, httpEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '})()', httpContext);
const gateStart = imageRouteSource.indexOf('    if (!resumeDeliveryOnly && deliveryRequirement === "recoverable_reference")');
const gateEnd = imageRouteSource.indexOf('    if (!resumeDeliveryOnly && effectiveMode', gateStart + 1);
const gate = runInNewContext('(function(candidates){' + ts.transpileModule(imageRouteSource.slice(gateStart, gateEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + 'return null;})', {
  resumeDeliveryOnly: false, deliveryRequirement: 'recoverable_reference', effectiveMode: 'local', references: [],
  assertAutodlH3SelfhostModelBinding: () => false, resolveImageProviderContract: candidate => candidate.contract,
  imageRecoverableReferenceCapability: readiness.imageRecoverableReferenceCapability, imageParameterRejection: (_message, code) => ({ code }),
  fetch: () => { throw Error('Provider fetch before admission forbidden'); } });
const urlCandidate = { provider: 'fixture', contract: { requestProtocol: 'images_generations', source: 'configured' } };
assert.equal(gate([urlCandidate]), null);
for (const protocol of ['google_generate_content', 'chat_completions', 'images_generations_async']) {
  assert.equal(gate([urlCandidate, { provider: 'volcengine', contract: { requestProtocol: protocol, source: 'configured' } }]).code, 'IMAGE_RECOVERABLE_REFERENCE_UNSUPPORTED');
}
const exactlyOnce = load('src/lib/image-exactly-once.ts', { 'node:crypto': crypto });
assert.notEqual(exactlyOnce.strictImagePayloadFingerprint({ prompt: 'same' }), exactlyOnce.strictImagePayloadFingerprint({ prompt: 'same', deliveryRequirement: 'recoverable_reference' }));
const providerSnapshot = production.imageGenerationSnapshot(providerHTTP);
assert.equal(JSON.stringify(providerSnapshot).includes('https://'), false);
await production.completeReferencedImageJob({ auth, projectId: 'project', job: { ...imageJob, resultPayload: { generation: providerSnapshot } }, repository });
assert.equal(updated.resultPayload.generatedImageReference.recordId, recordId); assert.equal(updated.resultPayload.blockedOnInput, undefined);
assert.equal(ledgerReference, billingReferenceId);
await production.generateProductionVideo({ auth, projectId: 'project', request: new NextRequest('https://fixture.invalid/api', { headers: { authorization: 'Bearer synthetic-fixture' } }), body: { action: 'generate_video', shotId: 'shot', modelId: 'video', duration: 5, clientRequestId: 'fixture-key' } });
assert.equal(videoBody.image_ref.recordId, recordId); assert.equal(videoBody.image_url, undefined); assert.equal(videoBody.image_storage_key, undefined); assert.equal(jobsCreated, 1); assert.equal(storageCalls, 0); assert.equal(verified, 2);
sourceExpired = true;
const expiredDone = await production.completeReferencedImageJob({ auth, projectId: 'project', job: { ...imageJob, resultPayload: { generation: providerSnapshot } }, repository });
assert.equal(expiredDone.body.job.state, 'succeeded'); assert.equal(expiredDone.body.blockedOnInput, true); assert.equal(expiredDone.body.job.billingSnapshot.actualCashCharged, 0.5);
await assert.rejects(production.generateProductionVideo({ auth, projectId: 'project', request: new NextRequest('https://fixture.invalid/api'), body: { action: 'generate_video', shotId: 'shot', modelId: 'video', duration: 5, clientRequestId: 'blocked-key' } }), error => error.code === 'VIDEO_REFERENCE_NOT_RECOVERABLE');
assert.equal(jobsCreated, 1);
ownedImageExists = false;
await assert.rejects(production.completeReferencedImageJob({ auth, projectId: 'project', job: { ...imageJob, resultPayload: { generation: providerSnapshot } }, repository }), error => error.code === 'GENERATED_IMAGE_NOT_OWNED');
legacyAssets = ['A', 'B'].map(id => ({ id, shotId: 'shot', assetRole: 'image', provider: 'tencent_cos', objectKey: 'owned-' + id, createdAt: '2026-10-11' })); selectedId = 'A';
const videoRequest = () => ({ auth, projectId: 'project', request: new NextRequest('https://fixture.invalid/api', { headers: { authorization: 'Bearer synthetic-fixture' } }), body: { action: 'generate_video', shotId: 'shot', modelId: 'video', duration: 5, clientRequestId: 'selected-key' } });
await production.generateProductionVideo(videoRequest()); assert.equal(videoBody.image_storage_key, 'owned-A'); assert.equal(videoBody.image_ref, undefined); assert.equal(storageCalls, 1);
selectedId = 'missing'; const jobsBeforeMissing = jobsCreated;
await assert.rejects(production.generateProductionVideo(videoRequest()), error => error.code === 'VIDEO_SELECTED_REFERENCE_NOT_AVAILABLE'); assert.equal(jobsCreated, jobsBeforeMissing); assert.equal(storageCalls, 1);
const composition = load('src/lib/cover-composition.ts');
const durable = load('src/lib/cover-durable-attempt.ts', { '@/lib/cover-composition': composition });
const plan = { title: '标题', subtitle: '', aspectRatio: '16:9', layoutTemplateId: 'gaoding-fixture', animationStyleId: 'pet-3d' };
const renderer = load('src/lib/cover-composition-server.ts', { 'node:fs': { existsSync }, sharp: { default: sharp } });
const renderingSource = await sharp({ create: { width: 640, height: 360, channels: 3, background: 'red' } }).png().toBuffer();
const rendered = await renderer.renderCoverComposition(renderingSource, plan);
assert.equal((await sharp(rendered.bytes).metadata()).width, 640); assert.equal(rendered.height, 360);
const safe = { prompt: task.prompt, modelId: 'pm_fixture', mode: 'local', style: '', aspectRatio: '16:9', resolution: '1K', coverText: '', referenceImageUrls: [], referenceUsage: 'general', historySurface: 'cover-studio' };
let attemptRow = { id: 'attempt', user_id: 'owner', surface: 'cover-studio', client_idempotency_key: 'fixture_key', client_trace_id: 'fixture_trace', state: 'failed', task: { ...task, renderPlan: plan }, generation_input: safe, requires_reference_reupload: false, created_at: task.createdAt, updated_at: task.createdAt, error_code: cover.COVER_TEMPORARY_DELIVERY_CODE };
let imageBinding = true, modelCalls = 0, renderCalls = 0, acquire = false, loseSettleAck = false, duringGeneration = null;
const db = { from: () => { const conditions = {}; const q = { select: () => q, eq: (key, value) => { conditions[key] = value; return q; }, maybeSingle: async () => ({ data: conditions.user_id === attemptRow.user_id && conditions.client_idempotency_key === attemptRow.client_idempotency_key && conditions.client_trace_id === attemptRow.client_trace_id ? attemptRow : null }) }; return q; },
  rpc: async (name, args) => {
    assert.ok(['reconcile_stale_cover_generation_attempts', 'begin_cover_generation_dispatch', 'settle_cover_generation_attempt'].includes(name));
    if (name === 'settle_cover_generation_attempt') { if (!['failed', 'cancelled', 'completed'].includes(attemptRow.state)) attemptRow = { ...attemptRow, state: args.p_state, error_code: args.p_error_code }; if (loseSettleAck) { loseSettleAck = false; return { error: Error('Synthetic acknowledgement lost after commit') }; } }
    const acquired = name === 'begin_cover_generation_dispatch' && acquire; if (acquired) { acquire = false; attemptRow = { ...attemptRow, state: 'dispatched' }; }
    return { data: { acquired, record: attemptRow }, error: null };
  } };
const route = load('src/app/api/cover/attempt/route.ts', { 'node:crypto': crypto, 'next/server': { NextRequest, NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/lib/current-api-user': { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: 'owner' } }) }, '@/storage/database/supabase-client': { getSupabaseClient: () => db },
  '@/lib/cover-durable-attempt': durable, '@/lib/cover-generated-delivery': cover,
  '@/lib/image-exactly-once': { DatabaseImageExactlyOnceStore: class { async get(keys) { return imageBinding && keys.userId === 'owner' && keys.clientIdempotencyKey === 'fixture_key' && keys.clientTraceId === 'fixture_trace' ? ownedRecord : null; } } },
  '@/app/api/image/generate/route': { POST: async () => { modelCalls++; await duringGeneration?.(); return Response.json(first); } },
  '@/app/api/cover/render/route': { POST: () => { renderCalls++; throw Error('Automatic persisted render forbidden'); } }, });
const getRequest = () => new NextRequest('https://fixture.invalid/api/cover/attempt?clientIdempotencyKey=fixture_key&clientTraceId=fixture_trace');
const dispatchRequest = () => new NextRequest('https://fixture.invalid/api/cover/attempt', { method: 'POST', body: JSON.stringify({ action: 'dispatch', clientIdempotencyKey: 'fixture_key', clientTraceId: 'fixture_trace', payload: safe }) });
assert.equal((await (await route.GET(getRequest())).json()).generationCompleted, true);
assert.equal((await (await route.POST(dispatchRequest())).json()).generationCompleted, true);
imageBinding = false;
assert.equal((await (await route.GET(getRequest())).json()).generationCompleted, undefined);
assert.equal((await (await route.POST(dispatchRequest())).json()).generationCompleted, undefined);
imageBinding = true; attemptRow = { ...attemptRow, error_code: 'OTHER_FAILED' };
assert.equal((await (await route.GET(getRequest())).json()).generationCompleted, undefined);
assert.equal((await (await route.POST(dispatchRequest())).json()).generationCompleted, undefined);
assert.equal(modelCalls, 0); assert.equal(renderCalls, 0);
attemptRow = { ...attemptRow, state: 'claimed', error_code: null }; acquire = true; loseSettleAck = true;
const compositionsBefore = compositions;
const paidOnce = await (await route.POST(dispatchRequest())).json();
assert.equal(paidOnce.generationCompleted, true); assert.equal(paidOnce.mediaAvailable, true); assert.equal(modelCalls, 1); assert.equal(compositions, compositionsBefore + 1);
assert.equal((await (await route.GET(getRequest())).json()).generationCompleted, true);
const replay = await (await route.POST(dispatchRequest())).json(); assert.equal(replay.generationCompleted, true); assert.equal(replay.images.length, 0);
assert.equal(modelCalls, 1); assert.equal(renderCalls, 0); assert.equal(compositions, compositionsBefore + 1);
attemptRow = { ...attemptRow, state: 'claimed', error_code: null }; acquire = true;
duringGeneration = async () => { assert.equal((await (await route.GET(getRequest())).json()).generationCompleted, true); assert.equal(attemptRow.state, 'failed'); attemptRow.error_code = cover.COVER_TEMPORARY_COMPOSITION_ERROR; };
const interleaved = await (await route.POST(dispatchRequest())).json();
assert.equal(interleaved.generationCompleted, true); assert.equal(interleaved.mediaAvailable, true); assert.equal(interleaved.images.length, 1);
assert.equal(attemptRow.error_code, cover.COVER_TEMPORARY_COMPOSITION_ERROR); assert.equal(modelCalls, 2); assert.equal(compositions, compositionsBefore + 2); assert.equal(renderCalls, 0);
const historySource = readFileSync('src/app/api/cover/history/route.ts', 'utf8');
const historySlice = historySource.slice(historySource.indexOf('  const temporaryReceipts = [];'), historySource.indexOf('  const recordCandidates ='));
const historyContext = { ...durable, ...cover, userId: 'owner', attemptsLoaded: { data: [attemptRow, { ...attemptRow, user_id: 'other' }, { ...attemptRow, client_trace_id: 'wrong_trace' }, { ...attemptRow, error_code: 'OTHER_FAILED' }] },
  DatabaseImageExactlyOnceStore: class { async get(keys) { return keys.userId === 'owner' && keys.clientTraceId === 'fixture_trace' ? ownedRecord : null; } } };
const historyReceipts = await runInNewContext('(async function(){' + ts.transpileModule(historySlice, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + 'return temporaryReceipts;})()', historyContext);
assert.equal(historyReceipts.length, 1); assert.equal(historyReceipts[0].imageDeliveryReceipt.recordId, recordId);
assert.equal(JSON.stringify(historyReceipts).includes('blob:'), false); assert.equal(JSON.stringify(historyReceipts).includes('base64'), false); assert.equal('unknown' in historyReceipts[0], false);
console.log(JSON.stringify({ passed: true, layer: 'actual-functions-mocked-dependencies-zero-network', checks: ['purpose-enum-and-fingerprint', 'actual-fallback-gate-protocol-priority', 'actual-provider-HTTP-billing-reference', 'actual-sharp-RAM-composition', 'cover-inline-composition-once', 'cover-provider-owned-RAM', 'cover-GET-POST-owner-binding-negatives', 'cover-history-strict-owner-key-trace-projection', 'cover-settle-ACK-loss-replay-no-resubmit', 'cover-finalization-GET-originalPOST-interleave', 'expired-source-preserves-fee-receipt', 'receipt-projection-reload', 'long-prompt-preserved', 'short-drama-inline-blocked-receipt', 'short-drama-owned-ref-to-video', 'selected-legacy-A-latest-B-exact-input', 'missing-selected-take-beforecost', 'no-implicit-COS'], syntheticImagePOSTs: modelCalls, realProviderCalls: 0, realDatabaseWrites: 0 }));
