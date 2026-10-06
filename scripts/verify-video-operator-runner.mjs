import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { selectOperatorRetest, operatorRetestControls, ownedPublicSource, probeOwnedPublicSource, AUTODL_PUBLIC_RESULT_HOST } from './lib/video-operator-retest-plan.mjs';

const actualRunner = (await fs.readFile('scripts/verify-video-all-models-e2e.mjs', 'utf8')).replace(/^import .+;\r?\n/gmu, '');
const editId = 'omni-video-edit-chA';
const grokId = 'grok-imagine-1.5-15s-ch3';
const publicUrl = `https://${AUTODL_PUBLIC_RESULT_HOST}/fixture-existing-video.mp4`;
const imageUrl = 'https://fixture-private-cos.example/image.png?signature=fixture-signature';
const sourceId = 'vt_existingfixturevideo';
const sourceRow = { id: sourceId, user_id: 'fixture-user', model_id: 'minimax-h3-autodl-hosted', status: 'completed', provider_result_url: publicUrl, duration_seconds: 1 };
const models = [editId, grokId, ...Array.from({ length: 11 }, (_, i) => `other-${i}`)].map(id => ({ id, name: `Display ${id}`, model_name: `upstream-${id}`, protocol_type: 'fixture-protocol', price_per_use: 0.1, cost_price: 0.01, api_endpoint: 'https://fixture-provider.example/v1', api_protocol_config: {}, is_active: true, supports_image_input: id === grokId, requires_image: false }));
const catalog = models.map(row => ({ internalId: row.id, publicId: `pm_${row.id}` }));
const key = 'channel-recovery-fixture-original-epoch';
const args = (overrides = []) => ['--operator-retest', '--models=' + editId, '--reason=修复来源视频读取兼容', '--run-id=fixture-retest-one', '--public-source-task=' + sourceId, '--confirm-operator-retest-authorized', ...overrides];
const normalize = filename => path.resolve(filename).replace(/\\/gu, '/');
function missing() { return Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }

