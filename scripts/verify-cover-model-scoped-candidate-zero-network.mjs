import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';

// Execute the actual TS compatibility/admin/contract modules. Only source-file
// reads and this report use the host filesystem. All runtime I/O ports below
// are fixtures or fail closed; this is not PostgreSQL CAS/publication proof.
const sourceFiles = new Set([
  'src/lib/platform-configuration-contract.ts',
  'src/lib/server/platform-configuration-admin.ts',
  'src/lib/server/platform-configuration-compatibility.ts',
  'src/lib/server/platform-configuration-pending-credentials.ts',
  'src/lib/workspace-model-assignment-settings.ts',
  'src/lib/image-model-surface-order.ts',
  'src/lib/video-model-surface-order.ts',
  'src/lib/image-model-admin-fields.ts',
  'src/lib/image-model-extra-configuration.ts',
  'src/lib/image-provider-contract.ts',
  'src/lib/image-model-capabilities.ts',
]);
const clone = value => JSON.parse(JSON.stringify(value));
const payloadHash = value => {
  const sort = input => Array.isArray(input) ? input.map(sort) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
};
const actor = '10000000-0000-4000-8000-000000000001';
const otherActor = '10000000-0000-4000-8000-000000000002';
const llmId = '10000000-0000-4000-8000-000000000010';
const baseId = '10000000-0000-4000-8000-000000000100';
const oldSecret = 'fixture-old-secret-never-network';
const newSecret = 'fixture-new-secret-never-network';
const publishedRef = 'secret://fixture/published-image';
let state, calls, currentReads, switchBase, failPhysicalReads, failReadback, failPreview;
let forbiddenIoAttempts = 0;
const forbidden = name => () => { forbiddenIoAttempts++; throw Error(`FORBIDDEN_RUNTIME_IO:${name}`); };
const modules = new Map(), cases = [], logs = [];
const sqlError = message => ({ data: null, error: { code: 'P0001', message } });
const db = {
  from(table) {
    if (!['model_pool_config_releases', 'workspace_model_config_releases', ...Object.keys(state.physical)].includes(table)) {
      throw Error(`UNFIXTURED_TABLE:${table}`);
    }
    const filters = [];
    let single = false;
    const query = {
      select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
      limit() { return query; }, order() { return query; }, maybeSingle() { single = true; return query; },
      insert: forbidden('direct insert'), update: forbidden('direct update'), upsert: forbidden('direct upsert'), delete: forbidden('direct delete'),
      then(resolve, reject) {
        try {
          calls.push({ type: 'read', table, filters: clone(filters) });
          if (table in state.physical && failPhysicalReads) throw Error('fixture physical reads unavailable');
          if (table === 'model_pool_config_releases' && failReadback && filters.some(([key]) => key === 'id')) {
            throw Error('fixture candidate readback unavailable');
          }
          let rows = table === 'model_pool_config_releases' ? state.releases : table === 'workspace_model_config_releases' ? [] : state.physical[table];
          rows = rows.filter(row => filters.every(([key, value]) => row[key] === value));
          if (table === 'model_pool_config_releases' && filters.some(([key]) => key === 'is_current')) {
            currentReads++;
            if (switchBase && currentReads === 2) rows = rows.map(row => ({ ...row, ...switchBase }));
          }
          return Promise.resolve({ data: clone(single ? rows[0] || null : rows), error: null }).then(resolve, reject);
        } catch (error) {
          return Promise.resolve({ data: null, error: { message: error.message } }).then(resolve, reject);
        }
      },
    };
    return query;
  },
  async rpc(name, input) {
    calls.push({ type: 'rpc', name, input: clone(input) });
    if (name === 'read_platform_model_mutation_receipt') {
      const receipt = state.receipts.find(row => row.actor === input.p_actor_id && row.requestId === input.p_request_id);
      if (!receipt) return { data: null, error: null };
      if (receipt.payloadHash !== payloadHash(input.p_request_payload)) return sqlError('PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT');
      return { data: { candidateId: receipt.id, state: 'staged', hasStagedCredentials: state.pending.some(row => row.releaseId === receipt.id) }, error: null };
    }
    if (name === 'read_platform_model_pending_credential_metadata') {
      if (failPreview) return sqlError('fixture preview unavailable');
      return { data: state.pending.filter(row => row.releaseId === input.p_release_id).map(({ secret, releaseId, ...metadata }) => metadata), error: null };
    }
    if (name === 'stage_model_pool_candidate_with_credentials_atomic') {
      // Capture the real application arguments. This fixture deliberately does
      // not invent an image SQL transaction CAS which the database lacks.
      const current = state.releases.find(row => row.is_current && row.status === 'published');
      if (input.p_validation_result.operation === 'video-upsert-only') {
        assert.equal(input.p_parent_release_id, current?.id);
        assert.equal(input.p_validation_result.baseSnapshotSha256, current?.snapshot_sha256);
      }
      const release = candidate(input);
      for (const change of input.p_credential_changes) {
        assert.ok(release.snapshot.models.some(row => `${row.configuration.legacyTable}:${row.configuration.legacyId}` === change.model_key && row.credentialRef === change.credential_ref));
        const active = state.active[change.model_key];
        state.pending.push({ releaseId: release.id, modelKey: change.model_key, credentialRef: change.credential_ref, secret: change.secret_value,
          pendingRevision: randomUUID(), expectedExists: Boolean(active), expectedRevision: active?.revision || null, state: 'pending' });
      }
      state.receipts.push({ actor: input.p_actor_id, requestId: input.p_request_id, payloadHash: payloadHash(input.p_request_payload), id: release.id });
      return { data: clone(release), error: null };
    }
    if (name === 'create_platform_configuration_candidate_atomic') return { data: clone(candidate(input)), error: null };
    throw Error(`UNFIXTURED_RPC:${name}`);
  },
};
function candidate(input) {
  const row = { id: randomUUID(), release_version: state.releases.length + 1, snapshot: clone(input.p_snapshot), snapshot_sha256: input.p_snapshot_sha256,
    validation_result: clone(input.p_validation_result), status: input.p_status, is_current: false, parent_release_id: input.p_parent_release_id, created_by: input.p_actor_id };
  state.releases.push(row);
  return row;
}
function load(relative) {
  relative = relative.replaceAll('\\', '/');
  assert.ok(sourceFiles.has(relative), `UNFIXTURED_SOURCE:${relative}`);
  if (modules.has(relative)) return modules.get(relative).exports;
  const module = { exports: {} };
  modules.set(relative, module);
  const localRequire = name => {
    if (name === 'node:crypto') return { createHash, randomUUID };
    if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => db };
    if (name === '@/lib/provider-secret') return { resolveProviderSecret: forbidden('provider secret') };
    if (name === '@/lib/llm-model-validation-gate') return { LlmModelValidationError: class extends Error {}, llmModelValidationConfigurationHash: forbidden('LLM validation') };
    if (name === '@/lib/server/llm-vision-validation') return Object.fromEntries(['assertFreshVisionEvidence', 'visionCandidateBinding', 'visionCapabilityTransitions', 'visionConfigurationHash'].map(key => [key, forbidden(key)]));
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('.')) {
      const source = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
      return load(path.posix.extname(source) ? source : `${source}.ts`);
    }
    throw Error(`UNFIXTURED_IMPORT:${name}`);
  };
  const js = ts.transpileModule(fs.readFileSync(relative, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: localRequire, URL, TextEncoder,
    process: Object.freeze({ env: Object.freeze({}) }), fetch: forbidden('fetch'),
    console: { log: (...items) => logs.push(items.join(' ')), error: (...items) => logs.push(items.join(' ')) },
  }, { filename: relative });
  return module.exports;
}
const contract = load('src/lib/platform-configuration-contract.ts');
const admin = load('src/lib/server/platform-configuration-admin.ts');
const compatibility = load('src/lib/server/platform-configuration-compatibility.ts');
const helper = load('src/lib/server/platform-configuration-pending-credentials.ts');
const { imageModelAdminMetadata } = load('src/lib/image-model-admin-fields.ts');
const entry = (kind, id, table) => ({ id: table === 'llm_models' ? `llm:${id}` : id, kind, name: `Published ${id}`, modelName: id,
  provider: 'published-provider', protocol: 'published-protocol', endpoint: `https://published.invalid/${id}`, credentialRef: `secret://published/${id}`,
  catalogState: 'enabled', sortOrder: 7, capabilities: { original: true }, pricing: { cost: 1, selling: 2 },
  configuration: { legacyTable: table, legacyId: id, userAccess: 'published-access', custom: 'published-only' } });
