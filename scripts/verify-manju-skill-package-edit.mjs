import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const out = '.codex-evidence/manju-skill-package-edit-20260902';
const clone = (value) => JSON.parse(JSON.stringify(value));
function componentFixture(fixtureFetch) {
  const filename = 'src/components/admin/ManjuCustomSkillPackageManager.tsx';
  const source = readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ManjuCustomSkillPackageManager');
  const returned = component.body.statements.findLast((node) => ts.isReturnStatement(node));
  const instrumented = source.slice(0, returned.getStart(tree))
    + `return { loadPackages, selectPackage, startNew, patchForm, postAction, form, error, notice, view: ${returned.expression.getText(tree)} };`
    + source.slice(returned.end)
    + '\nexports.pure = { payloadFromForm, formFromPackage, DEFAULT_FORM };';
  const states = [];
  let index = 0;
  const jsx = (type, props) => ({ type, props: props || {} });
  const hooks = {
    useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === 'function' ? initial() : initial; return [states[key], (value) => { states[key] = typeof value === 'function' ? value(states[key]) : value; }]; },
    useMemo: (factory) => factory(), useCallback: (callback) => callback, useEffect() {},
  };
  const sandbox = { exports: {}, fetch: fixtureFetch, Error, window: { confirm: () => true }, require(module) {
    if (module === 'react') return hooks;
    if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (module === 'lucide-react') return new Proxy({}, { get: (_target, property) => String(property) });
    throw new Error(`Unexpected component dependency ${module}`);
  } };
  runInNewContext(ts.transpileModule(instrumented, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, sandbox);
  return { pure: sandbox.exports.pure, render() { index = 0; return sandbox.exports.ManjuCustomSkillPackageManager({ token: 'offline-fixture-only' }); } };
}

const packageId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const firstTime = '2026-09-02T00:00:00.000Z';
const savedTime = '2026-09-02T00:01:00.000Z';
function syntheticView(pure) {
  const payload = pure.payloadFromForm({ ...pure.DEFAULT_FORM, slug: 'synthetic-skill', commandName: '/synthetic-skill', displayName: '合成 Skill', summary: '合成摘要', instructions: '仅用于离线测试。' });
  payload.tools = [{ id: 'synthetic-tool', capability: 'read-fixture', description: '合成工具', required: true, config: { endpoint: 'fixture-only', apiKey: '[REDACTED]' } }];
  payload.resources = [{ id: 'synthetic-resource', kind: 'reference', title: '合成参考', mediaType: 'application/json', version: '2', description: '参考', content: '保留这段参考内容' }];
  payload.input_schema = { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] };
  payload.output_schema = { type: 'object', properties: { story: { type: 'string' } } };
  payload.sanitized_config = { vendor: 'fixture', nested: { apiKey: '[REDACTED]' } };
  payload.orchestration = { stages: [{ id: 'custom', type: 'tool', title: '原编排', dependsOn: [], toolId: 'synthetic-tool', config: { retry: 0 } }], missingInputPolicy: 'fail', maxModelCalls: 4, maxToolCalls: 8 };
  payload.manifest.priority = 17;
  payload.manifest.permissions = [{ capability: 'read-fixture', description: '保留权限', required: true }];
  payload.manifest.negativeTriggerSignals = ['跳过'];
  payload.manifest.tags = ['包含,逗号的标签', '第二项'];
  payload.manifest.installCount = 12;
  payload.routing.explicitCommands.push('/synthetic-alias');
  payload.routing.priority = 17;
  payload.provenance = { kind: 'public_contract_reimplementation', sourceName: '合成来源', sourceUrl: 'https://example.invalid/reference', license: 'fixture-license', attribution: '保留归属', publicBehaviorReference: '合成来源说明' };
  return { package: { id: packageId, slug: 'synthetic-skill', display_name: '合成 Skill', summary: '合成摘要', origin: 'custom', visibility: 'private', runtime_kind: 'hybrid', lifecycle: 'draft', active_version_id: null, latest_version_number: 1, updated_at: firstTime, metadata: { folder: '保留目录', nested: { apiKey: '[REDACTED]' } } }, versions: [{ id: versionId, package_id: packageId, version_number: 1, semver: '2.3.4', status: 'draft', payload, schema_version: '1.0.0', updated_at: firstTime, published_at: null }] };
}

