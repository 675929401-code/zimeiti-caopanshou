import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const beforePath = '.codex-backups/20260903-015553-voice-mix-inputs/workspace-page.tsx';
const sourcePath = 'src/app/voice-studio/workspace/page.tsx';
const parse = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const before = parse(beforePath), source = parse(sourcePath);
function find(ast, predicate) { let result; const visit = node => { if (result) return; if (predicate(node)) { result = node; return; } ts.forEachChild(node, visit); }; visit(ast); assert.ok(result, 'ACTUAL_SOURCE_NODE_REQUIRED'); return result; }
const initializer = (ast, name) => find(ast, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name).initializer.getText(ast);
const voice = id => ({ id, speakerId: id, name: id });
const mixIds = ['zh_female_shuangkuaisisi_moon_bigtts', 'zh_male_wennuanahu_moon_bigtts'];
const two = [{ voice: voice(mixIds[0]), factor: 0.5 }, { voice: voice(mixIds[1]), factor: 0.5 }];
function fixture(items = two, text = '这是本地混音参数校验。') {
  const state = { items: structuredClone(items), errors: [], calls: [], accepted: [] };
  const context = vm.createContext({ mixVoices: state.items, MIX_VOICES: mixIds.map(voice), text, speed: 12, volume: -4, Number, Math,
    setError: value => state.errors.push(value), setSynthesizing() {}, setResult() {},
    buildBaseParams: () => ({ model: 'seed-tts-2.0-expressive', speechRate: 12, loudnessRate: -4, format: 'mp3', sampleRate: 24000 }),
    submitVoiceRequest: async (scope, body) => { state.calls.push({ scope, body: JSON.parse(JSON.stringify(body)) }); return { res: { ok: true }, json: { success: true, data: { fixture: true } } }; },
    acceptVoiceResult: result => state.accepted.push(result),
    setMixVoices: update => { state.items = update(state.items); context.mixVoices = state.items; },
  });
  const run = expression => { vm.runInContext(ts.transpileModule(`globalThis.fn=(${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context); return context.fn(); };
  return { state, run };
}
const cases = [];
const old = fixture([...two, ...two]); await old.run(initializer(before, 'handleMixSynthesize')); assert.equal(old.state.calls[0].body.mixSpeakers.length, 4); assert.equal(old.state.calls[0].body.model, 'seed-tts-2.0-expressive'); cases.push('Old actual handler submits four speakers and labels the 1.0 mix request as 2.0');
for (const [name, items, text] of [
  ['four-slot legacy state', [...two, ...two], '文本'],
  ['blank text', two, '   '],
  ['one voice', [two[0]], '文本'],
  ['unselected slot', [two[0], { voice: null, factor: 0.5 }], '文本'],
  ['missing speaker identity', [two[0], { voice: { id: '', speakerId: '' }, factor: 0.5 }], '文本'],
  ['2.0 voice cannot be silently mixed as 1.0', [two[0], { voice: voice('zh_female_vv_uranus_bigtts'), factor: 0.5 }], '文本'],
  ['weight sum below one', two.map(x => ({ ...x, factor: 0.25 })), '文本'],
  ['NaN weight', [{ ...two[0], factor: NaN }, two[1]], '文本'],
  ['zero weight', [{ ...two[0], factor: 0 }, { ...two[1], factor: 1 }], '文本'],
  ['negative weight', [{ ...two[0], factor: -0.5 }, { ...two[1], factor: 1.5 }], '文本'],
]) {
  const test = fixture(items, text), original = structuredClone(test.state.items); await test.run(initializer(source, 'handleMixSynthesize'));
  assert.equal(test.state.calls.length, 0); assert.ok(test.state.errors.some(Boolean)); assert.deepEqual(test.state.items, original); cases.push(`${name}: explained before submitting, original selections retained`);
}
for (const items of [two, [{ ...two[0], factor: 0.2 }, { ...two[1], factor: 0.3 }, { voice: voice(mixIds[0]), factor: 0.5 }]]) {
  const test = fixture(items); await test.run(initializer(source, 'handleMixSynthesize')); assert.equal(test.state.calls.length, 1);
  const { scope, body } = test.state.calls[0]; assert.equal(scope, 'mix'); assert.equal(body.model, 'seed-tts-1.0'); assert.equal(body.speed, 12); assert.equal(body.volume, -4);
  assert.deepEqual(body.mixSpeakers, items.map(item => ({ speaker: item.voice.speakerId, factor: item.factor }))); cases.push(`${items.length} selected voices preserve identities and weights, request the actual 1.0 model and API speed/volume fields`);
}
const originalVoices = [{ speakerId: 'fixture-a', name: 'A' }, { speakerId: 'fixture-b', name: 'B' }];
assert.equal(originalVoices.find(item => item.id === 'fixture-b'), undefined);
const mapping = find(source, node => ts.isArrowFunction(node) && node.parameters[0]?.name.getText(source) === 'mod' && node.body.getText(source).startsWith('mod.OFFICIAL_VOICES.map')).getText(source);
const mappingContext = vm.createContext({}); vm.runInContext(ts.transpileModule(`globalThis.map=(${mapping});`, {}).outputText, mappingContext);
const mapped = mappingContext.map({ OFFICIAL_VOICES: originalVoices }); assert.equal(mapped.find(item => item.id === 'fixture-b').speakerId, 'fixture-b'); cases.push('Official voices without id receive speakerId as their stable select value');
const addButton = find(source, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button' && node.children.some(child => ts.isJsxText(child) && child.text.trim() === '添加第三个音色'));
const onClick = addButton.openingElement.attributes.properties.find(attr => attr.name?.getText(source) === 'onClick').initializer.expression.getText(source);
const added = fixture(); await added.run(onClick); assert.equal(added.state.items.length, 3); assert.deepEqual(JSON.parse(JSON.stringify(added.state.items.slice(0, 2))), two); await added.run(onClick); assert.equal(added.state.items.length, 3); cases.push('Explicit add preserves current voices/weights and never adds a fourth slot');
const report = { passed: true, scenarios: cases.length, cases, actualSource: sourcePath, realNetworkRequests: 0, realDatabaseWrites: 0 };
fs.writeFileSync('.codex-evidence/voice-models-real-e2e-20260903/mix-input-fixture.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
