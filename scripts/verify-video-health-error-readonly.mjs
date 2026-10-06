import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
if (!process.argv.includes('--execute-readonly')) { console.log(JSON.stringify({ networkRequests: 0, mode: 'plan' })); process.exit(0); }
const cfg = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).origin, 'http://127.0.0.1:54321');
const endpoint = new URL('/rest/v1/video_channel_health', cfg.supabaseUrl);
endpoint.searchParams.set('select', 'channel_id,last_error,last_fail_at'); endpoint.searchParams.set('channel_id', 'in.(omni-video-edit-chA,minimax-h3-chA)');
const response = await fetch(endpoint, { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } });
const rows = await response.json(); assert.ok(response.ok && Array.isArray(rows));
const report = rows.map(row => {
  const error = String(row.last_error || '');
  return { channelId: row.channel_id, lastFailAt: row.last_fail_at, errorLength: error.length,
    errorSha256: createHash('sha256').update(error).digest('hex'),
    httpCodes: [...new Set(error.match(/\b(?:400|401|403|404|429|500|502|503|504)\b/g) || [])],
    inputDownload403: /(?:download|fetch|access|读取|下载)[\s\S]{0,300}(?:403|forbidden)/i.test(error) || /(?:403|forbidden)[\s\S]{0,300}(?:image|video|media|asset|url|图片|视频)/i.test(error),
    explicitApiCredentialError: /(?:invalid|incorrect|missing|expired|无效|失效)[ _-]*(?:api[ _-]?key|token|credential|密钥)|(?:api[ _-]?key|token|credential|密钥)[\s\S]{0,30}(?:invalid|incorrect|missing|expired|无效|失效)/i.test(error),
    allowedDiagnosticWords: [...new Set(error.match(/\b(?:input|image|video|media|asset|url|download|fetch|forbidden|unauthorized|authentication|credential|invalid|token|api|key|403|401|timeout|failed)\b/gi) || [])].map(word => word.toLowerCase()),
    chineseDiagnosticFragments: error.match(/[\p{Script=Han}]{2,24}/gu) || [],
    knownProviderFailures: ['no available key', 'no available keys', 'invalid key', 'key expired', 'insufficient', 'balance', 'quota', 'permission denied', 'missing API key'].filter(phrase => error.toLowerCase().includes(phrase.toLowerCase())),
    urlHosts: [...new Set((error.match(/https?:\/\/[^\s"'<>]+/gi) || []).flatMap(raw => { try { return [new URL(raw).host]; } catch { return []; } }))],
  };
});
await fs.writeFile('.codex-evidence/video-all-models-real-e2e-20260902/error-classification-readonly.json', JSON.stringify({ at: new Date().toISOString(), databaseWrites: 0, rawErrorsPersisted: false, report }, null, 2));
console.log(JSON.stringify(report));
