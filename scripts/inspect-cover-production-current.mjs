import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

const afterfix = process.argv.includes('--title-afterfix');
const deterministic = process.argv.includes('--deterministic-text');
const directory = deterministic ? '.codex-evidence/cover-deterministic-text-e2e-20260902' : afterfix ? '.codex-evidence/cover-title-afterfix-e2e-20260902' : '.codex-evidence/cover-production-e2e-20260902';
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
if (manifest.marker !== (deterministic ? 'cover-e2e-layout-20260902-742c0da1' : afterfix ? 'cover-e2e-titlefix-20260902-9c7fa12d' : 'cover-e2e-20260902-e2560a1c') || manifest.providerRequests.length !== 1) throw new Error('EXACT_CANARY_REQUIRED');
const key = manifest.providerRequests[0].key;
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
const db = new pg.Client(runtime.ownerConnection); await db.connect();
try {
  await db.query('begin read only');
  const attempts = await db.query(`select record_id,state,delivery_state,delivery_asset_id,created_at,updated_at,
    response is not null as has_response, response->>'schema' as checkpoint_schema
    from public.image_generation_requests where client_idempotency_key=$1 and client_trace_id=$1`, [key]);
  const assetId = attempts.rows[0]?.delivery_asset_id;
  const assetIds = assetId ? [assetId] : [];
  if (deterministic) {
    const events = (await readFile(`${directory}/network.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const event of events) if (event.type === 'response' && event.path === '/api/cover/render' && event.status === 200 && event.data?.sourceAssetId === assetId && event.data?.assetId) assetIds.push(event.data.assetId);
  }
  const assets = assetIds.length ? await db.query(`select id,file_size,content_type,storage_provider,
    storage_key is not null as has_storage_key from public.user_files where id=any($1::uuid[]) order by created_at`, [assetIds]) : { rows: [] };
  const history = assetIds.length ? await db.query(`select id,agent_id,role,created_at from public.conversation_messages
    where id like 'image_workbench_%' and content like any($1::text[]) order by created_at`, [assetIds.map(id => `%${id}%`)]) : { rows: [] };
  const balance = assetId ? await db.query(`select u.cash_balance,u.credits from public.users u
    join public.user_files f on f.user_id::text=u.id where f.id=$1`, [assetId]) : { rows: [] };
  await db.query('rollback');
  const result = { observedAt: new Date().toISOString(), normalSessionGenerationKey: key, expectedModelId: manifest.expectedModelId,
    attempts: attempts.rows, assets: assets.rows, history: history.rows, balance: balance.rows };
  await writeFile(`${directory}/local-state-${Date.now()}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await db.end(); }
