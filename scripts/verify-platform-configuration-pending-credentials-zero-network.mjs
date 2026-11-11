import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

// Actual source functions execute against a stateful fake RPC contract. This
// proves application behavior; PostgreSQL transaction/ACL/concurrency validation
// is independently required before migration apply or production closure.
const require = createRequire(import.meta.url), modules = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify((function sort(input) { return Array.isArray(input) ? input.map(sort) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])])) : input; })(value));
const actor = '10000000-0000-4000-8000-000000000001';
const secretA = 'fixture-secret-alpha-never-network', secretB = 'fixture-secret-beta-never-network';
let state = { releases: [], active: {}, pending: [], receipts: [], physical: { cover_models: [], video_models: [], llm_models: [], chat_models: [] } };
let writes = 0, raceInsert = false, failure = '', readbackFailure = false, previewFailure = false, unknownRpc = false;
const logs = [], cases = [];
// Imported provider-secret constructs its resolver at module initialization.
// Keep the real module, but never inject the host process/env into this VM.
const fixtureProcess = Object.freeze({ env: Object.freeze({}), platform: 'linux' });
const error = code => Object.assign(new Error(code), { code: 'P0001' });
const db = {
  from(table) {
    const filters = []; let update = null, single = false, head = false;
    const query = { select(_fields, options) { head = options?.head === true; return query; }, eq(k, v) { filters.push(row => row[k] === v); return query; }, in(k, values) { filters.push(row => values.includes(row[k])); return query; }, limit() { return query; }, order() { return query; },
      update(value) { update = value; return query; }, maybeSingle() { single = true; return query; },
      upsert() { throw Error('DIRECT_ACTIVE_CREDENTIAL_WRITE_FORBIDDEN'); },
      then(resolve, reject) { try {
        if (readbackFailure && table === 'model_pool_config_releases' && state.receipts.length) throw Error('fixture readback unavailable');
        let rows = table === 'model_pool_config_releases' ? state.releases : table === 'workspace_model_config_releases' ? [] : table === 'platform_model_credential_bindings' ? Object.values(state.active) : state.physical[table] || [];
        rows = rows.filter(row => filters.every(filter => filter(row)));
        if (update) { for (const row of rows) Object.assign(row, update); writes++; }
        return Promise.resolve({ data: head ? null : single ? rows[0] || null : rows, error: null, count: rows.length }).then(resolve, reject);
      } catch (e) { return Promise.resolve({ data: null, error: { message: e.message } }).then(resolve, reject); } }
    }; return query;
  },
  async rpc(name, p) {
    if (name === 'platform_configuration_order_map') return { data: {}, error: null };
    if (name === 'read_platform_model_mutation_receipt') {
      const receipt = state.receipts.find(row => row.actor === p.p_actor_id && row.requestId === p.p_request_id);
      if (!receipt) return { data: null, error: null };
      if (p.p_request_payload && receipt.logical !== canonical(p.p_request_payload)) return { data: null, error: { code: 'P0001', message: 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT' } };
      return { data: { candidateId: receipt.id, state: receipt.state, hasStagedCredentials: state.pending.some(row => row.releaseId === receipt.id && row.state === 'pending') }, error: null };
    }
    if (name === 'read_platform_model_pending_credential_metadata') {
      if (previewFailure && state.receipts.length) return { data: null, error: { message: 'fixture metadata failure' } };
      return { data: state.pending.filter(row => row.releaseId === p.p_release_id).map(({ modelKey, credentialRef, pendingRevision, expectedExists, expectedRevision, state: status }) => ({ modelKey, credentialRef, pendingRevision, expectedExists, expectedRevision, state: status })), error: null };
    }
    if (name === 'create_platform_configuration_candidate_atomic') {
      const release = { id: randomUUID(), release_version: state.releases.length + 1, snapshot: clone(p.p_snapshot), snapshot_sha256: p.p_snapshot_sha256, validation_result: clone(p.p_validation_result), status: p.p_status, is_current: false, created_by: p.p_actor_id, rollback_target_id: p.p_rollback_target_id };
      state.releases.push(release); writes++; return { data: clone(release), error: null };
    }
    if (name === 'stage_model_pool_candidate_with_credentials_atomic') {
      const before = clone(state), writesBefore = writes;
      try {
        const existing = state.receipts.find(row => row.actor === p.p_actor_id && row.requestId === p.p_request_id);
        if (existing) { if (existing.logical !== canonical(p.p_request_payload)) throw error('PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT'); return { data: clone(state.releases.find(row => row.id === existing.id)), error: null }; }
        const ids = new Set();
        for (const change of p.p_credential_changes) {
          const [table, id] = change.model_key.split(':');
          if (ids.has(change.model_key) || change.credential_ref !== `secret://platform-model/${table}/${id}` || !p.p_snapshot.models.some(row => row.configuration.legacyTable === table && row.configuration.legacyId === id && row.credentialRef === change.credential_ref)) throw error('PLATFORM_CONFIGURATION_CREDENTIAL_MODEL_MISMATCH');
          ids.add(change.model_key);
        }
        const release = { id: randomUUID(), release_version: state.releases.length + 1, snapshot: clone(p.p_snapshot), snapshot_sha256: p.p_snapshot_sha256, validation_result: clone(p.p_validation_result), status: p.p_status, is_current: false, created_by: p.p_actor_id, parent_release_id: p.p_parent_release_id };
        state.releases.push(release); writes++;
        if (failure === 'candidate') throw error('fixture stage failure');
        for (const change of p.p_credential_changes) {
          const active = state.active[change.model_key];
          state.pending.push({ releaseId: release.id, modelKey: change.model_key, credentialRef: change.credential_ref, secret: change.secret_value, pendingRevision: randomUUID(), expectedExists: Boolean(active), expectedRevision: active?.revision || null, state: 'pending' }); writes++;
        }
        if (failure === 'pending') throw error('fixture stage failure');
        state.receipts.push({ actor: p.p_actor_id, requestId: p.p_request_id, logical: canonical(p.p_request_payload), id: release.id, state: 'staged' }); writes++;
        if (failure === 'receipt') throw error('fixture stage failure');
        if (unknownRpc === 'throw') return Promise.reject(new Error('fixture connection rejected after commit'));
        if (unknownRpc) return { data: null, error: { ...(typeof unknownRpc === 'string' ? { code: unknownRpc } : {}), message: 'connection lost after commit' } };
        return { data: clone(release), error: null };
      } catch (e) { state = before; writes = writesBefore; return { data: null, error: { code: e.code || 'P0001', message: e.message } }; }
    }
    if (name === 'publish_platform_configuration_release_atomic') {
      const before = clone(state), writesBefore = writes;
      try {
        const candidate = state.releases.find(row => row.id === p.p_release_id), current = state.releases.find(row => row.is_current);
        if (candidate.snapshot_sha256 !== p.p_expected_candidate_sha256) throw error('PLATFORM_CONFIGURATION_CANDIDATE_CHANGED');
        if (candidate.is_current && candidate.status === 'published') return { data: clone(candidate), error: null };
        if (candidate.status !== 'validated' && candidate.status !== 'superseded') throw error('PLATFORM_CONFIGURATION_RELEASE_NOT_VALIDATED');
        if (candidate.status === 'superseded') throw error('PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT');
        if ((current?.id || null) !== p.p_expected_current_id || (current?.snapshot_sha256 || null) !== p.p_expected_current_sha256) throw error('PLATFORM_CONFIGURATION_CURRENT_CHANGED');
        const pending = state.pending.filter(row => row.releaseId === candidate.id);
        if (pending.length && (candidate.parent_release_id || null) !== (current?.id || null)) throw error('PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED');
        for (const row of pending) { const active = state.active[row.modelKey]; if (Boolean(active) !== row.expectedExists || (active && active.revision !== row.expectedRevision)) throw error('PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'); }
        if (raceInsert && pending.length) { const key = pending[0].modelKey; const owner = { modelKey: key, ref: pending[0].credentialRef, secret: 'fixture-owner-race-insert', revision: randomUUID() }; state.active[key] = owner; before.active[key] = clone(owner); }
        for (const row of pending) { const active = state.active[row.modelKey]; if (Boolean(active) !== row.expectedExists || (active && active.revision !== row.expectedRevision)) throw error('PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'); state.active[row.modelKey] = { modelKey: row.modelKey, ref: row.credentialRef, secret: row.secret, revision: randomUUID() }; writes++; }
        if (failure === 'projector') throw error('fixture projector failure');
        for (const row of pending) { const split = row.modelKey.indexOf(':'); const table = row.modelKey.slice(0, split), id = row.modelKey.slice(split + 1); const physical = state.physical[table].find(model => model.id === id); if (physical) physical.api_key = row.secret; else { const model = candidate.snapshot.models.find(model => model.configuration.legacyTable === table && model.configuration.legacyId === id); state.physical[table].push({ ...values, id, name: model.name, model: model.modelName, model_name: model.modelName, api_endpoint: model.endpoint, api_key: row.secret }); } }
        if (current) { current.is_current = false; current.status = 'superseded'; }
        candidate.is_current = true; candidate.status = 'published'; writes++;
        if (failure === 'pointer') throw error('fixture pointer failure');
        for (const row of pending) { row.state = 'applied'; row.secret = null; }
        for (const receipt of state.receipts.filter(row => row.id === candidate.id)) receipt.state = 'applied';
        return { data: clone(candidate), error: null };
      } catch (e) { state = before; writes = writesBefore; return { data: null, error: { code: e.code || 'P0001', message: e.message } }; }
    }
    throw Error(`UNMOCKED_RPC:${name}`);
  }
};
function load(relative) {
  const absolute = path.resolve(relative);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} }; modules.set(absolute, module);
  const localRequire = name => {
    if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => db };
    if (name === 'server-only') return {};
    if (name === 'node:os') return { homedir: () => '/fixture-home' };
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('.')) {
      const source = path.resolve(path.dirname(absolute), name);
      return load(path.extname(source) ? source : `${source}.ts`);
    }
    return require(name);
  };
  // Match tsconfig's interop for newly imported node:os/node:path defaults.
  const js = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: localRequire, console: { log: (...items) => logs.push(items.join(' ')), error: (...items) => logs.push(items.join(' ')) }, process: fixtureProcess, URL, Date, Object, JSON, Set, Map }, { filename: relative });
  return module.exports;
}
const contract = load('src/lib/platform-configuration-contract.ts');
const admin = load('src/lib/server/platform-configuration-admin.ts'), compatibility = load('src/lib/server/platform-configuration-compatibility.ts');
const helper = load('src/lib/server/platform-configuration-pending-credentials.ts');
const values = { name: 'fixture voice-free model', model: 'fixture-model', model_name: 'fixture-model', provider: 'fixture', protocol: 'openai_chat', api_endpoint: 'https://fixture.invalid/v1', api_key: secretA, api_protocol_config: { provider: 'fixture', protocol: 'openai_chat' }, is_active: false, cost_per_use: 1 };
const request = (key = randomUUID(), overrides = {}) => ({ actorId: actor, requestId: key, requestPayload: { method: 'POST', modelType: 'text', body: { ...values, ...overrides } }, table: 'llm_models', values: { ...values, ...overrides }, changeNote: 'fixture candidate' });
const fail = async (fn, code) => { await assert.rejects(fn, e => e.code === code); };
const reset = () => { state = { releases: [], active: {}, pending: [], receipts: [], physical: { cover_models: [{ ...values, id: 'fixture-image', model: 'image-fixture', api_key: '', api_protocol_config: { protocol: 'images_generations' } }], video_models: [{ ...values, id: 'fixture-video', model: 'video-fixture', api_key: '', api_protocol_config: { protocol: 'video' } }], llm_models: [{ ...values, id: 'fixture-agent', api_key: '' }], chat_models: [] } }; writes = 0; raceInsert = false; failure = ''; readbackFailure = previewFailure = unknownRpc = false; };
const stage = input => compatibility.stageLegacyModelPoolUpsert(input);
const publish = async result => { const preview = await admin.previewPlatformConfigurationRelease('model-pool', result.release.id); return admin.publishPlatformConfigurationRelease(actor, 'model-pool', result.release.id, preview.previewSha256); };

