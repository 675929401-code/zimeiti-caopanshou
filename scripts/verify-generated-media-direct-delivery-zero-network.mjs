import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import sharp from 'sharp';

assert.equal(process.version, 'v24.19.0', 'Use the pinned runtime');
function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  const result = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal((result.diagnostics || []).filter(x => x.category === ts.DiagnosticCategory.Error).length, 0, file);
  runInNewContext(result.outputText, { module, exports: module.exports, Buffer, URL, Date, setTimeout, clearTimeout,
    structuredClone, console, process: { env: {} }, require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw Error(`Unmocked dependency: ${name}`);
    }, ...globals });
  return module.exports;
}
const delivery = load('src/lib/generated-media-delivery.ts');
assert.equal(delivery.providerMediaUrl('data:image/png;base64,AA=='), null);
const credentialFixture = new URL('https://example.invalid/image');
credentialFixture.username = 'fixture-user'; credentialFixture.password = 'fixture-not-a-secret';
assert.equal(delivery.providerMediaUrl(credentialFixture.href), null);
assert.equal(delivery.providerMediaUrl('https://example.invalid/image?expires=1'), 'https://example.invalid/image?expires=1');
let cancelled = false;
await assert.rejects(delivery.readMediaStreamWithDeadline({ read: () => new Promise(() => {}), cancel: async () => { cancelled = true; } }, 5), /暂时没有回应/);
assert.equal(cancelled, true);
const retention = load('src/lib/media-history-contract.ts');
for (const kind of ['image', 'video']) {
  assert.equal(retention.resolveMediaHistoryRetention({ kind, status: 'completed', createdAt: '2020-01-01', upstreamExpiresAt: '2020-01-02' }).expired, false);
  assert.equal(retention.resolveMediaHistoryRetention({ kind, status: 'completed', createdAt: '2020-01-01', sourceExpiredAt: '2020-01-02' }).expired, true);
  assert.equal(retention.resolveMediaHistoryRetention({ kind, status: 'completed', createdAt: '2020-01-01' }).expired, false);
}
const rejection = load('src/lib/image-request-rejection.ts');
const ephemeral = load('src/lib/image-ephemeral-delivery.ts', { 'node:crypto': crypto });
const audit = load('src/lib/image-provider-request-audit.ts', { 'node:crypto': crypto }, { Request, TextDecoder });
let boundDatabase;
const exact = load('src/lib/image-exactly-once.ts', {
  'node:crypto': crypto, 'node:path': path,
  'node:fs/promises': new Proxy({}, { get() { return () => { throw Error('Filesystem effects forbidden'); }; } }),
  '@/storage/database/supabase-client': { getSupabaseAdminClient() { if (!boundDatabase) throw Error('Database effects forbidden'); return boundDatabase; } },
  '@/lib/runtime-paths': { resolveAppRuntimeDir() { throw Error('Runtime writes forbidden'); } },
  '@/lib/image-request-rejection': rejection,
  '@/lib/image-provider-request-audit': audit,
  '@/lib/image-ephemeral-delivery': ephemeral,
});
const providerResult = rawUrl => ({ schema: 'image_provider_result.v1', ...(rawUrl.startsWith('data:') ? { kind: 'inline', inlineDataUrl: rawUrl } : { kind: 'url', rawUrl }), selectedModelId: 'fixture-model', selectedCostPrice: 0.1,
  mode: 'local', provider: 'fixture', apiEndpoint: 'https://provider.invalid/v1/images/generations', source: 'fixture' });
