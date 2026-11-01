import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import ts from 'typescript';
import { confirmLocalModelPendingDatabase } from './lib/model-pending-local-verification-guard.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownerRole = 'SET LOCAL ROLE zimeiti_owner', serviceRole = 'SET LOCAL ROLE service_role';

// The same orchestration is exercised by --self-test without opening a socket.
// Real execution intentionally lets B bypass the publication advisory lock: it
// represents a privileged maintenance writer that inserts after A's existence
// check, while PostgreSQL's unique-index transaction lock seals the write race.
export async function executeOwnedRace({ a, b, monitor, stage, publish, fixture, baseline, journal, pollLimit = 100, pollDelayMs = 100 }) {
  let aBegun = false, bBegun = false, bCommitAttempted = false, bCommitted = false;
  let revision = null, pendingPublish = null, publishOutcome = null, failure = null;
  const record = async phase => journal({ phase, modelKey: fixture.key, credentialRef: fixture.ref, expectedRevision: revision,
    candidateId: fixture.candidateId || null, requestId: fixture.requestId, actorId: fixture.actorId,
    aPid: a.processID, bPid: b.processID, bCommitAttempted, bCommitted });
  try {
    await a.query('BEGIN'); aBegun = true; await a.query(serviceRole);
    const candidate = await stage(a); fixture.candidateId = candidate.id;
    assert.equal(await baseline.read(monitor), baseline.fingerprint, 'BASELINE_CHANGED_BEFORE_OWNED_INSERT');
    await b.query('BEGIN'); bBegun = true; await b.query(ownerRole);
    const inserted = await b.query('INSERT INTO public.platform_model_credential_bindings(credential_ref,model_key,secret_value,updated_by) VALUES($1,$2,$3,$4) RETURNING revision', [fixture.ref, fixture.key, fixture.secret, fixture.actorId]);
    revision = inserted.rows[0].revision; assert.ok(revision, 'B_REVISION_REQUIRED');
    await record('prepared-before-publish');
    pendingPublish = publish(a, candidate).then(result => (publishOutcome = { ok: true, result }), error => (publishOutcome = { ok: false, error }));
    let observed = false;
    for (let index = 0; index < pollLimit; index++) {
      if (publishOutcome) {
        const raw = String(publishOutcome.error?.message || '');
        const code = /^(?:PLATFORM_CONFIGURATION|MODEL_POOL)_[A-Z0-9_]+$/u.test(raw) ? raw : 'UNEXPECTED_EARLY_RESULT';
        const early = new Error('PUBLISH_ENDED_BEFORE_EXPECTED_RACE:' + (publishOutcome.ok ? 'SUCCESS' : code));
        early.code = publishOutcome.error?.code;
        throw early;
      }
      const activity = await monitor.query('SELECT wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [a.processID]);
      const row = activity.rows[0];
      if (row?.wait_event_type === 'Lock' && row.wait_event === 'transactionid' && row.blockers?.includes(b.processID)) { observed = true; break; }
      await delay(pollDelayMs);
    }
    assert.ok(observed, 'A_DID_NOT_WAIT_FOR_B_UNIQUE_TRANSACTION');
    await record('A-waits-for-B-transactionid');
    bCommitAttempted = true; await record('before-B-commit');
    await b.query('COMMIT'); bBegun = false; bCommitted = true; await record('B-committed');
    publishOutcome = await pendingPublish;
    assert.equal(publishOutcome.ok, false, 'A_MUST_NOT_OVERWRITE_OWNER_INSERT');
    assert.ok(String(publishOutcome.error?.message || '').includes('PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'), 'A_EXPECTED_CREDENTIAL_CONFLICT');
    await a.query('ROLLBACK'); aBegun = false; await record('A-rolled-back');
    const active = await monitor.query('SELECT credential_ref,model_key,revision,secret_value=$3 AS owned_secret_matches FROM public.platform_model_credential_bindings WHERE model_key=$1 AND credential_ref=$2', [fixture.key, fixture.ref, fixture.secret]);
    assert.equal(active.rows.length, 1); assert.equal(active.rows[0].revision, revision); assert.equal(active.rows[0].owned_secret_matches, true);
    const now = await baseline.read(monitor); assert.equal(now, baseline.fingerprint, 'CURRENT_BASELINE_CHANGED');
    const remnants = await monitor.query('SELECT (SELECT count(*) FROM public.model_pool_config_releases WHERE id=$1)::int AS candidates,(SELECT count(*) FROM public.platform_model_pending_credentials WHERE release_id=$1)::int AS pending,(SELECT count(*) FROM public.platform_model_mutation_receipts WHERE actor_id=$2 AND request_id=$3)::int AS receipts', [candidate.id, fixture.actorId, fixture.requestId]);
    assert.deepEqual(remnants.rows[0], { candidates: 0, pending: 0, receipts: 0 });
    await record('verified-conflict-baseline-intact');
  } catch (error) { failure = error; }
  finally {
    // Cancel the exact A backend before queuing rollback if it is still blocked.
    if (aBegun && pendingPublish && !publishOutcome) {
      try { await monitor.query('SELECT pg_cancel_backend($1)', [a.processID]); } catch { /* rollback/connection close remains mandatory */ }
      try { publishOutcome = await pendingPublish; } catch { /* promise is normally settled to a tagged outcome */ }
    }
    if (aBegun) { try { await a.query('ROLLBACK'); aBegun = false; } catch { failure ||= Error('A_ROLLBACK_UNCONFIRMED'); } }
    if (bBegun) { try { await b.query('ROLLBACK'); bBegun = false; } catch { failure ||= Error('B_ROLLBACK_UNCONFIRMED'); } }
    // COMMIT acknowledgement can be lost. After any commit attempt, exact CAS
    // cleanup is necessary; no secret is required to identify the owned row.
    if (bCommitAttempted && revision) {
      try {
        assert.equal(aBegun, false, 'A_ROLLBACK_REQUIRED_BEFORE_CLEANUP');
        await b.query('BEGIN'); bBegun = true; await b.query(ownerRole);
        const removed = await b.query('DELETE FROM public.platform_model_credential_bindings WHERE model_key=$1 AND credential_ref=$2 AND revision=$3 RETURNING model_key', [fixture.key, fixture.ref, revision]);
        if (removed.rowCount === 0) {
          const remaining = await b.query('SELECT revision FROM public.platform_model_credential_bindings WHERE model_key=$1 OR credential_ref=$2', [fixture.key, fixture.ref]);
          assert.equal(remaining.rows.length, 0, 'OWNED_ROW_CHANGED_CLEANUP_REFUSED');
        }
        await b.query('COMMIT'); bBegun = false;
        const residual = await monitor.query('SELECT count(*)::int AS count FROM public.platform_model_credential_bindings WHERE model_key=$1 OR credential_ref=$2', [fixture.key, fixture.ref]);
        assert.equal(residual.rows[0].count, 0, 'OWNED_FIXTURE_RESIDUAL');
        await record('cleanup-CAS-verified-zero-residual');
      } catch (error) {
        failure ||= error;
        if (bBegun) { try { await b.query('ROLLBACK'); bBegun = false; } catch { /* journal records unconfirmed cleanup */ } }
        await record('cleanup-refused-or-unconfirmed');
      }
    }
    if (aBegun || bBegun) failure ||= Error('TRANSACTION_ROLLBACK_UNCONFIRMED');
  }
  if (failure) throw failure;
  return { passed: true, candidateId: fixture.candidateId, waitForBTransactionVerified: true, activeOwnerInsertPreserved: true, aTransactionRolledBack: true, ownedFixtureResidual: 0 };
}

async function selfTest() {
  const events = [], journal = [], fixture = { key: 'llm_models:fixture', ref: 'secret://platform-model/llm_models/fixture', secret: 'fixture-secret-only', actorId: randomUUID(), requestId: randomUUID() };
  let releasePublish, inserted = false, committed = false, removed = false, aRollback = false;
  const a = { processID: 101, async query(sql) { events.push(`A:${sql}`); if (sql === 'ROLLBACK') aRollback = true; return { rows: [] }; } };
  const b = { processID: 102, async query(sql, values) {
    events.push(`B:${sql}`);
    if (sql.startsWith('INSERT')) { inserted = true; return { rows: [{ revision: 'owned-revision' }] }; }
    if (sql === 'COMMIT' && inserted && !committed) { committed = true; releasePublish(); }
    if (sql.startsWith('DELETE')) { assert.equal(aRollback, true); assert.deepEqual(values, [fixture.key, fixture.ref, 'owned-revision']); removed = true; return { rows: [{ model_key: fixture.key }], rowCount: 1 }; }
    return { rows: [] };
  } };
  const monitor = { async query(sql, values) {
    if (sql.includes('pg_stat_activity')) { assert.deepEqual(values, [101]); return { rows: [{ wait_event_type: 'Lock', wait_event: 'transactionid', blockers: [102] }] }; }
    if (sql.includes('owned_secret_matches')) return { rows: [{ revision: 'owned-revision', owned_secret_matches: true }] };
    if (sql.includes(' AS candidates')) return { rows: [{ candidates: 0, pending: 0, receipts: 0 }] };
    if (sql.includes('count(*)')) return { rows: [{ count: removed ? 0 : 1 }] };
    return { rows: [] };
  } };
  const result = await executeOwnedRace({ a, b, monitor, fixture, stage: async () => ({ id: randomUUID() }), publish: async () => new Promise((_resolve, reject) => { releasePublish = () => reject(Error('PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT')); }), baseline: { fingerprint: 'unchanged', read: async () => 'unchanged' }, journal: async entry => { journal.push(entry); assert.ok(!JSON.stringify(entry).includes(fixture.secret)); }, pollDelayMs: 0 });
  assert.equal(result.passed, true); assert.ok(events.indexOf('A:ROLLBACK') < events.findIndex(event => event.startsWith('B:DELETE'))); assert.ok(journal.some(entry => entry.phase === 'A-waits-for-B-transactionid')); assert.equal(journal.at(-1).phase, 'cleanup-CAS-verified-zero-residual');
  for (const mode of ['wrong-blocker', 'changed-cleanup']) {
    const negativeEvents = [], negativeJournal = [];
    let settle, commits = 0;
    const negativeFixture = { ...fixture, candidateId: null, requestId: randomUUID() };
    const negativeA = { processID: 201, async query(sql) { negativeEvents.push(`A:${sql}`); return { rows: [] }; } };
    const negativeB = { processID: 202, async query(sql, values) {
      negativeEvents.push(`B:${sql}`);
      if (sql.startsWith('INSERT')) return { rows: [{ revision: 'owned-revision' }] };
      if (sql === 'COMMIT') { commits++; settle(); }
      if (sql.startsWith('DELETE')) { assert.deepEqual(values, [fixture.key, fixture.ref, 'owned-revision']); return { rows: [], rowCount: 0 }; }
      if (sql.startsWith('SELECT revision')) return { rows: [{ revision: 'someone-else-revision' }] };
      return { rows: [] };
    } };
    const negativeMonitor = { async query(sql) {
      if (sql.includes('pg_stat_activity')) return { rows: [{ wait_event_type: 'Lock', wait_event: 'transactionid', blockers: mode === 'wrong-blocker' ? [999] : [202] }] };
      if (sql.includes('pg_cancel_backend')) { negativeEvents.push('cancel-A'); settle(); return { rows: [] }; }
      if (sql.includes('owned_secret_matches')) return { rows: [{ revision: 'owned-revision', owned_secret_matches: true }] };
      if (sql.includes(' AS candidates')) return { rows: [{ candidates: 0, pending: 0, receipts: 0 }] };
      return { rows: [] };
    } };
    await assert.rejects(() => executeOwnedRace({ a: negativeA, b: negativeB, monitor: negativeMonitor, fixture: negativeFixture, stage: async () => ({ id: randomUUID() }), publish: async () => new Promise((_resolve, reject) => { settle = () => reject(Error('PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT')); }), baseline: { fingerprint: 'base', read: async () => 'base' }, journal: async entry => negativeJournal.push(entry), pollLimit: 1, pollDelayMs: 0 }), error => String(error.message).includes(mode === 'wrong-blocker' ? 'A_DID_NOT_WAIT_FOR_B_UNIQUE_TRANSACTION' : 'OWNED_ROW_CHANGED_CLEANUP_REFUSED'));
    if (mode === 'wrong-blocker') { assert.equal(commits, 0); assert.ok(negativeEvents.indexOf('cancel-A') < negativeEvents.indexOf('A:ROLLBACK')); assert.ok(negativeEvents.indexOf('A:ROLLBACK') < negativeEvents.indexOf('B:ROLLBACK')); }
    else { assert.equal(commits, 1); assert.equal(negativeJournal.at(-1).phase, 'cleanup-refused-or-unconfirmed'); assert.equal(negativeEvents.filter(event => event.startsWith('B:DELETE')).length, 1); }
  }
  console.log(JSON.stringify({ passed: true, mode: 'zero-network-self-test', orchestrationChecks: ['exact backend and blocker PID', 'transactionid wait before B commit', 'A conflict rollback before cleanup', 'key/ref/revision CAS delete', 'journal contains no secret','wrong blocker timeout cancels A and rolls A back before B without commit','changed owned row cleanup is refused without broader retry'], actualDatabaseConnections: 0, actualCommittedWrites: 0 }));
}

async function executeReal() {
  const expectedFingerprint = process.env.MODEL_PENDING_PG_FINGERPRINT || '';
  const backupPath = process.env.MODEL_PENDING_BACKUP_RECEIPT_PATH || '', backupSha = process.env.MODEL_PENDING_BACKUP_RECEIPT_SHA256 || '';
  if (process.env.MODEL_PENDING_RACE_APPROVED !== '1' || !process.env.DATABASE_URL || !/^[a-f0-9]{64}$/u.test(expectedFingerprint) || !backupPath || !/^[a-f0-9]{64}$/u.test(backupSha)) throw Error('CONTROLLED_RACE_AUTHORIZATION_REQUIRED');
  const require = createRequire(import.meta.url), mod = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/platform-configuration-contract.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { require, module: mod, exports: mod.exports, URL });
  const contract = mod.exports, runId = randomUUID(), actorId = randomUUID(), id = randomUUID(), requestId = randomUUID();
  const fixture = { key: `llm_models:${id}`, ref: `secret://platform-model/llm_models/${id}`, secret: `fixture-owner-only-${randomUUID()}`, actorId, requestId };
  const a = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: `pending-race-A-${runId}` });
  const b = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: `pending-race-B-${runId}` });
  const monitor = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: `pending-race-monitor-${runId}` });
  const root = path.resolve('.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-pending-credentials'); fs.mkdirSync(root, { recursive: true });
  const journalPath = path.join(root, `owner-race-${runId}.json`);
  let result = null;
  try {
    await Promise.all([a.connect(), b.connect(), monitor.connect()]);
    await monitor.query('SET default_transaction_read_only=on');
    const capability = (await monitor.query("SELECT pg_has_role(current_user,'pg_read_all_stats','USAGE') AS can_read_all_stats")).rows[0];
    assert.equal(capability.can_read_all_stats, true, 'READONLY_MONITOR_STATS_VISIBILITY_REQUIRED');
    for (const client of [a, b]) { await client.query("SET statement_timeout='30s'"); await client.query("SET lock_timeout='20s'"); }
    await confirmLocalModelPendingDatabase(monitor, process.env.DATABASE_URL, { expectedFingerprint, backupReceiptPath: backupPath, backupReceiptSha256: backupSha, backupArchiveSha256: process.env.MODEL_PENDING_BACKUP_ARCHIVE_SHA256 });
    const readBaseline = async client => digest((await client.query("SELECT to_jsonb(r) AS release FROM public.model_pool_config_releases r WHERE is_current AND status='published'")).rows);
    const baselineFingerprint = await readBaseline(monitor);
    const baseline = (await monitor.query("SELECT * FROM public.model_pool_config_releases WHERE is_current AND status='published'")).rows[0]; assert.ok(baseline, 'PUBLISHED_BASELINE_REQUIRED');
    const template = baseline.snapshot.models.find(model => model.kind === 'agent' && model.configuration.legacyTable === 'llm_models'); assert.ok(template, 'LLM_TEMPLATE_REQUIRED');
    const entry = { ...structuredClone(template), id: `llm:${id}`, name: 'Owned rollback race fixture', modelName: 'fixture-no-provider', endpoint: 'https://fixture.invalid/v1', credentialRef: fixture.ref, configuration: { ...template.configuration, legacyTable: 'llm_models', legacyId: id } };
    const snapshot = contract.normalizeModelPoolSnapshot({ ...baseline.snapshot, models: [...baseline.snapshot.models, entry] }), snapshotSha = contract.configurationSha256(snapshot);
    const journal = async state => { const value = { schema: 'model-pending-owner-race-journal.v1', runId, databaseFingerprint: expectedFingerprint, backupReceiptSha256: backupSha, baselineFingerprint, ...state }; const temporary = `${journalPath}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); const descriptor = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } fs.renameSync(temporary, journalPath); };
    await journal({ phase: 'authorized-before-transactions', modelKey: fixture.key, credentialRef: fixture.ref, expectedRevision: null, requestId, actorId });
    result = await executeOwnedRace({ a, b, monitor, fixture, baseline: { fingerprint: baselineFingerprint, read: readBaseline }, journal,
      stage: async client => (await client.query('SELECT public.stage_model_pool_candidate_with_credentials_atomic($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10::jsonb) AS value', [actorId, requestId, JSON.stringify({ method: 'POST', modelType: 'text', targetId: id, endpoint: entry.endpoint, secret: 'stage-fixture-pending-value' }), JSON.stringify(snapshot), snapshotSha, JSON.stringify({ ok: true, schema: 'owned-race-fixture' }), 'validated', 'Owned rollback-only race fixture', baseline.id, JSON.stringify([{ model_key: fixture.key, credential_ref: fixture.ref, secret_value: 'stage-fixture-pending-value' }])])).rows[0].value,
      publish: async (client, candidate) => (await client.query('SELECT public.publish_platform_configuration_release_atomic($1,$2,$3,$4,$5,$6) AS value', ['model-pool', candidate.id, actorId, candidate.snapshot_sha256, baseline.id, baseline.snapshot_sha256])).rows[0].value });
  } finally { await Promise.allSettled([a.end(), b.end(), monitor.end()]); }
  console.log(JSON.stringify({ ...result, actualConcurrentTransactions: true, realProviderCalls: 0, journalPath }));
}

try {
  if (process.argv.includes('--self-test')) await selfTest();
  else if (process.argv.includes('--execute-owned-race-fixture')) await executeReal();
  else console.log(JSON.stringify({ mode: 'plan', databaseConnections: 0, requiredFlag: '--execute-owned-race-fixture', requirements: ['MODEL_PENDING_RACE_APPROVED=1','DATABASE_URL from controlled environment','MODEL_PENDING_PG_FINGERPRINT: canonical readDatabaseTargetIdentity fingerprint','MODEL_PENDING_BACKUP_RECEIPT_PATH','MODEL_PENDING_BACKUP_RECEIPT_SHA256'], identityContract: 'scripts/lib/database-target-identity.mjs; database zimeiti_local and actual/configured loopback required', backupContract: 'original pre-migration-database-backup-receipt.v1 with restore.status verified, original receipt bytes SHA and actual archive SHA; existing local-backup-result.json may point to that original receipt', mutationBoundary: 'A always rolls back; B commits one random owned fixture binding, then exact key/ref/revision CAS cleanup with readback; changed row is never deleted' }, null, 2));
} catch (error) { console.error(JSON.stringify({ passed: false, safeFailureCode: /^[A-Z][A-Z0-9_]{2,100}$/u.test(String(error.message)) ? error.message : 'OWNER_RACE_FAILED_REVIEW_JOURNAL', postgresCode: /^[0-9A-Z]{5}$/u.test(String(error.code)) ? error.code : undefined })); process.exitCode = 1; }
