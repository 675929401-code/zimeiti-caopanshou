import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as timing from '../src/lib/video-model-capabilities.ts';
import * as inputs from '../src/lib/ai-video-page-capabilities.ts';
import * as contract from '../src/lib/video-input-contract.ts';
import * as selection from '../src/lib/storyboard-video-model-selection.ts';
import { getImageModelCapabilities } from '../src/lib/image-model-capabilities.ts';
import { isPublicVideoAssetUrl } from '../src/lib/video-public-url.ts';
import { requiresVideoTaskTracking, persistVideoTaskCheckpoint, finishVideoTaskCheckpoint } from '../src/lib/video-task-checkpoint.ts';

const asset = 'https://fixture.example.invalid/reference.png';
const parse = (filename) => ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, filename.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const baseGlobals = { ...timing, ...inputs, ...contract, ...selection, getImageModelCapabilities, isPublicVideoAssetUrl, exports: {}, URL, URLSearchParams, AbortController, AbortSignal, DOMException, TextEncoder, Error, TypeError, crypto: webcrypto };

function declarations(tree, names) {
  return tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map((node) => node.getText(tree).replace(/^export\s/u, '')).join('\n');
}
function callback(tree, name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const value = node.initializer;
      const candidate = value && ts.isCallExpression(value) ? value.arguments[0] : value;
      if (candidate && ts.isArrowFunction(candidate)) found = candidate;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `actual ${name} handler`);
  return found.getText(tree);
}

// Execute the real POST prefix through the input gate, then return a fixture
// sentinel. Paid dispatch, storage, wallet, claim and provider code are absent.
const backendTree = parse('src/app/api/video/generate/route.ts');
const post = backendTree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
const attempt = post.body.statements.find((node) => ts.isTryStatement(node));
const stopAt = attempt.tryBlock.statements.findIndex((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => entry.name.getText(backendTree) === 'normalizedSurface'));
assert.ok(stopAt > 0);
const beforeTry = post.body.statements.slice(0, post.body.statements.indexOf(attempt)).map((node) => node.getText(backendTree)).join('\n');
const realInputPrefix = attempt.tryBlock.statements.slice(0, stopAt).map((node) => node.getText(backendTree)).join('\n');
function backendInputHandler(row) {
  const globals = { ...baseGlobals, console: { warn() {} },
    NextResponse: { json: (body, options) => Response.json(body, options) },
    getTokenFromHeaders: (headers) => headers.get('authorization'),
    verifyToken: async () => ({ userId: 'synthetic-user', role: 'admin' }),
    authorizeAdminToken: async () => ({ ok: true, user: { id: 'synthetic-user', role: 'admin' } }),
    createHash, writeVideoTrace: async () => {}, detectSuspiciousBody: () => ({ suspicious: false }),
    getSupabaseAdminClient: () => ({ from: () => { const query = { select() { return query; }, eq() { return query; }, async single() { return { data: row, error: null }; } }; return query; } }),
    getProductionVideoModelById: async () => null,
  };
  return runInNewContext(transpile(`async function inputHandler(req) { ${beforeTry} ${realInputPrefix} return NextResponse.json({ fixtureInputGateAccepted: true }); } inputHandler;`), globals);
}
function rawModel(config = {}) {
  return { id: 'fixture-model', supports_image_input: false, requires_image: false, is_active: true, api_protocol_config: { supports_prompt: true, workflow_input_mode: 'text', ...config } };
}
function dto(row, overrides = {}) {
  const input = contract.getVideoInputContract(row);
  return { id: row.id, displayName: 'Synthetic video', publicPrice: 0, capabilities: {
    ...input, workflowInputMode: input.mode, supportsImageInput: row.supports_image_input, requiresImage: row.requires_image,
    available: true, availabilityMessage: '', durationMode: 'fixed', defaultDuration: 5, minDuration: 5, maxDuration: 5, nativeDurations: [5],
    resolutionOptions: ['720p'], defaultResolution: '720p', resolutionPrices: ['720p=0'], aspectRatios: ['16:9'], workspaceSurfaces: ['ai-video', 'storyboard'], ...overrides,
  } };
}
async function inputRequest(row, body, token = true) {
  return backendInputHandler(row)(new Request('http://fixture.invalid/api/video/generate', { method: 'POST', headers: token ? { authorization: 'offline-fixture-only' } : {}, body: JSON.stringify({ model_id: row.id, ...body }) }));
}

