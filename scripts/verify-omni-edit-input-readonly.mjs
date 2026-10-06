import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
if (!process.argv.includes('--execute-readonly')) { console.log(JSON.stringify({ networkRequests: 0, mode: 'plan', generationRequests: 0 })); process.exit(0); }
const cfg = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).origin, 'http://127.0.0.1:54321');
const endpoint = new URL('/rest/v1/video_channel_health', cfg.supabaseUrl); endpoint.searchParams.set('select', 'channel_id,last_error'); endpoint.searchParams.set('channel_id', 'eq.omni-video-edit-chA');
const response = await fetch(endpoint, { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` }, signal: AbortSignal.timeout(15000) });
const rows = await response.json(); assert.ok(response.ok && rows.length === 1);
const raw = String(rows[0].last_error).match(/https:\/\/[^\s"'<>]+/u)?.[0]?.replace(/[),]+$/u, '');
const input = new URL(raw);
assert.equal(input.hostname, 'ai-agent-main-storage-1434868362.cos.ap-guangzhou.myqcloud.com');
const timing = (input.searchParams.get('q-sign-time') || '').split(';').map(Number);
const report = { at: new Date().toISOString(), generationRequests: 0, urlPersisted: false, inputUrlSha256: createHash('sha256').update(input.toString()).digest('hex'),
  host: input.host, queryKeys: [...input.searchParams.keys()], ttlSeconds: timing.length === 2 ? timing[1] - timing[0] : null,
  validAtProbeTime: timing.length === 2 ? timing[0] <= Date.now() / 1000 && timing[1] > Date.now() / 1000 : null, probes: [] };
for (const method of ['HEAD', 'GET']) {
  const result = await fetch(input, { method, headers: method === 'GET' ? { Range: 'bytes=0-1023' } : {}, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const type = result.headers.get('content-type');
  const body = method === 'GET' && !result.ok ? await result.text() : '';
  report.probes.push({ method, http: result.status, contentType: type, contentLength: result.headers.get('content-length'), errorCode: body.match(/<Code>([^<]+)<\/Code>/u)?.[1] || null });
  await result.body?.cancel();
}
await fs.mkdir('.codex-evidence/omni-edit-input-bridge-20260902', { recursive: true });
await fs.writeFile('.codex-evidence/omni-edit-input-bridge-20260902/failed-input-readonly.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