async function execute(argv, options = {}) {
  const files = options.files || new Map(); const calls = []; const posts = []; const logs = []; let healthReads = 0;
  const json = (value, status = 200) => Response.json(value, { status });
  const io = {
    async readFile(filename) {
      const normalized = normalize(filename);
      if (files.has(normalized)) return files.get(normalized);
      if (normalized.endsWith('/runtime.json')) return JSON.stringify({ supabaseUrl: 'http://127.0.0.1:54321', serviceRoleKey: 'fixture-db-secret' });
      if (normalized.endsWith('/reviewed-catalog-13.json')) return JSON.stringify({ models: catalog });
      throw missing();
    },
    async writeFile(filename, content, settings) { const normalized = normalize(filename); if (settings?.flag === 'wx' && files.has(normalized)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); files.set(normalized, String(content)); },
    async access(filename) { if (!files.has(normalize(filename))) throw missing(); },
    async mkdir() {},
  };
  const context = {
    assert, fs: io, path, createHash, randomUUID, selectOperatorRetest, operatorRetestControls, ownedPublicSource, probeOwnedPublicSource,
    publicModelDisplayName: row => row.name,
    getVideoInputContract: row => ({ requiresSourceVideo: row.id === editId, requiresFirstFrame: false, requiresLastFrame: false, minReferenceImages: 0, maxReferenceImages: row.supports_image_input ? 5 : 0, minReferenceAudios: 0, maxReferenceAudios: 0, mode: 'single', supportsPrompt: true }),
    getVideoDurationCapabilities: () => ({ minDuration: 1, maxDuration: 10, defaultDuration: 1, mode: 'range' }),
    getVideoResolutionCapabilities: () => ({ options: ['480p'], publicPrices: {} }), parseAutodlH3AssetRef: () => null,
    process: { argv: ['node', 'actual-runner', ...argv], env: { LOCAL_NAV_ADMIN_TOKEN: 'fixture-normal-session' }, exit: () => { throw new Error('PLAN_EXIT'); } },
    console: { log: line => logs.push(String(line)) }, URL, URLSearchParams, AbortSignal, Response, Buffer, Date, Map, Set, Promise, Object, Array, Number, String, JSON, RegExp, Error,
    setTimeout: callback => { callback(); return 0; },
    async fetch(input, init = {}) {
      const url = new URL(input); const method = init.method || 'GET'; calls.push({ host: url.host, pathname: url.pathname, method });
      if (url.hostname === AUTODL_PUBLIC_RESULT_HOST) {
        assert.equal(init.redirect, 'manual'); assert.equal(init.headers?.Authorization, undefined);
        if (options.sourceHttp) return new Response('', { status: options.sourceHttp });
        return method === 'HEAD' ? new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '2000' } }) : new Response(Buffer.alloc(1024), { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '1024', 'content-range': 'bytes 0-1023/2000' } });
      }
      if (url.port === '54321') {
        assert.equal(method, 'GET'); const table = url.pathname.split('/').at(-1);
        if (table === 'users') return json([{ id: 'fixture-user' }]);
        if (table === 'video_models') return json(models);
        if (table === 'user_files') return json([{ id: 'fixture-image-file', storage_key: 'fixture-owned-key', storage_provider: 'tencent_cos', content_type: 'image/png' }]);
        if (table === 'video_tasks') {
          if (url.searchParams.get('select').includes('provider_result_url')) return json([{ ...sourceRow, ...(options.sourcePatch || {}) }]);
          if (options.unknown || (!posts.length && !options.reconcile)) return json([]);
          const payload = posts[0]?.payload || { model_id: editId };
          return json([{ id: 'vt_fixture_result', model_id: payload.model_id, task_id_external: 'provider-fixture-task', status: 'failed', billing_state: 'not_required', price_charged: 0, storage_url: null, duration_seconds: 1, resolution: '480p' }]);
        }
      }
      assert.equal(url.origin, 'http://127.0.0.1:5000', 'Unexpected network destination');
      if (url.pathname === '/api/auth/me') return json({ user: { id: 'fixture-user', role: 'admin' } });
      if (url.pathname === '/api/video/models') return json({ models: models.map(row => ({ id: `pm_${row.id}`, displayName: row.name })) });
      if (url.pathname === '/api/video/channel-health') { healthReads++; return json({ channels: models.map(row => ({ channelId: row.id, productionBlocked: true, operatorRetestKey: options.changedEpoch && healthReads > 1 ? 'different-health-epoch' : key, recoveryCanaryEligible: false, circuitState: 'open' })), recoveryPolicy: { confirmation: 'fixture-confirmation' } }); }
      if (url.pathname === '/api/file') return json({ url: imageUrl });
      if (url.pathname.endsWith('/content')) return new Response(Buffer.alloc(1024), { status: 206, headers: { 'content-type': 'image/png' } });
      if (url.pathname === '/api/video/generate') {
        assert.equal(method, 'POST'); const payload = JSON.parse(init.body);
        assert.ok([...files.keys()].some(filename => filename.includes('/operator-retest-claims/')), 'Epoch claim must precede the actual POST');
        assert.ok([...files.keys()].some(filename => filename.endsWith('/dispatch.json')), 'Dispatch marker must precede the actual POST');
        posts.push({ payload, headers: init.headers });
        if (options.unknown) throw new Error('fixture response lost after server accepted');
        return json({ task_id: 'provider-fixture-task', business_task_id: 'vt_fixture_result', status: 'pending', model_id: payload.model_id });
      }
      throw new Error('Unexpected fixture endpoint');
    },
  };
  let error;
  try { await vm.runInNewContext(`(async () => { ${actualRunner}\n})()`, context); }
  catch (caught) { if (!(caught.message === 'PLAN_EXIT' && argv.includes('--inspect'))) error = caught; }
  return { files, calls, posts, logs, error };
}