function reset({ noCurrent = false, unbound = false } = {}) {
  const image = { ...entry('image', 'image-edit', 'cover_models'), credentialRef: publishedRef };
  if (unbound) delete image.credentialRef;
  const snapshot = contract.normalizeModelPoolSnapshot({ schema: 'model-pool-config/v1', models: [image, entry('image', 'image-other', 'cover_models'),
    entry('video', 'video-other', 'video_models'), entry('agent', llmId, 'llm_models')] });
  const row = (id, extra = {}) => ({ id, name: `Live ${id}`, model_name: `live-${id}`, provider: 'live-provider', protocol_type: 'images_generations',
    api_endpoint: `https://live-drift.invalid/${id}`, api_key: oldSecret, api_protocol_config: { protocol: 'images_generations', liveMetadata: true },
    is_active: false, supports_image_input: true, sort_order: 99, user_access: 'live-access', cost_price: 4, selling_price: 8,
    icon_url: '/fixture-live-icon.png', admin_notes: 'live-admin-note', ...extra });
  state = { releases: noCurrent ? [] : [{ id: baseId, release_version: 1, snapshot, snapshot_sha256: contract.configurationSha256(snapshot), is_current: true, status: 'published' }],
    physical: { cover_models: [row('image-edit'), row('image-other'), row('unpublished-physical-image')],
      video_models: [row('video-other', { protocol_type: 'video-fixture', price_per_use: 13 })],
      llm_models: [row(llmId, { protocol_type: 'openai_chat', cost_per_use: 17 })], chat_models: [] },
    active: { 'cover_models:image-edit': { secret: oldSecret, revision: '10000000-0000-4000-8000-000000000200' } }, pending: [], receipts: [] };
  calls = []; currentReads = 0; switchBase = null; failPhysicalReads = failReadback = failPreview = false;
  return clone(snapshot);
}
function imageRequest({ id, values = {}, method = id ? 'PUT' : 'POST', requestId = randomUUID(), actorId = actor } = {}) {
  const patch = id ? values : { name: 'New image', model_name: 'new-image', provider: 'fixture-provider', protocol_type: 'images_generations',
    api_endpoint: 'https://new-image.invalid/v1', api_key: newSecret, cost_price: 1, selling_price: 2, ...values };
  return { actorId, requestId, requestPayload: { method, modelType: 'drawing', ...(id ? { targetId: id } : {}), body: clone(patch) },
    table: 'cover_models', ...(id ? { id } : {}), values: patch, changeNote: 'zero-network scoped image fixture' };
}
const stage = input => compatibility.stageLegacyModelPoolUpsert(input);
const stages = () => calls.filter(call => call.name === 'stage_model_pool_candidate_with_credentials_atomic');
const byId = (snapshot, id) => snapshot.models.find(row => row.id === id);
const assertOnlyTarget = (before, after, targetId) => {
  assert.deepEqual(clone(after.models.filter(row => row.id !== targetId)), clone(before.models.filter(row => row.id !== targetId)));
  const beforeOrder = before.models.filter(row => row.id !== targetId).map(row => row.id);
  assert.deepEqual(clone(after.models.filter(row => row.id !== targetId).map(row => row.id)), beforeOrder);
  for (const model of before.models.filter(row => row.id !== targetId)) assert.equal(contract.configurationSha256(byId(after, model.id)), contract.configurationSha256(model));
};
const assertNoUnrelatedPhysicalReads = table => {
  for (const call of calls.filter(call => call.type === 'read' && call.table in state.physical)) {
    assert.equal(call.table, table);
    assert.ok(call.filters.some(([key]) => key === 'id'), 'scoped upserts never scan a full physical model pool');
  }
};
const check = async (name, work) => { await work(); cases.push(name); console.log(`PASS ${name}`); };
const rejectCode = (work, code) => assert.rejects(work, error => error.code === code);

