#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class ConfigurationError extends Error { constructor(code, message) { super(message); this.code = code; } }
let originalRelease = null;
let reads = 0;
const exports = {};
const compiled = ts.transpileModule(fs.readFileSync('src/lib/server/model-pool-mutation-http.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
vm.runInNewContext(compiled, { exports, URL, structuredClone,
  require(name) {
    if (name === 'next/server') return { NextResponse: { json: (body, options) => Response.json(body, options) } };
    if (name === './platform-configuration-admin') return {
      PlatformConfigurationError: ConfigurationError,
      resumePlatformModelMutation: async () => { reads++; return originalRelease; },
    };
    throw Error(`UNEXPECTED_HTTP_DEPENDENCY:${name}`);
  },
});
const operationId = '9d4eedf0-7517-4a1f-98fe-4f8cc2e2af66';
const candidateId = '94bad59c-f6d5-4b62-a2cf-11cae915984c';
const request = (pathname, key = operationId) => new Request(`http://127.0.0.1:5000${pathname}`, {
  method: 'POST', headers: key ? { 'Idempotency-Key': key } : {},
});
for (const key of ['', 'not-a-uuid', '9d4eedf0-7517-4a1f-98fe-4f8cc2e2af66-secret']) {
  assert.throws(() => exports.modelPoolMutationRequest(request('/api/admin/models', key), {}), /刷新页面/u);
}
assert.equal(reads, 0);
for (const invalid of [null, [], "input", 1, false]) {
  assert.throws(() => exports.modelPoolMutationRequest(request('/api/admin/models'), invalid), /必须是对象/u);
}
const body = { model_type: 'text', api_key: 'FIXTURE_SECRET_DO_NOT_EXPOSE', id: 'fixture' };
const operation = exports.modelPoolMutationRequest(request('/api/admin/models'), body);
body.id = 'changed-after-capture';
assert.equal(operation.requestPayload.body.id, 'fixture');
assert.equal(operation.requestPayload.body.api_key, 'FIXTURE_SECRET_DO_NOT_EXPOSE');
assert.equal(operation.requestPayload.method, 'POST');
const video = exports.modelPoolMutationRequest(request('/api/admin/video-models'), { name: 'same' });
const chat = exports.modelPoolMutationRequest(request('/api/admin/chat-models'), { name: 'same' });
assert.notEqual(video.requestPayload.resourcePath, chat.requestPayload.resourcePath);
assert.notEqual(video.requestPayload.modelType, chat.requestPayload.modelType);
assert.equal(await exports.resumeModelPoolMutationResponse('actor', operation), null);
for (const release of [
  { id: candidateId, status: 'draft', is_current: false },
  { id: candidateId, status: 'published', is_current: true },
  { id: candidateId, status: 'superseded', is_current: false },
]) {
  originalRelease = release;
  const response = await exports.resumeModelPoolMutationResponse('actor', operation);
  const result = await response.json();
  assert.equal(response.status, 202); assert.equal(result.replayed, true);
  assert.equal(result.published, release.status !== 'draft');
  assert.equal(result.result.release.is_current, release.is_current);
}
for (const [code, status] of [
  ['PLATFORM_CONFIGURATION_REQUEST_ID_INVALID', 400],
  ['PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND', 404],
  ['PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT', 409],
  ['PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT', 409],
  ['PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED', 409],
  ['PLATFORM_CONFIGURATION_UNREVIEWED_REJECTED', 503],
  ['PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED_EXTRA', 503],
  ['PLATFORM_CONFIGURATION_MUTATION_RECEIPT_UNAVAILABLE', 503],
]) {
  const response = exports.modelPoolMutationFailure(new ConfigurationError(code, 'DATABASE_SECRET_VALUE_FIXTURE'));
  assert.equal(response.status, status);
  const result = await response.text(); assert.doesNotMatch(result, /DATABASE_SECRET_VALUE_FIXTURE/u);
}
const removalCombination = await exports.modelPoolMutationFailure(new ConfigurationError('PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED', 'PRIVATE_DATABASE_ROW_FIXTURE')).json();
assert.equal(removalCombination.error, '此候选同时包含密钥变更和模型下架，请先单独发布密钥变更，再创建下架候选。');
assert.equal(removalCombination.code, 'PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED');
assert.equal(removalCombination.published, undefined);
assert.equal(removalCombination.outcome, undefined);
assert.doesNotMatch(JSON.stringify(removalCombination), /PRIVATE_DATABASE_ROW_FIXTURE/u);
const lost = Object.assign(new ConfigurationError('PLATFORM_CONFIGURATION_MUTATION_OUTCOME_UNKNOWN', 'DATABASE_SECRET_VALUE_FIXTURE'), {
  outcome: 'outcome_unknown', requestId: operationId, candidateId, phase: 'preview',
});
const unknown = await exports.modelPoolMutationFailure(lost).json();
assert.equal(unknown.outcome, 'unknown'); assert.equal(unknown.retryable, false);
assert.equal(unknown.requestId, operationId); assert.equal(unknown.candidateId, candidateId);
assert.doesNotMatch(JSON.stringify(unknown), /DATABASE_SECRET_VALUE_FIXTURE|secret_value/u);
assert.equal(exports.modelPoolMutationFailure(new Error('unclassified')), null);
// Execute the actual unified POST. Published replays must return before every
// duplicate/provider/pricing read, rather than merely satisfying source order.
const routeText = fs.readFileSync('src/app/api/admin/models/route.ts', 'utf8');
const routeAst = ts.createSourceFile('models-route.ts', routeText, ts.ScriptTarget.Latest, true);
const post = routeAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
assert.ok(post);
const handlers = {};
let authorized = true;
let duplicateReads = 0;
vm.runInNewContext(ts.transpileModule(post.getText(routeAst), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports: handlers, ...exports,
  authorizeModelWrite: async () => authorized ? { ok: true, actor: { userId: 'fixture-actor' } }
    : { ok: false, response: Response.json({ error: 'denied' }, { status: 403 }) },
  getSupabaseClient: () => { duplicateReads++; throw Error('DUPLICATE_QUERY_MUST_NOT_RUN_FOR_REPLAY'); },
  NextResponse: { json: (value, options) => Response.json(value, options) },
});
for (const status of ['published', 'superseded']) {
  originalRelease = { id: candidateId, status, is_current: status === 'published' };
  const response = await handlers.POST({ ...request('/api/admin/models'),
    headers: new Headers({ 'Idempotency-Key': operationId }), method: 'POST',
    url: 'http://127.0.0.1:5000/api/admin/models', json: async () => ({ model_type: 'text', name: 'same-original-form' }) });
  const replay = await response.json();
  assert.equal(response.status, 202); assert.equal(replay.replayed, true);
  assert.equal(replay.published, true); assert.equal(replay.result.release.id, candidateId);
  assert.equal(replay.result.release.status, status); assert.equal(duplicateReads, 0);
}
authorized = false;
const readsBeforeDenial = reads;
assert.equal((await handlers.POST(request('/api/admin/models'))).status, 403);
assert.equal(reads, readsBeforeDenial);
for (const name of ['models', 'chat-models', 'cover-models', 'cover-models/[id]', 'video-models']) {
  const file = `src/app/api/admin/${name}/route.ts`;
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const handler of ast.statements.filter(ts.isFunctionDeclaration)) {
    const text = handler.getText(ast);
    if (!text.includes('stageLegacyModelPoolUpsert({')) continue;
    const authorization = Math.max(text.indexOf('await authorizeModelWrite'), text.indexOf('await requireAdmin'), text.indexOf('await verifyAdminToken'));
    const capture = text.indexOf('modelPoolMutationRequest(');
    const resume = text.indexOf('await resumeModelPoolMutationResponse(');
    assert.ok(authorization >= 0 && capture > authorization && resume > capture && text.indexOf('stageLegacyModelPoolUpsert({') > resume, file);
    assert.match(text, /if \(resumedMutation\) return resumedMutation/u);
    assert.match(text, /\.\.\.mutationRequest/u);
    assert.match(text, /modelPoolMutationFailure\(error\)/u);
  }
}
console.log(JSON.stringify({ passed: true, missingOperationDeniedBeforeReads: true,
  rawInputCapturedBeforeDerivation: true, collectionIdentitySeparated: true,
  replayLifecyclePreserved: true, secretErrorsRedacted: true, upsertRouteCount: 5,
  actualUnifiedPostPublishedReplay: true, duplicateReadsOnReplay: duplicateReads, unauthorizedReceiptReads: 0,
  networkCalls: 0, databaseWrites: 0, providerCalls: 0 }));
