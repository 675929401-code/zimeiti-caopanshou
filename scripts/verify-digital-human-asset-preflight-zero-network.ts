import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPersonAssetPreflight, PersonAssetPreflightError } from '../src/lib/server/digital-human-asset-preflight';
import { version } from '../src/lib/server/gaorui-provider-assets';
import { gaoruiCredentialBindingFingerprint } from '../src/lib/gaorui-provider-asset-contract';
import { toPublicModelId, toPublicModelDto } from '../src/lib/public-model-dto';
import { readGaoruiPersonAssetAdmission } from '../src/lib/gaorui-person-asset-admission';
import { videoOperatorSubmissionAdmission } from '../src/lib/video-model-availability';

type Row = Record<string, unknown>;
const userId = '10000000-0000-4000-8000-000000000001';
const assetId = '20000000-0000-4000-8000-000000000001';
const secret = 'fixture-ram-only';
function fixture() {
  const asset: Row = { id: assetId, user_id: userId, file_category: 'image', source: 'digital-human-input',
    storage_provider: 'tencent_cos', storage_key: 'fixture/person.png', file_size: 20, content_type: 'image/png', created_at: '2026-01-01', meta: {} };
  const model: Row = { id: 'fixture-person-model', protocol_type: 'gaorui_video', model_name: 'seedance-2.0-fast',
    is_active: true, is_hidden: false, api_key: 'fixture-reference', api_endpoint: 'https://gaorui.cc/v1/videos',
    api_protocol_config: { workspace_surfaces: ['digital-human'] } };
  const fingerprint = gaoruiCredentialBindingFingerprint({ secret, modelId: String(model.id), endpoint: String(model.api_endpoint) });
  const scope = { user_id: userId, owned_asset_id: assetId, model_id: model.id, model_name: model.model_name,
    provider_origin: 'https://gaorui.cc', credential_binding_fingerprint: fingerprint, asset_version: version(asset),
    content_sha256: 'a'.repeat(64), storage_provider: asset.storage_provider, storage_key: asset.storage_key,
    type: 'image', role: 'reference_image', purpose: 'person_reference' };
  const ready: Row = { scope, state: 'ready', result: { status: 'ready', model: model.model_name,
    asset_type: 'Image', visibility: 'private', asset_id: 'fixture_asset', asset_url: 'asset://fixture_asset' } };
  const state = { asset: asset as Row | null, model, operations: [ready], error: false, secretCalls: 0, reads: [] as string[], rpcCalls: [] as Row[] };
  // Only SELECT methods and the one dedicated read RPC exist; no write RPCs.
  const db = { from(table: string) {
    assert.ok(['user_files', 'video_models'].includes(table), 'Private journal must use its read RPC');
    state.reads.push(table);
    const filters: Row = {};
    const finish = () => {
      const rows = table === 'user_files' ? [state.asset].filter(Boolean) as Row[] : table === 'video_models' ? [model] : state.operations;
      const data = rows.filter(row => Object.entries(filters).every(([key, value]) => key.includes('->>')
        ? true : row[key] === value));
      return { data, error: null };
    };
    const query = { select() { return query; }, eq(key: string, value: unknown) { filters[key] = value; return query; },
      maybeSingle: async () => { const found = finish(); return { ...found, data: found.data[0] || null }; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(finish()).then(resolve, reject); } };
    return query;
  }, async rpc(name: string, args: Row) {
    assert.equal(name, 'read_gaorui_person_asset_preflight_v1');
    assert.deepEqual(args, { p_user_id: userId, p_owned_asset_id: assetId, p_model_id: model.id,
      p_provider_origin: 'https://gaorui.cc', p_credential_binding_fingerprint: fingerprint });
    state.rpcCalls.push({ name, args });
    // Deliberately return even mismatched scopes to exercise reader revalidation.
    return { data: state.operations, error: state.error ? { message: 'fixture private failure' } : null };
  } } as unknown as SupabaseClient;
  const input = { userId, assetId, publicModelId: toPublicModelId('video', String(model.id)) };
  const run = () => readPersonAssetPreflight(input, { db, resolveSecret: () => { state.secretCalls++; return secret; } });
  return { state, run, scope, ready, asset, input, fingerprint };
}

