import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
if (!['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin)) throw new Error('LOCAL_PREVIEW_REQUIRED');
const marker = `local-video-crud-${randomUUID()}`;
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ ready: true, origin, ownFixtureOnly: true, requiresNormalToken: true, fixtureEndpoint: 'example.invalid', operations: ['POST pending model', 'PUT zero price', 'PUT endpoint', 'reject PUT activate', 'reject legacy activate', 'DELETE own model'], generates: false }));
  process.exit(0);
}
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
assert.ok(runtime.localOnly && runtime.ownerConnection.host === '127.0.0.1' && runtime.ownerConnection.port === 54322 && runtime.ownerConnection.database === 'zimeiti_local', 'LOCAL_DATABASE_REQUIRED');
const directory = `.codex-evidence/admin-video-model-crud-20260903/${marker}`;
await mkdir(directory, { recursive: true });
const db = new pg.Client(runtime.ownerConnection);
await db.connect();
await db.query('set default_transaction_read_only = on');
const events = [], checks = [];
let before = null, cleanupVerified = false, stage = 'preflight', error = null, fixtureIdWasAbsent = false, creationAttempted = false, normalAdmin = false;
const apiPath = '/api/admin/models';
const gateKey = '__model_activation_gate';
const priceFields = ['cost_per_use', 'cost_price', 'billing_mode', 'token_billing_enabled', 'input_cost_per_million', 'output_cost_per_million', 'cached_cost_per_million', 'profit_margin', 'token_rounding_unit'];
const configFields = ['name', 'model_name', 'provider', 'protocol_type', 'admin_notes', 'duration_seconds', 'max_duration', 'supports_image_input', 'requires_image', 'sort_order', ...priceFields];
const protocolFields = ['workflow_id', 'workflow_input_mode', 'duration_field', 'supports_duration', 'min_duration', 'max_duration', 'duration_options', 'duration_step', 'exact_duration_only', 'billing_unit', 'supports_prompt', 'required_reference_images', 'required_reference_audios', 'max_reference_images', 'max_reference_audios', 'resolution_options', 'aspect_ratios'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeEndpoint = value => { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return ''; } };
function snapshot(models) {
  return models.filter(model => model.id !== marker).map(model => {
    const config = Object.fromEntries(configFields.map(key => [key, model[key] ?? null]));
    config.endpoint = safeEndpoint(model.api_endpoint);
    config.protocol = Object.fromEntries(protocolFields.map(key => [key, model.api_protocol_config?.[key] ?? null]));
    config.activationState = model.api_protocol_config?.[gateKey]?.state ?? null;
    return { id: String(model.id), type: String(model.model_type), active: model.is_active === true, hidden: model.is_hidden === true, nonSecretConfigurationSha256: hash(config) };
  }).sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}
