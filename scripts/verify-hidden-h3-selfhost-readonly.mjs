import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readLocalPreviewLaunchPlan, LOCAL_PREVIEW_RUNTIME_FILE } from './start-local-data-preview.mjs';

if (!process.argv.includes('--execute-readonly')) { console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, generationRequests: 0, powerActions: 0 })); process.exit(0); }
const launch = await readLocalPreviewLaunchPlan(5002); // Pure environment construction, never startLocalPreviewProcess.
const runtime = JSON.parse((await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(new URL(runtime.supabaseUrl).toString(), 'http://127.0.0.1:54321/');
const url = new URL('/rest/v1/video_models', runtime.supabaseUrl);
url.searchParams.set('select', 'id,provider,protocol_type,api_endpoint,api_key,model_name,is_active,is_hidden,api_protocol_config');
url.searchParams.set('id', 'eq.minimax-h3-turbo-selfhost-pro6000'); url.searchParams.set('limit', '1');
const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` }, signal: AbortSignal.timeout(15000) });
assert.ok(response.ok); const [row] = await response.json(); assert.ok(row);
assert.equal(row.api_endpoint, 'http://127.0.0.1:16011/v1/video/generations');
const config = row.api_protocol_config || {};
const report = { at: new Date().toISOString(), modelId: row.id, protocol: row.protocol_type, modelName: row.model_name, localGateway: '127.0.0.1:16011',
  active: row.is_active, hidden: row.is_hidden, readonlyDatabase: true, databaseWrites: 0, generationRequests: 0, powerActions: 0,
  launchEnvironment: { lifecycleEnabled: launch.env.AUTODL_H3_LIFECYCLE_ENABLED === 'true', instanceUuidConfigured: Boolean(launch.env.AUTODL_H3_INSTANCE_UUID?.trim()),
    developerTokenFileExplicitlyConfigured: Boolean(launch.env.AUTODL_DEVELOPER_TOKEN_FILE?.trim()), gatewaySecretReferenceConfigured: row.api_key === 'secret://autodl-h3-selfhost', observedFrom: 'validated local launch plan; not remote process memory' },
  modelConfigurationHasInstanceBinding: Boolean(config.instance_uuid || config.instance_id || config.instanceUuid), currentGpuHardwareVerified: false, probes: [] };
for (const pathname of ['/health/live', '/health/ready']) {
  try {
    const result = await fetch(`http://127.0.0.1:16011${pathname}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    report.probes.push({ path: pathname, http: result.status, responded: true }); await result.body?.cancel();
  } catch (error) { report.probes.push({ path: pathname, responded: false, transportCode: /^[A-Z_]+$/u.test(error.cause?.code || '') ? error.cause.code : 'TRANSPORT_UNAVAILABLE' }); }
}
report.blockers = [];
if (!report.launchEnvironment.instanceUuidConfigured && !report.modelConfigurationHasInstanceBinding) report.blockers.push('No current instance UUID is bound in the local preview/model configuration; the old model name cannot identify current GPU hardware.');
if (report.probes.every(probe => !probe.responded)) report.blockers.push('The configured local gateway has no reachable health endpoint; no existing tunnel or readiness is demonstrated.');
if (!report.launchEnvironment.lifecycleEnabled) report.blockers.push('Local preview explicitly disables automatic instance lifecycle; this check preserves that setting.');
await fs.writeFile('.codex-evidence/hidden-video-inventory-20260902/selfhost-readonly.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