// Execute the actual route's fee-admission projections and early-return blocks
// in an isolated VM. This deliberately does not simulate the rest of POST,
// database access, pricing, provider dispatch, or real generation.
function routeAdmissionHarness() {
  const catalogSource = readFileSync(new URL('../src/app/api/video/models/route.ts', import.meta.url), 'utf8');
  const catalogTree = ts.createSourceFile('models-route.ts', catalogSource, ts.ScriptTarget.Latest, true);
  const names = ['baseAvailable', 'personAssetAdmission', 'operatorAdmission', 'capabilitiesVerified', 'available', 'generationReady'];
  const declarations = new Map<string, ts.VariableStatement[]>();
  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && names.includes(item.name.text)) {
        const list = declarations.get(item.name.text) || [];
        list.push(node); declarations.set(item.name.text, list);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(catalogTree);
  for (const name of names) assert.equal(declarations.get(name)?.length, 1, `catalog declaration ${name} must be unique`);
  const projection = names.map(name => declarations.get(name)![0].getText(catalogTree)).join('\n');
  const catalogModule = { exports: {} as { inspect: (m: Row) => { available: boolean; generationReady: boolean; capabilitiesVerified: boolean } } };
  const catalogCode = `exports.inspect = function(m) {
    const configuredForSubmission = true, priceReady = true, billingAdmission = {ready:true};
    const surfaceCompatibility = {compatible:true}, requestedSurface = 'digital-human';
    const protocolConfig = m.api_protocol_config;
    ${projection}
    return {available, generationReady, capabilitiesVerified};
  };`;
  runInNewContext(catalogCode, { exports: catalogModule.exports, readGaoruiPersonAssetAdmission, videoOperatorSubmissionAdmission }, { timeout: 1000 });

  const generateSource = readFileSync(new URL('../src/app/api/video/generate/route.ts', import.meta.url), 'utf8');
  const generateTree = ts.createSourceFile('generate-route.ts', generateSource, ts.ScriptTarget.Latest, true);
  const post = generateTree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
  const outerTry = post?.body?.statements.find(ts.isTryStatement);
  assert.ok(outerTry, 'POST try block is required');
  const statements = [...outerTry.tryBlock.statements];
  const declaresAdmission = (node: ts.Statement) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(generateTree) === 'personAssetAdmission');
  const start = statements.findIndex(declaresAdmission);
  assert.ok(start >= 0);
  const first = statements[start + 1];
  const second = statements.find(node => ts.isIfStatement(node) && node.expression.getText(generateTree) === 'personAssetAdmission.required');
  assert.ok(ts.isIfStatement(first) && first.expression.getText(generateTree) === '!personAssetAdmission.ready');
  assert.ok(second && ts.isIfStatement(second));
  assert.ok(second.getStart(generateTree) > first.getEnd(), 'credential-bound gate must follow the initial gate');
  const firstText = [statements[start], first].map(node => node.getText(generateTree)).join('\n');
  const secondText = second.getText(generateTree);
  assert.match(secondText, /credentialBindingFingerprint:\s*gaoruiCredentialBindingFingerprint\(/u);
  // Inspect every actual call in POST, including calls inside callbacks and
  // calls without await. Text searches can miss an earlier call or count a
  // comment/string as evidence that a later call exists.
  const protectedCalls = ['bridgeVideoProviderAsset', 'reserveVideoGenerationTask', 'prepareGaoruiPersonVideoExecution', 'submitVideoTask'];
  const callOffsets = new Map<string, number[]>();
  function collectCalls(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && protectedCalls.includes(node.expression.text)) {
      const offsets = callOffsets.get(node.expression.text) || [];
      offsets.push(node.getStart(generateTree));
      callOffsets.set(node.expression.text, offsets);
    }
    ts.forEachChild(node, collectCalls);
  }
  collectCalls(post!.body!);
  for (const call of protectedCalls) {
    const offsets = callOffsets.get(call) || [];
    assert.ok(offsets.length > 0, `${call} must exist in POST`);
    assert.ok(offsets.every(offset => offset > second.getEnd()), `${call} must follow both admission gates`);
  }
  const submitModule = { exports: {} as { inspect: (selectedModel: Row, providerApiKey: string) => { body: Row; status: number } | null } };
  const submitCode = `exports.inspect = function(selectedModel, providerApiKey) {
    const surface = 'digital-human';
    ${firstText}
    ${secondText}
    return null;
  };`;
  runInNewContext(submitCode, { exports: submitModule.exports, readGaoruiPersonAssetAdmission, gaoruiCredentialBindingFingerprint,
    NextResponse: { json: (body: Row, init: {status: number}) => ({body, status: init.status}) } }, { timeout: 1000 });
  return { catalog: catalogModule.exports.inspect, submit: submitModule.exports.inspect };
}

