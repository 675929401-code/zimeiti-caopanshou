#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { canonicalJson, sha256, validateOrigin, getJson, compareRows, projectCatalog, projectModels, compareModelSections, projectOwnerDiagnostics, compareOwnerDiagnostics } from './lib/public-configuration-parity.mjs';
import { parseArgs, loadSourceContract, buildReport } from './compare-public-configuration-readonly.mjs';

let passed = 0;
const check = async (name, work) => { await work(); passed++; console.log(`PASS ${name}`); };
const clone = value => structuredClone(value);
const contract = { displayCategory: row => `display:${row.category}`, getAgentNavigationKey: row => `permission:${row.category}`, surfaces: [{ id: 'image', kind: 'image', route: '/api/cover-models?surface=image-workbench' }] };
const agent = { id: 'agent-a', name: 'Agent A', category: 'creative', source: 'llm', is_active: true, user_access: 'available', preset_fields: { b: 2, a: 1 }, description: 'PRIVATE_FREE_TEXT' };
const categories = { categories: [{ id: 'category-a', name: 'creative', user_can_use: true, is_active: true }] };
const model = { id: 'pm_fixture', displayName: 'Fixture', publicPrice: 1, capabilities: { available: true, priceReady: true, generationReady: true, supportsImageInput: true } };
const options = parseArgs(['--left', 'http://127.0.0.1:5000', '--right', 'https://example.test', '--mode', 'strict', '--public-only']);
const ownerBody = () => ({ schemaVersion: 'configuration-identity.v1', readOnly: true, configurationSource: { status: 'verified', source: 'fixture' }, ...Object.fromEntries(['agents', 'categories', 'membershipPackages', 'modelPoolRelease', 'workspaceModelRelease'].map(key => [key, { status: 'verified', sha256: sha256(key), items: [{ id: 'same-id', revision: 1, version: 1, promptSha256: sha256('safe-digest') }] }])) });

