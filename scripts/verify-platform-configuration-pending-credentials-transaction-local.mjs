import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import ts from 'typescript';
import { confirmLocalModelPendingDatabase } from './lib/model-pending-local-verification-guard.mjs';

// WRITES ARE ALWAYS ENCLOSED IN ONE CONNECTION'S BEGIN/FINAL ROLLBACK.
// No provider or generation request exists in this verifier. It never alters a
// real function/trigger and never commits business data. It is not a concurrency
// proof: the separate missing-binding owner race requires root's two-connection
// coordinated test under the reviewed cleanup contract.
if (!process.argv.includes('--execute-rollback-fixture')) {
  console.log(JSON.stringify({ mode: 'plan', databaseConnectionOpened: false, requiredFlag: '--execute-rollback-fixture', requiredEnvironment: ['MODEL_PENDING_FIXTURE_APPROVED=1', 'DATABASE_URL (controlled local zimeiti_local only)', 'MODEL_PENDING_PG_FINGERPRINT (canonical identity)', 'MODEL_PENDING_BACKUP_RECEIPT_PATH', 'MODEL_PENDING_BACKUP_RECEIPT_SHA256'], mutationBoundary: 'one connection BEGIN, SAVEPOINT failures, final ROLLBACK; zero provider calls' }, null, 2));
  process.exit(0);
}
if (process.env.MODEL_PENDING_FIXTURE_APPROVED !== '1' || !process.env.DATABASE_URL) throw Error('CONTROLLED_ROLLBACK_FIXTURE_AUTHORIZATION_REQUIRED');
const require = createRequire(import.meta.url), mod = { exports: {} };
const source = fs.readFileSync('src/lib/platform-configuration-contract.ts', 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { require, module: mod, exports: mod.exports, URL });
const contract = mod.exports;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'model-pending-rollback-fixture' });
const actor = randomUUID(), fixtureId = randomUUID(), fixtureKey = `llm_models:${fixtureId}`, fixtureRef = `secret://platform-model/llm_models/${fixtureId}`;
const secretA = `fixture-only-A-${randomUUID()}`, secretB = `fixture-only-B-${randomUUID()}`;
const cases = [];
let begun = false, rolledBack = false, sequence = 0;
const owner = async (sql, params = []) => { await client.query('SET LOCAL ROLE zimeiti_owner'); return client.query(sql, params); };
const service = async (sql, params = []) => { await client.query('SET LOCAL ROLE service_role'); return client.query(sql, params); };
async function expectFailure(work, code) {
  const savepoint = `fixture_${++sequence}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let failed = false;
  try { await work(); } catch (error) { failed = true; assert.ok(code ? String(error.message).includes(code) : Boolean(error.code), 'EXPECTED_FAILURE_CODE_MISMATCH'); }
  finally { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`); }
  assert.equal(failed, true, 'EXPECTED_DATABASE_FAILURE');
}
const counts = async () => (await owner("SELECT jsonb_build_object('c',(SELECT count(*) FROM public.model_pool_config_releases WHERE created_by=$1),'p',(SELECT count(*) FROM public.platform_model_pending_credentials p JOIN public.model_pool_config_releases r ON r.id=p.release_id WHERE r.created_by=$1),'r',(SELECT count(*) FROM public.platform_model_mutation_receipts WHERE actor_id=$1)) AS value", [actor])).rows[0].value;
const current = async () => (await owner("SELECT * FROM public.model_pool_config_releases WHERE is_current AND status='published'")).rows[0];
const stage = async (snapshot, secret, requestId = randomUUID(), logical = { method: 'POST', modelType: 'text', targetId: fixtureId, endpoint: 'https://fixture.invalid/v1', secret }, changes = null, parentId = undefined) => {
  const effectiveParent = parentId === undefined ? (await current())?.id || null : parentId;
  const entries = changes || [{ model_key: fixtureKey, credential_ref: fixtureRef, secret_value: secret }];
  const result = await service('SELECT public.stage_model_pool_candidate_with_credentials_atomic($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10::jsonb) AS value', [actor, requestId, JSON.stringify(logical), JSON.stringify(snapshot), contract.configurationSha256(snapshot), JSON.stringify({ ok: true, schema: 'fixture-validation' }), 'validated', 'owned rollback-only fixture', effectiveParent, JSON.stringify(entries)]);
  return result.rows[0].value;
};
const publish = async (candidate, baseline) => (await service('SELECT public.publish_platform_configuration_release_atomic($1,$2,$3,$4,$5,$6) AS value', ['model-pool', candidate.id, actor, candidate.snapshot_sha256, baseline?.id || null, baseline?.snapshot_sha256 || null])).rows[0].value;
const protectedFixture = async releaseId => (await owner("SELECT jsonb_build_object('active',(SELECT to_jsonb(b) FROM public.platform_model_credential_bindings b WHERE model_key=$1),'pending',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY model_key),'[]'::jsonb) FROM public.platform_model_pending_credentials p WHERE release_id=$2),'current',(SELECT jsonb_build_object('id',id,'hash',snapshot_sha256) FROM public.model_pool_config_releases WHERE is_current)) AS value", [fixtureKey, releaseId])).rows[0].value;
try {
  await client.connect();
  await confirmLocalModelPendingDatabase(client, process.env.DATABASE_URL, { expectedFingerprint: process.env.MODEL_PENDING_PG_FINGERPRINT, backupReceiptPath: process.env.MODEL_PENDING_BACKUP_RECEIPT_PATH, backupReceiptSha256: process.env.MODEL_PENDING_BACKUP_RECEIPT_SHA256, backupArchiveSha256: process.env.MODEL_PENDING_BACKUP_ARCHIVE_SHA256 });
  await client.query('BEGIN'); begun = true;
  await client.query("SET LOCAL lock_timeout='8s'"); await client.query("SET LOCAL statement_timeout='30s'");
  await owner("SELECT pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0))");
  const baseline = await current(); assert.ok(baseline, 'PUBLISHED_BASELINE_REQUIRED');
  const template = baseline.snapshot.models.find(model => model.kind === 'agent' && model.configuration.legacyTable === 'llm_models');
  assert.ok(template, 'EXISTING_LLM_TEMPLATE_REQUIRED');
  const entry = { ...structuredClone(template), id: `llm:${fixtureId}`, name: 'Rollback-only pending credential fixture', modelName: 'fixture-no-provider', endpoint: 'https://fixture.invalid/v1', credentialRef: fixtureRef, catalogState: 'enabled', configuration: { ...template.configuration, legacyTable: 'llm_models', legacyId: fixtureId } };
  const snapshot = contract.normalizeModelPoolSnapshot({ ...baseline.snapshot, models: [...baseline.snapshot.models, entry] });
  const beforeCounts = await counts();
  await expectFailure(() => stage(snapshot, secretA, randomUUID(), { test: 'invalid-parent' }, null, randomUUID()));
  assert.deepEqual(await counts(), beforeCounts); cases.push('candidate FK constraint failure leaves no candidate pending or receipt');
  const key = randomUUID(), logical = { method: 'POST', targetId: fixtureId, endpoint: entry.endpoint, secret: secretA };
  const first = await stage(snapshot, secretA, key, logical), second = await stage(snapshot, secretB);
  assert.equal((await owner('SELECT count(*)::int AS count FROM public.platform_model_credential_bindings WHERE model_key=$1', [fixtureKey])).rows[0].count, 0);
  assert.equal((await current()).id, baseline.id);
  assert.equal((await stage(snapshot, secretA, key, logical)).id, first.id);
  await expectFailure(() => stage(snapshot, secretB, key, { ...logical, secret: secretB }), 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT');
  cases.push('two pending candidates remain isolated active unchanged same-key replay stable different-body conflicts');
  const badId = randomUUID(), badKey = `llm_models:${badId}`;
  await owner('INSERT INTO public.platform_model_credential_bindings(credential_ref,model_key,secret_value,updated_by) VALUES($1,$2,$3,$4)', [`secret://platform-model/llm_models/${randomUUID()}`, badKey, secretA, actor]);
  const badEntry = { ...entry, id: `llm:${badId}`, credentialRef: `secret://platform-model/llm_models/${badId}`, configuration: { ...entry.configuration, legacyId: badId } };
  const badSnapshot = contract.normalizeModelPoolSnapshot({ ...snapshot, models: [...snapshot.models, badEntry] });
  const beforePartial = await counts();
  await expectFailure(() => stage(badSnapshot, secretA, randomUUID(), { test: 'partial-pending' }, [{ model_key: fixtureKey, credential_ref: fixtureRef, secret_value: secretA }, { model_key: badKey, credential_ref: badEntry.credentialRef, secret_value: secretB }]), 'PLATFORM_CONFIGURATION_CREDENTIAL_MODEL_MISMATCH');
  assert.deepEqual(await counts(), beforePartial); cases.push('failure after candidate and first pending insert rolls the complete stage transaction back');
  await publish(first, baseline);
  const committedFixture = await protectedFixture(first.id);
  assert.equal(committedFixture.active.secret_value, secretA); assert.equal((await owner('SELECT api_key FROM public.llm_models WHERE id=$1', [fixtureId])).rows[0]?.api_key, secretA, 'PHYSICAL_MODEL_SECRET_MUST_MATCH_PROMOTED_BINDING'); assert.equal(committedFixture.pending[0].secret_value, null); assert.equal(committedFixture.pending[0].state, 'applied');
  assert.equal((await publish(first, baseline)).id, first.id); assert.deepEqual(await protectedFixture(first.id), committedFixture); cases.push('publish promotes only its pending secret scrubs pending and repeat-current publish is idempotent');
  const beforeSecond = await protectedFixture(second.id);
  await expectFailure(() => publish(second, first), 'PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED'); assert.deepEqual(await protectedFixture(second.id), beforeSecond); cases.push('later pending candidate fails stale parent guard without changes');
  const rotationCandidate = await stage(snapshot, secretB);
  await owner('UPDATE public.platform_model_credential_bindings SET secret_value=$1 WHERE model_key=$2', [`fixture-external-${randomUUID()}`, fixtureKey]);
  const rotated = await protectedFixture(rotationCandidate.id);
  await expectFailure(() => publish(rotationCandidate, first), 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'); assert.deepEqual(await protectedFixture(rotationCandidate.id), rotated); cases.push('external owner rotation updates opaque revision and prevents stale promotion');
  const brokenEntry = { ...entry, pricing: { ...entry.pricing, costPerUse: 'fixture-invalid-numeric' } };
  const brokenSnapshot = contract.normalizeModelPoolSnapshot({ ...baseline.snapshot, models: [...baseline.snapshot.models, brokenEntry] });
  const broken = await stage(brokenSnapshot, secretB);
  const beforeBroken = await protectedFixture(broken.id);
  await expectFailure(() => publish(broken, first)); assert.deepEqual(await protectedFixture(broken.id), beforeBroken); cases.push('real existing projector failure rolls active promotion current pointer and pending state back');
  const next = await stage(snapshot, secretB); await publish(next, first); assert.equal((await owner('SELECT api_key FROM public.llm_models WHERE id=$1', [fixtureId])).rows[0]?.api_key, secretB, 'PHYSICAL_MODEL_SECRET_MUST_MATCH_SECOND_PROMOTION');
  await expectFailure(() => publish(first, baseline), 'PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT'); cases.push('superseded publish does not replay old secret');
  const metadata = (await service('SELECT public.read_platform_model_pending_credential_metadata($1) AS value', [next.id])).rows[0].value;
  const receipt = (await service('SELECT public.read_platform_model_mutation_receipt($1,$2,NULL) AS value', [actor, key])).rows[0].value;
  const safe = JSON.stringify({ metadata, receipt }); for (const secret of [secretA, secretB]) assert.ok(!safe.includes(secret)); assert.ok(!/fingerprint|secret_value|request_salt/u.test(safe)); cases.push('service metadata and receipt never return secret or secret fingerprint');
  await expectFailure(() => service('SELECT * FROM public.platform_model_pending_credentials'));
  await expectFailure(() => service('SELECT * FROM public.platform_model_mutation_receipts'));
  await expectFailure(() => service('UPDATE public.platform_model_credential_bindings SET secret_value=$1 WHERE model_key=$2', [secretA, fixtureKey]));
  await expectFailure(() => service('SELECT public.publish_platform_configuration_release_before_pending_credentials($1,$2,$3,$4,$5,$6)', ['model-pool', next.id, actor, next.snapshot_sha256, first.id, first.snapshot_sha256]));
  for (const role of ['anon', 'authenticated']) await expectFailure(async () => { await client.query(`SET LOCAL ROLE ${role}`); await client.query('SELECT public.read_platform_model_pending_credential_metadata($1)', [next.id]); });
  cases.push('actual service and anonymous ACL deny raw pending receipt active writes and private legacy publisher');
} catch (error) {
  // Never print Postgres error detail or parameter values; they may contain a row.
  console.error(JSON.stringify({ passed: false, databaseErrorCode: String(error.code || 'FIXTURE_ASSERTION_FAILED'), safeFailure: 'rollback fixture failed; transaction rollback follows' }));
  process.exitCode = 1;
} finally {
  if (begun) { await client.query('ROLLBACK'); rolledBack = true; }
  await client.end();
  const report = { passed: !process.exitCode, cases, transactionRolledBack: rolledBack, realProviderCalls: 0, committedBusinessWrites: 0, concurrencyProof: 'not executed; single-connection transactional/ACL verifier only' };
  const root = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-pending-credentials'; fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(`${root}/postgres-rollback-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
