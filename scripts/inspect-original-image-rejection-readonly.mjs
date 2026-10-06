import fs from 'node:fs/promises';
import pg from 'pg';
import { LOCAL_PREVIEW_RUNTIME_FILE, validateLocalPreviewRuntime } from './start-local-data-preview.mjs';

const runtime = JSON.parse(await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8'));
validateLocalPreviewRuntime(runtime);
const connection = runtime.ownerConnection;
if (connection.host !== '127.0.0.1' || connection.port !== 54322 || connection.database !== 'zimeiti_local') throw new Error('LOCAL_TARGET_REQUIRED');
const client = new pg.Client(connection);
const report = { inspectedAt: new Date().toISOString(), localOnly: true, databaseWrites: 0, providerRequests: 0, originalKey: 'h3img-mtkdh613-r3haaj' };
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10s'");
  const result = await client.query('SELECT record_id,state,response IS NULL AS response_is_null,delivery_state,delivery_asset_id IS NOT NULL AS has_asset,created_at,updated_at FROM public.image_generation_requests WHERE client_idempotency_key=$1', [report.originalKey]);
  report.rowCount = result.rowCount;
  report.records = result.rows;
  report.unchangedLegacyUnknown = result.rowCount === 1 && result.rows[0].state === 'failed_unknown' && result.rows[0].response_is_null && !result.rows[0].has_asset;
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw new Error(`READONLY_CHECK_FAILED:${/^[A-Z0-9_]{1,60}$/u.test(String(error?.code)) ? error.code : 'REDACTED'}`);
} finally { await client.end(); }
const output = '.codex-evidence/image-reference-rejection-20260903/original-request-readonly.json';
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ rowCount: report.rowCount, unchangedLegacyUnknown: report.unchangedLegacyUnknown, databaseWrites: 0, providerRequests: 0, output }));
