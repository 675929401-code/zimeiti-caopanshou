#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, request, owner, otherOwner, parentId, sourceId, outputId, historyId, getExternalCalls } from './verify-cover-review-server-zero-network.mjs';

// Actual confirm/execute HTTP routes, repository, compiler, UUIDv5, sibling
// fence, DatabaseImageExactlyOnceStore.get, typed rejection and completed
// receipt checker run. Only DB/auth/catalog/attempt/render I/O ports are local.
const sha = text => createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
const children = f => f.state.rows.filter(row => row.preparation.recordKind === 'confirmation');
const execute = async (f, id, method = 'POST') => {
  const response = await f.executeRoute[method](request(method === 'POST' ? '/api/cover-workbench/execute' : `/api/cover-workbench/execute?confirmationId=${id}`,
    method, method === 'POST' ? { confirmationId: id } : undefined));
  return { response, body: await response.json() };
};
const queryOriginal = (result, id) => {
  assert.equal(result.response.status, 409); assert.equal(result.body.code, 'COVER_CONFIRMATION_QUERY_ORIGINAL');
  assert.equal(result.body.action, 'query_original'); assert.equal(result.body.originalConfirmationId, id);
};
async function confirmed(f, title = '方案 A', key = 'parent_confirm_key_a') {
  const result = await f.confirm({ primaryTitle: title }, key); assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return f.state.rows.find(row => row.id === result.body.confirmationId);
}
function attempt(f, child, state) {
  const parsed = f.load('src/lib/cover-durable-attempt.ts').parseCoverAttemptClaim({ task: child.result.task, payload: child.result.generationInput, referenceCount: 0 });
  assert.ok(parsed);
  const row = { id: randomUUID(), user_id: child.user_id, surface: 'cover-studio', client_idempotency_key: `coverwb_${child.id}`, client_trace_id: `coverwb_${child.id}`,
    state, task: clone(parsed.task), generation_input: clone(parsed.generationInput), requires_reference_reupload: false,
    created_at: '2026-11-06T00:00:00.000Z', updated_at: '2026-11-06T00:00:00.000Z', dispatched_at: '2026-11-06T00:00:00.000Z' };
  f.state.attempts.push(row); return row;
}
function rejection(f, row, overrides = {}) {
  const fingerprint = 'a'.repeat(64), input = row.generation_input;
  const record = { record_id: sha(`${row.user_id}\0${row.client_idempotency_key}`), user_hash: sha(row.user_id),
    client_idempotency_key: row.client_idempotency_key, client_trace_id: row.client_trace_id, payload_fingerprint: fingerprint,
    state: 'failed_unknown', response: { schema: 'image_request_rejection.v1', payloadFingerprint: fingerprint,
      source: 'provider', code: 'IMAGE_UPSTREAM_REQUEST_REJECTED', upstreamStatus: 400 },
    request_snapshot: { schema: 'image_generation_request_snapshot.v2', surface: 'cover-studio', payloadFingerprint: fingerprint,
      publicModelId: input.modelId, prompt: input.prompt.trim(), aspectRatio: input.aspectRatio, resolution: input.resolution,
      style: input.style.trim(), referenceUsage: input.referenceUsage }, created_at: row.created_at, updated_at: row.updated_at, ...overrides };
  f.state.images.push(record); return record;
}
function completion(f, row) {
  Object.assign(row, { background_asset_id: sourceId, result_asset_id: outputId, history_record_id: historyId });
  for (const id of [sourceId, outputId]) f.state.files.push({ id, user_id: row.user_id, storage_key: `offline/${id}.png`,
    storage_provider: 'tencent_cos', file_category: 'image', content_type: 'image/png', file_size: 1200 });
  const output = row.task.renderPlan.outputSpec;
  f.state.histories.push({ asset_id: outputId, user_id: row.user_id, background_asset_id: sourceId, history_record_id: historyId,
    plan: clone(row.task.renderPlan), output_width: output.width, output_height: output.height, source_width: 2048, source_height: 2048,
    task_no: 1, created_at: row.created_at, hidden_at: null });
  f.state.messages.push({ id: historyId, user_id: row.user_id, agent_id: 'image-workbench', role: 'assistant' });
}