async function reproduceBefore() {
  const writes = [];
  const fixture = componentFixture(async (_url, init = {}) => {
    if (init.method === 'POST') { writes.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { package_id: packageId, version_id: versionId, updated_at: savedTime } }); }
    return Response.json({ ok: true, packages: [], count: 0 });
  });
  const view = syntheticView(fixture.pure);
  const form = fixture.pure.formFromPackage(view);
  const renamed = fixture.pure.payloadFromForm({ ...form, displayName: '只改名称' });
  fixture.render().patchForm({ slug: 'new-synthetic', commandName: '/new-synthetic', displayName: '新合成包', summary: '摘要', instructions: '离线测试指令' });
  await fixture.render().postAction('save-draft', { save: true });
  await fixture.render().postAction('save-draft', { save: true });
  const result = { reproduced: true, toolsCleared: renamed.tools.length === 0, resourcesCleared: renamed.resources.length === 0,
    inputSchemaRebuilt: JSON.stringify(renamed.input_schema) !== JSON.stringify(view.versions[0].payload.input_schema),
    metadataCleared: form.metadataText === '{}', repeatedSaveHasNoPackageId: writes[1].packageId === null, repeatedSaveHasNoVersionId: writes[1].versionId === null };
  assert.ok(Object.values(result).every((value) => value === true));
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/before.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

