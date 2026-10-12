import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);
const LOCAL_RUNTIME = 'F:/tools/zimeiti-local-data/scripts/runtime.mjs';

function assertLocal(plan) {
  const database = new URL(plan.env.DATABASE_URL);
  if (database.hostname !== '127.0.0.1' || database.port !== '54322' || database.pathname !== '/zimeiti_local'
    || plan.env.COZE_SUPABASE_URL !== 'http://127.0.0.1:54321') throw new Error('LOCAL_DATA_TARGET_REJECTED');
}

export async function probeLocalData(plan) {
  assertLocal(plan);
  const client = new pg.Client({ connectionString: plan.env.DATABASE_URL, connectionTimeoutMillis: 2500, query_timeout: 2500 });
  const checks = await Promise.allSettled([
    (async () => {
      try { await client.connect(); await client.query('SELECT id FROM public.users LIMIT 0'); }
      finally { await client.end().catch(() => {}); }
    })(),
    (async () => {
      const response = await fetch('http://127.0.0.1:54321/rest/v1/users?select=id&limit=0', {
        headers: { apikey: plan.env.COZE_SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${plan.env.COZE_SUPABASE_SERVICE_ROLE_KEY}` },
        signal: AbortSignal.timeout(3000), redirect: 'error',
      });
      if (!response.ok || !Array.isArray(await response.json())) throw new Error('LOCAL_REST_UNAVAILABLE');
    })(),
  ]);
  return checks.every(result => result.status === 'fulfilled');
}

/** Restore the existing local cluster only; never initialize, migrate, or use production. */
export async function ensureLocalDataReady(plan, { restore = false } = {}, dependencies = {}) {
  assertLocal(plan);
  const probe = dependencies.probe || probeLocalData;
  if (await probe(plan)) return { ready: true, restored: false };
  if (!restore) throw new Error('LOCAL_DATA_UNAVAILABLE');
  let restoreCommandReportedFailure = false;
  try {
    const launch = dependencies.restore || (() => run(plan.executable, [LOCAL_RUNTIME, 'start'], {
      cwd: plan.cwd, windowsHide: true, shell: false, timeout: 45_000, maxBuffer: 512 * 1024,
    }));
    await launch();
  } catch { restoreCommandReportedFailure = true; }
  if (!await probe(plan)) throw new Error(restoreCommandReportedFailure ? 'LOCAL_DATA_RESTORE_FAILED' : 'LOCAL_DATA_UNAVAILABLE_AFTER_RESTORE');
  if (restoreCommandReportedFailure) return { ready: true, restored: true, restoreCommandReportedFailure: true };
  return { ready: true, restored: true };
}
