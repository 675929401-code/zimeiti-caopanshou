import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRequire = createRequire(import.meta.url);
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error('ZERO_NETWORK_AND_CREDENTIAL_ACCESS_REQUIRED'); };
const compile = (relative, requires, globals = {}) => {
  const filename = path.join(root, relative), module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  vm.runInNewContext(output.outputText, { module, exports: module.exports, require: requires, console, structuredClone, fetch: forbidden, ...globals }, { filename });
  return module.exports;
};
const brands = compile('src/lib/model-brand.ts', () => { throw new Error('UNEXPECTED_BRAND_IMPORT'); });
const gate = compile('src/lib/model-activation-gate.ts', name => {
  if (name === 'node:crypto') return nativeRequire(name);
  if (name === '@/lib/provider-secret') return { resolveProviderSecret(value) { assert.equal(value, 'fixture-only-token'); return value; } };
  throw new Error('UNEXPECTED_GATE_IMPORT');
});

const currentBinding = gate.forceNewVideoModelPending({
  id: 'fixture-kling61', model_name: 'kling-video-v4', provider: 'fixture-secure-skill', protocol_type: 'secure_skill_kling_video',
  api_endpoint: 'https://fixture.invalid/v1', api_key: 'fixture-only-token',
  api_protocol_config: {
    min_duration: 3, min_submit_duration: 3, max_duration: 30, duration_options: [],
    resolution_options: ['720p', '1080p'], default_resolution: '720p',
    resolution_cost_prices: { '720p': .2, '1080p': .4 }, resolution_prices: { '720p': .5, '1080p': 1 },
    max_reference_images: 10, max_reference_audios: 3, supports_audio_input: true, workflow_input_mode: 'multi_image',
    custom_future_option: { keep: true },
  }, is_active: true, is_hidden: false,
});
const model = {
  ...currentBinding, name: 'Offline Kling', model_type: 'video', api_key_configured: true,
  cost_per_use: .5, cost_price: .2, duration_seconds: 10, max_duration: 30,
  icon_url: '/model-brands/kling.svg', admin_notes: 'Existing notes', supports_image_input: true, requires_image: false, sort_order: 61,
};
delete model.api_key;
const wire = value => JSON.parse(JSON.stringify(value));
const initialModel = wire(model);
const cases = [];

function harness(activeModel = model) {
  let hooks = [], hookIndex = 0, pendingEffects = [], saved;
  const React = {
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) { const index = hookIndex++; return hooks[index] ||= { current: initial }; },
    useEffect(effect, dependencies) {
      const index = hookIndex++, previous = hooks[index];
      if (!previous || dependencies?.some((value, item) => !Object.is(value, previous[item]))) { hooks[index] = dependencies; pendingEffects.push(effect); }
    },
    useCallback(callback) { hookIndex++; return callback; },
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const component = compile('src/components/unified-model-dialog.tsx', name => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: node => node };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === '@/lib/model-endpoint') return { modelEndpointError: () => null, modelStationLabel: () => 'Offline fixture' };
    if (name === '@/lib/model-connection-summary') return { formatModelPrice: value => String(value), modelConnectionSummary: () => ({ label: 'Offline', provider: 'Fixture', kind: 'relay' }) };
    if (name === '@/lib/video-model-capabilities') return { getVideoBillingUnit: value => value.api_protocol_config?.billing_unit || 'per_use' };
    if (name === '@/lib/model-brand') return brands;
    if (name === '@/lib/llm-provider-presets') return { LLM_PROVIDER_PRESETS: [], getLlmProviderPreset: () => undefined };
    if (name === '@/lib/image-model-extra-configuration') return { imageModelExtraConfiguration: () => ({}), parseImageModelExtraConfiguration: () => ({ ok: true, value: {} }) };
    throw new Error(`UNEXPECTED_DIALOG_IMPORT:${name}`);
  }, { document: { body: {} }, alert: forbidden });
  const render = () => {
    hookIndex = 0; pendingEffects = [];
    const tree = component.default({ model: activeModel, modelType: 'video', onSave: value => { saved = wire(value); }, onClose() {}, token: 'fixture-browser-context' });
    const effects = pendingEffects; pendingEffects = []; for (const effect of effects) effect();
    return tree;
  };
  render();
  let tree = render();
  const all = (node, predicate, found = []) => {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) { for (const child of node) all(child, predicate, found); return found; }
    if (predicate(node)) found.push(node);
    all(node.props?.children, predicate, found); return found;
  };
  const one = predicate => { const nodes = all(tree, predicate); assert.equal(nodes.length, 1, 'REAL_COMPONENT_CONTROL_MUST_BE_UNIQUE'); return nodes[0]; };
  const label = (name, value) => {
    const node = one(node => node.props?.['aria-label'] === name);
    node.props.onChange({ target: { value } }); tree = render();
  };
  const change = (predicate, event) => { one(predicate).props.onChange(event); tree = render(); };
  const click = predicate => { one(predicate).props.onClick(); tree = render(); };
  const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : '';
  const price = (resolution, value) => {
    const row = one(node => node.type === 'div' && String(node.props?.className || '').includes('grid-cols-[110px_1fr_1fr_100px]') && text(node.props.children[0]) === resolution);
    const inputs = all(row, node => node.type === 'input' && node.props.type === 'number');
    assert.equal(inputs.length, 2); inputs[1].props.onChange({ target: { value: String(value) } }); tree = render();
  };
  const save = () => {
    one(node => node.type === 'button' && text(node) === '保存为候选').props.onClick();
    assert.ok(saved, 'REAL_COMPONENT_ONSAVE_MUST_RUN'); return saved;
  };
  return { label, change, click, price, save, exports: component };
}

