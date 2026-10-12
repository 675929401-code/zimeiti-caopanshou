import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
assert.equal(process.version, 'v24.19.0');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function load(file, deps = {}, globals = {}) {
  const module = { exports: {} };
  runInNewContext(compile(readFileSync(file, 'utf8')), { module, exports: module.exports, URL, Buffer, console, Date, require: name => { if (name in deps) return deps[name]; throw Error('Unmocked dependency ' + name); }, ...globals });
  return module.exports;
}
const refs = load('src/lib/generated-image-reference.ts', { zod: { z } });
const reference = digit => ({ schema: 'generated_image_ref.v1', recordId: digit.repeat(64) });
const a = reference('a'), b = reference('b'), c = reference('c');
const uri = value => refs.generatedImageReferenceUri(value);
const legacy = 'https://legacy.invalid/upload.png';
const body = { image_ref: a, last_frame_ref: b, reference_image_ref: c, reference_image_inputs: [legacy, a, b] };
const parsed = refs.parseGeneratedVideoImageInputs(body);
assert.deepEqual([...parsed.typed.keys()], ['image_url', 'last_frame_url', 'reference_image_url', 'reference_image_urls[1]', 'reference_image_urls[2]']);
assert.equal(parsed.referenceImageUrls[0], legacy);
assert.equal(parsed.referenceImageUrls[1], uri(a));
for (const bad of [
  { image_ref: a, image_url: '' }, { image_ref: a, image_storage_key: '' },
  { last_frame_ref: b, last_frame_url: '' }, { reference_image_ref: c, reference_image_url: '' },
  { reference_image_inputs: [], reference_image_urls: [] }, { reference_image_inputs: [uri(a)] },
  { last_frame_ref: { ...b, userId: 'other' } }, { reference_image_inputs: [{ ...c, url: legacy }] },
]) assert.throws(() => refs.parseGeneratedVideoImageInputs(bad));

