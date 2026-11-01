import assert from 'node:assert/strict';
import pg from 'pg';
import { toPublicModelId, publicModelDisplayName } from '../src/lib/public-model-dto.ts';

// Run only through the existing local acceptance wrapper. No credential files,
// provider calls, auth writes, migrations, or task reconciliation are performed.
export async function main(args = []) {
  let client;
  try {
    assert.equal(process.env.LOCAL_ACCEPTANCE_PREVIEW, 'true', 'LOCAL_WRAPPER_REQUIRED');
    const url = new URL(process.env.DATABASE_URL || '');
    assert.equal(url.hostname, '127.0.0.1', 'LOCAL_HOST_REQUIRED');
    assert.equal(url.port, '54322', 'LOCAL_PORT_REQUIRED');
    assert.equal(url.pathname, '/zimeiti_local', 'LOCAL_DATABASE_REQUIRED');
    const taskIds = args.filter(value => value.startsWith('--task-id=')).map(value => value.slice(10));
    assert.ok(args.every(value => value.startsWith('--task-id=') || value === '--baseline-window'), 'SUPPORTED_ARGUMENTS_REQUIRED');
    assert.ok(taskIds.length <= 2 && taskIds.every(value => /^vt_[a-f0-9]{40}$/.test(value)), 'BOUNDED_TASK_IDS_REQUIRED');
    client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'codex-ui-delivery-readonly', options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 10000, statement_timeout: 10000 });
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const identity = (await client.query("SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port, current_setting('transaction_read_only') AS read_only")).rows[0];
    assert.equal(identity.database, 'zimeiti_local');
    assert.equal(identity.port, 54322);
    assert.equal(identity.read_only, 'on');
    const schema = (await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('video_models','video_tasks')")).rows;
    const has = (table, column) => schema.some(row => row.table_name === table && row.column_name === column);
    const publicNameProjection = has('video_models', 'public_name') ? 'public_name' : 'NULL::text AS public_name';
    const reservedProjection = has('video_tasks', 'billing_reserved_yuan') ? 'billing_reserved_yuan' : 'NULL::numeric AS billing_reserved_yuan';
    const rows = (await client.query(`SELECT id, name, ${publicNameProjection}, model_name, protocol_type, supports_image_input, requires_image,
      jsonb_strip_nulls(jsonb_build_object(
        'generation_mode', api_protocol_config->'generation_mode',
        'workflow_input_mode', api_protocol_config->'workflow_input_mode',
        'min_reference_images', api_protocol_config->'min_reference_images',
        'max_reference_images', api_protocol_config->'max_reference_images',
        'supports_first_last_frame', api_protocol_config->'supports_first_last_frame',
        'resolution_options', api_protocol_config->'resolution_options',
        'default_resolution', api_protocol_config->'default_resolution'
      )) AS inputs
      FROM public.video_models WHERE id = ANY($1::text[]) ORDER BY id`, [['veo-3-1-fl-gaorui', 'veo-3-1-fast-chC']])).rows;
    const models = rows.map(row => ({ ...row, publicId: toPublicModelId('video', row.id), projectedDisplayName: publicModelDisplayName(row) }));
    const tasks = taskIds.length ? (await client.query(`SELECT id, status, billing_state,
      COALESCE(task_id_external,'') <> '' AS has_upstream_id,
      price_charged, billing_price_yuan, ${reservedProjection},
      COALESCE(provider_result_url,'') <> '' AS has_provider_result,
      COALESCE(storage_url,'') <> '' AS has_saved_result,
      CASE WHEN error_message ~ '502' THEN 'HTTP_502'
           WHEN COALESCE(error_message,'') <> '' THEN 'ERROR_PRESENT' ELSE 'NONE' END AS error_class
      FROM public.video_tasks WHERE id = ANY($1::text[]) ORDER BY id`, [taskIds])).rows : [];
    let baselineWindow;
    if (args.includes('--baseline-window')) {
      const window = ['2026-11-01T04:14:00Z', '2026-11-01T04:17:00Z'];
      const counts = [];
      for (const sql of [
        `SELECT count(*) FILTER (WHERE status='released' AND reason='terminal_or_expired' AND completed_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS released,
          count(*) FILTER (WHERE status='settled' AND completed_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS settled FROM public.llm_credit_reservations`,
        `SELECT count(*)::int AS expired_attempts FROM public.llm_request_attempts WHERE error_code='LLM_CREDIT_RESERVATION_EXPIRED' AND updated_at BETWEEN $1::timestamptz AND $2::timestamptz`,
        `SELECT count(*)::int AS expiry_events FROM public.llm_request_attempt_events WHERE event_type='reconciliation_required' AND evidence->>'reason'='credit_reservation_expired' AND created_at BETWEEN $1::timestamptz AND $2::timestamptz`,
        `SELECT count(*) FILTER (WHERE submission_error_code='VIDEO_SUBMISSION_CONFIRMATION_EXPIRED' AND completed_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS expired_video_confirmations,
          count(*) FILTER (WHERE provider_last_polled_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS last_polled_video,
          count(*) FILTER (WHERE completed_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS completed_video FROM public.video_tasks`,
        `SELECT 'credit_transactions' AS source,count(*)::int AS created FROM public.credit_transactions WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz
          UNION ALL SELECT 'cash_transactions',count(*)::int FROM public.cash_transactions WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz
          UNION ALL SELECT 'wallet_operations',count(*)::int FROM public.wallet_operations WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz
          UNION ALL SELECT 'wallet_ledger_entries',count(*)::int FROM public.wallet_ledger_entries WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz`,
      ]) counts.push((await client.query(sql, window)).rows);
      const functionHashes = (await client.query(`SELECT p.proname AS name, encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname`, [['recover_llm_credit_reservations_atomic','expire_video_submission_confirmations_atomic']])).rows;
      baselineWindow = { window, counts, functionHashes, limitation: 'Retained trace counts only; not before/after balance equality or attribution to this browser.' };
    }
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ at: new Date().toISOString(), scope: 'local-database-only', identity, models, requestedTaskCount: taskIds.length, tasks, baselineWindow, providerTerminalQueried: false, databaseWrites: 0, providerCalls: 0, credentialsExported: false }, null, 2));
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    console.log(JSON.stringify({ ok: false, scope: 'local-database-only', code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'READONLY_INSPECTION_FAILED', credentialsExported: false }));
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => undefined);
  }
}