await check('canonical semantics ignore JSON object key order but preserve array order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.notEqual(sha256([1, 2]), sha256([2, 1]));
  assert.equal(compareRows([{ id: '1', object: { b: 1, a: 2 } }], [{ id: '1', object: { a: 2, b: 1 } }]).status, 'EQUAL');
});
await check('equal counts never hide changed ID sets and changed semantic fields', () => {
  const difference = compareRows([{ id: '1', name: 'old' }, { id: '2' }], [{ id: '1', name: 'new' }, { id: '3' }]);
  assert.deepEqual(difference.onlyLeft, ['2']); assert.deepEqual(difference.onlyRight, ['3']);
  assert.deepEqual(difference.changed[0].fields, ['name']); assert.equal(difference.status, 'DIFFERENT');
  assert.throws(() => compareRows([{ id: '1' }, { id: '1' }], []), /DUPLICATE_ID/u);
  assert.throws(() => compareRows([{}], []), /ID_REQUIRED/u);
});
await check('catalog category projection is distinct from permission and free text is hashed', () => {
  const catalog = projectCatalog({ agents: [agent] }, categories, contract);
  assert.equal(catalog.rows[0].displayCategory, 'display:creative');
  assert.equal(catalog.rows[0].permissionGroup, 'permission:creative');
  assert.equal(catalog.rows[0].catalogAdmission, 'AVAILABLE_AT_CATALOG_LEVEL');
  assert.ok(!JSON.stringify(catalog).includes('PRIVATE_FREE_TEXT'));
  const readonly = clone(categories); readonly.categories[0].user_can_use = false;
  assert.equal(projectCatalog({ agents: [agent] }, readonly, contract).rows[0].catalogAdmission, 'VIEW_ONLY');
  assert.equal(projectCatalog({ agents: [{ ...agent, is_active: null }] }, categories, contract).unverified, 1);
  const reorder = { ...agent, preset_fields: { a: 1, b: 2 } };
  assert.equal(compareRows(catalog.rows, projectCatalog({ agents: [reorder] }, categories, contract).rows).status, 'EQUAL');
  const opaqueChanged = projectCatalog({ agents: [{ ...agent, model_public_id: 'environment-specific-id' }] }, categories, contract);
  assert.equal(compareRows(catalog.rows, opaqueChanged.rows).status, 'EQUAL');
  assert.equal(compareRows(catalog.opaquePublicModelBindings, opaqueChanged.opaquePublicModelBindings).status, 'DIFFERENT');
  assert.throws(() => projectCatalog({ agents: [agent, agent] }, categories, contract), /DUPLICATE_ID/u);
});
await check('model admission requires explicit real flags and tracks blocked/unavailable rows', () => {
  assert.equal(projectModels({ models: [model] }, 'image').serverDeclaredReady, 1);
  assert.equal(projectModels({ models: [{ ...model, capabilities: { priceReady: true } }] }, 'image').unverified, 1);
  assert.equal(projectModels({ models: [{ ...model, capabilities: { ...model.capabilities, generationReady: false } }] }, 'image').blocked, 1);
  assert.equal(projectModels({ models: [], unavailableModels: [model] }, 'text').blocked, 1);
  assert.throws(() => projectModels({ models: [model], unavailableModels: [model] }, 'text'), /DUPLICATE_ID/u);
  assert.throws(() => projectModels({ models: [{}] }, 'image'), /ID_REQUIRED/u);
  assert.throws(() => projectModels({}, 'image'), /ARRAY_REQUIRED/u);
});
await check('salted public model IDs do not imply missing models or physical binding equivalence', () => {
  const left = projectModels({ models: [model] }, 'image');
  const right = projectModels({ models: [{ ...model, id: 'pm_other_site' }] }, 'image');
  const comparison = compareModelSections(left, right);
  assert.equal(comparison.status, 'EQUAL'); assert.equal(comparison.semanticMultiset.status, 'EQUAL');
  assert.equal(comparison.opaqueIdSets.status, 'DIFFERENT'); assert.equal(comparison.physicalBinding.status, 'UNVERIFIED');
  assert.equal(left.sha256, right.sha256);
});
await check('model semantic multisets preserve price/readiness/capability changes and duplicate counts', () => {
  const left = projectModels({ models: [model] }, 'image');
  for (const changed of [
    { ...model, id: 'pm_salted', publicPrice: 9 },
    { ...model, id: 'pm_salted', capabilities: { ...model.capabilities, generationReady: false } },
    { ...model, id: 'pm_salted', capabilities: { ...model.capabilities, supportsImageInput: false } },
    { ...model, id: 'pm_salted', tokenPricing: { outputCost: 7 } },
  ]) assert.equal(compareModelSections(left, projectModels({ models: [changed] }, 'image')).status, 'DIFFERENT');
  const duplicates = projectModels({ models: [model, { ...model, id: 'pm_same_semantics' }] }, 'image');
  const duplicateComparison = compareModelSections(left, duplicates);
  assert.equal(duplicateComparison.status, 'DIFFERENT');
  assert.equal(duplicateComparison.semanticMultiset.multiplicityDifferences.length, 1);
  assert.equal(duplicateComparison.semanticMultiset.multiplicityDifferences[0].leftCount, 1);
  assert.equal(duplicateComparison.semanticMultiset.multiplicityDifferences[0].rightCount, 2);
  assert.equal(compareModelSections(duplicates, projectModels({ models: [{ ...model, id: 'pm_salt_one' }, { ...model, id: 'pm_salt_two' }] }, 'image')).status, 'EQUAL');
});
await check('same visible model name cannot hide distinct models or meaningful API ordering changes', () => {
  const second = { ...model, id: 'pm_second', publicPrice: 2 };
  const left = projectModels({ models: [model, second] }, 'image');
  const right = projectModels({ models: [{ ...second, id: 'pm_salt_second' }, { ...model, id: 'pm_salt_first' }] }, 'image');
  const comparison = compareModelSections(left, right);
  assert.equal(comparison.semanticMultiset.status, 'EQUAL'); assert.equal(comparison.apiOrder.status, 'DIFFERENT'); assert.equal(comparison.status, 'DIFFERENT');
  assert.equal(compareModelSections(left, { ...left, apiOrderPreserved: false }).status, 'UNVERIFIED');
});
await check('owner semantic hashes ignore timestamps/revisions but unavailable domains stay unverified', () => {
  const left = ownerBody(), right = ownerBody();
  right.observedAt = 'new'; right.agents.items[0].revision = 999; right.membershipPackages.items[0].version = 20;
  assert.equal(compareOwnerDiagnostics(projectOwnerDiagnostics(left), projectOwnerDiagnostics(right)).status, 'EQUAL');
  assert.equal(compareOwnerDiagnostics(projectOwnerDiagnostics(left), projectOwnerDiagnostics(right)).sections.agents.items.status, 'EQUAL');
  right.agents.sha256 = sha256('different');
  assert.equal(compareOwnerDiagnostics(projectOwnerDiagnostics(left), projectOwnerDiagnostics(right)).status, 'DIFFERENT');
  right.agents.status = 'unavailable'; right.agents.sha256 = null;
  assert.equal(projectOwnerDiagnostics(right).status, 'UNVERIFIED');
  assert.throws(() => projectOwnerDiagnostics({ ...left, readOnly: false }), /SCHEMA_REQUIRED/u);
  assert.ok(!JSON.stringify(projectOwnerDiagnostics(left)).includes('safe-digest'));
});
await check('invocation rejects unsafe origins, raw secret options and malformed env arguments', () => {
  const withUserInfo = new URL('https://example.test');
  withUserInfo.username = 'fixture-user';
  withUserInfo.password = 'fixture-password';
  const withQuery = new URL('https://example.test');
  withQuery.searchParams.set('token', 'fixture-invalid');
  for (const origin of ['http://example.test', withUserInfo.href, 'https://example.test/path', withQuery.href, 'https://example.test#bad']) assert.throws(() => validateOrigin(origin));
  assert.equal(validateOrigin('http://127.0.0.1:5000'), 'http://127.0.0.1:5000');
  for (const extra of [['--left-token', 'raw'], ['--left-token-env', 'raw secret'], ['--timeout-ms', 'NaN'], ['--mode', 'pass'], ['--left', 'https://again.test'], ['--right-connect-address', 'host.test']]) assert.throws(() => parseArgs(['--left', 'http://127.0.0.1:5000', '--right', 'https://example.test', ...extra]));
  assert.throws(() => parseArgs(['--left', 'http://127.0.0.1:5000', '--right', 'https://example.test', '--audience', 'authenticated']), /REQUIRES_BOTH_TOKENS/u);
  assert.equal(parseArgs(['--left', 'http://127.0.0.1:5000', '--right', 'https://example.test', '--mode', 'strict']).requireOwnerDiagnostics, true);
});

