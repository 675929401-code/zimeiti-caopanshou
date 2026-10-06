import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const workerSource = fs.readFileSync('src/lib/video-history-worker.ts', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260923193500_video_history_poll_leases.sql', 'utf8');
const rollback = fs.readFileSync('supabase/rollbacks/20260923193500_video_history_poll_leases.rollback.sql', 'utf8');

for (const marker of [
  "ADD COLUMN IF NOT EXISTS provider_poll_lease_owner",
  "ADD COLUMN IF NOT EXISTS provider_poll_lease_until",
  "CREATE OR REPLACE FUNCTION public.claim_video_history_poll_batch",
  "FOR UPDATE OF t SKIP LOCKED",
  "t.provider_poll_lease_until IS NULL OR t.provider_poll_lease_until <= now()",
  "t.status IN ('pending', 'queued', 'processing', 'generating', 'finalizing')",
  "left(t.task_id_external, 4) <> 'h3q_'",
  "t.task_label NOT LIKE 'digital-human:%'",
  "CREATE OR REPLACE FUNCTION public.release_video_history_poll_claim",
  "provider_poll_lease_owner = trim(p_worker_id)",
]) assert.ok(migration.includes(marker), `LEASE_MIGRATION_MARKER_MISSING:${marker}`);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_video_history_poll_batch[\s\S]*FROM PUBLIC, anon, authenticated/u);
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_video_history_poll_batch[\s\S]*TO service_role/u);
for (const marker of [
  "DROP FUNCTION IF EXISTS public.release_video_history_poll_claim",
  "DROP FUNCTION IF EXISTS public.claim_video_history_poll_batch",
  "DROP INDEX IF EXISTS public.video_tasks_provider_poll_claim_idx",
  "DROP COLUMN IF EXISTS provider_poll_lease_until",
  "DROP COLUMN IF EXISTS provider_poll_lease_owner",
]) assert.ok(rollback.includes(marker), `LEASE_ROLLBACK_MARKER_MISSING:${marker}`);
assert.match(workerSource, /missingLeaseRpc[\s\S]*legacyVideoHistoryTasks/u);
assert.match(workerSource, /finally \{[\s\S]*releaseVideoHistoryTask\(db, task\)/u);

function loadWorker({ db, refresh, pid, instance }) {
  const module = { exports: {} };
  const output = ts.transpileModule(workerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'video-history-worker.ts',
  }).outputText;
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    URLSearchParams,
    Response,
    console,
    process: { pid, env: { MEDIA_QUEUE_WORKER_INSTANCE: instance } },
    require(id) {
      if (id === 'server-only') return {};
      if (id === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => db };
      if (id === '@/lib/video-task-status') return { refreshOwnedVideoTaskStatus: refresh };
      if (id === '@/lib/video-submission-reconciliation') return { reconcileStaleVideoSubmissionBatch: async () => ({ expiredCount: 0, taskIds: [], scannedUserCount: 0, failedUserCount: 0 }) };
      if (id === '@/lib/durable-queue-loop') return { DurableQueueLoop: class {} };
      throw new Error(`UNEXPECTED_MODULE:${id}`);
    },
  }, { filename: 'video-history-worker.ts' });
  return module.exports;
}

const activeStatuses = new Set(['pending', 'queued', 'processing', 'generating', 'finalizing']);
const now = 10_000;
const rows = Array.from({ length: 31 }, (_, index) => ({
  id: `task-${String(index + 1).padStart(2, '0')}`,
  user_id: `owner-${(index % 3) + 1}`,
  model_id: 'model-1',
  task_id_external: `provider-${index + 1}`,
  task_label: `任务${index + 1}`,
  status: activeStatuses.has('processing') ? 'processing' : 'failed',
  provider_last_polled_at: index,
  provider_poll_lease_owner: null,
  provider_poll_lease_until: null,
}));
rows.push({
  id: 'stale-active', user_id: 'owner-1', model_id: 'model-1', task_id_external: 'provider-stale',
  task_label: '任务32', status: 'queued', provider_last_polled_at: -1,
  provider_poll_lease_owner: 'dead-worker', provider_poll_lease_until: now - 1,
});
rows.push({
  id: 'future-leased', user_id: 'owner-1', model_id: 'model-1', task_id_external: 'provider-future',
  task_label: '任务33', status: 'queued', provider_last_polled_at: -2,
  provider_poll_lease_owner: 'live-worker', provider_poll_lease_until: now + 500,
});
for (const status of ['completed', 'failed', 'cancelled', 'expired']) rows.push({
  id: `terminal-${status}`, user_id: 'owner-1', model_id: 'model-1', task_id_external: `provider-${status}`,
  task_label: '终态', status, provider_last_polled_at: -3,
  provider_poll_lease_owner: null, provider_poll_lease_until: null,
});

