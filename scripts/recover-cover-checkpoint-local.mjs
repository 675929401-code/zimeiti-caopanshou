import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

const base = 'http://127.0.0.1:5000';
const dir = '.codex-evidence/cover-deterministic-text-e2e-20260902';
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
const meResponse = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
const me = await meResponse.json();
if (!meResponse.ok || me.user?.role !== 'admin' || !me.user.id) throw new Error('NORMAL_CURRENT_ADMIN_REQUIRED');
const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, 'utf8'));
const state = JSON.parse(await readFile(`${dir}/results/015-checkpoint-pending-local-state.json`, 'utf8')).result.state;
const original = manifest.providerRequests[0], pending = state.pending;
if (manifest.marker !== 'cover-e2e-layout-20260902-742c0da1' || manifest.providerRequests.length !== 1 || !pending
  || pending.clientIdempotencyKey !== original.key || pending.clientTraceId !== original.key) throw new Error('EXACT_ORIGINAL_PENDING_REQUIRED');
const body = JSON.stringify({ ...pending.payload, clientIdempotencyKey: pending.clientIdempotencyKey, clientTraceId: pending.clientTraceId });
if (createHash('sha256').update(body).digest('hex') !== original.bodyHash || pending.payload.modelId !== manifest.expectedModelId) throw new Error('ORIGINAL_PAYLOAD_HASH_REQUIRED');
const db = new pg.Client(runtime.ownerConnection); await db.connect();
async function snapshot() {
  const records = await db.query(`select record_id,state,delivery_state,delivery_asset_id,response,payload_fingerprint,created_at,updated_at
    from public.image_generation_requests where client_idempotency_key=$1 and client_trace_id=$1 and user_id=$2`, [original.key, me.user.id]);
  if (records.rows.length !== 1) throw new Error('EXACT_OWNED_RECORD_REQUIRED');
  const record = records.rows[0];
  const balance = (await db.query(`select cash_balance,credits from public.users where id=$1`, [me.user.id])).rows[0];
  const ledger = (await db.query(`select (select count(*)::int from public.cash_transactions where user_id=$1::uuid) as cash_rows,
    (select count(*)::int from public.credit_transactions where user_id=$1::uuid) as credit_rows`, [me.user.id])).rows[0];
  return { record, balance, ledger };
}
const safeSnapshot = value => ({ recordId: value.record.record_id, state: value.record.state, deliveryState: value.record.delivery_state,
  assetId: value.record.delivery_asset_id, createdAt: value.record.created_at, payloadFingerprint: value.record.payload_fingerprint,
  checkpointSchema: value.record.response?.schema || null, checkpointFingerprint: value.record.response?.resultFingerprint || null,
  responseHash: createHash('sha256').update(JSON.stringify(value.record.response)).digest('hex'), balance: value.balance, ledger: value.ledger });
async function trace() {
  const raw = await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/preview-runtime/canvas-image-generation.ndjson', 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).flatMap(line => { try { const row = JSON.parse(line); return row.traceId === original.key ? [{ at: row.at, phase: row.phase, modelId: row.modelId || null }] : []; } catch { return []; } });
}
try {
  const before = await snapshot(), beforeTrace = await trace();
  const checkpoint = before.record.response;
  if (before.record.state !== 'intent' || checkpoint?.schema !== 'image_provider_checkpoint.v1' || checkpoint.providerResult?.schema !== 'image_provider_result.v1'
    || !checkpoint.providerResult.rawUrl || !checkpoint.resultFingerprint) throw new Error('DURABLE_PROVIDER_CHECKPOINT_REQUIRED_NO_NEW_GENERATION');
  const proof = { phase: 'before-one-recovery-post', originalKey: original.key, originalBodyHash: original.bodyHash, originalProviderRequests: 1, before: safeSnapshot(before), beforeTrace };
  await writeFile(`${dir}/checkpoint-recovery-started.json`, JSON.stringify(proof, null, 2), { flag: 'wx' });
  const response = await fetch(`${base}/api/image/generate`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(180_000) });
  const data = await response.json().catch(() => ({}));
  const after = await snapshot();
  const completed = response.ok && data.success === true && data.status === 'completed' && data.idempotencyReplayed === true
    && data.traceId === original.key && data.modelIdUsed === manifest.expectedModelId && after.record.state === 'completed' && after.record.delivery_state === 'delivered'
    && after.record.delivery_asset_id === data.images?.[0]?.assetId && before.record.payload_fingerprint === after.record.payload_fingerprint
    && String(before.record.created_at) === String(after.record.created_at);
  const result = { completed, responseStatus: response.status, responseCode: data.code || null, state: data.status || data.state || null, idempotencyReplayed: data.idempotencyReplayed === true,
    originalKey: original.key, modelIdUsed: data.modelIdUsed || null, assetId: data.images?.[0]?.assetId || null, width: data.images?.[0]?.width || null, height: data.images?.[0]?.height || null,
    before: safeSnapshot(before), after: safeSnapshot(after), afterTrace: await trace(), recoveryPosts: 1,
    additionalSupplierRequests: completed ? 0 : null, supplierRequestEvidence: 'Pre-existing validated provider checkpoint and server idempotencyReplayed path; no direct supplier billing telemetry',
    balanceUnchanged: JSON.stringify(before.balance) === JSON.stringify(after.balance), ledgerCountsUnchanged: JSON.stringify(before.ledger) === JSON.stringify(after.ledger) };
  await writeFile(`${dir}/checkpoint-recovery-result.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  if (!completed) process.exitCode = 1;
} finally { await db.end(); }
