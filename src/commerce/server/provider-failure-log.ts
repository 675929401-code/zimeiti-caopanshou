type FrozenAttempt={requestSentAt?:number;terminalAt?:number;providerAttestation?:{endpointHost:string;submitted:string}};
export type VerifiedProviderFailure={requestId:string;host:string;model:string;providerFinishedAt:number;durationSeconds:number;providerQuota:0;verifiedAt:number;operatorId:string};
export async function readVerifiedProviderFailure(attempt:FrozenAttempt,endpoint:string,key:string,requestId:string,operatorId:string):Promise<VerifiedProviderFailure>{
  const target=new URL(endpoint),host=target.hostname,model=attempt.providerAttestation?.submitted;
  if(target.protocol!=='https:'||target.port||target.username||target.password||host!==attempt.providerAttestation?.endpointHost||!['n.lconai.com','gaorui.cc'].includes(host)||!model||!key)throw Error('原单服务商不支持此日志核验方式');
  if(!/^[a-zA-Z0-9_-]{12,128}$/.test(requestId)||!operatorId||!attempt.requestSentAt||!attempt.terminalAt)throw Error('缺少原单回执信息');
  const res=await fetch(new URL('/api/log/token',target.origin),{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(16000),cache:'no-store'});
  if(!res.ok)throw Error('供应商未返回本密钥的日志');
  const payload=await res.json();const rows=Array.isArray(payload.data)?payload.data:payload.data?.items;
  if(payload.success!==true||!Array.isArray(rows))throw Error('供应商日志不可核验');
  const candidates=rows.filter(row=>{
    if(row.model_name!==model||!Number.isFinite(row.use_time)||row.use_time<0||!Number.isFinite(row.created_at))return false;
    const end=row.created_at*1000,start=end-row.use_time*1000;
    return Math.abs(end-attempt.terminalAt!)<5500&&Math.abs(start-attempt.requestSentAt!)<5500;
  });
  const row=candidates[0];
  if(candidates.length!==1||row.request_id!==requestId||Number(row.type)!==5||row.quota!==0||
    !/(未能生成图片|图片生成失败|image generation failed)/i.test(String(row.content||'')))throw Error('缺少唯一匹配的零扣费图片失败日志，原单保持待核对');
  return {requestId,host,model,providerFinishedAt:row.created_at*1000,durationSeconds:row.use_time,providerQuota:0,verifiedAt:Date.now(),operatorId};
}
