import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

if (!process.argv.includes('--execute-readonly')) {
  console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, generationRequests: 0, methods: ['GET', 'HEAD'] }));
  process.exit(0);
}

const evidenceRoot = '.codex-evidence/omni-edit-input-bridge-20260902';
const runRoot = '.codex-evidence/video-all-models-real-e2e-20260902/all13-real-canary-20260902';
const cfg = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).origin, 'http://127.0.0.1:54321');
const modelIds = ['minimax-h3-autodl-hosted', 'minimax-h3-autodl-hosted-lightx2v-v5'];
const report = { at: new Date().toISOString(), generationRequests: 0, databaseWrites: 0, urlsPersisted: false, sources: [] };
let firstOwner;

for (const modelId of modelIds) {
  const result = JSON.parse(await fs.readFile(`${runRoot}/${modelId}/result.json`, 'utf8'));
  assert.equal(result.state, 'completed');
  const id = result.business.id;
  const endpoint = new URL('/rest/v1/video_tasks', cfg.supabaseUrl);
  endpoint.searchParams.set('select', 'id,user_id,model_id,status,provider_result_url,duration_seconds');
  endpoint.searchParams.set('id', `eq.${id}`);
  const response = await fetch(endpoint, { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` }, signal: AbortSignal.timeout(15000) });
  const rows = await response.json();
  assert.ok(response.ok && rows.length === 1, 'Expected one locally completed source task');
  const row = rows[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.model_id, modelId);
  firstOwner ??= row.user_id;
  assert.equal(row.user_id, firstOwner, 'Source tasks must have the same owner');
  const input = new URL(row.provider_result_url);
  assert.equal(input.protocol, 'https:');
  assert.equal(input.username, ''); assert.equal(input.password, ''); assert.equal(input.port, '');
  assert.match(input.hostname, /^[a-z0-9][a-z0-9-]{0,62}\.cos\.[a-z0-9-]+\.myqcloud\.com$/u, 'Expected the previously completed provider COS output');
  const source = { taskId: id, modelId, persistentState: row.status, durationSeconds: row.duration_seconds, sameOwner: true,
    host: input.hostname, urlSha256: createHash('sha256').update(input.toString()).digest('hex'), hasQuery: input.search.length > 0,
    probes: [] };
  for (const method of ['HEAD', 'GET']) {
    try {
      const media = await fetch(input, { method, headers: method === 'GET' ? { Range: 'bytes=0-1023' } : {}, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      source.probes.push({ method, http: media.status, contentType: media.headers.get('content-type'), contentLength: media.headers.get('content-length'), contentRange: media.headers.get('content-range') });
      await media.body?.cancel();
    } catch (error) {
      source.probes.push({ method, errorClass: error?.name === 'TimeoutError' ? 'timeout' : 'transport-error' });
    }
  }
  source.readableByHeadAndGet = source.probes.every(probe => [200, 206].includes(probe.http) && /^video\//u.test(probe.contentType || ''));
  report.sources.push(source);
}
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(`${evidenceRoot}/public-sources-readonly.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
