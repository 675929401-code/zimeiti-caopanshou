import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeVideoChannelError } from '../src/lib/video-channel-health-circuit.ts';

if (!process.argv.includes('--execute-readonly')) { console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, databaseWrites: 0, generationRequests: 0 })); process.exit(0); }
const runtime = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const evidence = '.codex-evidence/hidden-video-inventory-20260902';
const previousRoot = '.codex-evidence/video-all-models-real-e2e-20260902';
const cfg = JSON.parse((await fs.readFile(runtime, 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).origin, 'http://127.0.0.1:54321');
const headers = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
async function get(route, query = {}) {
  const url = new URL(route, cfg.supabaseUrl); for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `Local metadata GET failed: ${response.status}`); return response.json();
}
const schema = await get('/rest/v1/');
const properties = schema.definitions?.video_models?.properties;
assert.ok(properties, 'Local schema does not expose video_models metadata');
const requested = ['id', 'name', 'display_name', 'description', 'admin_notes', 'provider', 'model_name', 'api_endpoint', 'api_key', 'protocol_type', 'api_protocol_config', 'is_active', 'is_hidden', 'supports_image_input', 'requires_image', 'duration_seconds', 'max_duration', 'default_resolution', 'resolution', 'created_at', 'updated_at'];
const columns = requested.filter(key => Object.hasOwn(properties, key));
const [models, health, proven] = await Promise.all([
  get('/rest/v1/video_models', { select: columns.join(','), order: 'id' }),
  get('/rest/v1/video_channel_health', { select: 'channel_id,total_requests,success_count,fail_count,consecutive_failures,is_healthy,last_success_at,last_fail_at,last_error,updated_at', order: 'channel_id' }),
  fs.readFile(`${previousRoot}/owned-results/summary.json`, 'utf8').then(JSON.parse),
]);
assert.ok(Array.isArray(models) && Array.isArray(health) && Array.isArray(proven));
const currentSecrets = models.map(row => String(row.api_key || '').trim()).filter(value => value.length > 5);
function clean(value, max = 1000) {
  let text = String(value ?? '');
  for (const secret of currentSecrets) text = text.split(secret).join('[configured-secret]');
  return text.replace(/https?:\/\/\S+/gu, '[url]').replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/gu, '[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, max);
}
function protocolHints(config, prefix = '', level = 0) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || level > 4) return {};
  const output = {};
  for (const [key, value] of Object.entries(config)) {
    if (/key|secret|token|authorization|credential|password/iu.test(key)) continue;
    const location = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(output, protocolHints(value, location, level + 1));
    else if (/workflow|resolution|duration|application|model|mode|frame|image|audio|dimension|instance|gateway|status|reason|note|disable|hidden|deprecat/iu.test(key)) {
      output[location] = Array.isArray(value) ? value.slice(0, 12).map(item => typeof item === 'string' ? clean(item, 180) : typeof item === 'number' || typeof item === 'boolean' ? item : '[object]') : typeof value === 'string' ? clean(value) : value;
    }
  }
  return output;
}
const hashes = new Map();
function binding(row) {
  const secret = String(row.api_key || '').trim();
  const credentialHash = sha(secret);
  if (!hashes.has(credentialHash)) hashes.set(credentialHash, `credential-binding-${hashes.size + 1}`);
  const family = { protocol: row.protocol_type || '', upstreamModel: row.model_name || '', workflowId: row.api_protocol_config?.workflow_id || null, endpoint: String(row.api_endpoint || '').replace(/\/+$/u, ''), credentialHash };
  const execution = { ...family, config: row.api_protocol_config || {}, supportsImageInput: row.supports_image_input, requiresImage: row.requires_image, durationSeconds: row.duration_seconds, maxDuration: row.max_duration, defaultResolution: row.default_resolution ?? row.resolution ?? null };
  const service = { ...family, credentialHash: undefined };
  const workflow = family.workflowId ? { workflowId: family.workflowId, endpoint: family.endpoint, credentialHash } : null;
  return { providerBindingSha256: sha(JSON.stringify(canonical(family))), executionConfigurationSha256: sha(JSON.stringify(canonical(execution))), serviceWithoutCredentialSha256: sha(JSON.stringify(canonical(service))), workflowBindingSha256: workflow ? sha(JSON.stringify(canonical(workflow))) : null, credentialBindingGroup: hashes.get(credentialHash), credentialMode: secret.startsWith('secret://') || secret.startsWith('env://') ? 'server-reference' : secret ? 'configured-value' : 'empty', family, execution };
}
const runtimeBindings = new Map(models.map(row => [row.id, binding(row)]));
const successfulModels = new Map();
for (const proof of proven.filter(item => item.passed === true)) {
  const row = models.find(item => item.id === proof.model); if (!row) continue;
  let previous;
  try { previous = JSON.parse(await fs.readFile(`${previousRoot}/all13-real-canary-20260902/${row.id.replace(/[^a-zA-Z0-9_-]/gu, '_')}/result.json`, 'utf8')); } catch { continue; }
  const originalConfigHash = sha(JSON.stringify(canonical({ id: row.id, model: row.model_name, protocol: row.protocol_type, endpoint: row.api_endpoint, config: row.api_protocol_config })));
  const currentConfigurationMatches = originalConfigHash === previous.selectedModel?.configurationSha256;
  successfulModels.set(row.id, { modelId: row.id, taskId: proof.taskId, readOnlyDeliveryPassed: true, originalRoutingVerified: previous.routingVerified === true, currentConfigurationMatches, acceptedDuration: previous.business?.duration ?? null, acceptedResolution: previous.business?.resolution ?? null, output: proof.playback, evidence: `${previousRoot}/owned-results/summary.json` });
}
const publicOutput = models.map(row => {
  const info = runtimeBindings.get(row.id); const channel = health.find(item => item.channel_id === row.id); const config = row.api_protocol_config || {};
  let endpointHost = null; let endpointPath = null; try { const url = new URL(row.api_endpoint); endpointHost = url.host; endpointPath = clean(url.pathname, 180); } catch {}
  const exactMatches = [...successfulModels.values()].filter(proof => proof.currentConfigurationMatches && proof.originalRoutingVerified && runtimeBindings.get(proof.modelId).executionConfigurationSha256 === info.executionConfigurationSha256);
  const bindingMatches = [...successfulModels.values()].filter(proof => proof.currentConfigurationMatches && proof.originalRoutingVerified && runtimeBindings.get(proof.modelId).providerBindingSha256 === info.providerBindingSha256);
  const differentCredentialMatches = [...successfulModels.values()].filter(proof => proof.currentConfigurationMatches && runtimeBindings.get(proof.modelId).serviceWithoutCredentialSha256 === info.serviceWithoutCredentialSha256 && runtimeBindings.get(proof.modelId).providerBindingSha256 !== info.providerBindingSha256);
  const workflowMatches = info.workflowBindingSha256 ? [...successfulModels.values()].filter(proof => proof.currentConfigurationMatches && runtimeBindings.get(proof.modelId).workflowBindingSha256 === info.workflowBindingSha256) : [];
  const gate = config.__model_activation_gate;
  return { id: row.id, name: clean(row.name, 180), description: clean(row.description), adminNotes: clean(row.admin_notes, 3000), provider: clean(row.provider, 100), upstreamModel: clean(row.model_name, 200), protocol: row.protocol_type,
    endpointHost, endpointPath, active: row.is_active === true, hidden: row.is_hidden === true, inHiddenOrInactiveScope: row.is_active !== true || row.is_hidden === true,
    credentialMode: info.credentialMode, credentialBindingGroup: info.credentialBindingGroup, providerBindingSha256: info.providerBindingSha256, executionConfigurationSha256: info.executionConfigurationSha256,
    supportsImageInput: row.supports_image_input === true, requiresImage: row.requires_image === true, durationSeconds: row.duration_seconds, maxDuration: row.max_duration, defaultResolution: row.default_resolution ?? row.resolution ?? null,
    protocolHints: protocolHints(config), configKeys: Object.keys(config).filter(key => !/key|secret|token|auth|credential|password/iu.test(key)).sort(),
    exactExecutionMatchesToProvenModels: exactMatches.map(proof => proof.modelId), providerBindingMatchesToProvenModels: bindingMatches.map(proof => proof.modelId),
    sameServiceWithDifferentCredentialMatches: differentCredentialMatches.map(proof => proof.modelId), sameWorkflowBindingMatches: workflowMatches.map(proof => proof.modelId),
    activationGate: gate ? { schema: clean(gate.schema, 100), status: clean(gate.status, 100), hasEvidence: !!gate.evidence, checks: Object.fromEntries(Object.entries(gate.evidence?.checks || {}).map(([key, value]) => [key, clean(value?.status, 40)])) } : null,
    health: channel ? { totalRequests: channel.total_requests, successCount: channel.success_count, failCount: channel.fail_count, consecutiveFailures: channel.consecutive_failures, healthy: channel.is_healthy, lastSuccessAt: channel.last_success_at, lastFailAt: channel.last_fail_at, updatedAt: channel.updated_at, error: sanitizeVideoChannelError(channel.last_error) } : null,
    createdAt: row.created_at || null, updatedAt: row.updated_at || null };
});
const scope = publicOutput.filter(row => row.inHiddenOrInactiveScope);
function groups(field) { return [...new Set(scope.map(row => row[field]))].map(hash => ({ hash, modelIds: scope.filter(row => row[field] === hash).map(row => row.id), activePeers: publicOutput.filter(row => !row.inHiddenOrInactiveScope && row[field] === hash).map(row => row.id) })); }
const report = { at: new Date().toISOString(), localDatabaseOnly: true, databaseWrites: 0, generationRequests: 0, credentialValuesOrStandaloneHashesPersisted: false,
  credentialComparison: 'Configured cells compared only through in-memory hashes. Group labels and combined binding hashes exclude plaintext keys; server references were not decrypted. Current binding equality does not prove the credential value used by an old canary.',
  totalModels: models.length, hiddenOrInactiveModels: scope.length, activeVisibleModels: models.length - scope.length,
  columnsRead: columns.filter(column => column !== 'api_key'), credentialColumnReadInMemoryOnly: true,
  provenModels: [...successfulModels.values()], providerBindingGroups: groups('providerBindingSha256'), executionConfigurationGroups: groups('executionConfigurationSha256'), models: publicOutput };
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(evidence, 'inventory.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ totalModels: report.totalModels, hiddenOrInactiveModels: report.hiddenOrInactiveModels, activeVisibleModels: report.activeVisibleModels, provenModels: report.provenModels.map(proof => ({ id: proof.modelId, sameConfig: proof.currentConfigurationMatches, routing: proof.originalRoutingVerified })), providerBindingGroups: report.providerBindingGroups.length, executionConfigurationGroups: report.executionConfigurationGroups.length, hiddenModels: scope.map(row => ({ id: row.id, protocol: row.protocol, upstreamModel: row.upstreamModel, host: row.endpointHost, exactMatches: row.exactExecutionMatchesToProvenModels, bindingMatches: row.providerBindingMatchesToProvenModels })), evidence: path.join(evidence, 'inventory.json') }));
