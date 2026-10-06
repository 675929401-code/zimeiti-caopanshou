import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Date, Number, String, Object, JSON, Set, Map, Error,
    process: { env: { COZE_SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-marker' } },
    require(name) { if (name === 'server-only') return {}; if (name in dependencies) return dependencies[name]; return nativeRequire(name); } });
  return module.exports;
}
const contract = load('src/lib/server/skill-package-contract.ts');
const calls = []; let rpcError = null;
const repository = load('src/lib/server/skill-package-repository.ts', {
  '@/lib/server/skill-package-contract': contract,
  '@/lib/server/skill-policy': { isSkillAvailableForActor: () => true },
  '@/lib/server/skill-admin-edit-preservation': {},
  '@/storage/database/supabase-client': { getSupabaseAdminClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return { data: { ok: true, lifecycle: 'archived', package_id: args.p_package_id }, error: rpcError }; } }) },
});
const action = { action: 'archive', packageId: 'cf44b5b6-18e9-4a5a-8096-8c510f7be1c2', expectedUpdatedAt: '2026-09-02T12:00:00.000Z', expectedActiveVersionId: 'ea91cf44-6672-461e-b02f-0168cfad26cb' };
let passed = 0;
const test = async (name, fn) => { calls.length = 0; rpcError = null; await fn(); passed++; console.log(`PASS ${name}`); };
await test('archive requires package CAS and cannot receive a client-supplied actor', () => {
  assert.equal(contract.SkillAdminActionSchema.safeParse(action).success, true);
  assert.equal(contract.SkillAdminActionSchema.safeParse({ ...action, expectedUpdatedAt: undefined }).success, false);
  assert.equal(contract.SkillAdminActionSchema.safeParse({ ...action, expectedActiveVersionId: undefined }).success, false);
  assert.equal(contract.SkillAdminActionSchema.safeParse({ ...action, actorId: 'other-user' }).success, false);
});
await test('actual repository uses one archive RPC and the authenticated actor, without deleting records', async () => {
  const result = await repository.executeAdminSkillAction(action, 'fixture-normal-admin');
  assert.equal(result.lifecycle, 'archived'); assert.equal(calls.length, 1); assert.equal(calls[0].name, 'archive_skill_package');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), { p_package_id: action.packageId, p_expected_updated_at: action.expectedUpdatedAt, p_expected_active_version_id: action.expectedActiveVersionId, p_actor_id: 'fixture-normal-admin' });
});
for (const [pgCode, message, status, code] of [
  ['PGRST202', 'archive_skill_package not found', 503, 'MIGRATION_NOT_READY'],
  ['42501', 'SKILL_ARCHIVE_OWNER_REQUIRED', 403, 'SKILL_ACCESS_DENIED'],
  ['55000', 'SKILL_ARCHIVE_IN_USE', 409, 'SKILL_CONFLICT'],
  ['40001', 'SKILL_ARCHIVE_CONFLICT', 409, 'SKILL_CONFLICT'],
  ['55000', 'SKILL_PACKAGE_ARCHIVED', 409, 'SKILL_OPERATION_INVALID'],
]) await test(`actual archive RPC ${message} remains a refusal`, async () => {
  rpcError = { code: pgCode, message };
  await assert.rejects(repository.executeAdminSkillAction(action, 'fixture-normal-admin'), error => error.status === status && error.code === code);
  assert.equal(calls.length, 1);
});
const output = '.codex-evidence/skill-package-archive-20260903'; fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(`${output}/fixture-report.json`, JSON.stringify({ passed, actualContractAndRepository: true, realDatabaseWrites: 0, upstreamCalls: 0 }, null, 2));
console.log(JSON.stringify({ passed, realDatabaseWrites: 0, upstreamCalls: 0 }));