const pageTree = parse('src/app/video/page.tsx');
const pageHelpers = declarations(pageTree, ['normalizePublicVideoModel', 'taskImageInputs', 'videoClientAttemptScope', 'isActiveVideoTaskStatus']);
async function runPage(row, taskPatch = {}, options = {}) {
  const probe = { requests: [], notices: [], states: [], cleared: [] };
  const saved = new Map();
  let tasks = [{ localId: 1, cardIndex: 1, batchId: 'synthetic-batch', batchTopic: 'fixture', status: 'idle', prompt: '合成视频任务', negativePrompt: '', firstFrameUrl: '', lastFrameUrl: '', referenceImageUrl: '', referenceImageUrls: [], referenceAudioUrls: [], sourceVideoUrl: '', taskId: '', ...taskPatch }];
  const globals = { ...baseGlobals,
    tasks, selectedModelId: row.id, selectedResolution: '720p', aspectRatio: { value: '16:9' }, duration: 5,
    tasksRef: { get current() { return tasks; } }, submissionLocksRef: { current: new Set() }, trackingStorageError: '',
    requiresVideoTaskTracking, persistVideoTaskCheckpoint, finishVideoTaskCheckpoint,
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    identity: { userId: 'synthetic-user' },
    auth: options.anonymous ? null : { token: 'offline-fixture-only' },
    setTasks: (update) => { tasks = update(tasks); probe.states.push(tasks); },
    toast: { error: (message) => probe.notices.push(message), info: (message) => probe.notices.push(message), success() {} },
    buildClientRequestFingerprint: async () => 'fixture-fingerprint', resolveBrowserClientAttempt: () => ({ clientRequestId: 'fixture-request-id' }), clearBrowserClientAttempt: (...args) => probe.cleared.push(args),
    sseRefs: { current: new Map() }, syncTaskToConversation() {}, loadHistory() {},
    isAmbiguousAutodlH3SubmissionStatus: (status) => status >= 500, reportVideoSubmitFailed() {}, classifyVideoError: String,
    fetch: async (url, init) => {
      assert.equal(url, '/api/video/generate');
      const body = JSON.parse(init.body);
      probe.requests.push({ body, headers: init.headers });
      const validated = await inputRequest(row, body);
      if (!validated.ok) return validated;
      if (options.response) return Response.json(options.response.body, { status: options.response.status });
      return Response.json({ task_id: 'synthetic-task', model_id: row.id, status: 'queued' });
    },
  };
  runInNewContext(transpile(`${pageHelpers}\nexports.model = normalizePublicVideoModel(${JSON.stringify(dto(row, options.capabilities))});`), globals);
  globals.models = options.missingModel ? [] : [globals.exports.model];
  globals.selectedModel = globals.exports.model;
  const generate = runInNewContext(transpile(`const submitVideoTask = ${callback(pageTree, 'submitVideoTask')}; const generate = ${callback(pageTree, 'generate')}; generate;`), globals);
  await generate(1);
  probe.finalTask = tasks[0];
  return probe;
}

