import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// Actual contract, public route and Gaorui adapter; only I/O is replaced.
const nativeRequire = createRequire(import.meta.url);
const state = { models: [], requests: [], responseStatus: 200, assignments: {} };
function query(table) {
  const predicates = [];
  const equalities = new Map();
  return {
    select() { return this; }, order() { return this; },
    eq(key, value) { equalities.set(key, value); predicates.push(row => row[key] === value); return this; },
    in(key, values) { predicates.push(row => values.includes(row[key])); return this; },
    maybeSingle() {
      const data = table === 'platform_settings' && equalities.get('setting_key') === 'workspace_model_assignment_overrides_v1'
        ? { setting_value: JSON.stringify({ version: 1, surfaces: state.assignments }) } : null;
      return Promise.resolve({ data, error: null });
    },
    then(resolve, reject) {
      const rows = table === 'video_models' ? state.models : state.models.map(row => ({ channel_id: row.id, is_healthy: true }));
      return Promise.resolve({ data: rows.filter(row => predicates.every(check => check(row))), error: null }).then(resolve, reject);
    },
  };
}
const mocks = {
  'server-only': {},
  'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
  '@/storage/database/supabase-client': { getSupabaseClient: () => ({ from: query }) },
  '@/lib/autodl-h3-selfhost': { AUTODL_H3_SELFHOST_PROTOCOL: 'autodl_h3_selfhost' },
  '@/lib/model-activation-gate': { inspectVideoModelActivationReadiness: () => ({ ready: true }) },
  '@/lib/video-cancellation': { supportsConfirmedVideoCancellation: () => false },
  '@/lib/video-terminal-finalizer': { requireVideoPriceSnapshot: () => ({}) },
};
const silentConsole = { log() {}, warn() {}, error() {} };
const cache = new Map();
function compile(source, filename, additional = {}) {
  const loadedModule = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: filename }).outputText;
  vm.runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports,
    require: name => mocks[name] || (name.startsWith('@/') ? load('src/' + name.slice(2) + '.ts') : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name + '.ts')) : nativeRequire(name)),
    Request, Response, Headers, URL, Buffer, AbortSignal, DOMException,
    console: silentConsole, process: { env: { NODE_ENV: 'test', PUBLIC_MODEL_ID_SECRET: 'fixture-only' } }, createHash,
    fetch: () => { throw new Error('UNEXPECTED_NETWORK'); }, ...additional,
  }, { filename });
  return loadedModule.exports;
}
function load(file) {
  file = path.resolve(file);
  if (!cache.has(file)) cache.set(file, compile(fs.readFileSync(file, 'utf8'), file));
  return cache.get(file);
}
const contractModule = load('src/lib/video-input-contract.ts');
const capabilities = load('src/lib/video-model-capabilities.ts');
const pageCapabilities = load('src/lib/ai-video-page-capabilities.ts');
const publicRoute = load('src/app/api/video/models/route.ts');
const adapterPath = path.resolve('src/lib/video-adapter.ts');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const ast = ts.createSourceFile(adapterPath, adapterSource, ts.ScriptTarget.Latest, true);
const requiredFunctions = ['generateGaoruiVideo', 'gaoruiPixelSize', 'mapToOmniFlashDuration', 'isDeterministicGaoruiModelError', 'safeParseJson', 'safeStr', 'safeNum', 'videoSubmitOnce', 'videoSubmissionTaskId', 'videoSubmissionWithoutTask', 'videoSubmissionUnknown'];
const requiredConstants = ['GR_LOG', 'GAORUI_SIZE_MAP', 'GAORUI_ALLOWED_PIXEL_SIZES'];
const pieces = ast.statements.filter(node => (
  ts.isFunctionDeclaration(node) && requiredFunctions.includes(node.name?.text)
) || (
  ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => requiredConstants.includes(declaration.name.getText(ast)))
));
for (const name of requiredFunctions) assert.ok(pieces.some(node => ts.isFunctionDeclaration(node) && node.name?.text === name), 'missing actual adapter function: ' + name);
const adapter = compile(pieces.map(node => node.getText(ast)).join('\n') + '\nexports.generateGaoruiVideo = generateGaoruiVideo;', adapterPath, {
  extractPromptDurationSeconds: load('src/lib/video-prompt-timing.ts').extractPromptDurationSeconds,
  ...load('src/lib/gaorui-seedance-native-contract.ts'),
  ...load('src/lib/gaorui-h3-native-contract.ts'),
  ...load('src/lib/gaorui-grok-native-contract.ts'),
  fetch: async (_url, options) => {
    assert.equal(options.method, 'POST');
    state.requests.push(JSON.parse(options.body));
    return Response.json(state.responseStatus === 200 ? { id: 'fixture-task', status: 'queued' } : { message: 'fixture unavailable' }, { status: state.responseStatus });
  },
});
const primary = 'https://fixture.invalid/primary.png';
const last = 'https://fixture.invalid/last.png';
const model = {
  id: 'grok-15-fixture', name: 'Grok Imagine 1.5', provider: 'gaorui',
  model_name: 'grok-imagine-video-1.5-preview', protocol_type: 'gaorui_video',
  api_endpoint: 'https://fixture.invalid/v1', api_key: 'fixture-only',
  supports_image_input: true, requires_image: false, is_active: true, is_hidden: false,
  duration_seconds: 6, api_protocol_config: { max_reference_images: 1, workspace_surfaces: ['ai-video', 'storyboard'] },
};
const request = extra => ({ prompt: 'A cloud moves.', duration: 6, ...extra });
const violation = (row, input) => contractModule.validateVideoInputContract(contractModule.getVideoInputContract(row), input);
async function submit(row, input) {
  const invalid = violation(row, input);
  return invalid ? { rejected: invalid.code } : adapter.generateGaoruiVideo(row, input);
}
let passed = 0;
async function test(name, run) { state.requests = []; state.responseStatus = 200; await run(); passed++; console.log('PASS ' + name); }

