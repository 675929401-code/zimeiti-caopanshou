import fs from 'node:fs/promises';
import { validateLocalPreviewRuntime, LOCAL_PREVIEW_RUNTIME_FILE } from './start-local-data-preview.mjs';

// Read-only PostgREST schema checks, with keys confined to request headers.
const runtime = JSON.parse(await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8'));
const local = validateLocalPreviewRuntime(runtime);
if (local.supabaseUrl !== 'http://127.0.0.1:54321') throw new Error('EXACT_LOCAL_REST_REQUIRED');
const headers = { apikey: local.serviceRoleKey, Authorization: `Bearer ${local.serviceRoleKey}` };
const tables = [
  ['image_model_validations', 'validation_id,model_id,configuration_hash,model_snapshot_hash,epoch,user_id,client_idempotency_key,client_trace_id,image_record_id,payload_fingerprint,state,quoted_price_yuan,cost_price_yuan,asset_id,evidence'],
  ['image_model_legacy_baselines', 'model_id,model_snapshot_hash,configuration_hash,evidence_ref,established_at'],
  ['image_generation_requests', 'record_id,user_id,state,response,delivery_state,delivery_asset_id,payload_fingerprint'],
];
const expectedRpcs = ['read_image_model_publication_state', 'read_image_model_validation_model', 'claim_image_model_validation', 'record_image_model_validation_outcome', 'publish_image_model_validation'];
const report = { at: new Date().toISOString(), target: 'http://127.0.0.1:54321', method: 'GET', tables: [], rpcs: [], databaseWrites: 0, providerRequests: 0 };
for (const [table, columns] of tables) {
  const response = await fetch(`${local.supabaseUrl}/rest/v1/${table}?${new URLSearchParams({ select: columns, limit: '0' })}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  report.tables.push({ table, status: response.status, code: typeof value?.code === 'string' ? value.code.replace(/[^A-Z0-9_]/g, '') : null, selectedColumns: columns.split(','), rowsReturned: Array.isArray(value) ? value.length : null });
}
const response = await fetch(`${local.supabaseUrl}/rest/v1/`, { headers: { ...headers, Accept: 'application/openapi+json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
report.openapiStatus = response.status;
const schema = response.ok ? await response.json() : {};
report.rpcs = expectedRpcs.map(name => ({ name, visible: Boolean(schema.paths?.[`/rpc/${name}`]) }));
report.passed = report.tables.every(item => item.status === 200 && item.rowsReturned === 0) && report.openapiStatus === 200 && report.rpcs.every(item => item.visible);
const directory = '.codex-evidence/image-hidden-real-e2e-20260903'; await fs.mkdir(directory, { recursive: true });
const output = `${directory}/rest-schema-${Date.now()}.json`; await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: report.passed, tables: report.tables.map(({ table, status, code }) => ({ table, status, code })), rpcsVisible: report.rpcs.filter(item => item.visible).length, databaseWrites: 0, providerRequests: 0, output }));
process.exitCode = report.passed ? 0 : 1;
