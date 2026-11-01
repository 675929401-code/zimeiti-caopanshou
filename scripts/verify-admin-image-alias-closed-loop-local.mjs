#!/usr/bin/env node
// Local, root-reviewed acceptance only. Importing and --plan do no I/O.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPaidDatabaseReadiness, runtimeIdentity, makePaidPostGuard, assertPaidActor,
  assertPaidQuote, assertPaidFinalPass, installPaidAuthCookie, waitForImageDecoded, capturePaidDownload,
  parseArgs as imageArgs, main as imageMain } from './verify-image-workbench-live-e2e.mjs';
import { readDatabaseTargetIdentity } from './lib/database-target-identity.mjs';
import { resolveWorkspaceCatalogConsumers } from './verify-admin-model-closed-loop-local.mjs';

const ORIGIN = 'http://127.0.0.1:5000';
const DB_ID = 'f182534099e8496efcf791f5ff09470500b0d3d320ad801992056f183a32ca35';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const check = (value, code) => { if (!value) throw new Error(code); };
// Same stable model identity accepted by assertImageValidationModelId; these are
// not release/actor/revision UUIDs (existing cover models commonly use text IDs).
export function assertStableModelId(value) { check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value) && !value.startsWith('pm_'), 'STABLE_IMAGE_MODEL_ID_REQUIRED'); }
const IMAGE_READINESS_FIELDS=['canary_verified','canaryVerified','verification_notice','verificationNotice','__model_activation_gate'];
const protocolWithoutGate = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !IMAGE_READINESS_FIELDS.includes(key)));
const protocolForForm = value => Object.fromEntries(Object.entries(protocolWithoutGate(value)).filter(([key])=>key!=='admin_notes'));
export function cloneBusiness(entry) {
  const copy = structuredClone(entry); delete copy.id; delete copy.name; delete copy.credentialRef;
  delete copy.configuration.legacyId;
  const notes=copy.configuration.protocolConfig?.admin_notes??copy.configuration.adminNotes??'';
  delete copy.configuration.adminNotes;
  if (copy.configuration.protocolConfig) copy.configuration.protocolConfig = {...protocolWithoutGate(copy.configuration.protocolConfig),admin_notes:notes};
  if (copy.capabilities.protocol) copy.capabilities.protocol = {...protocolWithoutGate(copy.capabilities.protocol),admin_notes:notes};
  return copy;
}
export function assertCloneEntry(source, alias) { check(canonical(cloneBusiness(source)) === canonical(cloneBusiness(alias)), 'ALIAS_CLONE_BUSINESS_MISMATCH'); }
export function assertCloneForm(source, body) {
  const expected = { provider: source.provider, model_name: source.model_name, api_endpoint: source.api_endpoint,
    cost_price: Number(source.cost_price), cost_per_use: Number(source.selling_price), supports_image_input: source.supports_image_input,
    sort_order: source.sort_order, admin_notes: source.api_protocol_config?.admin_notes || '', api_protocol_config: protocolForForm(source.api_protocol_config) };
  for (const [key, value] of Object.entries(expected)) check(canonical(body[key]) === canonical(value), 'ALIAS_FORM_BUSINESS_MISMATCH');
}
export function physicalBusiness(row) {
  return {provider:row.provider,modelName:row.model_name,endpoint:row.api_endpoint,cost:Number(row.cost_price),selling:Number(row.selling_price),sortOrder:row.sort_order,
    supportsImageInput:row.supports_image_input,protocol:{...protocolWithoutGate(row.api_protocol_config),admin_notes:row.api_protocol_config?.admin_notes??''}};
}
export function publicationMetadata(request) {
  try { return request.postDataJSON(); } catch {
    const encoded = request.headers()['x-image-publication-request'];
    check(encoded && encoded.length < 16000, 'PUBLICATION_METADATA_REQUIRED');
    return JSON.parse(decodeURIComponent(encoded));
  }
}
export async function journalBeforeForward({ journal, event, checkpoint, forward }) {
  journal.push(event); await checkpoint(); return forward();
}
export function createCheckpointWriter(destination, io=fs) {
  let queue=Promise.resolve();
  return snapshot=>{
    // Capture each revision at invocation, then serialize every physical commit.
    // A rejected queue stays rejected: no later checkpoint may conceal a failed
    // pre-dispatch write and no caller awaiting it is allowed to forward.
    const bytes=JSON.stringify(snapshot,null,2),temporary=destination+'.checkpoint-'+crypto.randomUUID()+'.tmp';
    const next=queue.then(async()=>{
      const handle=await io.open(temporary,'wx',0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await io.rename(temporary,destination);
    });
    queue=next;void next.catch(()=>{});return next;
  };
}
export function assertReceiptLedger(rows, referenceId, charged) {
  check(typeof referenceId==='string'&&referenceId&&rows.length===1&&rows[0].referenceId===referenceId
    && Number.isFinite(charged)&&Math.abs(rows[0].amount)===charged,'EXACT_RECEIPT_LEDGER_BINDING_REQUIRED');
}

// Used by the real UI flow and injected fixture flow. No timers stand in for a
// response/readback: the same validation identity must reach published state.
export async function activateValidationUI({ page, dialog, aliasId, proof, recordId, read, checkpoint, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const pending = page.waitForResponse(response => response.url().split('?')[0] === ORIGIN + '/api/admin/cover-models/validation/publish' && response.request().method() === 'POST').catch(() => null);
  await checkpoint({ phase: 'activation-dispatch', aliasId, recordId, proof });
  await dialog.getByRole('button', { name: /保存验证凭证并发布模型|启用此配置/ }).click();
  const response = await pending; check(response?.ok(), 'ACTIVATION_RESPONSE_UNKNOWN');
  const request = publicationMetadata(response.request());
  check(request.modelId === aliasId && request.imageRecordId === recordId && canonical(request.proof) === canonical(proof), 'ACTIVATION_REQUEST_BINDING');
  const result = await response.json();
  check(result.success === true && result.modelId === aliasId && result.imageRecordId === recordId && result.assetId, 'ACTIVATION_RESPONSE_BINDING');
  const deadline = now() + 60000;
  for (;;) {
    const dto = await read(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(aliasId)}`);
    check(dto.modelId === aliasId && dto.configurationHash === proof.configurationHash && dto.validationKey === proof.validationKey
      && dto.existingAttempt?.imageRecordId === recordId && (!dto.existingAttempt.assetId || dto.existingAttempt.assetId === result.assetId), 'ACTIVATION_READBACK_BINDING');
    if (dto.acceptance === 'published' && dto.existingAttempt.state === 'published') return dto;
    check(now() < deadline, 'ACTIVATION_READBACK_UNKNOWN'); await wait(1000);
  }
}

export async function publishCandidateUI({ page, kind, releaseId, expectedCurrent, read, checkpoint, inspect = () => {} }) {
  const endpoint = kind === 'model-pool' ? '/api/admin/model-pool-releases' : '/api/admin/workspace-model-releases';
  const overview = await read(endpoint), candidate = overview.releases.find(x => x.id === releaseId);
  check(overview.current?.id === expectedCurrent.id && overview.current.snapshot_sha256 === expectedCurrent.snapshot_sha256, 'PUBLISH_BASE_CURRENT_CHANGED');
  check(candidate && !candidate.is_current && ['draft', 'validated'].includes(candidate.status), 'OWN_UNPUBLISHED_CANDIDATE_REQUIRED'); inspect(candidate);
  const panel = page.getByTestId(`platform-release-panel-${kind}`), row = panel.locator(`[data-release-id="${releaseId}"]`);
  if (!await row.isVisible()) await panel.getByRole('button', { name: /管理版本|收起版本/ }).click();
  await row.getByRole('button', { name: '重新校验', exact: true }).click();
  const previewResponse = page.waitForResponse(response => response.request().method() === 'GET' && response.url() === ORIGIN + endpoint + '?previewReleaseId=' + encodeURIComponent(releaseId)).catch(() => null);
  await row.getByRole('button', { name: '查看差异', exact: true }).click();
  const observedPreview = await previewResponse; check(observedPreview?.ok(), 'PREVIEW_RESPONSE_REQUIRED');
  const { preview } = await observedPreview.json();
  check(preview.current?.releaseId === expectedCurrent.id && preview.current.snapshotSha256 === expectedCurrent.snapshot_sha256
    && preview.candidate?.releaseId === releaseId && preview.candidate.snapshotSha256 === candidate.snapshot_sha256
    && /^[a-f0-9]{64}$/u.test(preview.previewSha256), 'PREVIEW_BASE_OR_CANDIDATE_CHANGED');
  const fresh = await read(endpoint); check(fresh.current?.id === expectedCurrent.id && fresh.current.snapshot_sha256 === expectedCurrent.snapshot_sha256, 'PREPUBLISH_CURRENT_CHANGED');
  await checkpoint({ phase: 'publish-dispatch', kind, releaseId, candidateSha256: candidate.snapshot_sha256, baseReleaseId: expectedCurrent.id, baseSha256: expectedCurrent.snapshot_sha256, previewSha256: preview.previewSha256 });
  const pending = page.waitForResponse(response => response.url().split('?')[0] === ORIGIN + endpoint && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'publish').catch(() => null);
  await row.getByRole('button', { name: '按预览发布', exact: true }).click();
  const published = await pending; check(published?.ok(), 'PUBLICATION_RESPONSE_UNKNOWN');
  const body = published.request().postDataJSON(); check(body.releaseId === releaseId && body.previewSha256 === preview.previewSha256, 'PUBLICATION_REQUEST_CAS_BINDING');
  const after = await read(endpoint); check(after.current?.id === releaseId && after.current.snapshot_sha256 === candidate.snapshot_sha256, 'PUBLICATION_READBACK_UNKNOWN');
  return after.current;
}

export class ExposureBudget {
  constructor(limit) { check(Number.isFinite(limit) && limit > 0 && limit <= 10, 'BUDGET_LIMIT'); this.limit = limit; this.spent = 0; this.entries = new Map(); this.stopped = false; }
  reserve(id, maximum) {
    check(!this.stopped && !this.entries.has(id), 'BUDGET_STOPPED_OR_DUPLICATE');
    check(Number.isFinite(maximum) && maximum > 0 && this.spent + this.reserved + maximum <= this.limit + 1e-8, 'BUDGET_EXPOSURE');
    this.entries.set(id, { maximum, state: 'reserved' });
  }
  settle(id, charged) {
    const entry = this.entries.get(id);
    check(entry?.state === 'reserved' && Number.isFinite(charged) && charged >= 0 && charged <= entry.maximum + 1e-8, 'BUDGET_SETTLEMENT');
    entry.state = 'settled'; entry.charged = charged; this.spent += charged;
  }
  unknown(id) { check(this.entries.get(id)?.state === 'reserved', 'BUDGET_UNKNOWN_ID'); this.entries.get(id).state = 'unknown'; this.stopped = true; }
  get reserved() { return [...this.entries.values()].filter(x => x.state !== 'settled').reduce((sum, x) => sum + x.maximum, 0); }
  safe() { return { limit: this.limit, spent: this.spent, reserved: this.reserved, stopped: this.stopped, operations: [...this.entries].map(([id, x]) => ({ id, ...x })) }; }
}

export function requireLocalDatabase(value) {
  const url = new URL(value);
  check(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '54322' && url.pathname === '/zimeiti_local', 'CANONICAL_LOOPBACK_DATABASE_REQUIRED');
  check(!url.search && !url.hash, 'DATABASE_URL_OPTIONS_FORBIDDEN');
}

export function chooseRamCredential(row, binding) {
  check(row && binding && binding.model_key === `cover_models:${row.id}` && UUID.test(binding.revision), 'SOURCE_INDEPENDENT_BINDING_REQUIRED');
  check(binding.credential_ref === `secret://platform-model/cover_models/${row.id}`, 'SOURCE_BINDING_IDENTITY');
  const value = String(binding.secret_value || '').trim();
  check(value && !value.startsWith('secret://') && !/^\*+$/u.test(value), 'SOURCE_CREDENTIAL_NOT_REUSABLE_IN_RAM');
  // env:// is a server reference, not the source model's logical secret:// binding.
  check(!value.startsWith('env://') || /^env:\/\/[A-Z][A-Z0-9_]+$/u.test(value), 'ENV_REFERENCE_INVALID');
  check(row.api_key === value, 'SOURCE_ROW_BINDING_SECRET_MISMATCH');
  return value;
}

export function assertOnlyAliasDelta(before, after, aliasKey, operation) {
  check(before.schema === 'model-pool-config/v1' && after.schema === before.schema, 'POOL_SCHEMA_REQUIRED');
  const indexed = snapshot => { const map = new Map(); for (const row of snapshot.models) { const key = `${row.kind}:${row.id}`; check(!map.has(key), 'DUPLICATE_COMPOSITE_MODEL_KEY'); map.set(key, row); } return map; };
  const left = indexed(before), right = indexed(after); aliasKey = `image:${aliasKey}`;
  check([...left].every(([key, value]) => key === aliasKey || canonical(value) === canonical(right.get(key))), 'UNRELATED_MODEL_CHANGED');
  check([...right.keys()].every(key => left.has(key) || key === aliasKey), 'UNRELATED_MODEL_ADDED');
  const alias = right.get(aliasKey); check(alias?.kind === 'image', 'ALIAS_MISSING');
  if (operation === 'create') check(!left.has(aliasKey) && alias.catalogState === 'enabled', 'CREATE_ALIAS_DELTA');
  if (operation === 'retire') check(left.has(aliasKey) && alias.catalogState === 'retired', 'RETIRE_ALIAS_DELTA');
  return alias;
}

export function assertSourceUnchanged(before, after) {
  check(before.businessSha === after.businessSha && before.bindingRevision === after.bindingRevision && before.bindingRef === after.bindingRef && before.credentialEqual === true && after.credentialEqual === true, 'ORIGINAL_SOURCE_CHANGED');
}

export function assertWorkspaceOnlyAlias(before, after, modelId, enabled, currentPool) {
  check(before.schema === after.schema && before.schema === 'workspace-model-config/v1', 'WORKSPACE_SCHEMA_REQUIRED');
  check(currentPool && after.modelPoolRelease?.releaseId === currentPool.id && after.modelPoolRelease?.snapshotSha256 === currentPool.snapshot_sha256, 'WORKSPACE_CURRENT_POOL_BINDING_REQUIRED');
  check(canonical(Object.keys(before.surfaces).sort()) === canonical(Object.keys(after.surfaces).sort()), 'WORKSPACE_SURFACES_CHANGED');
  for (const [surface, original] of Object.entries(before.surfaces)) {
    const next = after.surfaces[surface];
    if (surface !== 'image-workbench') check(canonical(original) === canonical(next), 'UNRELATED_WORKSPACE_CHANGED');
    else {
      check(original.kind === next.kind && next.assignedModelIds.includes(modelId) === enabled, 'OWN_ASSIGNMENT_REQUIRED');
      for (const key of ['assignedModelIds', 'orderedModelIds']) check(canonical(original[key].filter(x => x !== modelId)) === canonical(next[key].filter(x => x !== modelId)), 'UNRELATED_WORKSPACE_ORDER_CHANGED');
    }
  }
}

export function plan() {
  return { schema: 'admin-image-alias-closed-loop-plan.v1', mode: 'plan', origin: ORIGIN,
    networkCalls: 0, databaseCalls: 0, providerCalls: 0, filesystemWrites: 0,
    automaticPaidRetries: 0, maximumCombinedExposureYuan: 10,
    sequence: ['canonical DB and fresh paid readiness + exact running build', 'RAM source credential + independent alias identity',
      'real admin form -> own candidate validate/preview/publish', 'one admin UI validation -> terminal owned artifact -> normal activation',
      'explicit image-workbench assignment -> own workspace candidate publish', 'one student real workbench submit via existing paid harness',
      'owned history/download/one ledger reference and reload without charging', 'fresh current unassign own alias and retire own alias', 'retired alias history download without charging'],
    executionRequires: ['ROOT_IMAGE_ALIAS_EXECUTION_AUTHORIZED=1', 'source-id', 'run-id', 'admin-user-id', 'student-user-id', 'expected-source-version', 'expected-build-id', 'database-readiness', 'database-readiness-sha256', 'expected-database-target', 'expected-database-identity', 'max-charge', 'remaining-budget', 'resolution', 'aspect-ratio'],
    evidenceBoundary: 'self-test/plan are not real provider, UI, database or paid acceptance; any unknown operation stops new paid work and requires root reconciliation' };
}

function parse(args) {
  const values = {}; const flags = new Set();
  const allowed = new Set(['source-id', 'run-id', 'admin-user-id', 'student-user-id', 'expected-source-version', 'expected-build-id', 'database-readiness', 'database-readiness-sha256', 'expected-database-target', 'expected-database-identity', 'max-charge', 'remaining-budget', 'resolution', 'aspect-ratio']);
  for (const arg of args) {
    if (['--execute', '--plan', '--self-test'].includes(arg)) { check(!flags.has(arg), 'DUPLICATE_ARGUMENT'); flags.add(arg); continue; }
    const match = /^--([^=]+)=(.+)$/u.exec(arg); check(match && allowed.has(match[1]) && !(match[1] in values), 'UNKNOWN_OR_DUPLICATE_ARGUMENT'); values[match[1]] = match[2];
  }
  check(flags.size <= 1, 'CONFLICTING_MODE');
  if (!flags.has('--execute')) return { execute: false, selfTest: flags.has('--self-test'), values };
  for (const key of allowed) check(values[key], 'EXPLICIT_EXECUTE_INPUT_REQUIRED');
  check(/^[a-zA-Z0-9_-]{8,90}$/u.test(values['run-id']), 'RUN_ID_REQUIRED');
  assertStableModelId(values['source-id']);
  check(UUID.test(values['admin-user-id']) && UUID.test(values['student-user-id']) && values['admin-user-id'] !== values['student-user-id'], 'EXPLICIT_DISTINCT_ACTOR_UUIDS');
  check(values['expected-database-identity'] === DB_ID && values['expected-database-target'] === '127.0.0.1:54322/zimeiti_local', 'DATABASE_PIN_REQUIRED');
  const maximum = Number(values['max-charge']), remaining = Number(values['remaining-budget']);
  check(maximum > 0 && remaining > 0 && remaining <= 10 && maximum * 2 <= remaining, 'TWO_CALL_EXPOSURE_MUST_FIT');
  return { execute: true, values, maximum, remaining };
}

export async function selfTest() {
  const originalFetch = globalThis.fetch; let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('NETWORK_FORBIDDEN'); };
  let groups = 0;
  try {
    assert.equal(parse([]).execute, false); assert.equal(plan().databaseCalls, 0); assert.throws(() => parse(['--execute'])); groups++;
    requireLocalDatabase('postgresql://fixture:fixture@127.0.0.1:54322/zimeiti_local');
    for (const target of ['localhost:54322/zimeiti_local', '127.0.0.1:5432/zimeiti_local', '127.0.0.1:54322/postgres', '127.0.0.1:54322/zimeiti_local?options=x']) assert.throws(() => requireLocalDatabase(`postgresql://fixture@${target}`)); groups++;
    const budget = new ExposureBudget(10); budget.reserve('admin', 4); budget.reserve('student', 4); assert.throws(() => budget.reserve('third', 3)); budget.settle('admin', 2); assert.equal(budget.safe().spent + budget.reserved, 6); groups++;
    budget.unknown('student'); assert.equal(budget.reserved, 4); assert.throws(() => budget.reserve('new', .01)); groups++;
    const id = '12345678-1234-4234-8234-123456789abc', row = { id, api_key: 'env://FIXTURE_IMAGE_KEY' }, binding = { model_key: `cover_models:${id}`, credential_ref: `secret://platform-model/cover_models/${id}`, revision: id, secret_value: row.api_key };
    assert.equal(chooseRamCredential(row, binding), row.api_key);
    assert.throws(() => chooseRamCredential({ ...row, api_key: binding.credential_ref }, { ...binding, secret_value: binding.credential_ref }));
    assert.throws(() => chooseRamCredential(row, { ...binding, model_key: 'cover_models:other' })); groups++;
    const before = { schema: 'model-pool-config/v1', models: [{ kind: 'image', id: 'source', name: 'untouched' }] }, alias = { kind: 'image', id: 'alias', catalogState: 'enabled' };
    assertOnlyAliasDelta(before, { ...before, models: [...before.models, alias] }, 'alias', 'create');
    assert.throws(() => assertOnlyAliasDelta(before, { ...before, models: [{ kind: 'image', id: 'source', name: 'changed' }, alias] }, 'alias', 'create')); groups++;
    const unchanged = { businessSha: 'same', bindingRevision: id, bindingRef: 'source', credentialEqual: true };
    assertSourceUnchanged(unchanged, unchanged); assert.throws(() => assertSourceUnchanged(unchanged, { ...unchanged, bindingRevision: 'new' })); groups++;
    // Execute the existing production harness guard, not a local imitation.
    const count = { attempts: 0, forwarded: 0 }, guard = makePaidPostGuard({ modelId: 'alias', historySurface: 'image-workbench' }, count);
    const route = body => ({ request: () => ({ method: () => 'POST', postDataJSON: () => body }), continue: async () => {}, abort: async () => {} });
    await assert.rejects(guard(route({ modelId: 'source', historySurface: 'image-workbench' })));
    await guard(route({ modelId: 'alias', historySurface: 'image-workbench' }));
    await assert.rejects(guard(route({ modelId: 'alias', historySurface: 'image-workbench' }))); assert.equal(count.forwarded, 1); groups++;
    assert.throws(() => assertPaidActor({ user: { id: 'student', role: 'admin' } }, { userId: 'student', actorRole: 'student' }));
    assert.throws(() => assertPaidQuote(6, { maxCharge: 5, remainingBudget: 10 })); groups++;
    const workspace = { schema: 'workspace-model-config/v1', surfaces: { 'image-workbench': { kind: 'image', assignedModelIds: ['source'], orderedModelIds: ['source'] }, other: { kind: 'image', assignedModelIds: [], orderedModelIds: [] } } };
    const assigned = structuredClone(workspace); assigned.surfaces['image-workbench'].assignedModelIds.push('alias'); assigned.surfaces['image-workbench'].orderedModelIds.push('alias');
    const poolIdentity = { id: 'pool', snapshot_sha256: 'sha' }; assigned.modelPoolRelease = { releaseId: 'pool', snapshotSha256: 'sha' };
    assertWorkspaceOnlyAlias(workspace, assigned, 'alias', true, poolIdentity); assigned.surfaces.other.assignedModelIds.push('alias'); assert.throws(() => assertWorkspaceOnlyAlias(workspace, assigned, 'alias', true, poolIdentity)); groups++;
    assert.equal(networkAttempts, 0);
    return { success: true, mode: 'zero-network-self-test', groups, networkAttempts, realDatabaseCalls: 0, paidCalls: 0, realBrowserCalls: 0 };
  } finally { globalThis.fetch = originalFetch; }
}

async function execute(options) {
  check(process.env.ROOT_IMAGE_ALIAS_EXECUTION_AUTHORIZED === '1', 'ROOT_EXECUTION_AUTHORIZATION_REQUIRED');
  check(process.env.LOCAL_NAV_ORIGIN === ORIGIN, 'EXACT_LOOPBACK_RUNTIME_REQUIRED');
  requireLocalDatabase(String(process.env.DATABASE_URL || ''));
  const v = options.values, adminToken = process.env.LOCAL_NAV_ADMIN_TOKEN, studentToken = process.env.R267_CUSTOMER_TOKEN, stepUp = process.env.LOCAL_ADMIN_STEP_UP_TOKEN;
  check(adminToken && studentToken && stepUp, 'CONTROLLED_SESSION_WRAPPERS_REQUIRED');
  const wrapper = JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER || '{}');
  check(wrapper.id === v['student-user-id'] && wrapper.role === 'student', 'EXPLICIT_WRAPPED_STUDENT_REQUIRED');
  const runId = v['run-id'], name = `本地新增闭环-${runId}`, output = path.resolve('.codex-evidence/admin-image-alias-closed-loop', runId);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output, { recursive: false });
  const budget = new ExposureBudget(options.remaining), report = { schema: 'admin-image-alias-closed-loop.v1', runId, status: 'running', phases: [], cleanup: { recoveryRequired: false }, paid: budget.safe() };
  const writeCheckpoint=createCheckpointWriter(path.join(output,'report.json'));
  const checkpoint = async () => { report.paid = budget.safe(); await writeCheckpoint(report); };
  let unknownWrite = false, browser, context, page, aliasId, aliasPublicId, baselinePool, baselineCatalogs, sourceFingerprint, cleanupNeeded = false, workspaceAssigned = false;
  let ramCredential = '', sourceEntry;
  const auth = ordinary => ({ Authorization: `Bearer ${ordinary ? studentToken : adminToken}`, ...(!ordinary ? { 'x-admin-step-up': stepUp } : {}) });
  async function read(endpoint, ordinary = false) {
    check(endpoint.startsWith('/api/') && !endpoint.includes('://'), 'LOCAL_API_PATH');
    const response = await fetch(ORIGIN + endpoint, { headers: auth(ordinary), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    check(response.ok, 'READBACK_HTTP_REJECTED'); return response.json();
  }
  async function account(ordinary) {
    const cash = await read('/api/cash/balance', ordinary);
    const tx = await read('/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=100', ordinary);
    check(Number.isFinite(Number(cash.balance)) && Array.isArray(tx.data?.transactions), 'REAL_ACCOUNT_READBACK_REQUIRED');
    return { cash: Number(cash.balance), transactions: tx.data.transactions.filter(x => x.category === 'cash').map(x => ({ id: x.id, amount: Number(x.amount), referenceId: x.referenceId })) };
  }
  const basePaid = role => imageArgs([`--run-id=${runId}-${role}`, `--actor-role=${role}`, `--user-id=${v[role === 'admin' ? 'admin-user-id' : 'student-user-id']}`,
    ...['expected-source-version', 'expected-build-id', 'database-readiness', 'database-readiness-sha256', 'expected-database-target', 'expected-database-identity'].map(key => `--${key}=${v[key]}`), `--max-charge=${options.maximum}`, `--remaining-budget=${Math.min(10, budget.limit - budget.spent - budget.reserved)}`]);
  const fresh = async role => { const paidOptions = basePaid(role); const runtime = await runtimeIdentity(paidOptions); await readPaidDatabaseReadiness(paidOptions.paid, runtime); return runtime; };
  const sourceRead = async (includeCredential = false) => {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'codex-image-alias-readonly' });
    try {
      await client.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      check((await client.query('show transaction_read_only')).rows[0]?.transaction_read_only === 'on', 'READ_ONLY_TRANSACTION_REQUIRED');
      check((await readDatabaseTargetIdentity(client, '127.0.0.1')).fingerprint === DB_ID, 'CANONICAL_PG_IDENTITY');
      const row = (await client.query('select * from public.cover_models where id=$1', [v['source-id']])).rows[0];
      const binding = (await client.query('select model_key,credential_ref,revision,secret_value from public.platform_model_credential_bindings where model_key=$1', [`cover_models:${v['source-id']}`])).rows[0];
      const pool = (await client.query("select id,snapshot,snapshot_sha256 from public.model_pool_config_releases where is_current=true and status='published'")).rows;
      check(pool.length === 1 && row && row.is_active && !row.is_hidden && row.provider !== 'retired_configuration', 'PUBLISHED_SOURCE_REQUIRED');
      const entry = pool[0].snapshot.models.find(x => x.configuration?.legacyTable === 'cover_models' && x.configuration?.legacyId === row.id);
      check(entry?.catalogState === 'enabled' && entry.credentialRef === binding?.credential_ref, 'PUBLISHED_SOURCE_MAPPING_REQUIRED');
      const key = chooseRamCredential(row, binding);
      if(aliasId && report.phases.some(x=>x.phase==='published'&&x.kind==='model-pool')) {
        const aliasBinding=(await client.query('select model_key,credential_ref,revision,secret_value from public.platform_model_credential_bindings where model_key=$1',[`cover_models:${aliasId}`])).rows[0];
        check(aliasBinding?.model_key===`cover_models:${aliasId}` && aliasBinding.credential_ref===`secret://platform-model/cover_models/${aliasId}` && UUID.test(aliasBinding.revision)
          && aliasBinding.revision!==binding.revision && aliasBinding.secret_value===key,'ALIAS_PHYSICAL_INDEPENDENT_BINDING_REQUIRED');
        const aliasRow=(await client.query('select * from public.cover_models where id=$1',[aliasId])).rows[0];
        check(aliasRow&&canonical(physicalBusiness(row))===canonical(physicalBusiness(aliasRow)),'ALIAS_PHYSICAL_BUSINESS_MISMATCH');
      }
      const { api_key: ignored, updated_at, usage_count, ...business } = row; void ignored; void updated_at; void usage_count;
      const fingerprint = { businessSha: digest(business), bindingRevision: binding.revision, bindingRef: binding.credential_ref, credentialEqual: row.api_key === key };
      if (includeCredential) return { row, entry, credential: key, fingerprint };
      return fingerprint;
    } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
  };
  const poolOverview = () => read('/api/admin/model-pool-releases');
  async function candidateFromResponse(response) {
    // Any missing response/JSON after a write remains unknown and is never retried.
    unknownWrite = true; report.cleanup.recoveryRequired = true; await checkpoint();
    check(response?.status() === 202, 'STAGED_202_REQUIRED'); const body = await response.json();
    const receipt = body?.result?.release;
    check(body.staged === true && body.published === false && UUID.test(String(receipt?.id || '')), 'STRICT_CANDIDATE_RECEIPT_REQUIRED');
    check(/^[a-f0-9]{64}$/u.test(String(receipt.snapshot_sha256||'')), 'CANDIDATE_SNAPSHOT_IDENTITY_REQUIRED');
    unknownWrite = false; report.phases.push({ phase: 'candidate-received', releaseId: receipt.id, snapshotSha256:receipt.snapshot_sha256 }); await checkpoint(); return receipt.id;
  }
  async function publishUI(kind, releaseId, expectedCurrent, operation) {
    check(UUID.test(releaseId) && !unknownWrite && expectedCurrent, 'OWN_CANDIDATE_AND_EXPECTED_CURRENT_REQUIRED');
    const result = await publishCandidateUI({ page, kind, releaseId, expectedCurrent, read,
      checkpoint: async event => { unknownWrite = true; report.phases.push(event); await checkpoint(); },
      inspect: candidate => { if (kind === 'model-pool') {
        const alias = candidate.snapshot.models.find(x => x.configuration?.legacyId === aliasId);
        assertOnlyAliasDelta(expectedCurrent.snapshot, candidate.snapshot, alias?.id, operation);
        if (operation === 'create') assertCloneEntry(sourceEntry, alias);
      } } });
    if (kind === 'model-pool' && operation === 'create') assertCloneEntry(sourceEntry, result.snapshot.models.find(x => x.configuration?.legacyId === aliasId));
    unknownWrite = false; report.phases.push({phase:'published',kind,releaseId}); await checkpoint(); return result;
  }
  const consumers = await resolveWorkspaceCatalogConsumers();
  const releaseIdentity = row => ({id:row?.id,sha256:row?.snapshot_sha256});
  const catalogSnapshot = async () => {
    const before={pool:releaseIdentity((await poolOverview()).current),workspace:releaseIdentity((await read('/api/admin/workspace-model-releases')).current)};
    const result = {}; for (const consumer of consumers) { const body = await read(consumer.path, true); const rows = body.models || body.data?.models; check(Array.isArray(rows), 'ACTUAL_SURFACE_MODEL_ARRAY_REQUIRED'); result[consumer.surface] = rows.filter(x => String(x.id) !== aliasPublicId).map(x => ({ id: x.id, model_name: x.model_name || x.modelName || null })); }
    const after={pool:releaseIdentity((await poolOverview()).current),workspace:releaseIdentity((await read('/api/admin/workspace-model-releases')).current)};
    check(canonical(before)===canonical(after),'CATALOG_RELEASE_DRIFT');
    report.phases.push({phase:'catalog-readback',...after,catalogSha256:digest(result)}); await checkpoint();return result;
  };
  async function assignmentUI(enabled) {
    const before = (await read('/api/admin/workspace-model-releases')).current;
    const currentPool = (await poolOverview()).current;
    await page.goto(ORIGIN + '/admin?tab=workspace-models&project=image', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-workspace-project-button="image"]').click();
    const responsePromise = page.waitForResponse(response => response.url() === ORIGIN + '/api/admin/workspace-models' && response.request().method() === 'POST' && response.request().postDataJSON()?.modelId === aliasId).catch(() => null);
    unknownWrite = true; await checkpoint();
    if (enabled) {
      await page.getByRole('button', { name: /从模型池添加/ }).first().click();
      const picker = page.getByRole('dialog', { name: /从模型池添加到/ });
      await picker.getByPlaceholder('搜索模型、渠道或能力').fill(name);
      await picker.locator('article').filter({ hasText: name }).getByRole('button', { name: '添加', exact: true }).click();
    } else await page.locator(`[data-model-assignment="${aliasId}"]`).click();
    const releaseId = await candidateFromResponse(await responsePromise);
    const staged = await read('/api/admin/workspace-model-releases');
    check(staged.current?.id === before.id, 'CONCURRENT_WORKSPACE_CHANGE');
    assertWorkspaceOnlyAlias(before.snapshot, staged.releases.find(x => x.id === releaseId)?.snapshot, aliasId, enabled, currentPool);
    const close = page.getByRole('button', { name: '关闭模型选择器' }); if (await close.isVisible()) await close.click();
    await publishUI('workspace-models', releaseId, before);
    workspaceAssigned = enabled;
    check(canonical(await catalogSnapshot()) === canonical(baselineCatalogs), 'UNRELATED_SURFACE_MEMBERS_OR_ORDER_CHANGED');
  }
  async function retireUI() {
    await page.goto(ORIGIN + '/admin?tab=models', { waitUntil: 'domcontentloaded' });
    const pool = (await poolOverview()).current;
    await page.getByPlaceholder('搜索模型...').fill(name);
    const card = page.locator('div').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: page.getByRole('button', { name: '删除', exact: true }) }).last();
    const responsePromise = page.waitForResponse(response => response.url().startsWith(ORIGIN + '/api/admin/models?') && response.request().method() === 'DELETE').catch(() => null);
    unknownWrite = true; await checkpoint();
    await card.getByRole('button', { name: '删除', exact: true }).click();
    const releaseId = await candidateFromResponse(await responsePromise); await publishUI('model-pool', releaseId, pool, 'retire');
    check(canonical(await catalogSnapshot()) === canonical(baselineCatalogs), 'FINAL_SURFACE_RESTORE_REQUIRED');
  }
  try {
    // Actual canonical PG identity is established before any application business read.
    const source = await sourceRead(true); sourceFingerprint = source.fingerprint; sourceEntry = source.entry; ramCredential = source.credential;
    const runtime = await fresh('admin'); report.runtime = runtime;
    assertPaidActor(await read('/api/auth/me'), { userId: v['admin-user-id'], actorRole: 'admin' });
    assertPaidActor(await read('/api/auth/me', true), { userId: v['student-user-id'], actorRole: 'student' });
    baselinePool = (await poolOverview()).current; baselineCatalogs = await catalogSnapshot();
    report.source = { id: source.row.id, provider: source.row.provider, businessSha: sourceFingerprint.businessSha, bindingRevisionUnchanged: true };
    // The extra form parser is the actual product parser; no request rewriting.
    const sourceProtocol = protocolForForm(source.row.api_protocol_config);
    const {tsImport}=await import('tsx/esm/api');
    const extraConfiguration=await tsImport('../src/lib/image-model-extra-configuration.ts',import.meta.url);
    check(canonical(extraConfiguration.IMAGE_MODEL_READINESS_KEYS)===canonical(IMAGE_READINESS_FIELDS),'READINESS_KEYS_CONTRACT_DRIFT');
    const sourceExtra=extraConfiguration.parseImageModelExtraConfiguration(JSON.stringify(extraConfiguration.imageModelExtraConfiguration(source.row.api_protocol_config)));
    check(sourceExtra.ok,'SOURCE_EXTRA_CONFIGURATION_INVALID');
    check(Object.keys(sourceEntry.configuration).every(key => ['legacyTable', 'legacyId', 'protocolConfig', 'adminNotes'].includes(key)), 'SOURCE_BUSINESS_FIELDS_NOT_EXPRESSIBLE');
    const formProtocols = { images_generations: 'generations_url_array', images_generations_async: 'generations_url_array', images_edits: 'edits_multipart_array', chat_completions: 'chat_inline_data', google_generate_content: 'chat_inline_data' };
    check(formProtocols[sourceProtocol.protocol] === sourceProtocol.reference_transport && sourceEntry.protocol === sourceProtocol.protocol, 'SOURCE_PROTOCOL_NOT_EXACTLY_EXPRESSIBLE');
    check(source.row.supports_image_input !== false, 'SOURCE_REQUIRES_UNEXPOSED_FORM_CAPABILITY');
    check(source.row.cost_price!==null&&source.row.cost_price!==''&&Number(source.row.cost_price) >= 0 && source.row.selling_price!==null&&source.row.selling_price!==''&&Number(source.row.selling_price) > 0, 'EXPLICIT_SOURCE_PRICES_REQUIRED');
    assertPaidQuote(Number(source.row.selling_price), { maxCharge: options.maximum, remainingBudget: options.remaining });
    const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
    await installPaidAuthCookie(context, ORIGIN, adminToken);
    const adminIdentity = (await read('/api/auth/me')).user;
    await context.addInitScript(({ token, user }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); }, { token: adminToken, user: adminIdentity });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
      if (!['GET', 'HEAD'].includes(request.method())) {
        let body; try { body = request.method() === 'DELETE' ? {} : url.pathname === '/api/admin/cover-models/validation/publish' ? publicationMetadata(request) : request.postDataJSON(); } catch { return route.abort('blockedbyclient'); }
        const releaseEndpoint = ['/api/admin/model-pool-releases', '/api/admin/workspace-model-releases'].includes(url.pathname);
        const allowed = url.pathname === '/api/admin/models' && (request.method() === 'POST' ? body?.name === name && body.model_type === 'drawing' && body.model_name === source.row.model_name && body.api_endpoint === source.row.api_endpoint && body.api_key === ramCredential : request.method() === 'DELETE' && url.searchParams.get('id') === aliasId && url.searchParams.get('model_type') === 'drawing' && [...url.searchParams.keys()].every(key=>['id','model_type'].includes(key)))
          || releaseEndpoint && ['validate', 'publish'].includes(body?.action) && report.phases.some(x => x.phase === 'candidate-received' && x.releaseId === body.releaseId)
          || url.pathname === '/api/admin/workspace-models' && body?.action === 'assign' && body.kind === 'image' && body.surface === 'image-workbench' && body.modelId === aliasId
          || url.pathname === '/api/admin/cover-models/validation/publish' && body?.modelId === aliasId && body.imageRecordId === report.adminReceipt?.recordId && canonical(body.proof) === canonical(report.adminRequest?.proof);
        if (!allowed) return route.abort('blockedbyclient');
        if(url.pathname === '/api/admin/models' && request.method() === 'POST') { try { assertCloneForm(source.row, body); } catch { return route.abort('blockedbyclient'); } }
        const requestId = request.headers()['idempotency-key'] || null;
        if(url.pathname === '/api/admin/models' && request.method()==='POST') { if(!UUID.test(String(requestId || ''))) return route.abort('blockedbyclient'); }
        const event={phase:'mutation-forward',method:request.method(),endpoint:url.pathname,requestId,aliasId:aliasId||null,
          releaseId:body?.releaseId||null,previewSha256:body?.previewSha256||null,
          ...(request.method()==='DELETE'?{targetPath:url.pathname+url.search,idempotentRetrySupported:false}:{}),
          ...(url.pathname === '/api/admin/cover-models/validation/publish'?{imageRecordId:body.imageRecordId,proof:body.proof}:{})};
        unknownWrite = true;
        return journalBeforeForward({journal:report.phases,event,checkpoint,forward:()=>route.continue({headers:{...request.headers(),'x-admin-step-up':stepUp}})});
      }
      if (url.pathname.startsWith('/api/admin/')) return route.continue({ headers: { ...request.headers(), 'x-admin-step-up': stepUp } });
      return route.continue();
    });
    // All generation routes stay blocked except the single armed admin validation.
    let armed = false, adminPostBody, adminGenerationForwarded = false, quotedAdmin;
    const adminCount = { attempts: 0, forwarded: 0 };
    const adminGuard = makePaidPostGuard({ noRetry: true, strictSingleSubmit: true }, adminCount);
    await context.route('**/api/image/generate', async route => {
      try {
        check(armed && !unknownWrite && !budget.stopped, 'GENERATION_NOT_ARMED');
        const body = route.request().postDataJSON();
        check(body.modelId === aliasId && body.resolution === v.resolution && body.aspectRatio === v['aspect-ratio'] && body.adminValidation?.validationKey, 'ADMIN_ALIAS_GENERATION_IDENTITY');
        await fresh('admin'); assertSourceUnchanged(sourceFingerprint, await sourceRead());
        const dto = await read(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(aliasId)}`);
        check(dto.quotedPriceYuan === quotedAdmin && dto.configurationHash === body.adminValidation.configurationHash && dto.validationKey === body.adminValidation.validationKey, 'ADMIN_QUOTE_OR_CONFIGURATION_CHANGED');
        adminPostBody = { clientIdempotencyKey: body.clientIdempotencyKey, clientTraceId: body.clientTraceId };
        report.adminRequest = { ...adminPostBody, aliasId, proof: body.adminValidation, reservationId: 'admin', maximumReserved: options.maximum };
        // Do not persist the confirmation/free-form fields from adminValidation.
        report.adminRequest.proof = Object.fromEntries(['validationKey','configurationHash','epoch','clientIdempotencyKey','clientTraceId'].map(key=>[key,body.adminValidation[key]]));
        await journalBeforeForward({journal:report.phases,event:{phase:'paid-forward',aliasId,reservationId:'admin',...adminPostBody,proof:report.adminRequest.proof},checkpoint,forward:()=>adminGuard(route)}); adminGenerationForwarded = true;
      } catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    page = await context.newPage(); page.setDefaultTimeout(20000); page.on('dialog', dialog => dialog.accept());
    await page.goto(ORIGIN + '/admin?tab=models', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /绘图模型/ }).first().click();
    await page.getByRole('button', { name: /添加绘图模型/ }).click();
    const form = page.getByRole('dialog').filter({ has: page.getByLabel('用户展示名称') });
    await form.getByLabel('用户展示名称').fill(name);
    const selects = form.locator('select'); await selects.nth(0).selectOption(source.row.provider);
    await selects.nth(1).selectOption(source.row.api_protocol_config?.protocol || source.entry.protocol);
    await form.getByLabel('模型 ID', { exact: true }).fill(source.row.model_name);
    await form.getByLabel('接入站点 API 地址', { exact: true }).fill(source.row.api_endpoint);
    await form.getByLabel('成本价', { exact: true }).fill(String(source.row.cost_price));
    await form.getByLabel('售价', { exact: true }).fill(String(source.row.selling_price));
    await form.locator('input[type="number"]').last().fill(String(source.row.sort_order));
    await form.getByText('更多接口参数',{exact:true}).click();
    await form.getByLabel('图片额外接口参数',{exact:true}).fill(JSON.stringify(sourceExtra.value,null,2));
    await form.getByText('管理员备注（仅内部管理员可见）',{exact:true}).click();
    await form.getByPlaceholder('填写供应商、计费单位、分档成本、并发边界与运维注意事项；不要粘贴明文令牌',{exact:true}).fill(source.row.api_protocol_config?.admin_notes || '');
    await form.getByLabel('API 密钥', { exact: true }).fill(ramCredential);
    const createResponse = page.waitForResponse(response => response.url() === ORIGIN + '/api/admin/models' && response.request().method() === 'POST').catch(() => null);
    // Mark before the browser click: timeouts after dispatch are unknown, even if
    // no response event is observed. No retries and no automatic whole-pool rollback.
    unknownWrite = true; cleanupNeeded = true; await checkpoint();
    await form.getByRole('button', { name: '保存为候选', exact: true }).click();
    const createId = await candidateFromResponse(await createResponse); ramCredential = '';
    const createdState = await poolOverview(), created = createdState.releases.find(x => x.id === createId);
    const added = created.snapshot.models.filter(x => !baselinePool.snapshot.models.some(y => y.kind===x.kind&&y.id === x.id));
    check(added.length === 1 && added[0].name === name && added[0].configuration?.legacyTable === 'cover_models', 'EXACT_NEW_ALIAS_REQUIRED');
    aliasId = added[0].configuration.legacyId; report.alias = { id: aliasId, name, releaseId: createId };
    assertStableModelId(aliasId); assertCloneEntry(sourceEntry, added[0]);
    check(aliasId !== source.row.id && added[0].credentialRef === `secret://platform-model/cover_models/${aliasId}`, 'ALIAS_INDEPENDENT_BINDING_REQUIRED');
    await publishUI('model-pool', createId, baselinePool, 'create');
    const aliasDto=await read(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(aliasId)}`);
    check(aliasDto.modelId===aliasId&&/^pm_[A-Za-z0-9_-]+$/u.test(aliasDto.publicModelId),'ALIAS_PUBLIC_ID_MAPPING_REQUIRED');
    aliasPublicId=aliasDto.publicModelId;report.alias.publicId=aliasPublicId;await checkpoint();
    const publicBefore = await read('/api/cover-models?surface=image-workbench', true);
    check(!(publicBefore.models || []).some(x => x.id === aliasPublicId && x.capabilities?.available === true), 'UNVALIDATED_ALIAS_MUST_NOT_BE_USABLE');
    await page.getByPlaceholder('搜索模型...').fill(name);
    const card = page.locator('div').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: page.getByRole('button', { name: '真实生成验证', exact: true }) }).last();
    await card.getByRole('button', { name: '真实生成验证', exact: true }).click();
    const validation = page.getByTestId('admin-image-validation-dialog');
    await validation.getByLabel('清晰度', { exact: true }).selectOption(v.resolution);
    await validation.getByLabel('画面比例', { exact: true }).selectOption(v['aspect-ratio']);
    const dto = await read(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(aliasId)}`);
    check(dto.modelId === aliasId && !dto.requiresReferenceInput && !dto.busy && dto.quotedPriceYuan > 0, 'ADMIN_VALIDATION_QUOTE_REQUIRED');
    quotedAdmin = dto.quotedPriceYuan;
    const adminBefore = await account(false);
    assertPaidQuote(dto.quotedPriceYuan, { maxCharge: options.maximum, remainingBudget: budget.limit }); budget.reserve('admin', options.maximum); await checkpoint();
    await validation.getByRole('checkbox').last().check(); armed = true;
    const generationResponsePromise = page.waitForResponse(response => response.url().split('?')[0] === ORIGIN + '/api/image/generate' && response.request().method() === 'POST').catch(()=>null);
    await validation.getByRole('button', { name: '提交一次真实验证', exact: true }).click();
    const generationResponse = await generationResponsePromise;
    check(generationResponse?.ok(), 'ADMIN_GENERATION_RESPONSE_UNKNOWN');
    const generationBody = await generationResponse.json();
    report.adminReceipt = {recordId:generationBody.recordId||generationBody.images?.[0]?.recordId||null,assetId:generationBody.assetId||generationBody.images?.[0]?.assetId||null,
      billingReferenceId:generationBody.billingReferenceId||null,cashCharged:generationBody.cashCharged??null,deliveryMode:generationBody.deliveryMode||generationBody.images?.[0]?.deliveryMode||null};
    await checkpoint();
    const attempt = validation.getByTestId('image-validation-attempt');
    await attempt.waitFor({ state: 'visible' });
    const deadline = Date.now() + 12 * 60000;
    while (!['completed', 'published'].includes(await attempt.getAttribute('data-status'))) {
      check(Date.now() < deadline && !['unknown', 'rejected', 'not_submitted'].includes(await attempt.getAttribute('data-status')), 'ADMIN_VALIDATION_UNKNOWN_OR_REJECTED');
      await validation.getByRole('button', { name: '检查原任务', exact: true }).click(); await page.waitForTimeout(3000);
    }
    armed = false; check(adminGenerationForwarded && adminCount.forwarded === 1 && adminPostBody, 'ONE_ADMIN_GENERATION_REQUIRED');
    await waitForImageDecoded(validation.locator('img'));
    await capturePaidDownload(page, validation.getByRole('button', { name: '下载验证图片', exact: true }), output, 'image');
    const completedValidation = await read(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(aliasId)}`);
    const recordId = completedValidation.existingAttempt?.imageRecordId;
    check(recordId && (!report.adminReceipt.recordId || report.adminReceipt.recordId === recordId), 'ADMIN_RECORD_RECEIPT_BINDING');
    report.adminReceipt.recordId = recordId; await checkpoint();
    const activation = await activateValidationUI({page,dialog:validation,aliasId,proof:report.adminRequest.proof,recordId,read,
      checkpoint:async event=>{unknownWrite=true;report.phases.push(event);await checkpoint();}});
    unknownWrite=false;
    // Actual wallet readback must confirm the first request before releasing its
    // worst-case reservation. Never infer a free admin call.
    const adminStatus = await read(`/api/image/status?${new URLSearchParams(adminPostBody)}`);
    const adminAfter = await account(false), charged = Math.round((adminBefore.cash - adminAfter.cash) * 1e6) / 1e6;
    const newAdminRows = adminAfter.transactions.filter(x => !adminBefore.transactions.some(y => y.id === x.id));
    check(adminStatus.state === 'completed' && (adminStatus.assetId || activation.existingAttempt?.assetId), 'ADMIN_OWNED_DELIVERY_REQUIRED');
    assertPaidFinalPass({ actor: { role: 'admin' }, expectedRole: 'admin', completed: true, cashDelta: charged, quote: quotedAdmin, newCashRows: newAdminRows.length, generationPosts: adminCount.forwarded });
    const billingReferenceId = report.adminReceipt.billingReferenceId || adminStatus.billingReferenceId;
    check(!adminStatus.billingReferenceId||!report.adminReceipt.billingReferenceId||adminStatus.billingReferenceId===report.adminReceipt.billingReferenceId,'ADMIN_RECEIPT_STATUS_LEDGER_BINDING');
    assertReceiptLedger(newAdminRows,billingReferenceId,charged);
    check((!adminStatus.recordId || adminStatus.recordId === recordId) && (!adminStatus.assetId || adminStatus.assetId === (report.adminReceipt.assetId || completedValidation.existingAttempt.assetId)), 'ADMIN_STATUS_ASSET_RECORD_BINDING');
    report.adminReceipt.billingReferenceId=billingReferenceId;report.adminReceipt.recordId=recordId;await checkpoint();
    budget.settle('admin', charged); report.admin = { assetId: adminStatus.assetId, state: adminStatus.state, charged }; await checkpoint();
    await page.goto(ORIGIN + '/admin?tab=models', { waitUntil: 'domcontentloaded' });
    await assignmentUI(true);
    assertSourceUnchanged(sourceFingerprint, await sourceRead()); await fresh('student');
    const customerRun = `${runId}-student`; budget.reserve('student', options.maximum); await checkpoint();
    // Existing paid UI consumer performs quote refresh, one guarded actual page
    // click, decoded artifact, owned history/download and ledger assertions.
    await imageMain([`--run-id=${customerRun}`, '--execute', `--model-id=${aliasPublicId}`, '--actor-role=student', `--user-id=${v['student-user-id']}`,
      `--prompt=Local alias acceptance ${runId}`, `--resolution=${v.resolution}`, `--aspect-ratio=${v['aspect-ratio']}`, '--image-count=1',
      ...['expected-source-version', 'expected-build-id', 'database-readiness', 'database-readiness-sha256', 'expected-database-target', 'expected-database-identity'].map(key => `--${key}=${v[key]}`), `--max-charge=${options.maximum}`, `--remaining-budget=${options.maximum}`]);
    const customerReportPath = path.resolve('.codex-evidence/image-workbench-live-ui-only', customerRun, 'report.json');
    const customerReport = JSON.parse(await fs.readFile(customerReportPath, 'utf8'));
    check(['passed', 'passed-with-recorded-diagnostics'].includes(customerReport.status) && customerReport.model?.id === aliasPublicId && (customerReport.records?.imageAssetId || customerReport.records?.recordId) && Number.isFinite(customerReport.billing?.cashDelta), 'CUSTOMER_REAL_HARNESS_PROOF_REQUIRED');
    check(customerReport.deliveryReceipt?.deliveryMode !== 'inline_ephemeral', 'DURABLE_DOWNLOAD_PROOF_UNAVAILABLE');
    budget.settle('student', customerReport.billing.cashDelta);
    report.student = { reportPath: customerReportPath, assetId: customerReport.records.imageAssetId || null, recordId: customerReport.records.recordId || null, historyId: customerReport.records.imageWorkbenchHistoryId || null, charged: customerReport.billing.cashDelta };
    const studentBeforeRetire = await account(true);
    const studentOldIds = new Set(customerReport.billing.before.walletTransactions.map(x => x.id));
    const studentNewRows = studentBeforeRetire.transactions.filter(x => !studentOldIds.has(x.id));
    assertPaidFinalPass({ actor: { role: 'student' }, expectedRole: 'student', completed: true, cashDelta: customerReport.billing.cashDelta, quote: customerReport.billing.quotedPrice, newCashRows: studentNewRows.length, generationPosts: customerReport.diagnostics.generationPostsContinued });
    const studentStatus=await read(`/api/image/status?${new URLSearchParams({clientIdempotencyKey:customerReport.request.clientIdempotencyKey,clientTraceId:customerReport.request.clientTraceId})}`,true);
    const studentBillingReference=customerReport.deliveryReceipt?.billingReferenceId||studentStatus.billingReferenceId;
    assertReceiptLedger(studentNewRows,studentBillingReference,customerReport.billing.cashDelta);
    await assignmentUI(false); await retireUI();
    const mediaQuery = new URLSearchParams({ limit: '60', offset: '0', category: 'all', kind: 'image', q: runId, includeTotal: 'true' });
    const history = await read(`/api/media-history?${mediaQuery}`, true);
    const ownedItems = (history.items || []).filter(x => report.student.recordId ? x.id === `image-attempt:${report.student.recordId}` : x.downloadPath?.includes(encodeURIComponent(report.student.assetId)));
    check(ownedItems.length === 1 && ownedItems[0].status === 'completed' && ownedItems[0].downloadPath, 'RETIRED_ALIAS_OWNED_HISTORY_MUST_REMAIN');
    const retiredContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
    try {
      const identity = (await read('/api/auth/me', true)).user;
      assertPaidActor({ user: identity }, { userId: v['student-user-id'], actorRole: 'student' });
      await installPaidAuthCookie(retiredContext, ORIGIN, studentToken);
      await retiredContext.addInitScript(({ token, user }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); }, { token: studentToken, user: identity });
      let forbiddenPosts = 0;
      await retiredContext.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== ORIGIN || !['GET', 'HEAD'].includes(request.method())) { forbiddenPosts++; return route.abort('blockedbyclient'); }
        return route.continue();
      });
      const retiredPage = await retiredContext.newPage();
      await retiredPage.goto(ORIGIN + '/media-history', { waitUntil: 'domcontentloaded' });
      await retiredPage.reload({ waitUntil: 'domcontentloaded' });
      await retiredPage.getByPlaceholder('搜索项目、分镜、来源或模型').fill(runId);
      const historyCard = retiredPage.locator('article').filter({ hasText: ownedItems[0].title });
      await historyCard.first().waitFor({ state: 'visible', timeout: 20000 });
      check(await historyCard.count() === 1, 'EXACT_OWNED_HISTORY_CARD_REQUIRED');
      const downloadButton = historyCard.getByRole('button', { name: '下载到电脑', exact: true });
      report.retiredDownload = await capturePaidDownload(retiredPage, downloadButton, output, 'image');
      check(forbiddenPosts === 0, 'RETIREMENT_READBACK_MUST_NOT_WRITE_OR_GENERATE');
      check(canonical(await account(true)) === canonical(studentBeforeRetire), 'REFRESH_HISTORY_DOWNLOAD_MUST_NOT_CHARGE');
      check(canonical(await catalogSnapshot()) === canonical(baselineCatalogs), 'FINAL_SEVEN_SURFACES_RESTORED');
      assertSourceUnchanged(sourceFingerprint, await sourceRead());
      check(canonical(await fresh('student')) === canonical(runtime), 'FINAL_RUNTIME_IDENTITY_UNCHANGED');
      report.status = 'passed';
    } finally { await retiredContext.close(); }
    cleanupNeeded = false;
  } catch {
    report.status = 'blocked'; report.errorCode = 'ALIAS_ACCEPTANCE_STOPPED_REQUIRES_ROOT_RECONCILIATION';
    for (const [id, entry] of budget.entries) if (entry.state === 'reserved') budget.unknown(id);
  } finally {
    ramCredential = '';
    if (sourceFingerprint) {
      try { assertSourceUnchanged(sourceFingerprint, await sourceRead()); report.originalSourceUnchanged = true; } catch { report.originalSourceUnchanged = false; }
    }
    report.cleanup = { recoveryRequired: cleanupNeeded || unknownWrite || workspaceAssigned || budget.stopped || report.originalSourceUnchanged === false,
      aliasId: aliasId || null, unknownWrite, workspaceAssigned, automaticRollback: false, paidHistoryDeleted: false, bindingsDeleted: false, walletAdjusted: false };
    if (report.cleanup.recoveryRequired) report.status = 'blocked';
    // Unknown operations never trigger automatic cleanup; parent reconciles them.
    await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await checkpoint();
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = parse(args);
  if (options.selfTest) return selfTest();
  if (!options.execute) return plan();
  return execute(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { console.log(JSON.stringify(result)); if (result.status && result.status !== 'passed') process.exitCode = 1; })
    .catch(() => { console.error(JSON.stringify({ success: false, errorCode: 'IMAGE_ALIAS_HARNESS_FAILED_CLOSED', automaticRetries: 0 })); process.exitCode = 1; });
}
