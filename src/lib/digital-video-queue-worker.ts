import 'server-only';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { submitVideoTask, pollVideoTask, type VideoModelConfig, type VideoTaskResult } from '@/lib/video-adapter';
import { digitalModelHash, digitalProviderKey, type DigitalDispatchJob } from '@/lib/digital-video-dispatch';
import { bindVideoProviderTask, finalizeVideoGenerationSuccess } from '@/lib/video-terminal-finalizer';
import { ownedDigitalHumanAsset } from '@/lib/digital-human-assets';
import { humanDurationCapabilities, planHumanDuration, type HumanDurationChoice } from '@/features/digital-human/duration-policy';
import { isUserAccountDisabled } from '@/lib/user-account-status';
import { resolveProviderSecret } from '@/lib/provider-secret';
import { classifyVideoProviderError, sanitizeVideoProviderDiagnostic } from '@/lib/video-error-policy';
import { recordVideoSubmission, recordVideoTerminalOutcome } from '@/lib/video-terminal-accounting';
import { DurableQueueLoop } from '@/lib/durable-queue-loop';

async function transition(job:DigitalDispatchJob,state:string,url?:string,code?:string,message?:string,delay=5) {
 const {data,error}=await getSupabaseAdminClient().rpc('update_digital_video_dispatch',{p_task_id:job.task_id,p_worker:job.lease_owner,p_state:state,p_result_url:url||null,p_error_code:code||null,p_error_message:message||null,p_delay_seconds:delay});
 if(error||data!==true)throw new Error('DIGITAL_QUEUE_LEASE_OR_SAVE_FAILED');
}
/** A dispatch lease is never replayed after a crash. Running leases only poll the bound provider task. */
export async function executeDigitalVideoDispatch(job:DigitalDispatchJob) {
 const db=getSupabaseAdminClient();
 const taskRead=await db.from('video_tasks').select('*').eq('id',job.task_id).eq('user_id',job.user_id).single();
 if(taskRead.error||!taskRead.data)throw new Error('DIGITAL_QUEUE_TASK_READ_FAILED');
 const task=taskRead.data;
 if(task.status==='completed'){await transition(job,'completed');return;}
 if(['failed','expired','cancelled'].includes(task.status)){await transition(job,task.status==='cancelled'?'cancelled':'failed',undefined,task.submission_error_code,task.error_message);return;}
 const userRead=await db.from('users').select('id,role,is_active,status,cash_balance,member_status,member_expires_at').eq('id',job.user_id).single();
 if(userRead.error||!userRead.data)throw new Error('DIGITAL_QUEUE_USER_READ_FAILED');
 const user=userRead.data;
 if(job.state==='finalizing') {
  const result=await finalizeVideoGenerationSuccess({taskIdInternal:job.task_id,userId:job.user_id,userRole:user.role==='admin'?'admin':'student',providerTaskId:task.task_id_external,providerVideoUrl:job.provider_result_url||undefined});
  await transition(job,result.state==='completed'?'completed':'finalizing',undefined,undefined,undefined,15);return;
 }
 const modelRead=await db.from('video_models').select('*').eq('id',task.model_id).single();
 if(modelRead.error||!modelRead.data)throw new Error('DIGITAL_QUEUE_MODEL_READ_FAILED');
 const raw=modelRead.data;
 const model:VideoModelConfig={...raw,api_key:resolveProviderSecret(raw.api_key),model_name:raw.model_name||raw.id,api_protocol_config:raw.api_protocol_config||undefined};
 if(digitalModelHash(model)!==job.model_hash||digitalProviderKey(model)!==job.provider_key){
  await transition(job,job.state==='dispatching'?'failed':'submission_unknown',undefined,'DIGITAL_MODEL_CONFIGURATION_CHANGED',job.state==='dispatching'?'模型配置已更新，请重新选择后生成。本次未扣费。':'正在核对原模型任务，请勿重复生成');return;
 }
 if(job.state==='dispatching') {
  if(isUserAccountDisabled(user)||task.billing_exempt&&user.role!=='admin') {await transition(job,'failed',undefined,'DIGITAL_ACCOUNT_UNAVAILABLE','账号状态已变更，任务未提交，本次未扣费。');return;}
  const membershipExpired=['inactive','expired'].includes(user.member_status)||user.member_expires_at&&Date.parse(user.member_expires_at)<Date.now();
  if(user.role!=='admin'&&membershipExpired){await transition(job,'failed',undefined,'MEMBERSHIP_REQUIRED','会员状态已失效，请激活或续费后重新生成。本次未扣费。');return;}
  if(!raw.is_active||raw.is_hidden){await transition(job,'failed',undefined,'DIGITAL_MODEL_UNAVAILABLE','所选模型暂时不可用，任务未提交，本次未扣费。');return;}
  if(!task.billing_exempt&&Number(user.cash_balance)<Number(task.billing_price_yuan)){await transition(job,'failed',undefined,'INSUFFICIENT_CASH_BALANCE','本站钱包余额不足，请充值后重新生成。本次未扣费。');return;}
  let person,audio;
  try{[person,audio]=await Promise.all([ownedDigitalHumanAsset(job.user_id,job.inputs.personAssetId),ownedDigitalHumanAsset(job.user_id,job.inputs.audioAssetId)]);}catch{await transition(job,'failed',undefined,'DIGITAL_ASSET_UNAVAILABLE','人物素材或配音暂时无法读取，请检查素材后重试。本次未扣费。');return;}
  const plan=planHumanDuration(humanDurationCapabilities(raw),job.inputs.mode,person.duration,audio.duration,job.inputs.durationChoice as HumanDurationChoice,audio.size);
  if(plan.error||person.category!==(job.inputs.mode==='photo'?'image':'video')||audio.category!=='audio'||plan.videoExtension!==Boolean(job.inputs.params.videoExtension)) {await transition(job,'failed',undefined,'DIGITAL_ASSET_INPUT_CHANGED',plan.error||'素材与原任务不一致，任务未提交，本次未扣费。');return;}
  const lease=await db.rpc('begin_digital_video_post',{p_task_id:job.task_id,p_worker:job.lease_owner});
  if(lease.error||lease.data!==true)throw new Error('DIGITAL_QUEUE_DISPATCH_LEASE_EXPIRED');
  let result:VideoTaskResult;
  try{result=await submitVideoTask(model,{...job.inputs.params,imageUrl:job.inputs.mode==='photo'?person.url:undefined,sourceVideoUrl:job.inputs.mode==='video'?person.url:undefined,audioUrl:audio.url});}
  catch(error){
   console.warn('[DigitalVideoQueue] provider submission outcome is unknown', {
    taskId: job.task_id,
    modelId: model.id,
    protocol: model.protocol_type,
    diagnostic: sanitizeVideoProviderDiagnostic(error instanceof Error ? error.message : error),
   });
   await transition(job,'submission_unknown',undefined,'VIDEO_SUBMIT_OUTCOME_UNKNOWN','正在确认原任务，请勿重复生成');return;
  }
  if(result.submissionOutcome==='unknown'){await transition(job,'submission_unknown',undefined,'VIDEO_SUBMIT_OUTCOME_UNKNOWN','正在确认原任务，请勿重复生成');return;}
  if(result.status==='failed') {
   const failure=classifyVideoProviderError(result.error,model.name);
   console.warn('[DigitalVideoQueue] provider rejected submission', {
    taskId: job.task_id,
    modelId: model.id,
    protocol: model.protocol_type,
    code: failure.code,
    diagnostic: sanitizeVideoProviderDiagnostic(result.error),
   });
   if(result.taskId)await bindVideoProviderTask({taskIdInternal:job.task_id,userId:job.user_id,requestFingerprint:task.request_fingerprint,providerTaskId:result.taskId,contentUrl:result.contentUrl});
   await transition(job,'failed',undefined,failure.code,failure.publicMessage);
   await recordVideoTerminalOutcome({modelId:model.id,outcome:'fail',responseMs:0,errorMessage:failure.publicMessage,countSubmission:true});return;
  }
  const providerId=result.taskId||(result.status==='success'&&result.videoUrl?'sync_'+job.task_id.slice(3):'');
  if(!providerId){await transition(job,'submission_unknown',undefined,'VIDEO_PROVIDER_TASK_ID_MISSING','正在确认原任务，请勿重复生成');return;}
  // Save the receipt before releasing the lease. A later DB failure cannot cause another generation.
  await bindVideoProviderTask({taskIdInternal:job.task_id,userId:job.user_id,requestFingerprint:task.request_fingerprint,providerTaskId:providerId,contentUrl:result.contentUrl});
  await transition(job,result.status==='success'&&result.videoUrl?'finalizing':'running',result.videoUrl);
  await recordVideoSubmission(model.id);return;
 }
 if(!task.task_id_external){await transition(job,'submission_unknown',undefined,'VIDEO_PROVIDER_TASK_ID_MISSING','正在确认原任务，请勿重复生成');return;}
 let result:VideoTaskResult;
 try{result=await pollVideoTask(model,String(task.task_id_external),task.content_url||undefined);}
 catch{await transition(job,'running',undefined,undefined,undefined,30);return;}
 if(result.status==='success'&&result.videoUrl){await transition(job,'finalizing',result.videoUrl);return;}
 if(result.status==='failed') {
  const failure=classifyVideoProviderError(result.error,model.name);
  await transition(job,'failed',undefined,failure.code,failure.publicMessage);
  await recordVideoTerminalOutcome({modelId:model.id,outcome:'fail',responseMs:0,errorMessage:failure.publicMessage});return;
 }
 await transition(job,'running',undefined,undefined,undefined,10);
}