await check('image without published current fails closed before staging', async () => {
  reset({ noCurrent: true });
  await rejectCode(() => stage(imageRequest()), 'MODEL_POOL_CURRENT_RELEASE_REQUIRED');
  assert.equal(stages().length, 0); assert.equal(state.releases.length, 0); assert.equal(state.pending.length, 0);
});
await check('new image adds exactly one stable pending model; unrelated live price endpoint and permission drift stays outside candidate', async () => {
  const before = reset(), physical = clone(state.physical), active = clone(state.active), input = imageRequest();
  const out = await stage(input), staged = stages()[0].input;
  assert.equal(out.legacyId, `pending-cover-model-${helper.modelMutationLegacyId(actor, input.requestId, 'cover_models')}`);
  assert.equal(out.modelId, out.legacyId); assertOnlyTarget(before, out.release.snapshot, out.modelId);
  assert.equal(out.release.snapshot.models.length, before.models.length + 1);
  assert.equal(staged.p_parent_release_id, baseId); assert.equal(staged.p_validation_result.baseSnapshotSha256, contract.configurationSha256(before));
  assert.equal(staged.p_validation_result.operation, undefined); assert.equal(out.release.is_current, false);
  assert.deepEqual(state.physical, physical); assert.deepEqual(state.active, active); assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].secret, newSecret); assert.equal(out.preview.credentialChanges[0].pendingRevision, state.pending[0].pendingRevision);
  assert.ok(!JSON.stringify(out).includes(newSecret)); assertNoUnrelatedPhysicalReads('cover_models');
});
for (const method of ['PUT', 'POST']) await check(`${method} image rename changes only published target name and preserves its complete logical contract`, async () => {
  const before = reset(), out = await stage(imageRequest({ id: 'image-edit', method, values: { name: 'Renamed target', api_key: '' } }));
  assertOnlyTarget(before, out.release.snapshot, 'image-edit');
  const changed = byId(out.release.snapshot, 'image-edit');
  assert.equal(out.legacyId, 'image-edit'); assert.equal(out.modelId, 'image-edit'); assert.equal(changed.name, 'Renamed target');
  const expected = clone(before); byId(expected, 'image-edit').name = 'Renamed target';
  assert.deepEqual(clone(out.release.snapshot), expected);
  assert.equal(changed.credentialRef, publishedRef); assert.equal(state.pending.length, 0); assertNoUnrelatedPhysicalReads('cover_models');
});
const completeImageProtocol = () => ({ protocol: 'images_generations', reference_transport: 'multipart',
  submit: { path: '/v1/images', method: 'POST', response_path: ['data', 'url'] },
  poll: { path: '/v1/images/{taskId}', success_statuses: ['completed'], interval_ms: 1500 },
  resolution_prices: { '2K': 0.8 }, resolution_cost_prices: { '2K': 0.4 },
  capabilities: ['image_input', { ratio: '16:9', enabled: true }], max_reference_images: 4, max_tokens: 4096 });