await test('official Gaorui preview text mode uses the actual native adapter', async () => {
  assert.equal(model.requires_image, false);
  const result = await adapter.generateGaoruiVideo(model, request());
  assert.equal(result.taskId, 'fixture-task'); assert.equal(state.requests.length, 1);
  assert.deepEqual(state.requests[0], { model: model.model_name, prompt: 'A cloud moves.', size: '16:9', seconds: 6, resolution: '480p' });
});
await test('public input contract permits documented optional reference image', async () => {
  const invalid = violation(model, request());
  assert.equal(invalid, null); assert.equal((await submit(model, request())).taskId, 'fixture-task'); assert.equal(state.requests.length, 1);
});
await test('primary image maps to exactly one provider image_urls submission', async () => {
  assert.equal((await submit(model, request({ imageUrl: primary }))).taskId, 'fixture-task');
  assert.equal(state.requests.length, 1); assert.deepEqual(state.requests[0].image_urls, [primary]);
});
await test('singular legacy reference is consumed once by the native adapter', async () => {
  assert.equal((await submit(model, request({ referenceImageUrl: primary }))).taskId, 'fixture-task');
  assert.equal(state.requests.length, 1); assert.deepEqual(state.requests[0].image_urls, [primary]);
});
await test('malformed and private reference URLs cannot dispatch', async () => {
  for (const imageUrl of ['  ', 'data:image/png;base64,fixture', 'https://localhost/ref.png']) await assert.rejects(() => adapter.generateGaoruiVideo(model, request({ imageUrl })));
  assert.equal(state.requests.length, 0);
});
await test('preview conservatively rejects two references without truncation', async () => {
  const invalid = violation(model, request({ imageUrl: primary, lastFrameUrl: last })); assert.equal(invalid.code, 'VIDEO_REFERENCE_LIMIT_EXCEEDED');
  await assert.rejects(() => adapter.generateGaoruiVideo(model, request({ imageUrl: primary, lastFrameUrl: last }))); assert.equal(state.requests.length, 0);
});
await test('explicit operator legacy image requirement remains independent', async () => {
  const stale = { ...model, supports_image_input: false, api_protocol_config: { workflow_input_mode: 'text', max_reference_images: 1, requires_image_v15: true } };
  const input = contractModule.getVideoInputContract(stale);
  assert.equal(input.requiresFirstFrame, true); assert.equal(input.minReferenceImages, 1); assert.notEqual(input.mode, 'text');
  assert.equal((await submit(stale, request({ imageUrl: primary }))).taskId, 'fixture-task');
  assert.equal((await submit(stale, request({ referenceImageUrl: primary }))).rejected, 'VIDEO_FIRST_FRAME_REQUIRED');
});
await test('Grok 1.0 and Omni text submission remain valid', async () => {
  for (const name of ['grok-imagine-1.0-video', 'omni_flash_10s']) {
    const row = { ...model, model_name: name }; assert.equal(capabilities.requiresGaoruiGrok15InputImage(row), false);
    assert.equal((await submit(row, request())).taskId, 'fixture-task');
  }
  assert.equal(state.requests.length, 2);
});
await test('formal Grok 1.5 accepts text and maps up to five references to image_urls', async () => {
  const row = { ...model, model_name: 'grok-imagine-video-1.5', requires_image: false, api_protocol_config: { max_reference_images: 5 } };
  assert.equal(capabilities.requiresGaoruiGrok15InputImage(row), false);
  assert.equal((await submit(row, request({ resolutionTier: '720p' }))).taskId, 'fixture-task');
  assert.equal(state.requests[0].resolution, '720p'); assert.equal('image_urls' in state.requests[0], false);
  state.requests = [];
  const images = Array.from({ length: 6 }, (_, index) => `https://fixture.invalid/${index}.png`);
  assert.equal((await submit(row, request({ imageUrl: images[0], imageUrls: images.slice(1, 5), resolutionTier: '480p' }))).taskId, 'fixture-task');
  assert.deepEqual(state.requests[0].image_urls, images.slice(0, 5)); assert.equal(state.requests[0].resolution, '480p');
  state.requests = []; await assert.rejects(() => adapter.generateGaoruiVideo(row, request({ imageUrl: images[0], imageUrls: images.slice(1) }))); assert.equal(state.requests.length, 0);
});
await test('other protocols and display labels do not inherit the Gaorui constraint', async () => {
  for (const row of [{ ...model, protocol_type: 'secure_skill_video' }, { ...model, model_name: 'unrelated-video', name: 'Grok 1.5' }, { ...model, model_name: undefined }]) {
    assert.equal(capabilities.requiresGaoruiGrok15InputImage(row), false); assert.equal(violation(row, request()), null);
  }
});
await test('other explicit first-frame models do not gain a reference alias', async () => {
  const row = { ...model, model_name: 'unrelated', api_protocol_config: { requires_first_frame: true } };
  assert.equal(violation(row, request({ referenceImageUrl: primary })).code, 'VIDEO_FIRST_FRAME_REQUIRED');
});
await test('actual public DTO and client controls agree on optional preview image in both workspaces', async () => {
  state.models = [model];
  state.assignments = { 'video-page': { [model.id]: true }, 'storyboard-video': { [model.id]: true } };
  for (const surface of ['video-page', 'storyboard-workbench']) {
    const response = await publicRoute.GET(new Request('http://fixture.invalid/api/video/models?surface=' + surface));
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.models.length, 1);
    const dto = body.models[0]; assert.equal(dto.capabilities.requiresImage, false); assert.equal(dto.capabilities.supportsImageInput, true); assert.equal(dto.capabilities.minReferenceImages, 0);
    const input = pageCapabilities.getAiVideoPageInputCapabilities(dto); assert.equal(input.requiresFirstFrame, false);
    assert.doesNotMatch(JSON.stringify(body), /api_key|fixture-only|api_endpoint|allowReferenceImageAsFirstFrame/u);
  }
});
await test('unconfirmed upstream error still makes only one submission', async () => {
  state.responseStatus = 503;
  const result = await submit(model, request({ imageUrl: primary }));
  assert.equal(result.status, 'processing'); assert.equal(result.submissionOutcome, 'unknown'); assert.equal(state.requests.length, 1);
});
console.log(JSON.stringify({ passed, failed: 0, realUpstreamRequests: 0, databaseWrites: 0 }));
