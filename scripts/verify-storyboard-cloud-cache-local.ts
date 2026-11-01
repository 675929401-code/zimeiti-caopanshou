import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { readLocalPreviewLaunchPlan, LOCAL_PREVIEW_RUNTIME_FILE } from './start-local-data-preview.mjs';

const MARKER = '分镜工作台·系统缓存验收';
const POLICY = 'storyboard-video-72h-v1';
const PREFIX = 'videos/scoped/storyboard-delivery/';
const EVIDENCE = path.resolve('.codex-evidence/storyboard-history-20261023');
const FIXTURE = path.join(EVIDENCE, 'cloud-fixture.json');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
type Fixture = { schema: string; runId: string; ownerId: string; sourceId: string; targetId: string; sourceKey: string; targetKey?: string; modelId?: string; originalModelId?: string; fixtureModelRemoved?: boolean; createdAt: string; stage: string };
type TaskRow = Record<string, any>;

export async function main(stage = process.argv[2] || 'readonly') {
  assert.ok(['prepare', 'verify', 'expire', 'verify-cleanup', 'cleanup', 'readonly'].includes(stage), 'FIXTURE_STAGE_INVALID');
  const readonly = stage === 'readonly' || process.argv.includes('--readonly');
  const plan = await readLocalPreviewLaunchPlan(5000);
  Object.assign(process.env, plan.env);
  const runtime = JSON.parse((await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.equal(runtime.localOnly, true);
  assert.equal(runtime.ownerConnection.host, '127.0.0.1');
  assert.equal(Number(runtime.ownerConnection.port), 54322);
  assert.equal(runtime.ownerConnection.database, 'zimeiti_local');
  const rest = new URL(runtime.supabaseUrl); assert.equal(rest.hostname, '127.0.0.1'); assert.equal(rest.port, '54321');
  const db = new pg.Client({ ...runtime.ownerConnection, user: 'postgres', password: runtime.postgresPassword,
    connectionTimeoutMillis: 5000, query_timeout: 20_000, application_name: 'codex-storyboard-cloud-fixture' });
  const query = (sql: string, params: any[] = []) => db.query(sql, params);
  let fixture: Fixture | null = null;
  // Provider SDK diagnostics may contain operational URLs. This harness emits
  // only its bounded allowlisted report, never raw error stacks or URLs.
  const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
  const quiet = async <T>(operation: () => Promise<T>): Promise<T> => {
    console.log = console.warn = console.error = () => {};
    try { return await operation(); }
    finally { console.log = originalLog; console.warn = originalWarn; console.error = originalError; }
  };
  const save = async () => { assert(fixture); await fs.mkdir(EVIDENCE, { recursive: true }); await fs.writeFile(FIXTURE, JSON.stringify(fixture, null, 2) + '\n'); };
  const load = async () => {
    const value = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as Fixture;
    assert.equal(value.schema, 'storyboard-cloud-fixture.v1');
    assert.match(value.runId, /^archive-cloud-[a-f0-9-]{36}$/u);
    assert.equal(value.sourceId, value.runId + '-source'); assert.equal(value.targetId, value.runId + '-target');
    assert.match(value.ownerId, /^[a-f0-9-]{36}$/iu);
    assert.equal(value.sourceKey.split('/').slice(0, 5).join('/'), PREFIX.slice(0, -1) + '/' + hash(value.ownerId) + '/' + hash(value.sourceId));
    fixture = value; return value;
  };
  const ownedRows = async (value: Fixture) => {
    const rows = (await query(`SELECT t.id,t.user_id,t.task_label,t.status,t.completed_at,t.storage_url,t.billing_state,t.price_charged,
      t.billing_exempt,t.explicitly_free,t.client_request_id,t.storyboard_archive_expires_at,t.storyboard_archive_state,
      j.state,j.object_key,j.expires_at,j.cleanup_completed_at,j.last_error_code
      FROM video_tasks t LEFT JOIN video_history_archive_jobs j ON j.task_id=t.id
      WHERE t.id=ANY($1::text[]) ORDER BY t.id`, [[value.sourceId, value.targetId]])).rows as TaskRow[];
    for (const row of rows) {
      assert.equal(row.task_label, MARKER); assert.equal(String(row.user_id), value.ownerId);
      assert.equal(row.client_request_id, value.runId + (row.id === value.sourceId ? '-source-request' : '-target-request'));
      assert.equal(row.billing_exempt, true); assert.equal(row.explicitly_free, true); assert.equal(Number(row.price_charged), 0);
    }
    return rows;
  };
  const mutate = async (id: string, token: string, action: string, key: string, metadata: Record<string, unknown> | null = null) =>
    query('SELECT storyboard_archive_mutate($1,$2,$3,$4,NULL,$5)', [id, token, action, key, metadata]);
  try {
    await db.connect();
    const identity = (await query('SELECT current_database() db,host(inet_server_addr()) addr,inet_server_port() port')).rows[0];
    assert.deepEqual(identity, { db: 'zimeiti_local', addr: '127.0.0.1', port: 54322 });
    await query("SET lock_timeout='3s'; SET statement_timeout='15s'");
    if (readonly) {
      try { const value = await load(); const rows = await ownedRows(value);
        return { passed: true, stage: 'readonly', fixtureCount: rows.length, states: rows.map(row => ({ taskId: row.id, state: row.state, deliveryState: row.storyboard_archive_state })), generationRequests: 0, writes: 0 };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { passed: true, stage: 'readonly', fixtureCount: 0, generationRequests: 0, writes: 0 }; }
    }
    const { storageManager } = await import('../src/storage/object');
    if (stage === 'prepare') {
      try { await fs.access(FIXTURE); throw new Error('FIXTURE_ALREADY_EXISTS_USE_EXISTING_STAGES'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const template = (await query("SELECT to_jsonb(t) row FROM video_tasks t WHERE task_label LIKE '分镜工作台%' AND task_label<>$1 ORDER BY created_at DESC LIMIT 1", [MARKER])).rows[0]?.row;
      assert(template, 'STORYBOARD_TEMPLATE_REQUIRED');
      const modelTemplate = (await query('SELECT to_jsonb(m) row FROM video_models m WHERE id=$1', [template.model_id])).rows[0]?.row;
      assert.ok(modelTemplate, 'EXISTING_MODEL_TEMPLATE_REQUIRED');
      const runId = 'archive-cloud-' + crypto.randomUUID();
      fixture = { schema: 'storyboard-cloud-fixture.v1', runId, ownerId: String(template.user_id), sourceId: runId + '-source', targetId: runId + '-target',
        sourceKey: '', createdAt: new Date().toISOString(), stage: 'preparing' };
      fixture.sourceKey = PREFIX + hash(fixture.ownerId) + '/' + hash(fixture.sourceId) + '/' + crypto.randomUUID() + '.mp4';
      await save();
      const binary = process.env.FFMPEG_PATH || (await import('ffmpeg-static')).default;
      assert.ok(binary, 'FFMPEG_REQUIRED');
      const clipPath = path.join(EVIDENCE, 'cloud-fixture-0.5s.mp4');
      await promisify(execFile)(binary as string, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=160x90:r=10', '-t', '0.5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clipPath], { timeout: 20_000, windowsHide: true });
      const clip = await fs.readFile(clipPath); assert.ok(clip.length > 32 && clip.length < 1024 * 1024);
      const makeRow = (id: string, modelId: string, url: string) => ({ ...template, id, user_id: fixture!.ownerId, model_id: modelId, task_label: MARKER,
        status: 'completed', created_at: new Date().toISOString(), completed_at: new Date().toISOString(), history_hidden_at: null, source_expired_at: null,
        video_url: url, provider_result_url: url, content_url: null, thumbnail_url: null, storage_url: null, needs_proxy: true,
        task_id_external: id + '-no-provider-generation', batch_id: runId, batch_topic: MARKER, card_index: id === fixture!.sourceId ? 0 : 1,
        client_request_id: id + '-request', request_fingerprint: hash(id),
        billing_idempotency_key: id + '-exempt', billing_operation_id: null, billing_state: 'not_required', explicitly_free: true, billing_exempt: true,
        price_charged: 0, billing_price_yuan: 0, billing_cost_price_yuan: 0, billing_unit: 'per_use', billing_quantity: 1,
        billing_token_quote: null, billing_token_usage: null, billing_reserved_yuan: null, provider_poll_lease_owner: null, provider_poll_lease_until: null,
        request_snapshot: null, request_snapshot_hash: null, request_snapshot_version: null, routing_snapshot: null, routing_snapshot_hash: null, routing_snapshot_version: null,
        provider_dispatch_receipt: null, provider_submission_receipt: null, storyboard_archive_expires_at: null, storyboard_archive_state: null });
      const signedUrl = await quiet(() => storageManager.getSignedUrl(fixture!.sourceKey, { expireTime: 3600 }, 'tencent_cos'));
      const parsed = new URL(signedUrl); assert.equal(parsed.protocol, 'https:'); assert.ok(parsed.hostname.endsWith('.myqcloud.com'));
      // A disabled acceptance-only model authorizes this exact owned bucket.
      // Reusing a generation model would test the wrong download-host policy.
      const model = { ...modelTemplate, id: 'archive-cache-fixture-' + runId.slice('archive-cloud-'.length),
        name: '系统缓存验收（不参与生成）', model_name: 'archive-cache-fixture-' + runId.slice('archive-cloud-'.length),
        protocol_type: 'unified_video', api_endpoint: 'https://fixture.invalid/v1', api_key: 'local-acceptance-no-generation',
        provider: 'retired_configuration', is_active: false, is_hidden: true, api_protocol_config: { result_hostnames: [parsed.hostname] } };
      const { trustedVideoProviderResultHostname } = await import('../src/lib/video-provider-result-url');
      assert.equal(trustedVideoProviderResultHostname(signedUrl, { protocolType: model.protocol_type, apiEndpoint: model.api_endpoint, apiProtocolConfig: model.api_protocol_config }), parsed.hostname);
      fixture.modelId = model.id; fixture.originalModelId = modelTemplate.id; await save();
      const sourceRow = makeRow(fixture.sourceId, model.id, 'https://fixture.invalid/not-a-provider-result.mp4');
      // Insert source and reserve its key in one short transaction so a running
      // real worker can never claim the manually seeded source job first.
      const sourceToken = crypto.randomUUID();
      await query('BEGIN');
      try { await query('INSERT INTO video_models SELECT (jsonb_populate_record(NULL::video_models,$1::jsonb)).*', [model]);
        const visibility = (await query('SELECT is_active,is_hidden FROM video_models WHERE id=$1', [model.id])).rows[0];
        assert.deepEqual(visibility, { is_active: false, is_hidden: true }, 'FIXTURE_MUST_NOT_ENTER_MODEL_CATALOG');
        await query('INSERT INTO video_tasks SELECT (jsonb_populate_record(NULL::video_tasks,$1::jsonb)).*', [sourceRow]);
        await query("UPDATE video_history_archive_jobs SET state='leased',lease_owner=$2,lease_token=$3,lease_until=now()+interval '10 minutes' WHERE task_id=$1", [fixture.sourceId, runId, sourceToken]);
        await mutate(fixture.sourceId, sourceToken, 'prepare', fixture.sourceKey); await query('COMMIT');
      } catch (error) { await query('ROLLBACK'); throw error; }
      await quiet(() => storageManager.upload(clip, 'cache-acceptance.mp4', 'video/mp4', { providerType: 'tencent_cos', strictProvider: true,
        requireOwnershipRecord: true, category: 'video', userId: fixture!.ownerId, storyboardArchiveKey: fixture!.sourceKey,
        fileName: 'cache-acceptance.mp4', source: 'storyboard-cache-local-acceptance',
        meta: { taskId: fixture!.sourceId, archivePolicy: POLICY, retainedUntil: new Date(Date.now() + 72 * 3600000).toISOString(), fixtureRunId: runId } }));
      await mutate(fixture.sourceId, sourceToken, 'complete', fixture.sourceKey, { size: clip.length, contentType: 'video/mp4' });
      const targetRow = makeRow(fixture.targetId, model.id, signedUrl);
      await query('INSERT INTO video_tasks SELECT (jsonb_populate_record(NULL::video_tasks,$1::jsonb)).*', [targetRow]);
      fixture.stage = 'target-queued'; await save();
      return { passed: true, stage: 'prepare', sourceTaskId: fixture.sourceId, targetTaskId: fixture.targetId, testClipBytes: clip.length,
        targetQueued: true, sourceUploaded: true, generationRequests: 0, signedUrlsWrittenToEvidence: false };
    }
    const value = await load();
    const rows = await ownedRows(value);
    assert.ok(rows.length > 0 && rows.length <= 2, 'MARKED_FIXTURES_REQUIRED');
    if (stage === 'verify') assert.equal(rows.length, 2, 'BOTH_MARKED_FIXTURES_REQUIRED');
    if (stage === 'expire') {
      await query('BEGIN');
      try {
        const locked = (await query('SELECT id,task_label,user_id,client_request_id FROM video_tasks WHERE id=ANY($1::text[]) FOR UPDATE', [[value.sourceId, value.targetId]])).rows;
        assert.equal(locked.length, rows.length); for (const row of locked) { assert.equal(row.task_label, MARKER); assert.equal(String(row.user_id), value.ownerId); }
        await query("UPDATE video_tasks SET storyboard_archive_expires_at=now()-interval '1 second',storyboard_archive_state='expired' WHERE id=ANY($1::text[]) AND task_label=$2 AND user_id=$3", [[value.sourceId, value.targetId], MARKER, value.ownerId]);
        await query("UPDATE video_history_archive_jobs SET expires_at=now()-interval '1 second',next_attempt_at=now() WHERE task_id=ANY($1::text[])", [[value.sourceId, value.targetId]]);
        await query('COMMIT');
      } catch (error) { await query('ROLLBACK'); throw error; }
      value.stage = 'expired-for-cleanup'; await save(); return { passed: true, stage, fixturesExpired: rows.length, generationRequests: 0 };
    }
    const cleanup = stage === 'cleanup' || stage === 'verify-cleanup';
    const deadline = Date.now() + 120_000;
    let lastState = '';
    do {
      const current = await ownedRows(value); const target = current.find(row => row.id === value.targetId)!;
      lastState = String(target?.state || 'missing');
      if (!cleanup && target?.state === 'completed') {
        const key = String(target.object_key || ''); assert.ok(key.startsWith(PREFIX + hash(value.ownerId) + '/' + hash(value.targetId) + '/'));
        assert.notEqual(key, value.sourceKey); assert.equal(key, decodeURIComponent(String(target.storage_url).slice('object://tencent_cos/'.length)));
        const head = await quiet(() => storageManager.headStoryboardArchiveObjectOnly(key)); assert(head && head.size > 0 && head.contentType === 'video/mp4');
        const asset = (await query("SELECT user_id,meta FROM user_files WHERE storage_key=$1 AND storage_provider='tencent_cos'", [key])).rows;
        assert.equal(asset.length, 1); assert.equal(String(asset[0].user_id), value.ownerId); assert.equal(asset[0].meta.taskId, value.targetId); assert.equal(asset[0].meta.archivePolicy, POLICY);
        assert.equal(new Date(target.expires_at).getTime() - new Date(target.completed_at).getTime(), 72 * 3600000);
        value.targetKey = key; value.stage = 'runtime-copy-verified'; await save();
        return { passed: true, stage: 'verify', runtimeWorkerCopied: true, independentKey: true, ownedMetadata: true, retentionHours: 72, generationRequests: 0 };
      }
      if (cleanup && current.every(row => row.cleanup_completed_at)) {
        for (const row of current) {
          const key = row.id === value.sourceId ? value.sourceKey : value.targetKey || String(row.object_key || '');
          assert.ok(key.startsWith(PREFIX + hash(value.ownerId) + '/' + hash(String(row.id)) + '/'));
          assert.equal(await quiet(() => storageManager.headStoryboardArchiveObjectOnly(key)), null);
          assert.equal(Number((await query('SELECT count(*) n FROM user_files WHERE storage_provider=\'tencent_cos\' AND storage_key=$1', [key])).rows[0].n), 0);
          assert.equal(row.storage_url, null); assert.equal(row.billing_state, 'not_required'); assert.equal(Number(row.price_charged), 0);
        }
        await query('UPDATE video_tasks SET history_hidden_at=now() WHERE id=ANY($1::text[]) AND task_label=$2 AND user_id=$3', [[value.sourceId, value.targetId], MARKER, value.ownerId]);
        if (value.modelId && value.originalModelId && !value.fixtureModelRemoved) {
          assert.equal(value.modelId, 'archive-cache-fixture-' + value.runId.slice('archive-cloud-'.length));
          await query('BEGIN');
          try {
            const other = (await query('SELECT count(*) n FROM video_tasks WHERE model_id=$1 AND NOT(id=ANY($2::text[]))', [value.modelId, [value.sourceId, value.targetId]])).rows[0];
            assert.equal(Number(other.n), 0, 'FIXTURE_MODEL_HAS_OTHER_REFERENCES');
            await query('UPDATE video_tasks SET model_id=$2 WHERE id=ANY($1::text[]) AND task_label=$3 AND user_id=$4 AND model_id=$5', [[value.sourceId, value.targetId], value.originalModelId, MARKER, value.ownerId, value.modelId]);
            const deleted = await query("DELETE FROM video_models WHERE id=$1 AND provider='retired_configuration' AND is_active=false AND is_hidden=true AND api_endpoint='https://fixture.invalid/v1' RETURNING id", [value.modelId]);
            assert.equal(deleted.rowCount, 1, 'EXACT_HIDDEN_FIXTURE_MODEL_REQUIRED');
            await query('COMMIT'); value.fixtureModelRemoved = true;
          } catch (error) { await query('ROLLBACK'); throw error; }
        }
        value.stage = 'runtime-cleanup-verified'; await save();
        return { passed: true, stage: 'verify-cleanup', runtimeWorkerDeleted: true, cosObjectsAbsent: true, ownedMetadataAbsent: true, taskAndBillingEvidenceRetained: true, hiddenTestRecords: current.length, generationRequests: 0 };
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    } while (Date.now() < deadline);
    return { passed: false, stage, reason: 'RUNTIME_WORKER_ACCEPTANCE_TIMEOUT', queueState: lastState, generationRequests: 0 };
  } finally { await db.end(); }
}

if (process.argv[1] && /verify-storyboard-cloud-cache-local\.ts$/u.test(process.argv[1])) {
  main().then(report => { console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1; })
    .catch(error => { console.error(JSON.stringify({ passed: false, errorType: error instanceof Error ? error.name : 'UNKNOWN', reason: 'CLOUD_FIXTURE_STAGE_FAILED_REVIEW_DB_STATE', generationRequests: 0 })); process.exitCode = 1; });
}