async function main() {
  const previousFetch = globalThis.fetch;
  const localRequire = createRequire(import.meta.url);
  const stylePath = fileURLToPath(new URL('../src/features/digital-human/PersonAssetPreflight.module.css', import.meta.url));
  const previousCssLoader = localRequire.extensions['.css'];
  localRequire.extensions['.css'] = (module, filename) => {
    if (filename !== stylePath) {
      if (previousCssLoader) return previousCssLoader(module, filename);
      throw new Error('Unexpected stylesheet in isolated preflight SSR test');
    }
    const css = readFileSync(filename, 'utf8');
    const names = [...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)\b/gu)].map(match => match[1]);
    module.exports = Object.fromEntries(names.map(name => [name, name]));
  };
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  try {
    // Load the actual component after installing the exact-file process-local shim.
    const { PersonAssetPreflightPicker } = await import('../src/features/digital-human/PersonAssetPreflight');
    let checks = 0;
    const baseline = fixture();
    const observed = await baseline.run();
    assert.equal(observed.cache, 'ready_record');
    assert.equal(observed.fee, 'unverified');
    assert.equal(observed.content, 'unverified');
    assert.equal(observed.generationAuthorized, false); checks++;
    assert.equal(baseline.state.rpcCalls.length, 1);
    assert.deepEqual(baseline.state.reads, ['user_files', 'video_models']); checks++;
    const serialized = JSON.stringify(observed);
    for (const privateValue of [secret, baseline.fingerprint, baseline.scope.storage_key, baseline.scope.content_sha256, baseline.scope.model_id, 'gaorui.cc', 'fixture_asset']) assert.ok(!serialized.includes(String(privateValue)));
    checks++;
    const foreign = fixture(); foreign.state.asset!.user_id = '10000000-0000-4000-8000-000000000002';
    await assert.rejects(foreign.run, (error: unknown) => error instanceof PersonAssetPreflightError && error.status === 404);
    assert.deepEqual(foreign.state.reads, ['user_files']); assert.equal(foreign.state.secretCalls, 0);
    assert.equal(foreign.state.rpcCalls.length, 0); checks++;
    const deleted = fixture(); deleted.state.asset!.meta = { deleted: true };
    await assert.rejects(deleted.run, (error: unknown) => error instanceof PersonAssetPreflightError && error.status === 404); checks++;
    for (const [field, value] of [['credential_binding_fingerprint', 'b'.repeat(64)], ['user_id', 'other-user'], ['model_id', 'other-model'], ['provider_origin', 'https://other.invalid'], ['content_sha256', 'invalid']]) {
      const mismatch = fixture(); mismatch.scope[field as keyof typeof mismatch.scope] = value;
      assert.equal((await mismatch.run()).cache, 'missing'); checks++;
    }
    const changed = fixture(); changed.state.asset!.meta = { contentVersion: 'new-version' };
    assert.equal((await changed.run()).version, 'unmatched'); assert.equal((await changed.run()).cache, 'missing'); checks++;
    for (const [state, expected] of [['submitting', 'pending'], ['processing', 'pending'], ['submission_unknown', 'reconciliation_required'], ['reconciliation_required', 'reconciliation_required'], ['failed', 'failed']]) {
      const item = fixture(); item.ready.state = state;
      assert.equal((await item.run()).cache, expected); checks++;
    }
    const mixed = fixture(); mixed.state.operations.push({ scope: mixed.scope, state: 'submission_unknown', result: null });
    assert.equal((await mixed.run()).cache, 'reconciliation_required'); checks++;
    const invalidReady = fixture(); invalidReady.ready.result = { status: 'ready', asset_id: 'bad' };
    assert.equal((await invalidReady.run()).cache, 'reconciliation_required'); checks++;
    const missingTable = fixture(); missingTable.state.error = true;
    assert.equal((await missingTable.run()).cache, 'unavailable');
    assert.equal((await missingTable.run()).version, 'unverified'); checks++;
    const overflow = fixture(); overflow.state.operations = Array.from({ length: 101 }, () => overflow.ready);
    assert.equal((await overflow.run()).cache, 'unavailable');
    assert.equal((await overflow.run()).version, 'unverified'); checks++;
    const authorized = fixture();
    const config = authorized.state.model.api_protocol_config as Row;
    config.gaorui_person_asset_fee_authorization = { schema: 'gaorui_person_asset_fee_authorization.v1', enabled: true,
      providerOrigin: 'https://gaorui.cc', modelName: authorized.state.model.model_name, modelId: authorized.state.model.id,
      credentialBindingFingerprint: authorized.fingerprint, verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), evidenceRef: 'fixture:verified-evidence', authorizationId: 'fixture-authorization', feeCny: 0, maxChargeCny: 0 };
    assert.equal((await authorized.run()).fee, 'verified');
    assert.equal((await authorized.run()).generationAuthorized, false); checks++;
    (config.gaorui_person_asset_fee_authorization as Row).credentialBindingFingerprint = 'c'.repeat(64);
    assert.equal((await authorized.run()).fee, 'unverified'); checks++;
    const hidden = fixture(); hidden.state.model.is_hidden = true;
    await assert.rejects(hidden.run, (error: unknown) => error instanceof PersonAssetPreflightError && error.status === 404); checks++;
    const retired = fixture(); retired.state.model.provider = 'retired_configuration';
    await assert.rejects(retired.run, (error: unknown) => error instanceof PersonAssetPreflightError && error.status === 404);
    assert.equal(retired.state.secretCalls, 0); checks++;
    const route = readFileSync(new URL('../src/app/api/digital-human/assets/preflight/route.ts', import.meta.url), 'utf8');
    assert.match(route, /authorizeCurrentApiUser/); assert.match(route, /private, no-store/);
    assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/u.test(route)); checks++;
    const sql = readFileSync(new URL('../supabase/migrations/20261031010000_digital_human_asset_preflight.sql', import.meta.url), 'utf8');
    assert.match(sql, /LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/u);
    const body = sql.split('AS $$')[1].split('$$;')[0];
    assert.ok(!/\b(?:INSERT|UPDATE|DELETE|MERGE|CALL|PERFORM|LOCK|INTO)\b/iu.test(body));
    assert.match(body, /LIMIT 101/u);
    for (const field of ['user_id', 'owned_asset_id', 'model_id', 'provider_origin', 'credential_binding_fingerprint']) {
      assert.ok(body.includes(`operation.scope->>'${field}' = p_${field}`));
    }
    assert.match(body, /asset\.id::text = p_owned_asset_id/u);
    assert.match(body, /asset\.user_id::text = p_user_id/u);
    for (const deletionGuard of ["to_jsonb(asset)->>'deleted_at'", "to_jsonb(asset)->>'is_deleted'", "asset.meta->>'deleted_at'", "asset.meta->>'deletedAt'", "asset.meta->>'deleted'"]) assert.ok(body.includes(deletionGuard));
    assert.match(body, /p_user_id ~\*/u); assert.match(body, /p_owned_asset_id ~\*/u);
    assert.match(sql, /REVOKE ALL ON FUNCTION[^;]+FROM PUBLIC, anon, authenticated, service_role/u);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION[^;]+TO service_role/u);
    assert.ok(!/GRANT\s+SELECT/iu.test(sql)); checks++;
    const dedicatedRow = fixture().state.model;
    const supported = toPublicModelDto('video', dedicatedRow, 0, { capabilitiesVerified: true, generationReady: false });
    assert.equal(supported.capabilities.supportsPersonAssetPreflight, true);
    assert.equal(supported.capabilities.generationReady, false); checks++;
    const routeHarness = routeAdmissionHarness();
    function authorizedFixture() {
      const item = fixture();
      const config = item.state.model.api_protocol_config as Row;
      config.capability_contract_verified = false;
      config.gaorui_person_asset_fee_authorization = {
        schema: 'gaorui_person_asset_fee_authorization.v1', enabled: true,
        providerOrigin: 'https://gaorui.cc', modelName: item.state.model.model_name, modelId: item.state.model.id,
        credentialBindingFingerprint: item.fingerprint, verifiedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(), evidenceRef: 'fixture:verified-evidence',
        authorizationId: 'fixture-authorization', feeCny: 0, maxChargeCny: 0,
      };
      return item;
    }
    for (const scenario of ['missing', 'expired', 'model-mismatch'] as const) {
      const item = authorizedFixture();
      const config = item.state.model.api_protocol_config as Row;
      const fee = config.gaorui_person_asset_fee_authorization as Row;
      if (scenario === 'missing') delete config.gaorui_person_asset_fee_authorization;
      if (scenario === 'expired') fee.expiresAt = new Date(Date.now() - 1).toISOString();
      if (scenario === 'model-mismatch') fee.modelId = 'other-model';
      const preflight = await item.run();
      assert.equal(preflight.fee, 'unverified', scenario);
      assert.equal(preflight.generationAuthorized, false, scenario);
      const computed = routeHarness.catalog(item.state.model);
      const dto = toPublicModelDto('video', item.state.model, 0, computed);
      assert.equal(dto.capabilities.supportsPersonAssetPreflight, true, scenario);
      assert.equal(dto.capabilities.available, false, scenario);
      assert.equal(dto.capabilities.generationReady, false, scenario);
      const rejected = routeHarness.submit(item.state.model, secret);
      assert.equal(rejected?.status, 422, scenario);
      assert.equal(rejected?.body.error_code, scenario === 'expired' ? 'GAORUI_ASSET_FEE_AUTHORIZATION_EXPIRED'
        : scenario === 'model-mismatch' ? 'GAORUI_ASSET_FEE_SCOPE_MISMATCH' : 'GAORUI_ASSET_FEE_UNVERIFIED', scenario);
      assert.equal(rejected?.body.task_submitted, false, scenario);
      assert.equal(rejected?.body.video_task_submitted, false, scenario);
      assert.equal(rejected?.body.asset_preparation_attempted, false, scenario);
      checks++;
    }
    const admitted = authorizedFixture();
    const preflightAdmitted = await admitted.run();
    assert.equal(preflightAdmitted.fee, 'verified');
    assert.equal(preflightAdmitted.generationAuthorized, false, 'read-only preflight never grants generation');
    const computedAdmitted = routeHarness.catalog(admitted.state.model);
    const admittedDto = toPublicModelDto('video', admitted.state.model, 0, computedAdmitted);
    assert.equal(admittedDto.capabilities.supportsPersonAssetPreflight, true);
    assert.equal(admittedDto.capabilities.capabilitiesVerified, false);
    assert.equal(admittedDto.capabilities.available, true);
    assert.equal(admittedDto.capabilities.generationReady, true);
    assert.equal(routeHarness.submit(admitted.state.model, secret), null); checks++;
    // Catalog GET cannot resolve secrets; the generate route rechecks the real
    // credential fingerprint before any asset preparation or provider call.
    const wrongCredential = authorizedFixture();
    assert.equal(routeHarness.catalog(wrongCredential.state.model).available, true);
    const rejectedCredential = routeHarness.submit(wrongCredential.state.model, 'different-fixture-secret');
    assert.equal(rejectedCredential?.status, 422);
    assert.equal(rejectedCredential?.body.error_code, 'GAORUI_ASSET_FEE_SCOPE_MISMATCH');
    assert.equal(rejectedCredential?.body.task_submitted, false);
    assert.equal(rejectedCredential?.body.video_task_submitted, false);
    assert.equal(rejectedCredential?.body.asset_preparation_attempted, false); checks++;
    const changedBinding = authorizedFixture();
    ((changedBinding.state.model.api_protocol_config as Row).gaorui_person_asset_fee_authorization as Row).credentialBindingFingerprint = 'c'.repeat(64);
    const changedBindingPreflight = await changedBinding.run();
    assert.equal(changedBindingPreflight.fee, 'unverified');
    assert.equal(changedBindingPreflight.generationAuthorized, false);
    assert.equal(routeHarness.catalog(changedBinding.state.model).available, true);
    const changedBindingSubmit = routeHarness.submit(changedBinding.state.model, secret);
    assert.equal(changedBindingSubmit?.body.error_code, 'GAORUI_ASSET_FEE_SCOPE_MISMATCH');
    assert.equal(changedBindingSubmit?.body.task_submitted, false); checks++;
    for (const row of [
      { ...dedicatedRow, provider: 'retired_configuration' },
      { ...dedicatedRow, model_name: 'seedance-2.0' },
      { ...dedicatedRow, protocol_type: 'standard' },
      { ...dedicatedRow, api_protocol_config: { workspace_surfaces: ['ai-video'] } },
    ]) {
      const dto = toPublicModelDto('video', row, 0, { supportsPersonAssetPreflight: true });
      assert.notEqual(dto.capabilities.supportsPersonAssetPreflight, true, 'Caller flag must not grant a preflight capability'); checks++;
    }
    const wrongKind = toPublicModelDto('cover', dedicatedRow, 0, { supportsPersonAssetPreflight: true });
    assert.notEqual(wrongKind.capabilities.supportsPersonAssetPreflight, true); checks++;
    const blockedModel = { id: 'pm_fixture_blocked', displayName: '专用待核验模型', capabilities: {
      supportsPersonAssetPreflight: true, available: false, generationReady: false } };
    const ordinaryModel = { id: 'pm_fixture_available', displayName: '普通可用模型', capabilities: { available: true, generationReady: true } };
    // Both all-gated and mixed catalogues expose an independent inspection choice.
    for (const models of [[blockedModel], [ordinaryModel, blockedModel]]) {
      const html = renderToStaticMarkup(createElement(PersonAssetPreflightPicker, { models, assetId, token: 'fixture-session' }));
      assert.match(html, /素材预检模型/u); assert.match(html, /专用待核验模型/u);
      assert.ok(!html.includes(' disabled')); assert.ok(!html.includes('普通可用模型'));
      assert.ok(!html.includes('正在核对')); checks++;
    }
    console.log(JSON.stringify({ passed: true, checks, networkRequests: 0, databaseWrites: 0, providerRequests: 0 }));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCssLoader) localRequire.extensions['.css'] = previousCssLoader;
    else delete localRequire.extensions['.css'];
    delete localRequire.cache[stylePath];
  }
}
void main();
