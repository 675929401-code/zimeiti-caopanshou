import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
}

function load(file, modules, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(file), {
    module,
    exports: module.exports,
    URLSearchParams,
    Response,
    Date,
    console,
    process: { pid: 707, env: { MEDIA_QUEUE_WORKER_INSTANCE: 'recovery-test' } },
    require(id) {
      if (id in modules) return modules[id];
      throw new Error(`UNEXPECTED_MODULE:${id}`);
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}

// Unknown submissions are deduplicated by owner, reconciled independently,
// and never cause a second provider submission.
const rpcUsers = [];
const scanFilters = [];
const reconciliationDb = {
  from(table) {
    assert.equal(table, 'video_tasks');
    const chain = {
      select() { return chain; },
      in(...args) { scanFilters.push(['in', ...args]); return chain; },
      eq(...args) { scanFilters.push(['eq', ...args]); return chain; },
      is(...args) { scanFilters.push(['is', ...args]); return chain; },
      or(...args) { scanFilters.push(['or', ...args]); return chain; },
      lte(...args) { scanFilters.push(['lte', ...args]); return chain; },
      order() { return chain; },
      async range() {
        return { data: [{ user_id: 'owner-a' }, { user_id: 'owner-a' }, { user_id: 'owner-b' }, { user_id: 'owner-c' }], error: null };
      },
    };
    return chain;
  },
  async rpc(name, args) {
    assert.equal(name, 'expire_video_submission_confirmations_atomic');
    rpcUsers.push(args.p_user_id);
    if (args.p_user_id === 'owner-b') return { data: null, error: { code: 'FIXTURE_FAILURE' } };
    const count = args.p_user_id === 'owner-a' ? 2 : 1;
    return { data: { expired_count: count, task_ids: Array.from({ length: count }, (_, index) => `${args.p_user_id}-${index + 1}`) }, error: null };
  },
};
const reconciliation = load('src/lib/video-submission-reconciliation.ts', {
  '@/storage/database/supabase-client': { getSupabaseClient: () => reconciliationDb },
});
const reconciled = await reconciliation.reconcileStaleVideoSubmissionBatch({
  supabase: reconciliationDb,
  now: new Date('2026-09-25T08:00:00.000Z'),
});
assert.deepEqual([...rpcUsers].sort(), ['owner-a', 'owner-b', 'owner-c']);
assert.equal(reconciled.scannedUserCount, 3);
assert.equal(reconciled.failedUserCount, 1);
assert.equal(reconciled.expiredCount, 3);
assert.equal(reconciled.taskIds.length, 3);
assert.ok(scanFilters.some((entry) => entry[0] === 'eq' && entry[1] === 'submission_error_code' && entry[2] === 'VIDEO_SUBMIT_OUTCOME_UNKNOWN'));
assert.ok(scanFilters.some((entry) => entry[0] === 'or' && String(entry[1]).includes('task_id_external.is.null')));

// Accepted provider jobs use an adaptive database cooldown.  A thrown status
// refresh is isolated; the remaining tasks still advance in the same batch.
const claimedRows = [
  { task_id: 'processing-internal', owner_user_id: 'owner-a', internal_model_id: 'model-a', provider_task_id: 'provider-processing' },
  { task_id: 'completed-internal', owner_user_id: 'owner-a', internal_model_id: 'model-a', provider_task_id: 'provider-completed' },
  { task_id: 'error-internal', owner_user_id: 'owner-a', internal_model_id: 'model-a', provider_task_id: 'provider-error' },
];
const billingCandidate = {
  id: 'billing-internal', user_id: 'owner-a', model_id: 'model-a', task_id_external: 'provider-billing',
  task_label: 'billing fixture', provider_poll_lease_owner: null, provider_poll_lease_until: null,
  created_at: '2026-09-25T07:00:00.000Z',
};
const releases = [];
const deferrals = [];
const refreshes = [];
let backgroundReconciliations = 0;

function videoTaskQuery(initialPayload) {
  const state = { payload: initialPayload, filters: [], selection: '' };
  const chain = {
    select(value) { state.selection = value || ''; return chain; },
    in(...args) { state.filters.push(['in', ...args]); return chain; },
    not(...args) { state.filters.push(['not', ...args]); return chain; },
    neq(...args) { state.filters.push(['neq', ...args]); return chain; },
    or(...args) { state.filters.push(['or', ...args]); return chain; },
    eq(...args) { state.filters.push(['eq', ...args]); return chain; },
    is(...args) { state.filters.push(['is', ...args]); return chain; },
    order() { return chain; },
    async range() { return { data: [billingCandidate], error: null }; },
    async maybeSingle() {
      if (state.payload?.provider_poll_lease_owner && state.payload.provider_poll_lease_until) {
        return { data: billingCandidate, error: null };
      }
      if (state.payload && state.payload.provider_poll_lease_owner === null) {
        const idFilter = state.filters.find((item) => item[0] === 'eq' && item[1] === 'id');
        deferrals.push({ id: idFilter?.[2], until: state.payload.provider_poll_lease_until });
        return { data: { id: idFilter?.[2] }, error: null };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

const workerDb = {
  async rpc(name, args) {
    if (name === 'claim_video_history_poll_batch') {
      return { data: claimedRows, error: null };
    }
    if (name === 'release_video_history_poll_claim') {
      releases.push(args.p_task_id);
      return { data: true, error: null };
    }
    throw new Error(`UNEXPECTED_RPC:${name}`);
  },
  from(table) {
    if (table === 'video_tasks') {
      return {
        ...videoTaskQuery(),
        update(payload) { return videoTaskQuery(payload); },
      };
    }
    assert.equal(table, 'users');
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      async maybeSingle() { return { data: { id: 'owner-a', role: 'student' }, error: null }; },
    };
    return chain;
  },
};

const worker = load('src/lib/video-history-worker.ts', {
  'server-only': {},
  '@/storage/database/supabase-client': { getSupabaseAdminClient: () => workerDb },
  '@/lib/video-task-status': {
    refreshOwnedVideoTaskStatus: async (_owner, params) => {
      const taskId = params.get('taskId');
      refreshes.push(taskId);
      if (taskId === 'provider-error') throw new Error('fixture transport interruption');
      if (taskId === 'provider-completed') return Response.json({ status: 'completed' });
      if (taskId === 'provider-billing') return Response.json({ status: 'billing_pending', processingStage: 'billing' }, { status: 503 });
      return Response.json({ status: 'processing', processingStage: 'processing' });
    },
  },
  '@/lib/video-submission-reconciliation': {
    reconcileStaleVideoSubmissionBatch: async () => {
      backgroundReconciliations += 1;
      return { expiredCount: 0, taskIds: [], scannedUserCount: 0, failedUserCount: 0 };
    },
  },
  '@/lib/durable-queue-loop': { DurableQueueLoop: class {} },
});

const startedAt = Date.now();
await worker.reconcileVideoHistoryBatch();
assert.equal(backgroundReconciliations, 1);
assert.deepEqual([...refreshes].sort(), ['provider-billing', 'provider-completed', 'provider-error', 'provider-processing']);
assert.deepEqual(releases, ['completed-internal']);
assert.deepEqual(deferrals.map((entry) => entry.id).sort(), ['billing-internal', 'error-internal', 'processing-internal']);
for (const entry of deferrals) {
  const seconds = (Date.parse(entry.until) - startedAt) / 1000;
  assert.ok(seconds >= 9 && seconds <= 31, `unexpected cooldown for ${entry.id}: ${seconds}`);
}

// An optional billing-pending scan failure must not strand the primary RPC
// claims that were already acquired in the same tick.
let primaryRefreshesAfterSupplementFailure = 0;
const supplementFailureDb = {
  async rpc(name) {
    if (name === 'claim_video_history_poll_batch') {
      return { data: [{ task_id: 'primary-survives', owner_user_id: 'owner-a', internal_model_id: 'model-a', provider_task_id: 'provider-survives' }], error: null };
    }
    if (name === 'release_video_history_poll_claim') return { data: true, error: null };
    throw new Error(`UNEXPECTED_RPC:${name}`);
  },
  from(table) {
    if (table === 'video_tasks') {
      const chain = {
        select() { return chain; }, eq() { return chain; }, not() { return chain; }, neq() { return chain; }, or() { return chain; }, order() { return chain; },
        async range() { return { data: null, error: { code: 'FIXTURE_BILLING_SCAN_FAILURE' } }; },
      };
      return chain;
    }
    const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() { return { data: { id: 'owner-a', role: 'student' }, error: null }; } };
    return chain;
  },
};
const supplementFailureWorker = load('src/lib/video-history-worker.ts', {
  'server-only': {},
  '@/storage/database/supabase-client': { getSupabaseAdminClient: () => supplementFailureDb },
  '@/lib/video-task-status': { refreshOwnedVideoTaskStatus: async () => { primaryRefreshesAfterSupplementFailure += 1; return Response.json({ status: 'completed' }); } },
  '@/lib/video-submission-reconciliation': { reconcileStaleVideoSubmissionBatch: async () => ({ expiredCount: 0, taskIds: [], scannedUserCount: 0, failedUserCount: 0 }) },
  '@/lib/durable-queue-loop': { DurableQueueLoop: class {} },
});
await supplementFailureWorker.reconcileVideoHistoryBatch();
assert.equal(primaryRefreshesAfterSupplementFailure, 1);

console.log(JSON.stringify({
  passed: true,
  unknownOwnersScanned: reconciled.scannedUserCount,
  unknownTasksExpiredWithoutReplay: reconciled.expiredCount,
  isolatedReconciliationFailures: reconciled.failedUserCount,
  workerTasksAdvanced: refreshes.length,
  perTaskFailuresIsolated: true,
  adaptiveDatabaseCooldowns: deferrals.length,
  completedLeaseReleased: releases.length,
  billingPendingRecovered: refreshes.includes('provider-billing'),
  supplementalClaimFailureIsolated: primaryRefreshesAfterSupplementFailure === 1,
  providerSubmissions: 0,
  paidCalls: 0,
  realDatabaseWrites: 0,
}, null, 2));
