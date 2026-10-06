import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
function load(source, globals = {}) {
  const compiled = compile(source);
  assert.deepEqual(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, require, Number, Array, URL, Date, JSON, ...globals });
  return module.exports;
}
const display = load(await fs.readFile('src/lib/video-duration-display.ts', 'utf8'));
const validation = load(await fs.readFile('src/components/admin-video-validation-state.ts', 'utf8'));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
test('public DTO capabilities describe target pricing without needing supplier identifiers', () => {
  const shown = display.videoDurationDisplay({ workflowInputMode: 'first_last_frame', billingUnit: 'output_second' });
  assert.equal(shown.label, '目标时长'); assert.equal(shown.quoteBasis, '按本次目标秒数报价');
  assert.match(shown.description, /报价按目标秒数计算/u); assert.match(shown.description, /帧数/u);
});
test('lipsync describes an audio clip upper bound, while optional-audio workflows keep target duration', () => {
  const lip = display.videoDurationDisplay({ workflowInputMode: 'image_audio_lipsync', billingUnit: 'output_second' });
  assert.equal(lip.label, '音频截取上限'); assert.match(lip.description, /限定输入音频的截取长度/u); assert.match(lip.quoteBasis, /上限秒数/u);
  assert.equal(display.videoDurationDisplay({ workflowInputMode: 'multi_image_audio', billingUnit: 'output_second' }).label, '目标时长');
});
test('source-video and per-use models do not receive an invented target-second charge explanation', () => {
  assert.equal(display.videoDurationDisplay({ requiresSourceVideo: true, billingUnit: 'per_use' }).description, '');
  assert.equal(display.videoDurationDisplay({ billingUnit: 'per_use' }).description, '');
  assert.equal(display.videoDurationDisplay().description, '');
});
test('actual duration comes only from finite positive numeric metadata and preserves observed frame differences', () => {
  assert.equal(display.formatActualVideoDuration(1.625), '1.625 秒');
  assert.equal(display.formatActualVideoDuration(4.458333), '4.458 秒');
  for (const value of [null, undefined, '5', 0, -1, NaN, Infinity]) assert.equal(display.formatActualVideoDuration(value), null);
});
test('rechecked configuration receives fresh required image/audio slots instead of carrying stale form shape', () => {
  const dto = { minimumInput: { imageCount: 3, audioCount: 2 }, capabilities: { showFirstFrame: false, showLastFrame: false, showReferenceImages: true, showAudioInputs: true } };
  const first = validation.videoValidationInputsForDto(dto); first.images[0] = 'https://example.test/old.png';
  const next = validation.videoValidationInputsForDto(dto);
  assert.equal(next.images.length, 3); assert.equal(next.audios.length, 2); assert.equal(next.images[0], '');
  const frames = validation.videoValidationInputsForDto({ minimumInput: { imageCount: 2, audioCount: 0 }, capabilities: { showFirstFrame: true, showLastFrame: true, showReferenceImages: false, showAudioInputs: false } });
  assert.equal(frames.images.length, 0); assert.equal(frames.audios.length, 0);
});

// Exercise the actual local player component with media events, without fetching assets.
const pageText = await fs.readFile('src/app/video/page.tsx', 'utf8');
const page = ts.createSourceFile('page.tsx', pageText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(page.parseDiagnostics.length, 0);
const node = page.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'PlayableVideo');
assert.ok(node);
const playerSource = ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, page) + '\nexport { PlayableVideo };';
let cursor = 0;
const state = [], effects = [], changed = [];
const hooks = {
  useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
  useEffect(run, deps) { const index = cursor++; if (!effects[index] || deps.some((value, at) => value !== effects[index][at])) changed.push(run); effects[index] = deps; },
};
const player = load(playerSource, { ...hooks, formatActualVideoDuration: display.formatActualVideoDuration, requestVideoAccessUrl() { throw new Error('NETWORK_FORBIDDEN'); }, AlertCircle: () => null });
const walk = (tree, predicate) => { if (!tree || typeof tree !== 'object') return null; if (predicate(tree)) return tree; for (const child of [tree.props?.children].flat(Infinity)) { const found = walk(child, predicate); if (found) return found; } return null; };
const props = { videoUrl: '/fixture?media_ticket=synthetic', taskId: 'synthetic-task', className: 'player' };
const render = (values = props) => { cursor = 0; let tree = player.PlayableVideo(values); const runs = changed.splice(0); if (runs.length) { runs.forEach(run => run()); cursor = 0; tree = player.PlayableVideo(values); } return tree; };
test('actual player metadata event displays 1.625 seconds, with no task-request fallback', () => {
  let tree = render(); assert.equal(walk(tree, item => Object.hasOwn(item.props || {}, 'data-video-actual-duration')), null);
  walk(tree, item => item.type === 'video').props.onLoadedMetadata({ currentTarget: { duration: 1.625 } });
  tree = render(); const badge = walk(tree, item => Object.hasOwn(item.props || {}, 'data-video-actual-duration'));
  assert.equal(badge.props.children.join(''), '实际 1.625 秒');
});
test('changing media clears prior measured duration; invalid metadata never displays a false duration', () => {
  const changedProps = { ...props, taskId: 'another-synthetic-task', videoUrl: '/other?media_ticket=synthetic' };
  let tree = render(changedProps); tree = render(changedProps);
  assert.equal(walk(tree, item => Object.hasOwn(item.props || {}, 'data-video-actual-duration')), null);
  walk(tree, item => item.type === 'video').props.onLoadedMetadata({ currentTarget: { duration: Infinity } });
  assert.equal(walk(render(changedProps), item => Object.hasOwn(item.props || {}, 'data-video-actual-duration')), null);
});
const directory = '.codex-evidence/admin-video-validation-ui-20260903';
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(`${directory}/duration-display-fixture.json`, JSON.stringify({ passed, source: 'actual duration helper, validation input initializer, and PlayableVideo component', realUpstreamCalls: 0, databaseWrites: 0 }, null, 2));
console.log(JSON.stringify({ passed, realUpstreamCalls: 0, databaseWrites: 0 }));