async function verifyAfter() {
  const contract = await import('../src/lib/server/skill-package-contract.ts');
  const preservation = await import('../src/lib/server/skill-admin-edit-preservation.ts');
  const actorId = '33333333-3333-4333-8333-333333333333';
  const secretRefs = ['env://FIXTURE_TOOL', 'env://FIXTURE_CONFIG', 'env://FIXTURE_METADATA', 'env://FIXTURE_RESOURCE'];
  const bare = componentFixture(() => { throw new Error('Pure fixture must not fetch'); });
  const rawView = clone(syntheticView(bare.pure));
  rawView.versions[0].payload.tools[0].config.apiKey = secretRefs[0];
  rawView.versions[0].payload.sanitized_config.nested.apiKey = secretRefs[1];
  rawView.package.metadata.nested.apiKey = secretRefs[2];
  rawView.versions[0].payload.resources[0].content = `Reference uses ${secretRefs[3]} in a synthetic description.`;
  rawView.versions[0].payload = contract.validateSkillPackagePayload(rawView.versions[0].payload);
  rawView.versions[0].payload_hash = contract.skillPayloadHash(rawView.versions[0].payload);

  function databaseFixture(initial) {
    const state = { view: initial ? clone(initial) : null, queries: [], rpcs: [], sequence: 0, failRead: false, failRpc: false };
    const safeView = () => state.view ? { package: { ...clone(state.view.package), metadata: contract.sanitizeSkillAdminValue(state.view.package.metadata) }, versions: state.view.versions.map((version) => ({ ...clone(version), payload: contract.sanitizeSkillAdminPayload(version.payload) })) } : null;
    const database = {
      from(table) {
        assert.ok(['skill_packages', 'skill_versions'].includes(table));
        const filters = {};
        const query = { select() { return query; }, eq(key, value) { filters[key] = value; return query; }, async maybeSingle() {
          state.queries.push({ table, ...filters });
          if (state.failRead) return { data: null, error: { code: '42P01' } };
          const candidates = table === 'skill_packages' ? [state.view?.package].filter(Boolean) : state.view?.versions || [];
          const data = candidates.find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value));
          return { data: data ? clone(data) : null, error: null };
        } };
        return query;
      },
      async rpc(name, input) {
        state.rpcs.push({ name, input: clone(input) });
        assert.equal(name, 'save_skill_package_draft');
        if (state.failRpc) return { data: null, error: { code: 'P0001' } };
        if (state.view && (input.p_package_id !== state.view.package.id || Date.parse(input.p_expected_updated_at) !== Date.parse(state.view.package.updated_at))) {
          return { data: null, error: { code: 'P0001' } };
        }
        const updatedAt = new Date(Date.parse(firstTime) + (++state.sequence) * 60_000).toISOString();
        const nextPackageId = input.p_package_id || packageId;
        const nextVersionId = input.p_version_id || versionId;
        state.view = { package: { id: nextPackageId, slug: input.p_slug, display_name: input.p_display_name, summary: input.p_summary, origin: input.p_origin, visibility: input.p_visibility, runtime_kind: input.p_runtime_kind, lifecycle: 'draft', active_version_id: null, latest_version_number: 1, metadata: clone(input.p_metadata), updated_at: updatedAt }, versions: [{ id: nextVersionId, package_id: nextPackageId, version_number: 1, semver: input.p_semver, schema_version: input.p_schema_version, status: 'draft', payload: clone(input.p_payload), payload_hash: input.p_payload_hash, updated_at: updatedAt, published_at: null }] };
        return { data: { ok: true, package_id: nextPackageId, version_id: nextVersionId, updated_at: updatedAt }, error: null };
      },
    };
    const filename = 'src/lib/server/skill-package-repository.ts';
    const sandbox = { exports: {}, Error, process: { env: { COZE_SUPABASE_SERVICE_ROLE_KEY: 'offline-fixture-only' } }, require(module) {
      if (module === 'server-only') return {};
      if (module === '@/lib/server/skill-package-contract') return contract;
      if (module === '@/lib/server/skill-admin-edit-preservation') return preservation;
      if (module === '@/lib/server/skill-policy') return { isSkillAvailableForActor: () => false };
      if (module === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => database };
      throw new Error(`Unexpected repository dependency ${module}`);
    } };
    runInNewContext(ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    const requests = [];
    const fetch = async (_url, init = {}) => {
      if (init.method !== 'POST') return Response.json({ ok: true, packages: safeView() ? [safeView()] : [], count: state.view ? 1 : 0 });
      const action = JSON.parse(init.body);
      requests.push(action);
      try { return Response.json({ ok: true, result: await sandbox.exports.executeAdminSkillAction(action, actorId) }); }
      catch (error) { const normalized = sandbox.exports.normalizeSkillRepositoryError(error, action.action); return Response.json({ ok: false, error: normalized.message, code: normalized.code }, { status: normalized.status }); }
    };
    return { state, safeView, requests, fetch, execute: (action) => sandbox.exports.executeAdminSkillAction(action, actorId) };
  }

  const existing = databaseFixture(rawView);
  const editor = componentFixture(existing.fetch);
  await editor.render().loadPackages();
  editor.render().selectPackage(existing.safeView());
  assert.deepEqual(JSON.parse(editor.render().form.metadataText), contract.sanitizeSkillAdminValue(rawView.package.metadata));
  editor.render().patchForm({ displayName: '只改名称' });
  await editor.render().postAction('validate');
  assert.equal(existing.state.rpcs.length, 0, 'validate is read-only even when restoring masked fields');
  assert.equal(editor.render().error, '');
  await editor.render().postAction('save-draft', { save: true });
  assert.equal(editor.render().error, '');
  const written = existing.state.rpcs.at(-1).input;
  const expectedPayload = clone(rawView.versions[0].payload);
  expectedPayload.manifest.displayName = '只改名称';
  assert.deepEqual(written.p_payload, expectedPayload, 'name-only save preserves all tools/resources/schemas/config/routing/orchestration/provenance');
  assert.deepEqual(written.p_metadata, rawView.package.metadata, 'metadata and nested server references survive unchanged');
  assert.equal(written.p_expected_updated_at, firstTime);
  assert.equal(editor.render().form.packageId, packageId);
  assert.equal(editor.render().form.versionId, versionId);
  assert.equal(editor.render().form.expectedUpdatedAt, savedTime);
  for (const ref of secretRefs) assert.ok(!JSON.stringify(existing.requests).includes(ref), 'browser requests must not contain underlying references');

  editor.render().patchForm({ instructions: '第二次修改后的指令。', commandName: '/renamed-command' });
  await editor.render().postAction('save-draft', { save: true });
  assert.equal(editor.render().error, '');
  assert.equal(existing.state.rpcs.at(-1).input.p_version_id, versionId);
  assert.equal(existing.state.rpcs.at(-1).input.p_expected_updated_at, savedTime);
  assert.deepEqual(existing.state.view.versions[0].payload.routing.explicitCommands, ['/renamed-command', '/synthetic-alias']);
  assert.deepEqual(existing.state.view.versions[0].payload.tools, rawView.versions[0].payload.tools);
  assert.equal(existing.requests.at(-1).baseVersionId, versionId);

  const newlyCreated = databaseFixture(null);
  const newEditor = componentFixture(newlyCreated.fetch);
  newEditor.render().patchForm({ slug: 'new-synthetic', commandName: '/new-synthetic', displayName: '新合成包', summary: '摘要', instructions: '离线测试指令' });
  await newEditor.render().postAction('validate');
  assert.equal(newlyCreated.state.queries.length, 0, 'new-package validation remains available without database tables');
  assert.equal(newlyCreated.state.rpcs.length, 0);
  await newEditor.render().postAction('save-draft', { save: true });
  assert.equal(newEditor.render().error, '');
  assert.equal(newEditor.render().form.packageId, packageId);
  assert.equal(newEditor.render().form.versionId, versionId);
  newEditor.render().patchForm({ summary: '接着编辑同一草稿' });
  await newEditor.render().postAction('save-draft', { save: true });
  assert.equal(newEditor.render().error, '');
  const newSaves = newlyCreated.requests.filter((request) => request.action === 'save-draft');
  assert.equal(newSaves[0].packageId, null);
  assert.equal(newSaves[1].packageId, packageId);
  assert.equal(newSaves[1].versionId, versionId);
  assert.equal(newSaves[1].expectedUpdatedAt, savedTime);
  assert.equal(newlyCreated.state.view.versions.length, 1);

  const actionFor = (view) => ({ action: 'save-draft', packageId: view.package.id, versionId: view.versions[0].id, baseVersionId: view.versions[0].id, expectedUpdatedAt: view.package.updated_at, slug: view.package.slug, displayName: view.package.display_name, summary: view.package.summary, origin: view.package.origin, visibility: view.package.visibility, runtimeKind: view.package.runtime_kind, payload: clone(view.versions[0].payload), semver: view.versions[0].semver, schemaVersion: view.versions[0].schema_version, metadata: clone(view.package.metadata) });
  const guarded = databaseFixture(rawView);
  const baselineAction = actionFor(guarded.safeView());
  await assert.rejects(guarded.execute({ ...baselineAction, packageId: '44444444-4444-4444-8444-444444444444' }), (error) => error.code === 'SKILL_OPERATION_INVALID');
  assert.ok(guarded.state.queries.some((query) => query.table === 'skill_versions' && query.package_id === '44444444-4444-4444-8444-444444444444'));
  await assert.rejects(guarded.execute({ ...baselineAction, baseVersionId: null }), (error) => error.code === 'SKILL_REDACTED_VALUE_UNRESOLVED');
  const wrongPlaceholder = clone(baselineAction);
  wrongPlaceholder.payload.tools[0].config.apiKey = '[REDACTED_UNKNOWN]';
  await assert.rejects(guarded.execute(wrongPlaceholder), (error) => error.code === 'SKILL_REDACTED_VALUE_UNRESOLVED');
  const movedPlaceholder = clone(baselineAction);
  movedPlaceholder.payload.tools[0].id = 'different-tool';
  await assert.rejects(guarded.execute(movedPlaceholder), (error) => error.code === 'SKILL_REDACTED_VALUE_UNRESOLVED');
  const changedResourceMask = clone(baselineAction);
  changedResourceMask.payload.resources[0].content += ' changed';
  await assert.rejects(guarded.execute(changedResourceMask), (error) => error.code === 'SKILL_REDACTED_VALUE_UNRESOLVED');
  const wrongMetadata = clone(baselineAction);
  wrongMetadata.metadata.newField = '[REDACTED]';
  await assert.rejects(guarded.execute(wrongMetadata), (error) => error.code === 'SKILL_REDACTED_VALUE_UNRESOLVED');
  await assert.rejects(guarded.execute({ ...baselineAction, expectedUpdatedAt: savedTime }), (error) => error.code === 'SKILL_CONFLICT');
  assert.equal(guarded.state.rpcs.length, 0, 'unsafe edits never reach a write RPC');
  guarded.state.failRead = true;
  await assert.rejects(guarded.execute(baselineAction), (error) => error.code === 'MIGRATION_NOT_READY');
  guarded.state.failRead = false;
  guarded.state.failRpc = true;
  await assert.rejects(guarded.execute(baselineAction), (error) => error.code === 'SKILL_CONFLICT');
  assert.equal(guarded.state.rpcs.at(-1).input.p_expected_updated_at, firstTime, 'RPC CAS remains active after server merge');

  // Array identities prevent swapping one tool's masked reference into another.
  const reordered = preservation.restoreSkillAdminRedactedValues(
    [{ id: 'b', config: { apiKey: '[REDACTED]' } }, { id: 'a', config: { apiKey: '[REDACTED]' } }],
    [{ id: 'a', config: { apiKey: 'env://FIXTURE_A' } }, { id: 'b', config: { apiKey: 'env://FIXTURE_B' } }],
  );
  assert.equal(reordered[0].config.apiKey, 'env://FIXTURE_B');

  let incompleteWrites = 0;
  const incomplete = componentFixture(async (_url, init = {}) => {
    if (init.method === 'POST') { incompleteWrites++; return Response.json({ ok: true, result: { package_id: packageId } }); }
    return Response.json({ ok: true, packages: [], count: 0 });
  });
  incomplete.render().patchForm({ slug: 'incomplete-result', commandName: '/incomplete-result', displayName: '合成包', summary: '摘要', instructions: '合成指令' });
  await incomplete.render().postAction('save-draft', { save: true });
  await incomplete.render().postAction('save-draft', { save: true });
  assert.equal(incompleteWrites, 1, 'missing save identity cannot silently create another package on retry');
  assert.match(incomplete.render().error, /版本信息不完整/);
  const result = { passed: true, dynamicGroups: 15, actualComponentAndRepository: true, secretReferencesKeptServerSide: true, realNetworkRequests: 0, realDatabaseWrites: 0 };
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/after.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

if (process.argv.includes('--before')) await reproduceBefore();
else await verifyAfter();
