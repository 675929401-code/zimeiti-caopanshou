import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import COS from 'cos-nodejs-sdk-v5';
import sharp from 'sharp';

const directory = '.codex-evidence/cover-title-afterfix-e2e-20260902';
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
if (manifest.marker !== 'cover-e2e-titlefix-20260902-9c7fa12d' || manifest.providerRequests.length !== 1) throw new Error('EXACT_CANARY_REQUIRED');
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
const db = new pg.Client(runtime.ownerConnection); await db.connect();
let asset, settings;
try {
  const result = await db.query(`select f.storage_key,f.file_size,f.storage_provider,f.content_type from public.image_generation_requests r
    join public.user_files f on f.id::text=r.delivery_asset_id::text and f.user_id::text=r.user_id::text
    where r.client_idempotency_key=$1 and r.state='completed' and r.delivery_state='delivered'`, [manifest.providerRequests[0].key]);
  if (result.rows.length !== 1) throw new Error('COMPLETED_OWNED_ASSET_REQUIRED');
  asset = result.rows[0];
  if (asset.storage_provider !== 'tencent_cos' || asset.content_type !== 'image/jpeg' || Number(asset.file_size) > 30 * 1024 * 1024) throw new Error('EXPECTED_BOUNDED_JPEG_REQUIRED');
  const configRows = await db.query("select setting_key,setting_value from public.platform_settings where setting_key like 'storage_tencent_cos_%'");
  settings = Object.fromEntries(configRows.rows.map(row => [row.setting_key, row.setting_value]));
} finally { await db.end(); }
const env = dotenv.parse(await readFile('.env.local', 'utf8'));
const cos = new COS({ SecretId: settings.storage_tencent_cos_secret_id || settings.storage_tencent_cos_secretId || env.COS_SECRET_ID,
  SecretKey: settings.storage_tencent_cos_secret_key || settings.storage_tencent_cos_secretKey || env.COS_SECRET_KEY, Timeout: 30_000, MaxRetryTimes: 0 });
const result = await new Promise((resolve, reject) => cos.getObject({ Bucket: settings.storage_tencent_cos_bucket || env.COS_BUCKET,
  Region: settings.storage_tencent_cos_region || env.COS_REGION || 'ap-guangzhou', Key: asset.storage_key }, (error, data) => {
  if (error) reject(new Error(`COS_READ_STATUS_${Number(error.statusCode) || 'UNKNOWN'}`)); else resolve(data);
}));
const bytes = Buffer.from(result.Body);
if (bytes.length !== Number(asset.file_size)) throw new Error('IMAGE_SIZE_MISMATCH');
const metadata = await sharp(bytes).metadata();
await writeFile(`${directory}/direct-read-preview.jpg`, bytes);
const report = { directOwnedAssetReadOnly: true, isBrowserDownloadProof: false, status: result.statusCode, bytes: bytes.length,
  width: metadata.width, height: metadata.height, format: metadata.format, sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile(`${directory}/direct-read-preview.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
