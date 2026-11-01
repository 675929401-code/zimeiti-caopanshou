import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

// Actual four route functions and metadata/mutation helpers execute in RAM.
// Only external authorization, reads, provider contract, and staging are fakes.
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = new Map();
function source(path) { if (!sources.has(path)) sources.set(path, fs.readFileSync(path, 'utf8')); return sources.get(path); }
function syntax(path) { return ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function actual(path, name, globals = {}) {
  const tree = syntax(path); const nodes = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, `real function ${path}:${name}`);
  const code = nodes[0].getText(tree).replace(/^export\s+/u, '') + `\nmodule.exports=${name};`;
  const module = { exports: null };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, URL, structuredClone, Error, console, ...globals }, { filename: path });
  return module.exports;
}
const metadataPath = 'src/lib/image-model-admin-fields.ts';
const extraPath = 'src/lib/image-model-extra-configuration.ts';
const extraModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(source(extraPath), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
  { module: extraModule, exports: extraModule.exports, TextEncoder, Error }, { filename: extraPath });
const { IMAGE_MODEL_READINESS_KEYS, validateImageModelProtocolConfiguration, parseImageModelExtraConfiguration, imageModelExtraConfiguration } = extraModule.exports;
const imageModelAdminMetadata = actual(metadataPath, 'imageModelAdminMetadata', { IMAGE_MODEL_READINESS_KEYS, validateImageModelProtocolConfiguration });
const pricePath = 'src/lib/model-price-rounding.ts';
const explicitNonNegativePrice = actual(pricePath, 'explicitNonNegativePrice');
const invalidExplicitPriceField = actual(pricePath, 'invalidExplicitPriceField', { explicitNonNegativePrice });
const pendingImageConfigurationUpdate = actual('src/lib/image-model-availability.ts', 'pendingImageConfigurationUpdate', {
  object: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
});
class PlatformConfigurationError extends Error { constructor(code, message) { super(message); this.code = code; } }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const NextResponse = { json: (body, options = {}) => ({ status: options.status || 200, body: JSON.parse(JSON.stringify(body)) }) };
const httpPath = 'src/lib/server/model-pool-mutation-http.ts';
const modelPoolMutationRequest = actual(httpPath, 'modelPoolMutationRequest', { UUID, PlatformConfigurationError });
const modelPoolMutationFailure = actual(httpPath, 'modelPoolMutationFailure', { UUID, PlatformConfigurationError, NextResponse });
const current = { id: 'fixture-existing-image', name: 'Existing', model_name: 'fixture-model', provider: 'fixture',
  api_endpoint: 'https://fixture.invalid/v1', api_key: 'fixture-not-a-credential', cost_price: 0.12, selling_price: 0.34,
  is_active: true, is_hidden: false, supports_image_input: true, sort_order: 9,
  api_protocol_config: { protocol: 'fixture-v1', admin_notes: '旧备注\n必须保留', canary_verified: true } };
