import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resolveProviderSecret } from '../src/lib/provider-secret';

async function main() {
const here = path.resolve('../运行日志/模型手动接入闭环-20261015-2b48');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(new URL(runtime.supabaseUrl).origin, 'http://127.0.0.1:54321');
const targets = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'];
const origins = ['https://n.lconai.com', 'https://gaorui.cc', 'https://token.secure-skill.com'];
const credentials: Record<string, { table: string; value: string; auth: string }> = {};
for (const table of ['llm_models', 'video_models', 'cover_models']) {
  const url = new URL(`/rest/v1/${table}`, runtime.supabaseUrl);
  url.searchParams.set('select', 'id,api_endpoint,api_key,api_protocol_config');
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) continue;
  const rows = await response.json();
  for (const row of rows) {
    let origin: string;
    try { origin = new URL(row.api_endpoint).origin; } catch { continue; }
    if (!origins.includes(origin) || credentials[origin] || !row.api_key) continue;
    const config = row.api_protocol_config && typeof row.api_protocol_config === 'object' ? row.api_protocol_config : {};
    credentials[origin] = { table, value: row.api_key, auth: config.auth_scheme === 'x-api-key' ? 'x-api-key' : 'bearer' };
  }
}
const results = [];
for (const origin of origins) {
  const configured = credentials[origin];
  if (!configured) { results.push({ origin, status: 'NO_SAME_ORIGIN_CONTROLLED_CREDENTIAL' }); continue; }
  let secret = '';
  try { secret = resolveProviderSecret(configured.value); }
  catch { results.push({ origin, status: 'CONTROLLED_CREDENTIAL_UNAVAILABLE', credentialTable: configured.table }); continue; }
  assert.ok(secret.length >= 8);
  const headers: Record<string, string> = configured.auth === 'x-api-key' ? { 'x-api-key': secret } : { Authorization: `Bearer ${secret}` };
  try {
    const response = await fetch(origin + '/v1/models', { headers, method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000) });
    const payload = await response.json().catch(() => null);
    const ids = payload && Array.isArray(payload.data) ? payload.data.map((entry: {id?: unknown}) => String(entry.id || '')).filter(Boolean) : [];
    results.push({ origin, path: '/v1/models', method: 'GET', authScheme: configured.auth, credentialTable: configured.table, httpStatus: response.status, openAiCatalogShape: Boolean(payload && Array.isArray(payload.data)), catalogCount: ids.length, targetModelsAdvertised: targets.filter(model => ids.includes(model)), status: response.ok && ids.length ? 'AUTHENTICATED_CATALOG_READ' : 'CATALOG_NOT_VERIFIED', inferenceRequests: 0 });
  } catch { results.push({ origin, status: 'CATALOG_NETWORK_FAILURE', inferenceRequests: 0 }); }
  finally { secret = ''; }
}
const report = { schemaVersion: 'three_provider_readonly_catalogs.v1', observedAt: new Date().toISOString(), results, databaseWrites: 0, inferenceRequests: 0, limitation: '鉴权目录只证明该受控账户此刻可读目录，不证明每个型号可调用，也不证明Anthropic认证可互换；没有生成请求或自动重试。' };
const encoded = JSON.stringify(report, null, 2) + '\n';
assert.ok(!encoded.includes(runtime.serviceRoleKey));
await fs.writeFile(path.join(here, '三平台鉴权目录只读核验.json'), encoded, { flag: 'wx' });
console.log(encoded);
}
main().catch(() => { console.error('CONTROLLED_CATALOG_READ_FAILED'); process.exitCode = 1; });