async function stubTransport(protocol, spec, work) {
  const module = protocol === 'https:' ? https : http;
  const original = module.request;
  let calls = 0;
  module.request = (url, requestOptions, callback) => {
    calls++;
    spec.inspect?.(url, requestOptions);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      if (spec.neverRespond) return;
      if (spec.error) { request.emit('error', Object.assign(new Error('Bearer RAW_SECRET'), { code: spec.error })); return; }
      const response = new PassThrough();
      response.statusCode = spec.status ?? 200;
      response.headers = { 'content-type': spec.contentType ?? 'application/json', ...(spec.headers || {}) };
      callback(response);
      if (spec.abort) response.emit('aborted');
      else if (!spec.neverEnd) response.end(spec.body ?? JSON.stringify({ ok: true }));
    });
    return request;
  };
  try { await work(() => calls); } finally { module.request = original; }
}

await check('TLS hostname and certificate verification survive IP override; auth never enters report', async () => {
  await stubTransport('https:', { inspect(url, requestOptions) {
    assert.equal(url.hostname, 'example.test'); assert.equal(requestOptions.rejectUnauthorized, true); assert.equal(requestOptions.method, 'GET');
    assert.equal(requestOptions.headers.Authorization, 'Bearer RAW_SECRET'); assert.equal(requestOptions.headers['x-admin-step-up'], 'STEP_SECRET');
    requestOptions.lookup('example.test', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '203.0.113.8'); assert.equal(family, 4); });
    requestOptions.lookup('example.test', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '203.0.113.8', family: 4 }]); });
  } }, async count => {
    const result = await getJson('https://example.test', '/api/version', { token: 'RAW_SECRET', diagnosticHeaders: { 'x-admin-step-up': 'STEP_SECRET' }, connectAddress: '203.0.113.8' });
    assert.equal(result.ok, true); assert.equal(count(), 1); assert.equal(result.tlsVerificationEnabled, true);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
});
await check('redirect/status/type/schema/size/abort/error/timeout all fail without retry or body logging', async () => {
  const redirectTarget = new URL('https://other.test');
  redirectTarget.searchParams.set('token', 'RAW_SECRET');
  for (const [spec, error] of [
    [{ status: 302, headers: { location: redirectTarget.href } }, 'REDIRECT_REFUSED'],
    [{ status: 401, body: 'RAW_SECRET' }, 'HTTP_401'], [{ contentType: 'text/html', body: 'RAW_SECRET' }, 'JSON_CONTENT_TYPE_REQUIRED'],
    [{ body: '{invalid RAW_SECRET' }, 'INVALID_JSON_OBJECT'], [{ body: '[]' }, 'INVALID_JSON_OBJECT'],
    [{ body: JSON.stringify({ data: 'x'.repeat(200) }) }, 'RESPONSE_TOO_LARGE'], [{ abort: true }, 'RESPONSE_ABORTED'],
    [{ error: 'CERT_HAS_EXPIRED' }, 'CERT_HAS_EXPIRED'], [{ neverRespond: true }, 'REQUEST_TIMEOUT'], [{ neverEnd: true }, 'REQUEST_TIMEOUT'],
  ]) await stubTransport('http:', spec, async count => {
    const result = await getJson('http://127.0.0.1:5000', '/api/version', { timeoutMs: 10, maxBytes: 100 });
    assert.equal(result.ok, false); assert.equal(result.error, error); assert.equal(count(), 1);
    assert.ok(!JSON.stringify(result).includes('RAW_SECRET'));
  });
});
await check('unsafe transport paths/headers are rejected before dispatch', async () => {
  await stubTransport('http:', {}, async count => {
    for (const route of ['//external.test/api/version', '/outside', '/api/version#bad']) await assert.rejects(getJson('http://127.0.0.1:5000', route));
    await assert.rejects(getJson('http://127.0.0.1:5000', '/api/version', { diagnosticHeaders: { authorization: 'secret' } }));
    assert.equal(count(), 0);
  });
});

