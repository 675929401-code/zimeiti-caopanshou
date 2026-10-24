import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';

const routePath = 'src/app/api/video/generate/route.ts';
const source = fs.readFileSync(routePath, 'utf8');
assert.doesNotMatch(source, /normalizeVideoPromptTiming|durationInstruction|时长执行约束/u, 'video route still rewrites the user prompt');
assert.match(source, /const executionPrompt = inputContract\.supportsPrompt \? trimmedPrompt : "";/u, 'video route does not preserve the trimmed user prompt');
assert.match(source, /videoBillingAdapterAdmission\(selectedProtocolConfig\)/u, 'video route must evaluate the provider billing adapter before submission');
assert.match(source, /error_code: billingAdmission\.code[\s\S]*task_submitted: false[\s\S]*price: 0/u, 'unsupported provider billing must fail closed before charging or dispatch');
assert.match(source, /status: "billing_pending"[\s\S]*submission_outcome: "not_submitted"[\s\S]*task_submitted: false/u, 'unconfirmed admission release must never look queued');
assert.match(source, /status: "failed"[\s\S]*submission_outcome: "not_submitted"[\s\S]*task_submitted: false/u, 'persisted admission rejection must be terminal in the client contract');
const tree = ts.createSourceFile(routePath, source, ts.ScriptTarget.Latest, true);
const post = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
const outerTry = post.body.statements.find(ts.isTryStatement);
const statements = [...outerTry.tryBlock.statements];
const declares = (node, name) => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(tree) === name);
const bodyIndex = statements.findIndex(node => declares(node, 'body'));
const submitIndex = statements.findIndex(node => declares(node, 'result'));
const syncIndex = statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(tree) === 'isSyncCompleted');
assert.ok(bodyIndex > 0 && submitIndex > bodyIndex && syncIndex > submitIndex);
const nextServerImport = tree.statements.find(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'next/server');
assert.ok(nextServerImport?.importClause?.namedBindings && ts.isNamedImports(nextServerImport.importClause.namedBindings));
assert.ok(nextServerImport.importClause.namedBindings.elements.some(element => element.name.text === 'after'), 'video route must use the supported response-lifecycle after() API');
const bindIndex = statements.findIndex(node => node.getText(tree).includes('await bindVideoProviderTask('));
const asyncAfterIndex = statements.findIndex((node, index) => index > syncIndex
  && ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(tree) === 'after');
