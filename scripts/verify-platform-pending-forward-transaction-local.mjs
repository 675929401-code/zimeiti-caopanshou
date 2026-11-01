import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import ts from 'typescript';
import { confirmLocalModelPendingDatabase } from './lib/model-pending-local-verification-guard.mjs';

// Forward-only acceptance. Root executes after reviewed migration 187. One
// connection, BEGIN/final ROLLBACK, no provider calls or real function changes.
if (!process.argv.includes('--execute-forward-rollback-fixture')) {
  console.log(JSON.stringify({ mode: 'plan', databaseConnections: 0, requiredFlag: '--execute-forward-rollback-fixture', requiredEnvironment: ['MODEL_PENDING_FIXTURE_APPROVED=1','DATABASE_URL controlled zimeiti_local','MODEL_PENDING_PG_FINGERPRINT canonical','MODEL_PENDING_BACKUP_RECEIPT_PATH','MODEL_PENDING_BACKUP_RECEIPT_SHA256'], scenarios: ['same-parent promotion','stale pending parent rejects without changes','fresh candidate promotion','cover and LLM removal content integrity','removed content rewrite denied','stale no-pending and rollback compatibility','current publish replay'], mutationBoundary: 'one connection BEGIN/final ROLLBACK; no provider requests' }, null, 2)); process.exit(0);
}
if (process.env.MODEL_PENDING_FIXTURE_APPROVED !== '1' || !process.env.DATABASE_URL) throw Error('CONTROLLED_FORWARD_FIXTURE_REQUIRED');
const require = createRequire(import.meta.url), mod = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/platform-configuration-contract.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { require, module: mod, exports: mod.exports, URL });
const contract = mod.exports, client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'platform-pending-forward-rollback-fixture' });
const actor = randomUUID(), id = randomUUID(), llmExtraId = randomUUID(), coverId = `pending-cover-model-${randomUUID()}`, key = `llm_models:${id}`, ref = `secret://platform-model/llm_models/${id}`;
const secretA = `fixture-forward-A-${randomUUID()}`, secretB = `fixture-forward-B-${randomUUID()}`;
let begun = false, baseline = null, step = 0;
const report = { schema: 'platform-pending-forward-transaction-acceptance.v1', passed: false, cases: [], transactionRolledBack: false, baselineRestored: false, committedBusinessWrites: 0, providerCalls: 0 };
const owner = async (sql, params = []) => { await client.query('SET LOCAL ROLE zimeiti_owner'); return client.query(sql, params); };
const service = async (sql, params = []) => { await client.query('SET LOCAL ROLE service_role'); return client.query(sql, params); };
const current = async () => (await owner("SELECT * FROM public.model_pool_config_releases WHERE is_current AND status='published'")).rows[0];
const changes = secret => [{ model_key: key, credential_ref: ref, secret_value: secret }];
const stage = async (snapshot, credentialChanges = []) => {
  const parent = await current();
  return (await service('SELECT public.stage_model_pool_candidate_with_credentials_atomic($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10::jsonb) AS value', [actor, randomUUID(), JSON.stringify({ method: 'PUT', fixture: 'forward', sequence: ++step, secret: credentialChanges[0]?.secret_value || '' }), JSON.stringify(snapshot), contract.configurationSha256(snapshot), JSON.stringify({ ok: true, schema: 'owned-forward-fixture' }), 'validated', 'Owned forward rollback-only fixture', parent?.id || null, JSON.stringify(credentialChanges)])).rows[0].value;
};
const publish = async candidate => { const parent = await current(); return (await service('SELECT public.publish_platform_configuration_release_atomic($1,$2,$3,$4,$5,$6) AS value', ['model-pool', candidate.id, actor, candidate.snapshot_sha256, parent?.id || null, parent?.snapshot_sha256 || null])).rows[0].value; };
const physical = async () => (await owner('SELECT api_key FROM public.llm_models WHERE id=$1', [id])).rows[0]?.api_key;
const protectedState = async candidateId => (await owner("SELECT jsonb_build_object('binding',(SELECT to_jsonb(t) FROM public.platform_model_credential_bindings t WHERE model_key=$1),'physical',(SELECT to_jsonb(t) FROM public.llm_models t WHERE id=$2),'pending',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY model_key),'[]'::jsonb) FROM public.platform_model_pending_credentials t WHERE release_id=$3),'current',(SELECT to_jsonb(t) FROM public.model_pool_config_releases t WHERE is_current)) AS value", [key, id, candidateId])).rows[0].value;
const content = async (table, targetId) => { assert.ok(['llm_models', 'cover_models'].includes(table)); return (await owner(`SELECT to_jsonb(t)-ARRAY['is_active','is_hidden','updated_at'] AS value FROM public.${table} t WHERE id::text=$1`, [targetId])).rows[0]?.value; };
async function expectedFailure(work, code) {
  const name = `forward_failure_${++step}`; await client.query(`SAVEPOINT ${name}`); let caught = false;
  try { await work(); } catch (error) {
    caught = true;
    const diagnostic = { expectedCode: code, postgresCode: /^[0-9A-Z]{5}$/u.test(String(error.code)) ? error.code : null,
      actualToken: String(error.message || "").match(/(?:MODEL_POOL|PLATFORM_CONFIGURATION)_[A-Z0-9_]+/u)?.[0] || null,
      constraint: /^[a-zA-Z0-9_]{1,100}$/u.test(String(error.constraint)) ? error.constraint : null,
      functions: [...String(error.where || "").matchAll(/PL\/pgSQL function ([a-zA-Z0-9_.]+)\(/gu)].map(match => match[1]) };
    (report.expectedFailureDiagnostics ||= []).push(diagnostic);
    assert.ok(String(error.message).includes(code), 'EXPECTED_FORWARD_FAILURE_CODE_MISMATCH');
  }
  finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); }
  assert.equal(caught, true, 'EXPECTED_FORWARD_REJECTION');
}
try {
  await client.connect(); await confirmLocalModelPendingDatabase(client, process.env.DATABASE_URL, { expectedFingerprint: process.env.MODEL_PENDING_PG_FINGERPRINT, backupReceiptPath: process.env.MODEL_PENDING_BACKUP_RECEIPT_PATH, backupReceiptSha256: process.env.MODEL_PENDING_BACKUP_RECEIPT_SHA256, backupArchiveSha256: process.env.MODEL_PENDING_BACKUP_ARCHIVE_SHA256 });
  await client.query('BEGIN'); begun = true; await client.query("SET LOCAL lock_timeout='8s'"); await client.query("SET LOCAL statement_timeout='30s'"); await owner("SELECT pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0))");
  baseline = await current(); assert.ok(baseline, 'PUBLISHED_BASELINE_REQUIRED');
  const llmTemplate = baseline.snapshot.models.find(model => model.kind === 'agent' && model.configuration.legacyTable === 'llm_models'), coverTemplate = baseline.snapshot.models.find(model => model.kind === 'image' && model.configuration.legacyTable === 'cover_models'); assert.ok(llmTemplate && coverTemplate, 'LEGAL_FIXTURE_TEMPLATES_REQUIRED');
  const entry = { ...structuredClone(llmTemplate), id: `llm:${id}`, name: 'Owned forward survivor', modelName: 'fixture-no-provider-survivor', endpoint: 'https://fixture.invalid/v1', credentialRef: ref, configuration: { ...llmTemplate.configuration, legacyTable: 'llm_models', legacyId: id } };
  const small = contract.normalizeModelPoolSnapshot({ ...baseline.snapshot, models: [...baseline.snapshot.models, entry] });
  const initial = await stage(small, changes(secretA)); await publish(initial);
  let protectedReadback = await protectedState(initial.id); assert.equal(await physical(), secretA); assert.equal(protectedReadback.binding.secret_value, secretA); assert.equal(protectedReadback.pending[0].state, 'applied'); assert.equal(protectedReadback.pending[0].secret_value, null); report.cases.push('A same-parent pending promotes physical and binding and scrubs staged secret');
  const oldPending = await stage(small, changes(secretB));
  const coverEntry = { ...structuredClone(coverTemplate), id: coverId, name: 'Owned forward cover extra', modelName: 'fixture-no-provider-cover', endpoint: 'https://fixture.invalid/v1', configuration: { ...coverTemplate.configuration, legacyTable: 'cover_models', legacyId: coverId } }; delete coverEntry.credentialRef;
  const larger = contract.normalizeModelPoolSnapshot({ ...small, models: [...small.models, coverEntry] }); const addition = await stage(larger); await publish(addition);
  const beforeBlocked = await protectedState(oldPending.id);
  await expectedFailure(() => publish(oldPending), 'PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED'); assert.deepEqual(await protectedState(oldPending.id), beforeBlocked); report.cases.push('B stale pending base rejects with active physical pending current byte-identical');
  const fresh = await stage(larger, changes(secretB)); await publish(fresh); protectedReadback = await protectedState(fresh.id); assert.equal(await physical(), secretB); assert.equal(protectedReadback.binding.secret_value, secretB); assert.equal(protectedReadback.pending[0].secret_value, null); report.cases.push('C new candidate on actual new current promotes successfully');
  const coverBefore = await content('cover_models', coverId), survivorBeforeCover = await content('llm_models', id); const removeCover = await stage(small); await publish(removeCover);
  assert.deepEqual(await content('cover_models', coverId), coverBefore); assert.deepEqual(await content('llm_models', id), survivorBeforeCover); assert.equal((await owner('SELECT is_hidden,is_active FROM public.cover_models WHERE id::text=$1', [coverId])).rows[0].is_hidden, true); report.cases.push('D cover removal changes only allowed visibility fields and leaves survivor unchanged');
  const llmExtra = { ...structuredClone(entry), id: `llm:${llmExtraId}`, name: 'Owned forward LLM extra', modelName: 'fixture-no-provider-extra', configuration: { ...entry.configuration, legacyId: llmExtraId } }; delete llmExtra.credentialRef;
  const withLlm = contract.normalizeModelPoolSnapshot({ ...small, models: [...small.models, llmExtra] }); const llmAddition = await stage(withLlm); await publish(llmAddition);
  const llmBefore = await content('llm_models', llmExtraId), survivorBeforeLlm = await content('llm_models', id); const removeLlm = await stage(small); await publish(removeLlm);
  assert.deepEqual(await content('llm_models', llmExtraId), llmBefore); assert.deepEqual(await content('llm_models', id), survivorBeforeLlm); const removedFlags = (await owner('SELECT is_active,is_hidden,user_access FROM public.llm_models WHERE id=$1', [llmExtraId])).rows[0]; assert.equal(removedFlags.is_active, false); assert.equal(removedFlags.is_hidden, true); assert.equal(removedFlags.user_access, llmBefore.user_access); report.cases.push('D LLM removal preserves entire nonvisibility content including user_access and survivor');
  // Deliberately exercise the unchanged canonical removed-content guard using
  // only its owner-scoped TEMP permit and a random owned fixture row.
  await expectedFailure(async () => {
    await owner('CREATE TEMP TABLE pg_temp.model_pool_canonical_visibility_permit(legacy_table text NOT NULL,legacy_id text NOT NULL,transaction_id bigint NOT NULL,backend_pid integer NOT NULL,expected_present boolean NOT NULL,removed boolean NOT NULL,original_hash text NOT NULL) ON COMMIT DROP');
    await owner("INSERT INTO pg_temp.model_pool_canonical_visibility_permit VALUES('llm_models',$1,txid_current(),pg_backend_pid(),true,true,'fixture-original-hash')", [llmExtraId]);
    const forbiddenAccess = llmBefore.user_access === 'hidden' ? 'available' : 'hidden';
    assert.notEqual(forbiddenAccess, llmBefore.user_access, 'REMOVED_CONTENT_NEGATIVE_MUST_CHANGE_VALUE');
    await owner('UPDATE public.llm_models SET user_access=$2 WHERE id=$1', [llmExtraId, forbiddenAccess]);
  }, 'MODEL_POOL_REMOVAL_CONTENT_CHANGED'); assert.deepEqual(await content('llm_models', llmExtraId), llmBefore); report.cases.push('E deliberate removed content rewrite remains rejected by existing guard');
  const staleNoPending = await stage(small); const renameEntry = { ...entry, name: 'Owned intermediate rename' }; const renamed = contract.normalizeModelPoolSnapshot({ ...small, models: small.models.map(model => model.id === entry.id ? renameEntry : model) }); const intermediate = await stage(renamed); await publish(intermediate); await publish(staleNoPending); assert.equal(await physical(), secretB); report.cases.push('F stale no-pending candidate retains previous publication behavior');
  const currentBeforeRollback = await current();
  const rollback = (await service('SELECT public.create_platform_configuration_candidate_atomic($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,$9) AS value', ['model-pool', actor, JSON.stringify(initial.snapshot), initial.snapshot_sha256, JSON.stringify({ ok: true, schema: 'owned-rollback-fixture' }), 'validated', 'Owned rollback compatibility', currentBeforeRollback.id, initial.id])).rows[0].value;
  await publish(rollback); assert.equal(await physical(), secretB); assert.equal((await protectedState(rollback.id)).pending.length, 0); report.cases.push('F rollback has no pending and retains current environment credential');
  const repeatBefore = await protectedState(rollback.id); await publish(rollback); assert.deepEqual(await protectedState(rollback.id), repeatBefore); report.cases.push('G repeated current publication performs no additional change'); report.passed = true;
} catch (error) { report.safeFailureCode = /^[A-Z][A-Z0-9_]{2,100}$/u.test(String(error.message)) ? error.message : 'FORWARD_VERIFIER_FAILED'; report.postgresCode = /^[0-9A-Z]{5}$/u.test(String(error.code)) ? error.code : undefined; process.exitCode = 1; }
finally {
  try { if (begun) { await client.query('ROLLBACK'); report.transactionRolledBack = true; } if (report.transactionRolledBack && baseline) { const now = await current(); report.baselineRestored = now?.id === baseline.id && now?.snapshot_sha256 === baseline.snapshot_sha256; const residual = await owner('SELECT (SELECT count(*) FROM public.llm_models WHERE id::text=ANY($1::text[]))::int+(SELECT count(*) FROM public.cover_models WHERE id::text=$2)::int+(SELECT count(*) FROM public.platform_model_credential_bindings WHERE model_key=$3)::int+(SELECT count(*) FROM public.model_pool_config_releases WHERE created_by=$4)::int AS count', [[id, llmExtraId], coverId, key, actor]); report.ownedFixtureResidual = residual.rows[0].count; if (!report.baselineRestored || report.ownedFixtureResidual !== 0) { report.passed = false; process.exitCode = 1; } } }
  finally { await client.end(); }
  const root = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-pending-credentials'; fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(`${root}/forward-transaction-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