const storage = new Map(); let userId = 'owner'; let time = 100_000;
class FixedDate extends Date { static now() { return time; } }
const fakeWindow = { sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, localStorage: { removeItem() {} }, dispatchEvent() {} };
const draft = load('src/lib/video-workflow-draft.ts', {
  '@/lib/generated-image-reference': refs,
  '@/lib/workbench-user-storage': { readBrowserWorkbenchIdentity: () => ({ userId }), workbenchUserStorageKey: (key, user) => key + ':' + user },
}, { window: fakeWindow, CustomEvent: class {}, Date: FixedDate });
const prompt = 'Draw label data: value, a long English prompt. '.repeat(300);
let saved = draft.mergeVideoWorkflowDraft([{ order: 1, prompt, imageRef: a, imageTarget: 'first-frame' }, { order: 1, imageRef: b, imageTarget: 'last-frame' }, { order: 2, imageRef: c }], 'first-last');
assert.equal(saved.slots[0].prompt, prompt.trim());
assert.equal(saved.slots[0].firstFrameImageRef.recordId, a.recordId);
assert.equal(saved.slots[0].lastFrameImageRef.recordId, b.recordId);
assert.equal(JSON.stringify(saved).includes('blob:'), false);
saved = draft.mergeVideoWorkflowDraft([{ order: 1, imageUrl: legacy, imageTarget: 'first-frame' }]);
assert.equal(saved.slots[0].firstFrameImageRef, undefined);
assert.equal(saved.slots[0].firstFrameUrl, legacy);
saved = draft.mergeVideoWorkflowDraft([{ order: 1, clearImageTarget: 'last-frame' }]);
assert.equal(saved.slots[0].lastFrameImageRef, undefined);
assert.equal(saved.slots[0].lastFrameUrl, undefined);
assert.throws(() => draft.mergeVideoWorkflowDraft([{ order: 1, imageRef: a, imageUrl: '' }]));
for (const url of ['data:image/png;base64,AA==', 'blob:fixture', '/api/media-history/content?recordId=x', 'https://app.invalid/api/media-history/content?recordId=x']) assert.throws(() => draft.mergeVideoWorkflowDraft([{ order: 1, imageUrl: url }]));
const slot = draft.projectVideoWorkflowSlot({ order: 1, updatedAt: time, prompt, nested: { payload: 'AA==' }, bytes: [1, 2, 3], firstFrameImageRef: a });
assert.equal(slot.prompt, prompt); assert.equal('nested' in slot, false); assert.equal('bytes' in slot, false);
userId = 'other'; assert.equal(draft.readVideoWorkflowDraft(), null); userId = 'owner';
time += draft.VIDEO_WORKFLOW_DRAFT_TTL_MS + 1; assert.equal(draft.readVideoWorkflowDraft(), null);
const mapped = draft.videoWorkflowImageRequestFields({ imageUrl: uri(a), lastFrameUrl: uri(b), referenceImageUrl: uri(c), referenceImageUrls: [legacy, uri(a), uri(b)] });
assert.equal(mapped.image_ref.recordId, a.recordId); assert.equal('image_url' in mapped, false);
assert.equal(mapped.last_frame_ref.recordId, b.recordId); assert.equal('last_frame_url' in mapped, false);
assert.equal(mapped.reference_image_ref.recordId, c.recordId);
assert.equal(mapped.reference_image_inputs[0], legacy); assert.equal(mapped.reference_image_inputs[2].recordId, b.recordId);
assert.equal('reference_image_urls' in mapped, false);
assert.equal(draft.videoWorkflowImageRequestFields({ imageUrl: uri(a), lastFrameUrl: legacy }).last_frame_url, legacy);
let bitmapClosed = 0, drawArguments;
const preview = load('src/lib/video-workflow-draft.ts', { '@/lib/generated-image-reference': refs, '@/lib/workbench-user-storage': {} }, {
  createImageBitmap: async () => ({ width: 16, height: 16, close: () => bitmapClosed++ }),
  document: { createElement: () => ({ getContext: () => ({ drawImage: (...args) => { drawArguments = args; } }), toBlob: callback => callback(new Blob(['cropped'], { type: 'image/png' })) }) }, Blob,
});
const cropReference = { ...a, transform: { kind: 'crop', x: 2, y: 3, width: 4, height: 5 } };
assert.equal((await preview.generatedVideoPreviewBlob(new Blob(['fixture'], { type: 'image/png' }), cropReference)).type, 'image/png');
assert.deepEqual(drawArguments.slice(1), [2, 3, 4, 5, 0, 0, 4, 5]); assert.equal(bitmapClosed, 1);
await assert.rejects(preview.generatedVideoPreviewBlob(new Blob(['fixture'], { type: 'image/png' }), { ...cropReference, transform: { ...cropReference.transform, width: 99 } })); assert.equal(bitmapClosed, 2);

