import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';

const output = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/digital-human';
const originalFetch = globalThis.fetch;
let realNetworkAttempts = 0;
globalThis.fetch = async () => { realNetworkAttempts++; throw new Error('REAL_NETWORK_FORBIDDEN'); };
const files = ['src/components/admin/DigitalHumanAdminTab.tsx', 'src/features/digital-human/presets.ts', 'src/app/api/admin/video-models/route.ts', 'src/components/admin/model-mutation-request.ts', 'src/components/admin/model-candidate-receipt.ts', 'src/lib/model-price-rounding.ts', 'src/lib/model-activation-gate.ts'];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await fs.readFile(file, 'utf8')])));
const astFor = file => ts.createSourceFile(file, sources[file], ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const tabAst = astFor(files[0]); const routeAst = astFor(files[2]);
const nodes = new Map(); let editArrow; let candidateHref; const variantChanges = new Map();
function walk(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) nodes.set(node.name.text, node.initializer);
  if (ts.isFunctionDeclaration(node) && node.name) nodes.set(node.name.text, node);
  if (ts.isJsxAttribute(node) && node.name.getText(tabAst) === 'onClick' && node.initializer && ts.isJsxExpression(node.initializer)) {
    const expression = node.initializer.expression;
    if (expression && ts.isArrowFunction(expression) && /provider: row\.provider/u.test(expression.getText(tabAst))) editArrow = expression;
  }
  if (ts.isJsxAttribute(node) && node.name.getText(tabAst) === 'href' && node.initializer && ts.isJsxExpression(node.initializer)
    && node.initializer.expression?.getText(tabAst).includes('candidateId=')) candidateHref = node.initializer.expression;
  if (ts.isJsxAttribute(node) && node.name.getText(tabAst) === 'onChange' && node.initializer && ts.isJsxExpression(node.initializer)) {
    const expression = node.initializer.expression;
    if (expression && ts.isArrowFunction(expression)) {
      const text = expression.getText(tabAst);
      if (text.includes('resolution_prices:') && text.includes('[resolution]')) variantChanges.set('price', expression);
      if (text.includes('resolution_cost_prices:') && text.includes('[resolution]')) variantChanges.set('cost', expression);
    }
  }
  ts.forEachChild(node, walk);
}
walk(tabAst);
assert.ok(nodes.get('newForm') && nodes.get('save') && editArrow && candidateHref, 'ACTUAL_PRODUCTION_HANDLERS_AND_CANDIDATE_LINK_REQUIRED');
const presets = (await tsImport('../src/features/digital-human/presets.ts', import.meta.url)).HUMAN_PRESETS;
const { readModelCandidateReceipt, modelCandidateSaveMessage } = await tsImport('../src/components/admin/model-candidate-receipt.ts', import.meta.url);
const { modelMutationAttempt } = await tsImport('../src/components/admin/model-mutation-request.ts', import.meta.url);
const { explicitNonNegativePrice, videoPriceConfigurationError } = await tsImport('../src/lib/model-price-rounding.ts', import.meta.url);
const { forceNewVideoModelPending, preservePersistedVideoActivationGate, prepareVideoModelBindingUpdate, ModelActivationGateError } = await tsImport('../src/lib/model-activation-gate.ts', import.meta.url);
const js = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const receipt = { staged: true, published: false, result: { release: { id: '5ea47cca-874a-4c29-80f6-4e569c10cc05', release_version: 105 } } };
function tabHarness(fetcher) {
  const state = { requests: [], notices: [], errors: [], busy: [], loadCalls: 0, closed: 0, candidateId: '' };
  const context = vm.createContext({ HUMAN_PRESETS: presets, JSON, Error, Number, String, Math,
    token: 'fixture-only', saveLock: { current: false }, saveAttempt: { current: null }, form: null,
    readModelCandidateReceipt, modelCandidateSaveMessage, modelMutationAttempt, explicitNonNegativePrice, videoPriceConfigurationError,
    setForm: value => { context.form = value; if (!value) state.closed++; },
    setBusy: value => state.busy.push(value), setError: value => state.errors.push(value), setNotice: value => state.notices.push(value),
    setCandidateId: value => { state.candidateId = value; context.candidateId = value; },
    load: async () => { state.loadCalls++; },
    fetch: (url, init) => { state.requests.push({ url, method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) }); return fetcher(url, init); },
  });
  vm.runInContext(js(`globalThis.newForm=${nodes.get('newForm').getText(tabAst)}; ${nodes.get('save').getText(tabAst)}; globalThis.save=save; globalThis.edit=${editArrow.getText(tabAst)}; globalThis.link=()=>(${candidateHref.getText(tabAst)});`), context);
  for (const [key, expression] of variantChanges) vm.runInContext(js(`globalThis.variant_${key}=${expression.getText(tabAst)};`), context);
  return { state, context, usePreset: index => { context.form = context.newForm(index); context.form.api_key = 'fixture-only-not-a-real-secret'; } };
}

