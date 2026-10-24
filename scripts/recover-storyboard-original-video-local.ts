import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { readLocalPreviewLaunchPlan, LOCAL_PREVIEW_RUNTIME_FILE } from './start-local-data-preview.mjs';

async function main() {
const plan = await readLocalPreviewLaunchPlan(5000);
Object.assign(process.env, plan.env);
const runtime = JSON.parse(await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8'));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.ownerConnection.host, '127.0.0.1');
assert.equal(runtime.ownerConnection.database, 'zimeiti_local');
const baseline = JSON.parse(await fs.readFile('.codex-evidence/storyboard-history-20261023/live-before.json', 'utf8'));
const ids = baseline.tasks.filter((task: { status: string }) => task.status === 'completed').map((task: { taskId: string }) => task.taskId);
const limit = process.argv.includes('--all') ? 8 : 1;
const restore = process.argv.includes('--restore-existing-result');
const { resolveProviderSecret } = await import('../src/lib/provider-secret');
const { pollVideoTask } = await import('../src/lib/video-adapter');
const { safeMediaFetch } = await import('../src/lib/safe-media-fetch');
const db = new pg.Client(runtime.ownerConnection);
await db.connect();
const outcomes: Record<string, unknown>[] = [];
const originalFetch = globalThis.fetch;
let supplierGetRequests = 0;
globalThis.fetch = async (input, init) => {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  assert.ok(['GET', 'HEAD'].includes(method), 'RECOVERY_MUST_NOT_SUBMIT_GENERATION');
  supplierGetRequests++;
  return originalFetch(input, init);
};
try {
  const tasks = (await db.query(`select t.*,m.name,m.model_name,m.protocol_type,m.api_endpoint,m.api_key,m.api_protocol_config
    from video_tasks t join video_models m on m.id=t.model_id
    where t.id=any($1::text[]) and t.task_label like '分镜工作台%' and t.status='completed'
      and t.storage_url is null and t.completed_at > now()-interval '72 hours'
      and (t.history_hidden_at is null or t.history_hidden_at=t.source_expired_at)
    order by t.completed_at desc limit $2`, [ids, limit])).rows;
  for (const task of tasks) {
    const outcome: Record<string, unknown> = { taskId: task.id, protocol: task.protocol_type, restored: false };
    const oldLog = console.log, oldWarn = console.warn, oldError = console.error;
    try {
      // Provider adapters may log diagnostics. Never expose URLs, credentials or raw responses.
      console.log = console.warn = console.error = () => {};
      const key = resolveProviderSecret(String(task.api_key || ''));
      const result = await pollVideoTask({ id: task.model_id, name: task.name, model_name: task.model_name,
        provider: 'local-acceptance', price_per_use: 0, duration_seconds: Number(task.duration_seconds || 8), supports_image_input: true,
        protocol_type: task.protocol_type, api_endpoint: task.api_endpoint, api_key: key,
        api_protocol_config: task.api_protocol_config || {} }, task.task_id_external);
      outcome.providerStatus = result.status;
      outcome.hasResultUrl = Boolean(result.videoUrl);
      if (result.videoUrl && ['success', 'completed'].includes(result.status)) {
        let target = new URL(result.videoUrl);
        assert.equal(target.protocol, 'https:');
        const fetched = await safeMediaFetch(target.toString(), { headers: { Range: 'bytes=0-1023' },
          authorization: { origin: new URL(task.api_endpoint).origin, value: `Bearer ${key}` }, timeoutMs: 20_000 });
        outcome.mediaStatus = fetched.response.status;
        outcome.contentType = fetched.response.headers.get('content-type');
        let readable = fetched.response.ok && /^video\//iu.test(String(outcome.contentType));
        await fetched.response.body?.cancel();
        if (!readable && task.protocol_type === 'gaorui_video') {
          const contentUrl = `${String(task.api_endpoint).replace(/\/+$/u, '')}/videos/${encodeURIComponent(task.task_id_external)}/content`;
          const fallback = await safeMediaFetch(contentUrl, { headers: { Range: 'bytes=0-1023' },
            authorization: { origin: new URL(task.api_endpoint).origin, value: `Bearer ${key}` }, timeoutMs: 20_000 });
          outcome.contentFallbackStatus = fallback.response.status;
          outcome.contentFallbackType = fallback.response.headers.get('content-type');
          readable = fallback.response.ok && /^video\//iu.test(String(outcome.contentFallbackType));
          await fallback.response.body?.cancel();
          if (readable) target = new URL(contentUrl);
        }
        outcome.mediaReadable = readable;
        if (readable && restore) {
          const updated = await db.query(`update video_tasks set provider_result_url=$2,video_url=$2,source_expired_at=null,
            history_hidden_at=case when history_hidden_at=source_expired_at then null else history_hidden_at end
            where id=$1 and user_id=$3 and task_id_external=$4 and status='completed' and storage_url is null
              and (history_hidden_at is null or history_hidden_at=source_expired_at) returning id`,
          [task.id, target.toString(), task.user_id, task.task_id_external]);
          outcome.restored = updated.rowCount === 1;
        }
      }
    } catch (error) {
      outcome.failure = error instanceof Error ? error.name : 'UNKNOWN';
    } finally { console.log = oldLog; console.warn = oldWarn; console.error = oldError; }
    outcomes.push(outcome);
  }
} finally { globalThis.fetch = originalFetch; await db.end(); }
const report = { checkedAt: new Date().toISOString(), mode: restore ? 'recover-existing-result' : 'inspect-existing-result',
  newGenerationRequests: 0, supplierGetRequests, outcomes };
const output = path.resolve('.codex-evidence/storyboard-history-20261023', restore ? 'original-result-recovery.json' : 'original-result-inspection.json');
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, ...report }, null, 2));
}
main().catch(error => { console.error('ORIGINAL_RESULT_INSPECTION_FAILED', error instanceof Error ? error.name : 'UNKNOWN'); process.exitCode = 1; });
