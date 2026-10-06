import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeVideoProviderDiagnostic } from '../src/lib/video-error-policy.ts';

const runtimePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const apply = process.argv.includes('--apply');
if (apply) assert.ok(process.argv.includes('--confirm-local-health-redaction'));
const runtime = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, ''));
const base = new URL(runtime.supabaseUrl);
assert.equal(base.hostname, '127.0.0.1');
assert.equal(base.port, '54321');
const headers = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const readUrl = new URL('/rest/v1/video_channel_health', base);
readUrl.searchParams.set('select', 'channel_id,last_error,updated_at');
readUrl.searchParams.set('last_error', 'not.is.null');
const read = await fetch(readUrl, { headers, signal: AbortSignal.timeout(15_000) });
const rows = await read.json();
assert.ok(read.ok && Array.isArray(rows));
const sha = value => createHash('sha256').update(String(value || '')).digest('hex');
const changes = rows.map(row => ({
  channelId: row.channel_id,
  updatedAt: row.updated_at,
  beforeSha256: sha(row.last_error),
  after: sanitizeVideoProviderDiagnostic(row.last_error),
})).filter(row => sha(row.after) !== row.beforeSha256);

const applied = [];
if (apply) {
  for (const change of changes) {
    const update = new URL('/rest/v1/video_channel_health', base);
    update.searchParams.set('channel_id', `eq.${change.channelId}`);
    update.searchParams.set('updated_at', `eq.${change.updatedAt}`);
    const response = await fetch(update, { method: 'PATCH', headers, body: JSON.stringify({ last_error: change.after }), signal: AbortSignal.timeout(15_000) });
    const updated = await response.json();
    assert.ok(response.ok && Array.isArray(updated) && updated.length === 1, `CAS failed for ${change.channelId}`);
    assert.equal(updated[0].last_error, change.after);
    applied.push({ channelId: change.channelId, beforeSha256: change.beforeSha256, after: change.after });
  }
}

const report = { at: new Date().toISOString(), target: '127.0.0.1:54321', mode: apply ? 'apply' : 'plan', scanned: rows.length, changed: changes.length, applied: applied.length, rows: apply ? applied : changes.map(({ channelId, beforeSha256, after }) => ({ channelId, beforeSha256, after })) };
const evidence = path.resolve('.codex-evidence/video-health-diagnostic-redaction-20260904', `${apply ? 'apply' : 'plan'}.json`);
await fs.mkdir(path.dirname(evidence), { recursive: true });
await fs.writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ mode: report.mode, scanned: report.scanned, changed: report.changed, applied: report.applied, evidence }));