function routeHarness() {
  const routeNodes = new Map();
  function inspect(node) { if (ts.isFunctionDeclaration(node) && node.name) routeNodes.set(node.name.text, node); ts.forEachChild(node, inspect); }
  inspect(routeAst);
  const staged = []; const requests = [];
  class PlatformConfigurationError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const httpFile = 'src/lib/server/model-pool-mutation-http.ts';
  const httpSource = sources[httpFile]; const httpAst = ts.createSourceFile(httpFile, httpSource, ts.ScriptTarget.Latest, true);
  let mutationNode;
  function find(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'modelPoolMutationRequest') mutationNode = node; ts.forEachChild(node, find); }
  find(httpAst); assert.ok(mutationNode);
  const context = vm.createContext({ URL, structuredClone, console: { error() {} },
    NextResponse: { json: (data, init = {}) => response(init.status || 200, data) }, requireAdmin: async () => ({ userId: 'fixture-admin' }),
    resumeModelPoolMutationResponse: async () => null, PlatformConfigurationError,
    videoPriceConfigurationError, explicitNonNegativePrice, forceNewVideoModelPending, preservePersistedVideoActivationGate, prepareVideoModelBindingUpdate, ModelActivationGateError,
    RETIRED_MODEL_PROVIDER: 'retired_configuration', MASKED_SECRET: /^(?:[*•●·]+|已配置)$/u,
    getSupabaseAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    stageLegacyModelPoolUpsert: async value => { staged.push(value); return receipt.result; }, modelPoolMutationFailure: error => error instanceof PlatformConfigurationError ? response(400, { code: error.code }) : null,
  });
  vm.runInContext(js(mutationNode.getText(httpAst).replace(/^export\s+/u, '') + '\nglobalThis.modelPoolMutationRequest=modelPoolMutationRequest;\nconst UUID=/^[a-f0-9-]{36}$/i;'), context);
  for (const name of ['buildRecord', 'generateModelId', 'replacementApiKey', 'POST']) {
    assert.ok(routeNodes.get(name), `REAL_ROUTE_${name}_REQUIRED`);
    vm.runInContext(js(routeNodes.get(name).getText(routeAst).replace(/^export\s+/u, '') + `\nglobalThis.${name}=${name};`), context);
  }
  return { staged, requests, post: async (body, requestId = crypto.randomUUID()) => {
    requests.push({ body, requestId });
    return context.POST({ method: 'POST', url: 'http://fixture.invalid/api/admin/video-models', headers: new Headers({ 'Idempotency-Key': requestId }), json: async () => body });
  } };
}