const boardTree = parse('src/components/storyboard-workbench.tsx');
const boardHelpers = declarations(boardTree, ['firstText', 'firstNumber', 'firstOptionalNumber', 'firstOptionalBoolean', 'firstBoolean', 'stringList', 'numberList', 'isWorkbenchRatio', 'normalizeVideoModel', 'normalizeImageFamily', 'normalizeImageModel', 'isStoryboardVideoModel']);
function boardModel(input) {
  const globals = { ...baseGlobals, WORKBENCH_RATIOS: ['16:9', '9:16', '1:1', '4:3', '3:4'] };
  runInNewContext(transpile(`${boardHelpers}\nexports.model = normalizeVideoModel(${JSON.stringify(input)}); exports.image = normalizeImageModel; exports.inSurface = isStoryboardVideoModel;`), globals);
  return globals.exports;
}
async function runBoard(row, overrides = {}, cardPatch = {}, options = {}) {
  const model = boardModel(dto(row, overrides)).model;
  const probe = { requests: [], notices: [], patches: [], assetWrites: 0 };
  const card = { id: 'synthetic-card', order: 1, imagePrompt: 'single frame', videoPrompt: '合成视频任务', narration: '', imageUrl: asset, imageStorageKey: 'synthetic/owned-image', imageStatus: 'done', imageValidatedAt: 1, videoStatus: 'idle', ...cardPatch };
  const current = { id: 'synthetic-run', cards: [card], videoModelId: row.id, videoDuration: 5, videoResolution: '720p', ratio: '16:9' };
  const globals = { ...baseGlobals, runRef: { current }, videoModels: [model], token: 'offline-fixture-only',
    videoSubmissionsRef: { current: new Set() }, submittedRunIdsRef: { current: new Set() }, videoSectionsRef: { current: {} }, videoSubmissionControllersRef: { current: new Map() },
    isActiveVideoStatus: (status) => ['running', 'queued'].includes(status), hasValidatedImage: (input) => input.imageStatus === 'done' && Boolean(input.imageValidatedAt),
    setNotice: (message) => probe.notices.push(message), effectiveVideoDuration: (_model, value) => value, effectiveVideoResolution: (_model, value) => value,
    inferStoryboardNarration: () => '', narrationCharacterCount: (value) => value.length, submittedVideoPrompt: (value) => value,
    publicModelName: (value) => value.name, archiveRunSnapshot() {}, setExpandedVideoCards() {}, window: { setTimeout() {} }, STRICT_AUTODL_H3_SELFHOST_PUBLIC_ID: 'fixture-other-model',
    patchCard: (_id, patch) => { probe.patches.push(patch); Object.assign(card, patch); },
    isMultiPanelStoryboardPrompt: () => false, isPublicHttpMediaUrl: isPublicVideoAssetUrl,
    persistImage: async () => { probe.assetWrites++; throw new Error('protected inputs must stop before asset processing'); },
    buildClientRequestFingerprint: async () => 'fixture-fingerprint', resolveBrowserClientAttempt: () => ({ clientRequestId: 'fixture-request-id' }), clearBrowserClientAttempt() {},
    isAbortError: () => false, friendlyVideoError: (value) => value, normalizeRemoteVideoStatus: (value) => value, startPolling: async () => 'fixture-polling',
    fetch: async (url, init) => { assert.equal(url, '/api/video/generate'); const body = JSON.parse(init.body); probe.requests.push({ body, headers: init.headers }); const validated = await inputRequest(row, body); if (!validated.ok) return validated; if (options.response) return Response.json(options.response.body, { status: options.response.status }); return Response.json({ task_id: 'synthetic-task', status: 'queued' }); },
  };
  const generate = runInNewContext(transpile(`const generateVideo = ${callback(boardTree, 'generateVideo')}; generateVideo;`), globals);
  await generate(card.id);
  probe.finalCard = card;
  return probe;
}

