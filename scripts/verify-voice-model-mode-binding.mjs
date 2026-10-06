import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const beforePath = '.codex-backups/20260903-voice-model-mode-binding/workspace-page.tsx';
const target = process.argv.includes('--source') ? 'src/app/voice-studio/workspace/page.tsx' : '.codex-evidence/voice-models-real-e2e-20260903/staging/workspace-page.tsx';
const parse = path => ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const before = parse(beforePath), after = parse(target);
function find(ast, predicate) { let result; const visit = node => { if (result) return; if (predicate(node)) { result = node; return; } ts.forEachChild(node, visit); }; visit(ast); assert.ok(result, 'ACTUAL_CALLBACK_REQUIRED'); return result; }
const initializer = (ast, name) => find(ast, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name).initializer.getText(ast);
function fixture({ mode = 'single', model = 'tts', busy = false, refs = ['https://owned-fixture.invalid/reference.mp3'], text = '你好，这是音频模式验证。' } = {}) {
  const state = { mode, model, synthesizing: busy, errors: [], requests: [], results: [] };
  const context = vm.createContext({ ...state, audioGenLinks: refs, audioGenText: text, audioFormat: 'mp3', sampleRate: 24000,
    setModel: value => { state.model = value; context.model = value; }, setMode: value => { state.mode = value; context.mode = value; },
    setSynthesizing: value => { state.synthesizing = value; context.synthesizing = value; }, setError: value => state.errors.push(value), setResult() {}, acceptVoiceResult: value => state.results.push(value),
    submitVoiceRequest: async (scope, body) => { state.requests.push({ scope, body: JSON.parse(JSON.stringify(body)) }); return { res: { ok: true }, json: { success: true, data: { fixture: true } } }; },
  });
  const load = expression => { vm.runInContext(ts.transpileModule(`globalThis.fn = (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context); return context.fn; };
  return { state, load };
}
const oldButton = find(before, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(before) === 'button' && node.children.some(child => ts.isJsxText(child) && child.text.trim() === 'seed-audio 1.0'));
const oldOnClick = oldButton.openingElement.attributes.properties.find(attr => attr.name?.getText(before) === 'onClick').initializer.expression.getText(before);
const cases = [];
const old = fixture(); old.load(oldOnClick)(); assert.equal(old.state.model, 'audio'); assert.equal(old.state.mode, 'single'); cases.push('Old real audio-model button changes only its highlight while keeping TTS submit mode');
for (const [mode, selectedModel, expected] of [['single', 'audio', 'audio-gen'], ['audio-gen', 'tts', 'single'], ['dual', 'tts', 'dual'], ['mix', 'tts', 'mix']]) {
  const test = fixture({ mode }); test.load(initializer(after, 'handleSynthesisModelChange'))(selectedModel); assert.equal(test.state.model, selectedModel); assert.equal(test.state.mode, expected); assert.equal(test.state.requests.length, 0); cases.push(`Model selection ${mode} to ${selectedModel} binds ${expected} without submitting`);
}
for (const mode of ['single', 'dual', 'long-text', 'mix', 'audio-gen']) {
  const test = fixture({ mode: 'audio-gen', model: 'audio' }); test.load(initializer(after, 'handleSynthesisModeChange'))(mode); assert.equal(test.state.model, mode === 'audio-gen' ? 'audio' : 'tts'); assert.equal(test.state.mode, mode); assert.equal(test.state.requests.length, 0); cases.push(`Mode ${mode} synchronizes its visible model without submitting`);
}
const busy = fixture({ busy: true }); busy.load(initializer(after, 'handleSynthesisModelChange'))('audio'); busy.load(initializer(after, 'handleSynthesisModeChange'))('audio-gen'); assert.equal(busy.state.mode, 'single'); assert.equal(busy.state.model, 'tts'); cases.push('In-flight selection cannot relabel the active request');
const actual = fixture(); actual.load(initializer(after, 'handleSynthesisModelChange'))('audio'); await actual.load(initializer(after, 'handleAudioGen'))();
assert.equal(actual.state.requests.length, 1); assert.equal(actual.state.requests[0].scope, 'seed-audio'); assert.equal(actual.state.requests[0].body.model, 'seed-audio-1.0'); assert.equal(actual.state.requests[0].body.textPrompt, '你好，这是音频模式验证。'); assert.equal(actual.state.requests[0].body.text, undefined); assert.equal(actual.state.requests[0].body.references.length, 1); cases.push('Actual audio handler uses seed-audio phase/textPrompt/references with the selected audio model');
const noRef = fixture({ refs: [] }); await noRef.load(initializer(after, 'handleAudioGen'))(); assert.equal(noRef.state.requests.length, 0); assert.ok(noRef.state.errors.some(text => text.includes('参考音频'))); cases.push('Missing reference audio is explained before submission');
const report = { passed: true, scenarios: cases.length, cases, target, actualCallbacks: true, realNetworkRequests: 0, realDatabaseWrites: 0 };
fs.writeFileSync('.codex-evidence/voice-models-real-e2e-20260903/mode-binding-fixture.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
