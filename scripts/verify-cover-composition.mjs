import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';

const nativeRequire = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const context = { exports: {}, AbortController, Buffer, URL, URLSearchParams, clearTimeout, crypto: webcrypto, Response, setTimeout, console,
    require(name) { return Object.hasOwn(mocks, name) ? mocks[name] : nativeRequire(name); } };
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, context, { filename: path });
  return context.exports;
}
const pure = load('src/lib/cover-composition.ts');
const renderer = load('src/lib/cover-composition-server.ts');
assert.ok(renderer.coverCompositionFont(), 'A real Chinese font is required for this fixture');
const plan = { title: '小芽种薄荷', subtitle: '每天一点绿意', aspectRatio: '4:3', layoutTemplateId: 'gaoding-real-12', animationStyleId: 'pixar-3d' };
const background = await sharp({ create: { width: 1200, height: 896, channels: 3, background: '#457962' } }).png().toBuffer();
const originalHash = createHash('sha256').update(background).digest('hex');
const rendered = await renderer.renderCoverComposition(background, plan);
assert.equal(rendered.renderedText.title, plan.title);
assert.equal(rendered.renderedText.subtitle, plan.subtitle);
assert.ok(rendered.width <= 1200 && rendered.height <= 896, 'Never enlarge a smaller provider image');
assert.equal(rendered.width / rendered.height, 4 / 3);
assert.equal(createHash('sha256').update(background).digest('hex'), originalHash, 'Original background remains unchanged');
const repeated = await renderer.renderCoverComposition(background, plan);
assert.ok(rendered.bytes.equals(repeated.bytes), 'The same source and plan produce identical pixels');
const edited = await renderer.renderCoverComposition(background, { ...plan, title: '小芽和薄荷', subtitle: '今天也有绿意' });
assert.ok(!rendered.bytes.equals(edited.bytes), 'Text edits must change the saved image');
await renderer.renderCoverComposition(background, { ...plan, title: '薄荷 <芽> & “光”', subtitle: '' });
await assert.rejects(() => renderer.renderCoverComposition(Buffer.from('not-image'), plan));
const portrait = await renderer.renderCoverComposition(background, { ...plan, aspectRatio: '9:16', title: '春日薄荷\n慢慢生长' });
assert.ok(portrait.width <= 1200 && portrait.height <= 896);
const directory = '.codex-evidence/cover-deterministic-text-e2e-20260902';
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/fixture-render.png`, rendered.bytes);
writeFileSync(`${directory}/fixture-edit.png`, edited.bytes);
writeFileSync(`${directory}/fixture-portrait.png`, portrait.bytes);

const guard = load('src/lib/image-workbench-attempt-guard.ts');
const resolutionPricing = load('src/lib/image-resolution-pricing.ts');
const helper = load('src/lib/cover-generation-attempt.ts', {
  '@/lib/cover-composition': pure,
  '@/lib/image-workbench-attempt-guard': guard,
  '@/lib/image-resolution-pricing': resolutionPricing,
});
const makeStorage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const storage = makeStorage();
let calls = [], current;
const assetId = '11111111-1111-4111-8111-111111111111';
const compositeId = '22222222-2222-4222-8222-222222222222';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const delivered = (id, textPlan = plan) => ({ status: 'completed', persisted: true, assetId: id, key: `owned/${id}.png`, url: `/own/${id}.png`, historyRecordId: `history_${id}`,
  outputKind: 'cover-composition', sourceAssetId: assetId, renderedText: { title: textPlan.title, subtitle: textPlan.subtitle }, width: 1192, height: 894,
  sourceWidth: 1200, sourceHeight: 896, cloudStored: true, createdAt: '2026-09-25T00:00:00.000Z', taskNo: 1, historyVisible: true });
const task = { id: 'synthetic-task', ratio: '4:3', title: plan.title, subtitle: plan.subtitle, prompt: 'synthetic art', source: '生成', createdAt: '2026-09-25T00:00:00.000Z', taskNo: 1, status: 'running', renderPlan: plan };
const payload = { prompt: 'synthetic art', modelId: 'pm_synthetic', mode: 'local', style: '', aspectRatio: '4:3', resolution: '2K', coverText: '', referenceImageUrls: [], referenceUsage: 'general', historySurface: 'cover-studio' };
const activeAttempt = (key = 'cover_synthetic_durable', sourceTask = task, sourcePayload = payload) => ({
  clientIdempotencyKey: key, clientTraceId: key, state: 'claimed', updatedAt: Date.now(),
  task: { ...sourceTask, status: 'running', error: '封面任务已由账号安全认领，正在等待首次提交' },
  dispatchInput: { ...sourcePayload, referenceImageUrls: [] }, canDispatch: true, requiresReferenceReupload: false,
});
let durableDispatchPosts = 0;
const fetcher = async (path, options = {}) => {
  calls.push(path);
  if (path === '/api/cover/render' && !options.method) return response({ ready: true });
  assert.equal(path.split('?')[0], '/api/cover/attempt');
  const body = JSON.parse(options.body);
  if (body.action === 'claim') return response({ success: true, activeAttempt: activeAttempt() });
  assert.equal(body.action, 'dispatch'); durableDispatchPosts++;
  assert.equal(body.payload.historySurface, 'cover-studio');
  return response({ success: true, completed: true, operationId: 'operation-synthetic', backgroundAssetId: assetId, result: delivered(compositeId) });
};
const wrappedFetcher = async (path, options = {}) => path.startsWith('/api/cover/attempt?') && options.method === 'GET'
  ? response({ success: true, activeAttempt: activeAttempt() }) : fetcher(path, options);
await helper.runCoverGeneration({ userId: 'synthetic', token: 'synthetic-token', payload, task, storage, fetcher: wrappedFetcher, onState: state => { current = state; } });
assert.equal(current.pending, null); assert.equal(current.history[0].assetId, compositeId); assert.equal(current.history[0].backgroundAssetId, assetId);
assert.equal(durableDispatchPosts, 1); assert.equal(calls.filter(path => path === '/api/image/generate').length, 0);
calls = [];
const editedPlan = { ...plan, title: '小芽和薄荷', subtitle: '今天也有绿意' };
await helper.saveCoverCompositionEdit({ userId: 'synthetic', token: 'synthetic-token', storage, task: current.history[0], plan: editedPlan,
  onState: state => { current = state; }, fetcher: async (path, options) => {
    calls.push(path); assert.equal(JSON.parse(options.body).sourceAssetId, assetId); return response(delivered('33333333-3333-4333-8333-333333333333', editedPlan));
  } });
assert.deepEqual(calls, ['/api/cover/render']); assert.equal(current.history.length, 1); assert.equal(current.history[0].assetId, '33333333-3333-4333-8333-333333333333');
assert.ok(!storage.getItem('cover-generation:v1:synthetic').includes('synthetic art'), 'Browser persistence must not retain prompt or shadow account history');
const unavailableCalls = [];
const invalidPlanCalls = [];
for (const invalid of [{ ...plan, title: '字'.repeat(81) }, { ...plan, subtitle: '字'.repeat(121) }, { ...plan, title: '文字\u0000' }]) {
  await assert.rejects(() => helper.runCoverGeneration({ userId: 'invalid', token: 'synthetic-token', payload, task: { ...task, renderPlan: invalid }, storage: makeStorage(), onState() {},
    fetcher: async path => { invalidPlanCalls.push(path); return response({ ready: true }); } }), /尚未提交生图/);
}
assert.equal(invalidPlanCalls.length, 0, 'Invalid text must never reach even the readiness request');
await assert.rejects(() => helper.runCoverGeneration({ userId: 'unavailable', token: 'synthetic-token', payload, task, storage: makeStorage(), onState() {}, fetcher: async path => {
  unavailableCalls.push(path); return response({ ready: false });
} }), /尚未提交生图/);
assert.deepEqual(unavailableCalls, ['/api/cover/render']);
const mismatchStorage = makeStorage(); let mismatchState, mismatchPosts = 0;
const mismatchActive = activeAttempt('cover_mismatch_durable');
const mismatchFetcher = async (path, options = {}) => {
  if (path === '/api/cover/render') return response({ ready: true });
  assert.equal(path.split('?')[0], '/api/cover/attempt');
  if (options.method === 'GET') return response({ success: true, activeAttempt: mismatchActive });
  const body = JSON.parse(options.body);
  if (body.action === 'claim') return response({ success: true, activeAttempt: mismatchActive });
  assert.equal(body.action, 'dispatch'); mismatchPosts++;
  return response({ success: true, completed: true, backgroundAssetId: assetId, result: { ...delivered(compositeId), sourceAssetId: 'foreign-source' } });
};
const mismatchInput = { userId: 'mismatch', token: 'synthetic-token', payload, task, storage: mismatchStorage, fetcher: mismatchFetcher, onState: state => { mismatchState = state; } };
await helper.runCoverGeneration(mismatchInput);
assert.equal(mismatchState.pending.task.status, 'running', 'A claimed task whose render receipt mismatches stays visibly in progress');
const originalPendingKey = mismatchState.pending.clientIdempotencyKey;
await helper.runCoverGeneration(mismatchInput);
assert.equal(mismatchPosts, 1); assert.equal(mismatchState.pending.clientIdempotencyKey, originalPendingKey);
const raceStorage = makeStorage();
raceStorage.setItem('cover-generation:v1:race', JSON.stringify(current));
let releaseRender;
const waitRender = new Promise(resolve => { releaseRender = resolve; });
const racingEdit = helper.saveCoverCompositionEdit({ userId: 'race', token: 'synthetic-token', task: current.history[0], plan, storage: raceStorage, onState() {}, fetcher: async () => { await waitRender; return response(delivered(compositeId)); } });
const concurrentlySubmitted = { version: 1, pending: { clientIdempotencyKey: 'cover_race_other_tab', clientTraceId: 'cover_race_other_tab', updatedAt: Date.now() }, history: [] };
raceStorage.setItem('cover-generation:v1:race', JSON.stringify(concurrentlySubmitted));
releaseRender(); await racingEdit;
assert.equal(helper.readCoverGenerationState(raceStorage, 'race').pending?.clientIdempotencyKey, 'cover_race_other_tab', 'A render response must preserve a task submitted in another tab while it was running');
await assert.rejects(() => helper.saveCoverCompositionEdit({ userId: 'synthetic', token: 'synthetic-token', task: current.history[0], plan, storage, onState() {},
  fetcher: async () => response({ ...delivered(compositeId), renderedText: { title: 'changed-by-provider', subtitle: plan.subtitle } }) }), /文字保存尚未确认/);

// Run the actual route with owned-storage and persist boundaries replaced by fixtures.
const { NextRequest } = nativeRequire('next/server');
let authorized = true, owned = true, readCount = 0, persistCount = 0;
const traceIds = [];
const route = load('src/app/api/cover/render/route.ts', {
  '@/lib/current-api-user': { authorizeCurrentApiUser: async () => authorized
    ? { ok: true, user: { userId: 'synthetic-user' } }
    : { ok: false, response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) } },
  '@/lib/auth': { getTokenFromHeaders: () => 'synthetic-token' },
  '@/storage/database/supabase-client': { getSupabaseClient: () => ({
    from: name => {
      assert.equal(name, 'user_files'); const filters = {}; let selection = '';
      const query = { select: value => { selection = value; return query; }, eq: (key, value) => { filters[key] = value; return query; }, order: () => query, limit: () => query,
        maybeSingle: async () => {
          assert.equal(filters.user_id, 'synthetic-user');
          if (selection.includes('storage_provider')) {
            assert.equal(filters.id, assetId); assert.equal(filters.file_category, 'image');
            return { data: owned ? { id: assetId, storage_key: 'owned/background.png', storage_provider: 'tencent_cos', file_size: background.length, content_type: 'image/png' } : null, error: null };
          }
          assert.equal(filters['meta->>clientTraceId']?.startsWith('cover_render_'), true);
          return { data: null, error: null };
        } };
      return query;
    },
    rpc: async (name, args) => {
      assert.equal(name, 'record_cover_composition'); assert.equal(args.p_user_id, 'synthetic-user');
      return { data: { asset_id: compositeId, hidden_at: null, task_no: 1, created_at: '2026-09-05T00:00:00Z' }, error: null };
    },
  }) },
  '@/storage/object': { storageManager: { read: async (key, provider) => { readCount++; assert.equal(key, 'owned/background.png'); assert.equal(provider, 'tencent_cos'); return background; } } },
  '@/lib/cover-composition-server': renderer,
  '@/app/api/image-workbench/persist/route': { POST: async request => {
    persistCount++; assert.equal(request.headers.get('authorization'), 'Bearer synthetic-token');
    const text = await request.text(); assert.equal(Number(request.headers.get('content-length')), Buffer.byteLength(text));
    const body = JSON.parse(text); traceIds.push(body.clientTraceId); assert.ok(body.url.startsWith('data:image/png;base64,'));
    return response({ status: 'completed', persisted: true, assetId: compositeId, key: 'owned/composite.png', url: '/composite.png', historyRecordId: 'synthetic-history' });
  } },
});
const request = (body = JSON.stringify({ sourceAssetId: assetId, plan })) => new NextRequest('http://127.0.0.1:5000/api/cover/render', { method: 'POST', body });
authorized = false; assert.equal((await route.POST(request())).status, 401); assert.equal(readCount, 0);
authorized = true; owned = false; assert.equal((await route.POST(request())).status, 404); assert.equal(readCount, 0); assert.equal(persistCount, 0);
owned = true; assert.equal((await route.POST(request('x'.repeat(262_145)))).status, 413); assert.equal(readCount, 0);
assert.equal((await route.POST(request(JSON.stringify({ sourceAssetId: assetId, plan: { ...plan, title: '' } })))).status, 400);
const firstResponse = await route.POST(request()), secondResponse = await route.POST(request());
assert.equal(firstResponse.status, 200); assert.equal(secondResponse.status, 200);
assert.equal(traceIds.length, 2); assert.equal(traceIds[0], traceIds[1], 'Repeated same composition uses the same persist key');
const body = await firstResponse.json(); assert.equal(body.renderedText.title, plan.title); assert.equal(body.nativeUpscaleApplied, false);
assert.ok(!JSON.stringify(body).includes('synthetic-token'));
const summary = { passed: true, actualRenderer: true, actualClientHelper: true, actualRoute: true, ChineseFontAvailable: true,
  noUpscaling: true, unchangedSource: true, deterministicPixels: true, normalGenerationPosts: 1, editingGenerationPosts: 0,
  ownerScopeAndInputBounds: true, stablePersistTrace: true, durableClaimPath: true, concurrentPendingPreserved: true,
  invalidTextPreventsAllRequests: true, mismatchedRenderRetainsOriginalNoReplay: true, realUpstreamCalls: 0 };
writeFileSync(`${directory}/fixture-summary.json`, JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