const asyncReturnIndex = statements.findIndex((node, index) => index > asyncAfterIndex && ts.isReturnStatement(node));
assert.ok(bindIndex > submitIndex && bindIndex < syncIndex, 'provider task binding must remain awaited before any accepted response');
assert.ok(asyncAfterIndex > syncIndex && asyncReturnIndex === asyncAfterIndex + 1, 'async telemetry must be scheduled immediately before the accepted response');
const asyncAfterCall = statements[asyncAfterIndex].expression;
const asyncAfterCallback = asyncAfterCall.arguments[0];
assert.ok((ts.isArrowFunction(asyncAfterCallback) || ts.isFunctionExpression(asyncAfterCallback)) && asyncAfterCallback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword));
assert.ok(ts.isBlock(asyncAfterCallback.body));
const asyncTailCode = statements.slice(asyncAfterIndex, asyncReturnIndex + 1).map(node => node.getText(tree)).join('\n');
const authCode = statements.slice(0, bodyIndex).map(node => node.getText(tree)).join('\n');
const submitCode = statements.slice(submitIndex, syncIndex).map(node => node.getText(tree)).join('\n');
const outerDeclarations = post.body.statements.slice(0, post.body.statements.indexOf(outerTry)).map(node => node.getText(tree)).join('\n');
const catchCode = outerTry.catchClause.getText(tree);
const adminSource = fs.readFileSync('src/lib/admin-auth.ts', 'utf8');
const adminTree = ts.createSourceFile('admin-auth.ts', adminSource, ts.ScriptTarget.Latest, true);
const adminFunction = adminTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createAdminTokenAuthorizer');
assert.ok(adminFunction);
const state = {};
class FixtureProviderAdmissionBusyError extends Error {
  constructor() { super('Fixture admission busy'); this.code = 'PROVIDER_ADMISSION_BUSY'; this.status = 429; this.retryAfterSeconds = 3; }
}
class FixtureProviderAdmissionUnavailableError extends Error {
  constructor() { super('Fixture admission unavailable'); this.code = 'PROVIDER_ADMISSION_CONTROL_UNAVAILABLE'; this.status = 503; }
}
const report = { at: new Date().toISOString(), routeSha256: createHash('sha256').update(source).digest('hex'), actualAstBranches: true, realNetworkRequests: 0, databaseWrites: 0, cases: [] };
function reset() {
  Object.assign(state, { user: { id: 'fixture-owner', role: 'admin', is_active: true, status: 'active', session_id: 'fixture-session' }, staleJwtRole: 'admin', authDbError: false, signatureValid: true,
    row: { id: 'vt_fixture', user_id: 'fixture-owner', request_fingerprint: 'fixture-fingerprint', status: 'pending', task_id_external: null },
    updateMode: 'ok', bindError: false, providerError: false, providerResult: { taskId: '', status: 'processing', submissionOutcome: 'unknown' },
    providerCalls: 0, bindCalls: 0, submissionFailureCalls: 0, admissionMode: 'available', admissionReleases: 0, healthCalls: [], updates: [], order: [], traces: [], dispatchReceipts: [], submissionReceipts: [],
  });
}
const db = { from(table) {
  assert.equal(table, 'video_tasks');
  let update;
  const filters = [];
  const chain = {
    update(value) { update = value; return chain; },
    eq(key, value) { filters.push(row => row[key] === value); return chain; },
    is(key, value) { filters.push(row => row[key] === value); return chain; },
    in(key, values) { filters.push(row => values.includes(row[key])); return chain; },
    select() { return chain; },
    async maybeSingle() {
      state.order.push('update'); state.updates.push(update);
      if (state.updateMode === 'throw') throw new Error('FIXTURE_DATABASE_TRANSPORT');
      if (state.updateMode === 'error') return { data: null, error: { code: 'FIXTURE_DATABASE_ERROR' } };
      if (state.updateMode === 'missing' || !filters.every(check => check(state.row))) return { data: null, error: null };
      Object.assign(state.row, update); return { data: { id: state.row.id }, error: null };
    },
  };
  return chain;
} };
const payload = () => state.signatureValid ? { userId: 'fixture-owner', role: state.staleJwtRole, sessionId: 'fixture-session' } : null;
const policyModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/video-error-policy.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: policyModule, exports: policyModule.exports, URL });
const sanitizeVideoProviderDiagnostic = policyModule.exports.sanitizeVideoProviderDiagnostic;
assert.equal(typeof sanitizeVideoProviderDiagnostic, 'function');
assert.equal(sanitizeVideoProviderDiagnostic('Actionable fixture failure https://fixture.invalid/result?token=private'),
  'Actionable fixture failure https://fixture.invalid/result');
