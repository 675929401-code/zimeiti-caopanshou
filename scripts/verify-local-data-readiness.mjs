import assert from 'node:assert/strict';
import { ensureLocalDataReady } from './local-data-readiness.mjs';

const plan = { env: { DATABASE_URL: 'postgresql://127.0.0.1:54322/zimeiti_local', COZE_SUPABASE_URL: 'http://127.0.0.1:54321' } };
let restores = 0, probes = 0;
const restore = async () => { restores++; };
assert.deepEqual(await ensureLocalDataReady(plan, { restore: true }, { probe: async () => true, restore }), { ready: true, restored: false });
assert.equal(restores, 0);
await assert.rejects(ensureLocalDataReady(plan, {}, { probe: async () => false, restore }), /LOCAL_DATA_UNAVAILABLE/);
assert.equal(restores, 0, 'check mode is read only');
assert.deepEqual(await ensureLocalDataReady(plan, { restore: true }, { probe: async () => ++probes > 1, restore }), { ready: true, restored: true });
assert.equal(restores, 1);
await assert.rejects(ensureLocalDataReady(plan, { restore: true }, { probe: async () => false, restore }), /LOCAL_DATA_UNAVAILABLE_AFTER_RESTORE/);
let failedLaunchRestores = 0, recoveredProbes = 0;
const failingRestore = async () => { failedLaunchRestores++; throw new Error('RESTORE_COMMAND_SECRET_SENTINEL'); };
assert.deepEqual(await ensureLocalDataReady(plan, { restore: true }, {
  probe: async () => ++recoveredProbes > 1, restore: failingRestore,
}), { ready: true, restored: true, restoreCommandReportedFailure: true });
assert.equal(recoveredProbes, 2);
assert.equal(failedLaunchRestores, 1, 'failed start is called only once before the authoritative recovery probe');
let unavailableProbes = 0;
await assert.rejects(ensureLocalDataReady(plan, { restore: true }, {
  probe: async () => { unavailableProbes++; return false; }, restore: failingRestore,
}), error => {
  assert.equal(String(error), 'Error: LOCAL_DATA_RESTORE_FAILED');
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error.stack), /RESTORE_COMMAND_SECRET_SENTINEL/u);
  return true;
});
assert.equal(unavailableProbes, 2);
assert.equal(failedLaunchRestores, 2, 'each restore attempt calls start exactly once');
for (const env of [
  { ...plan.env, DATABASE_URL: 'postgresql://example.com:54322/zimeiti_local' },
  { ...plan.env, COZE_SUPABASE_URL: 'https://example.com' },
]) await assert.rejects(ensureLocalDataReady({ env }, { restore: true }, { probe: async () => { throw new Error('must not probe'); }, restore }), /LOCAL_DATA_TARGET_REJECTED/);
console.log('Local data readiness: PASS (healthy, restore, fail closed, read-only check, local target isolation)');
