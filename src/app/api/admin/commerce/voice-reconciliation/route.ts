import {NextRequest,NextResponse} from 'next/server';

import {requireCommerceAdmin} from '@/lib/commerce-admin-auth';
import {publicVoiceJob,resolveVoiceReconciliation,voiceReconciliationJobs} from '@/commerce/server/voice-jobs';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:NextRequest){
  const auth=await requireCommerceAdmin(request,{
    requiredPermissions:['billing.view','member_content.view'],
    operation:'commerce_voice_reconciliation_view',
  });
  if('response' in auth)return auth.response;
  const jobs=voiceReconciliationJobs().map(job=>({
    owner:job.owner,
    mainUserId:job.mainUserId,
    requestedAt:job.reconciliation?.requestedAt,
    job:publicVoiceJob(job),
  }));
  return NextResponse.json({ok:true,jobs},{headers:{'Cache-Control':'no-store'}});
}

export async function POST(request:NextRequest){
  const auth=await requireCommerceAdmin(request,{
    mutation:true,
    requiredPermissions:['wallet.adjust','member_content.view'],
    stepUpPermissions:['wallet.adjust'],
    operation:'commerce_voice_reconciliation_manage',
  });
  if('response' in auth)return auth.response;
  try{
    const body=await request.json();
    if(!['resolve-success','resolve-failed'].includes(String(body.action||'')))throw Error('对账操作无效');
    const job=await resolveVoiceReconciliation({
      owner:String(body.owner||''),
      id:String(body.id||''),
      resolvedBy:auth.actor.userId,
      outcome:body.action==='resolve-success'?'success':'failed',
      evidence:body.evidence,
      providerTaskId:String(body.providerTaskId||''),
      resultAssetId:body.resultAssetId?String(body.resultAssetId):undefined,
      actualCostAmount:body.actualCostAmount===undefined?undefined:Number(body.actualCostAmount),
    });
    return NextResponse.json({ok:true,job:publicVoiceJob(job)});
  }catch(error){
    return NextResponse.json({ok:false,error:error instanceof Error?error.message:'语音对账失败'},{status:409,headers:{'Cache-Control':'no-store'}});
  }
}