// Obtain the HTTP helper source after declaring the list; no application request is made.
sources['src/lib/server/model-pool-mutation-http.ts'] = await fs.readFile('src/lib/server/model-pool-mutation-http.ts', 'utf8');
const checks = []; const failures = [];
async function check(name, action) { try { await action(); checks.push(name); } catch (error) { failures.push({ check: name, message: String(error.message).slice(0, 800) }); } }
await check('four-production-presets-newForm-provider-and-real-post-staged-receipt', async () => {
  assert.equal(presets.length, 4);
  for (let index = 0; index < presets.length; index++) {
    const server = routeHarness(); const sample = tabHarness(async (_url, init) => server.post(JSON.parse(init.body), init.headers['Idempotency-Key'])); sample.usePreset(index);
    assert.ok(sample.context.form.provider.trim()); await sample.context.save();
    assert.equal(sample.state.requests.length, 1); assert.equal(server.staged.length, 1);
    assert.equal(server.staged[0].values.provider, presets[index].provider);
    assert.equal(server.staged[0].values.api_protocol_config.__model_activation_gate.state, 'pending');
    assert.equal(sample.state.candidateId, receipt.result.release.id); assert.equal(sample.state.closed, 1);
    assert.equal(sample.state.errors.at(-1), '', 'VALID_CANDIDATE_MUST_NOT_LEAVE_AN_ERROR');
    assert.match(sample.state.notices.at(-1), /待发布候选/); assert.doesNotMatch(sample.state.notices.at(-1), /已启用|自动启用|保存成功.*启用/u);
    assert.equal(sample.context.link(), `/admin?tab=models&candidateId=${receipt.result.release.id}`);
  }
  const unified = await fs.readFile('src/components/unified-models-tab.tsx', 'utf8');
  assert.match(unified, /get\("candidateId"\)/u); assert.match(unified, /setFocusReleaseId\(candidateId\)/u);
});
await check('replayed-published-receipt-reports-current-or-historical-state-without-restaging', async () => {
  for (const isCurrent of [true, false]) {
    const sample = tabHarness(() => response(202, { ...receipt, published: true, replayed: true, result: { release: { ...receipt.result.release, status: isCurrent ? 'published' : 'superseded', is_current: isCurrent } } }));
    sample.usePreset(0); await sample.context.save();
    assert.equal(sample.state.closed, 1); assert.equal(sample.state.errors.at(-1), '');
    assert.match(sample.state.notices.at(-1), isCurrent ? /已发布且为当前版本/u : /历史已发布版本/u);
    assert.doesNotMatch(sample.state.notices.at(-1), /已保存为待发布候选/u);
  }
});
await check('edit-preserves-historical-provider-without-inferring-from-model-name', async () => {
  const sample = tabHarness(() => response(202, receipt));
  sample.context.row = { provider: 'historical-owned-provider', id: 'historical-row', name: 'Unrelated name', model_name: 'videoretalk', protocol_type: 'dashscope_video_retalk', api_endpoint: 'https://fixture.invalid', price_per_use: 1, cost_price: 0.3, max_duration: 120, supports_image_input: false, api_protocol_config: {} };
  sample.context.edit(); assert.equal(sample.context.form.provider, 'historical-owned-provider');
  await sample.context.save(); assert.equal(sample.state.requests[0].method, 'PUT'); assert.equal(sample.state.requests[0].body.provider, 'historical-owned-provider');
});
await check('synchronous-double-click-single-dispatch-lock', async () => {
  let resolve;
  const sample = tabHarness(() => new Promise(done => { resolve = done; })); sample.usePreset(0);
  const first = sample.context.save(); const second = sample.context.save();
  assert.equal(sample.state.requests.length, 1); assert.equal(sample.context.saveLock.current, true);
  resolve(response(202, receipt)); await Promise.all([first, second]);
  assert.deepEqual(sample.state.busy, [true, false]); assert.equal(sample.context.saveLock.current, false);
});
for (const [name, fetcher] of [['empty-200', () => response(200, {})], ['empty-202', () => response(202, {})], ['network-unknown', () => Promise.reject(new Error('fixture-response-lost'))], ['server-unknown', () => response(503, { error: 'fixture-unknown-result', outcome: 'unknown' })]]) {
  await check(`${name}-preserves-form-and-same-logical-retry-idempotency-key`, async () => {
    const sample = tabHarness(fetcher); sample.usePreset(0); const saved = sample.context.form;
    await sample.context.save(); assert.equal(sample.context.form, saved); assert.equal(sample.state.closed, 0); assert.ok(sample.state.errors.at(-1));
    assert.equal(sample.state.candidateId, ''); await sample.context.save();
    assert.equal(sample.state.requests.length, 2); assert.equal(sample.state.requests[0].headers['Idempotency-Key'], sample.state.requests[1].headers['Idempotency-Key']);
    sample.context.form = { ...sample.context.form, name: 'Changed logical payload' }; await sample.context.save();
    assert.notEqual(sample.state.requests[1].headers['Idempotency-Key'], sample.state.requests[2].headers['Idempotency-Key']);
  });
}
await check('blank-and-whitespace-cost-or-sale-reject-before-post-explicit-zero-remains-explicit', async () => {
  for (const field of ['price', 'cost']) for (const value of ['', '   ', '-1', 'NaN']) {
    const sample = tabHarness(() => response(202, receipt)); sample.usePreset(0); sample.context.form[field] = value;
    await sample.context.save(); assert.equal(sample.state.requests.length, 0, `${field}:${JSON.stringify(value)}`); assert.ok(sample.context.form);
  }
  const zero = tabHarness(() => response(202, receipt)); zero.usePreset(0); zero.context.form.price = '0'; zero.context.form.cost = '0'; await zero.context.save();
  assert.equal(zero.state.requests[0].body.price_per_use, 0); assert.equal(zero.state.requests[0].body.cost_price, 0);
});
await check('actual-post-rejects-missing-provider-before-staging', async () => {
  const sample = tabHarness(() => response(202, receipt)); sample.usePreset(0); await sample.context.save();
  const server = routeHarness(); const result = await server.post({ ...sample.state.requests[0].body, provider: '' });
  assert.equal(result.status, 400); assert.equal((await result.json()).code, 'VIDEO_PROTOCOL_BINDING_REQUIRED'); assert.equal(server.staged.length, 0);
});
await check('actual-post-cannot-convert-empty-raw-base-prices-to-zero', async () => {
  const sample = tabHarness(() => response(202, receipt)); sample.usePreset(0); await sample.context.save();
  for (const field of ['cost_price', 'price_per_use']) for (const value of ['', '   ', null, undefined]) {
    const server = routeHarness(); const body = { ...sample.state.requests[0].body, [field]: value };
    const result = await server.post(body);
    assert.equal(result.status, 400, `${field}=${JSON.stringify(value)} must reject before normalization`); assert.equal(server.staged.length, 0);
  }
});
await check('actual-variant-onchange-cannot-silently-convert-empty-resolution-price-to-zero', async () => {
  assert.equal(variantChanges.size, 2, 'ACTUAL_BOTH_VARIANT_PRICE_CHANGE_HANDLERS_REQUIRED');
  for (const field of ['price', 'cost']) {
    const sample = tabHarness(() => response(202, receipt)); sample.usePreset(0);
    sample.context.formConfig = JSON.parse(sample.context.form.config); sample.context.resolution = '720p';
    sample.context[`variant_${field}`]({ target: { value: '' } });
    await sample.context.save();
    assert.equal(sample.state.requests.length, 0, `empty secondary-resolution ${field} must not become explicit zero`);
    assert.ok(sample.context.form);
  }
});
await check('actual-post-rejects-blank-secondary-resolution-and-sale-only-variant', async () => {
  const sample = tabHarness(() => response(202, receipt)); sample.usePreset(0); await sample.context.save();
  for (const field of ['resolution_prices', 'resolution_cost_prices']) {
    const body = structuredClone(sample.state.requests[0].body); body.api_protocol_config[field]['720p'] = '';
    const server = routeHarness(); const result = await server.post(body);
    assert.equal(result.status, 400); assert.equal(server.staged.length, 0);
  }
  const body = structuredClone(sample.state.requests[0].body);
  body.api_protocol_config.resolution_prices['sale-only-fixture'] = '';
  const server = routeHarness(); const result = await server.post(body);
  assert.equal(result.status, 400); assert.equal(server.staged.length, 0);
});
assert.equal(realNetworkAttempts, 0, 'ACTUAL_PRODUCTION_DEPENDENCY_ATTEMPTED_REAL_NETWORK');
globalThis.fetch = originalFetch;
await fs.mkdir(output, { recursive: true });
const sourceHashes = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, crypto.createHash('sha256').update(source).digest('hex')]));
const report = { passed: failures.length === 0, actualAstHandlers: true, sourceHashes, checks, failures, realNetworkCalls: 0, realNetworkAttempts, businessDatabaseWrites: 0, providerCalls: 0, scope: 'actual production UI handlers/newForm/presets and actual video-models POST executed in isolated VM with all persistence/provider boundaries replaced' };
await fs.writeFile(`${output}/candidate-zero-network.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