function fixture(rawUrl) {
  const store = new exact.MemoryImageExactlyOnceStore(); let submissions = 0, inspections = 0;
  const input = { store, userId: 'fixture-user', clientIdempotencyKey: 'fixture-client-key', clientTraceId: 'fixture-trace-key', payloadFingerprint: 'a'.repeat(64),
    billingReferenceId: 'image:fixture-reservation', requestSnapshot: { quotedPriceYuan: 0.2, billingExempt: false },
    rejectionBilling: { referenceId: 'image:fixture-reservation', amount: 0.2 },
    submitOnce: async context => {
      submissions++;
      const prepared = await audit.prepareImageProviderRequest({ url: 'https://provider.invalid/v1/images/generations',
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, providerProtocol: 'images_generations',
        projection: { userPromptSha256: 'a'.repeat(64), effectivePromptSha256: 'a'.repeat(64), modelIdSha256: 'b'.repeat(64), aspectRatio: '1:1', resolution: '1K', imageCount: 1, referenceCount: 0 } });
      await context.recordProviderDispatchReceipt(prepared.receipt);
      await context.recordProviderSubmissionReceipt(audit.createImageProviderSubmissionReceipt({ dispatchReceipt: prepared.receipt, transportState: 'response_received', responseStatus: 200, responseBody: Buffer.from('{}') }));
      return providerResult(rawUrl);
    },
    persistProviderResult: async result => { inspections++; return { deliveryMode: 'provider_url', providerUrl: result.rawUrl }; },
  };
  return { input, store, counts: () => ({ submissions, inspections }) };
}
const direct = fixture('https://provider.invalid/image.png');
const first = await exact.runImageExactlyOnce(direct.input);
assert.equal(first.response.deliveryMode, 'provider_url');
const replay = await exact.runImageExactlyOnce(direct.input);
assert.equal(replay.replayed, true);
assert.equal(direct.counts().submissions, 1);
assert.equal(direct.counts().inspections, 1);
const unknown = fixture('https://provider.invalid/image.png');
unknown.input.persistProviderResult = async () => { throw Error('temporary DNS failure'); };
await assert.rejects(exact.runImageExactlyOnce(unknown.input));
assert.equal(exact.hasImageProviderCheckpoint(await unknown.store.get(unknown.input)), true);
unknown.input.persistProviderResult = async result => ({ deliveryMode: 'provider_url', providerUrl: result.rawUrl });
await exact.runImageExactlyOnce(unknown.input);
assert.equal(unknown.counts().submissions, 1);
// Exercise the actual route callback, rather than a mirror of its implementation.
const routeFile = 'src/app/api/image/generate/route.ts';
const routeText = readFileSync(routeFile, 'utf8');
const routeAst = ts.createSourceFile(routeFile, routeText, ts.ScriptTarget.Latest, true);
let callbackText, inlineCallbackText, prepareBytesText;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(routeAst) === 'persistProviderResult') callbackText = node.initializer.getText(routeAst);
  if (ts.isPropertyAssignment(node) && node.name.getText(routeAst) === 'prepareEphemeralResult') inlineCallbackText = node.initializer.getText(routeAst);
  if (ts.isFunctionDeclaration(node) && node.name?.getText(routeAst) === 'prepareGeneratedImageBytes') prepareBytesText = node.getText(routeAst);
  ts.forEachChild(node, visit);
}
visit(routeAst); assert.ok(callbackText && inlineCallbackText && prepareBytesText);
let downloads = 0;
const callbackModule = { exports: {} };
runInNewContext(ts.transpileModule(`module.exports = (${callbackText});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
  module: callbackModule, providerMediaUrl: delivery.providerMediaUrl, effectiveMode: 'local', resumeSnapshot: null,
  candidates: [{ id: 'fixture-model', provider: 'fixture', api_endpoint: 'https://provider.invalid/v1/images/generations' }],
  workflowConfig: {}, ImageExactlyOnceError: exact.ImageExactlyOnceError, ImageRequestRejectedError: exact.ImageRequestRejectedError,
  AUTODL_H3_SELFHOST_PROVIDER: 'autodl_h3_selfhost', AUTODL_H3_IMAGE_MAX_BYTES: 1024, AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS: 1000,
  AUTODL_H3_IMAGE_CONTENT_TYPES: ['image/png'], TRUSTED_GENERATED_IMAGE_HOSTS: [], ratio: '1:1', effectiveResolution: '1K',
  safeFetch: async () => { downloads++; return { buffer: Buffer.from('fixture-png'), contentType: 'image/png' }; },
  validateUploadBuffer: () => ({ contentType: 'image/png' }), expectedImagePixelSize: () => '1024x1024',
  prepareGeneratedImageBytes: async () => ({ dimensions: { width: 1024, height: 1024 } }),
  storageManager: { upload() { throw Error('Generated media upload forbidden'); } },
});
const inspected = await callbackModule.exports(providerResult('https://provider.invalid/image.png'), { persistenceAttemptId: 'fixture' });
assert.equal(inspected.providerUrl, 'https://provider.invalid/image.png');
assert.equal(inspected.deliveryMode, 'provider_url');
assert.equal(inspected.storageKey, undefined);
assert.equal(downloads, 1);
await assert.rejects(callbackModule.exports({ ...providerResult('https://provider.invalid/image.png'), provider: 'wrong-provider' }, {}), error => error.code === 'IMAGE_MODEL_BINDING_CHANGED');
assert.equal(downloads, 1);
// Real PNG, actual upload signature/dimension/output validators, actual route callback.
const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer();
const inlineDataUrl = `data:image/png;base64,${png.toString('base64')}`;
const dimensions = load('src/lib/image-dimensions.ts', { '@/lib/safe-fetch': { safeFetch() { throw Error('Network forbidden'); } } });
const uploadSecurity = load('src/lib/file-upload-security.ts', { 'node:crypto': crypto });
const outputContract = load('src/lib/image-output-contract.ts');
function inlineCallback() {
  const module = { exports: {} };
  const code = `${prepareBytesText}\nmodule.exports = (${inlineCallbackText});`;
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, Buffer, candidates: [{ id: 'fixture-model', provider: 'fixture', api_endpoint: 'https://provider.invalid/v1/images/generations' }],
    effectiveMode: 'local', effectiveResolution: '1K', ratio: '1:1', costPrice: 0.1, workflowConfig: {},
    resolveImageResolutionPrice: () => 0.1, ImageExactlyOnceError: exact.ImageExactlyOnceError, ImageRequestRejectedError: exact.ImageRequestRejectedError,
    decodeInlineImage: ephemeral.decodeInlineImage, createImageEphemeralDelivery: ephemeral.createImageEphemeralDelivery,
    validateUploadBuffer: uploadSecurity.validateUploadBuffer, parseImageDimensions: dimensions.parseImageDimensions,
    validateImageOutputContract: outputContract.validateImageOutputContract, AUTODL_H3_IMAGE_CONTENT_TYPES: ['image/png','image/jpeg','image/webp'],
    expectedImagePixelSize: () => '1024x1024', storageManager: { upload() { throw Error('Media upload forbidden'); } },
  });
  return module.exports;
}
const actualInlineCallback = inlineCallback();
const embedded = fixture(inlineDataUrl);
embedded.input.prepareEphemeralResult = actualInlineCallback;
const inlineFirst = await exact.runImageExactlyOnce(embedded.input);
assert.equal(inlineFirst.transientDelivery.dataUrl, inlineDataUrl);
assert.equal(inlineFirst.response.width, 1024);
const record = await embedded.store.get(embedded.input);
assert.equal(exact.hasImageProviderCheckpoint(record), false);
assert.equal(JSON.stringify(record).includes(png.toString('base64')), false);
assert.equal(embedded.counts().inspections, 0);
const inlineReplay = await exact.runImageExactlyOnce(embedded.input);
assert.equal(inlineReplay.transientDelivery, undefined);
assert.equal(embedded.counts().submissions, 1);
await assert.rejects(actualInlineCallback({ ...providerResult(inlineDataUrl), provider: 'unbound' }, record.recordId), error => error.code === 'IMAGE_MODEL_BINDING_CHANGED');
await assert.rejects(actualInlineCallback({ ...providerResult(inlineDataUrl), selectedCostPrice: 10 }, record.recordId), error => error.code === 'IMAGE_MODEL_BINDING_CHANGED');
await assert.rejects(actualInlineCallback({ ...providerResult(inlineDataUrl), apiEndpoint: 'https://foreign.invalid' }, record.recordId), error => error.code === 'IMAGE_MODEL_BINDING_CHANGED');
const wrongSize = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png().toBuffer();
await assert.rejects(actualInlineCallback(providerResult(`data:image/png;base64,${wrongSize.toString('base64')}`), record.recordId), error => error.code === 'IMAGE_OUTPUT_RESOLUTION_MISMATCH');
// Actual status route: metadata only, no recovery payload or browser bytes.
const status = load('src/app/api/image/status/route.ts', {
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/lib/api-middleware': { withAuth: (_req, handler) => handler({ id: embedded.input.userId }, {}) },
  '@/lib/image-exactly-once': { ...exact, DatabaseImageExactlyOnceStore: class { get(input) { return embedded.store.get(input); } } },
  '@/lib/image-ephemeral-delivery': ephemeral,
  '@/lib/image-failure-history': { parseImageFailureRequestSnapshot: () => null },
  '@/lib/cover-durable-attempt': {}, '@/storage/database/supabase-client': { getSupabaseClient() { throw Error('DB forbidden'); } },
  '@/lib/image-provider-request-audit': { imageProviderEvidenceProjection: () => ({}) },
});
const statusResponse = await status.GET({ nextUrl: new URL(`http://fixture.invalid/?clientIdempotencyKey=${embedded.input.clientIdempotencyKey}&clientTraceId=${embedded.input.clientTraceId}`) });
assert.match(statusResponse.headers.get('cache-control'), /no-store/u);
const statusBody = await statusResponse.json();
assert.equal(statusBody.mediaAvailable, false); assert.equal(statusBody.canRecover, false);
assert.equal(statusBody.resumeInput, undefined); assert.deepEqual(statusBody.images, []);
assert.equal(JSON.stringify(statusBody).includes(png.toString('base64')), false);
// Execute the real HTTP inline response block, including one-copy bytes/no-store.
const branchStart = routeText.indexOf('    if (isImageEphemeralReceipt(exactResult.response)) {');
const branchEnd = routeText.indexOf('    const directProviderUrl', branchStart);
assert.ok(branchStart >= 0 && branchEnd > branchStart);
const httpModule = { exports: {} };
const responseBlock = `module.exports = async function(exactResult) { let idempotencyReplayed=exactResult.replayed; ${routeText.slice(branchStart, branchEnd)} };`;
let revenueCalls = 0;
runInNewContext(ts.transpileModule(responseBlock, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
  module: httpModule, console, isImageEphemeralReceipt: ephemeral.isImageEphemeralReceipt, imageEphemeralStatus: ephemeral.imageEphemeralStatus,
  NextResponse: { json: (body, init) => Response.json(body, init) }, recordRevenue: async () => { revenueCalls++; },
  userId: embedded.input.userId, effectiveMode: 'local', billingReferenceId: embedded.input.billingReferenceId, sellingPrice: 0.2,
  userRole: 'student', traceId: embedded.input.clientTraceId, h3OperationId: 'fixture-op', userVisibleModelLabel: 'Fixture', modelId: 'pm_fixture',
  effectiveResolution: '1K', outputPixelSize: '1024x1024', IMAGE_FIXED_OUTPUT_COUNT: 1, providerProtocol: 'images_generations', generationFingerprint: 'a'.repeat(64),
});
const originalHttp = await httpModule.exports(inlineFirst);
assert.match(originalHttp.headers.get('cache-control'), /no-store/u);
const originalHttpText = await originalHttp.text();
assert.equal(originalHttpText.split(png.toString('base64')).length - 1, 1);
assert.equal(JSON.parse(originalHttpText).images[0].recordId, record.recordId);
const replayHttp = await httpModule.exports(inlineReplay);
const replayHttpBody = await replayHttp.json();
assert.equal(replayHttpBody.mediaAvailable, false); assert.deepEqual(replayHttpBody.images, []);
assert.equal(revenueCalls, 2, 'receipt-only replay repairs existing idempotent revenue projection');
const readiness = load('src/lib/autodl-h3-provider-delivery-readiness.ts', {
  '@/lib/production-database-readiness': { probeProductionDatabaseReadiness() { throw Error('Network forbidden'); } },
});
const readyMetadata = { state: 'ready', missingTables: [], missingColumns: [], missingRpcs: [], missingRpcArguments: [] };
assert.equal(readiness.evaluateAutodlH3ProviderDeliveryReadiness(readyMetadata).ready, true);
assert.equal(readiness.evaluateAutodlH3ProviderDeliveryReadiness({ ...readyMetadata, missingRpcs: ['autodl_h3_finalize_video_provider_url'] }).ready, false);
assert.equal((await readiness.probeAutodlH3ProviderDeliveryReadiness(async () => { throw Error('unknown metadata'); })).ready, false);
const activation = load('src/lib/autodl-h3-activation-profile.ts');
let recoveryFetch;
const selfhost = load('src/lib/autodl-h3-selfhost.ts', { 'node:crypto': crypto, './autodl-h3-activation-profile': activation }, { Headers, Response, AbortSignal, fetch: (...args) => recoveryFetch(...args) });
const endpoint = selfhost.AUTODL_H3_SELFHOST_VIDEO_ENDPOINT;
const exp = Math.floor(Date.now() / 1000) + 300;
const sig = 'a'.repeat(64);
const imageEndpoint = selfhost.AUTODL_H3_SELFHOST_IMAGE_ENDPOINT;
const heldJob = 'h3_held_checkpoint_fixture';
const expiredHeldUrl = `http://127.0.0.1:16011/v1/files/${heldJob}?expires=1&sig=${sig}`;
const freshHeldUrl = `http://127.0.0.1:16011/v1/files/${heldJob}?expires=${exp}&sig=${sig}`;
const held = fixture(expiredHeldUrl);
const claimedHeld = await held.store.claim(held.input);
const heldResult = { ...providerResult(expiredHeldUrl), provider: selfhost.AUTODL_H3_SELFHOST_PROVIDER, apiEndpoint: imageEndpoint };
const lease = 'fixture-held-lease';
const acquiredHeld = await held.store.claimProviderPersistence(claimedHeld.record, heldResult, lease);
let heldRow = {
  record_id: acquiredHeld.recordId, user_hash: acquiredHeld.userHash, user_id: held.input.userId,
  client_idempotency_key: acquiredHeld.clientIdempotencyKey, client_trace_id: acquiredHeld.clientTraceId,
  payload_fingerprint: acquiredHeld.payloadFingerprint, state: acquiredHeld.state, response: acquiredHeld.response,
  created_at: acquiredHeld.createdAt, updated_at: acquiredHeld.updatedAt,
};
boundDatabase = { from(table) {
  assert.equal(table, 'image_generation_requests'); const filters=[];
  const query={ select(){return query;}, eq(key,value){filters.push([key,value]);return query;}, async maybeSingle(){
    return {data: filters.every(([key,value])=>heldRow[key]===value) ? structuredClone(heldRow) : null,error:null};
  } }; return query;
} };
const recoveryCalls=[]; let secretReads=0;
recoveryFetch=async (url,init)=>{
  recoveryCalls.push({url:String(url),method:init?.method||'GET'});
  assert.equal(init?.method||'GET','GET'); assert.equal(init?.body,undefined);
  if(String(url).includes('/v1/jobs/'))return Response.json({id:heldJob,object:'image.generation',model:selfhost.AUTODL_H3_SELFHOST_IMAGE_MODEL,status:'completed',data:[{url:freshHeldUrl}]});
  assert.equal(String(url),freshHeldUrl); return new Response(png,{headers:{'Content-Type':'image/png'}});
};
const h3CallbackModule={exports:{}};
runInNewContext(ts.transpileModule(`module.exports=(${callbackText});`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
  module:h3CallbackModule,URL,providerMediaUrl:delivery.providerMediaUrl,effectiveMode:'local',resumeSnapshot:null,
  candidates:[{id:'fixture-model',provider:selfhost.AUTODL_H3_SELFHOST_PROVIDER,api_endpoint:imageEndpoint}],workflowConfig:{},
  ImageExactlyOnceError:exact.ImageExactlyOnceError,ImageRequestRejectedError:exact.ImageRequestRejectedError,
  AUTODL_H3_SELFHOST_PROVIDER:selfhost.AUTODL_H3_SELFHOST_PROVIDER,AUTODL_H3_SELFHOST_SECRET_REF:selfhost.AUTODL_H3_SELFHOST_SECRET_REF,
  AUTODL_H3_IMAGE_MAX_BYTES:30*1024*1024,AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS:1000,AUTODL_H3_IMAGE_CONTENT_TYPES:['image/png'],
  imageExactlyOnceStore:new exact.DatabaseImageExactlyOnceStore(),userId:held.input.userId,
  resolveAutodlH3SelfhostResultUrl:selfhost.resolveAutodlH3SelfhostResultUrl,readAutodlH3SelfhostResult:selfhost.readAutodlH3SelfhostResult,
  resolveProviderSecret:ref=>{assert.equal(ref,selfhost.AUTODL_H3_SELFHOST_SECRET_REF);secretReads++;return 'fixture-gateway-key';},
  validateUploadBuffer:uploadSecurity.validateUploadBuffer,expectedImagePixelSize:()=> '1024x1024',ratio:'1:1',effectiveResolution:'1K',
  prepareGeneratedImageBytes:async ({buffer})=>{assert.equal(buffer.equals(png),true);return {buffer,dimensions:{width:1024,height:1024}};},
});
const heldContext={recordId:acquiredHeld.recordId,payloadFingerprint:acquiredHeld.payloadFingerprint,persistenceAttemptId:lease};
const refreshedDelivery=await h3CallbackModule.exports(heldResult,heldContext);
assert.equal(refreshedDelivery.providerUrl,freshHeldUrl);
assert.deepEqual(recoveryCalls.map(x=>x.method),['GET','GET']);
assert.equal(heldRow.response.providerResult.rawUrl,expiredHeldUrl,'refresh does not rewrite original checkpoint/fingerprint');
const originalHeldRow=structuredClone(heldRow);
for(const mutate of [
 row=>row.user_id='foreign-owner', row=>row.user_hash='f'.repeat(64), row=>row.state='completed',
 row=>row.payload_fingerprint='e'.repeat(64), row=>row.response.resultFingerprint='d'.repeat(64),
 row=>row.response.persistenceLease.owner='foreign-lease', row=>row.response.persistenceLease.expiresAt='2000-01-01',
 row=>row.response.providerResult.rawUrl=freshHeldUrl, row=>row.response.providerResult.apiEndpoint='https://foreign.invalid',
 row=>row.response.providerResult.selectedModelId='foreign-model',
]){
  heldRow=structuredClone(originalHeldRow);mutate(heldRow);
  await assert.rejects(h3CallbackModule.exports(heldResult,heldContext),error=>error.code==='IMAGE_H3_CHECKPOINT_BINDING_UNAVAILABLE');
}
assert.equal(recoveryCalls.length,2,'unbound held checkpoints cannot GET jobs or source files');
assert.equal(secretReads,1,'unbound checkpoints cannot read the controlled secret');
boundDatabase=undefined;
const h3Sql = readFileSync('supabase/migrations/20261012011000_h3_provider_delivery.sql', 'utf8');
const urlPattern = h3Sql.match(/AND p_url ~ '([^']+)'/u)?.[1];
assert.ok(urlPattern);
for (const query of [`expires=${exp}&sig=${sig}`, `sig=${sig}&expires=${exp}`]) {
  const url = `http://127.0.0.1:16011/v1/files/h3_abcd?${query}`;
  assert.equal(selfhost.resolveAutodlH3SelfhostResultUrl(url, endpoint), url);
  assert.equal(new RegExp(urlPattern).test(url), true);
}
assert.equal(new RegExp(urlPattern).test(`http://127.0.0.1:16011/v1/files/h3_abcd?expires=${exp}&signature=${sig}`), false);
const production = load('src/lib/autodl-h3-production-finalizer.ts', {
  '@/lib/autodl-h3-selfhost': selfhost,
  '@/storage/database/supabase-client': { getSupabaseAdminClient() { throw Error('Real database forbidden'); } },
});
let settlementCalls = 0;
const h3Url = `http://127.0.0.1:16011/v1/files/h3_abcd?expires=${exp}&sig=${sig}`;
const deps = production.createAutodlH3ProductionFinalizerDependencies({ store: {}, persist() { throw Error('Backup forbidden'); },
  client: { async rpc(name, args) { settlementCalls++; assert.equal(name, 'autodl_h3_finalize_video_provider_url');
    return { data: { committed: true, stable_asset_url: args.p_result_asset_url, charged_yuan: 0.2 }, error: null }; } } });
assert.equal(await deps.persistResult({ context: { providerEndpoint: endpoint }, resultUrl: h3Url }), h3Url);
const settlement = await deps.settleAtomically({ job: { id: 'fixture', publicTaskId: 'fixture', leaseOwner: 'fixture', leaseToken: 1 },
  context: { videoTaskInternalId: 'fixture', userId: 'fixture', modelId: 'fixture', upstreamTaskId: 'fixture', priceYuan: 0.2, costPrice: 0.1 }, stableAssetUrl: h3Url, responseMs: 1 });
assert.equal(settlement.committed, true);
assert.equal(settlementCalls, 1);
console.log(JSON.stringify({ ok: true, network: 0, database: 0, mediaWrites: 0,
  checks: ['provider-reference', 'stream-idle', 'retention-confirmation', 'direct-replay', 'inline-receipt-without-checkpoint', 'inline-model-cost-endpoint-binding', 'inline-real-png-and-dimensions', 'inline-status-no-store-no-recovery', 'inline-one-copy-http-and-receipt-replay', 'unknown-source-recovery', 'actual-route-callback-no-upload', 'h3-held-checkpoint-get-only-recovery', 'h3-held-checkpoint-owner-lease-fingerprint-negatives', 'h3-readonly-readiness', 'h3-ts-sql-url-samples', 'h3-production-adapter-no-backup'] }));
