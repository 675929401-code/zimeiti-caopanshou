import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Actual store/CAS/run function, actual generate callbacks and persistence
// function, and actual status handler. All DB/storage/provider effects are
// mandatory in-memory fixtures. No real configuration or network is reachable.
const rootRoute = 'src/app/api/image/generate/route.ts';
const libPath = 'src/lib/image-exactly-once.ts';
const routeSource = readFileSync(rootRoute, 'utf8');
const preflightSource = routeSource.slice(routeSource.indexOf('    // A confirmed result resumes'), routeSource.indexOf('    const exactResult ='));
const syntax = ts.createSourceFile(rootRoute, routeSource, ts.ScriptTarget.Latest, true);
let optionsSource = '';

function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'runImageExactlyOnce') optionsSource = node.arguments[0].getText(syntax);

  ts.forEachChild(node, visit);
}
visit(syntax); assert.ok(optionsSource);
const rawUrl = 'https://provider-media.invalid/private-image.png?signature=fixture-private-signature';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const copy = value => value === undefined ? undefined : structuredClone(value);

function fixture() {
  let clock = Date.now();
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const rows = new Map(); const assets = new Map(); const events = [];
  const faults = { checkpointBefore: false, checkpointAfter: false, saveBefore: false, saveAfter: false, download: false, provider: false, deferDownload: null, allowOldDownload: false };
  const calls = { provider: 0, downloads: 0, uploads: 0, uploadNames: [], checkpointWrites: 0, finalizes: 0, queryFilters: [], balanceReads: 0, debtCalls: 0, reservations: 0 };
  const rowValue = (row, key) => key.replaceAll('->>', '.').replaceAll('->', '.').split('.').reduce((value, item) => value?.[item], row);
  const db = {
    from(table) {
      assert.equal(table, 'image_generation_requests');
      const filters = []; let update;
      const execute = async () => {
        const row = [...rows.values()].find(item => filters.every(([kind, key, value]) => kind === 'is' ? rowValue(item, key) == null : rowValue(item, key) === value));
        if (!row) return { data: null, error: null };
        if (update) {
          if (update.state === 'completed' && faults.saveBefore) return { data: null, error: { message: 'fixture complete unavailable' } };
          const checkpointClaim = Boolean(update.response?.persistenceLease);
          if (checkpointClaim) {
            calls.checkpointWrites++;
            if (faults.checkpointBefore) return { data: null, error: { message: `fixture DB error ${rawUrl}` } };
          }
          Object.assign(row, copy(update));
          if (update.state === 'completed' && faults.saveAfter) { faults.saveAfter = false; return { data: null, error: { message: 'fixture complete acknowledgement lost' } }; }
          if (checkpointClaim && faults.checkpointAfter) { faults.checkpointAfter = false; return { data: null, error: { message: `fixture DB lost response ${rawUrl}` } }; }
        }
        // PostgreSQL jsonb does not retain JS property order.
        return { data: canonical(copy(row)), error: null };
      };
      const query = {
        update(value) { update = value; return query; }, select() { return query; },
        eq(key, value) { filters.push(['eq', key, value]); calls.queryFilters.push([key, value]); return query; },
        is(key, value) { filters.push(['is', key, value]); calls.queryFilters.push([key, value]); return query; },
        maybeSingle: execute, then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      if (name === 'claim_image_generation_request_v2') {
        let row = rows.get(args.p_record_id); const created = !row;
        if (row?.payload_fingerprint !== undefined && row.payload_fingerprint !== args.p_payload_fingerprint) return { error: { message: 'IMAGE_IDEMPOTENCY_CONFLICT' } };
        if (row?.client_trace_id !== undefined && row.client_trace_id !== args.p_client_trace_id) return { error: { message: 'IMAGE_IDEMPOTENCY_TRACE_CONFLICT' } };
        if (!row) {
          row = { record_id: args.p_record_id, user_hash: args.p_user_hash, user_id: args.p_user_id,
            client_idempotency_key: args.p_client_idempotency_key, client_trace_id: args.p_client_trace_id,
            payload_fingerprint: args.p_payload_fingerprint, request_snapshot: copy(args.p_request_snapshot),
            state: 'intent', response: null, delivery_state: 'held',
            created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() };
          rows.set(args.p_record_id, row);
        }
        return { data: { created, record: canonical(copy(row)) }, error: null };
      }
      const row = rows.get(args.p_record_id); assert.ok(row);
      if (name === 'save_image_generation_request') {
        if (faults.saveBefore && args.p_state === 'completed') return { error: { message: 'fixture save unavailable' } };
        if (row.state === 'completed') {
          if (args.p_state !== 'completed' || JSON.stringify(canonical(row.response)) !== JSON.stringify(canonical(args.p_response))) return { error: { message: 'IMAGE_IDEMPOTENCY_RESULT_CONFLICT' } };
        } else if (row.state === 'failed_unknown') {
          if (args.p_state !== 'failed_unknown') return { error: { message: 'IMAGE_IDEMPOTENCY_UNKNOWN_TERMINAL' } };
        } else Object.assign(row, { state: args.p_state, response: args.p_state === 'completed' ? copy(args.p_response) : null });
        if (faults.saveAfter && args.p_state === 'completed') { faults.saveAfter = false; return { error: { message: 'fixture save acknowledgement lost' } }; }
        return { data: { record: canonical(copy(row)) }, error: null };
      }
      assert.equal(name, 'finalize_image_generation_delivery'); calls.finalizes++;
      assert.equal(row.state, 'completed'); assert.equal(row.response.storageKey, args.p_storage_key);
      if (!assets.has(row.record_id)) assets.set(row.record_id, `fixture-asset-${assets.size + 1}`);
      row.delivery_state = 'delivered'; row.delivery_asset_id = assets.get(row.record_id);
      return { data: { deliveryAssetId: row.delivery_asset_id, deliveryState: 'delivered' }, error: null };
    },
  };
  const modules = {
    'node:crypto': { createHash, randomUUID }, 'node:path': { default: path, ...path }, 'node:fs/promises': {},
    '@/lib/runtime-paths': { resolveAppRuntimeDir: () => '/fixture-runtime' },
    '@/lib/image-provider-request-audit': {
      imageProviderEvidenceProjection: () => ({}),
      assertImageProviderDispatchReceipt: () => undefined,
      assertImageProviderSubmissionReceipt: () => undefined,
    },
    '@/storage/database/supabase-client': {
      getSupabaseAdminClient: () => db,
      getSupabaseClient: () => db,
    },
    '@/lib/cover-durable-attempt': {
      COVER_ATTEMPT_ACTIVE_STATES: ['claimed', 'dispatched', 'delivery_pending'],
      isCoverAttemptRow: () => false,
      coverAttemptProjection: () => ({}),
    },
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth': { getTokenFromHeaders: () => 'fixture-session', verifyToken: async () => ({ userId: 'fixture-user' }) },
    '@/lib/api-middleware': { withAuth: async (_request, handler) => handler({ id: 'fixture-user' }, db) },
  };
  const globals = { Date: FixtureDate, Buffer, URL, structuredClone, createHash, process: { env: {} },
    console: { log: (...args) => events.push(args), error: (...args) => events.push(args), warn: (...args) => events.push(args) } };
  function evaluate(source, extra = {}) {
    const compiledModule = { exports: {} };
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    runInNewContext(compiled, { ...globals, ...extra, module: compiledModule, exports: compiledModule.exports,
      require(id) { assert.ok(id in modules, `unstubbed module ${id}`); return modules[id]; } });
    return compiledModule.exports;
  }
  modules['@/lib/image-request-rejection'] = evaluate(readFileSync('src/lib/image-request-rejection.ts', 'utf8'));
  modules['@/lib/image-failure-history'] = evaluate(readFileSync('src/lib/image-failure-history.ts', 'utf8'));
  modules['@/lib/image-ephemeral-delivery'] = evaluate(readFileSync('src/lib/image-ephemeral-delivery.ts', 'utf8'));
  const lib = evaluate(readFileSync(libPath, 'utf8'));  modules['@/lib/image-exactly-once'] = lib;
  const store = new lib.DatabaseImageExactlyOnceStore();
  const candidate = { id: 'fixture-image-model', provider: 'fixture-provider', api_endpoint: 'https://provider.invalid/v1/images/generations', api_key: 'fixture-provider-key', cost_price: 0.1 };
  function options(mode = 'local') {
    return evaluate(`module.exports = (${optionsSource});`, {
      imageExactlyOnceStore: store, userId: 'fixture-user', generationIdempotencyKey: 'fixture_image_key', traceId: 'fixture_image_trace',
      generationFingerprint: hash('fixture bound model and request'), effectiveMode: mode, sellingPrice:0.2, billingReferenceId: 'image:fixture_operation_id',
      reserveImageBudgetOnce: async () => { calls.reservations++; },
      resumeSnapshot: null,
      failureRequestSnapshot: { schema: 'image_generation_request_snapshot.v1', surface: 'other', prompt: 'fixture prompt',
        publicModelId: 'pm_fixture', modelName: 'Fixture image model', mode: 'text-to-image', aspectRatio: '1:1',
        resolution: '1K', referenceAssetRefs: [], quotedPriceYuan: 0.2, billingExempt: false },
      workflowConfig: { apiToken: 'fixture-workflow-key', apiUrl: 'https://workflow.invalid/run', appId: 'fixture-workflow' },
      candidates: [candidate], ratio: '1:1', effectiveResolution: '1K', references: [], identityReferenceOnly: false,
      prompt:'fixture prompt', acquireProviderAdmission: async () => ({release: async () => {}}), releaseProviderAdmission: async () => {}, imageAdmissionRejection: () => null, summarizeUpstreamImageError: value => value,
      holdProviderAdmissionUntilResponseEnds: async response => response, fetchAuditedImageProviderPost: async () => {calls.provider++;return {response:new Response('fixture SSE'),dispatchReceipt:{}};},
      fullPrompt: 'fixture prompt', workflowPrompt: 'fixture workflow prompt', h3OperationId: 'fixture_operation_id', strictImageRequest: false,
      traceNodeId: '', traceNodeTitle: '', costPrice: 0.1,
      AUTODL_H3_SELFHOST_PROVIDER: 'autodl_h3_selfhost', ImageExactlyOnceError: lib.ImageExactlyOnceError, ImageRequestRejectedError: lib.ImageRequestRejectedError,
      ImageCandidateFailure: class extends Error { constructor(input) { super(input.message); Object.assign(this, input); } },
      isRetryableImageUpstreamStatus: () => false, resolveProviderSecret: () => 'fixture-resolved-key',
      resolveImageResolutionPrice: model => model.cost_price,
      expectedImagePixelSize: () => '1024x1024',
      exactCoverText: '',
      writeImageTrace: async event => events.push(event),
      generateLocalImageCandidate: async () => { calls.provider++; if (faults.provider) throw new Error('fixture upstream unknown'); return rawUrl; },
      providerMediaUrl: value => /^https?:/.test(value) ? value : null,
      AUTODL_H3_IMAGE_MAX_BYTES: 25 * 1024 * 1024, AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS: 120_000,
      AUTODL_H3_IMAGE_CONTENT_TYPES: ['image/png','image/jpeg','image/webp'], TRUSTED_GENERATED_IMAGE_HOSTS: ['provider-media.invalid'],
      safeFetch: async url => {
        calls.downloads++; assert.equal(url,rawUrl);
        assert.ok([...rows.values()][0].response?.persistenceLease,'download requires durable lease');
        if(faults.deferDownload) await faults.deferDownload;
        if(faults.download) throw new Error('fixture download unavailable');
        return {buffer:Buffer.from('fixture-image-bytes'),contentType:'image/png'};
      },
      validateUploadBuffer: () => ({contentType:'image/png',extension:'.png'}),
      prepareGeneratedImageBytes: async ({buffer}) => ({buffer,dimensions:{width:64,height:64}}),

      persistAutodlH3SelfhostImageWithRecovery: async () => { throw new Error('H3 is outside this fixture'); },
      fetchImageUpstream: async () => { calls.provider++; return new Response('fixture SSE', { headers: { 'content-type': 'text/event-stream' } }); },
      readAuditedImageProviderResponseText: async ({response}) => response.text(),
      readImageUpstreamResponseText: async response => response.text(),
      parseImageUpstreamResponse: () => ({ format: 'sse', payload: {}, error: null }),
      parseImageSseFrames: () => [],
      ImageUpstreamResponseTooLargeError: class extends Error {},
      extractImageUrlsFromSSE: () => [rawUrl],
    });
  }
  const status = evaluate(readFileSync('src/app/api/image/status/route.ts', 'utf8'));
  return { lib, store, faults, calls, rows, assets, events, options,
    advance: ms => { clock += ms; }, first: () => [...rows.values()][0],
    run: mode => lib.runImageExactlyOnce(options(mode)),
    preflight: async (changes = {}) => evaluate(`module.exports = async () => { const previousImageRequest = await imageExactlyOnceStore.get({ userId, clientIdempotencyKey: generationIdempotencyKey, clientTraceId: traceId }); ${preflightSource}\n return { continued: true }; };`, {
      imageExactlyOnceStore: store, userId: 'fixture-user', generationIdempotencyKey: 'fixture_image_key', traceId: 'fixture_image_trace',
      generationFingerprint: hash('fixture bound model and request'), isAdmin: false, sellingPrice: 0.2, validationControl: null,
      failureRequestSnapshot: { schema: 'image_generation_request_snapshot.v1', surface: 'other', prompt: 'fixture prompt',
        publicModelId: 'pm_fixture', modelName: 'Fixture image model', mode: 'text-to-image', aspectRatio: '1:1',
        resolution: '1K', referenceAssetRefs: [], quotedPriceYuan: 0.2, billingExempt: false },
      h3OperationId: 'fixture_operation_id', effectiveMode: 'local', workflowConfig: { appId: '' },
      publicModelLabel: 'Fixture image model', modelConfig: candidate, selectedBillingPublicModelId: 'pm_fixture',
      costPrice: 0.1, ratio: '1:1', effectiveResolution: '1K', deductResult: null, billingReservation: null,
      ImageExactlyOnceError: lib.ImageExactlyOnceError, hasImageProviderCheckpoint: lib.hasImageProviderCheckpoint,
      ImageRequestRejectedError: lib.ImageRequestRejectedError, getImageRequestRejection: lib.getImageRequestRejection,
      publicModelDisplayName: () => 'Fixture image model',
      executeCashDeduction: async () => { calls.reservations++; return { success: true, cashCharged: 0.2, remaining: 9.8, operationId: 'fixture-op' }; },
      NextResponse: modules['next/server'].NextResponse,
      dbClient: { from() { calls.balanceReads++; const query = { select() { return query; }, eq() { return query; }, single: async () => ({ data: { cash_balance: 0 } }) }; return query; } },
      checkAndCollectDebt: async () => { calls.debtCalls++; throw new Error('fixture unrelated historical debt must not be collected on recovery'); },
      ...changes,
    })(),
    status: async () => {
      const response = await status.GET({ headers: new Headers(), nextUrl: new URL('http://fixture.invalid/api/image/status?clientIdempotencyKey=fixture_image_key&clientTraceId=fixture_image_trace') });
      const body = await response.json(); assert.ok(!JSON.stringify(body).includes(rawUrl)); return body;
    },
    assertPrivate: () => {
      assert.ok(!JSON.stringify(events).includes(rawUrl));
      assert.ok(!JSON.stringify(calls.queryFilters).includes(rawUrl), 'private URL must not enter PostgREST query filters/logs');
    },
  };
}

let scenarios = 0;
async function test(name, action) { await action(); scenarios++; console.log(`PASS ${name}`); }
const pending = error => error?.code === 'IMAGE_RESULT_PERSISTENCE_PENDING' && !error.message.includes(rawUrl);
await test('legacy COS completed receipt replay and asset finalization remain idempotent', async () => {
  const f=fixture();const options=f.options();let legacySubmissions=0;
  const response={storageUri:'object://tencent_cos/fixture-owned/legacy.png',storageKey:'fixture-owned/legacy.png',storageProvider:'tencent_cos',fileName:'legacy.png',fileSize:19,contentType:'image/png',source:'image-generation'};
  const legacyOptions={...options,persistProviderResult:undefined,prepareEphemeralResult:undefined,submitOnce:async()=>{legacySubmissions++;return response;}};
  const first=await f.lib.runImageExactlyOnce(legacyOptions);const replay=await f.lib.runImageExactlyOnce(legacyOptions);
  assert.equal(first.record.state,'completed');assert.equal(replay.replayed,true);assert.equal(legacySubmissions,1);assert.deepEqual({...replay.response},response);
  const delivery={recordId:first.record.recordId,userId:'fixture-user',...response,meta:{}};
  const one=await f.lib.finalizeImageExactlyOnceDelivery(delivery);const two=await f.lib.finalizeImageExactlyOnceDelivery(delivery);
  assert.equal(one.assetId,two.assetId);assert.equal(f.assets.size,1);assert.equal((await f.status()).deliveryReady,true);assert.equal(f.calls.provider,0);
});
await test('real callbacks checkpoint before download; completed replay and delivery stay idempotent', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.record.state, 'completed'); assert.equal(result.response.deliveryMode,'provider_url');
  assert.equal(result.response.providerUrl,rawUrl); assert.equal(f.calls.provider,1); assert.equal(f.calls.downloads,1);
  assert.equal(f.calls.uploads,0); assert.equal(f.assets.size,0,'direct delivery creates no media history');
  f.first().delivery_state='delivered';
  assert.equal((await f.run()).replayed,true); assert.equal(f.calls.provider,1); assert.equal(f.calls.downloads,1);
  assert.equal((await f.status()).deliveryReady,true); f.assertPrivate();
});
await test('DNS failure retains checkpoint; same key resumes storage only', async () => {
  const f = fixture(); f.faults.download = true; await assert.rejects(f.run(), pending);
  assert.equal(f.first().state, 'intent'); assert.equal(f.first().response.providerResult.rawUrl, rawUrl);
  const status = await f.status(); assert.equal(status.canRecover, true); assert.equal(status.canResubmit, false);
  assert.equal(status.state, 'provider_completed_pending_delivery');
  f.faults.download = false; assert.equal((await f.run()).replayed, true);
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.downloads, 2); f.assertPrivate();
});
await test('checkpoint refused before commit prevents all downloads and provider replay', async () => {
  const f = fixture(); f.faults.checkpointBefore = true;
  await assert.rejects(f.run(), error => error.code === 'IMAGE_PROVIDER_CHECKPOINT_NOT_CONFIRMED');
  assert.equal(f.calls.downloads, 0); assert.equal(f.first().response, null);
  f.faults.checkpointBefore = false; await assert.rejects(f.run(), error => error.code === 'IMAGE_IDEMPOTENCY_FAIL_CLOSED');
  assert.equal(f.calls.provider, 1); f.assertPrivate();
});
await test('checkpoint commit acknowledgement lost; lease expiry only resumes persistence', async () => {
  const f = fixture(); f.faults.checkpointAfter = true;
  await assert.rejects(f.run(), error => error.code === 'IMAGE_PROVIDER_CHECKPOINT_NOT_CONFIRMED');
  assert.equal(f.calls.downloads, 0);
  const ackStatus = await f.status(); assert.equal(ackStatus.canRecover, false); assert.ok(ackStatus.retryAfterMs > 0);
  await assert.rejects(f.run(), pending); assert.equal(f.calls.downloads, 0);
  f.advance(300001); await f.run(); assert.equal(f.calls.provider, 1); assert.equal(f.calls.downloads, 1); f.assertPrivate();
});
await test('completed result commit acknowledgement lost remains completed and replayable', async () => {
  const f = fixture(); f.faults.saveAfter = true;
  const completedAfterAckLoss = await f.run(); assert.equal(completedAfterAckLoss.record.state, 'completed');
  assert.equal(f.first().state, 'completed'); assert.equal((await f.run()).replayed, true);
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.downloads, 1); f.assertPrivate();
});
await test('completed result save failure preserves checkpoint for storage-only recovery', async () => {
  const f = fixture(); f.faults.saveBefore = true; await assert.rejects(f.run(), pending);
  assert.equal(f.first().state, 'intent'); assert.equal((await f.status()).canRecover, true);
  f.faults.saveBefore = false; await f.run(); assert.equal(f.calls.provider, 1); f.assertPrivate();
});
await test('concurrent same-key recovery only leases one download', async () => {
  const f = fixture(); f.faults.download = true; await assert.rejects(f.run(), pending); f.faults.download = false;
  let release; f.faults.deferDownload = new Promise(resolve => { release = resolve; });
  const winner = f.run();
  for (let i = 0; i < 100 && f.calls.downloads < 2; i++) await Promise.resolve();
  assert.equal(f.calls.downloads, 2); await assert.rejects(f.run(), pending);
  assert.equal(f.calls.downloads, 2); release(); await winner;
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.uploads, 0); f.assertPrivate();
});
await test('expired lease takeover fences a late old worker from completing or releasing the winner', async () => {
  const f = fixture(); let release;
  f.faults.deferDownload = new Promise(resolve => { release = resolve; });
  const old = f.run();
  for (let i = 0; i < 100 && f.calls.downloads < 1; i++) await Promise.resolve();
  assert.equal(f.calls.downloads, 1); f.advance(300001); f.faults.deferDownload = null;
  const winner = await f.run(); const saved = JSON.stringify(f.first().response);
  release(); const late = await old; assert.equal(late.record.state, 'completed');
  assert.equal(JSON.stringify(f.first().response), saved); assert.equal(winner.record.state, 'completed');
  assert.equal(f.calls.uploads,0,'direct delivery never creates backup objects');
  assert.equal(f.calls.provider, 1); f.assertPrivate();
});
await test('no-checkpoint provider uncertainty stays frozen', async () => {
  const f = fixture(); f.faults.provider = true; await assert.rejects(f.run());
  assert.equal(f.first().state, 'failed_unknown'); assert.equal(f.first().response, null);
  assert.equal((await f.status()).canRecover, false); f.faults.provider = false; await assert.rejects(f.run()); assert.equal(f.calls.provider, 1);
});
await test('payload and trace conflicts cannot use the checkpoint', async () => {
  const f = fixture(); f.faults.download = true; await assert.rejects(f.run(), pending);
  for (const change of [{ payloadFingerprint: hash('changed') }, { clientTraceId: 'different_trace' }]) {
    await assert.rejects(f.lib.runImageExactlyOnce({ ...f.options(), ...change }), error => error.code.startsWith('IMAGE_IDEMPOTENCY_'));
  }
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.downloads, 1);
});
await test('tampered checkpoint fingerprint is not recoverable', async () => {
  const f = fixture(); f.faults.download = true; await assert.rejects(f.run(), pending);
  f.first().response.providerResult.rawUrl += '-changed'; assert.equal((await f.status()).canRecover, false);
  await assert.rejects(f.run(), error => error.code === 'IMAGE_IDEMPOTENCY_FAIL_CLOSED'); assert.equal(f.calls.provider, 1);
});
await test('workflow uses the same checkpoint-before-download contract', async () => {
  const f = fixture(); f.faults.download = true; await assert.rejects(f.run('workflow'), pending);
  f.faults.download = false; const result = await f.run('workflow');
  assert.equal(result.response.source, 'image-workflow-generation'); assert.equal(f.calls.provider, 1); f.assertPrivate();
});
await test('unsupported store is rejected before provider submission', async () => {
  const f = fixture(); const options = f.options();
  await assert.rejects(f.lib.runImageExactlyOnce({ ...options, prepareEphemeralResult:undefined, store: { claim: options.store.claim } }), error => error.code === 'IMAGE_CHECKPOINT_STORE_REQUIRED');
  assert.equal(f.calls.provider, 0);
});
await test('paid result recovery bypasses new-request balance/debt prechecks; changed payload cannot', async () => {
  const f = fixture(); await f.run();
  assert.equal((await f.preflight()).continued, true); assert.equal(f.calls.balanceReads, 0); assert.equal(f.calls.debtCalls, 0);
  assert.equal(f.calls.reservations, 1, 'recovery must still bind the atomic billing reservation');
  await assert.rejects(f.preflight({ generationFingerprint: hash('changed request') }), error => error.code === 'IMAGE_IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.preflight({ traceId: 'changed_trace' }), error => error.code === 'IMAGE_IDEMPOTENCY_TRACE_CONFLICT');
  assert.equal(f.calls.balanceReads, 0); assert.equal(f.calls.debtCalls, 0); assert.equal(f.calls.provider, 1);
  const fresh = fixture(); const denied = await fresh.preflight(); assert.equal(denied.status, 402); assert.equal(fresh.calls.balanceReads, 1);
});
await test('paid budget is atomically reserved before provider submission and definite rejection releases it', async () => {
  const reserveAt = routeSource.indexOf('imageBudgetState.deduction = await executeCashDeduction({');
  const runnerAt = routeSource.indexOf('const exactResult = await runImageExactlyOnce({');
  assert.ok(reserveAt > 0 && runnerAt > reserveAt, 'wallet reservation callback must be defined before the provider-capable runner');
  assert.match(routeSource, /beforeSubmitOnce:\s*reserveImageBudgetOnce/u,
    'the wallet reservation must execute inside the durable-intent winner');
  assert.doesNotMatch(routeSource.slice(reserveAt - 500, runnerAt), /imageExactlyOnceStore\.claim\(/u,
    'the route must not pre-claim and then let the runner claim the same key again');
  const exactlyOnceSource = readFileSync(libPath, 'utf8');
  assert.ok(exactlyOnceSource.indexOf('await options.beforeSubmitOnce?.(claimed.record)')>=0 && exactlyOnceSource.indexOf('result = await options.submitOnce(receiptContext)')>=0);
  assert.ok(exactlyOnceSource.indexOf('await options.beforeSubmitOnce?.(claimed.record)')
    < exactlyOnceSource.indexOf('result = await options.submitOnce(receiptContext)'),
  'wallet reservation must run after the durable claim and before provider submission');
  assert.match(routeSource, /IMAGE_BILLING_RESERVATION_REJECTED/u);
  assert.match(routeSource, /ImageRequestRejectedError[\s\S]*?refundCash\([\s\S]*?:release/u);
  assert.match(routeSource, /IMAGE_BILLING_RELEASE_PENDING[\s\S]*?canResubmit:\s*false/u);
});
console.log(JSON.stringify({ passed: true, scenarios, actualDatabaseStore: true, actualGenerateCallbacks: true, actualLegacyReceiptReplay: true, actualStatusHandler: true, realNetworkCalls: 0, realDatabaseWrites: 0 }));