const routeDefinitions = [
  ['unified POST', 'src/app/api/admin/models/route.ts', 'POST'],
  ['unified PUT', 'src/app/api/admin/models/route.ts', 'PUT'],
  ['cover POST', 'src/app/api/admin/cover-models/route.ts', 'POST'],
  ['cover PUT', 'src/app/api/admin/cover-models/[id]/route.ts', 'PUT'],
];
async function execute(definition, patch = {}, { authorized = true, requestId = 'b0bb7110-1234-4234-8234-123456789abc', replay = false } = {}) {
  const [label, path, method] = definition, unified = label.startsWith('unified'), editing = method === 'PUT';
  const payload = { ...(editing ? { id: current.id, api_key: '*****' } : { name: 'Fixture image', model_name: 'fixture-model', provider: 'fixture', api_endpoint: current.api_endpoint, api_key: current.api_key, cost_price: current.cost_price,
    ...(unified ? { cost_per_use: current.selling_price } : { selling_price: current.selling_price }), api_protocol_config: { protocol: 'fixture-v1' } }),
    ...(unified ? { model_type: 'drawing' } : {}), ...patch };
  const calls = { json: 0, reads: 0, stage: [], resume: 0 };
  const response403 = NextResponse.json({ code: 'AUTH_DENIED' }, { status: 403 });
  const request = { method, url: 'https://fixture.invalid/api/admin/' + (unified ? 'models' : 'cover-models'),
    headers: new Headers({ authorization: 'Bearer fixture-token', ...(requestId === null ? {} : { 'Idempotency-Key': requestId }) }),
    json: async () => { calls.json++; return structuredClone(payload); } };
  const resumeModelPoolMutationResponse = actual(httpPath, 'resumeModelPoolMutationResponse', {
    NextResponse, resumePlatformModelMutation: async () => { calls.resume++; return replay ? { id: 'fixture-candidate', status: 'candidate' } : null; },
  });
  const globals = { NextResponse, imageModelAdminMetadata, explicitNonNegativePrice, invalidExplicitPriceField,
    pendingImageConfigurationUpdate, modelPoolMutationRequest, modelPoolMutationFailure, resumeModelPoolMutationResponse,
    authorizeModelWrite: async () => authorized ? { ok: true, actor: { userId: 'fixture-admin' } } : { ok: false, response: response403 },
    verifyAdminToken: async () => authorized ? { userId: 'fixture-admin', role: 'admin' } : null,
    getSupabaseClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { calls.reads++; return { data: structuredClone(current), error: null }; } }) }) }) }),
    stageLegacyModelPoolUpsert: async input => { calls.stage.push(JSON.parse(JSON.stringify(input))); return { release: { id: 'fixture-candidate' } }; },
    RETIRED_MODEL_PROVIDER: 'retired_configuration', isPermanentlyRetiredModel: () => false,
    AUTODL_H3_SELFHOST_PROVIDER: 'autodl-selfhost', assertAdminAutodlH3SelfhostBinding: () => {}, resolveImageProviderContract: () => {},
    newPendingImageModelId: () => 'pending-fixture-image', ImageProviderBindingError: class extends Error {},
    ModelActivationGateError: class extends Error {}, ImageAdminValidationError: class extends Error {},
    replacementApiKey: editing ? actual(path, 'replacementApiKey', { MASKED_SECRET: /^(?:[*•●·]+|已配置)$/u }) : undefined,
  };
  const handler = actual(path, method, globals);
  const response = await handler(request, { params: Promise.resolve({ id: current.id }) });
  return { response, calls, payload, values: calls.stage[0]?.values, merged: calls.stage[0] ? { ...current, ...calls.stage[0].values } : null };
}
const cases = [];
for (const route of routeDefinitions) {
  const label = route[0], editing = route[2] === 'PUT';
  const saved = await execute(route, { sort_order: 37, admin_notes: '完整备注\n第二行 中文 🎬' });
  assert.equal(saved.response.status, 202, label); assert.equal(saved.calls.stage.length, 1); assert.equal(saved.values.sort_order, 37);
  assert.equal(saved.values.api_protocol_config.admin_notes, '完整备注\n第二行 中文 🎬'); assert.equal(saved.values.api_protocol_config.protocol, 'fixture-v1');
  assert.equal(saved.merged.cost_price, current.cost_price); assert.equal(saved.merged.selling_price, current.selling_price);
  assert.equal(saved.merged.api_key, current.api_key); assert.equal(saved.merged.is_active, true); assert.equal(saved.merged.is_hidden, false);
  assert.equal(saved.calls.stage[0].requestPayload.body.admin_notes, saved.payload.admin_notes);
  cases.push(label + ': sort37/full note persisted with price/credential/status and raw mutation body preserved');
  const zero = await execute(route, { sort_order: 0, admin_notes: '' }); assert.equal(zero.response.status, 202); assert.equal(zero.values.sort_order, 0); assert.equal(zero.values.api_protocol_config.admin_notes, '');
  if (editing) {
    const omitted = await execute(route); assert.equal(omitted.response.status, 202); assert.deepEqual(omitted.merged.api_protocol_config, current.api_protocol_config); assert.equal(omitted.merged.sort_order, 9);
    const replaced = await execute(route, { api_protocol_config: { protocol: 'fixture-v2' } }); assert.equal(replaced.values.api_protocol_config.admin_notes, current.api_protocol_config.admin_notes); assert.equal(replaced.values.api_protocol_config.protocol, 'fixture-v2');
  }
  for (const value of [-1, '', ' ', null, true, false, 1.5, 2147483648, '1.5', '-1']) {
    const rejected = await execute(route, { sort_order: value }); assert.equal(rejected.response.status, 400, label + ': invalid sort'); assert.equal(rejected.response.body.code, 'IMAGE_MODEL_SORT_ORDER_INVALID'); assert.equal(rejected.calls.stage.length, 0);
  }
  for (const value of [null, 1, true, [], {}]) {
    const rejected = await execute(route, { admin_notes: value }); assert.equal(rejected.response.status, 400); assert.equal(rejected.response.body.code, 'IMAGE_MODEL_ADMIN_NOTES_INVALID'); assert.equal(rejected.calls.stage.length, 0);
  }
  for (const value of [null, 1, 'bad', true, []]) {
    const rejected = await execute(route, { api_protocol_config: value }); assert.equal(rejected.response.status, 400); assert.equal(rejected.response.body.code, 'IMAGE_MODEL_PROTOCOL_CONFIG_INVALID'); assert.equal(rejected.calls.stage.length, 0);
  }
  cases.push(label + ': zero/clear supported; omitted edit preserves; twenty invalid metadata variants never stage');
  for (const requestId of [null, 'invalid-id']) { const result = await execute(route, { sort_order: -1 }, { requestId }); assert.equal(result.response.status, 400); assert.equal(result.response.body.code, 'PLATFORM_CONFIGURATION_REQUEST_ID_INVALID'); assert.equal(result.calls.resume, 0); assert.equal(result.calls.reads, 0); assert.equal(result.calls.stage.length, 0); }
  const replay = await execute(route, { sort_order: -1 }, { replay: true }); assert.equal(replay.response.status, 202); assert.equal(replay.response.body.replayed, true); assert.equal(replay.calls.stage.length, 0); assert.equal(replay.calls.reads, 0);
  const denied = await execute(route, { sort_order: -1 }, { authorized: false }); assert.equal(denied.response.status, 403); assert.equal(denied.calls.json, 0); assert.equal(denied.calls.stage.length, 0);
  cases.push(label + ': actual UUID parsing/replay and authorization precede metadata and staging');
  const completeConfig = { protocol: 'fixture-v1', reference_transport: 'multipart', admin_notes: 'full',
    submit: { path: '/v1/images/submit', method: 'POST', response_path: ['data', 'task_id'] },
    poll: { path: '/v1/images/{taskId}', success_statuses: ['completed', 'success'], interval_ms: 1500 },
    resolution_prices: { '1K': 0.34, '2K': 0.56 }, resolution_cost_prices: { '1K': 0.12 },
    max_reference_images: 14, max_tokens: 4096, credential_scope: 'provider_group', provider_group_name: 'main', capabilities: ['image_input', { ratio: '16:9', enabled: true }] };
  const complete = await execute(route, { api_protocol_config: completeConfig }); assert.equal(complete.response.status, 202); assert.deepEqual(complete.values.api_protocol_config, editing ? { ...completeConfig, canary_verified: true } : completeConfig);
  const forged = Object.fromEntries(IMAGE_MODEL_READINESS_KEYS.map(key => [key, 'forged-accepted']));
  const guarded = await execute(route, { api_protocol_config: { ...completeConfig, ...forged } }); assert.equal(guarded.response.status, 202);
  for (const key of IMAGE_MODEL_READINESS_KEYS) assert.equal(guarded.values.api_protocol_config[key], editing ? current.api_protocol_config[key] : undefined);
  for (const key of ['api_key', 'X-API-Key', 'access_token', 'RefreshToken', 'Authorization', 'client_secret', 'password', 'private-key', 'secret_value']) {
    const rejected = await execute(route, { api_protocol_config: { submit: { headers: { [key]: 'fixture-not-a-secret' } } } });
    assert.equal(rejected.response.status, 400); assert.equal(rejected.response.body.code, 'IMAGE_MODEL_PROTOCOL_CONFIG_SENSITIVE_KEY'); assert.equal(rejected.calls.stage.length, 0);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const rejected = await execute(route, { api_protocol_config: JSON.parse(`{"poll":{"${key}":"unsafe"}}`) }); assert.equal(rejected.response.status, 400); assert.equal(rejected.calls.stage.length, 0);
  }
  let tooDeep = { leaf: true }; for (let depth = 0; depth < 17; depth++) tooDeep = { child: tooDeep };
  for (const config of [{ description: 'x'.repeat(65536) }, tooDeep, { nonfinite: Number.POSITIVE_INFINITY }]) {
    const rejected = await execute(route, { api_protocol_config: config }); assert.equal(rejected.response.status, 400); assert.equal(rejected.calls.stage.length, 0);
  }
  cases.push(label + ': complete submit/poll/prices/capability JSON preserved; nested credential/prototype/size/depth/nonfinite rejected; readiness cannot be forged');
}
const full = { protocol: 'fixture-v1', reference_transport: 'multipart', admin_notes: 'owned', canary_verified: true, submit: { path: '/submit' }, poll: { path: '/poll' }, resolution_prices: { '2K': 1.25 }, capabilities: ['first', { enabled: true }], credential_scope: 'group', provider_group_name: 'main', max_tokens: 8096 };
const extras = imageModelExtraConfiguration(full), parsedExtras = parseImageModelExtraConfiguration(JSON.stringify(extras)); assert.equal(parsedExtras.ok, true); assert.deepEqual(JSON.parse(JSON.stringify(parsedExtras.value)), JSON.parse(JSON.stringify(extras)));
for (const key of ['protocol', 'reference_transport', 'admin_notes', ...IMAGE_MODEL_READINESS_KEYS]) {
  assert.equal(Object.hasOwn(extras, key), false); const parsed = parseImageModelExtraConfiguration(JSON.stringify({ [key]: 'owned' })); assert.equal(parsed.ok, false); assert.equal(parsed.code, 'IMAGE_MODEL_EXTRA_CONFIGURATION_OWNED_KEY');
}
for (const raw of ['[]', 'null', 'invalid JSON', '{"api_key":"fixture"}', ' '.repeat(65537)]) assert.equal(parseImageModelExtraConfiguration(raw).ok, false);
assert.equal(parseImageModelExtraConfiguration('  ').ok, true);
const circular = {}; circular.self = circular; assert.equal(validateImageModelProtocolConfiguration(circular).ok, false);
assert.equal(validateImageModelProtocolConfiguration({ bad: undefined }).ok, false); assert.equal(validateImageModelProtocolConfiguration({ bad: new Date() }).ok, false);
cases.push('actual extra parser roundtrips complete legal provider fields and rejects owned keys, unsafe JSON, limits, cycles and non-JSON values');
const report = { passed: true, cases, actualFunctions: ['imageModelAdminMetadata', 'pendingImageConfigurationUpdate', 'modelPoolMutationRequest', 'resumeModelPoolMutationResponse', 'modelPoolMutationFailure', 'four route handlers'], sourceHashes: Object.fromEntries([...sources].map(([path, text]) => [path, hash(text)])), networkCalls: 0, databaseWrites: 0, providerCalls: 0 };
const evidence = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/image-model-metadata'; fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(evidence + '/zero-network-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
