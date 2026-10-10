import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

const root = process.cwd();
const runtimePath = path.resolve(
  process.env.LOCAL_DATA_RUNTIME_PATH
    || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json',
);

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

  const { purgeExpiredUserContentBatch } = await import('../src/lib/user-content-retention-worker');
  const result = await purgeExpiredUserContentBatch();
  console.log(JSON.stringify({
    ok: true,
    target: '127.0.0.1:54322/zimeiti_local',
    result,
    policy: {
      rawVideoExtractionHistory: false,
      extractionContentDays: 10,
      conversationContentDays: 30,
      agentAndLongTermMemoryProtected: true,
    },
    paidGenerationRequests: 0,
    billingMutations: 0,
    credentialsPrinted: false,
  }, null, 2));
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