const claims = new Map();
const releases = [];
const refreshed = [];
const claimArgs = [];
const db = {
  async rpc(name, args) {
    if (name === 'claim_video_history_poll_batch') {
      claimArgs.push(args);
      const eligible = rows
        .filter(row => activeStatuses.has(row.status)
          && row.task_id_external
          && !row.task_id_external.startsWith('h3q_')
          && !row.task_label.startsWith('digital-human:')
          && (row.provider_poll_lease_until == null || row.provider_poll_lease_until <= now))
        .sort((left, right) => left.provider_last_polled_at - right.provider_last_polled_at || left.id.localeCompare(right.id))
        .slice(0, args.p_limit);
      for (const row of eligible) {
        row.provider_poll_lease_owner = args.p_worker_id;
        row.provider_poll_lease_until = now + args.p_lease_seconds;
      }
      claims.set(args.p_worker_id, eligible.map(row => row.id));
      return { data: eligible.map(row => ({
        task_id: row.id,
        owner_user_id: row.user_id,
        internal_model_id: row.model_id,
        provider_task_id: row.task_id_external,
      })), error: null };
    }
    if (name === 'release_video_history_poll_claim') {
      releases.push({ taskId: args.p_task_id, worker: args.p_worker_id });
      const row = rows.find(item => item.id === args.p_task_id && item.provider_poll_lease_owner === args.p_worker_id);
      if (row) {
        row.provider_poll_lease_owner = null;
        row.provider_poll_lease_until = null;
      }
      return { data: Boolean(row), error: null };
    }
    throw new Error(`UNEXPECTED_RPC:${name}`);
  },
  from(table) {
    assert.equal(table, 'users');
    let ownerId = '';
    const chain = {
      select() { return chain; },
      eq(column, value) { assert.equal(column, 'id'); ownerId = value; return chain; },
      async maybeSingle() { return { data: { id: ownerId, role: 'student' }, error: null }; },
    };
    return chain;
  },
};
const refresh = async (_owner, params) => {
  refreshed.push(params.get('taskId'));
  return new Response('{}');
};
const workerA = loadWorker({ db, refresh, pid: 101, instance: 'a' });
const workerB = loadWorker({ db, refresh, pid: 202, instance: 'b' });
await Promise.all([workerA.reconcileVideoHistoryBatch(), workerB.reconcileVideoHistoryBatch()]);

assert.equal(claimArgs.length, 2);
assert.ok(claimArgs.every(args => args.p_limit === 16 && args.p_lease_seconds === 180));
const [workerAId, workerBId] = [...claims.keys()];
assert.notEqual(workerAId, workerBId);
const claimedA = new Set(claims.get(workerAId));
const claimedB = new Set(claims.get(workerBId));
assert.equal([...claimedA].some(id => claimedB.has(id)), false, 'two workers claimed an overlapping task');
const claimedAll = new Set([...claimedA, ...claimedB]);
assert.equal(claimedAll.size, 32);
assert.equal(claimedAll.has('stale-active'), true, 'expired lease was not recovered');
assert.equal(claimedAll.has('future-leased'), false, 'unexpired lease was stolen');
for (const status of ['completed', 'failed', 'cancelled', 'expired']) {
  assert.equal(claimedAll.has(`terminal-${status}`), false, `${status} task was claimed`);
}
assert.equal(refreshed.length, 32);
assert.equal(releases.length, 32);

let fallbackRefreshes = 0;
const fallbackFilters = [];
const fallbackDb = {
  async rpc(name) {
    assert.equal(name, 'claim_video_history_poll_batch');
    return { data: null, error: { code: 'PGRST202', message: 'function is absent from the schema cache' } };
  },
  from(table) {
    if (table === 'video_tasks') {
      const chain = {
        select() { return chain; }, in(...args) { fallbackFilters.push(args); return chain; },
        not(...args) { fallbackFilters.push(args); return chain; }, neq(...args) { fallbackFilters.push(args); return chain; },
        or() { return chain; }, order() { return chain; },
        async range() { return { data: [{ id: 'legacy-task', user_id: 'legacy-owner', model_id: 'legacy-model', task_id_external: 'legacy-provider' }], error: null }; },
      };
      return chain;
    }
    assert.equal(table, 'users');
    const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() { return { data: { id: 'legacy-owner', role: 'student' }, error: null }; } };
    return chain;
  },
};
const fallbackWorker = loadWorker({
  db: fallbackDb,
  refresh: async () => { fallbackRefreshes += 1; return new Response('{}'); },
  pid: 303,
  instance: 'fallback',
});
await fallbackWorker.reconcileVideoHistoryBatch();
assert.equal(fallbackRefreshes, 1, 'missing migration stopped legacy polling');
assert.ok(fallbackFilters.some(args => args[0] === 'status'));

console.log(JSON.stringify({
  passed: true,
  claimedTasks: claimedAll.size,
  overlap: 0,
  expiredLeaseRecovered: true,
  unexpiredLeaseProtected: true,
  terminalTasksClaimed: 0,
  legacyFallbackPolls: fallbackRefreshes,
  providerRequests: 0,
  databaseWrites: 0,
}, null, 2));