{
  const f = fixture(), id = f.repository.coverConfirmationPlanId(owner, parentId, 'a'.repeat(64));
  // Independently computed by Python stdlib uuid.uuid5(NAMESPACE_URL, canonical JSON name).
  assert.equal(id, '63dc7899-90ea-5a5e-8901-317f7bd40323');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(id, f.repository.coverConfirmationPlanId(otherOwner, parentId, 'a'.repeat(64)));
  assert.notEqual(id, f.repository.coverConfirmationPlanId(owner, parentId, 'b'.repeat(64)));
  checks.push('true RFC UUIDv5 matches independent standard-library vector and binds owner parent and frozen plan');
}
{
  const f = fixture({ exactAttemptKeys: true }), parentBefore = JSON.stringify(f.parent);
  const a = await confirmed(f); f.state.unknownDispatch = true;
  const first = await execute(f, a.id); assert.equal(first.body.status, 'unknown');
  const count = f.state.writes.length, childBefore = JSON.stringify(a);
  queryOriginal(await f.confirm({ primaryTitle: '方案 A' }, 'new_key_same_unknown_plan'), a.id);
  queryOriginal(await f.confirm({ primaryTitle: '方案 B' }, 'new_key_changed_unknown_plan'), a.id);
  assert.equal(f.state.writes.filter(row => row.action === 'dispatch').length, 1);
  assert.equal(f.state.writes.length, count); assert.equal(children(f).length, 1);
  assert.equal(JSON.stringify(f.parent), parentBefore); assert.equal(JSON.stringify(a), childBefore);
  f.state.imageState = 'failed_unknown'; assert.equal((await execute(f, a.id, 'GET')).body.status, 'unknown');
  assert.equal(f.state.writes.length, count);
  checks.push('old two-dispatch reproduction now admits one; same-plan/new-plan keys cannot bypass unknown and original GET never redispatches');
}
{
  const f = fixture({ exactAttemptKeys: true }), a = await confirmed(f), b = await confirmed(f, '预建方案 B', 'prebuilt_plan_b_key');
  f.state.unknownDispatch = true; assert.equal((await execute(f, a.id)).body.status, 'unknown');
  const reads = f.state.attemptReads, writes = f.state.writes.length;
  queryOriginal(await execute(f, b.id), a.id);
  assert.equal(f.state.attemptReads, reads, 'sibling classifier must not call recovery GET');
  assert.equal(f.state.writes.length, writes); assert.equal(f.state.writes.filter(row => row.action === 'dispatch').length, 1);
  checks.push('preconfirmed B is fenced at execute after A becomes unknown without recovery GET or attempt mutation');
}
{
  const f = fixture(), parentBefore = JSON.stringify(f.parent);
  const raced = await Promise.all([f.confirm({ primaryTitle: '同一个冻结方案' }, 'concurrent_plan_key_a'), f.confirm({ primaryTitle: '同一个冻结方案' }, 'concurrent_plan_key_b')]);
  assert.deepEqual(raced.map(row => row.response.status).sort(), [200, 409]);
  const winner = raced.find(row => row.response.status === 200), loser = raced.find(row => row.response.status === 409);
  queryOriginal(loser, winner.body.confirmationId); assert.equal(children(f).length, 1); assert.equal(f.state.writes.length, 0);
  const original = children(f)[0], snapshot = JSON.stringify(original);
  const replay = await f.confirm({ primaryTitle: '同一个冻结方案' }, original.client_request_id);
  assert.equal(replay.body.confirmationId, original.id);
  assert.equal((await f.confirm({ primaryTitle: '同 key 内容冲突' }, original.client_request_id)).response.status, 409);
  assert.equal(JSON.stringify(original), snapshot); assert.equal(JSON.stringify(f.parent), parentBefore);
  checks.push('same frozen plan across two client keys converges to one child; exact-key replay and conflicting-content rejection preserve snapshots');
}
{
  const f = fixture(), seed = await confirmed(f), first = clone(seed), second = clone(seed);
  f.state.rows.splice(f.state.rows.indexOf(seed), 1); f.state.mutations.length = 0;
  second.client_request_id = 'different_client_same_pk'; second.preparation.confirmationRequestHash = 'b'.repeat(64);
  const raced = await Promise.allSettled([f.repository.insertCoverConfirmation(first), f.repository.insertCoverConfirmation(second)]);
  assert.equal(raced.filter(row => row.status === 'fulfilled').length, 1);
  const error = raced.find(row => row.status === 'rejected').reason;
  assert.equal(error.status, 409); assert.equal(error.originalConfirmationId, first.id);
  assert.equal(children(f).length, 1); assert.equal(f.state.mutations.length, 1);
  checks.push('actual repository handles PK race with owner-and-ID readback and 409 query-original instead of storage failure');
}
{
  const f = fixture({ exactAttemptKeys: true }), a = await confirmed(f), b = await confirmed(f, '独立方案 B', 'independent_plan_b_key');
  assert.notEqual(a.id, b.id); assert.equal(children(f).length, 2); assert.equal(f.state.writes.length, 0);
  const results = await Promise.all([execute(f, a.id), execute(f, b.id)]);
  assert.equal(results.every(row => row.response.status === 200), true);
  assert.equal(f.state.writes.filter(row => row.action === 'dispatch').length, 2);
  checks.push('different unsubmitted plans coexist and their simultaneous initial execute window remains explicitly independent');
}
{
  const f = fixture(), a = await confirmed(f), failed = attempt(f, a, 'failed'); rejection(f, failed);
  const b = await f.confirm({ primaryTitle: '有 typed rejection 后改方案' }, 'after_typed_failure_key');
  assert.equal(b.response.status, 200); assert.notEqual(b.body.confirmationId, a.id);
  queryOriginal(await f.confirm({ primaryTitle: '方案 A' }, 'same_failed_plan_new_key'), a.id);
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.attemptReads, 0);
  checks.push('exact DatabaseImageExactlyOnceStore record plus fingerprint-bound typed rejection allows changed plan only; unchanged plan remains original');
}
for (const state of ['claimed', 'dispatched', 'delivery_pending', 'cancelled', 'failed', 'completed']) {
  const f = fixture(), a = await confirmed(f), original = attempt(f, a, state), before = JSON.stringify(original);
  original.error_code = 'IMAGE_UPSTREAM_REQUEST_REJECTED';
  const mutatedFixture = JSON.stringify(original);
  queryOriginal(await f.confirm({ primaryTitle: `不能信任 ${state} 标签` }, `unproven_state_${state}_key`), a.id);
  assert.equal(JSON.stringify(original), mutatedFixture); assert.equal(f.state.writes.length, 0); assert.equal(f.state.attemptReads, 0);
  assert.ok(before); checks.push(`${state} without authoritative terminal evidence blocks sibling and never updates original`);
}
for (const invalid of ['fingerprint', 'trace', 'owner', 'snapshot']) {
  const f = fixture(), a = await confirmed(f), row = attempt(f, a, 'failed'), image = rejection(f, row);
  if (invalid === 'fingerprint') image.response.payloadFingerprint = 'b'.repeat(64);
  if (invalid === 'trace') image.client_trace_id = 'another_trace_identifier';
  if (invalid === 'owner') image.user_hash = sha(otherOwner);
  if (invalid === 'snapshot') image.request_snapshot.publicModelId = 'pm_other_model';
  queryOriginal(await f.confirm({ primaryTitle: '无效拒绝证明不能解锁' }, `invalid_proof_${invalid}_key`), a.id);
  assert.equal(f.state.writes.length, 0); checks.push(`typed failure ${invalid} mismatch cannot unlock another confirmation`);
}
{
  const f = fixture(), a = await confirmed(f), row = attempt(f, a, 'completed'); completion(f, row);
  assert.equal((await f.confirm({ primaryTitle: '可信保存后改方案' }, 'after_real_completion_key')).response.status, 200);
  assert.equal(f.state.attemptReads, 0); assert.equal(f.state.writes.length, 0);
  checks.push('shared production completed receipt checks owned files history media and frozen plan before allowing a different plan');
}
for (const invalid of ['media', 'foreign-file', 'plan']) {
  const f = fixture(), a = await confirmed(f), row = attempt(f, a, 'completed'); completion(f, row);
  if (invalid === 'media') f.state.messages.length = 0;
  if (invalid === 'foreign-file') f.state.files[0].user_id = otherOwner;
  if (invalid === 'plan') f.state.histories[0].plan.title = 'different persisted title';
  queryOriginal(await f.confirm({ primaryTitle: '伪 completed 不能解锁' }, `invalid_completed_${invalid}_key`), a.id);
  assert.equal(f.state.writes.length, 0); checks.push(`completed ${invalid} proof mismatch blocks sibling without save or reconciliation`);
}
{
  const f = fixture(), a = await confirmed(f), oldId = randomUUID();
  a.id = oldId; delete a.preparation.confirmationIdentityVersion;
  a.result.task.prepareOperationId = oldId; a.result.task.id = `cover-review-${oldId}`;
  const before = JSON.stringify(a);
  queryOriginal(await f.confirm({ primaryTitle: '方案 A' }, 'legacy_random_same_plan_key'), oldId);
  const replay = await f.confirm({ primaryTitle: '方案 A' }, a.client_request_id);
  assert.equal(replay.body.confirmationId, oldId); assert.equal(JSON.stringify(a), before);
  assert.equal(f.state.writes.length, 0); checks.push('historical random UUID and original coverwb child identity remain immutable and same-plan new key returns its original ID');
}
{
  const f = fixture(), a = await confirmed(f); attempt(f, a, 'dispatched');
  f.state.userId = otherOwner;
  const response = await f.confirm({ primaryTitle: '其他账号不能查原ID' }, 'foreign_account_confirm_key');
  assert.equal(response.response.status, 404); assert.equal(Object.hasOwn(response.body, 'originalConfirmationId'), false);
  const read = await execute(f, a.id, 'GET'); assert.equal(read.response.status, 404);
  assert.equal(Object.hasOwn(read.body, 'originalConfirmationId'), false); checks.push('cross-account confirm and execute cannot reveal original confirmation IDs');
}
{
  const f = fixture({ original: true }), a = await confirmed(f), b = await confirmed(f, '方案 A', 'free_same_plan_new_key');
  const c = await confirmed(f, '另一版免费排版', 'free_different_plan_key');
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.equal(children(f).every(row => row.preparation.quote.image.amount === 0), true);
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.attemptReads, 0); checks.push('original layout retains multiple free immutable confirmations including identical plans');
}
{
  const f = fixture(), a = await confirmed(f), row = attempt(f, a, 'failed'); rejection(f, row);
  f.state.attempts.length = 0;
  queryOriginal(await f.confirm({ primaryTitle: 'wrapper missing image intent仍保守' }, 'orphan_image_record_key'), a.id);
  checks.push('an orphaned exact image record without cover terminal proof stays query-original');
}
{
  const f = fixture();
  for (let index = 0; index < 501; index++) f.state.rows.push({ id: randomUUID(), user_id: owner,
    created_at: '2026-11-06T00:00:00.000Z', preparation: { recordKind: 'confirmation', originalAnalysisOperationId: parentId } });
  f.state.rows.push({ id: randomUUID(), user_id: otherOwner, preparation: { recordKind: 'confirmation', originalAnalysisOperationId: parentId } });
  const rows = await f.repository.loadCoverConfirmationsForAnalysis(owner, parentId);
  assert.equal(rows.length, 501); assert.equal(new Set(rows.map(row => row.id)).size, 501);
  assert.equal(rows.every(row => row.user_id === owner), true); assert.equal(f.state.writes.length, 0);
  checks.push('all historical siblings are paginated beyond one page without foreign-account rows or writes');
}
assert.equal(getExternalCalls(), 0);
console.log(JSON.stringify({ passed: true, checks: checks.length, cases: checks, realNetworkCalls: 0, liveDatabaseCalls: 0,
  realProviderCalls: 0, realAttemptWrites: 0, walletCalls: 0, credentialReads: 0,
  boundary: 'Real source functions and HTTP routes; database/auth/catalog/attempt/render I/O ports are fixtures. Mock dispatch count intentionally verifies admission only.',
  limitations: ['No live PostgreSQL concurrency claim', 'No global atomic lock across different plans', 'Same-parent fence does not cover separate reused-analysis parent lineages', 'Mixed old random-ID writers require release coordination'] }, null, 2));