let passed = 0;
async function test(name, callback) { await callback(); passed++; console.log('PASS ' + name); }
await test('default plan performs no network and no writes', async () => { const result = await execute([]); assert.equal(result.error?.message, 'PLAN_EXIT'); assert.equal(result.calls.length, 0); assert.equal(result.files.size, 0); });
await test('missing, multiple, unknown models and missing reason fail before network', async () => {
  for (const patch of [args().filter(arg => !arg.startsWith('--models=')), args().map(arg => arg.startsWith('--models=') ? '--models=' + editId + ',' + grokId : arg), args().map(arg => arg.startsWith('--models=') ? '--models=not-reviewed' : arg), args().filter(arg => !arg.startsWith('--reason='))]) {
    const result = await execute(patch); assert.ok(result.error); assert.equal(result.calls.length, 0); assert.equal(result.posts.length, 0);
  }
});
await test('inspect accepts only one existing public owned source and never dispatches', async () => {
  const result = await execute([...args(), '--inspect']); assert.equal(result.error, undefined); assert.equal(result.posts.length, 0);
  assert.equal(result.calls.filter(call => call.host === AUTODL_PUBLIC_RESULT_HOST).length, 2);
  const inventory = JSON.parse([...result.files.entries()].find(([filename]) => filename.endsWith('/inspect-inventory.json'))[1]); assert.equal(inventory.plans.length, 1); assert.equal(inventory.assets.sourceVideoProbes[1].bytes, 1024);
});
await test('actual operator dispatch preserves epoch key, reason, model and source while excluding raw URLs from evidence', async () => {
  const result = await execute(args()); assert.equal(result.error, undefined); assert.equal(result.posts.length, 1);
  const { payload, headers } = result.posts[0]; assert.equal(payload.model_id, editId); assert.equal(payload.client_request_id, key); assert.equal(payload.health_recovery_key, key); assert.equal(headers['Idempotency-Key'], key); assert.equal(payload.health_operator_retest, true); assert.equal(payload.health_operator_retest_reason, '修复来源视频读取兼容'); assert.equal(payload.source_video_url, publicUrl);
  const evidence = [...result.files.values()].join('\n'); assert.ok(!evidence.includes(publicUrl) && !evidence.includes('fixture-normal-session') && !evidence.includes('fixture-db-secret'));
});
await test('explicit image retest adds one owned image and does not fetch unrelated source video', async () => {
  const input = args().filter(arg => !arg.startsWith('--public-source-task=')).map(arg => arg.startsWith('--models=') ? '--models=' + grokId : arg);
  const result = await execute([...input, '--with-reference-image']); assert.equal(result.error, undefined); assert.equal(result.posts.length, 1); assert.equal(result.posts[0].payload.image_url, imageUrl); assert.equal(result.posts[0].payload.source_video_url, undefined); assert.equal(result.calls.some(call => call.host === AUTODL_PUBLIC_RESULT_HOST), false);
  assert.equal([...result.files.values()].some(content => content.includes(imageUrl)), false);
});
await test('changed health epoch before marker blocks all submissions and does not adopt a new key', async () => { const result = await execute(args(), { changedEpoch: true }); assert.equal(result.posts.length, 0); assert.ok([...result.files.values()].some(content => content.includes('Health epoch changed'))); assert.equal([...result.files.keys()].some(filename => filename.includes('/operator-retest-claims/')), false); });
await test('wrong owner, nonterminal task, untrusted model, signed/private URLs and excessive duration block before POST', async () => {
  for (const sourcePatch of [{ user_id: 'other-owner' }, { status: 'processing' }, { model_id: 'untrusted-provider' }, { provider_result_url: publicUrl + '?q-signature=fixture' }, { provider_result_url: 'http://127.0.0.1/private.mp4' }, { provider_result_url: 'https://another.example/private.mp4' }, { duration_seconds: 31 }]) {
    const result = await execute(args(), { sourcePatch }); assert.ok(result.error); assert.equal(result.posts.length, 0);
  }
});
await test('HTTP redirects and forbidden public source probes cannot dispatch', async () => { for (const sourceHttp of [302, 403]) { const result = await execute(args(), { sourceHttp }); assert.ok(result.error); assert.equal(result.posts.length, 0); } });
await test('lost response retains original key and blocks a second POST in the same run', async () => {
  const first = await execute(args(), { unknown: true }); assert.equal(first.posts.length, 1);
  const second = await execute(args(), { unknown: true, files: first.files }); assert.equal(second.posts.length, 0);
  assert.ok([...first.files.values()].some(content => content.includes('unknown-no-business-record')));
});
await test('one epoch cannot be dispatched from a different run directory after an unknown response', async () => {
  const first = await execute(args(), { unknown: true });
  const second = await execute(args().map(arg => arg.startsWith('--run-id=') ? '--run-id=fixture-retest-second' : arg), { unknown: true, files: first.files });
  assert.equal(second.posts.length, 0); assert.ok([...second.files.values()].some(content => content.includes('OPERATOR_EPOCH_ALREADY_MARKED')));
});
await test('reconcile uses frozen retest inventory without health, source reads or new POST', async () => {
  const first = await execute(args());
  const result = await execute(['--reconcile', '--run-id=fixture-retest-one', '--confirm-operator-retest-authorized'], { files: first.files, reconcile: true, changedEpoch: true });
  assert.equal(result.error, undefined); assert.equal(result.posts.length, 0); assert.equal(result.calls.some(call => call.pathname === '/api/video/channel-health'), false); assert.equal(result.calls.some(call => call.host === AUTODL_PUBLIC_RESULT_HOST), false);
});
await test('secrets and URL-shaped audit reasons are rejected', async () => { for (const reason of ['https://private.example/video?token=secret', 'Bearer fixture-token', 'sk-secretfixture']) assert.throws(() => selectOperatorRetest({ modelIds: [editId], reason, reviewedModels: catalog })); });
console.log(JSON.stringify({ passed, failed: 0, realNetworkRequests: 0, realDatabaseWrites: 0, actualRunnerExecutedWithIsolatedDependencies: true }));
