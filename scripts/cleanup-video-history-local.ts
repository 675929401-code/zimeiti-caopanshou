import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { isCurrentDigitalHumanTask } from '../src/lib/digital-human-task';
import { isVideoHistoryExplicitlyHidden, isVideoHistoryProtected, videoHistoryTerminalTime, type VideoHistorySurface } from '../src/lib/video-history-policy';

const TARGET = '127.0.0.1:54322/zimeiti_local';
const SCHEMA = 'local-video-history-cleanup.v1';
type Decision = 'candidate' | 'protected' | 'already_hidden' | 'after_cutoff' | 'invalid_time';
type Row = {
  id: string; user_id: string; task_label: string | null; status: string | null; billing_state: string | null;
  created_at: string | null; completed_at: string | null; history_hidden_at: string | null; source_expired_at: string | null;
};
type PlannedRow = Row & { surface: VideoHistorySurface; decision: Decision };
type PlanBody = { schema: typeof SCHEMA; target: typeof TARGET; cutoff: string; records: PlannedRow[]; counts: Record<Decision, number> };
type Plan = PlanBody & { digest: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const classify = (row: Row): VideoHistorySurface | null => {
  const label = String(row.task_label || '');
  if (isCurrentDigitalHumanTask(row as unknown as Record<string, unknown>) || label.startsWith('digital-human:')) return null;
  return label.startsWith('分镜工作台') ? 'storyboard-workbench' : 'video-page';
};
const decision = (row: Row, cutoff: number): Decision => {
  if (isVideoHistoryExplicitlyHidden(row)) return 'already_hidden';
  if (isVideoHistoryProtected(row)) return 'protected';
  const created = Date.parse(row.created_at || '');
  const terminal = videoHistoryTerminalTime(row);
  if (!Number.isFinite(created) || !Number.isFinite(terminal)) return 'invalid_time';
  return created <= cutoff && terminal <= cutoff ? 'candidate' : 'after_cutoff';
};
const originalKeys: (keyof Row)[] = ['id', 'user_id', 'task_label', 'status', 'billing_state', 'created_at', 'completed_at', 'source_expired_at'];
const sameOriginal = (planned: PlannedRow, current: Row) => originalKeys.every((key) => planned[key] === current[key]);
const columns = `id::text AS id,user_id::text AS user_id,task_label,status,billing_state,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
  to_char(history_hidden_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS history_hidden_at,
  to_char(source_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_expired_at`;

async function localClient() {
  const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
    || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
  const runtime = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.equal(runtime.localOnly, true, 'LOCAL_ONLY_RUNTIME_REQUIRED');
  assert.equal(runtime.host, '127.0.0.1', 'LOCAL_RUNTIME_HOST_REQUIRED');
  const api = new URL(runtime.supabaseUrl);
  assert.equal(api.origin, 'http://127.0.0.1:54321', 'LOCAL_API_REQUIRED');
  assert.equal(api.username + api.password, '', 'API_URL_CREDENTIALS_FORBIDDEN');
  const database = new URL(runtime.databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol), 'LOCAL_DATABASE_PROTOCOL_REQUIRED');
  assert.equal(database.hostname, '127.0.0.1', 'LOCAL_DATABASE_HOST_REQUIRED');
  assert.equal(database.port, '54322', 'LOCAL_DATABASE_PORT_REQUIRED');
  assert.equal(database.pathname, '/zimeiti_local', 'LOCAL_DATABASE_NAME_REQUIRED');
  assert.equal(database.search, '', 'DATABASE_CONNECTION_OVERRIDES_FORBIDDEN');
  const client = new Client({ connectionString: runtime.databaseUrl, connectionTimeoutMillis: 10000, query_timeout: 30000, application_name: 'local_video_history_cleanup' });
  await client.connect();
  const identity = await client.query('SELECT current_database() AS name');
  assert.equal(identity.rows[0]?.name, 'zimeiti_local', 'CONNECTED_DATABASE_IDENTITY_MISMATCH');
  return client;
}

async function writeNew(file: string, value: unknown) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

