import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import ts from 'typescript';

function load(file, dependencies) {
  const sandbox = { exports: {}, Error, Object, Array, JSON, Buffer, process: { env: { COZE_SUPABASE_SERVICE_ROLE_KEY: 'fixture' } }, require(name) {
    if (name === 'server-only') return {};
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected import ${name}`);
  } };
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return sandbox.exports;
}
const contract = load('src/lib/server/skill-package-contract.ts', { zod: { z }, 'node:crypto': crypto });
const preservation = load('src/lib/server/skill-admin-edit-preservation.ts', { '@/lib/server/skill-package-contract': contract });
const packageId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2026-09-02T12:00:00.000Z';
const payload = contract.validateSkillPackagePayload({
  manifest: { commandName: '/local-fixture', displayName: 'Fixture', description: 'Fixture', category: 'fixture', author: 'fixture' },
  instructions: 'Inert fixture only.', input_schema: {}, output_schema: {}, execution_type: 'prompt',
  sanitized_config: { apiKey: 'env://FIXTURE_REF' },
  orchestration: { stages: [{ id: 'result', type: 'output', title: 'No execution' }], maxModelCalls: 0, maxToolCalls: 0 },
  provenance: { kind: 'internal_original', sourceName: 'fixture', license: 'Internal' },
});
const state = { package: { id: packageId, updated_at: observedAt, metadata: {} },
  version: { id: versionId, package_id: packageId, status: 'released', payload, payload_hash: contract.skillPayloadHash(payload), updated_at: observedAt }, rpcs: [], rpcError: null };
const database = {
  from(table) {
    const filters = {};
    const query = { select() { return query; }, eq(key, value) { filters[key] = value; return query; }, async maybeSingle() {
      const value = table === 'skill_packages' ? state.package : state.version;
      return { data: Object.entries(filters).every(([key, entry]) => value[key] === entry) ? value : null, error: null };
    } };
    return query;
  },
  async rpc(name, args) { state.rpcs.push({ name, args }); return { data: state.rpcError ? null : { ok: true }, error: state.rpcError }; },
};
const repository = load('src/lib/server/skill-package-repository.ts', {
  '@/lib/server/skill-package-contract': contract, '@/lib/server/skill-admin-edit-preservation': preservation,
  '@/lib/server/skill-policy': {}, '@/storage/database/supabase-client': { getSupabaseAdminClient: () => database },
});
const action = { action: 'save-draft', packageId, baseVersionId: versionId, versionId: null, expectedUpdatedAt: observedAt,
  slug: 'local-fixture', displayName: 'Fixture', summary: 'Fixture', origin: 'custom', visibility: 'private', runtimeKind: 'prompt',
  payload: contract.sanitizeSkillAdminPayload(payload), metadata: {}, semver: '1.0.1', schemaVersion: '1.0.0' };
await repository.executeAdminSkillAction(action, 'fixture-actor');
assert.equal(state.rpcs[0].name, 'create_skill_package_next_draft');
assert.equal(state.rpcs[0].args.p_base_version_id, versionId);
assert.equal(state.rpcs[0].args.p_expected_package_updated_at, observedAt);
assert.equal('p_expected_updated_at' in state.rpcs[0].args, false);
assert.equal('p_version_id' in state.rpcs[0].args, false);
assert.equal(state.rpcs[0].args.p_payload.sanitized_config.apiKey, 'env://FIXTURE_REF');

state.version.status = 'draft';
await repository.executeAdminSkillAction({ ...action, versionId }, 'fixture-actor');
assert.equal(state.rpcs[1].name, 'save_skill_package_draft');
assert.equal(state.rpcs[1].args.p_expected_updated_at, observedAt);
assert.equal(state.rpcs[1].args.p_version_id, versionId);
await assert.rejects(repository.executeAdminSkillAction({ ...action, expectedUpdatedAt: null }, 'fixture-actor'), { code: 'SKILL_OPERATION_INVALID' });
await assert.rejects(repository.executeAdminSkillAction({ ...action, baseVersionId: '33333333-3333-4333-8333-333333333333' }, 'fixture-actor'), { code: 'SKILL_OPERATION_INVALID' });
await assert.rejects(repository.executeAdminSkillAction({ ...action, expectedUpdatedAt: '2026-09-02T11:00:00.000Z' }, 'fixture-actor'), { code: 'SKILL_CONFLICT' });
assert.equal(state.rpcs.length, 2);

state.rpcError = { code: '40001' };
await assert.rejects(repository.executeAdminSkillAction(action, 'fixture-actor'), { code: 'SKILL_CONFLICT' });
state.rpcError = { code: '42883' };
await assert.rejects(repository.executeAdminSkillAction(action, 'fixture-actor'), { code: 'MIGRATION_NOT_READY' });
assert.equal(state.rpcs.length, 4);
assert.ok(state.rpcs.slice(2).every((call) => call.name === 'create_skill_package_next_draft'));
console.log(JSON.stringify({ passed: true, groups: 7, actualRepositoryFunction: true, oldDraftCasPreserved: true,
  nextDraftPackageCasForwarded: true, redactedValuesRestoredServerSide: true, missingRpcDoesNotFallback: true, realDatabaseWrites: 0 }));
