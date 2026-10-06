#!/usr/bin/env node
// Default: schema metadata only, GET OpenAPI + GET table with limit=0.
// Explicit --audit-user-id-values mode reads only users.id and emits counts.
// Never POST an RPC or call app generation/status routes; never emit row values.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
const contract = JSON.parse(fs.readFileSync(path.join(root, 'deploy/policies/database-contract.v1.json'), 'utf8'));
const addedVideoColumns = ['client_request_id', 'request_fingerprint', 'billing_price_yuan', 'billing_cost_price_yuan', 'billing_unit', 'billing_quantity', 'billing_state', 'billing_operation_id', 'billing_idempotency_key', 'provider_result_url', 'explicitly_free', 'billing_exempt', 'submission_error_code'];
const addedPaymentColumns = ['provider_trade_order_id', 'provider_transaction_id', 'provider_paid_amount', 'provider_confirmed_at'];
const tableNames = ['users', 'credit_transactions', 'cash_transactions', 'payment_orders', 'user_files', 'video_tasks', 'wallet_operations', 'wallet_ledger_entries', 'image_generation_requests', 'cash_debt_records', 'password_audit_log', 'extraction_attempts', 'extraction_attempt_reconciliation_audit', 'llm_request_attempts', 'llm_request_attempt_events'];
const baselineNames = new Set(['users', 'credit_transactions', 'cash_transactions', 'payment_orders', 'user_files', 'video_tasks']);
const tables = tableNames.map(name => {
  const entry = contract.tables.find(table => table.name === name);
  if (!entry) throw new Error('MISSING_LOCAL_TABLE_CONTRACT');
  // Voice authorization is unrelated to this media/cash migration bundle.
  const columns = entry.columns.filter(column => name !== 'users' || column !== 'voice_clone_authorized');
  const baselineColumns = !baselineNames.has(name) ? [] : columns.filter(column =>
    !(name === 'video_tasks' && addedVideoColumns.includes(column)) &&
    !(name === 'payment_orders' && addedPaymentColumns.includes(column)));
  return { name, columns, baselineColumns };
});
tables.push({ name: 'autodl_h3_settlements', columns: ['video_task_internal_id', 'user_id', 'model_id', 'stable_asset_url', 'price_yuan', 'charged_yuan'], baselineColumns: ['video_task_internal_id', 'user_id', 'model_id', 'stable_asset_url', 'price_yuan', 'charged_yuan'] });
const rpcNames = ['apply_wallet_operation_atomic', 'claim_image_generation_request', 'save_image_generation_request', 'finalize_image_generation_delivery', 'reserve_video_generation_task_atomic', 'bind_video_provider_task_atomic', 'fail_video_generation_submission_atomic', 'finalize_video_generation_task_atomic', 'fulfill_payment_order_with_evidence_atomic', 'claim_extraction_attempt_atomic', 'finalize_extraction_attempt_atomic', 'list_extraction_attempts_for_reconciliation', 'reconcile_extraction_attempt_atomic', 'claim_llm_request_attempt_atomic', 'mark_llm_request_provider_started_atomic', 'finalize_llm_request_attempt_atomic', 'reconcile_llm_request_attempt_atomic'];

function emitResult(result) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const outputArg = process.argv.find(argument => argument.startsWith('--output='));
  if (outputArg) {
    const outputPath = path.resolve(root, outputArg.slice('--output='.length));
    const evidenceRoot = `${path.join(root, '.codex-evidence')}${path.sep}`;
    if (!outputPath.startsWith(evidenceRoot)) throw new Error('OUTPUT_MUST_BE_LOCAL_EVIDENCE');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, { flag: 'wx' });
  }
  console.log(json);
}

function collectNames(document, item, result = new Set(), seen = new Set()) {
  if (!item || typeof item !== 'object') return result;
  if (typeof item.name === 'string') result.add(item.name);
  if (item.properties) Object.keys(item.properties).forEach(name => result.add(name));
  if (typeof item.$ref === 'string' && item.$ref.startsWith('#/') && !seen.has(item.$ref)) {
    seen.add(item.$ref);
    const target = item.$ref.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((value, key) => value?.[key], document);
    collectNames(document, target, result, seen);
  }
  Object.values(item).forEach(value => collectNames(document, value, result, seen));
  return result;
}

