import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateMarker = 'FIXTURE_PRIVATE_DATA_MUST_NOT_ESCAPE';
const state = { network: 0, writes: 0, auditCalls: 0, reads: [], capabilityCalls: [], failTable: '', truncate: false, changeCount: false, denied: '', owner: true, legacy: false, releaseError: '', missingRelease: '', sourceError: false };
const fixtures = {
  agents: [
    { id: 'agent-b', name: 'B', category: '公开', is_active: true, user_access: 'available', sort_order: 1, config_revision: 4, source: 'llm', model: 'example-model', model_id: 'model-a', system_prompt: privateMarker, coze_coding_api_url: 'https://provider.invalid/' + privateMarker, coze_coding_api_token: privateMarker, updated_by: privateMarker, deleted_at: null },
    { id: 'agent-a', name: 'A', category: '自用', is_active: true, user_access: 'available', sort_order: 0, config_revision: 2, source: 'llm', model: 'example-model', system_prompt: privateMarker + '-2', output_style: { privatePrompt: privateMarker }, deleted_at: null },
    { id: 'agent-trash', name: 'Trash', deleted_at: '2026-01-01' },
  ],
  categories: [{ id: 'public', name: '公开', is_active: true, visibility: 'normal', sort_order: 0 }, { id: 'private', name: '自用', is_active: true, visibility: 'private', sort_order: 1 }],
  member_permission_profiles: [
    { profile_key: 'registered_basic', version: 2, name: '注册基础', is_active: true, is_selectable: false, membership_status: 'trial', duration_days: 7, credits: '10.000000', cash_amount: '0.00', sort_order: 0, feature_navigation_keys: ['marketplace'], agent_navigation_keys: ['task:文案创作'], updated_by: privateMarker },
    { profile_key: 'internal_full', version: 1, name: '内部', is_active: true, is_selectable: false, membership_status: 'active', duration_days: 0, credits: 0, cash_amount: 0, sort_order: 1, feature_navigation_keys: ['marketplace', 'unknown-key'], agent_navigation_keys: ['自用'] },
    { profile_key: 'paid', version: 3, name: '会员', is_active: true, is_selectable: true, membership_status: 'active', duration_days: 365, credits: 200, cash_amount: 50, sort_order: 2, feature_navigation_keys: ['marketplace', 'cover'], agent_navigation_keys: ['task:文案创作'] },
    { profile_key: 'retired', version: 1, name: '停用', is_active: false, is_selectable: true },
  ],
  member_permission_resources: [
    { resource_type: 'feature', resource_key: 'marketplace', label: '广场', route: '/?token=' + privateMarker, description: privateMarker, sort_order: 0 },
    { resource_type: 'agent', resource_key: 'task:文案创作', label: '文案', route: null, sort_order: 1 },
    { resource_type: 'feature', resource_key: 'unknown-key', label: '未知', route: null, sort_order: 2 },
  ],
};
const pool = {
  release: { id: 'pool-release-one', release_version: 4, snapshot_sha256: 'a'.repeat(64), status: 'published', created_by: privateMarker },
  snapshot: { models: [{ id: 'model-a', kind: 'agent', name: '模型 A', modelName: 'model-a', provider: 'example', protocol: 'openai', endpoint: 'https://provider.invalid/' + privateMarker, credentialRef: 'secret://' + privateMarker, catalogState: 'enabled', sortOrder: 0, capabilities: {}, pricing: {}, configuration: { metadata: privateMarker } }] },
};
const workspace = {
  release: { id: 'workspace-release-one', release_version: 3, snapshot_sha256: 'b'.repeat(64), status: 'published', created_by: privateMarker },
  snapshot: { modelPoolRelease: { releaseId: 'pool-release-one', snapshotSha256: 'a'.repeat(64) }, surfaces: { 'storyboard-video': { kind: 'video', assignedModelIds: ['video-a', 'video-b'], orderedModelIds: ['video-b', 'video-a'] } } },
};
function query(table) {
  const predicates = [];
  const orders = [];
  let columns = [];
  let first = 0;
  let last = 499;
  const read = () => {
    if (state.failTable === table) throw new Error(privateMarker);
    let found = fixtures[table].filter(row => predicates.every(predicate => predicate(row)));
    found = [...found].sort((left, right) => {
      for (const key of orders) {
        if (left[key] < right[key]) return -1;
        if (left[key] > right[key]) return 1;
      }
      return 0;
    });
    state.reads.push({ table, columns: [...columns], first, last });
    const count = found.length + (state.changeCount && first > 0 ? 1 : 0);
    const selected = found.slice(first, state.truncate ? Math.min(first + 100, last + 1) : last + 1).map(row => Object.fromEntries(columns.map(key => [key, row[key] ?? null])));
    return { data: selected, count, error: null };
  };
  return {
    select(value) { assert.notEqual(value, '*'); columns = value.split(','); assert.ok(!columns.some(key => /api_key|api_token|created_by|updated_by|user_id/u.test(key)), 'no secret or user identity selection'); return this; },
    order(key) { orders.push(key); return this; },
    eq(key, value) { predicates.push(row => row[key] === value); return this; },
    is(key, value) { predicates.push(row => (row[key] ?? null) === value); return this; },
    range(start, end) { first = start; last = end; return this; },
    abortSignal() { return this; },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); },
    insert() { state.writes++; throw new Error('WRITES_FORBIDDEN'); },
    update() { state.writes++; throw new Error('WRITES_FORBIDDEN'); },
    upsert() { state.writes++; throw new Error('WRITES_FORBIDDEN'); },
    delete() { state.writes++; throw new Error('WRITES_FORBIDDEN'); },
  };
}
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, Date, URL, Set, Map, Promise, JSON, Object, Number, Array, String, Error, AbortSignal,
    process: { env: { COZE_SUPABASE_URL: 'https://user:' + privateMarker + '@database.invalid/base?token=' + privateMarker, SHARED_CONFIGURATION_ID: 'shared-test' } },
    fetch() { state.network++; throw new Error('REAL_NETWORK_FORBIDDEN'); },
    require(name) {
      if (name === 'server-only') return {};
      if (name === 'node:crypto') return crypto;
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => ({ from: query }) };
      if (name === '@/storage/database/configuration-source') return {
        configurationSourceStatus() { if (state.sourceError) throw new Error(privateMarker); return { configuration: 'shared-cloud', businessData: 'cloud', sharedTables: ['agents', 'categories'], automaticCodeDeployment: false }; },
        sharedConfigurationEnabled: () => false,
      };
      if (name === '@/lib/server/platform-configuration-admin') return { readCurrentPlatformConfiguration: async kind => {
        if (state.releaseError === kind) throw new Error(privateMarker);
        if (state.missingRelease === kind) return null;
        return structuredClone(kind === 'model-pool' ? pool : workspace);
      } };
      if (name === '@/lib/server/admin-governance-authority') return { authorizeAdminCapability: async (_request, permission, options) => {
        state.capabilityCalls.push({ permission, ...options });
        if (options.requireStepUp) state.auditCalls++;
        if (state.denied === permission) return { ok: false, response: Response.json({ code: 'ADMIN_STEP_UP_REQUIRED' }, { status: 428 }) };
        return { ok: true, access: { adminLevel: state.owner ? 'super_admin' : 'admin', profileActive: true, revision: state.legacy ? 0 : 1, checksum: state.legacy ? 'legacy-schema-absent' : 'valid' } };
      } };
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts');
      throw new Error('UNEXPECTED_DEPENDENCY:' + name);
    },
  }, { filename: relative });
  cache.set(relative, module.exports);
  return module.exports;
}
const service = load('src/lib/server/configuration-identity.ts');
const route = load('src/app/api/admin/configuration-identity/route.ts');
const request = () => new Request('http://fixture.invalid/api/admin/configuration-identity');
const digest = section => section.sha256;
const baseline = await service.readConfigurationIdentity();
assert.equal(baseline.status, 'verified');
assert.equal(baseline.consistency, 'independent-read-observations');
assert.equal(baseline.agents.count, 2);
assert.equal(baseline.categories.count, 2);
assert.equal(baseline.membershipPackages.count, 3, 'system non-selectable profiles are included');
assert.ok(baseline.membershipPackages.items.some(item => item.key === 'internal_full' && !item.isSelectable));
assert.ok(baseline.membershipPackages.items.find(item => item.key === 'internal_full').ignoredFeatureNavigationKeys.includes('unknown-key'));
assert.ok(baseline.membershipPackages.resourceDrift.unknownInDatabase.includes('feature:unknown-key'));
assert.ok(baseline.membershipPackages.resourceDrift.missingFromDatabase.length > 0);
assert.equal(baseline.modelPoolRelease.physicalBindingReadiness, 'not-evaluated');
assert.ok(!JSON.stringify(baseline).includes(privateMarker), 'prompt, credential, metadata, actor and URL payloads do not escape');
assert.deepEqual(Object.keys(baseline.agents.items[0]).sort(), ['id', 'name', 'category', 'isActive', 'userAccess', 'sortOrder', 'revision', 'promptSha256', 'configurationSha256', 'displaySha256', 'modelBinding'].sort());
assert.equal(service.configurationIdentitySha256({ b: [2, 3], a: 1 }), service.configurationIdentitySha256({ a: 1, b: [2, 3] }));
assert.notEqual(service.configurationIdentitySha256([1, 2]), service.configurationIdentitySha256([2, 1]));
fixtures.agents.reverse();
fixtures.agents.find(row => row.id === 'agent-a').config_revision++;
fixtures.member_permission_profiles[0].version++;
pool.release.id = 'pool-release-two';
pool.release.release_version++;
workspace.release.id = 'workspace-release-two';
workspace.snapshot.modelPoolRelease.releaseId = 'pool-release-two';
const provenanceOnly = await service.readConfigurationIdentity();
for (const name of ['agents', 'categories', 'membershipPackages', 'modelPoolRelease', 'workspaceModelRelease']) assert.equal(digest(provenanceOnly[name]), digest(baseline[name]), name + ': provenance does not alter semantic identity');
fixtures.agents.find(row => row.id === 'agent-a').system_prompt += '!';
const promptChanged = await service.readConfigurationIdentity();
assert.notEqual(digest(promptChanged.agents), digest(baseline.agents));
assert.equal(promptChanged.agents.items.find(row => row.id === 'agent-a').configurationSha256, baseline.agents.items.find(row => row.id === 'agent-a').configurationSha256);
fixtures.agents.find(row => row.id === 'agent-a').temperature = 0.8;
const configChanged = await service.readConfigurationIdentity();
assert.notEqual(digest(configChanged.agents), digest(promptChanged.agents));
fixtures.member_permission_resources[0].sort_order++;
assert.notEqual(digest((await service.readConfigurationIdentity()).membershipPackages), digest(baseline.membershipPackages));
workspace.snapshot.surfaces['storyboard-video'].orderedModelIds.reverse();
assert.notEqual(digest((await service.readConfigurationIdentity()).workspaceModelRelease), digest(baseline.workspaceModelRelease));
pool.snapshot.models[0].endpoint += '/new';
assert.notEqual(digest((await service.readConfigurationIdentity()).modelPoolRelease), digest(baseline.modelPoolRelease));
state.failTable = 'categories';
const partial = await service.readConfigurationIdentity();
assert.equal(partial.status, 'incomplete');
assert.equal(partial.categories.status, 'unavailable');
assert.equal(partial.categories.sha256, null);
assert.equal(partial.agents.status, 'verified');
assert.ok(!JSON.stringify(partial).includes(privateMarker), 'raw errors never escape');
state.failTable = '';
state.releaseError = 'model-pool';
state.missingRelease = 'workspace-models';
const releases = await service.readConfigurationIdentity();
assert.equal(releases.modelPoolRelease.status, 'unavailable');
assert.equal(releases.workspaceModelRelease.status, 'missing');
state.releaseError = '';
state.missingRelease = '';
state.sourceError = true;
assert.equal((await service.readConfigurationIdentity()).configurationSource.status, 'unavailable');
state.sourceError = false;
const originalAgents = fixtures.agents;
fixtures.agents = Array.from({ length: 501 }, (_, index) => ({ ...originalAgents.find(row => row.id === 'agent-a'), id: 'page-' + String(index).padStart(3, '0') }));
assert.equal((await service.readConfigurationIdentity()).agents.count, 501, 'catalog pages are all included');
state.truncate = true;
assert.equal((await service.readConfigurationIdentity()).agents.status, 'unavailable', 'truncation never yields a verified partial hash');
state.truncate = false;
state.changeCount = true;
assert.equal((await service.readConfigurationIdentity()).agents.status, 'unavailable', 'count drift never yields a verified partial hash');
state.changeCount = false;
fixtures.agents = originalAgents;
state.reads = [];
state.owner = false;
assert.equal((await route.GET(request())).status, 403);
assert.equal(state.reads.length, 0, 'ordinary admin cannot observe even hashed private rows');
state.owner = true;
state.legacy = true;
assert.equal((await route.GET(request())).status, 403);
assert.equal(state.reads.length, 0, 'legacy role fallback is not owner evidence');
state.legacy = false;
for (const permission of ['agents.view', 'models.view', 'members.view', 'prompts.view', 'internal_tools.manage']) {
  state.denied = permission;
  assert.equal((await route.GET(request())).status, 428);
  assert.equal(state.reads.length, 0, permission + ': denied checks precede data access');
}
state.denied = '';
state.capabilityCalls = [];
const response = await route.GET(request());
assert.equal(response.status, 200);
assert.match(response.headers.get('cache-control'), /private, no-store/u);
assert.equal(response.headers.get('vary'), 'Authorization, Cookie');
assert.ok(!(await response.text()).includes(privateMarker));
assert.deepEqual(state.capabilityCalls.map(row => row.permission), ['agents.view', 'models.view', 'members.view', 'prompts.view', 'internal_tools.manage']);
assert.ok(state.capabilityCalls.filter(row => ['prompts.view', 'internal_tools.manage'].includes(row.permission)).every(row => row.requireStepUp === true));
assert.equal(state.network, 0);
assert.equal(state.writes, 0);
console.log(JSON.stringify({ ok: true, suites: ['sanitized-readback', 'semantic-digests', 'active-system-profiles', 'stored-resource-drift', 'independent-source-failures', 'pagination-and-truncation', 'owner-and-step-up-gates'], realNetworkCalls: state.network, businessOrConfigurationWrites: state.writes, securityAudit: 'standard capability calls retained; mocked in zero-network test' }));