reset();
for (const requestId of ['', 'invalid', null]) await fail(() => stage({ ...request(), requestId }), 'PLATFORM_CONFIGURATION_REQUEST_ID_REQUIRED');
assert.equal(writes, 0); cases.push('missing and invalid request UUID denied before writes');
const malformed = request(); malformed.values.api_endpoint = 'file:///private'; await assert.rejects(() => stage(malformed)); assert.equal(writes, 0); cases.push('invalid snapshot denied before RPC writes');
const oldCandidates = Array.from({ length: 9 }, (_, index) => ({ id: randomUUID(), release_version: index + 1, snapshot: { schema: 'model-pool-config/v1', models: [] }, snapshot_sha256: contract.configurationSha256({ schema: 'model-pool-config/v1', models: [] }), status: 'draft', is_current: false }));
state.releases.push(...clone(oldCandidates));
const a = request(); const result = await stage(a); assert.equal(result.release.status, "validated"); assert.equal(result.release.validation_result.ok, true); assert.deepEqual(state.releases.slice(0, 9), oldCandidates); assert.equal(state.pending.length, 1); assert.equal(Object.keys(state.active).length, 0); assert.equal(state.releases.filter(row => row.is_current).length, 0); cases.push('new candidate and pending do not change active credentials current or nine existing candidates');
const publicJson = JSON.stringify(result); assert.ok(!publicJson.includes(secretA)); assert.ok(!publicJson.includes('fingerprint')); assert.ok(result.preview.credentialChanges.length === 1); cases.push('candidate and preview expose opaque metadata only');
const validSnapshot = clone(result.release.snapshot);
for (const changes of [[{ model_key: 'llm_models:bad-target', credential_ref: 'secret://platform-model/llm_models/bad-target', secret_value: secretB }], [{ model_key: `llm_models:${result.legacyId}`, credential_ref: 'secret://platform-model/video_models/wrong', secret_value: secretB }]]) {
  const count = writes; await fail(() => admin.stagePlatformModelCandidateWithCredentials({ actorId: actor, requestId: randomUUID(), requestPayload: { method: 'PUT', body: {} }, snapshot: validSnapshot, credentialChanges: changes, changeNote: 'negative ownership fixture' }), 'PLATFORM_CONFIGURATION_CREDENTIAL_STAGE_FAILED'); assert.equal(writes, count);
}
cases.push('actual stage function rejects mismatched modelKey and reference before fake transaction writes');
state.releases.push({ id: randomUUID(), snapshot: { schema: 'model-pool-config/v1', models: [] }, snapshot_sha256: contract.configurationSha256({ schema: 'model-pool-config/v1', models: [] }), status: 'published', is_current: true, release_version: 10 });
const retry = await stage(a); assert.equal(retry.release.id, result.release.id); assert.equal(state.receipts.length, 1); cases.push('same original logical request resumes exact candidate after current changes');
for (const field of ['api_key', 'api_endpoint']) { const changed = clone(a); changed.requestPayload.body[field] = field === 'api_key' ? secretB : 'https://different.invalid'; changed.values[field] = changed.requestPayload.body[field]; await fail(() => stage(changed), 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT'); }
const targetChanged = clone(a); targetChanged.requestPayload.targetId = 'different-target'; await fail(() => stage(targetChanged), 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT');
cases.push('changed secret endpoint or target cannot reuse request id');
for (const point of ['candidate', 'pending', 'receipt']) { reset(); failure = point; await fail(() => stage(request()), 'PLATFORM_CONFIGURATION_CREDENTIAL_STAGE_FAILED'); assert.equal(writes, 0); assert.equal(state.releases.length + state.pending.length + state.receipts.length, 0); }
cases.push('stateful fake stage transaction injection rolls all three writes back');
reset();
// Image upserts require a published base and never bootstrap a full live pool.
const imageBase = { schema: 'model-pool-config/v1', models: [] };
state.releases.push({ id: randomUUID(), release_version: 1, snapshot: imageBase, snapshot_sha256: contract.configurationSha256(imageBase), status: 'published', is_current: true });
const image = request(); image.table = 'cover_models'; image.id = 'pending-cover-model-random-one'; image.requestPayload.modelType = 'drawing'; image.values = { ...values, api_protocol_config: { protocol: 'images_generations' } }; const imageResult = await stage(image); assert.ok(imageResult.legacyId.startsWith('pending-cover-model-')); const imageAgain = await stage({ ...image, id: 'pending-cover-model-random-two' }); assert.equal(imageAgain.legacyId, imageResult.legacyId); cases.push('image create stable request identity retains pending activation prefix');
for (const masked of ['', '***', 'sk-***', 'configured', 'unchanged']) { reset(); const input = request(); input.values.api_key = masked; input.requestPayload.body.api_key = masked; await stage(input); assert.equal(state.pending.length, 0); assert.equal(Object.keys(state.active).length, 0); }
cases.push('blank and masked values create no pending secret');
reset(); const editId = '10000000-0000-4000-8000-000000000003', modelKey = `llm_models:${editId}`; state.active[modelKey] = { modelKey, ref: `secret://platform-model/llm_models/${editId}`, secret: secretA, revision: randomUUID() };
const edit = request(); edit.id = editId; edit.requestPayload.method = 'PUT'; edit.values.api_key = secretB; edit.requestPayload.body.api_key = secretB;
const first = await stage(edit); const second = await stage({ ...edit, requestId: randomUUID() }); assert.equal(state.pending.length, 2); assert.equal(state.active[modelKey].secret, secretA); cases.push('two candidates retain independent pending values and original active revision');
const protectedState = input => ({ active: input.active, pending: input.pending, receipts: input.receipts, releases: input.releases.map(({id,status,is_current,snapshot,snapshot_sha256}) => ({id,status,is_current,snapshot,snapshot_sha256})) });
const oldState = clone(state); for (const point of ['projector', 'pointer']) { failure = point; await fail(() => publish(first), 'PLATFORM_CONFIGURATION_PUBLISH_FAILED'); assert.deepEqual(protectedState(state), protectedState(oldState)); } failure = ''; cases.push('stateful fake projection and pointer failures rollback active/current/pending together');
state.active[modelKey].revision = randomUUID(); state.active[modelKey].secret = 'fixture-external-rotation'; const rotated = clone(state); await fail(() => publish(first), 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'); assert.deepEqual(protectedState(state), protectedState(rotated)); cases.push('external secret revision rotation blocks candidate with zero publish effects');
state = clone(oldState); await publish(first); assert.equal(state.active[modelKey].secret, secretB); assert.equal(state.physical.llm_models.find(row => row.id === editId).api_key, secretB); assert.equal(state.pending.find(row => row.releaseId === first.release.id).secret, null); const count = writes; await admin.publishPlatformConfigurationRelease(actor, 'model-pool', first.release.id, first.preview.previewSha256); assert.equal(writes, count); cases.push('successful publish scrubs staged secret; current replay performs no duplicate write');
const publishedReceiptRetry = await stage(edit); assert.equal(publishedReceiptRetry.release.id, first.release.id); assert.equal(publishedReceiptRetry.preview, null); cases.push('published candidate retry returns original receipt without recreating a draft');
await fail(() => publish(second), 'PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED'); cases.push('stale-parent pending candidate cannot overwrite current credentials');
state.releases.find(row => row.id === first.release.id).status = 'superseded'; state.releases.find(row => row.id === first.release.id).is_current = false;
const beforeSuperseded = writes; await fail(() => admin.publishPlatformConfigurationRelease(actor, 'model-pool', first.release.id, first.preview.previewSha256), 'PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT'); assert.equal(writes, beforeSuperseded); cases.push('superseded publication cannot be replayed');
const envSecret = state.active[modelKey].secret;
const rollback = await admin.createPlatformConfigurationRollbackCandidate(actor, 'model-pool', first.release.id, 'fixture rollback');
assert.equal(state.pending.filter(row => row.releaseId === rollback.id).length, 0);
await publish({ release: rollback }); assert.equal(state.active[modelKey].secret, envSecret); cases.push('rollback candidate has no pending secret and keeps current environment credential');
reset(); const raced = await stage(request()); raceInsert = true; await fail(() => publish(raced), 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'); assert.equal(Object.values(state.active)[0].secret, 'fixture-owner-race-insert'); assert.equal(state.releases.some(row => row.is_current), false); cases.push('owner insert between CAS check and write cannot be overwritten');
for (const point of ['readback', 'preview', 'stage', '08006', '08007', 'throw']) { reset(); if (point === 'readback') readbackFailure = true; if (point === 'preview') previewFailure = true; if (point === 'stage') unknownRpc = true; if (['08006', '08007', 'throw'].includes(point)) unknownRpc = point; const input = request(); await assert.rejects(() => stage(input), e => e instanceof admin.PlatformConfigurationMutationOutcomeUnknown && e.requestId === input.requestId && e.outcome === 'outcome_unknown' && e.receiptPath.includes(input.requestId)); assert.equal(state.receipts.length, 1); assert.equal(state.pending.length, 1); assert.equal(Object.keys(state.active).length, 0); readbackFailure = previewFailure = unknownRpc = false; const resumed = await stage(input); assert.equal(resumed.release.id, state.receipts[0].id); }
cases.push('lost RPC/readback/preview and 08006/08007/Promise rejection preserve receipt and resume with same id');
assert.ok(!logs.join('').includes(secretA)); assert.ok(!logs.join('').includes(secretB));
const sql = fs.readFileSync('supabase/migrations/20261030010000_platform_configuration_pending_credentials.sql', 'utf8');
assert.match(sql, /REVOKE ALL ON public\.platform_model_pending_credentials,public\.platform_model_mutation_receipts FROM PUBLIC,anon,authenticated,service_role/u);
assert.match(sql, /REVOKE INSERT,UPDATE,DELETE ON public\.platform_model_credential_bindings FROM PUBLIC,anon,authenticated,service_role/u);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.publish_platform_configuration_release_before_pending_credentials[^;]+FROM PUBLIC,anon,authenticated,service_role/u);
assert.match(sql, /ON CONFLICT DO NOTHING RETURNING/u);
assert.match(sql, /revision=v_pending.expected_revision[\s\S]*RETURNING/u);
assert.doesNotMatch(sql, /ON CONFLICT\(model_key\) DO UPDATE/u);
assert.match(sql, /ALTER TABLE public\.platform_model_pending_credentials OWNER TO zimeiti_owner/u);
assert.match(sql, /expected_revision[\s\S]*PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT/u);
assert.ok(sql.indexOf("platform-configuration-publish:model-pool") < sql.indexOf("platform-model-request:"));
cases.push('SQL ACL, lock order, private legacy publisher and revision CAS source contracts');
assert.equal(helper.modelMutationLegacyId(actor, a.requestId, 'llm_models'), helper.modelMutationLegacyId(actor, a.requestId, 'llm_models'));
const report = { passed: true, cases, scenarioGroups: cases.length, realNetworkRequests: 0, realDatabaseWrites: 0, postgresTransactionAndConcurrencyProof: 'NOT EXECUTED: root must verify the migration against authorized PostgreSQL before apply/deploy' };
const reportDirectory = process.env.PLATFORM_PENDING_CREDENTIALS_EVIDENCE_DIR || '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-pending-credentials';
fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(path.join(reportDirectory, 'zero-network-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
