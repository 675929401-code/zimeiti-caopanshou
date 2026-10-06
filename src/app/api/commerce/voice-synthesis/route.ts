import {after} from 'next/server';

import {authorizeCurrentCommerceIdentity} from '../../../../commerce/server/main-account-access';
import {commerceVoiceCatalog,CommerceVoiceBridgeError} from '../../../../commerce/server/voice-bridge';
import {cancelVoicePendingCharge,confirmVoice,publicVoiceJob,publicVoiceQuote,quoteVoice,recoverVoiceJobs,requestVoiceReconciliation,retryVoiceAssetRecovery,retryVoiceCharge,runVoiceJob,voiceJob,voiceJobs} from '../../../../commerce/server/voice-jobs';
import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {errorResponse,json} from '../../../../commerce/server/http';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;

function failure(error:unknown){
  if(error instanceof CommerceVoiceBridgeError)return json({error:error.message,code:error.code},error.status);
  return errorResponse(error);
}

export async function GET(request:Request){
  try{
    const user=requireIdentity(request),url=new URL(request.url),action=url.searchParams.get('action');
    if(action==='catalog')return json({voices:await commerceVoiceCatalog()});
    const id=url.searchParams.get('id');
    if(id){
      const job=voiceJob(user.id,id);if(!job)return json({error:'语音任务不存在'},404);
      const workerEligible=(job.status==='queued'&&job.billingState==='charged')||
        (['running','saving'].includes(job.status)&&job.billingState==='charged')||
        (job.status==='succeeded'&&['charged','revenue_pending'].includes(job.billingState))||
        (job.status==='failed'&&['charged','refund_pending','reconciliation_required'].includes(job.billingState));
      if(workerEligible)after(()=>runVoiceJob(job.id,user.id));
      return json({job:publicVoiceJob(job)});
    }
    const jobs=voiceJobs(user.id);after(()=>recoverVoiceJobs(user.id,4));return json({jobs:jobs.map(publicVoiceJob)});
  }catch(error){return failure(error);}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);const user=requireIdentity(request);const mainAccount=await authorizeCurrentCommerceIdentity(user);const body=await request.json();
    if(body.action==='quote')return json({quote:publicVoiceQuote(await quoteVoice(user.id,{voiceId:body.voiceId,text:body.text,parameters:body.parameters}))});
    if(body.action==='confirm'){
      const job=await confirmVoice(user.id,String(body.quoteId||''),String(body.clientRequestId||''),mainAccount.mainUserId);
      if(job.status==='queued')after(()=>runVoiceJob(job.id,user.id));
      return json({job:publicVoiceJob(job)},job.status==='queued'?202:200);
    }
    if(body.action==='retry-save'){
      const job=await retryVoiceAssetRecovery(user.id,String(body.id||''));
      return json({job:publicVoiceJob(job)});
    }
    if(body.action==='request-reconciliation'){
      const job=requestVoiceReconciliation(user.id,String(body.id||''));
      return json({job:publicVoiceJob(job)},202);
    }
    if(body.action==='retry-charge'){
      const job=await retryVoiceCharge(user.id,String(body.id||''),mainAccount.mainUserId);
      if(job.status==='queued')after(()=>runVoiceJob(job.id,user.id));
      return json({job:publicVoiceJob(job)},job.status==='queued'?202:200);
    }
    if(body.action==='cancel-pending-charge'){
      const job=cancelVoicePendingCharge(user.id,String(body.id||''),mainAccount.mainUserId);
      return json({job:publicVoiceJob(job)});
    }
    throw Error('语音操作无效；仅支持 quote、confirm、retry-charge、cancel-pending-charge、retry-save 与 request-reconciliation');
  }catch(error){return failure(error);}
}
