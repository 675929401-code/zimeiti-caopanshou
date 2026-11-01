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
  const localRequire = name => name === '@/storage/database/supabase-client' ? { getSupabaseAdminClient: () => db } : name === '@/lib/provider-secret' ? {resolveProviderSecret:value=>String(value||'')} : name === 'server-only' ? {} : name.startsWith('@/') ? load(`src/${name.slice(2)}.ts`) : require(name);
  const js = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: localRequire, console: { log: (...items) => logs.push(items.join(' ')), error: (...items) => logs.push(items.join(' ')) }, URL, Date, Object, JSON, Set, Map }, { filename: relative });
  return module.exports;
}
const contract = load('src/lib/platform-configuration-contract.ts');
const admin = load('src/lib/server/platform-configuration-admin.ts'), compatibility = load('src/lib/server/platform-configuration-compatibility.ts');
const helper = load('src/lib/server/platform-configuration-pending-credentials.ts');

const reads=[],rpcCalls=[];const originalFrom=db.from.bind(db),originalRpc=db.rpc.bind(db);
db.from=table=>{reads.push(table);return originalFrom(table);};db.rpc=async(name,p)=>{rpcCalls.push({name,p});return originalRpc(name,p);};
const model=(kind,id,table)=>({id:table==='llm_models'?'llm:'+id:id,kind,name:id,modelName:id,provider:'fixture',protocol:kind==='agent'?'openai_chat':'video-fixture',endpoint:'https://fixture.invalid/v1',credentialRef:`secret://platform-model/${table}/${id}`,catalogState:'enabled',sortOrder:0,capabilities:{protocol:{}},pricing:{cost:1,selling:2,currency:'CNY'},configuration:{legacyTable:table,legacyId:id,protocolConfig:{}}});
const llmIds=Array.from({length:6},()=>randomUUID()),baseId=randomUUID();
const snapshot=contract.normalizeModelPoolSnapshot({schema:'model-pool-config/v1',models:[model('video','fixture-video','video_models'),...llmIds.map(id=>model('agent',id,'llm_models'))]});
state.releases=[{id:baseId,release_version:1,snapshot,snapshot_sha256:contract.configurationSha256(snapshot),is_current:true,status:'published'}];
state.physical.video_models=[{id:'fixture-video',name:'Physical video',model_name:'fixture-video',provider:'fixture',protocol_type:'video-fixture',api_endpoint:'https://fixture.invalid/v1',api_key:secretA,api_protocol_config:{},cost_price:1,price_per_use:2,icon_url:'/fixture.png',admin_notes:'Fixture note',is_active:true}];
state.physical.llm_models=llmIds.slice(0,4).map(id=>({id,model_name:'drifting-physical',api_endpoint:'https://live-drift.invalid/v1',api_key:secretB}));
const input={actorId:actor,requestId:randomUUID(),requestPayload:{method:'PUT',modelType:'video',targetId:'fixture-video',body:{name:'Updated video'}},table:'video_models',id:'fixture-video',values:{name:'Updated video'},changeNote:'Synthetic upsert'};
const out=await compatibility.stageLegacyModelPoolUpsert(input);
const candidate=out.release;
assert.deepEqual(clone(candidate.snapshot.models.filter(m=>m.kind!=='video')),clone(snapshot.models.filter(m=>m.kind!=='video')));
assert.equal(reads.includes('llm_models'),false);assert.equal(reads.includes('cover_models'),false);
assert.equal(candidate.snapshot.models.find(m=>m.kind==='video').configuration.iconUrl,'/fixture.png');assert.equal(candidate.snapshot.models.find(m=>m.kind==='video').configuration.adminNotes,'Fixture note');
const staged=rpcCalls.find(x=>x.name==='stage_model_pool_candidate_with_credentials_atomic').p;
assert.equal(staged.p_parent_release_id,baseId);assert.equal(staged.p_validation_result.operation,'video-upsert-only');assert.equal(staged.p_validation_result.baseSnapshotSha256,state.releases[0].snapshot_sha256);assert.equal(staged.p_credential_changes.length,0);
cases.push('actual video compatibility preserves exact six unrelated entries and never reads other physical pools; avatar and notes serialized');
await admin.validatePlatformConfigurationCandidate(actor,'model-pool',candidate.id);assert.equal(state.releases.find(r=>r.id===candidate.id).validation_result.operation,'video-upsert-only');cases.push('candidate validation preserves video operation marker');
const gate=load('src/lib/model-activation-gate.ts');assert.equal(gate.inspectVideoModelActivationReadiness({id:'synthetic-pending',model_name:'fixture',provider:'fixture',protocol_type:'fixture',api_endpoint:'https://fixture.invalid',api_key:secretA,api_protocol_config:{__model_activation_gate:{schema:'media_model_activation_gate.v1',state:'pending'}},is_active:true,is_hidden:false}).ready,false);cases.push('activation evidence inspector returns ready=false for pending; catalog flags remain visible (not proof of admission isolation)');
const writesBefore=writes;await assert.rejects(()=>admin.stagePlatformModelCandidateWithCredentials({actorId:actor,requestId:randomUUID(),requestPayload:{method:'PUT'},snapshot,credentialChanges:[],changeNote:'stale base',expectedBase:{releaseId:randomUUID(),snapshotSha256:state.releases[0].snapshot_sha256}}),e=>e.code==='PLATFORM_CONFIGURATION_CURRENT_CHANGED');assert.equal(writes,writesBefore);cases.push('actual admin rejects changed expected base before stage RPC');
const resume=await compatibility.stageLegacyModelPoolUpsert(input);assert.equal(resume.release.id,candidate.id);cases.push('actual receipt retry resumes same candidate');
const migration=fs.readFileSync('supabase/migrations/20261030070000_video_upsert_publication.sql','utf8');
for(const token of ['e20c16d0af33624896dd0138ce5227c2c208021112242bf1c52a1704e52d9a74','b51ab600921f399b2ce2d7a0c61547273f80bb65ab2ca027a6e2d0e1a478225d','PLATFORM_CONFIGURATION_VIDEO_UPSERT_EXISTING_MISSING','PLATFORM_CONFIGURATION_VIDEO_UPSERT_NEW_COLLISION','baseSnapshotSha256','ADD COLUMN IF NOT EXISTS icon_url text','PLATFORM_CONFIGURATION_VIDEO_UPSERT_GATE_INVALID','ORDER BY id FOR UPDATE'])assert.ok(migration.includes(token),token);
assert.doesNotMatch(migration,/UPDATE public\.(?:llm_models|cover_models|chat_models)/u);
assert.equal((migration.match(/CREATE OR REPLACE FUNCTION/gu)||[]).length,2);
const scoped=migration.slice(migration.lastIndexOf('  IF v_video_upsert THEN'),migration.indexOf('    -- Exact original model-pool pointer finalization'));
assert.doesNotMatch(scoped,/ON CONFLICT|project_model_pool_configuration|publish_platform_configuration_release_before_pending_credentials/u);
const stageBody=migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.stage_model_pool_candidate'));
assert.ok(stageBody.indexOf('RETURN v_candidate;')<stageBody.indexOf("p_validation_result->>'operation'='video-upsert-only'"));
cases.push('SQL exact preconditions scopes plain INSERT physical lock gate and resume-before-CAS guards');
console.log(JSON.stringify({passed:true,cases,networkCalls:0,databaseWrites:0,providerCalls:0,postgresTransactionRequired:true}));
