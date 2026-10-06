import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseOptions, selectBindingRepresentatives, validatePreflight, chooseCanaryDuration, buildPayload, durableState, dispatchOnce } from './verify-hidden-video-models-e2e.mjs';

// Actual exported runner functions; all provider calls are injected in-memory.
// Temporary markers use a new fixture directory and never contain credentials.
const root = path.resolve('.codex-evidence/hidden-video-inventory-20260902/runner-fixtures', randomUUID());
await fs.mkdir(root, { recursive: true });
let passed = 0, posts = 0;
const validation = () => ({ success: true, localDatabaseOnly: true, validationKey: `vav_${'a'.repeat(64)}`, configurationHash: 'b'.repeat(64), healthEpoch: 'c'.repeat(64), confirmation: 'AUTHORIZE_ONE_REAL_VIDEO_CANARY', endpoint: '/api/video/generate',
  model: { id: 'hidden-fixture', publicId: 'pm_fixture', protocol: 'fixture', upstreamModel: 'fixture-model' }, readiness: { credentialReady: true, endpointConfigured: true },
  capabilities: { mode: 'text', minDuration: 1, maxDuration: 15 }, minimumInput: { imageCount: 0, audioCount: 0, firstFrameRequired: false, lastFrameRequired: false, sourceVideoRequired: false, promptRequired: true, requiresComputeLifecycle: false, aspectRatio: '16:9', resolution: '480p' } });