export async function runDigitalVideoQueueWorkerOnce(maxClaims = 8) {
 let claimed = 0;
 let retained = 0;
 for(let index=0;index<Math.max(1,Math.min(32,maxClaims));index++){
  const workerId=`media:${process.pid}:${randomUUID()}`;
  const {data,error}=await getSupabaseAdminClient().rpc('claim_digital_video_dispatch',{p_worker:workerId});
  if(error)throw new Error('DIGITAL_QUEUE_CLAIM_FAILED');
  if(!data)break;
  claimed+=1;
  try{await executeDigitalVideoDispatch(data as DigitalDispatchJob);}
  catch{retained+=1;console.warn('[DigitalVideoQueue] task retained for safe recovery',{taskId:data.task_id});}
 }
 return {claimed,retained};
}

type WorkerState={loop:DurableQueueLoop};
const stateGlobal=globalThis as typeof globalThis & {__digitalVideoWorker?:WorkerState};
export function startDigitalVideoQueueWorker() {
 if(process.env.NEXT_PHASE==='phase-production-build'||process.argv.includes('build')||process.env.MEDIA_QUEUE_WORKER_PROCESS!=='1'||process.env.DIGITAL_VIDEO_QUEUE_WORKER!=='1')return false;
 const state=stateGlobal.__digitalVideoWorker??={loop:new DurableQueueLoop({
  name:'digital-video-dispatch',intervalMs:5000,runOnce:async()=>{await runDigitalVideoQueueWorkerOnce(8);},
  onError:()=>console.warn('[DigitalVideoQueue] queue temporarily unavailable; no task resubmitted'),
 })};
 return state.loop.start();
}

export async function stopDigitalVideoQueueWorker(drainTimeoutMs=25_000){
 const state=stateGlobal.__digitalVideoWorker;
 return state?state.loop.stop(drainTimeoutMs):true;
}

export function digitalVideoQueueWorkerStatus(){
 return stateGlobal.__digitalVideoWorker?.loop.snapshot()??null;
}
