import fs from 'node:fs/promises';
import { Client } from 'pg';
import { readLocalPreviewLaunchPlan, LOCAL_PREVIEW_DATA_ROOT } from './start-local-data-preview.mjs';
const plan = await readLocalPreviewLaunchPlan(5000);
Object.assign(process.env, plan.env, { NODE_ENV: 'production', LOCAL_ACCEPTANCE_PREVIEW: 'true', LOCAL_VALIDATION_DIST_DIR: '.next-local-acceptance' });
const cfg = JSON.parse(await fs.readFile(LOCAL_PREVIEW_DATA_ROOT + '/config/runtime.json', 'utf8'));
if (!cfg.localOnly || cfg.ownerConnection.host !== '127.0.0.1' || Number(cfg.ownerConnection.port) !== 54322) throw Error('LOCAL_DATABASE_REQUIRED');
const db = new Client(cfg.ownerConnection); await db.connect();
try {
  const task = (await db.query('select t.id,t.task_id_external,t.provider_result_url,m.api_endpoint,m.api_key from video_tasks t join video_models m on m.id=t.model_id where t.id=$1', ['vt_77ae5f0b32d3311f55ba211df00bd9cdfcdbdc59'])).rows[0];
  const { resolveProviderSecret } = await import('../src/lib/provider-secret.ts');
  const { safeMediaFetch } = await import('../src/lib/safe-media-fetch.ts');
  const base = task.api_endpoint.replace(/\/v1\/?$/,'');
  const targets = [{ kind:'provider-result', url: task.provider_result_url }, { kind:'provider-content', url: base + '/v1/videos/' + encodeURIComponent(task.task_id_external) + '/content' }];
  const outcomes=[];
  for(const target of targets) {
    try {
      const {response,finalUrl} = await safeMediaFetch(target.url, { headers:{ Range:'bytes=0-1023' }, authorization:{origin:new URL(base).origin,value:'Bearer '+resolveProviderSecret(task.api_key)}, timeoutMs:20000 });
      outcomes.push({kind:target.kind,http:response.status,host:new URL(finalUrl).host,contentType:response.headers.get('content-type'),length:response.headers.get('content-length')}); await response.body?.cancel();
    } catch(error) {outcomes.push({kind:target.kind,code:error.code||error.name,message:String(error.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,200)});}
  }
  const report={at:new Date().toISOString(),taskId:task.id,newGenerationRequests:0,outcomes};
  await fs.writeFile('.codex-evidence/ordinary-video-billing-20260903/result-network-readonly.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally { await db.end(); }
