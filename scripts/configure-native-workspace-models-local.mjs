import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';

// Configure only the two new local scenes through the real versioned admin API.
// No model, credential, price, provider call or production environment is changed.
export async function main(){
 const root=path.resolve('.');assert.equal(root.replaceAll('\\','/').toLowerCase(),'f:/总项目文件/skill存储系统/01_网页开发项目/自媒体操盘手/当前版本');
 const origin=process.env.LOCAL_NAV_ORIGIN;assert.equal(origin,'http://127.0.0.1:5000');assert.ok(process.argv.includes('--execute-local'));
 const token=process.env.LOCAL_NAV_ADMIN_TOKEN,step=process.env.LOCAL_ADMIN_STEP_UP_TOKEN;assert.ok(token&&step,'REAL_PASSWORD_STEP_UP_REQUIRED');
 const headers={Authorization:`Bearer ${token}`,'x-admin-step-up':step};
 const runtime=JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json','utf8')).replace(/^\uFEFF/,''));assert.equal(runtime.localOnly,true);assert.equal(runtime.ownerConnection.host,'127.0.0.1');assert.equal(Number(runtime.ownerConnection.port),54322);assert.equal(runtime.ownerConnection.database,'zimeiti_local');
 const db=new pg.Client({...runtime.ownerConnection,application_name:'native-model-scene-local-admin-audit'});await db.connect();
 const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
 const sha=value=>createHash('sha256').update(canonical(value)).digest('hex');
 async function invariant(){const facts={};for(const table of ['users','member_permission_assignments','wallet_operations','wallet_ledger_entries','cover_models','video_models','llm_models','model_pool_config_releases','pub_config_versions'])facts[table]=sha((await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS value FROM public.${table} t`)).rows[0].value);facts.otherSettings=sha((await db.query("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY setting_key),'[]') AS value FROM public.platform_settings t WHERE setting_key<>ALL($1::text[])",[['workspace_model_assignment_overrides_v1','image_model_surface_orders_v1','video_model_surface_orders_v1']])).rows[0].value);return facts;}
 const endpoint='/api/admin/workspace-model-releases',runId=randomUUID(),note=`原版发布中心两场景本地兼容映射 ${runId}`;
 const report={passed:false,runId,scope:'local-real-admin-versioned-two-native-scenes-only',createdAt:new Date().toISOString(),productionWrites:0,externalCalls:0,paidCalls:0,modelActivationChanges:0,credentialChanges:0,priceChanges:0};let stage='preflight',baseline;
 async function api(method,url,body){const response=await fetch(origin+url,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',signal:AbortSignal.timeout(30000)});const value=await response.json().catch(()=>null);assert.ok(response.ok&&value?.ok===true,`LOCAL_ADMIN_${method}_${response.status}:${String(value?.code||'UNKNOWN')}`);return value;}
 try{
  const previewStatus=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.resolve(root,'../../..','启动自媒体操盘手本地预览.ps1'),'-CheckOnly'],{cwd:path.resolve(root,'../../..'),encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']}).replace(/^\uFEFF/,'').trim());assert.equal(previewStatus.runningLatest,true,'LATEST_F_SOURCE_PREVIEW_REQUIRED');report.runningLatest=true;
  baseline=await invariant();const state=await api('GET',endpoint);assert.equal(state.runtimeEnforcement.ready,true);assert.ok(state.current?.id&&state.current.snapshot?.surfaces);
  const original=state.current.snapshot,next=structuredClone(original),mapping=[['publish-center-image','image-workbench','image'],['publish-center-video','video-page','video']];report.beforeReleaseId=state.current.id;report.beforeSnapshotSha256=state.current.snapshot_sha256;
  const readProjections=async()=>Object.fromEntries((await db.query("SELECT setting_key,setting_value::jsonb AS value FROM public.platform_settings WHERE setting_key=ANY($1::text[])",[['workspace_model_assignment_overrides_v1','image_model_surface_orders_v1','video_model_surface_orders_v1']])).rows.map(s=>[s.setting_key,s.value]));
  const beforeProjections=await readProjections();
  const oldProjectionFacts=value=>{const result=structuredClone(value);for(const setting of Object.values(result)){delete setting.surfaces['publish-center-image'];delete setting.surfaces['publish-center-video'];}return result;};
  for(const [target,source,kind]of mapping){const current=next.surfaces[target];if(current){assert.equal(current.kind,kind);assert.ok(current.assignedModelIds.length>0,'EXISTING_EMPTY_NATIVE_SCENE_REQUIRES_EXPLICIT_REVIEW');continue;}const from=original.surfaces[source];assert.equal(from.kind,kind);assert.ok(from.assignedModelIds.length>0,'SOURCE_SCENE_MUST_HAVE_ACTUAL_ASSIGNMENTS');next.surfaces[target]=structuredClone(from);}
  stage='rollback-only projection preflight';let previewOpen=false;try{await db.query('BEGIN');previewOpen=true;await db.query("SET LOCAL lock_timeout='3s'");await db.query('SELECT public.project_workspace_model_configuration_atomic($1::jsonb)',[JSON.stringify(next)]);assert.equal(canonical(oldProjectionFacts(await readProjections())),canonical(oldProjectionFacts(beforeProjections)),'EXISTING_SCENE_DRIFT_REQUIRES_RECONCILIATION_BEFORE_PUBLISH');}finally{if(previewOpen)await db.query('ROLLBACK');}report.projectionPreflightRolledBack=true;
  if(canonical(next)===canonical(original)){report.action='already_configured';report.afterReleaseId=state.current.id;}
  else{
   const originalWithout=structuredClone(original),nextWithout=structuredClone(next);for(const [target]of mapping){delete originalWithout.surfaces[target];delete nextWithout.surfaces[target];}assert.equal(canonical(nextWithout),canonical(originalWithout),'ONLY_TWO_NATIVE_SCENES_MAY_CHANGE');
   stage='create exact scoped candidate';const drafted=await api('POST',endpoint,{action:'draft',snapshot:next,changeNote:note});assert.ok(drafted.release?.id);report.candidateId=drafted.release.id;
   stage='validate candidate';const validated=await api('POST',endpoint,{action:'validate',releaseId:report.candidateId});assert.equal(validated.release.status,'validated');assert.equal(validated.release.validation_result.ok,true);
   stage='review exact preview';const {preview}=await api('GET',`${endpoint}?previewReleaseId=${encodeURIComponent(report.candidateId)}`);assert.equal(preview.current.releaseId,state.current.id);assert.equal(preview.diff.modelPoolRelease.changed,false);const changed=preview.diff.surfaces.filter(s=>s.changed);assert.ok(changed.length>0&&changed.every(s=>mapping.some(([target])=>target===s.surface)));report.changedSurfaces=changed.map(s=>s.surface);report.previewSha256=preview.previewSha256;
   stage='publish reviewed scoped candidate';await api('POST',endpoint,{action:'publish',releaseId:report.candidateId,previewSha256:preview.previewSha256});
   stage='exact persisted and projection readback';const readback=await api('GET',endpoint);assert.equal(readback.current.id,report.candidateId);assert.equal(canonical(readback.current.snapshot),canonical(next));report.afterReleaseId=readback.current.id;report.afterSnapshotSha256=readback.current.snapshot_sha256;
   report.action='published_local';
  }
  stage='shared exact native and old-scene projection readback';const projections=await readProjections();assert.equal(canonical(oldProjectionFacts(projections)),canonical(oldProjectionFacts(beforeProjections)),'TEN_EXISTING_SCENES_PROJECTION_CHANGED');report.existingSceneProjectionsUnchanged=true;report.scenes=[];
  for(const [target,,kind]of mapping){const scene=next.surfaces[target],assignment=projections.workspace_model_assignment_overrides_v1.surfaces[target],orders=projections[kind==='image'?'image_model_surface_orders_v1':'video_model_surface_orders_v1'].surfaces[target];assert.equal(canonical(assignment),canonical(Object.fromEntries(scene.assignedModelIds.map(id=>[id,true]))));assert.equal(canonical(orders),canonical(Object.fromEntries(scene.orderedModelIds.map((id,index)=>[id,(index+1)*10]))));report.scenes.push({surface:target,assigned:scene.assignedModelIds.length,ordered:scene.orderedModelIds.length});}report.passed=true;
 }catch(error){report.error={stage,message:String(error.message||error).slice(0,500)};}
 finally{if(baseline){report.existingUsersWalletModelsPoolAndOtherSettingsInvariant=canonical(await invariant())===canonical(baseline);if(!report.existingUsersWalletModelsPoolAndOtherSettingsInvariant)report.passed=false;}await db.end();const directory=path.join(root,'.codex-evidence/publish-center-closure-afb7f0d4');await fs.mkdir(directory,{recursive:true});const name=`native-model-scenes-config-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;await fs.writeFile(path.join(directory,name),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...report,report:name}));}
 if(!report.passed)process.exitCode=1;
}
