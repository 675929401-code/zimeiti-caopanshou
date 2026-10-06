import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await fs.readFile('src/components/admin-video-validation-state.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const module = { exports: {} };
vm.runInNewContext(compiled.outputText, { module, exports: module.exports, URL, Date, AbortSignal, JSON, Error, Number, String, Boolean,
  fetch() { throw new Error('REAL_NETWORK_FORBIDDEN'); } });
const helper = module.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const baseDto = {
  validationKey: `vav_${'a'.repeat(64)}`, configurationHash: 'b'.repeat(64), healthEpoch: 'c'.repeat(64), confirmation: 'CONFIRM_ONE_REAL_VIDEO_VALIDATION',
  model: { id: 'hidden-video-model', publicId: 'pm_fixture', displayName: '固定验证模型', upstreamModel: 'fixture-upstream-model' },
  readiness: { credentialReady: true, endpointConfigured: true },
  capabilities: { mode: 'text', supportsPrompt: true, showFirstFrame: false, showLastFrame: false, showReferenceImages: false, showAudioInputs: false, requiresFirstFrame: false, requiresLastFrame: false, minReferenceImages: 0, maxReferenceImages: 0, minReferenceAudios: 0, maxReferenceAudios: 0, requiresSourceVideo: false },
  minimumInput: { promptRequired: true, imageCount: 0, audioCount: 0, firstFrameRequired: false, lastFrameRequired: false, sourceVideoRequired: false, durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', requiresComputeLifecycle: false },
};
const fields = { prompt: '一片树叶缓慢飘落', firstFrame: '', lastFrame: '', images: [], audios: [], sourceVideo: '' };
let passed = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); passed++; }
function harness(response = { task_id: 'provider-task-1', business_task_id: 'business-task-1', model_id: baseDto.model.id, status: 'queued' }) {
  const records = new Map(), requests = [];
  const storage = { getItem: key => records.get(key) || null, setItem: (key, value) => records.set(key, value) };
  return { records, requests, storage, token: 'fixture-normal-admin-token',
    async fetcher(url, options) {
      assert.equal(url, '/api/video/generate'); assert.equal(options.method, 'POST');
      const saved = helper.readVideoValidationAttempt(storage, 'fixture-user', baseDto.model.id);
      assert.equal(saved.status, 'submitting', 'Stable proof is saved before dispatch');
      requests.push({ url, options });
      if (response instanceof Error) throw response;
      return Response.json(response, { status: response.httpStatus || 200 });
    },
  };
}
await test('fixed model and exact proof are sent once, saved before the request, without storing credentials', async () => {
  const io = harness(); const result = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  const body = JSON.parse(io.requests[0].options.body);
  assert.equal(io.requests.length, 1); assert.equal(body.model_id, baseDto.model.id);
  assert.equal(body.client_request_id, baseDto.validationKey); assert.equal(body.admin_validation_key, baseDto.validationKey); assert.equal(body.admin_validation, true);
  assert.equal(result.status, 'processing'); assert.equal(result.businessTaskId, 'business-task-1');
  assert.equal([...io.records.values()].join('').includes(io.token), false); assert.equal([...io.records.values()].join('').includes('Authorization'), false);
});
await test('rapid duplicate submissions share one saved request and do not send a second POST', async () => {
  const io = harness(); await Promise.all([helper.submitVideoValidation(baseDto, fields, 'fixture-user', io), helper.submitVideoValidation(baseDto, fields, 'fixture-user', io)]);
  assert.equal(io.requests.length, 1);
});
await test('network exception keeps unknown and the original key; reopening cannot create a second request', async () => {
  const io = harness(new TypeError('socket disconnected with PRIVATE_UPSTREAM_DETAILS'));
  const first = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  assert.equal(first.status, 'unknown'); assert.equal(first.proof.validationKey, baseDto.validationKey);
  assert.equal(JSON.stringify(first).includes('PRIVATE_UPSTREAM_DETAILS'), false);
  await helper.submitVideoValidation({ ...baseDto, validationKey: `vav_${'d'.repeat(64)}` }, fields, 'fixture-user', io);
  assert.equal(io.requests.length, 1); assert.equal(helper.readVideoValidationAttempt(io.storage, 'fixture-user', baseDto.model.id).proof.validationKey, baseDto.validationKey);
});
await test('HTTP unknown receipt retains both task IDs and is never automatically replayed', async () => {
  const io = harness({ task_id: 'vt_unknown', business_task_id: 'vt_unknown', status: 'pending', submission_outcome: 'unknown', task_submitted: null, httpStatus: 503 });
  const result = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  assert.equal(result.status, 'unknown'); assert.equal(result.businessTaskId, 'vt_unknown');
  await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io); assert.equal(io.requests.length, 1);
});
await test('storage write failure stops the request before it reaches the provider path', async () => {
  const io = harness(); io.storage.setItem = () => { throw new Error('QUOTA_EXCEEDED'); };
  await assert.rejects(helper.submitVideoValidation(baseDto, fields, 'fixture-user', io)); assert.equal(io.requests.length, 0);
});
await test('required prompt and missing configured inputs fail before dispatch', async () => {
  const io = harness(); await assert.rejects(helper.submitVideoValidation(baseDto, { ...fields, prompt: '' }, 'fixture-user', io)); assert.equal(io.requests.length, 0);
  const dto = clone(baseDto); Object.assign(dto.minimumInput, { firstFrameRequired: true, lastFrameRequired: true, imageCount: 2 }); dto.capabilities.maxReferenceImages = 2;
  assert.throws(() => helper.buildVideoValidationRequest(dto, fields));
  assert.throws(() => helper.buildVideoValidationRequest(dto, { ...fields, firstFrame: 'https://assets.example/first.png' }));
});
await test('first and last frames occupy distinct fields, with no duplicate reference count', () => {
  const dto = clone(baseDto); Object.assign(dto.minimumInput, { firstFrameRequired: true, lastFrameRequired: true, imageCount: 2 }); dto.capabilities.maxReferenceImages = 2;
  const body = helper.buildVideoValidationRequest(dto, { ...fields, firstFrame: 'https://assets.example/first.png', lastFrame: 'https://assets.example/last.png' });
  assert.equal(body.image_url, 'https://assets.example/first.png'); assert.equal(body.last_frame_url, 'https://assets.example/last.png'); assert.deepEqual(clone(body.reference_image_urls), []);
});
await test('audio-only no-prompt and source-video contracts use their actual minimum requirements', () => {
  const dto = clone(baseDto); Object.assign(dto.minimumInput, { promptRequired: false, audioCount: 1, sourceVideoRequired: true }); dto.capabilities.maxReferenceAudios = 1;
  assert.throws(() => helper.buildVideoValidationRequest(dto, { ...fields, prompt: '' }));
  const body = helper.buildVideoValidationRequest(dto, { ...fields, prompt: '', audios: ['https://assets.example/audio.wav'], sourceVideo: 'https://assets.example/source.mp4' });
  assert.equal(body.prompt, ''); assert.equal(body.source_video_url, 'https://assets.example/source.mp4'); assert.deepEqual(clone(body.reference_audio_urls), ['https://assets.example/audio.wav']);
});
await test('text-only models reject extra images and credential-bearing reference URLs are rejected', () => {
  assert.throws(() => helper.buildVideoValidationRequest(baseDto, { ...fields, firstFrame: 'https://assets.example/a.png' }));
  const dto = clone(baseDto); dto.capabilities.maxReferenceImages = 1;
  for (const url of ['http://assets.example/a.png', ['https://', 'user:password@assets.example/a.png'].join(''), 'data:image/png;base64,AAA']) assert.throws(() => helper.buildVideoValidationRequest(dto, { ...fields, images: [url] }));
});
await test('missing credentials and another active claim prevent any POST', async () => {
  for (const dto of [{ ...baseDto, readiness: { credentialReady: false, endpointConfigured: true } }, { ...baseDto, busy: true }]) {
    const io = harness(); await assert.rejects(helper.submitVideoValidation(dto, fields, 'fixture-user', io)); assert.equal(io.requests.length, 0);
  }
});
await test('server receipt for another model remains unknown and cannot overwrite original identity', async () => {
  const io = harness({ task_id: 'wrong-task', model_id: 'different-model', status: 'completed' });
  const attempt = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  assert.equal(attempt.status, 'unknown'); assert.equal(attempt.proof.model.id, baseDto.model.id); assert.equal(attempt.taskId, '');
});
await test('only explicit unsubmitted rejection can retry corrected inputs under the same proof', async () => {
  const io = harness({ error: '字段未通过', task_submitted: false, httpStatus: 400 });
  const first = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io); assert.equal(first.status, 'failed'); assert.equal(first.notSubmitted, true);
  await helper.submitVideoValidation(baseDto, { ...fields, prompt: '修正后的场景描述' }, 'fixture-user', io); assert.equal(io.requests.length, 2);
  const unknown = harness({ error: '网关异常', httpStatus: 503 }); await helper.submitVideoValidation(baseDto, fields, 'fixture-user', unknown); await helper.submitVideoValidation(baseDto, fields, 'fixture-user', unknown); assert.equal(unknown.requests.length, 1);
});
await test('successful status recovery preserves original proof for publishing and never generates', async () => {
  const io = harness(); const before = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  const completed = helper.updateVideoValidationReceipt(before, { status: 'completed', taskId: before.taskId });
  helper.saveVideoValidationAttempt(io.storage, completed);
  const publish = helper.buildVideoValidationPublishRequest(helper.readVideoValidationAttempt(io.storage, 'fixture-user', baseDto.model.id));
  assert.equal(publish.taskId, 'business-task-1'); assert.equal(publish.healthEpoch, baseDto.healthEpoch); assert.equal(publish.configurationHash, baseDto.configurationHash); assert.equal(publish.clientRequestId, baseDto.validationKey); assert.equal(publish.confirmation, 'PUBLISH_VALIDATED_VIDEO_MODEL'); assert.equal(io.requests.length, 1);
  assert.throws(() => helper.buildVideoValidationPublishRequest(before));
});
await test('records are scoped to the current user and corrupt records fail closed', async () => {
  const io = harness(); await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  assert.equal(helper.readVideoValidationAttempt(io.storage, 'different-user', baseDto.model.id), null);
  io.storage.setItem(helper.videoValidationStorageKey('fixture-user', baseDto.model.id), '{broken');
  await assert.rejects(helper.submitVideoValidation(baseDto, fields, 'fixture-user', io)); assert.equal(io.requests.length, 1);
});
await test('completed without any task receipt remains unknown instead of displaying a false result', async () => {
  const io = harness({ status: 'completed' }); const result = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io); assert.equal(result.status, 'unknown');
});
await test('a failed status lookup cannot turn an already accepted task into a retryable failure', async () => {
  const io = harness(); const accepted = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  const lookup = helper.updateVideoValidationReceipt(accepted, { error: '状态暂时不可读', task_submitted: false }, false);
  assert.equal(lookup.status, 'unknown'); assert.equal(lookup.taskId, accepted.taskId); assert.equal(lookup.notSubmitted, false);
});
await test('provider-completed asset persistence failure stays finalizing under the original task', async () => {
  const io = harness(); const accepted = await helper.submitVideoValidation(baseDto, fields, 'fixture-user', io);
  const finalizing = helper.updateVideoValidationReceipt(accepted, { status: 'finalizing', errorCode: 'VIDEO_ASSET_PERSISTENCE_FAILED', errorMessage: '保存视频时连接中断', retryable: true }, false);
  assert.equal(finalizing.status, 'finalizing'); assert.equal(finalizing.taskId, accepted.taskId); assert.equal(finalizing.businessTaskId, accepted.businessTaskId);
  helper.saveVideoValidationAttempt(io.storage, finalizing);
  await helper.submitVideoValidation({ ...baseDto, validationKey: `vav_${'d'.repeat(64)}` }, fields, 'fixture-user', io);
  assert.equal(io.requests.length, 1); assert.equal(helper.videoValidationIsTerminal(finalizing), false);
});
const directory = '.codex-evidence/admin-video-validation-ui-20260903'; await fs.mkdir(directory, { recursive: true });
await fs.writeFile(`${directory}/fixture-summary.json`, JSON.stringify({ passed, source: 'actual admin-video-validation-state helper', realUpstreamCalls: 0, databaseWrites: 0 }, null, 2));
console.log(JSON.stringify({ passed, realUpstreamCalls: 0 }));