async function createPlan(client: Client, output: string) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const clock = await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cutoff");
    const cutoff = String(clock.rows[0].cutoff);
    const result = await client.query<Row>(`SELECT ${columns} FROM public.video_tasks WHERE task_label IS NULL OR task_label NOT LIKE 'digital-human:%' ORDER BY user_id,id`);
    const counts: Record<Decision, number> = { candidate: 0, protected: 0, already_hidden: 0, after_cutoff: 0, invalid_time: 0 };
    const records: PlannedRow[] = [];
    for (const row of result.rows) {
      const surface = classify(row);
      if (!surface) continue;
      const verdict = decision(row, Date.parse(cutoff));
      counts[verdict]++;
      records.push({ ...row, surface, decision: verdict });
    }
    const body: PlanBody = { schema: SCHEMA, target: TARGET, cutoff, records, counts };
    const plan: Plan = { ...body, digest: digest(body) };
    await client.query('COMMIT');
    await writeNew(output, plan);
    console.log(JSON.stringify({ mode: 'plan', target: TARGET, cutoff, digest: plan.digest, counts, accountCount: new Set(records.map((row) => row.user_id)).size, planFile: path.resolve(output), databaseWrites: 0 }));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function applyPlan(client: Client, planFile: string, expectedDigest: string, receiptFile: string) {
  const parsed = JSON.parse((await fs.readFile(planFile, 'utf8')).replace(/^\uFEFF/u, '')) as Plan;
  const { digest: savedDigest, ...body } = parsed;
  assert.equal(savedDigest, expectedDigest, 'PLAN_DIGEST_ARGUMENT_MISMATCH');
  assert.equal(digest(body), expectedDigest, 'PLAN_CONTENT_DIGEST_MISMATCH');
  assert.equal(body.schema, SCHEMA, 'PLAN_SCHEMA_MISMATCH');
  assert.equal(body.target, TARGET, 'PLAN_TARGET_MISMATCH');
  const cutoff = Date.parse(body.cutoff);
  assert.ok(Number.isFinite(cutoff), 'PLAN_CUTOFF_INVALID');
  const clock = await client.query('SELECT clock_timestamp() AS now');
  assert.ok(cutoff <= new Date(clock.rows[0].now).getTime(), 'PLAN_CUTOFF_FUTURE');
  const candidates = body.records.filter((row) => row.decision === 'candidate');
  assert.equal(new Set(candidates.map((row) => row.id)).size, candidates.length, 'DUPLICATE_PLAN_IDS');
  for (const row of candidates) {
    assert.equal(classify(row), row.surface, 'PLAN_SURFACE_MISMATCH');
    assert.equal(decision(row, cutoff), 'candidate', 'PLAN_CANDIDATE_INVALID');
  }
  const results: { id: string; user_id: string; result: string }[] = [];
  let changed = 0; let alreadyApplied = 0; let skipped = 0; let protectedCount = body.counts.protected;
  let failure = '';
  try {
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const batch = candidates.slice(offset, offset + 100);
      await client.query('BEGIN');
      try {
        const current = await client.query<Row>(`SELECT ${columns} FROM public.video_tasks WHERE id::text=ANY($1::text[]) ORDER BY id FOR UPDATE`, [batch.map((row) => row.id)]);
        const lookup = new Map(current.rows.map((row) => [row.id, row]));
        const batchResults: typeof results = [];
        let batchChanged = 0; let batchAlready = 0; let batchSkipped = 0; let batchProtected = 0;
        const updatedIds: string[] = [];
        for (const planned of batch) {
          const row = lookup.get(planned.id);
          let verdict = 'original_changed';
          if (!row) verdict = 'missing';
          else if (isVideoHistoryProtected(row)) { verdict = 'protected'; batchProtected++; }
          else if (sameOriginal(planned, row) && isVideoHistoryExplicitlyHidden(row)) { verdict = 'already_applied'; batchAlready++; }
          else if (sameOriginal(planned, row) && row.history_hidden_at === planned.history_hidden_at && classify(row) === planned.surface && decision(row, cutoff) === 'candidate') {
            // Row lock + complete original-image comparison makes this update conditional.
            // A one-millisecond difference is retained even by browser Date parsing.
            const update = await client.query(`UPDATE public.video_tasks SET history_hidden_at=CASE
              WHEN source_expired_at IS NOT NULL AND date_trunc('milliseconds',source_expired_at)=date_trunc('milliseconds',clock_timestamp())
                THEN clock_timestamp()+interval '1 millisecond' ELSE clock_timestamp() END
              WHERE id::text=$1 AND user_id::text=$2 RETURNING id::text AS id`, [row.id, row.user_id]);
            assert.equal(update.rowCount, 1, 'UPDATE_ROWCOUNT_MISMATCH');
            verdict = 'changed'; batchChanged++; updatedIds.push(row.id);
          }
          if (!['changed', 'already_applied'].includes(verdict)) batchSkipped++;
          batchResults.push({ id: planned.id, user_id: planned.user_id, result: verdict });
        }
        if (updatedIds.length) {
          const confirmed = await client.query<Row>(`SELECT ${columns} FROM public.video_tasks WHERE id::text=ANY($1::text[])`, [updatedIds]);
          assert.equal(confirmed.rows.length, updatedIds.length, 'READBACK_COUNT_MISMATCH');
          assert.ok(confirmed.rows.every((row) => isVideoHistoryExplicitlyHidden(row) && sameOriginal(batch.find((item) => item.id === row.id)!, row)), 'READBACK_MISMATCH');
        }
        await client.query('COMMIT');
        changed += batchChanged; alreadyApplied += batchAlready; skipped += batchSkipped; protectedCount += batchProtected;
        results.push(...batchResults);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } catch { failure = 'APPLY_BATCH_FAILED_RETRY_SAME_PLAN'; }
  const receipt = { schema: 'local-video-history-cleanup-receipt.v1', target: TARGET, planDigest: expectedDigest, cutoff: body.cutoff, changed, alreadyApplied, skipped, protectedCount, failure: failure || null, taskDeletes: 0, billingMutations: 0, results };
  await writeNew(receiptFile, receipt);
  console.log(JSON.stringify({ ...receipt, results: undefined, receiptFile: path.resolve(receiptFile) }));
  if (failure) throw Error(failure);
}

async function main() {
  const mode = process.argv[2];
  const argument = (name: string) => process.argv.slice(3).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (mode === 'self-test') {
    const row: Row = { id: 'test', user_id: 'owner', task_label: '分镜工作台', status: 'completed', billing_state: 'settled', created_at: '2026-10-18T00:00:00.000000Z', completed_at: '2026-10-18T00:01:00.000000Z', history_hidden_at: null, source_expired_at: null };
    assert.equal(decision(row, Date.parse('2026-10-18T01:00:00Z')), 'candidate');
    assert.equal(decision({ ...row, billing_state: 'usage_pending' }, Date.now()), 'protected');
    assert.equal(classify({ ...row, task_label: 'digital-human:photo' }), null);
    assert.equal(decision({ ...row, source_expired_at: row.completed_at, history_hidden_at: row.completed_at }, Date.parse('2026-10-18T01:00:00Z')), 'candidate');
    assert.equal(digest({ a: 1 }), digest({ a: 1 }));
    assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
    console.log('PASS: local-only cleanup classification, billing protection, source-expiry distinction and digest; no DB or network');
    return;
  }
  assert.ok(mode === 'plan' || mode === 'apply', 'MODE_MUST_BE_PLAN_OR_APPLY');
  if (mode === 'plan') assert.ok(argument('out'), 'PLAN_OUT_REQUIRED');
  if (mode === 'apply') assert.ok(argument('plan') && /^[a-f0-9]{64}$/.test(argument('digest') || '') && argument('receipt'), 'APPLY_PLAN_DIGEST_RECEIPT_REQUIRED');
  const client = await localClient();
  try {
    if (mode === 'plan') await createPlan(client, argument('out')!);
    else await applyPlan(client, argument('plan')!, argument('digest')!, argument('receipt')!);
  } finally { await client.end(); }
}
void main().catch((error: unknown) => {
  const details = error as { code?: unknown; message?: unknown };
  const safe = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : '';
  console.error(JSON.stringify({ ok: false, code: safe(details.message) || safe(details.code) || 'LOCAL_VIDEO_HISTORY_CLEANUP_FAILED', target: TARGET, credentialsPrinted: false }));
  process.exitCode = 1;
});