async function main() {
  const text = rawModel();
  const image = { ...rawModel({ workflow_input_mode: 'flexible_image', max_reference_images: 1 }), supports_image_input: true, requires_image: true };
  const silent = { ...image, api_protocol_config: { ...image.api_protocol_config, supports_prompt: false } };
  assert.equal((await inputRequest(text, { prompt: '' })).status, 422);
  assert.equal((await inputRequest(text, { prompt: '   ' })).status, 422);
  assert.equal((await inputRequest(silent, { prompt: '', image_url: asset })).status, 200);
  assert.equal((await inputRequest(silent, { image_url: asset })).status, 200);
  assert.equal((await inputRequest(silent, { prompt: '' })).status, 422, 'optional prompt never removes image requirements');
  assert.equal((await inputRequest(text, { prompt: 'ok' }, false)).status, 401);

  const plain = await runPage(text, { firstFrameUrl: asset, referenceAudioUrls: [asset] });
  assert.equal(plain.requests.length, 1);
  assert.equal(plain.requests[0].body.image_url, '', 'hidden stale media is not submitted for text-only models');
  assert.deepEqual(plain.requests[0].body.reference_audio_urls, []);
  const silentPage = await runPage(silent, { prompt: '', referenceImageUrl: asset });
  assert.equal(silentPage.requests.length, 1);
  assert.equal(silentPage.requests[0].body.prompt, '');
  assert.equal(silentPage.requests[0].headers['Idempotency-Key'], silentPage.requests[0].body.client_request_id);
  const tooMany = await runPage(image, { referenceImageUrl: asset, referenceImageUrls: ['https://fixture.example.invalid/second.png'] });
  assert.equal(tooMany.requests.length, 0);
  assert.ok(tooMany.notices.some(message => /最多支持 1 张/.test(message)));
  for (const url of ['blob:pending', 'http://127.0.0.1:5000/local.png']) assert.equal((await runPage(image, { referenceImageUrl: url })).requests.length, 0);
  assert.equal((await runPage(text, {}, { anonymous: true })).requests.length, 0);
  assert.equal((await runPage(text, {}, { missingModel: true })).requests.length, 0);
  const audio = { ...image, api_protocol_config: { ...image.api_protocol_config, workflow_input_mode: 'multi_image_audio', supports_audio_input: true, max_reference_audios: 1 } };
  assert.equal((await runPage(audio, { referenceImageUrl: asset, referenceAudioUrls: [asset, 'https://fixture.example.invalid/second.mp3'] })).requests.length, 0);

  const terminalFailure = { status: 502, body: { status: 'failed', business_task_id: 'vt_fixture_terminal', error: '当前首尾帧输入不完整' } };
  const failedPage = await runPage(text, {}, { response: terminalFailure });
  assert.equal(failedPage.finalTask.status, 'failed');
  assert.equal(failedPage.finalTask.taskId, 'vt_fixture_terminal');
  assert.equal(failedPage.finalTask.clientRequestId, '');
  assert.equal(requiresVideoTaskTracking(failedPage.finalTask), false);
  assert.equal(failedPage.cleared.length, 1);
  const ambiguousPage = await runPage(text, {}, { response: { status: 502, body: { error: 'Gateway timeout' } } });
  assert.equal(requiresVideoTaskTracking(ambiguousPage.finalTask), true);
  assert.equal(ambiguousPage.cleared.length, 0);
  const failedBoard = await runBoard(image, {}, {}, { response: terminalFailure });
  assert.equal(failedBoard.finalCard.videoStatus, 'failed');
  assert.equal(failedBoard.finalCard.videoTaskId, 'vt_fixture_terminal');
  assert.equal(failedBoard.finalCard.videoClientRequestId, undefined);
  assert.match(failedBoard.finalCard.videoError, /首尾帧/);
  const ambiguousBoard = await runBoard(image, {}, {}, { response: { status: 502, body: { error: 'Gateway timeout' } } });
  assert.equal(ambiguousBoard.finalCard.videoStatus, 'queued');
  assert.equal(ambiguousBoard.finalCard.videoClientRequestId, 'fixture-request-id');

  const normalBoard = await runBoard(image);
  assert.equal(normalBoard.requests.length, 1);
  assert.equal(normalBoard.requests[0].body.image_url, asset);
  assert.equal(normalBoard.requests[0].body.image_storage_key, 'synthetic/owned-image');
  assert.equal(normalBoard.requests[0].headers['Idempotency-Key'], normalBoard.requests[0].body.client_request_id);
  assert.equal((await runBoard(image, {}, { videoPrompt: '' })).requests.length, 0);
  const silentBoard = await runBoard(silent, {}, { videoPrompt: '' });
  assert.equal(silentBoard.requests.length, 1);
  assert.equal(silentBoard.requests[0].body.prompt, '');
  for (const handlerName of ['batchVideos', 'fullFlow']) {
    for (const videoPromptRequired of [true, false]) {
      let videoBatchCalls = 0;
      const run = { cards: [{ id: 'synthetic-card', imagePrompt: 'single image', videoPrompt: '', imageStatus: 'done', imageUrl: asset, videoStatus: 'idle' }] };
      const globals = { ...baseGlobals, run, runRef: { current: run }, videoPromptRequired, batchMode: '', hasValidatedImage: () => true,
        setNotice() {}, setBatchMode() {}, runImageBatch: async () => { throw new Error('existing fixture image must not regenerate'); },
        runVideoBatch: async () => { videoBatchCalls++; return [true]; } };
      await runInNewContext(transpile(`const handler = ${callback(boardTree, handlerName)}; handler;`), globals)();
      assert.equal(videoBatchCalls, videoPromptRequired ? 0 : 1, `${handlerName} follows the selected model prompt requirement`);
    }
  }
  const disabledConditions = [];
  function collectDisabled(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(boardTree) === 'disabled' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(boardTree).includes('videoPromptRequired')) disabledConditions.push(node.initializer.expression.getText(boardTree));
    ts.forEachChild(node, collectDisabled);
  }
  collectDisabled(boardTree);
  assert.equal(disabledConditions.length, 2);
  for (const expression of disabledConditions) {
    const globals = { activeVideoModel: { id: 'fixture-model' }, canRemotelyCancelVideoTask: () => false, card: { videoPrompt: '', videoStatus: 'idle' }, hasValidatedImage: () => true, isActiveVideoStatus: () => false, batchMode: '' };
    assert.equal(runInNewContext(expression, { ...globals, videoPromptRequired: false }), false);
    assert.equal(runInNewContext(expression, { ...globals, videoPromptRequired: true }), true);
  }
  const firstFrameOnly = { ...image, api_protocol_config: { ...image.api_protocol_config, requires_first_frame: true } };
  assert.equal((await runBoard(firstFrameOnly)).requests.length, 1, 'a single required first frame is satisfied by the storyboard image');
  const legacyFirstFrameOnly = { ...firstFrameOnly, api_protocol_config: { max_reference_images: 1, requires_first_frame: true } };
  assert.equal((await runBoard(legacyFirstFrameOnly)).requests.length, 1, 'derived frame mode does not invent a required last frame');
  assert.equal((await runBoard(audio)).requests.length, 1, 'optional audio does not block a valid single-image task');
  for (const overrides of [{ available: false, availabilityMessage: '合成渠道暂停' }, { minReferenceImages: 2, maxReferenceImages: 4 }, { workflowInputMode: 'first_last_frame', requiresFirstFrame: true, requiresLastFrame: true }, { workflowInputMode: 'multi_image_audio', supportsAudioInput: true, minReferenceAudios: 1, maxReferenceAudios: 1 }]) {
    const protectedBoard = await runBoard(image, overrides);
    assert.equal(protectedBoard.requests.length, 0);
    assert.equal(protectedBoard.assetWrites, 0);
    assert.equal(protectedBoard.patches.length, 0, 'unsupported input stops before erasing old results');
    assert.ok(protectedBoard.notices.length > 0);
  }
  const normalized = boardModel(dto(image, { minReferenceImages: 2, maxReferenceImages: 4, workflowInputMode: 'multi_image' }));
  assert.equal(normalized.model.minReferenceImages, 2);
  assert.equal(normalized.model.maxReferenceImages, 4);
  assert.equal(normalized.model.referenceInputMode, 'multi_image');
  assert.equal(normalized.inSurface(normalized.model), true, 'incompatible general models stay visible with a mode-specific disabled reason');
  assert.match(selection.storyboardVideoModelSelectionIssue(normalized.model, {}), /至少需要 2 张/);
  const imageDto = { id: 'synthetic-image', displayName: 'Nano Banana 2', capabilities: { family: 'gemini', supportsImageInput: true, supportsReferenceInput: true, maxReferenceImages: 2, maxCharacterReferences: 1, referenceInputMode: 'multi', identityReferenceLevel: 'single-subject', resolutionOptions: ['1K', '2K'], defaultResolution: '1K' } };
  const imageModel = normalized.image(imageDto);
  assert.equal(getImageModelCapabilities(imageModel).maxReferenceImages, 2, 'explicit public limit overrides name-based inference');
  assert.equal(getImageModelCapabilities(imageModel).maxCharacterReferences, 1);
  const catalogTree = parse('src/app/api/video/models/route.ts');
  const catalogGlobals = { ...baseGlobals, AUTODL_H3_SELFHOST_PROTOCOL: 'synthetic-selfhost' };
  const matchesSurface = runInNewContext(transpile(`${declarations(catalogTree, ['workspaceSurfaceList', 'modelIdentity', 'isDigitalHumanModel', 'modelMatchesSurface'])}\nmodelMatchesSurface;`), catalogGlobals);
  for (const mode of ['first_last_frame', 'multi_image_audio']) {
    const row = { ...image, api_protocol_config: { ...image.api_protocol_config, workflow_input_mode: mode, ...(mode === 'multi_image_audio' ? { supports_audio_input: true, max_reference_audios: 3 } : { requires_first_frame: true, requires_last_frame: true }) } };
    assert.equal(matchesSurface(row, 'storyboard-workbench'), false, 'single-image storyboard catalog excludes workflows requiring another frame or audio surface');
    assert.equal(matchesSurface(row, 'video-page'), true);
  }
  assert.equal(matchesSurface(firstFrameOnly, 'storyboard-workbench'), true);
  assert.equal(matchesSurface(text, 'storyboard-workbench'), false);
  const result = { passed: true, dynamicGroups: 21, actualFrontendHandlers: ['video.generate', 'storyboard.generateVideo', 'storyboard.batchVideos', 'storyboard.fullFlow'], actualBackendInputGate: true, actualCatalogSurfaceFilter: true, providerRequests: 0, realDatabaseWrites: 0 };
  mkdirSync('.codex-evidence/video-storyboard-submission-20260902', { recursive: true });
  writeFileSync('.codex-evidence/video-storyboard-submission-20260902/fixture.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
await main();