async function main() {
  const base = process.env.COZE_SUPABASE_URL?.trim();
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!base || !key) throw new Error('SERVICE_ROLE_SCHEMA_PROBE_NOT_CONFIGURED');
  const rest = new URL('rest/v1/', base.endsWith('/') ? base : `${base}/`);
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'public' };
  if (process.argv.includes('--audit-user-id-values')) {
    // Explicitly requested identity compatibility audit. Values remain in RAM;
    // only aggregate counts are emitted. Stable keyset pages avoid offset drift.
    let cursor = null;
    let scanned = 0;
    let compatible = 0;
    let unproven = 0;
    let complete = false;
    let pages = 0;
    const pageLimit = 50;
    const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    while (pages < pageLimit) {
      const url = new URL('users', rest);
      url.searchParams.set('select', 'id');
      url.searchParams.set('order', 'id.asc');
      url.searchParams.set('limit', '500');
      if (cursor !== null) url.searchParams.set('id', `gt.${cursor}`);
      const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
      const rows = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(rows)) throw new Error('USER_ID_READONLY_AUDIT_UNAVAILABLE');
      pages += 1;
      if (!rows.length) { complete = true; break; }
      for (const row of rows) {
        scanned += 1;
        if (typeof row.id === 'string' && canonicalUuid.test(row.id)) compatible += 1;
        else unproven += 1;
      }
      const nextCursor = rows.at(-1)?.id;
      if (typeof nextCursor !== 'string' || nextCursor === cursor) throw new Error('USER_ID_AUDIT_PAGINATION_INVALID');
      cursor = nextCursor;
    }
    emitResult({ readOnly: true, method: 'GET_ONLY_USERS_ID_KEYSET_PAGES', observedAt: new Date().toISOString(), scanned, uuidConvertibleCanonicalCount: compatible, nonCanonicalNeedsDatabaseCastCheckCount: unproven, confirmedIncompatibleCount: unproven === 0 ? 0 : null, complete, pages, rowLimit: pageLimit * 500, identifiersEmitted: false, limitation: 'Read-only pages are not a database snapshot; concurrent registrations can change totals. Canonical UUIDs are provably castable; any other shape requires database-side cast checking.' });
    return;
  }
  const openApiResponse = await fetch(rest, { method: 'GET', headers: { ...headers, Accept: 'application/openapi+json' }, signal: AbortSignal.timeout(15000) });
  if (!openApiResponse.ok) throw new Error('OPENAPI_METADATA_UNAVAILABLE');
  const document = await openApiResponse.json();
  async function probe(name, columns) {
    const url = new URL(name, rest);
    url.searchParams.set('select', columns.join(','));
    url.searchParams.set('limit', '0');
    const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && Array.isArray(body) && body.length === 0, httpStatus: response.status, errorCode: response.ok ? null : (typeof body?.code === 'string' ? body.code : 'UNAVAILABLE') };
  }
  const tableResults = [];
  for (const table of tables) {
    const properties = document.definitions?.[table.name]?.properties || document.components?.schemas?.[table.name]?.properties || {};
    const missingColumns = table.columns.filter(column => !(column in properties));
    const baselineMissingColumns = table.baselineColumns.filter(column => !(column in properties));
    const postApply = await probe(table.name, table.columns);
    const baseline = table.baselineColumns.length ? await probe(table.name, table.baselineColumns) : null;
    const columnTypes = Object.fromEntries(table.columns.filter(column => column in properties).map(column => [column, { type: properties[column].type ?? null, format: properties[column].format ?? null }]));
    tableResults.push({ name: table.name, columns: table.columns, baselineColumns: table.baselineColumns, baseline, postApply, missingColumns, baselineMissingColumns, columnTypes });
  }
  const rpcResults = rpcNames.map(name => {
    const entry = contract.rpcs.find(rpc => rpc.name === name);
    if (!entry) throw new Error('MISSING_LOCAL_RPC_CONTRACT');
    const rpc = document.paths?.[`/rpc/${name}`]?.post;
    const names = collectNames(document, rpc);
    return { name, present: Boolean(rpc), requiredArguments: entry.arguments, missingArguments: entry.arguments.filter(argument => !names.has(argument)) };
  });
  const legacyPaymentRpcExposed = Boolean(document.paths?.['/rpc/fulfill_payment_order_atomic']);
  const baselineReady = tableResults.every(table => !table.baseline || (table.baseline.ok && table.baselineMissingColumns.length === 0));
  const postApplySchemaReady = tableResults.every(table => table.postApply.ok && table.missingColumns.length === 0) && rpcResults.every(rpc => rpc.present && rpc.missingArguments.length === 0) && !legacyPaymentRpcExposed;
  const result = { readOnly: true, method: 'GET_ONLY_LIMIT_ZERO', observedAt: new Date().toISOString(), targetHost: rest.host, baselineReady, postApplySchemaReady, legacyPaymentRpcExposed, tables: tableResults, rpcs: rpcResults, notVerified: ['pg_catalog constraints, indexes, function bodies and ACLs', 'migration execution', 'provider call and result', 'balance mutations and real billing', 'historical task settlement'] };
  emitResult(result);
  if (process.argv.includes('--require-ready') && !postApplySchemaReady) process.exitCode = 2;
}

main().catch(() => { console.error('MEDIA_WALLET_READONLY_SCHEMA_PROBE_FAILED (sensitive details suppressed)'); process.exitCode = 1; });
