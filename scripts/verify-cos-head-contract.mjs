import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import dotenv from 'dotenv';
import COS from 'cos-nodejs-sdk-v5';

const directory = '.codex-evidence/cos-head-contract-20260902';
await mkdir(directory, { recursive: true });
const compiled = ts.transpileModule(await readFile('src/storage/object/providers/tencent-cos.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = { exports: {}, Buffer, Date };
vm.runInNewContext(compiled, context);
const Provider = context.exports.TencentCOSProvider;
if (process.argv.includes('--live-before') || process.argv.includes('--live-after')) {
  const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
  if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
  const db = new pg.Client(runtime.ownerConnection); await db.connect();
  let settings;
  try {
    const result = await db.query("select setting_key,setting_value from public.platform_settings where setting_key like 'storage_tencent_cos_%'");
    settings = Object.fromEntries(result.rows.map(row => [row.setting_key, row.setting_value]));
  } finally { await db.end(); }
  const env = dotenv.parse(await readFile('.env.local', 'utf8'));
  const config = {
    SecretId: settings.storage_tencent_cos_secret_id || settings.storage_tencent_cos_secretId || env.COS_SECRET_ID,
    SecretKey: settings.storage_tencent_cos_secret_key || settings.storage_tencent_cos_secretKey || env.COS_SECRET_KEY,
  };
  const bucket = settings.storage_tencent_cos_bucket || env.COS_BUCKET;
  const region = settings.storage_tencent_cos_region || env.COS_REGION || 'ap-guangzhou';
  if (!config.SecretId || !config.SecretKey || !bucket) throw new Error('COS_CONFIG_REQUIRED');
  const cos = new COS({ ...config, Timeout: 30_000, MaxRetryTimes: 0 });
  const key = 'short-drama/final/2026/09/02/sdj_73884a982e262c2348e78d6d355765ec.mp4';
  const raw = await new Promise((resolve, reject) => cos.headObject({ Bucket: bucket, Region: region, Key: key }, (error, value) => {
    if (error) reject(new Error(`COS_HEAD_STATUS_${Number(error.statusCode) || 'UNKNOWN'}`)); else resolve(value);
  }));
  const before = process.argv.includes('--live-before');
  const result = { readOnly: true, method: 'HEAD', status: raw.statusCode, sdkResultKeys: Object.keys(raw), headerKeys: Object.keys(raw.headers || {}),
    contentLengthHeader: raw.headers?.['content-length'], contentTypeHeader: raw.headers?.['content-type'],
    legacyContentLengthPresent: Object.hasOwn(raw, 'ContentLength'), expectedBytes: 3961842 };
  assert.equal(Number(result.contentLengthHeader), result.expectedBytes);
  if (!before) {
    const provider = new Provider(); provider.cos = cos; provider.bucket = bucket; provider.region = region;
    result.providerHead = await provider.head(key);
    assert.equal(result.providerHead?.size, result.expectedBytes);
    assert.equal(result.providerHead?.contentType, 'video/mp4');
    assert.ok(Number.isFinite(result.providerHead?.lastModified.getTime()));
  }
  await writeFile(`${directory}/${before ? 'before' : 'after'}-live.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} else {
  const provider = new Provider();
  let payload, failure = null, calls = 0;
  provider.cos = { headObject(_options, callback) { calls++; callback(failure, payload); } };
  payload = { headers: { 'content-length': '3961842', 'content-type': 'video/mp4', 'last-modified': 'Wed, 02 Sep 2026 14:57:19 GMT' } };
  let result = await provider.head('fixture'); assert.equal(result.size, 3961842); assert.equal(result.contentType, 'video/mp4'); assert.equal(result.lastModified.toISOString(), '2026-09-02T14:57:19.000Z');
  payload = { headers: { 'Content-Length': '0', 'Content-Type': 'image/png', 'Last-Modified': 'Wed, 02 Sep 2026 14:57:19 GMT' } };
  result = await provider.head('fixture'); assert.equal(result.size, 0); assert.equal(result.contentType, 'image/png');
  payload = { ContentLength: '12', ContentType: 'image/jpeg', LastModified: 'Wed, 02 Sep 2026 14:57:19 GMT' };
  assert.equal((await provider.head('fixture')).size, 12);
  for (const size of [undefined, '', 'garbage', '12oops', '-1', '1.5', '9007199254740992']) {
    payload = { headers: { 'content-length': size } }; assert.equal(await provider.head('fixture'), null);
  }
  payload = { headers: { 'content-length': '3', 'last-modified': 'bad date' } };
  result = await provider.head('fixture'); assert.equal(result.size, 3); assert.equal(result.lastModified.getTime(), 0);
  failure = new Error('synthetic denied'); assert.equal(await provider.head('fixture'), null);
  console.log(JSON.stringify({ passed: true, actualProviderHeadFixture: true, cases: calls, upstreamCalls: 0 }));
}