await check('name-only full image form preserves published protocol while raw-only 4K and absent-note defaults stay outside the candidate', async () => {
  const before = reset(), live = state.physical.cover_models[0];
  const logicalProtocol = { ...completeImageProtocol(), resolution_options: ['1K', '2K'] };
  for (let index = 0; index < 39; index++) state.releases[0].snapshot.models.push(entry('image', 'logical-extra-' + index, 'cover_models'));
  live.api_protocol_config = { ...clone(logicalProtocol), resolution_options: ['1K', '2K', '4K'], resolution_prices: { ...logicalProtocol.resolution_prices, '4K': .1 }, resolution_cost_prices: { ...logicalProtocol.resolution_cost_prices, '4K': .05 } }; delete live.admin_notes;
  const logical = byId(state.releases[0].snapshot, live.id); logical.configuration.protocolConfig = clone(logicalProtocol); logical.capabilities.protocol = clone(logicalProtocol);
  state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot); state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  Object.assign(before, clone(state.releases[0].snapshot));
  const form = { ...clone(live), name: 'Name-only form edit', api_key: '', admin_notes: '' }; delete form.id;
  const metadata = imageModelAdminMetadata(form, live.api_protocol_config);
  assert.equal(metadata.ok, true); assert.equal(metadata.fields.api_protocol_config.admin_notes, '', 'reproduce the actual metadata helper empty-note input');
  const sanitized = Object.fromEntries(['name', 'model_name', 'provider', 'api_endpoint', 'api_key', 'cost_price', 'selling_price', 'supports_image_input'].map(key => [key, form[key]]));
  const input = imageRequest({ id: live.id, values: { ...sanitized, ...metadata.fields, is_active: true, is_hidden: false } }); input.requestPayload.body = clone(form);
  const originalInput = clone(input), physical = clone(state.physical), out = await stage(input), model = byId(out.release.snapshot, live.id);
  assertOnlyTarget(before, out.release.snapshot, live.id); assert.deepEqual(clone(input), originalInput); assert.deepEqual(state.physical, physical);
  for (const config of [model.configuration.protocolConfig, model.capabilities.protocol]) {
    assert.equal(Object.hasOwn(config, 'admin_notes'), false); assert.deepEqual(clone(config), logicalProtocol);
    assert.equal(contract.configurationSha256(config), contract.configurationSha256(logicalProtocol));
  }
  const expected = clone(before); byId(expected, live.id).name = form.name; assert.deepEqual(clone(out.release.snapshot), expected);
  assert.equal(before.models.length, 43); assert.equal(out.release.snapshot.models.length, 43);
  assert.equal(model.credentialRef, publishedRef); assert.equal(state.pending.length, 0);
});
await check('existing nonempty or empty image note remains an explicit empty string when the operator clears it', async () => {
  for (const previousNote of ['Existing note to clear', '']) {
    const before = reset(), live = state.physical.cover_models[0];
    live.api_protocol_config = { ...completeImageProtocol(), admin_notes: previousNote };
    const logical = byId(state.releases[0].snapshot, live.id); logical.configuration.protocolConfig = clone(live.api_protocol_config); logical.capabilities.protocol = clone(live.api_protocol_config);
    state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot); state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
    Object.assign(before, clone(state.releases[0].snapshot));
    const form = { name: 'Clear existing note', admin_notes: '', api_protocol_config: clone(live.api_protocol_config) };
    const metadata = imageModelAdminMetadata(form, live.api_protocol_config); assert.equal(metadata.ok, true);
    const out = await stage(imageRequest({ id: live.id, values: { name: form.name, ...metadata.fields } }));
    assertOnlyTarget(before, out.release.snapshot, live.id);
    for (const config of [byId(out.release.snapshot, live.id).configuration.protocolConfig, byId(out.release.snapshot, live.id).capabilities.protocol]) {
      assert.equal(Object.hasOwn(config, 'admin_notes'), true); assert.equal(config.admin_notes, '');
      assert.deepEqual(clone(config), { ...live.api_protocol_config, admin_notes: '' });
    }
  }
});
await check('new image create retains the metadata helper empty-note default and complete supplied protocol', async () => {
  const before = reset(), form = { admin_notes: '', api_protocol_config: completeImageProtocol() };
  const metadata = imageModelAdminMetadata(form); assert.equal(metadata.ok, true);
  const out = await stage(imageRequest({ values: metadata.fields })), model = byId(out.release.snapshot, out.modelId);
  assertOnlyTarget(before, out.release.snapshot, out.modelId);
  for (const config of [model.configuration.protocolConfig, model.capabilities.protocol]) {
    assert.equal(Object.hasOwn(config, 'admin_notes'), true); assert.equal(config.admin_notes, '');
    assert.deepEqual(clone(config), { ...form.api_protocol_config, admin_notes: '' });
  }
});
await check('empty-note normalization is image-only and leaves text and video protocol inputs intact', async () => {
  for (const [table, id] of [['video_models', 'video-other'], ['llm_models', llmId]]) {
    reset(); const live = state.physical[table][0], protocol = { ...clone(live.api_protocol_config), admin_notes: '' };
    const input = imageRequest({ id, values: { name: 'Other media edit', api_protocol_config: protocol } }); input.table = table;
    const out = await stage(input), model = byId(out.release.snapshot, table === 'llm_models' ? `llm:${id}` : id);
    assert.deepEqual(clone(model.configuration.protocolConfig), protocol); assert.deepEqual(clone(model.capabilities.protocol), protocol);
  }
});

