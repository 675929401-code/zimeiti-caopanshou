import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { configurationSha256, normalizeModelPoolSnapshot, normalizeWorkspaceModelSnapshot, validateModelPoolSnapshot, validateWorkspaceModelSnapshot, type JsonObject, type ModelPoolEntry, type ModelPoolSnapshot, type PlatformConfigurationReleasePreview } from '../src/lib/platform-configuration-contract';
import { SECURE_SKILL_GPT25_SYNC_V2_CONTRACT, validateSecureSkillGpt25SyncInput } from '../src/lib/secure-skill-image-adapter';

const RUNTIME = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const TARGETS = new Map([
  ['pending-cover-model-1789125082114-2ea1a1e15b37', 'gpt-image-2.5-sunburst'],
  ['pending-cover-model-1789125219296-147da9a502d5', 'gpt-image-2.5-flare'],
]);
const TABLES = ['cover_models', 'video_models', 'llm_models', 'chat_models'] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
type Row = Record<string, unknown>;
type Physical = { hashes: Record<string, string>; targetProtected: Record<string, string>; targetProtocols: Record<string, unknown> };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}
function object(value: unknown): JsonObject { assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'EXPECTED_JSON_OBJECT'); return value as JsonObject; }
function amount(value: unknown): number { assert.ok(typeof value === 'number' && Number.isFinite(value) && value > 0, 'PRICE_MISSING_OR_INVALID'); return value; }
function identity(release: Row) { return { releaseId: String(release.id), snapshotSha256: String(release.snapshot_sha256) }; }
function actor(release: Row): string { const id = String(release.published_by || release.created_by || ''); assert.match(id, UUID, 'EXISTING_RELEASE_ACTOR_REQUIRED'); return id; }
function withoutProtocols(model: ModelPoolEntry) {
  const clone = structuredClone(model); delete clone.configuration.protocolConfig; delete clone.capabilities.protocol; return clone;
}
export function upgradeGpt25Snapshot(before: ModelPoolSnapshot): ModelPoolSnapshot {
  const seen = new Set<string>();
  const models = before.models.map(model => {
    const id = String(model.configuration.legacyId || '');
    if (!TARGETS.has(id)) return model;
    assert.equal(model.configuration.legacyTable, 'cover_models', 'TARGET_PHYSICAL_TABLE_MISMATCH');
    assert.equal(model.kind, 'image'); assert.equal(model.modelName, TARGETS.get(id), 'EXACT_TARGET_MODEL_MISMATCH');
    assert.equal(model.catalogState, 'enabled', 'TARGET_CATALOG_NOT_ENABLED');
    assert.ok(!seen.has(id), 'DUPLICATE_TARGET'); seen.add(id);
    const current = object(model.configuration.protocolConfig);
    assert.deepEqual(current, model.capabilities.protocol, 'TARGET_PROTOCOL_COPIES_DISAGREE');
    const cost = amount(model.pricing.cost); const selling = amount(model.pricing.selling);
    // Public docs quote fixed per-image tiers. The local key's group is unknown.
    // Preserve the existing conservative three-tier costs rather than claiming a group match.
    assert.ok(cost >= 0.16, 'CURRENT_COST_BELOW_PUBLIC_MAX_REQUIRES_GROUP_REVIEW');
    const existingCosts = object(current.resolution_cost_prices);
    for (const tier of ['1K', '2K', '4K']) assert.equal(existingCosts[tier], cost, 'EXISTING_COST_TIERS_NOT_FIXED_PER_IMAGE');
    assert.ok(selling >= cost, 'SELLING_PRICE_BELOW_CURRENT_COST_REQUIRES_REVIEW');
    for (const [field, expected] of [['resolution_cost_prices', cost], ['resolution_prices', selling]] as const) {
      if (current[field] !== undefined) {
        const prices = object(current[field]);
        if (prices['1K'] !== undefined) assert.equal(prices['1K'], expected, 'EXISTING_1K_PRICE_CONFLICTS_WITH_FIXED_PRICE');
      }
    }
    const protocol = structuredClone(current);
    for (const key of ['request_pixel_size_by_resolution', 'input_pixel_size_by_resolution', 'pixel_size_by_resolution', 'size', 'image_size', 'pixel_size', 'resolution', 'aspect_ratio']) delete protocol[key];
    Object.assign(protocol, {
      provider_contract: SECURE_SKILL_GPT25_SYNC_V2_CONTRACT, protocol: 'images_generations', reference_transport: 'generations_url_array',
      resolution_options: ['1K', '2K', '4K'], default_resolution: '2K', aspect_ratios: ['16:9', '9:16', '1:1'],
      quality: current.quality === undefined ? 'high' : current.quality,
      resolution_cost_prices: { '1K': cost, '2K': cost, '4K': cost }, resolution_prices: { '1K': selling, '2K': selling, '4K': selling },
    });
    const issue = validateSecureSkillGpt25SyncInput({ modelName: model.modelName, prompt: 'configuration-only validation', resolution: '2K', aspectRatio: '16:9', providerContract: SECURE_SKILL_GPT25_SYNC_V2_CONTRACT,
      requestProtocol: 'images_generations', referenceTransport: 'generations_url_array', maxReferenceImages: 9, quality: String(protocol.quality), protocolConfig: protocol });
    assert.equal(issue, null, 'UPGRADED_PROTOCOL_INVALID');
    const next = { ...model, configuration: { ...model.configuration, protocolConfig: protocol }, capabilities: { ...model.capabilities, protocol: structuredClone(protocol) } };
    assert.deepEqual(withoutProtocols(next), withoutProtocols(model), 'NON_PROTOCOL_TARGET_CHANGE'); return next;
  });
  assert.equal(seen.size, TARGETS.size, 'BOTH_EXACT_TARGETS_REQUIRED');
  const next = normalizeModelPoolSnapshot({ ...before, models });
  assert.equal(validateModelPoolSnapshot(next).ok, true, 'MODEL_POOL_VALIDATION_FAILED');
  return next;
}
async function physical(client: pg.Client): Promise<Physical> {
  const hashes: Record<string, string> = {}; const targetProtected: Record<string, string> = {}; const targetProtocols: Record<string, unknown> = {};
  for (const table of TABLES) {
    const result = await client.query<{ id: string; body: Row }>('select id::text as id, to_jsonb(t) as body from public.' + table + ' t order by id::text');
    for (const row of result.rows) {
      const key = table + ':' + row.id; hashes[key] = sha(canonical(row.body));
      if (table === 'cover_models' && TARGETS.has(row.id)) {
        const protectedFields = { ...row.body }; delete protectedFields.api_protocol_config; delete protectedFields.updated_at;
        targetProtected[row.id] = sha(canonical(protectedFields));
        targetProtocols[row.id] = row.body.api_protocol_config;
      }
    }
  }
  assert.equal(Object.keys(targetProtected).length, 2, 'PHYSICAL_TARGETS_MISSING'); return { hashes, targetProtected, targetProtocols };
}
function nonTargetHashes(value: Physical) { return Object.fromEntries(Object.entries(value.hashes).filter(([key]) => ![...TARGETS.keys()].some(id => key === 'cover_models:' + id))); }
async function deltaGuard(client: pg.Client, snapshot: ModelPoolSnapshot, alreadyPublished = false) {
  const migration = await readFile(path.resolve('supabase/migrations/20261019010000_model_pool_delta_projection.sql'), 'utf8');
  const projectorBodies: Record<string, string> = {};
  for (const [name, signature] of [
    ['project_model_pool_configuration_atomic', 'p_snapshot jsonb'],
    ['project_model_pool_configuration_atomic_before_explicit_protoco', 'p_snapshot jsonb, p_delta jsonb'],
    ['project_model_pool_configuration_atomic_before_llm_gate', 'p_snapshot jsonb, p_delta jsonb'],
  ]) {
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(' + signature + ')');
    assert.ok(start >= 0, 'EXPECTED_DELTA_PROJECTOR_SOURCE_MISSING');
    const bodyStart = migration.indexOf('AS $$', start) + 'AS $$'.length;
    const bodyEnd = migration.indexOf('$$;', bodyStart);
    assert.ok(bodyStart > start && bodyEnd > bodyStart, 'DELTA_PROJECTOR_SOURCE_BODY_INVALID');
    const expected = migration.slice(bodyStart, bodyEnd).replace(/\s+/gu, ' ').trim();
    const runtimeName = 'public.' + name + '(' + (signature.includes('p_delta') ? 'jsonb,jsonb' : 'jsonb') + ')';
    const actual = await client.query<{ definition: string }>('select prosrc as definition from pg_proc where oid=$1::regprocedure', [runtimeName]);
    assert.equal(actual.rows.length, 1, 'DELTA_PROJECTOR_NOT_INSTALLED');
    const body = actual.rows[0].definition.replace(/\s+/gu, ' ').trim();
    assert.equal(sha(body), sha(expected), 'DELTA_PROJECTOR_IMPLEMENTATION_DIFFERS_FROM_REVIEWED_MIGRATION');
    projectorBodies[runtimeName] = sha(body);
  }
  const functions = await client.query<{ definition: string }>("select pg_get_functiondef('public.project_model_pool_configuration_atomic(jsonb)'::regprocedure) as definition");
  assert.match(functions.rows[0].definition, /model_pool_projection_delta\(p_snapshot\)/u, 'DELTA_PROJECTION_MIGRATION_REQUIRED');
  assert.match(functions.rows[0].definition, /p_snapshot, v_delta/u, 'FROZEN_DELTA_PROJECTION_REQUIRED');
  const delta = (await client.query<{ legacy_table: string; legacy_id: string; removed: boolean }>('select * from public.model_pool_projection_delta($1::jsonb)', [JSON.stringify(snapshot)])).rows;
  assert.equal(delta.length, alreadyPublished ? 0 : 2, 'UNEXPECTED_PHYSICAL_PROJECTION_CHANGE_COUNT');
  assert.deepEqual(delta.map(row => row.legacy_id).sort(), alreadyPublished ? [] : [...TARGETS.keys()].sort(), 'NON_TARGET_PHYSICAL_PROJECTION_DETECTED');
  assert.ok(delta.every(row => row.legacy_table === 'cover_models' && row.removed === false), 'PROJECTION_REMOVAL_OR_TABLE_CHANGE'); return { delta, projectorSha256: sha(functions.rows[0].definition), projectorBodies };
}
function checkPoolPreview(preview: PlatformConfigurationReleasePreview, before: ModelPoolSnapshot, after: ModelPoolSnapshot) {
  assert.equal(preview.kind, 'model-pool'); assert.equal(preview.diff.schema, 'model-pool-config-diff/v1');
  if (preview.diff.schema !== 'model-pool-config-diff/v1') throw new Error('POOL_DIFF_SCHEMA_INVALID');
  assert.deepEqual(preview.diff.models.added, []); assert.deepEqual(preview.diff.models.removed, []);
  const expected = before.models.filter(model => TARGETS.has(String(model.configuration.legacyId))).map(model => model.kind + ':' + model.id).sort();
  assert.deepEqual(preview.diff.models.changed.map(entry => entry.key).sort(), expected, 'PREVIEW_TARGET_SCOPE_MISMATCH');
  assert.equal(preview.candidate.snapshotSha256, configurationSha256(after));
}
async function main() {
  const execute = process.argv.includes('--execute');
  assert.ok(process.argv.slice(2).every(arg => arg === '--execute'), 'UNKNOWN_ARGUMENT');
  const runtime = JSON.parse((await readFile(RUNTIME, 'utf8')).replace(/^\uFEFF/u, '')) as Row;
  const connection = runtime.ownerConnection as pg.ClientConfig;
  assert.equal(runtime.localOnly, true); assert.equal(connection.host, '127.0.0.1'); assert.equal(Number(connection.port), 54322); assert.equal(connection.database, 'zimeiti_local');
  assert.equal(runtime.supabaseUrl, 'http://127.0.0.1:54321'); assert.ok(typeof runtime.serviceRoleKey === 'string' && runtime.serviceRoleKey);
  process.env.SERVER_ENV_DISCOVERY_DISABLED = '1'; process.env.SHARED_CONFIGURATION_ENABLED = '0';
  process.env.COZE_SUPABASE_URL = String(runtime.supabaseUrl); process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = String(runtime.serviceRoleKey);
  const admin = await import('../src/lib/server/platform-configuration-admin');
  const client = new pg.Client({ ...connection, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  const output = path.resolve('.codex-evidence/gpt25-reference-capabilities-local-' + new Date().toISOString().replace(/[:.]/gu, '-'));
  await mkdir(output, { recursive: true });
  const receipt: Row = { mode: execute ? 'execute' : 'read-only-plan', providerCalls: 0, secretsPrinted: false, completed: false, writesStarted: false };
  const evidence = async (name: string, value: unknown) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    await client.connect();
    const actual = (await client.query('select current_database() as db, host(inet_server_addr()) as host, inet_server_port() as port')).rows[0];
    assert.equal(actual.db, 'zimeiti_local'); assert.equal(actual.host, '127.0.0.1'); assert.equal(Number(actual.port), 54322);
    const [pool, workspace] = await Promise.all([admin.readCurrentPlatformConfiguration('model-pool'), admin.readCurrentPlatformConfiguration('workspace-models')]);
    assert.ok(pool && workspace, 'PUBLISHED_POOL_AND_WORKSPACE_REQUIRED');
    const actorId = actor(pool.release); const workspaceActor = actor(workspace.release);
    const beforePhysical = await physical(client);
    await evidence('before-model-pool.json', pool); await evidence('before-workspace.json', workspace);
    await evidence('before-physical-hashes.json', { hashes: beforePhysical.hashes, targetProtected: beforePhysical.targetProtected });
    const nextPool = upgradeGpt25Snapshot(pool.snapshot);
    const poolAlreadyCurrent = configurationSha256(nextPool) === configurationSha256(pool.snapshot);
    const projection = await deltaGuard(client, nextPool, poolAlreadyCurrent);
    for (const model of pool.snapshot.models.filter(model => TARGETS.has(String(model.configuration.legacyId)))) {
      const live = { ...object(beforePhysical.targetProtocols[String(model.configuration.legacyId)]) }; delete live.__model_activation_gate;
      const planned = { ...object(model.configuration.protocolConfig) }; delete planned.__model_activation_gate;
      assert.deepEqual(live, planned, 'TARGET_LIVE_PROTOCOL_DRIFT_REQUIRES_REVIEW');
    }
    const modelValidation = validateModelPoolSnapshot(nextPool);
    const surfacesSha256 = configurationSha256(workspace.snapshot.surfaces);
    await evidence('plan.json', { currentPool: identity(pool.release), currentWorkspace: identity(workspace.release), targetPoolSha256: configurationSha256(nextPool), modelValidation, projection, surfacesSha256,
      poolAlreadyCurrent, targets: nextPool.models.filter(model => TARGETS.has(String(model.configuration.legacyId))).map(model => ({ legacyId: model.configuration.legacyId, modelName: model.modelName, pricing: model.pricing, protocol: model.configuration.protocolConfig })) });
    if (!execute) { receipt.completed = true; return; }
    const freshPool = await admin.readCurrentPlatformConfiguration('model-pool'); const freshWorkspace = await admin.readCurrentPlatformConfiguration('workspace-models');
    assert.ok(freshPool && freshWorkspace); assert.deepEqual(identity(freshPool.release), identity(pool.release)); assert.deepEqual(identity(freshWorkspace.release), identity(workspace.release));
    assert.deepEqual((await physical(client)).hashes, beforePhysical.hashes, 'PHYSICAL_STATE_CHANGED_BEFORE_PUBLICATION');
    await deltaGuard(client, nextPool, poolAlreadyCurrent);
    let publishedPool = pool.release;
    if (!poolAlreadyCurrent) {
      receipt.writesStarted = true;
      const stagedPool = await admin.createPlatformConfigurationCandidate(actorId, 'model-pool', nextPool, 'GPT Image 2.5 explicit v2 reference resolutions and ratios; preserve prices and all other models');
      receipt.poolCandidateId = String(stagedPool.id); await evidence('pool-candidate.json', stagedPool);
      await admin.validatePlatformConfigurationCandidate(actorId, 'model-pool', String(stagedPool.id));
      const poolPreview = await admin.previewPlatformConfigurationRelease('model-pool', String(stagedPool.id));
      checkPoolPreview(poolPreview, pool.snapshot, nextPool); assert.equal(poolPreview.current?.releaseId, String(pool.release.id));
      await evidence('pool-preview.json', poolPreview);
      publishedPool = await admin.publishPlatformConfigurationRelease(actorId, 'model-pool', String(stagedPool.id), poolPreview.previewSha256);
    }
    receipt.publishedPoolId = String(publishedPool.id);
    await evidence('receipt.json', receipt);
    const midPhysical = await physical(client);
    assert.deepEqual(nonTargetHashes(midPhysical), nonTargetHashes(beforePhysical), 'NON_TARGET_PHYSICAL_ROWS_CHANGED_AFTER_POOL_PUBLISH');
    assert.deepEqual(midPhysical.targetProtected, beforePhysical.targetProtected, 'TARGET_NON_PROTOCOL_FIELDS_CHANGED');
    const latestWorkspace = await admin.readCurrentPlatformConfiguration('workspace-models');
    assert.ok(latestWorkspace); assert.deepEqual(identity(latestWorkspace.release), identity(workspace.release), 'WORKSPACE_CHANGED_DURING_POOL_PUBLICATION');
    const nextWorkspace = normalizeWorkspaceModelSnapshot({ ...workspace.snapshot, modelPoolRelease: identity(publishedPool) });
    assert.equal(configurationSha256(nextWorkspace.surfaces), surfacesSha256, 'WORKSPACE_SURFACES_CHANGED');
    assert.equal(validateWorkspaceModelSnapshot(nextWorkspace, nextPool).ok, true, 'WORKSPACE_REBASE_VALIDATION_FAILED');
    if (configurationSha256(nextWorkspace) === configurationSha256(workspace.snapshot)) {
      receipt.publishedWorkspaceId = String(workspace.release.id); receipt.completed = true; return;
    }
    receipt.writesStarted = true;
    const stagedWorkspace = await admin.createPlatformConfigurationCandidate(workspaceActor, 'workspace-models', nextWorkspace, 'Rebase unchanged workspace surfaces onto explicit GPT Image 2.5 v2 model-pool release');
    receipt.workspaceCandidateId = String(stagedWorkspace.id); await evidence('workspace-candidate.json', stagedWorkspace);
    await admin.validatePlatformConfigurationCandidate(workspaceActor, 'workspace-models', String(stagedWorkspace.id));
    const workspacePreview = await admin.previewPlatformConfigurationRelease('workspace-models', String(stagedWorkspace.id));
    assert.equal(workspacePreview.diff.schema, 'workspace-model-config-diff/v1');
    if (workspacePreview.diff.schema !== 'workspace-model-config-diff/v1') throw new Error('WORKSPACE_DIFF_SCHEMA_INVALID');
    assert.ok(workspacePreview.diff.surfaces.every(surface => !surface.changed), 'WORKSPACE_SURFACE_DIFF_REJECTED');
    assert.equal(workspacePreview.current?.releaseId, String(workspace.release.id)); await evidence('workspace-preview.json', workspacePreview);
    const publishedWorkspace = await admin.publishPlatformConfigurationRelease(workspaceActor, 'workspace-models', String(stagedWorkspace.id), workspacePreview.previewSha256);
    receipt.publishedWorkspaceId = String(publishedWorkspace.id);
    const [afterPool, afterWorkspace] = await Promise.all([admin.readCurrentPlatformConfiguration('model-pool'), admin.readCurrentPlatformConfiguration('workspace-models')]);
    assert.ok(afterPool && afterWorkspace); assert.equal(afterPool.release.id, publishedPool.id); assert.equal(afterWorkspace.release.id, publishedWorkspace.id);
    assert.equal(configurationSha256(afterPool.snapshot), configurationSha256(nextPool)); assert.equal(configurationSha256(afterWorkspace.snapshot.surfaces), surfacesSha256);
    assert.deepEqual(afterWorkspace.snapshot.modelPoolRelease, identity(afterPool.release));
    const finalPhysical = await physical(client); assert.deepEqual(nonTargetHashes(finalPhysical), nonTargetHashes(beforePhysical)); assert.deepEqual(finalPhysical.targetProtected, beforePhysical.targetProtected);
    await evidence('after-physical-hashes.json', { hashes: finalPhysical.hashes, targetProtected: finalPhysical.targetProtected });
    await evidence('after-releases.json', { pool: identity(afterPool.release), workspace: identity(afterWorkspace.release), surfacesSha256 }); receipt.completed = true;
  } catch (error) {
    // No automatic rollback: publication may already have advanced one dependency.
    receipt.failureCode = error instanceof Error ? error.name : 'UNKNOWN_FAILURE';
    receipt.requiresReview = true; throw error;
  } finally {
    await evidence('receipt.json', receipt); await client.end(); console.log(JSON.stringify({ ...receipt, output }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error instanceof Error ? error.message.split('\n')[0] : 'GPT25_LOCAL_UPGRADE_FAILED'); process.exitCode = 1; });
}
