import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import ts from 'typescript';
import { confirmLocalModelPendingDatabase } from './lib/model-pending-local-verification-guard.mjs';

// Dedicated regression: a pending-credential candidate becomes a strict subset
// after another publication adds a model. The accepted fresh preview explicitly
// removes that model. Pure-removal projection must still deliver the pending
// credential to the survivor's physical runtime row. One BEGIN/final ROLLBACK;
// no alteration of functions/triggers, provider traffic, or persistent fixture.
if (!process.argv.includes('--execute-rollback-combination')) {
  console.log(JSON.stringify({ mode: 'plan', databaseConnections: 0, scenario: 'pending-credential-and-cover-strict-subset-pure-removal', requiredFlag: '--execute-rollback-combination', requiredEnvironment: ['MODEL_PENDING_FIXTURE_APPROVED=1','DATABASE_URL controlled local zimeiti_local','MODEL_PENDING_PG_FINGERPRINT canonical','MODEL_PENDING_BACKUP_RECEIPT_PATH','MODEL_PENDING_BACKUP_RECEIPT_SHA256'], mutationBoundary: 'same connection BEGIN and final ROLLBACK; all model credential candidate and pointer changes rollback' }, null, 2)); process.exit(0);
}
if (process.env.MODEL_PENDING_FIXTURE_APPROVED !== '1' || !process.env.DATABASE_URL) throw Error('CONTROLLED_ROLLBACK_COMBINATION_REQUIRED');
const require = createRequire(import.meta.url), mod = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/platform-configuration-contract.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { require, module: mod, exports: mod.exports, URL });
const contract = mod.exports, client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'pending-pure-removal-rollback-combination' });
const actor = randomUUID(), id = randomUUID(), extraId = randomUUID(), key = `llm_models:${id}`, ref = `secret://platform-model/llm_models/${id}`;
const coverId = `pending-cover-model-${extraId}`;
const secretA = `fixture-combination-A-${randomUUID()}`, secretB = `fixture-combination-B-${randomUUID()}`;
let begun = false, rolledBack = false, baselineId = null, baselineHash = null;
const report = { scenario: 'pending-credential-and-cover-strict-subset-pure-removal', passed: false, reproducedMismatch: false, strictSubset: false, survivorBindingMatchesPending: null, survivorPhysicalMatchesPending: null, pendingApplied: null, readbackPerformed: false, plainCoverRemovalControlPassed: false, transactionRolledBack: false, baselineRestored: false, committedBusinessWrites: 0, providerCalls: 0 };
const owner = async (sql, params = []) => { await client.query('SET LOCAL ROLE zimeiti_owner'); return client.query(sql, params); };
const service = async (sql, params = []) => { await client.query('SET LOCAL ROLE service_role'); return client.query(sql, params); };
const current = async () => (await owner("SELECT * FROM public.model_pool_config_releases WHERE is_current AND status='published'")).rows[0];
const stage = async (snapshot, secret, changes = null) => (await service('SELECT public.stage_model_pool_candidate_with_credentials_atomic($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7,$8,NULL,$9::jsonb) AS value', [actor, randomUUID(), JSON.stringify({ method: 'PUT', scenario: report.scenario, targetId: id, secret }), JSON.stringify(snapshot), contract.configurationSha256(snapshot), JSON.stringify({ ok: true, schema: 'owned-rollback-combination' }), 'validated', 'Owned rollback-only pure-removal/pending regression', JSON.stringify(changes || [{ model_key: key, credential_ref: ref, secret_value: secret }])])).rows[0].value;
const publish = async (candidate, baseline) => (await service('SELECT public.publish_platform_configuration_release_atomic($1,$2,$3,$4,$5,$6) AS value', ['model-pool', candidate.id, actor, candidate.snapshot_sha256, baseline.id, baseline.snapshot_sha256])).rows[0].value;
try {
  await client.connect(); await confirmLocalModelPendingDatabase(client, process.env.DATABASE_URL, { expectedFingerprint: process.env.MODEL_PENDING_PG_FINGERPRINT, backupReceiptPath: process.env.MODEL_PENDING_BACKUP_RECEIPT_PATH, backupReceiptSha256: process.env.MODEL_PENDING_BACKUP_RECEIPT_SHA256, backupArchiveSha256: process.env.MODEL_PENDING_BACKUP_ARCHIVE_SHA256 });
  await client.query('BEGIN'); begun = true; await client.query("SET LOCAL lock_timeout='8s'"); await client.query("SET LOCAL statement_timeout='30s'");
  await owner("SELECT pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0))");
  const baseline = await current(); assert.ok(baseline, 'PUBLISHED_BASELINE_REQUIRED'); baselineId = baseline.id; baselineHash = baseline.snapshot_sha256;
  const template = baseline.snapshot.models.find(model => model.kind === 'agent' && model.configuration.legacyTable === 'llm_models'); assert.ok(template, 'EXISTING_LLM_TEMPLATE_REQUIRED');
  const entry = { ...structuredClone(template), id: `llm:${id}`, name: 'Owned pending survivor fixture', modelName: 'fixture-no-provider-survivor', endpoint: 'https://fixture.invalid/v1', credentialRef: ref, configuration: { ...template.configuration, legacyTable: 'llm_models', legacyId: id } };
  const snapshot = contract.normalizeModelPoolSnapshot({ ...baseline.snapshot, models: [...baseline.snapshot.models, entry] });
  const initial = await stage(snapshot, secretA); await publish(initial, baseline);
  assert.equal((await owner('SELECT api_key FROM public.llm_models WHERE id=$1', [id])).rows[0]?.api_key, secretA, 'INITIAL_PHYSICAL_PROJECTION_REQUIRED');
  // Capture pending B before a different publication grows the model pool.
  const oldCandidate = await stage(snapshot, secretB);
  const coverTemplate = baseline.snapshot.models.find(model => model.kind === 'image' && model.configuration.legacyTable === 'cover_models'); assert.ok(coverTemplate, 'EXISTING_COVER_TEMPLATE_REQUIRED');
  const extra = { ...structuredClone(coverTemplate), id: coverId, name: 'Owned cover removal fixture', modelName: 'fixture-no-provider-extra', endpoint: 'https://fixture.invalid/v1', configuration: { ...coverTemplate.configuration, legacyTable: 'cover_models', legacyId: coverId } }; delete extra.credentialRef;
  const largerSnapshot = contract.normalizeModelPoolSnapshot({ ...snapshot, models: [...snapshot.models, extra] });
  const addition = await stage(largerSnapshot, '', []); await publish(addition, initial);
  report.strictSubset = snapshot.models.length < largerSnapshot.models.length && snapshot.models.every(next => largerSnapshot.models.some(old => contract.stableConfigurationJson(next) === contract.stableConfigurationJson(old)));
  assert.equal(report.strictSubset, true, 'STRICT_SUBSET_PRECONDITION_REQUIRED');
  // Control: the same strict-subset deletion WITHOUT pending credentials must
  // succeed before the pending combination can be interpreted. Savepoint keeps
  // the larger current snapshot and the older pending candidate intact.
  await client.query('SAVEPOINT plain_cover_removal_control');
  try {
    const control = await stage(snapshot, '', []); await publish(control, addition);
    const hidden = (await owner('SELECT is_hidden FROM public.cover_models WHERE id::text=$1', [coverId])).rows[0];
    assert.equal(hidden?.is_hidden, true, 'PLAIN_COVER_REMOVAL_NOT_APPLIED');
    assert.equal((await owner('SELECT api_key FROM public.llm_models WHERE id=$1', [id])).rows[0]?.api_key, secretA, 'CONTROL_MUST_KEEP_SURVIVOR_SECRET');
    report.plainCoverRemovalControlPassed = true;
  } finally { await client.query('ROLLBACK TO SAVEPOINT plain_cover_removal_control'); await client.query('RELEASE SAVEPOINT plain_cover_removal_control'); }
  const delta = await owner('SELECT * FROM public.model_pool_projection_delta($1::jsonb)', [JSON.stringify(snapshot)]);
  report.beforePromotionDeltaRemovedOnly = delta.rows.every(row => row.removed === true);
  // Fresh expected-current identity explicitly accepts removal of the extra.
  await publish(oldCandidate, addition);
  const active = (await owner('SELECT secret_value FROM public.platform_model_credential_bindings WHERE model_key=$1', [key])).rows[0];
  const physical = (await owner('SELECT api_key FROM public.llm_models WHERE id=$1', [id])).rows[0];
  const pending = (await owner('SELECT state,secret_value IS NULL AS scrubbed FROM public.platform_model_pending_credentials WHERE release_id=$1 AND model_key=$2', [oldCandidate.id, key])).rows[0];
  report.readbackPerformed = true;
  report.removedCoverHidden = (await owner('SELECT is_hidden FROM public.cover_models WHERE id::text=$1', [coverId])).rows[0]?.is_hidden === true;
  report.survivorBindingMatchesPending = active?.secret_value === secretB; report.survivorPhysicalMatchesPending = physical?.api_key === secretB; report.pendingApplied = pending?.state === 'applied' && pending.scrubbed === true;
  report.reproducedMismatch = report.survivorBindingMatchesPending && report.pendingApplied && !report.survivorPhysicalMatchesPending;
  assert.equal(report.survivorPhysicalMatchesPending, true, 'PENDING_SECRET_SURVIVOR_PHYSICAL_PROJECTION_MISMATCH');
  assert.equal(report.survivorBindingMatchesPending && report.pendingApplied && report.removedCoverHidden, true, 'PENDING_PROMOTION_READBACK_MISMATCH'); report.passed = true;
} catch (error) { report.safeFailureCode = report.reproducedMismatch ? 'PENDING_SECRET_SURVIVOR_PHYSICAL_PROJECTION_MISMATCH' : /^[A-Z][A-Z0-9_]{2,100}$/u.test(String(error.message)) ? error.message : 'COMBINATION_VERIFIER_FAILED'; report.postgresCode = /^[0-9A-Z]{5}$/u.test(String(error.code)) ? error.code : undefined; process.exitCode = 1; }
finally {
  try { if (begun) { await client.query('ROLLBACK'); rolledBack = true; } report.transactionRolledBack = rolledBack;
    if (rolledBack && baselineId) { const now = await current(); report.baselineRestored = now?.id === baselineId && now?.snapshot_sha256 === baselineHash; const leftovers = await owner('SELECT ((SELECT count(*) FROM public.llm_models WHERE id::text=$1)+(SELECT count(*) FROM public.cover_models WHERE id::text=$4))::int AS physical,(SELECT count(*) FROM public.platform_model_credential_bindings WHERE model_key=$2)::int AS active,(SELECT count(*) FROM public.model_pool_config_releases WHERE created_by=$3)::int AS releases', [id, key, actor, coverId]); report.ownedFixtureResidual = Object.values(leftovers.rows[0]).reduce((sum, value) => sum + value, 0); if (!report.baselineRestored || report.ownedFixtureResidual !== 0) { report.passed = false; process.exitCode = 1; } }
  } finally { await client.end(); }
  const root = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-pending-credentials'; fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(`${root}/cover-removal-pending-combination-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