const source = readFileSync('src/app/api/video/generate/route.ts', 'utf8');
const gate = source.slice(source.indexOf('    let effectiveImageUrl = image_url;'), source.indexOf('    // 新版 AutoDL ComfyUI workflow'));
const server = load('src/lib/server/generated-image-reference.ts', { '@/lib/generated-image-reference': refs, '@/storage/database/supabase-client': {}, '@/lib/video-public-url': {}, '@/lib/safe-fetch': {} });
let version = 1, reserves = 0, providerPosts = 0, bridges = 0, ownerChecks = 0;
async function execute(body, options = {}) {
  const inputs = refs.parseGeneratedVideoImageInputs(body); const module = { exports: {} };
  const context = { module, image_url: inputs.imageUrl, last_frame_url: inputs.lastFrameUrl, reference_image_url: inputs.referenceImageUrl,
    referenceImageUrls: inputs.referenceImageUrls || [], generatedInputs: inputs, userId: 'owner', useAutodlH3Lifecycle: options.queue || false,
    selectedModel: { protocol_type: options.protocol || 'secure_skill_video', supports_image_input: true }, selectedProtocolConfig: { request_format: options.multipart ? 'multipart' : 'json' },
    generatedImageReferenceUri: refs.generatedImageReferenceUri, GeneratedImageReferenceError: server.GeneratedImageReferenceError,
    isAutodlComfyuiHostedProtocol: value => value === 'hosted',
    resolveGeneratedImageReference: async ({ userId, reference }) => { ownerChecks++; assert.equal(userId, 'owner'); if (reference.recordId === options.forbidden) throw new server.GeneratedImageReferenceError('GENERATED_IMAGE_NOT_OWNED', 'not owned', 403); return `https://fixture.cos.ap-test.myqcloud.com/${reference.recordId}?sig=${version}`; },
    readGeneratedImageMaterial: async () => { ownerChecks++; return {}; },
    NextResponse: { json: (body, init) => ({ body, status: init.status }) },
    audio_url: '', source_video_url: '', referenceAudioUrls: [], image_storage_key: '',
    hasAnyVideoReference: values => Object.values(values).some(value => Array.isArray(value) ? value.length : Boolean(value)),
    isTencentCosAssetUrl: value => value.includes('.myqcloud.com/'), bridgeVideoProviderAsset: async () => { bridges++; throw Error('Implicit upload forbidden'); },
    reserve: () => { reserves++; }, submit: () => { providerPosts++; },
  };
  runInNewContext(compile(`module.exports=async()=>{${gate};reserve();submit();return {imageUrl:effectiveImageUrl,lastFrameUrl:effectiveLastFrameUrl,referenceImageUrl:effectiveReferenceImageUrl,imageUrls:effectiveReferenceImageUrls};}`), context);
  return module.exports();
}
let result = await execute(body);
assert.equal(result.imageUrls[0], legacy); assert.ok(result.imageUrls[1].includes(a.recordId)); assert.ok(result.lastFrameUrl.includes(b.recordId));
assert.equal(bridges, 0); assert.equal(reserves, 1); assert.equal(providerPosts, 1);
for (const forbidden of [a.recordId, b.recordId, c.recordId]) { const before = reserves; const failed = await execute(body, { forbidden }); assert.equal(failed.status, 403); assert.equal(reserves, before); assert.equal(providerPosts, before); }
const listOnly = { reference_image_inputs: [legacy, a] };
assert.equal((await execute(listOnly, { forbidden: a.recordId })).status, 403);
const beforeHosted = reserves; assert.equal((await execute({ last_frame_ref: b }, { protocol: 'hosted' })).status, 422); assert.equal(reserves, beforeHosted); assert.equal(bridges, 0);
for (const mixed of [{ image_ref: a, last_frame_url: legacy }, { image_url: legacy, reference_image_ref: b }, { image_ref: a, reference_image_inputs: [legacy] }, { last_frame_ref: b }]) {
  const before = reserves, checks = ownerChecks; assert.equal((await execute(mixed, { protocol: 'newapi_video', multipart: true })).status, 422); assert.equal(reserves, before); assert.equal(ownerChecks, checks);
}
assert.equal((await execute({ image_ref: a }, { protocol: 'newapi_video', multipart: true })).imageUrl, uri(a));
const adapterSource = readFileSync('src/lib/video-adapter.ts', 'utf8');
const adapterText = adapterSource.slice(adapterSource.indexOf('async function generateNewApiVideo('), adapterSource.indexOf('/** New API (openclaw) 轮询'));
const adapterModule = { exports: {} }; let adapterPosts = 0;
runInNewContext(compile(adapterText + '\nmodule.exports=generateNewApiVideo;'), { module: adapterModule, FormData, Blob, AbortSignal, safeStr: value => String(value || ''), videoSubmissionUnknown: () => ({ status: 'unknown' }), fetch: async (_url, init) => {
  adapterPosts++; assert.equal(init.method, 'POST'); const payload = JSON.parse(init.body);
  assert.equal(payload.images[0], result.imageUrl); assert.equal(payload.images[1], result.lastFrameUrl); assert.equal(payload.images[2], result.referenceImageUrl); assert.equal(payload.images[3], legacy);
  return Response.json({ id: 'mock-provider-task' });
} });
assert.equal((await adapterModule.exports({ api_endpoint: 'https://adapter.invalid/v1', api_key: 'synthetic', model_name: 'fixture', supports_image_input: true, api_protocol_config: {} }, { ...result, prompt })).taskId, 'mock-provider-task'); assert.equal(adapterPosts, 1);