async function api(path, method = 'GET', body) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, 'EXTERNAL_REQUEST_FORBIDDEN');
  assert.ok(['/api/auth/me', '/api/admin/models', '/api/admin/models/activate', '/api/video/models'].includes(url.pathname), 'REQUEST_PATH_FORBIDDEN');
  if (method !== 'GET') {
    if (method === 'DELETE') assert.equal(url.searchParams.get('id'), marker, 'FOREIGN_MODEL_MUTATION_FORBIDDEN');
    else assert.equal(body?.id, marker, 'FOREIGN_MODEL_MUTATION_FORBIDDEN');
  }
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  events.push({ path: url.pathname, method, status: response.status, code: typeof data.code === 'string' && /^[A-Z0-9_]+$/u.test(data.code) ? data.code : null, ...(typeof data.error === 'string' && /updated_at/u.test(data.error) ? { updatedAtColumnError: true } : {}) });
  return { status: response.status, ok: response.ok, data };
}
async function inventory() {
  const response = await api(apiPath);
  assert.equal(response.ok, true, 'ADMIN_INVENTORY_UNAVAILABLE'); assert.ok(Array.isArray(response.data.models), 'ADMIN_INVENTORY_INVALID');
  return response.data.models;
}
async function ownRow() {
  return (await db.query('select id,is_active,is_hidden,price_per_use,cost_price,api_endpoint,api_protocol_config-> $2 ->> \'state\' as activation_state from public.video_models where id=$1', [marker, gateKey])).rows[0] || null;
}
async function verifyPending(label, expectedPrice, expectedEndpoint) {
  const row = await ownRow(); assert.ok(row, 'OWN_FIXTURE_NOT_IN_LOCAL_DATABASE');
  assert.equal(row.is_active, false, 'PENDING_FIXTURE_BECAME_ACTIVE'); assert.equal(row.is_hidden, true, 'PENDING_FIXTURE_BECAME_VISIBLE');
  assert.equal(row.activation_state, 'pending', 'PENDING_GATE_MISSING');
  if (expectedPrice !== undefined) assert.equal(Number(row.price_per_use), expectedPrice, 'PRICE_MISMATCH');
  if (expectedEndpoint) assert.equal(row.api_endpoint, expectedEndpoint, 'ENDPOINT_UPDATE_MISMATCH');
  const publicModels = await api('/api/video/models'); assert.equal(publicModels.ok, true, 'PUBLIC_CATALOG_UNAVAILABLE');
  const visible = publicModels.data.models ?? publicModels.data.data ?? [];
  assert.ok(Array.isArray(visible), 'PUBLIC_CATALOG_INVALID');
  assert.equal(visible.some(model => [model.id, model.name, model.displayName].includes(marker)), false, 'PENDING_FIXTURE_PUBLIC');
  checks.push({ check: label, id: marker, status: 'passed', active: false, hidden: true, pending: true, publicAbsent: true, ...(expectedPrice !== undefined ? { zeroPricePreserved: expectedPrice === 0 } : {}) });
  await writeFile(`${directory}/progress.json`, JSON.stringify({ marker, stage, checks, events }, null, 2));
}
try {
  const me = await api('/api/auth/me'); assert.equal(me.ok, true, 'NORMAL_LOGIN_REQUIRED'); assert.equal(me.data.user?.role, 'admin', 'ADMIN_REQUIRED');
  const actor = (await db.query('select role from public.users where id=$1', [me.data.user.id])).rows[0]; assert.equal(actor?.role, 'admin', 'LOCAL_ADMIN_IDENTITY_REQUIRED');
  normalAdmin = true;
  const columns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='video_models'")).rows.map(row => row.column_name);
  checks.push({ check: 'video-schema', status: 'passed', updatedAtColumnPresent: columns.includes('updated_at') });
  before = snapshot(await inventory()); await writeFile(`${directory}/before.json`, JSON.stringify(before, null, 2));
  assert.equal(await ownRow(), null, 'FIXTURE_ID_ALREADY_EXISTS');
  fixtureIdWasAbsent = true;
  const endpoint = 'https://example.invalid/local-video-crud/v1';
  stage = 'create';
  await writeFile(`${directory}/intent.json`, JSON.stringify({ marker, origin, expectedActive: false, expectedHidden: true, upstreamAllowed: false, mutationScope: 'new fixture only' }, null, 2));
  creationAttempted = true;
  const created = await api(apiPath, 'POST', { id: marker, model_type: 'video', name: marker, model_name: marker, api_endpoint: endpoint, api_key: 'fixture-key-not-a-real-provider-credential', protocol_type: 'openai_compatible', cost_per_use: 0.01, cost_price: 0, duration_seconds: 5, max_duration: 5, supports_image_input: false, requires_image: false, api_protocol_config: { workflow_input_mode: 'text', supports_prompt: true, billing_unit: 'per_use' }, is_active: true, is_hidden: false });
  assert.equal(created.ok, true, 'CREATE_FAILED'); assert.equal(created.data.model?.id, marker, 'CREATE_RETURNED_FOREIGN_ID'); assert.equal(created.data.activation_required, true, 'ACTIVATION_REQUIREMENT_MISSING');
  await verifyPending('new-model-forced-pending', 0.01, endpoint);
  stage = 'zero-price'; const zero = await api(apiPath, 'PUT', { model_type: 'video', id: marker, cost_per_use: 0, cost_price: 0 }); assert.equal(zero.ok, true, 'ZERO_PRICE_UPDATE_FAILED'); await verifyPending('zero-price-keeps-pending', 0, endpoint);
  stage = 'endpoint-update'; const editedEndpoint = 'https://example.invalid/local-video-crud/v2'; const changed = await api(apiPath, 'PUT', { model_type: 'video', id: marker, api_endpoint: editedEndpoint }); assert.equal(changed.ok, true, 'ENDPOINT_UPDATE_FAILED'); await verifyPending('endpoint-edit-keeps-pending', 0, editedEndpoint);
  stage = 'reject-ordinary-activation'; const ordinary = await api(apiPath, 'PUT', { model_type: 'video', id: marker, is_active: true, is_hidden: false }); assert.equal(ordinary.status, 409, 'ORDINARY_ACTIVATION_NOT_REJECTED'); assert.equal(ordinary.data.code, 'MODEL_ACTIVATION_CHANNEL_REQUIRED'); await verifyPending('ordinary-activation-rejected', 0, editedEndpoint);
  stage = 'reject-legacy-activation'; const legacy = await api('/api/admin/models/activate', 'POST', { model_type: 'video', id: marker }); assert.equal(legacy.status, 409, 'LEGACY_ACTIVATION_NOT_REJECTED'); assert.equal(legacy.data.code, 'MODEL_ACCEPTANCE_EVIDENCE_INCOMPLETE'); await verifyPending('legacy-activation-without-evidence-rejected', 0, editedEndpoint);
} catch (cause) {
  error = { stage, type: cause.name, code: /^[A-Z0-9_]+$/u.test(String(cause.message)) ? cause.message : 'CRUD_ASSERTION_FAILED' };
} finally {
  try {
    const row = await ownRow();
    if (row) {
      assert.ok(fixtureIdWasAbsent && creationAttempted, 'PREEXISTING_MODEL_DELETE_FORBIDDEN');
      assert.equal(row.id, marker); assert.ok(['https://example.invalid/local-video-crud/v1', 'https://example.invalid/local-video-crud/v2'].includes(row.api_endpoint), 'FOREIGN_ENDPOINT_DELETE_FORBIDDEN');
      const deleted = await api(`${apiPath}?model_type=video&id=${encodeURIComponent(marker)}`, 'DELETE'); assert.equal(deleted.ok, true, 'OWN_FIXTURE_DELETE_FAILED');
    }
    assert.equal(await ownRow(), null, 'OWN_FIXTURE_STILL_EXISTS'); cleanupVerified = true;
    if (before) { const after = snapshot(await inventory()); await writeFile(`${directory}/after.json`, JSON.stringify(after, null, 2)); assert.deepEqual(after, before, 'OTHER_MODEL_SNAPSHOT_CHANGED'); checks.push({ check: 'other-models-unchanged', status: 'passed', count: after.length }); }
  } catch (cause) { error ||= { stage: 'cleanup', type: cause.name, code: /^[A-Z0-9_]+$/u.test(String(cause.message)) ? cause.message : 'CLEANUP_OR_SNAPSHOT_FAILED' }; }
  await db.end();
  const report = { passed: !error, marker, origin, normalAdmin, checks, events, cleanupVerified, error, generationRequests: 0, supplierRequests: 0, fixtureOnly: true };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (error) process.exitCode = 1;
}