function imageDeltaFixture() {
  reset(); const live = state.physical.cover_models[0], logical = byId(state.releases[0].snapshot, live.id);
  Object.assign(logical, { provider: live.provider, protocol: live.protocol_type, modelName: live.model_name, endpoint: live.api_endpoint });
  logical.capabilities.supportsImageInput = live.supports_image_input;
  const protocol = { ...completeImageProtocol(), resolution_options: ['1K', '2K'], extra_parameters: { quality: 'standard', logicalOnly: true }, marker: 5, flag: true };
  logical.configuration.protocolConfig = clone(protocol); logical.capabilities.protocol = clone(protocol);
  live.api_protocol_config = { ...clone(protocol), resolution_options: ['1K', '2K', '4K'], resolution_prices: { ...protocol.resolution_prices, '4K': .1 },
    resolution_cost_prices: { ...protocol.resolution_cost_prices, '4K': .05 }, extra_parameters: { quality: 'standard', physicalOnly: true }, untouchedPhysical: 'must-not-import' };
  delete live.admin_notes;
  state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot); state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  return { live, before: clone(state.releases[0].snapshot), logical: byId(state.releases[0].snapshot, live.id) };
}
function exactExpected(before, mutate) { const expected = clone(before); mutate(byId(expected, 'image-edit')); return contract.normalizeModelPoolSnapshot(expected); }
await check('explicit price and extra leaf intent updates both mirrors without importing raw 4K or raw-only siblings', async () => {
  const { live, before } = imageDeltaFixture(), protocol = clone(live.api_protocol_config);
  protocol.resolution_prices['2K'] = .9; protocol.extra_parameters.quality = 'high';
  const input = imageRequest({ id: live.id, values: { name: 'Leaf edit', api_protocol_config: protocol } }), inputBefore = clone(input), physical = clone(state.physical);
  const out = await stage(input), expected = exactExpected(before, model => { model.name = 'Leaf edit';
    for (const config of [model.configuration.protocolConfig, model.capabilities.protocol]) { config.resolution_prices['2K'] = .9; config.extra_parameters.quality = 'high'; } });
  assert.deepEqual(clone(out.release.snapshot), clone(expected)); assert.deepEqual(input, inputBefore); assert.deepEqual(state.physical, physical); assert.equal(state.pending.length, 0);
});
await check('arrays replace atomically and explicit deletions false zero null remain distinct in the logical protocol', async () => {
  const { live, before } = imageDeltaFixture(), protocol = clone(live.api_protocol_config);
  protocol.resolution_options = ['2K']; delete protocol.extra_parameters.quality; protocol.marker = null; protocol.flag = false; protocol.zero = 0;
  const out = await stage(imageRequest({ id: live.id, values: { api_protocol_config: protocol } }));
  const expected = exactExpected(before, model => { for (const config of [model.configuration.protocolConfig, model.capabilities.protocol]) {
    config.resolution_options = ['2K']; delete config.extra_parameters.quality; config.marker = null; config.flag = false; config.zero = 0;
  } });
  assert.deepEqual(clone(out.release.snapshot), clone(expected));
});
await check('removing raw-only nested leaves cannot synthesize empty logical objects and conflicting logical shapes fail closed', async () => {
  const { live, before } = imageDeltaFixture(); live.api_protocol_config.rawOnlyBranch = { leaf: true };
  const protocol = clone(live.api_protocol_config); delete protocol.rawOnlyBranch.leaf;
  const out = await stage(imageRequest({ id: live.id, values: { api_protocol_config: protocol } }));
  assert.deepEqual(clone(out.release.snapshot), before);
  const next = imageDeltaFixture();
  for (const config of [next.logical.configuration.protocolConfig, next.logical.capabilities.protocol]) config.extra_parameters = 'logical scalar';
  state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot); state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  const changed = clone(next.live.api_protocol_config); changed.extra_parameters.quality = 'high';
  await rejectCode(() => stage(imageRequest({ id: next.live.id, values: { api_protocol_config: changed } })), 'PLATFORM_CONFIGURATION_IMAGE_DELTA_SHAPE_CONFLICT');
  assert.equal(stages().length, 0); assert.equal(state.pending.length, 0);
});
await check('explicit scalar price sort and note changes alter only their corresponding logical paths', async () => {
  const { live, before } = imageDeltaFixture(), form = { ...clone(live), api_key: '', admin_notes: 'operator note', sort_order: 31, cost_price: 6, selling_price: 9 };
  delete form.id; const metadata = imageModelAdminMetadata(form, live.api_protocol_config); assert.equal(metadata.ok, true);
  const sanitized = { ...form, ...metadata.fields }; delete sanitized.admin_notes;
  const out = await stage(imageRequest({ id: live.id, values: sanitized }));
  const expected = exactExpected(before, model => { model.sortOrder = 31; model.pricing.cost = 6; model.pricing.selling = 9; model.configuration.adminNotes = 'operator note';
    model.configuration.protocolConfig.admin_notes = 'operator note'; model.capabilities.protocol.admin_notes = 'operator note'; });
  // Notes are stored in protocol JSON. No physical top-level note is synthesized.
  delete byId(expected, live.id).configuration.adminNotes;
  assert.deepEqual(clone(out.release.snapshot), clone(expected));
});
await check('server readiness and release catalog membership cannot be overwritten by an image form echo', async () => {
  const { live, before, logical } = imageDeltaFixture(); logical.catalogState = 'retired';
  for (const config of [logical.configuration.protocolConfig, logical.capabilities.protocol]) config.canary_verified = false;
  state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot); state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  Object.assign(before, clone(state.releases[0].snapshot));
  const protocol = { ...clone(live.api_protocol_config), canary_verified: true, __model_activation_gate: { state: 'pending' } };
  const out = await stage(imageRequest({ id: live.id, values: { name: 'Only rename', api_protocol_config: protocol, is_hidden: false } }));
  assert.deepEqual(clone(out.release.snapshot), clone(exactExpected(before, model => { model.name = 'Only rename'; })));
});
await check('image binding identity replacements require a separate isolated candidate before any stage or credential write', async () => {
  for (const field of ['provider', 'protocol_type', 'model_name', 'api_endpoint']) {
    const { live } = imageDeltaFixture(), values = { [field]: field === 'api_endpoint' ? 'https://new-binding.invalid/v1' : 'new-binding', api_key: newSecret };
    await rejectCode(() => stage(imageRequest({ id: live.id, values })), 'PLATFORM_CONFIGURATION_IMAGE_BINDING_CHANGE_UNSUPPORTED');
    assert.equal(stages().length, 0); assert.equal(state.pending.length, 0); assert.equal(state.releases.length, 1);
  }
});
await check('protocol parameter edits close when physical and published binding identities already disagree; metadata edits still preserve logical identity', async () => {
  const { live, before, logical } = imageDeltaFixture(); logical.provider = 'different-logical-provider';
  state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot); state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  Object.assign(before, clone(state.releases[0].snapshot)); const protocol = clone(live.api_protocol_config); protocol.extra_parameters.quality = 'high';
  await rejectCode(() => stage(imageRequest({ id: live.id, values: { api_protocol_config: protocol } })), 'PLATFORM_CONFIGURATION_IMAGE_PHYSICAL_BASE_CONFLICT');
  assert.equal(stages().length, 0); assert.equal(state.pending.length, 0);
  const out = await stage(imageRequest({ id: live.id, values: { name: 'Metadata only' } }));
  assert.deepEqual(clone(out.release.snapshot), clone(exactExpected(before, model => { model.name = 'Metadata only'; })));
});
await check('effective protocol aliases reference transport and request binding paths cannot switch existing image execution identity', async () => {
  const mutations = [
    protocol => { protocol.reference_transport = 'edits_multipart_array'; },
    protocol => { delete protocol.reference_transport; protocol.image_reference_transport = 'chat_inline_data'; },
    protocol => { delete protocol.protocol; protocol.protocol_type = 'images_edits'; },
    protocol => { delete protocol.protocol; protocol.image_protocol = 'google_generate_content'; },
    protocol => { protocol.submit_path = '/different-submit'; }, protocol => { protocol.poll_path = '/different-poll'; },
    protocol => { protocol.provider_contract = 'new-adapter'; },
  ];
  for (const mutate of mutations) {
    const { live } = imageDeltaFixture(), protocol = clone(live.api_protocol_config); mutate(protocol);
    await rejectCode(() => stage(imageRequest({ id: live.id, values: { api_protocol_config: protocol } })), 'PLATFORM_CONFIGURATION_IMAGE_BINDING_CHANGE_UNSUPPORTED');
    assert.equal(stages().length, 0); assert.equal(state.pending.length, 0);
  }
});
await check('missing physical published baseline and malformed identity or prototype JSON fail without stage RPC', async () => {
  reset(); state.physical.cover_models = state.physical.cover_models.filter(model => model.id !== 'image-edit');
  const complete = { name: 'No raw baseline', model_name: 'new', provider: 'p', api_endpoint: 'https://fixture.invalid/v1', api_protocol_config: { protocol: 'images_generations' } };
  await rejectCode(() => stage(imageRequest({ id: 'image-edit', values: complete })), 'PLATFORM_CONFIGURATION_IMAGE_PHYSICAL_BASE_NOT_FOUND');
  assert.equal(stages().length, 0);
  reset(); byId(state.releases[0].snapshot, 'image-edit').configuration.legacyId = 'foreign-legacy-id';
  state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  await rejectCode(() => stage(imageRequest({ id: 'image-edit', values: { name: 'Wrong mapping' } })), 'PLATFORM_CONFIGURATION_IMAGE_IDENTITY_CONFLICT');
  assert.equal(stages().length, 0); assert.equal(state.pending.length, 0);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const { live } = imageDeltaFixture(), protocol = JSON.parse('{' + JSON.stringify(key) + ':{"polluted":true},"protocol":"images_generations"}');
    await rejectCode(() => stage(imageRequest({ id: live.id, values: { api_protocol_config: protocol } })), 'PLATFORM_CONFIGURATION_IMAGE_DELTA_INVALID');
    assert.equal(stages().length, 0); assert.equal({}.polluted, undefined);
  }
});
await check('replacement secret with an unchanged canonical reference stages credentials without importing physical business drift', async () => {
  const { live, before, logical } = imageDeltaFixture(); logical.credentialRef = 'secret://platform-model/cover_models/image-edit';
  state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot); state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  Object.assign(before, clone(state.releases[0].snapshot)); const active = clone(state.active), physical = clone(state.physical);
  const out = await stage(imageRequest({ id: live.id, values: { api_key: newSecret } }));
  assert.deepEqual(clone(out.release.snapshot), before); assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].expectedRevision, active['cover_models:image-edit'].revision); assert.equal(state.pending[0].secret, newSecret);
  assert.deepEqual(state.active, active); assert.deepEqual(state.physical, physical); assert.ok(!JSON.stringify(out).includes(newSecret));
});