const common = {
  sanitizeVideoProviderDiagnostic,
  Request, Response, Headers, URL, Date, Error, Buffer, crypto: { randomUUID }, process: { env: { NODE_ENV: 'production' } }, console: { log() {}, warn() {}, error() {} },
  NextResponse: { json: (body, init) => Response.json(body, init) },
  getTokenFromHeaders: headers => headers.get('Authorization')?.slice(7) || null,
  verifyToken: async () => payload(),
  db,
  writeVideoTrace: async value => { state.traces.push(value); },
  ProviderAdmissionBusyError: FixtureProviderAdmissionBusyError,
  ProviderAdmissionUnavailableError: FixtureProviderAdmissionUnavailableError,
  acquireProviderAdmission: async () => {
    if (state.admissionMode === 'busy') throw new FixtureProviderAdmissionBusyError();
    if (state.admissionMode === 'unavailable') throw new FixtureProviderAdmissionUnavailableError();
    return { leaseId: 'fixture-admission', expiresAt: Date.now() + 60_000, release: async () => { state.admissionReleases++; } };
  },
  publicModelDisplayName: () => 'Fixture model',
  classifyVideoProviderError: () => ({ code: 'FIXTURE_PROVIDER_ERROR', category: 'provider', publicMessage: 'Fixture rejected', operatorMessage: 'Fixture rejected', retryable: true }),
  videoTerminalErrorResponse: () => null,
  bindVideoProviderTask: async value => {
    state.bindCalls++; state.order.push('bind');
    assert.equal(value.taskIdInternal, state.row.id); assert.equal(value.userId, state.row.user_id); assert.equal(value.requestFingerprint, state.row.request_fingerprint);
    if (state.bindError) throw new Error('FIXTURE_BIND_FAILED');
    if (state.row.task_id_external && state.row.task_id_external !== value.providerTaskId) throw new Error('FIXTURE_BIND_CONFLICT');
    state.row.task_id_external = value.providerTaskId;
  },
  markVideoSubmissionFailed: async () => { state.submissionFailureCalls++; state.order.push('submission-rpc'); if (!state.row.task_id_external) state.row.status = 'failed'; return true; },
  recordVideoTerminalOutcome: async value => { state.healthCalls.push(value); state.order.push('health'); },
  persistVideoProviderDispatchReceipt: async value => {
    assert.equal(value.taskIdInternal, state.row.id); assert.equal(value.userId, state.row.user_id); assert.equal(value.requestFingerprint, state.row.request_fingerprint);
    assert.equal(value.snapshot.providerModelId, 'fixture-model'); state.dispatchReceipts.push(value);
  },
  persistVideoProviderSubmissionReceipt: async value => {
    if (state.updateMode !== 'ok') throw new Error('FIXTURE_SUBMISSION_RECEIPT_' + state.updateMode.toUpperCase());
    assert.equal(value.taskIdInternal, state.row.id); assert.equal(value.userId, state.row.user_id); assert.equal(value.requestFingerprint, state.row.request_fingerprint);
    state.submissionReceipts.push(value);
  },
  submitVideoTask: async (_config, params) => {
    state.providerCalls++; assert.equal(params.inputOwnerId, state.user.id, 'Material owner comes from authenticated server state');
    if (state.providerError) throw new TypeError('FIXTURE_CONNECTION_RESET');
    await params.onProviderRequest?.({ schemaVersion: 1, method: 'POST', endpointHost: 'fixture.invalid', idempotencyKey: params.idempotencyKey });
    return state.providerResult;
  },
  taskIdInternal: 'vt_fixture', userId: 'fixture-owner', requestFingerprint: 'fixture-fingerprint', model_id: 'pm_fixture', selectedModel: { id: 'fixture-model', name: 'Fixture', model_name: 'fixture', protocol_type: 'fixture', api_endpoint: 'https://fixture.invalid' },
  routingSnapshot: { schemaVersion: 1, providerModelId: 'fixture-model', publicModelId: 'pm_fixture', protocolType: 'fixture', endpoint: 'https://fixture.invalid', credentialRef: 'fixture-credential' },
  traceId: 'fixture-trace', traceModelId: 'fixture-model', traceTaskLabel: 'fixture-task', tracePromptHash: 'fixture-prompt',
  normalizedClientRequestId: 'fixture-original-key', channelConfig: {}, executionPrompt: 'Fixture', effectiveImageUrl: undefined, effectiveLastFrameUrl: undefined, effectiveReferenceImageUrl: undefined,
  effectiveAudioUrl: undefined, effectiveReferenceImageUrls: [], effectiveReferenceAudioUrls: [], source_video_url: undefined, effectiveSourceVideoUrl: undefined, body: { inputOwnerId: 'untrusted-body-owner' }, negative_prompt: undefined,
  adapterParams: { prompt: 'Fixture', idempotencyKey: 'fixture-provider-original' },
  videoTiming: { submit: 5 }, aspect_ratio: '16:9', selectedResolution: '720p', taskIdentity: { taskIdInternal: 'vt_fixture', providerIdempotencyKey: 'fixture-provider-original' }, submitMs: 0,
};
function compile(code, additions = {}) {
  const loadedModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { ...common, ...additions, module: loadedModule, exports: loadedModule.exports }, { filename: 'actual-video-route-branches.ts' });
  return loadedModule.exports;
}
const authorizer = compile(adminFunction.getText(adminTree)).createAdminTokenAuthorizer({
  verifySignature: async () => payload(),
  findCurrentUser: async () => { if (state.authDbError) throw new Error('FIXTURE_AUTH_DB_ERROR'); return state.user; },
});
const auth = compile(`export async function run(req: Request) { ${authCode}\nreturn { effectiveRole: userRole }; }`, { authorizeAdminToken: authorizer }).run;
const submit = compile(`export async function run() { ${outerDeclarations}\ntry { ${submitCode}\nreturn { completedSection: true }; } ${catchCode} }`).run;
const input = () => new Request('http://127.0.0.1:5000/api/video/generate', { headers: { Authorization: 'Bearer fixture-signature-input' } });
async function test(name, run) {
  reset();
  try { await run(); report.cases.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { report.cases.push({ name, passed: false, errorType: error.name, message: String(error.message).slice(0, 300) }); console.log('FAIL ' + name + ': ' + String(error.message).slice(0, 300)); }
}
await test('current database demotion overrides old administrator JWT', async () => { state.user.role = 'student'; assert.equal((await auth(input())).effectiveRole, 'student'); assert.equal(state.providerCalls, 0); });
await test('current database administrator overrides old student JWT', async () => { state.staleJwtRole = 'student'; assert.equal((await auth(input())).effectiveRole, 'admin'); });
for (const [name, patch, expected] of [
  ['disabled account', { user: { id: 'fixture-owner', role: 'admin', is_active: false, status: 'active' } }, 403],
  ['inactive status', { user: { id: 'fixture-owner', role: 'admin', is_active: true, status: 'disabled' } }, 403],
  ['missing account', { user: null }, 401],
  ['database unavailable', { authDbError: true }, 503],
  ['invalid signature', { signatureValid: false }, 401],
]) await test('authorization rejects ' + name + ' before submit', async () => { Object.assign(state, patch); const result = await auth(input()); assert.equal(result.status, expected); assert.equal(state.providerCalls, 0); });
for (const [mode, expected] of [['ok', 202], ['error', 503], ['missing', 503], ['throw', 503]]) {
  await test('unknown acknowledgement + database ' + mode + ' preserves original task identity', async () => {
    state.updateMode = mode; const response = await submit(); const body = await response.json();
    assert.equal(response.status, expected); assert.equal(body.task_id, 'vt_fixture'); assert.equal(body.business_task_id, 'vt_fixture');
    assert.equal(body.submission_outcome, 'unknown'); assert.equal(body.task_submitted, null); assert.equal(body.retryable, false);
    assert.equal(state.providerCalls, 1); assert.equal(state.dispatchReceipts.length, 1); assert.equal(state.healthCalls.length, 0); assert.equal(state.submissionFailureCalls, 0);
    if (mode === 'ok') assert.equal(state.submissionReceipts.length, 1);
  });
}
await test('adapter exception before provider dispatch fails locally without poisoning channel health', async () => {
  state.providerError = true; const response = await submit(); const body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.status, 'failed'); assert.equal(body.business_task_id, 'vt_fixture');
  assert.equal(state.submissionFailureCalls, 1); assert.equal(state.healthCalls.length, 0);
});
for (const [mode, expectedStatus, expectedCode] of [
  ['busy', 429, 'PROVIDER_ADMISSION_BUSY'],
  ['unavailable', 503, 'PROVIDER_ADMISSION_CONTROL_UNAVAILABLE'],
]) await test('provider admission ' + mode + ' fails before provider and releases reservation', async () => {
  state.admissionMode = mode; const response = await submit(); const body = await response.json();
  assert.equal(response.status, expectedStatus); assert.equal(body.error_code, expectedCode); assert.equal(body.task_submitted, false);
  assert.equal(state.providerCalls, 0); assert.equal(state.submissionFailureCalls, 1); assert.equal(state.admissionReleases, 0);
  if (mode === 'busy') assert.equal(response.headers.get('retry-after'), '3');
});
await test('failed task with provider ID binds before terminal CAS and counts health once', async () => {
  state.providerResult = { taskId: 'provider-original', status: 'failed', error: 'Fixture failure' };
  const response = await submit(); const body = await response.json();
  assert.equal(body.task_id, 'provider-original'); assert.equal(body.business_task_id, 'vt_fixture'); assert.equal(body.status, 'failed');
  assert.equal(state.dispatchReceipts.length, 1); assert.equal(state.submissionReceipts.length, 1);
  assert.equal(state.row.task_id_external, 'provider-original'); assert.equal(state.row.status, 'failed'); assert.equal(state.row.price_charged, 0);
  assert.equal(state.submissionFailureCalls, 0); assert.equal(state.healthCalls.length, 1); assert.equal(state.healthCalls[0].countSubmission, true);
  assert.deepEqual(state.order, ['bind', 'update', 'health']);
});
await test('terminal CAS cannot count a duplicate failed outcome twice', async () => {
  state.providerResult = { taskId: 'provider-original', status: 'failed', error: 'Fixture failure' };
  await submit(); const response = await submit(); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.task_id, 'provider-original'); assert.equal(state.healthCalls.length, 1); assert.equal(state.submissionFailureCalls, 0);
});
for (const mode of ['error', 'missing', 'throw']) await test('failed accepted task database ' + mode + ' keeps provider ID and skips health', async () => {
  state.providerResult = { taskId: 'provider-original', status: 'failed', error: 'Fixture failure' }; state.updateMode = mode;
  const response = await submit(); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.task_id, 'provider-original'); assert.equal(body.business_task_id, 'vt_fixture'); assert.equal(body.retryable, false);
  assert.equal(state.healthCalls.length, 0); assert.equal(state.submissionFailureCalls, 0);
});
for (const status of ['failed', 'queued']) await test('bind failure for accepted ' + status + ' receipt keeps exact ID in outer catch', async () => {
  state.providerResult = { taskId: 'provider-original', status, error: 'Fixture failure' }; state.bindError = true;
  const response = await submit(); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.task_id, 'provider-original'); assert.equal(body.business_task_id, 'vt_fixture'); assert.equal(body.task_submitted, true); assert.equal(body.retryable, false);
  assert.equal(state.healthCalls.length, 0); assert.equal(state.submissionFailureCalls, 0);
});
await test('explicit rejection without provider ID retains submission failure path', async () => {
  state.providerResult = { taskId: '', status: 'failed', error: 'Fixture rejection' }; const response = await submit();
  assert.equal(response.status, 502); assert.equal(state.bindCalls, 0); assert.equal(state.submissionFailureCalls, 1); assert.equal(state.healthCalls.length, 1);
});
await test('accepted async response does not await accounting or trace telemetry failures', async () => {
  const deferred = [];
  const warnings = [];
  const telemetryCalls = [];
  const responseRunner = compile(`export async function run() { ${asyncTailCode} }`, {
    after: callback => { deferred.push(callback); },
    channelConfig: { id: 'fixture-channel', name: 'Fixture channel' },
    traceId: 'fixture-trace', traceTaskLabel: 'fixture-task', tracePromptHash: 'fixture-prompt', providerTaskId: 'provider-original', totalMs: 321,
    result: { contentUrl: 'https://fixture.invalid/content' }, model_id: 'pm_fixture', selectedModel: { name: 'Fixture model' }, price: 1.25,
    videoTiming: { target: 5, submit: 5 }, normalizedTiming: { timelineNormalized: false },
    recordVideoSubmission: async modelId => { telemetryCalls.push(['accounting', modelId]); throw new Error('FIXTURE_ACCOUNTING_FAILED'); },
    writeVideoTrace: async event => { telemetryCalls.push(['trace', event.phase]); throw new Error('FIXTURE_TRACE_FAILED'); },
    console: { log() {}, error() {}, warn: (...args) => warnings.push(args.map(String).join(' ')) },
  }).run;
  const response = await responseRunner();
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.task_id, 'provider-original');
  assert.deepEqual(telemetryCalls, []); assert.equal(deferred.length, 1, 'telemetry must wait until after the response lifecycle');
  await deferred[0]();
  assert.deepEqual(telemetryCalls, [['accounting', 'fixture-channel'], ['trace', 'submitted']]);
  assert.equal(warnings.length, 2); assert.match(warnings[0], /Accounting/); assert.match(warnings[1], /Trace/);
});
report.passed = report.cases.every(item => item.passed);
report.passedCount = report.cases.filter(item => item.passed).length;
report.failedCount = report.cases.length - report.passedCount;
const output = process.argv[2];
if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
console.log(JSON.stringify({ passed: report.passed, passedCount: report.passedCount, failedCount: report.failedCount, realNetworkRequests: 0, databaseWrites: 0 }));
if (!report.passed) process.exitCode = 1;
