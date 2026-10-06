import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const parse = (filename) => ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = parse('src/app/voice-studio/workspace/page.tsx');
const imitate = parse('src/app/voice-studio/imitate/page.tsx');
const voices = parse('src/lib/vs/voices-data.ts');
function find(tree, predicate) {
  let found;
  function walk(node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, walk); }
  walk(tree);
  assert.ok(found, 'Required actual source node must exist');
  return found;
}
const declaration = (tree, name) => find(tree, (node) => ts.isVariableDeclaration(node) && node.name.getText(tree) === name);
function execute(source, globals = {}) {
  const exports = {};
  const context = vm.createContext({ exports, module: { exports }, console, ...globals, require(name) {
    if (name === 'react/jsx-runtime') return require(name);
    throw new Error(`Unexpected dependency ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { fileName: 'actual-ui.tsx', compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  return exports;
}
const actualFormats = execute(`export const value = ${declaration(voices, 'AUDIO_FORMATS').initializer.getText(voices)};`).value;
const fileFormats = execute(`export const value = ${declaration(workspace, 'FILE_AUDIO_FORMATS').initializer.getText(workspace)};`, { AUDIO_FORMATS: actualFormats }).value;
const imitationFormats = execute(`export const value = ${declaration(imitate, 'FORMAT_OPTIONS').initializer.getText(imitate)};`).value;
const attr = (node, name) => node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === name)?.initializer?.text;
const formatSelect = find(workspace, (node) => ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'select' && attr(node.openingElement, 'aria-label') === '音频格式');
const selectElement = execute(`export const value = ${formatSelect.getText(workspace)};`, { FILE_AUDIO_FORMATS: fileFormats, audioFormat: 'mp3', setAudioFormat() {} }).value;
const formatHtml = renderToStaticMarkup(selectElement);
assert.ok(!formatHtml.includes('value="pcm"'));
assert.ok(formatHtml.includes('value="mp3"') && formatHtml.includes('value="wav"') && formatHtml.includes('value="ogg_opus"'));
assert.equal(imitationFormats.some((entry) => entry.value === 'pcm'), false);
assert.equal(actualFormats.some((entry) => entry.value === 'pcm'), true, 'Underlying protocol list remains available for a future dedicated PCM workflow');
console.log('PASS actual workspace selector and imitation options exclude raw PCM');

const textCard = find(workspace, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'TextInputCard');
const longCard = find(workspace, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'TextInputCard' && attr(node, 'title') === '长文本输入（同步合成）');
const cardElement = execute(`${textCard.getText(workspace)}\nexport const value = ${longCard.getText(workspace)};`, { text: 'fixture', setText() {}, FileText: () => null }).value;
const cardHtml = renderToStaticMarkup(cardElement);
assert.ok(cardHtml.includes('maxLength="5000"'));
assert.ok(cardHtml.includes('同步合成') && cardHtml.includes('5000'));
assert.ok(!cardHtml.includes('100000') && !cardHtml.includes('10万') && !cardHtml.includes('异步'));
console.log('PASS actual rendered long-text card describes synchronous 5000-character limit');

const callback = declaration(workspace, 'handleLongTextSynthesize').initializer.getText(workspace);
for (const length of [0, 5000, 5001]) {
  const calls = [];
  const errors = [];
  const statuses = [];
  let accepted = false;
  const actual = execute(`export const run = ${callback};`, {
    selectedVoice: { speakerId: 'fixture-public-voice' }, text: '字'.repeat(length),
    setError: (value) => errors.push(value), setSynthesizing() {}, setResult() {},
    setLongTextStatus: (value) => statuses.push(value), setLongTextAudioUrl() {},
    buildBaseParams: () => ({ format: 'mp3' }),
    submitVoiceRequest: async (scope, payload) => { calls.push({ scope, payload }); return { res: { ok: true }, json: { success: true, data: { audioUrl: 'fixture' } } }; },
    acceptVoiceResult() { accepted = true; },
  });
  await actual.run();
  if (length === 5000) {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, 'long-text');
    assert.equal(calls[0].payload.mode, 'long-text');
    assert.equal(calls[0].payload.text.length, 5000);
    assert.deepEqual(statuses, ['processing', 'success']);
    assert.equal(accepted, true);
  } else {
    assert.equal(calls.length, 0);
    assert.equal(accepted, false);
    assert.ok(errors.some(Boolean));
  }
  console.log(`PASS actual long-text callback boundary ${length}`);
}
console.log('PASS 5 UI capability scenarios; no provider, network, session, storage or DB access');
