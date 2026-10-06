import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { isLikelyMojibake, repairLikelyMojibake } from '@/lib/display-normalization';

const out = path.resolve('.codex-evidence/admin-activity-20260902');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const textMetrics = (value: unknown) => {
  const text = typeof value === 'string' ? value : '';
  const repaired = repairLikelyMojibake(text);
  return {
    present: text.length > 0,
    suspicious: isLikelyMojibake(text),
    changed: text !== repaired,
    originalReplacementCount: (text.match(/\uFFFD/gu) || []).length,
    repairedReplacementCount: (repaired.match(/\uFFFD/gu) || []).length,
    textSha256: digest(text),
  };
};

async function main() {
  const client = getSupabaseAdminClient();
  const sources = [
    { table: 'credit_transactions', fields: ['description'], select: 'description,type,created_at' },
    { table: 'cash_transactions', fields: ['description'], select: 'description,type,created_at' },
    { table: 'system_logs', fields: ['message', 'source'], select: 'message,source,created_at' },
    { table: 'diagnostic_logs', fields: ['description', 'admin_notes'], select: 'description,admin_notes,created_at' },
  ];
  const tables = await Promise.all(sources.map(async source => {
    const { data, error } = await client.from(source.table).select(source.select).order('created_at', { ascending: false }).limit(100);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const metrics = rows.flatMap(row => source.fields.map(field => ({ field, ...textMetrics(row[field]) })));
    return {
      table: source.table,
      errorCode: error?.code || null,
      rowCount: rows.length,
      fieldCount: metrics.filter(entry => entry.present).length,
      suspiciousFields: metrics.filter(entry => entry.suspicious).length,
      repairableFields: metrics.filter(entry => entry.changed).length,
      fieldsWithNewReplacementCharacters: metrics.filter(entry => entry.repairedReplacementCount > entry.originalReplacementCount).length,
      suspiciousMetrics: metrics.filter(entry => entry.suspicious),
    };
  }));

  const base = 'http://127.0.0.1:5000';
  const sessionResponse = await fetch(`${base}/api/auth/dev-session`, { headers: { 'x-local-workbench': 'ai-creation-studio-local' }, signal: AbortSignal.timeout(20_000) });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string } };
  const api: Array<Record<string, unknown>> = [{ route: '/api/auth/dev-session', status: sessionResponse.status, authenticated: Boolean(sessionResponse.ok && session.token) }];
  if (sessionResponse.ok && session.token) {
    const routes = [
      { route: '/api/admin/user-transactions?type=recharge&pageSize=20', label: '/api/admin/user-transactions?type=recharge&pageSize=20' },
      { route: '/api/admin/diagnostic-logs?pageSize=10', label: '/api/admin/diagnostic-logs?pageSize=10' },
    ];
    if (session.user?.id) {
      for (const type of ['credits','cash']) routes.push({ route: `/api/admin/user-transactions?userId=${encodeURIComponent(session.user.id)}&type=${type}&pageSize=20`, label: `/api/admin/user-transactions?userId=[current-admin]&type=${type}&pageSize=20` });
    }
    if (process.argv.includes('--verify-logs')) routes.push({ route: '/api/health?logs=true&limit=20', label: '/api/health?logs=true&limit=20' });
    for (const {route, label} of routes) {
      const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(30_000) });
      const payload = await response.json() as Record<string, unknown>;
      const nestedData = payload.data as { transactions?: unknown[] } | undefined;
      const rows = (Array.isArray(payload.transactions) ? payload.transactions : Array.isArray(payload.logs) ? payload.logs : Array.isArray(payload.data) ? payload.data : Array.isArray(nestedData?.transactions) ? nestedData.transactions : []) as Array<Record<string, unknown>>;
      const metrics = rows.flatMap(row => ['description','message','source'].map(field => textMetrics(row[field]))).filter(entry => entry.present);
      api.push({ route: label, status: response.status, rowCount: rows.length, suspiciousFields: metrics.filter(entry => entry.suspicious).length, logsContractPresent: Array.isArray(payload.logs), checksPresent: Array.isArray(payload.checks) });
    }
  }
  const result = { observedAt: new Date().toISOString(), mode: 'read-only', rawTextPersisted: false, identitiesPersisted: false, tableSamples: tables, api };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, process.argv.includes('--verify-logs') ? 'after.json' : 'before.json'), JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify({ ...result, tableSamples: tables.map(({ suspiciousMetrics, ...summary }) => {
    void suspiciousMetrics;
    return summary;
  }) }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ auditFailed: true, errorName: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
