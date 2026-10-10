import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Execute the actual finalizer with bounded dependencies. No DB or network writes.
const source = fs.readFileSync('src/lib/video-terminal-finalizer.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const task = { id: 'vt_completed_fixture', user_id: 'fixture-user', model_id: 'original-model', task_id_external: 'provider-original', status: 'completed',
  storage_url: 'object://tencent_cos/videos%2Fowned.mp4', video_url: 'object://tencent_cos/videos%2Fowned.mp4',
  billing_price_yuan: 0.55, billing_cost_price_yuan: 0.4, billing_exempt: true, explicitly_free: false,
  billing_state: 'not_required', billing_operation_id: null, price_charged: 0 };
let reads = 0, rpcs = 0, writes = 0, bills = 0, persist = 0, outcomes = 0, revenues = 0;
const db = { from(table) {
  assert.equal(table, 'video_tasks');
  const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() { reads++; await Promise.resolve(); return { data: { ...task }, error: null }; },
    update() { writes++; throw new Error('COMPLETED_TASK_MUST_NOT_BE_REOPENED'); } };
  return chain;
}, async rpc(name, payload) { rpcs++; assert.equal(name, 'finalize_video_generation_task_atomic'); assert.equal(payload.p_stable_storage_url, task.storage_url);
  return { data: { status: 'completed', already_completed: true, price_charged: 0, billing_state: 'not_required' }, error: null };
} };
const load = () => {
  const module = { exports: {} };
  const require = name => {
    if (name === 'server-only') return {};
    if (name.endsWith('/supabase-client')) return { getSupabaseAdminClient: () => db };
    if (name.endsWith('/video-access-ticket')) return { createVideoAccessUrl: async () => '/owned-playback' };
    if (name.endsWith('/billing-executor')) return { executeCashDeduction: async () => { bills++; throw new Error('UNEXPECTED_BILLING'); } };
    if (name.endsWith('/revenue')) return { recordRevenue: async () => { revenues++; } };
    if (name.endsWith('/video-persistence')) return { persistStableVideoFromUrl: async () => { persist++; throw new Error('UNEXPECTED_PERSIST'); } };
    if (name.endsWith('/video-terminal-accounting')) return { recordVideoTerminalOutcome: async () => { outcomes++; } };
    return {};
  };
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  return module.exports;
};
const a = load(), b = load();
const input = { taskIdInternal: task.id, userId: task.user_id, userRole: 'admin', providerTaskId: task.task_id_external };
const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).finalizeVideoGenerationSuccess(input)));
assert.equal(reads, 1, 'Separate route module instances share a process lock');
assert.equal(rpcs, 1);
assert.equal(revenues, 1, 'Concurrent completed replay must share one idempotent revenue confirmation');
assert.ok(results.every(item => item.state === 'completed' && item.newlyCompleted === false));
await a.finalizeVideoGenerationSuccess(input);
assert.equal(reads, 2); assert.equal(rpcs, 2);
assert.equal(revenues, 2, 'Sequential completed replay must re-confirm the idempotent revenue receipt');
assert.deepEqual({ writes, bills, persist, outcomes }, { writes: 0, bills: 0, persist: 0, outcomes: 0 });
assert.equal(task.status, 'completed');
task.status = 'failed';
await assert.rejects(a.finalizeVideoGenerationSuccess(input), { code: 'VIDEO_TASK_TERMINAL_CONFLICT' });
assert.equal(writes, 0);
console.log('PASS completed replay: 12 concurrent calls across 2 module instances, sequential replay, idempotent revenue confirmation, no state reset/billing/persistence/accounting, terminal conflict');