function unchangedContract(payload, label) {
  assert.deepEqual(payload.api_protocol_config, wire(currentBinding.api_protocol_config), `${label}: exact original protocol fields and absent keys`);
  assert.equal(Object.hasOwn(payload.api_protocol_config, 'resolution'), false);
  assert.equal(Object.hasOwn(payload.api_protocol_config, 'supports_duration'), false);
  for (const key of ['cost_per_use', 'price_per_use', 'cost_price', 'duration_seconds', 'max_duration', 'protocol_type', 'api_endpoint', 'api_key']) assert.equal(Object.hasOwn(payload, key), false, `${label}: unchanged field ${key} must not be patched`);
  const prepared = wire(gate.prepareVideoModelBindingUpdate(currentBinding, payload));
  assert.deepEqual(prepared.api_protocol_config.__model_activation_gate, wire(currentBinding.api_protocol_config.__model_activation_gate), `${label}: activation gate must remain byte-for-byte unchanged`);
}

for (const [label, control, value] of [
  ['avatar', '模型头像地址', '/api/avatars?key=fixture-kling-upload.png'],
  ['name', '用户展示名称', 'New display name'],
]) {
  const ui = harness(); ui.label(control, value); const payload = ui.save();
  unchangedContract(payload, label);
  assert.equal(payload[label === 'avatar' ? 'icon_url' : 'name'], value); cases.push(`${label}:real-component-save-preserves-binding`);
}
{
  const ui = harness();
  ui.click(node => node.props?.['data-model-brand-option'] === 'xai');
  const payload = ui.save(); unchangedContract(payload, 'built-in-brand-avatar');
  assert.equal(payload.icon_url, '/model-brands/xai.svg');
  cases.push('built-in-brand-avatar:real-control-save-preserves-binding');
}
{
  const ui = harness();
  ui.change(node => node.type === 'textarea' && node.props.value === model.admin_notes, { target: { value: 'Updated note only' } });
  const payload = ui.save(); unchangedContract(payload, 'notes'); assert.equal(payload.admin_notes, 'Updated note only'); cases.push('notes:real-component-save-preserves-binding');
}
{
  const ui = harness(); ui.price('720p', .75); const payload = ui.save();
  assert.equal(payload.api_protocol_config.resolution_prices['720p'], .75);
  assert.equal(Object.hasOwn(payload.api_protocol_config, 'supports_duration'), false); assert.equal(Object.hasOwn(payload.api_protocol_config, 'resolution'), false);
  assert.equal(payload.api_protocol_config.min_duration, 3); assert.equal(payload.price_per_use, .75);
  assert.notEqual(gate.prepareVideoModelBindingUpdate(currentBinding, payload).api_protocol_config.__model_activation_gate.binding_sha256, currentBinding.api_protocol_config.__model_activation_gate.binding_sha256);
  cases.push('tier-price:explicit-map-price-update-without-unrelated-defaults');
}
{
  const ui = harness(); ui.change(node => node.type === 'input' && node.props.name === 'default-video-resolution' && node.props.checked === false && node.props.disabled === false, {});
  const payload = ui.save(); assert.equal(payload.api_protocol_config.default_resolution, '1080p'); assert.equal(payload.api_protocol_config.resolution, '1080p'); assert.equal(payload.price_per_use, 1);
  assert.equal(Object.hasOwn(payload.api_protocol_config, 'supports_duration'), false); assert.equal(payload.api_protocol_config.min_duration, 3);
  cases.push('default-resolution:explicit-default-and-price-change-retained');
}
{
  const ui = harness(); ui.change(node => node.type === 'input' && node.props.type === 'number' && node.props.min === '1' && node.props.value === 10, { target: { value: '12' } });
  const payload = ui.save(); assert.equal(payload.duration_seconds, 12); assert.equal(payload.api_protocol_config.min_duration, 3); assert.equal(payload.api_protocol_config.min_submit_duration, 3);
  assert.equal(Object.hasOwn(payload.api_protocol_config, 'supports_duration'), false); assert.equal(Object.hasOwn(payload.api_protocol_config, 'resolution'), false);
  cases.push('range-default-duration:default-change-preserves-minimum-boundary');
}
{
  const ui = harness(); ui.change(node => node.type === 'input' && node.props.type === 'number' && node.props.min === '1' && node.props.value === 30, { target: { value: '25' } });
  const payload = ui.save(); assert.equal(payload.max_duration, 25); assert.equal(payload.api_protocol_config.max_duration, 25); assert.equal(payload.api_protocol_config.min_duration, 3);
  cases.push('range-maximum:explicit-bound-update-retained');
}
{
  const ui = harness(); ui.change(node => node.type === 'select' && node.props.value === 'range', { target: { value: 'fixed' } });
  const payload = ui.save(); assert.equal(payload.api_protocol_config.supports_duration, false); assert.deepEqual(payload.api_protocol_config.duration_options, [10]);
  assert.equal(payload.api_protocol_config.min_duration, 10); assert.equal(payload.api_protocol_config.max_duration, 10); assert.equal(payload.max_duration, 10);
  assert.equal(Object.hasOwn(payload.api_protocol_config, 'resolution'), false);
  cases.push('duration-mode:explicit-fixed-mode-contract-retained');
}
{
  const ui = harness(); ui.label('渠道分组', 'Fixture group 61'); const payload = ui.save();
  assert.equal(payload.api_protocol_config.connection_group, 'Fixture group 61');
  assert.equal(payload.api_protocol_config.min_duration, 3); assert.equal(Object.hasOwn(payload.api_protocol_config, 'resolution'), false); assert.equal(Object.hasOwn(payload.api_protocol_config, 'supports_duration'), false);
  assert.notEqual(gate.prepareVideoModelBindingUpdate(currentBinding, payload).api_protocol_config.__model_activation_gate.binding_sha256, currentBinding.api_protocol_config.__model_activation_gate.binding_sha256);
  cases.push('direct-protocol-config-edit:explicit-group-change-retained');
}
{
  const ui = harness(); ui.label('视频模型接口协议', 'secure_skill_grok_video'); const payload = ui.save();
  assert.equal(payload.protocol_type, 'secure_skill_grok_video'); assert.equal(payload.api_protocol_config.supports_duration, true);
  assert.notEqual(gate.prepareVideoModelBindingUpdate(currentBinding, payload).api_protocol_config.__model_activation_gate.binding_sha256, currentBinding.api_protocol_config.__model_activation_gate.binding_sha256);
  cases.push('protocol-selection:existing-explicit-preset-mapping-retained');
}
{
  const ui = harness(), preserve = ui.exports.preserveUnchangedVideoEditPayload;
  for (const model_type of ['drawing', 'text']) {
    const computed = { model_type, api_protocol_config: { explicit: true }, name: 'Unchanged other flow' };
    assert.equal(preserve(model, {}, {}, computed), computed);
    cases.push(`${model_type}:payload-path-unchanged`);
  }
  const newModel = { model_type: 'video', api_protocol_config: { supports_duration: true, resolution: '720p' } };
  assert.equal(preserve(null, null, {}, newModel), newModel); cases.push('new-video-model:existing-mapping-unchanged');
  assert.deepEqual(wire(model), initialModel); cases.push('input-model-and-gate-not-mutated');
}
assert.equal(forbiddenCalls, 0);
console.log(JSON.stringify({ passed: true, checks: cases.length, cases, realNetworkCalls: 0, providerCalls: 0, databaseWrites: 0, credentialReads: 0, browserCalls: 0, scope: 'actual TSX component hooks/effects/controls/onSave; actual activation fingerprint functions with a literal fixture credential resolver' }));