const plan = () => ({ validation: validation(), durationSeconds: 1, bindingHash: 'd'.repeat(64) });
async function test(name, callback) { await callback(); passed++; console.log('PASS ' + name); }
await test('plan is default, local previews only, explicit execute confirmation and bounded concurrency', () => {
  assert.equal(parseOptions([]).mode, 'plan'); assert.equal(parseOptions(['--origin=http://127.0.0.1:5002']).origin, 'http://127.0.0.1:5002');
  for (const args of [['--origin=https://production.example'], ['--origin=http://localhost:5000'], ['--concurrency=3'], ['--execute', '--run-id=fixture-run'], ['--execute', '--inspect']]) assert.throws(() => parseOptions(args));
});
await test('current supplier bindings group aliases but separate credentials, protocols and real model names', () => {
  const base = { id: 'a', protocol_type: 'newapi_video', model_name: 'veo-fixture', api_endpoint: 'https://fixture.example/v1', api_key: 'fixture-only-key', is_active: false, api_protocol_config: {} };
  const groups = selectBindingRepresentatives([base, { ...base, id: 'b', max_duration: 10 }, { ...base, id: 'c', api_key: 'other-fixture-key' }, { ...base, id: 'd', protocol_type: 'gaorui_video' }, { ...base, id: 'e', model_name: 'other-fixture-model' }]);
  assert.equal(groups.length, 4); assert.deepEqual(groups[0].aliasIds, ['b']); assert.ok(groups[0].aliasBoundary.includes('not individually accepted'));
  assert.equal(JSON.stringify(groups.map(({ representative, ...safe }) => ({ ...safe, id: representative.id }))).includes('fixture-only-key'), false);
});
await test('fresh proof must match the inspected model, hash, epoch and confirmation', () => {
  const old = validation(); assert.equal(validatePreflight(validation(), old.model.id, old).validationKey, old.validationKey);
  for (const patch of [{ validationKey: `vav_${'f'.repeat(64)}` }, { configurationHash: 'f'.repeat(64) }, { healthEpoch: 'f'.repeat(64) }, { confirmation: 'yes' }, { localDatabaseOnly: false }]) assert.throws(() => validatePreflight({ ...validation(), ...patch }, old.model.id, old));
});
await test('fixed-price range uses configured default while per-second uses the minimum', () => {
  const dto = validation(); dto.minimumInput.durationSeconds = 1; dto.capabilities.defaultDuration = 8;
  assert.equal(chooseCanaryDuration(dto, 'per_use'), 8); assert.equal(chooseCanaryDuration(dto, 'output_second'), 1);
});
await test('text payload is bound to original proof and has no fabricated reference fields', () => {
  const current = plan(), body = buildPayload(current, { images: [], audios: [] }, 'fixture-run');
  assert.equal(body.client_request_id, current.validation.validationKey); assert.equal(body.admin_validation_key, body.client_request_id); assert.equal(body.admin_validation, true);
  for (const field of ['image_url', 'last_frame_url', 'reference_image_urls', 'audio_url', 'source_video_url']) assert.equal(Object.hasOwn(body, field), false);
});
await test('first-last workflow requires two distinct real assets and maps both exact URLs', () => {
  const current = plan(); Object.assign(current.validation.minimumInput, { imageCount: 2, firstFrameRequired: true, lastFrameRequired: true }); current.validation.capabilities.mode = 'first_last_frame';
  const assets = { images: [{ id: 'image-a', url: 'https://fixture.example/first' }, { id: 'image-b', url: 'https://fixture.example/last' }], audios: [] };
  const body = buildPayload(current, assets, 'fixture-run'); assert.equal(body.image_url, assets.images[0].url); assert.equal(body.last_frame_url, assets.images[1].url);
  assert.throws(() => buildPayload(current, { ...assets, images: [assets.images[0], assets.images[0]] }, 'fixture-run'));
});
await test('lipsync maps owned image and audio without an unsupported prompt', () => {
  const current = plan(); Object.assign(current.validation.minimumInput, { imageCount: 1, audioCount: 1, promptRequired: false }); current.validation.capabilities.mode = 'image_audio_lipsync';
  const body = buildPayload(current, { images: [{ id: 'image-a', url: 'https://fixture.example/image' }], audios: [{ id: 'audio-a', url: 'https://fixture.example/audio' }] }, 'fixture-run');
  assert.equal(body.prompt, ''); assert.equal(body.audio_url, 'https://fixture.example/audio'); assert.deepEqual(body.reference_image_urls, ['https://fixture.example/image']);
});
await test('missing audio/source or compute lifecycle is blocked before dispatch', () => {
  for (const patch of [{ audioCount: 1 }, { sourceVideoRequired: true }, { requiresComputeLifecycle: true }]) { const current = plan(); Object.assign(current.validation.minimumInput, patch); assert.throws(() => buildPayload(current, { images: [], audios: [] }, 'fixture-run')); }
});
await test('provider completed or failed responses cannot invent a durable terminal state', () => {
  for (const response of [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }]) assert.equal(durableState({ status: 'finalizing' }, response), 'processing');
  assert.equal(durableState({ status: 'completed' }, { status: 'processing' }), 'completed');
  assert.equal(durableState(null, { status: 'completed' }), 'unknown-no-business-record');
  assert.equal(durableState(null, { task_submitted: false }), 'blocked-before-dispatch');
});
await test('two simultaneous actual dispatchers create one marker and invoke one POST', async () => {
  const current = plan(), saves = [], base = { claimsDir: path.join(root, 'concurrent-claims'), userHash: 'fixture-user-hash', plan: current, payload: buildPayload(current, { images: [], audios: [] }, 'fixture-run'), runId: 'fixture-run', save: async value => { saves.push(value); }, post: async () => { posts++; return { status: 200 }; } };
  const result = await Promise.allSettled([dispatchOnce({ ...base, modelDir: path.join(root, 'concurrent-a') }), dispatchOnce({ ...base, modelDir: path.join(root, 'concurrent-b') })]);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1); assert.equal(posts, 1); assert.deepEqual(saves.map(value => value.state), ['dispatch-marked', 'dispatched']);
});
await test('lost response keeps the original claim and prevents a new run or epoch POST', async () => {
  const current = plan(), base = { claimsDir: path.join(root, 'lost-claims'), modelDir: path.join(root, 'lost-a'), userHash: 'fixture-user-hash', plan: current, payload: buildPayload(current, { images: [], audios: [] }, 'fixture-run'), runId: 'fixture-run', save: async () => {}, post: async () => { posts++; throw new Error('Simulated response loss'); } };
  await assert.rejects(dispatchOnce(base), /Simulated response loss/u); const oldPosts = posts;
  const next = plan(); next.validation.healthEpoch = 'e'.repeat(64); next.validation.validationKey = `vav_${'e'.repeat(64)}`;
  await assert.rejects(dispatchOnce({ ...base, plan: next, modelDir: path.join(root, 'lost-b'), runId: 'another-run' }), error => error.code === 'EEXIST');
  assert.equal(posts, oldPosts); assert.equal(JSON.parse(await fs.readFile(path.join(root, 'lost-a/dispatch.json'), 'utf8')).clientRequestId, current.validation.validationKey);
});
await test('evidence persistence failure prevents POST and leaves a non-replayable claim', async () => {
  const current = plan(), before = posts;
  await assert.rejects(dispatchOnce({ claimsDir: path.join(root, 'save-fail-claims'), modelDir: path.join(root, 'save-fail'), userHash: 'fixture-user-hash', plan: current, payload: {}, runId: 'fixture-run', save: async () => { throw new Error('Simulated disk failure'); }, post: async () => { posts++; } }), /Simulated disk failure/u);
  assert.equal(posts, before); assert.ok(await fs.stat(path.join(root, 'save-fail/dispatch.json')));
});
console.log(JSON.stringify({ passed, failed: 0, realNetworkRequests: 0, realDatabaseWrites: 0, actualRunnerDispatchTested: true, injectedProviderCalls: posts, fixtureDirectory: root }));
