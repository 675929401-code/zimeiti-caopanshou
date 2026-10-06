#!/usr/bin/env node
// Read-only comparison. Never transfers member data, credentials, or success flags.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const localFile = option('source-config');
const confirmedTarget = option('confirm-target-host');
const output = option('output');
assert.ok(localFile && output && confirmedTarget, 'Required: --source-config --confirm-target-host --output');
const local = JSON.parse(await fs.readFile(localFile, 'utf8'));
assert.equal(local.localOnly, true);
assert.equal(local.supabaseUrl, 'http://127.0.0.1:54321');
const targetUrl = new URL(process.env.COZE_SUPABASE_URL || '');
assert.equal(targetUrl.protocol, 'https:');
assert.equal(targetUrl.hostname, confirmedTarget);
assert.ok(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY);
const source = { url:local.supabaseUrl, key:local.serviceRoleKey };
const target = { url:targetUrl.origin, key:process.env.COZE_SUPABASE_SERVICE_ROLE_KEY };
async function query(db, table, params) {
  const res = await fetch(`${db.url}/rest/v1/${table}?${new URLSearchParams(params)}`, {
    headers:{apikey:db.key,Authorization:`Bearer ${db.key}`},signal:AbortSignal.timeout(30000),redirect:'error',
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
  return res.json();
}
const [sourceModels,targetModels,sourceHealth,targetHealth] = await Promise.all([
  query(source,'video_models',{select:'*',order:'id'}),query(target,'video_models',{select:'*',order:'id'}),
  query(source,'video_channel_health',{select:'channel_id,is_healthy,last_success_at,health_protocol_version,verification_state,verified_at,verification_evidence'}),
  query(target,'video_channel_health',{select:'channel_id,is_healthy,last_success_at,health_protocol_version,verification_state,verified_at,verification_evidence'}),
]);
const healthVerified = h => h?.is_healthy === true && h.health_protocol_version === 'video-channel-health.v2'
  && h.verification_state === 'verified' && typeof h.last_success_at === 'string' && Number.isFinite(Date.parse(h.last_success_at))
  && typeof h.verified_at === 'string' && Date.parse(h.verified_at) >= Date.parse(h.last_success_at)
  && String(h.verification_evidence?.task_id || '').length >= 8 && String(h.verification_evidence?.evidence_id || '').length >= 8;
const operational = new Set(['created_at','updated_at','total_requests','success_count','fail_count','last_success_at']);
const config = row => Object.fromEntries(Object.entries(row).filter(([key])=>!operational.has(key)));
const rows = [];
for (const row of sourceModels) {
  const old = targetModels.find(item=>item.id === row.id);
  const localHealth = sourceHealth.find(item=>item.channel_id === row.id);
  const remoteHealth = targetHealth.find(item=>item.channel_id === row.id);
  const a = config(row), b = old ? config(old) : {};
  const fields = [...new Set([...Object.keys(a),...Object.keys(b)])].filter(key=>hash(a[key] ?? null)!==hash(b[key] ?? null)).sort();
  const publication = row.api_protocol_config?.__model_activation_gate?.publication;
  rows.push({id:row.id,name:row.name,action:!old?'insert-isolated':fields.length?'review-update':'unchanged',changedFields:fields,
    sourceHash:hash(row),targetHash:old?hash(old):null,sourceActive:row.is_active === true,sourceHidden:row.is_hidden === true,
    targetActive:old?.is_active === true,targetHidden:old?.is_hidden === true,sourceReleaseVerified:healthVerified(localHealth),
    targetReleaseVerified:healthVerified(remoteHealth),hasSourcePublication:!!publication,
    // A historical local success does not certify production configuration or production billing.
    requiresProductionValidation:fields.length>0 || !healthVerified(remoteHealth),
  });
}
const targetOnly = targetModels.filter(row=>!sourceModels.some(item=>item.id===row.id)).map(row=>row.id);
const report = {schema:'production-video-config-sync-plan.v1',observedAt:new Date().toISOString(),mode:'read-only',
  databaseWrites:0,upstreamRequests:0,sourceHost:new URL(source.url).host,targetHost:confirmedTarget,
  sourceCount:sourceModels.length,targetCount:targetModels.length,insertCount:rows.filter(r=>r.action==='insert-isolated').length,
  updateCount:rows.filter(r=>r.action==='review-update').length,unchangedCount:rows.filter(r=>r.action==='unchanged').length,
  sourceReleaseVerifiedCount:rows.filter(r=>r.sourceReleaseVerified).length,targetReleaseVerifiedCount:rows.filter(r=>r.targetReleaseVerified).length,
  preservesTargetOnlyModels:true,targetOnly,rows,
  boundaries:['No member, balance, transaction, or user history transfer','New models remain isolated until current production validation succeeds','Never backfill verified flags from historical success booleans','Credentials transferred separately through protected storage, never in this plan'],
};
await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({mode:report.mode,databaseWrites:0,upstreamRequests:0,sourceCount:report.sourceCount,targetCount:report.targetCount,
  insertCount:report.insertCount,updateCount:report.updateCount,unchangedCount:report.unchangedCount,
  sourceReleaseVerifiedCount:report.sourceReleaseVerifiedCount,targetReleaseVerifiedCount:report.targetReleaseVerifiedCount,output}));