function fixtureRequest(change = () => {}) {
  const calls = [];
  const request = async (origin, route, requestOptions) => {
    calls.push({ origin, route, options: requestOptions });
    let body = route === '/api/version' ? { sourceVersion: 'R-fixture', buildId: origin.includes('127.0.0.1') ? 'local-build' : 'prod-build' }
      : route === '/api/bots?shape=agents' ? { agents: [clone(agent)] }
      : route === '/api/categories' ? clone(categories)
      : route === '/api/auth/me' ? { user: { id: 'member-id', role: 'user' } }
      : route === '/api/admin/configuration-identity' ? ownerBody() : { models: [clone(model)] };
    const result = { ok: true, status: 200, route, body };
    change(result, origin, route, calls);
    return result;
  };
  return { request, calls };
}

await check('strict gate accepts same source/catalogs despite different deployment build IDs', async () => {
  const fixture = fixtureRequest();
  const report = await buildReport(options, contract, fixture.request);
  assert.equal(report.evaluation.exitCode, 0); assert.equal(report.evaluation.status, 'ALIGNED_WITHIN_CHECKED_SCOPE');
  assert.equal(report.comparison.ownerDiagnostics.status, 'UNVERIFIED');
  assert.ok(fixture.calls.every(call => !call.options.token && !call.route.includes('/api/admin/')));
  assert.equal(report.scope.modelCalls, 0);
});
await check('strict gate blocks unavailable endpoints, malformed catalogs, unknown admission and identity drift', async () => {
  for (const change of [
    (result, origin, route) => { if (route === '/api/cover-models?surface=image-workbench' && origin.includes('example')) { result.ok = false; result.error = 'HTTP_503'; } },
    (result, origin, route) => { if (route === '/api/bots?shape=agents') result.body.agents.push(clone(agent)); },
    (result, origin, route) => { if (route.startsWith('/api/cover-models')) delete result.body.models[0].capabilities.available; },
    (result, origin, route, calls) => { if (route === '/api/version' && calls.filter(call => call.origin === origin && call.route === route).length > 1) result.body.sourceVersion = 'changed'; },
    (result, origin, route) => { if (route === '/api/version') delete result.body.sourceVersion; },
    (result, origin, route) => { if (route === '/api/bots?shape=agents') delete result.body.agents[0].is_active; },
  ]) {
    const fixture = fixtureRequest(change);
    const report = await buildReport(options, contract, fixture.request);
    assert.equal(report.evaluation.exitCode, 1); assert.ok(report.evaluation.blockers.length);
  }
});
await check('informational reports drift while strict source expectations and required owner diagnostics fail closed', async () => {
  const fixture = fixtureRequest((result, origin, route) => { if (origin.includes('example') && route === '/api/bots?shape=agents') result.body.agents[0].id = 'different-id'; });
  assert.equal((await buildReport({ ...options, mode: 'informational' }, contract, fixture.request)).evaluation.exitCode, 0);
  assert.equal((await buildReport({ ...options, expectLeftSource: 'other' }, contract, fixtureRequest().request)).evaluation.exitCode, 1);
  assert.equal((await buildReport({ ...options, requireOwnerDiagnostics: true }, contract, fixtureRequest().request)).evaluation.exitCode, 1);
  const ownerFixture = fixtureRequest();
  const ownerReport = await buildReport({ ...options, includeOwnerDiagnostics: true, requireOwnerDiagnostics: true, leftToken: 'LEFT_SECRET', rightToken: 'RIGHT_SECRET', leftStepUp: 'STEP_SECRET' }, contract, ownerFixture.request);
  assert.equal(ownerReport.evaluation.exitCode, 0);
  assert.equal(ownerFixture.calls.find(call => call.route === '/api/admin/configuration-identity' && call.origin.includes('127.0.0.1')).options.diagnosticHeaders['x-admin-step-up'], 'STEP_SECRET');
  assert.ok(!JSON.stringify(ownerReport).includes('SECRET'));
});
await check('authenticated identities must be live and both roles must match', async () => {
  const fixture = fixtureRequest((result, origin, route) => { if (route === '/api/auth/me' && origin.includes('example')) result.body.user.role = 'admin'; });
  const report = await buildReport({ ...options, audience: 'authenticated', leftToken: 'LEFT_SECRET', rightToken: 'RIGHT_SECRET' }, contract, fixture.request);
  assert.equal(report.comparison.audience.status, 'DIFFERENT'); assert.equal(report.evaluation.exitCode, 1);
});
await check('canonical source surface contract loads without app initialization or business access', () => {
  const source = loadSourceContract();
  assert.ok(source.surfaces.length > 1); assert.equal(new Set(source.surfaces.map(surface => surface.id)).size, source.surfaces.length);
  assert.ok(source.surfaces.every(surface => surface.route.startsWith('/api/')));
  assert.equal(typeof source.displayCategory, 'function'); assert.equal(typeof source.getAgentNavigationKey, 'function');
});

console.log(JSON.stringify({ passed: true, cases: passed, networkRequests: 0, databaseQueries: 0, writes: 0, providerCalls: 0 }));
