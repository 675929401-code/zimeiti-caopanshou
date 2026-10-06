import assert from 'node:assert/strict';
import { listPublishedSkills, describeSkillApiError, SkillCatalogApiError } from '../src/features/youcai-skills/youcai-skill-api.ts';

const originalFetch = globalThis.fetch;
let calls = 0;
let body;
let status = 200;
globalThis.fetch = async (_url, init) => {
  calls += 1;
  assert.equal(init.method, 'GET');
  return Response.json(body, { status });
};
try {
  for (const packageStore of [{ state: 'migration_not_ready' }, { code: 'MIGRATION_NOT_READY', operation: 'public-list' }]) {
    body = { ok: true, mode: 'builtin_runtime_catalog', skills: [], package_store: packageStore };
    let received;
    await assert.rejects(listPublishedSkills(null), (error) => {
      received = error;
      return error instanceof SkillCatalogApiError && error.code === 'MIGRATION_NOT_READY' && error.status === 200;
    });
    const notice = describeSkillApiError(received);
    assert.equal(notice.fallbackToBuiltin, true);
    assert.equal(notice.code, 'MIGRATION_NOT_READY');
  }
  body = { ok: true, skills: [] };
  assert.deepEqual(await listPublishedSkills(null), []);
  body = { ok: true, skills: [], package_store: { state: 'ready' } };
  assert.deepEqual(await listPublishedSkills(null), []);
  body = { ok: true, skills: [{ id: 'version-fixture', packageId: 'package-fixture', slug: 'fixture',
    title: 'Fixture', commandName: '/fixture', version: '1.0.0', priceCredits: 0 }] };
  const result = await listPublishedSkills(null);
  assert.equal(result.length, 1);
  assert.equal(result[0].priceCredits, 0);
  status = 503;
  body = { ok: false, code: 'MIGRATION_NOT_READY' };
  await assert.rejects(listPublishedSkills(null), { code: 'MIGRATION_NOT_READY', status: 503 });
  status = 200;
  body = { ok: true, skills: [{}] };
  await assert.rejects(listPublishedSkills(null), { code: 'INVALID_RESPONSE' });
  assert.equal(calls, 7);
  console.log(JSON.stringify({ passed: true, cases: 7, actualCatalogFunction: true, actualUiErrorMapping: true, providerCalls: 0, databaseWrites: 0 }));
} finally { globalThis.fetch = originalFetch; }
