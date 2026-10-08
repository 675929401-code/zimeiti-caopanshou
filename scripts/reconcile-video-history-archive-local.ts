import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import pg from 'pg';

const root = process.cwd();
const runtimePath = path.resolve(
  process.env.LOCAL_DATA_RUNTIME_PATH
    || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json',
);
const maxBatchesArgument = process.argv.find((argument) => argument.startsWith('--max-batches='));
const maxBatches = Math.max(1, Math.min(100, Number(maxBatchesArgument?.split('=', 2)[1] || 16)));

type LocalRuntime = {
  localOnly: boolean;
  host: string;
  databasePort: number;
  databaseName: string;
  databaseUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  anonKey: string;
};

async function queueSnapshot(client: pg.Client) {
  const [states, assets] = await Promise.all([
    client.query<{ state: string; count: number }>(
      `SELECT state,count(*)::int AS count
         FROM public.video_history_archive_jobs
        GROUP BY state ORDER BY state`,
    ),
    client.query<{ count: number; bytes: string }>(
      `SELECT count(*)::int AS count,coalesce(sum(file_size),0)::text AS bytes
         FROM public.user_files
        WHERE storage_provider='tencent_cos'
          AND storage_key LIKE 'videos/generated/%'`,
    ),
  ]);
  return { states: states.rows, generatedVideoAssets: assets.rows[0] };
}

async function main() {
  dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
  const runtime = JSON.parse((await readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, '')) as LocalRuntime;
  assert.equal(runtime.localOnly, true, 'LOCAL_RUNTIME_REQUIRED');
  assert.equal(runtime.host, '127.0.0.1', 'LOCAL_HOST_REQUIRED');
  assert.equal(Number(runtime.databasePort), 54322, 'LOCAL_DATABASE_PORT_REQUIRED');
  assert.equal(runtime.databaseName, 'zimeiti_local', 'LOCAL_DATABASE_NAME_REQUIRED');
  assert.ok(runtime.supabaseUrl && runtime.serviceRoleKey && runtime.anonKey, 'LOCAL_SUPABASE_RUNTIME_REQUIRED');

  process.env.COZE_SUPABASE_URL = runtime.supabaseUrl;
  process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = runtime.serviceRoleKey;
  process.env.COZE_SUPABASE_ANON_KEY = runtime.anonKey;
  process.env.NEXT_PUBLIC_SUPABASE_URL = runtime.supabaseUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = runtime.anonKey;
  process.env.DATABASE_URL = runtime.databaseUrl;
  process.env.APP_LOCAL_DATA_ONLY = 'true';

  const db = new pg.Client({
    connectionString: runtime.databaseUrl,
    application_name: 'codex-local-video-history-archive-reconcile',
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
  });
  await db.connect();
  const before = await queueSnapshot(db);
  const { reconcileVideoHistoryArchiveBatch } = await import('../src/lib/video-history-archive-worker');
  let claimed = 0;
  let batches = 0;
  let unavailable = false;
  try {
    for (; batches < maxBatches; batches += 1) {
      const result = await reconcileVideoHistoryArchiveBatch();
      unavailable ||= result.unavailable;
      claimed += result.claimed;
      if (result.unavailable || result.claimed === 0) break;
    }
    const after = await queueSnapshot(db);
    console.log(JSON.stringify({
      ok: !unavailable,
      target: '127.0.0.1:54322/zimeiti_local',
      batches,
      claimed,
      before,
      after,
      generatedAssetsAdded: after.generatedVideoAssets.count - before.generatedVideoAssets.count,
      generatedBytesAdded: Number(after.generatedVideoAssets.bytes) - Number(before.generatedVideoAssets.bytes),
      paidGenerationRequests: 0,
      billingMutations: 0,
      credentialsPrinted: false,
    }, null, 2));
    if (unavailable) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error instanceof Error ? error.message.slice(0, 240) : 'UNKNOWN_ERROR',
    target: '127.0.0.1:54322/zimeiti_local',
    paidGenerationRequests: 0,
    billingMutations: 0,
    credentialsPrinted: false,
  }, null, 2));
  process.exitCode = 1;
});
