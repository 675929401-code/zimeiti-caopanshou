import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureNativePublishingReady } from '../scripts/native-publishing-readiness.mjs';

test('healthy current native process is reused without a start', async () => {
  const calls = [];
  const result = await ensureNativePublishingReady({ runCommand: async mode => { calls.push(mode); return { runningNativeLatest: true }; } });
  assert.equal(result.runningNativeLatest, true); assert.deepEqual(calls, ['--check']);
});
test('verified missing process is started once and readiness is checked', async () => {
  const calls = [];
  await ensureNativePublishingReady({ runCommand: async mode => { calls.push(mode); if (calls.length === 1) throw new Error('NATIVE_PROCESS_NOT_VERIFIED'); return { runningNativeLatest: true }; } });
  assert.deepEqual(calls, ['--check', '--start', '--check']);
});
for (const code of ['NATIVE_SOURCE_STALE', 'NATIVE_BUILD_ID_MISMATCH', 'NATIVE_READY_PROOF_MISSING']) test(`${code} never triggers a start or a stop`, async () => {
  const calls = [];
  await assert.rejects(ensureNativePublishingReady({ runCommand: async mode => { calls.push(mode); throw new Error(code); } }), new RegExp(code));
  assert.deepEqual(calls, ['--check']);
});
test('unknown occupied port is preserved and main startup is refused', async () => {
  const calls = [];
  await assert.rejects(ensureNativePublishingReady({ runCommand: async mode => { calls.push(mode); throw new Error(mode === '--check' ? 'NATIVE_PROCESS_NOT_VERIFIED' : 'NATIVE_PORT_OCCUPIED_REQUIRES_OWNER_CHECK'); } }), /NATIVE_PORT_OCCUPIED/);
  assert.deepEqual(calls, ['--check', '--start']);
});
test('startup waits only for bounded transient network readiness and verifies final identity', async () => {
  let calls = 0, sleeps = 0;
  const result = await ensureNativePublishingReady({ sleep: async () => { sleeps++; }, runCommand: async () => { calls++; if (calls === 1) throw new Error('NATIVE_PROCESS_NOT_VERIFIED'); if (calls === 3) throw new Error('fetch failed'); return { runningNativeLatest: true }; } });
  assert.equal(result.runningNativeLatest, true); assert.equal(calls, 4); assert.equal(sleeps, 1);
});