// Execute the real route fingerprint/snapshot statements with mocked persistence only.
const fingerprintCode = source.slice(source.indexOf('    const requestFingerprint = buildVideoRequestFingerprint(', source.indexOf('    const adapterParams:')), source.indexOf('    const dispatch ='));
const snapshotCode = source.slice(source.indexOf('    const requestSnapshot = buildVideoGenerationRequestSnapshot(', source.indexOf('    const adapterParams:')), source.indexOf('    const reservation = await reserveVideoGenerationTask(', source.indexOf('    const adapterParams:')));
function persisted(fresh) {
  const module = { exports: {} }, fields = refs.parseGeneratedVideoImageInputs(body);
  const globals = { module, generatedInputs: fields, generatedImageUri: uri(a), image_url: fields.imageUrl, last_frame_url: fields.lastFrameUrl, reference_image_url: fields.referenceImageUrl, referenceImageUrls: fields.referenceImageUrls,
    effectiveImageUrl: fresh.imageUrl, effectiveLastFrameUrl: fresh.lastFrameUrl, effectiveReferenceImageUrl: fresh.referenceImageUrl, effectiveReferenceImageUrls: fresh.imageUrls,
    channelConfig: { id: 'model', protocol_type: 'fixture' }, executionPrompt: prompt, prompt, promptNormalizations: [], negative_prompt: '', effectiveAudioUrl: '', effectiveReferenceAudioUrls: [], effectiveSourceVideoUrl: '', body,
    generateAudio: undefined, videoTiming: { target: 5, submit: 5 }, aspect_ratio: '16:9', selectedResolution: '720p', dispatch: undefined, adapterParams: fresh, image_storage_key: '', audio_url: '', referenceAudioUrls: [], source_video_url: '', ownedPageAssetRefs: new Map(),
    snapshotFps: null, snapshotSeed: null, snapshotGenerateAudio: null, publicRequestedModelId: 'public-model', routingSnapshot: { configVersion: 'a'.repeat(64) },
    buildVideoRequestFingerprint: input => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'), buildVideoGenerationRequestSnapshot: input => input, buildVideoRequestAssetRefs: input => input };
  runInNewContext(compile(`${fingerprintCode}\n${snapshotCode}\nmodule.exports={requestFingerprint,requestSnapshot};`), globals);
  return module.exports;
}
const first = persisted(result); version++; const second = persisted(await execute(body));
assert.equal(first.requestFingerprint, second.requestFingerprint);
assert.equal(first.requestSnapshot.providerPayload.lastFrameUrl, uri(b));
assert.equal(first.requestSnapshot.providerPayload.referenceImageUrl, uri(c));
assert.equal(first.requestSnapshot.providerPayload.imageUrls[1], uri(a));
assert.equal(JSON.stringify(first.requestSnapshot).includes('?sig='), false);
const assets = load('src/lib/autodl-h3-assets.ts', { '@/lib/generated-image-reference': refs });
const dependency = { resolveGeneratedImage: async (user, value) => { assert.equal(user, 'owner'); return 'https://provider.invalid/' + refs.parseGeneratedImageReferenceUri(value).recordId + '?sig=' + version; }, findOwnedAsset: () => { throw Error('COS lookup forbidden'); }, exists: () => { throw Error('COS read forbidden'); }, sign: () => { throw Error('COS sign forbidden'); } };
const stable = await assets.stabilizeAutodlH3InputAssets({ userId: 'owner', candidates: { imageUrl: uri(a), lastFrameUrl: uri(b), referenceImageUrl: uri(c), imageUrls: [uri(b), uri(a)] } }, dependency);
const queued = JSON.stringify(stable); const dispatched = await assets.resolveAutodlH3QueuedAssetPayload({ userId: 'owner', payload: stable }, dependency); version++;
const redispatched = await assets.resolveAutodlH3QueuedAssetPayload({ userId: 'owner', payload: stable }, dependency);
assert.equal(queued.includes('?sig='), false); assert.equal(stable.imageAssetRefs[0], uri(b)); assert.equal(stable.lastFrameAssetRef, uri(b));
assert.notEqual(dispatched.lastFrameUrl, redispatched.lastFrameUrl); assert.notEqual(dispatched.imageUrls[1], redispatched.imageUrls[1]); assert.equal(JSON.stringify(stable), queued);

// Actual page handoff/retry/request call sites remain bound to these helpers.
const page = readFileSync('src/app/video/page.tsx', 'utf8');
assert.ok(page.includes('...videoWorkflowImageRequestFields(submittedInputs)'));
for (const field of ['referenceImageRef', 'firstFrameImageRef', 'lastFrameImageRef']) assert.ok(page.includes(`generatedImageReferenceUri(slot.${field})`));
assert.ok(page.includes('generatedImagePreviewUrl(reference)')); assert.ok(page.includes('Authorization: `Bearer ${auth.token}`'));
assert.ok(page.includes('redirect: "error"')); assert.ok(page.includes('generatedVideoPreviewBlob(await response.blob(), reference)'));
const previewCode = page.slice(page.indexOf('    const controller = new AbortController();', page.indexOf('const generatedPreviewKey')), page.indexOf('    return () => controller.abort();', page.indexOf('const generatedPreviewKey')));
const cache = { current: new Map([[uri(a), 'blob:old-owner']]) }, cacheOwner = { current: 'old-user:old-token' }, revoked = [], pending = [];
const previewModule = { exports: {} }; let previewFetches = 0;
runInNewContext(compile(`module.exports=()=>{${previewCode}};`), {
  module: previewModule, AbortController, generatedPreviewKey: JSON.stringify([uri(a)]), identity: { userId: 'new-owner' }, auth: { token: 'fixture' }, generatedPreviewCache: cache, generatedPreviewOwner: cacheOwner,
  URL: { revokeObjectURL: value => revoked.push(value), createObjectURL: () => 'blob:new-owner' }, setInputImagePreview() {}, setGeneratedPreviews() {},
  parseGeneratedImageReferenceUri: refs.parseGeneratedImageReferenceUri, generatedImagePreviewUrl: refs.generatedImagePreviewUrl, generatedVideoPreviewBlob: async blob => blob,
  fetch: (url, init) => { previewFetches++; assert.equal(url, refs.generatedImagePreviewUrl(a)); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.headers.Authorization, 'Bearer fixture'); const promise = Promise.resolve({ ok: true, blob: async () => new Blob(['synthetic'], { type: 'image/png' }) }); pending.push(promise); return promise; },
});
previewModule.exports(); await Promise.all(pending); await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(revoked, ['blob:old-owner']); assert.equal(previewFetches, 1); assert.equal(cache.current.get(uri(a)), 'blob:new-owner');
const retry = page.slice(page.indexOf('  const prepareHistoryRetry ='), page.indexOf('    setSelectedModelId', page.indexOf('  const prepareHistoryRetry =')));
const retryModule = { exports: {} };
runInNewContext(compile(`module.exports=(saved)=>{${retry.slice(retry.indexOf('    if (saved.canRetry'))};return card;}`), { module: retryModule, toast: { error: () => assert.fail('retry rejected') }, models: [{ id: 'model' }], nextLocalId: { current: 1 }, emptyCard: () => ({}), restoreVideoGenerateAudio: value => value });
const retryCard = retryModule.exports({ canRetry: true, modelId: 'model', retryInputs: { firstFrameUrl: uri(a), lastFrameUrl: uri(b), referenceImageUrl: uri(c), referenceImageUrls: [legacy, uri(b)] }, requestSnapshot: { userPrompt: prompt } });
assert.equal(retryCard.prompt, prompt); assert.equal(draft.videoWorkflowImageRequestFields({ imageUrl: retryCard.firstFrameUrl, lastFrameUrl: retryCard.lastFrameUrl, referenceImageUrl: retryCard.referenceImageUrl, referenceImageUrls: retryCard.referenceImageUrls }).last_frame_ref.recordId, b.recordId);
console.log(JSON.stringify({ pass: true, scope: 'actual pure draft/parser + route gate/fingerprint/snapshot statements + H3 queue hydration + page retry statements; mocked dependencies, zero network, no real provider/DB/UI acceptance', roles: ['first', 'last', 'reference', 'ordered-list'], implicitUploads: bridges }));