await check('no secret change never synthesizes a binding for a previously unbound image', async () => {
  const before = reset({ unbound: true }), out = await stage(imageRequest({ id: 'image-edit', values: { name: 'Unbound edit' } }));
  assertOnlyTarget(before, out.release.snapshot, 'image-edit'); assert.equal(byId(out.release.snapshot, 'image-edit').credentialRef, undefined);
  assert.equal(state.pending.length, 0);
});
await check('blank and masked secrets preserve the baseline binding and create no pending credential', async () => {
  for (const value of ['', '***', 'sk-***', 'configured', 'unchanged']) {
    reset(); const out = await stage(imageRequest({ id: 'image-edit', values: { name: 'Masked edit', api_key: value } }));
    assert.equal(byId(out.release.snapshot, 'image-edit').credentialRef, publishedRef); assert.equal(state.pending.length, 0);
  }
});
await check('real secret changes stay pending with original revision and leave active credentials and physical rows unchanged', async () => {
  const before = reset(), active = clone(state.active), physical = clone(state.physical);
  const out = await stage(imageRequest({ id: 'image-edit', values: { name: 'Rotate later', api_key: newSecret } }));
  assertOnlyTarget(before, out.release.snapshot, 'image-edit'); assert.deepEqual(state.active, active); assert.deepEqual(state.physical, physical);
  const pending = state.pending[0]; assert.equal(pending.expectedExists, true); assert.equal(pending.expectedRevision, active['cover_models:image-edit'].revision);
  assert.equal(pending.secret, newSecret); assert.equal(byId(out.release.snapshot, 'image-edit').credentialRef, 'secret://platform-model/cover_models/image-edit');
  assert.ok(!JSON.stringify(out).includes(newSecret)); assert.ok(!JSON.stringify(out).includes(oldSecret));
});
await check('same actor/request resumes exact candidate before current or physical reads; changed payload conflicts without staging', async () => {
  reset(); const input = imageRequest(), first = await stage(input), writes = stages().length;
  state.releases.find(row => row.id === baseId).is_current = false; failPhysicalReads = true; calls = [];
  const resumed = await stage({ ...input, id: 'ignored-unstable-post-id' });
  assert.equal(resumed.release.id, first.release.id); assert.equal(resumed.legacyId, first.legacyId); assert.equal(stages().length, 0);
  assert.equal(state.receipts.length, writes); assert.equal(state.pending.length, 1);
  assert.equal(calls.some(call => call.type === 'read' && call.table in state.physical), false);
  const changed = clone(input); changed.requestPayload.body.name = 'Different logical payload';
  await rejectCode(() => stage(changed), 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT'); assert.equal(stages().length, 0);
});
await check('same request ID is scoped to actor and cannot reuse another actor candidate', async () => {
  reset(); const input = imageRequest(), first = await stage(input), second = await stage({ ...input, actorId: otherActor });
  assert.notEqual(first.release.id, second.release.id); assert.notEqual(first.legacyId, second.legacyId);
  assert.equal(state.receipts.length, 2); assert.equal(state.receipts[0].actor, actor); assert.equal(state.receipts[1].actor, otherActor);
});
await check('lost readback and preview preserve original receipt; retry never creates a second candidate', async () => {
  for (const failure of ['readback', 'preview']) {
    reset(); const input = imageRequest(); if (failure === 'readback') failReadback = true; else failPreview = true;
    await assert.rejects(() => stage(input), error => error instanceof admin.PlatformConfigurationMutationOutcomeUnknown && error.phase === failure);
    assert.equal(state.receipts.length, 1); assert.equal(state.pending.length, 1);
    failReadback = failPreview = false; const resumed = await stage(input);
    assert.equal(resumed.release.id, state.receipts[0].id); assert.equal(stages().length, 1);
  }
});
await check('application-level current ID and hash mismatch prevent image stage RPC', async () => {
  for (const changed of [{ id: randomUUID() }, { snapshot_sha256: '0'.repeat(64) }]) {
    reset(); switchBase = changed;
    await rejectCode(() => stage(imageRequest()), 'PLATFORM_CONFIGURATION_CURRENT_CHANGED');
    assert.equal(stages().length, 0); assert.equal(state.pending.length, 0); assert.equal(state.releases.length, 1);
  }
});
await check('arbitrary operation names and video operation without expectedBase fail before RPC', async () => {
  const before = reset();
  for (const operation of ['image-upsert-only', 'anything', 'video-upsert-only']) {
    await rejectCode(() => admin.stagePlatformModelCandidateWithCredentials({ actorId: actor, requestId: randomUUID(), requestPayload: {}, snapshot: before,
      credentialChanges: [], changeNote: 'invalid operation fixture', operation }), 'PLATFORM_CONFIGURATION_OPERATION_INVALID');
  }
  assert.equal(stages().length, 0);
});
await check('video keeps its explicit operation marker, exact published base, unrelated entries and credential ownership', async () => {
  const before = reset(), input = imageRequest({ id: 'video-other', values: { name: 'Video edit', api_key: '' } });
  input.table = 'video_models'; input.requestPayload.modelType = 'video';
  const out = await stage(input), staged = stages()[0].input;
  assertOnlyTarget(before, out.release.snapshot, 'video-other'); assertNoUnrelatedPhysicalReads('video_models');
  assert.equal(staged.p_validation_result.operation, 'video-upsert-only'); assert.equal(staged.p_parent_release_id, baseId);
  assert.equal(staged.p_validation_result.baseSnapshotSha256, contract.configurationSha256(before));
  assert.equal(byId(out.release.snapshot, 'video-other').credentialRef, byId(before, 'video-other').credentialRef);
  reset({ noCurrent: true }); await rejectCode(() => stage(input), 'MODEL_POOL_CURRENT_RELEASE_REQUIRED'); assert.equal(stages().length, 0);
});
await check('text upsert retains existing live overlay without expanding release membership', async () => {
  const before = reset(), input = imageRequest({ id: llmId, values: { name: 'Text edit' } });
  input.table = 'llm_models'; input.requestPayload.modelType = 'text';
  const out = await stage(input), unrelated = byId(out.release.snapshot, 'image-other');
  assert.equal(unrelated.endpoint, state.physical.cover_models[1].api_endpoint); assert.equal(unrelated.pricing.cost, 4);
  assert.equal(unrelated.configuration.userAccess, 'live-access'); assert.equal(unrelated.credentialRef, byId(before, 'image-other').credentialRef);
  assert.equal(unrelated.sortOrder, 7); assert.equal(out.release.snapshot.models.length, before.models.length);
  assert.equal(stages()[0].input.p_validation_result.operation, undefined);
  reset({ noCurrent: true }); await stage(input); assert.equal(stages().length, 1);
});
await check('catalog and order consumers keep existing live overlay and release-owned membership and order semantics', async () => {
  for (const mode of ['catalog', 'order']) {
    const before = reset();
    const out = mode === 'catalog'
      ? await compatibility.stageLegacyModelPoolCatalogState({ actorId: actor, table: 'cover_models', id: 'image-edit', catalogState: 'retired', changeNote: 'catalog fixture' })
      : await compatibility.stageLegacyModelPoolOrder({ actorId: actor, table: 'cover_models', orders: [{ id: 'image-edit', sortOrder: 20 }], changeNote: 'order fixture' });
    const other = byId(out.release.snapshot, 'image-other');
    assert.equal(other.endpoint, state.physical.cover_models[1].api_endpoint); assert.equal(other.credentialRef, byId(before, 'image-other').credentialRef);
    assert.equal(other.catalogState, 'enabled'); assert.equal(other.sortOrder, 7); assert.equal(out.release.snapshot.models.length, before.models.length);
    assert.equal(byId(out.release.snapshot, 'image-edit')[mode === 'catalog' ? 'catalogState' : 'sortOrder'], mode === 'catalog' ? 'retired' : 20);
  }
});


function refreshImageLogical() {
  state.releases[0].snapshot = contract.normalizeModelPoolSnapshot(state.releases[0].snapshot);
  state.releases[0].snapshot_sha256 = contract.configurationSha256(state.releases[0].snapshot);
  return byId(state.releases[0].snapshot, 'image-edit');
}
async function rejectFinalBinding(setup, submitted, expectedCode = 'PLATFORM_CONFIGURATION_IMAGE_BINDING_CHANGE_UNSUPPORTED') {
  const { live, logical } = imageDeltaFixture(); setup(live, logical); refreshImageLogical();
  const published = clone(state.releases[0]), physical = clone(state.physical), active = clone(state.active);
  const input = imageRequest({ id: live.id, values: { ...submitted(live, logical), api_key: newSecret } }), originalInput = clone(input);
  await rejectCode(() => stage(input), expectedCode);
  assert.equal(stages().length, 0); assert.equal(state.pending.length, 0); assert.equal(state.receipts.length, 0); assert.equal(state.releases.length, 1);
  assert.deepEqual(clone(state.releases[0]), published); assert.deepEqual(state.physical, physical); assert.deepEqual(state.active, active); assert.deepEqual(input, originalInput);
}
await check('final logical protocol closes when a physically inactive alias becomes active after applying the delta', async () => {
  await rejectFinalBinding((live, logical) => {
    delete live.api_protocol_config.reference_transport; live.api_protocol_config.image_protocol = 'images_generations';
    delete logical.configuration.protocolConfig.protocol; delete logical.configuration.protocolConfig.reference_transport;
    logical.configuration.protocolConfig.image_protocol = 'images_generations'; logical.capabilities.protocol = clone(logical.configuration.protocolConfig);
  }, live => { const protocol = clone(live.api_protocol_config); protocol.image_protocol = 'images_edits'; return { api_protocol_config: protocol }; });
});
await check('final logical transport closes when a physically inactive transport alias becomes active after the delta', async () => {
  await rejectFinalBinding((live, logical) => {
    live.api_protocol_config.reference_transport = 'generations_url_array'; live.api_protocol_config.image_reference_transport = 'generations_url_array';
    delete logical.configuration.protocolConfig.reference_transport; logical.configuration.protocolConfig.image_reference_transport = 'generations_url_array';
    logical.capabilities.protocol = clone(logical.configuration.protocolConfig);
  }, live => { const protocol = clone(live.api_protocol_config); protocol.image_reference_transport = 'edits_multipart_array'; return { api_protocol_config: protocol }; });
});
await check('final logical support flags close even when explicit physical transport hides the same flag change', async () => {
  await rejectFinalBinding((live, logical) => {
    live.supports_image_input = false; live.api_protocol_config.reference_transport = 'generations_url_array';
    logical.capabilities.supportsImageInput = false; delete logical.configuration.protocolConfig.reference_transport;
    logical.capabilities.protocol = clone(logical.configuration.protocolConfig);
  }, () => ({ supports_image_input: true }));
});
await check('capabilities-only alias changes are checked even when the configuration mirror stays effectively unchanged', async () => {
  await rejectFinalBinding((live, logical) => {
    delete live.api_protocol_config.reference_transport; live.api_protocol_config.image_protocol = 'images_generations';
    logical.configuration.protocolConfig.image_protocol = 'images_generations'; delete logical.configuration.protocolConfig.reference_transport;
    logical.capabilities.protocol = clone(logical.configuration.protocolConfig); delete logical.capabilities.protocol.protocol;
  }, live => { const protocol = clone(live.api_protocol_config); protocol.image_protocol = 'images_edits'; return { api_protocol_config: protocol }; });
});
await check('final request paths cannot be cleared by explicit null hidden by an absent physical baseline', async () => {
  for (const field of ['submit_path', 'poll_path', 'provider_contract']) for (const mirror of ['configuration', 'capabilities']) {
    await rejectFinalBinding((live, logical) => {
      delete live.api_protocol_config[field];
      (mirror === 'configuration' ? logical.configuration.protocolConfig : logical.capabilities.protocol)[field] = 'published-binding';
    }, live => ({ api_protocol_config: { ...clone(live.api_protocol_config), [field]: null } }));
  }
});
await check('actual input capability changes require isolation even when explicit or Google transport resolvers stay equal', async () => {
  for (const google of [false, true]) await rejectFinalBinding((live, logical) => {
    live.supports_image_input = false; logical.capabilities.supportsImageInput = false;
    const protocol = google ? 'google_generate_content' : 'images_generations';
    live.protocol_type = protocol; logical.protocol = protocol;
    for (const config of [live.api_protocol_config, logical.configuration.protocolConfig, logical.capabilities.protocol]) {
      config.protocol = protocol; config.reference_transport = google ? 'chat_inline_data' : 'generations_url_array';
    }
  }, () => ({ supports_image_input: true }));
  for (const mirror of ['configuration', 'capabilities']) await rejectFinalBinding((live, logical) => {
    for (const config of [live.api_protocol_config, logical.configuration.protocolConfig, logical.capabilities.protocol]) config.reference_transport = 'generations_url_array';
    (mirror === 'configuration' ? logical.configuration.protocolConfig : logical.capabilities.protocol).max_reference_images = 2;
  }, live => ({ api_protocol_config: { ...clone(live.api_protocol_config), max_reference_images: 5 } }));
});
await check('an unparseable final execution mirror stops before stage while unknown historical metadata and price edits remain available', async () => {
  await rejectFinalBinding((_live, logical) => { logical.capabilities.protocol = { protocol: 'unknown-protocol' }; }, live => {
    const protocol = clone(live.api_protocol_config); protocol.extra_parameters.quality = 'high'; return { api_protocol_config: protocol };
  });
  const { live, logical } = imageDeltaFixture();
  logical.configuration.protocolConfig.protocol = 'unknown-protocol'; logical.capabilities.protocol.protocol = 'unknown-protocol';
  refreshImageLogical(); const before = clone(state.releases[0].snapshot), protocol = clone(live.api_protocol_config);
  protocol.resolution_prices['2K'] = .9; protocol.resolution_cost_prices['2K'] = .45;
  const out = await stage(imageRequest({ id: live.id, values: { name: 'Unknown binding metadata only', cost_price: 6, selling_price: 9,
    sort_order: 31, api_protocol_config: { ...protocol, admin_notes: 'note' } } }));
  const expected = exactExpected(before, model => {
    model.name = 'Unknown binding metadata only'; model.pricing.cost = 6; model.pricing.selling = 9; model.sortOrder = 31;
    for (const config of [model.configuration.protocolConfig, model.capabilities.protocol]) {
      config.resolution_prices['2K'] = .9; config.resolution_cost_prices['2K'] = .45; config.admin_notes = 'note';
    }
  });
  assert.deepEqual(clone(out.release.snapshot), clone(expected)); assert.equal(state.pending.length, 0);
});

assert.equal(forbiddenIoAttempts, 0); assert.ok(!logs.join('').includes(newSecret)); assert.ok(!logs.join('').includes(oldSecret));
const hashes = Object.fromEntries([...sourceFiles].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report = { passed: true, nodeVersion: process.version, scenarioGroups: cases.length, cases, sourceSha256: hashes,
  actualTsModulesExecuted: [...modules.keys()], realNetworkRequests: 0, realDatabaseReads: 0, realDatabaseWrites: 0, providerCalls: 0, forbiddenIoAttempts,
  imageAtomicStageCas: 'NOT VERIFIED: generic SQL stage has no transaction-level image current CAS',
  strictSingleTargetPublication: 'NOT VERIFIED: generic publisher may include missing-row and credential-binding repairs; no publish executed' };
const evidenceDir = process.env.COVER_SCOPED_CANDIDATE_EVIDENCE_DIR || '.codex-evidence/cover-rebuild-20261106-bc1a/supervisor-resume/model-mapping-audit/scoped-candidate-fix';
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, 'zero-network-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
