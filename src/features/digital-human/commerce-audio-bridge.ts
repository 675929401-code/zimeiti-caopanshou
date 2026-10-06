import type {HumanAsset} from './client-state';

export const COMMERCE_DIGITAL_HUMAN_AUDIO_BRIDGE_VERSION='commerce-digital-human-audio-bridge/v1' as const;
export const COMMERCE_AUDIO_TRANSFER_MAX_BYTES=30*1024*1024;

export type CommerceAudioCandidate={
 id:string;
 name:string;
 type:string;
 size:number;
 sha256:string;
 createdAt:number;
 source:'upload'|'generated';
 jobId?:string;
 url:string;
 completionEvidence:'persisted-upload'|'voice-job-succeeded';
};

type FetchLike=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
type UploadTicket={
 error?:unknown;
 mode?:'direct'|'proxy'|'completed';
 asset?:HumanAsset;
 uploadUrl?:string;
 ticketId?:string;
 upload?:{url?:string;method?:string;headers?:Record<string,string>};
 completeUrl?:string;
};

const AUDIO_TYPES=new Set(['audio/mpeg','audio/wav','audio/x-wav']);

function text(value:unknown){return typeof value==='string'?value:'';}
function customerError(value:unknown,fallback:string){
 const message=text(value).trim();
 if(/API|HTTP|provider|供应商|上游|渠道|密钥|后台|数据库|迁移|对象存储/iu.test(message))return fallback;
 return message||fallback;
}
function assertHumanAudioAsset(value:unknown):HumanAsset{
 if(!value||typeof value!=='object')throw Error('数字人音频素材读回无效');
 const asset=value as HumanAsset;
 if(!/^[0-9a-f-]{36}$/iu.test(asset.id)||asset.category!=='audio'||!asset.url||!Number.isFinite(asset.duration)||asset.duration<=0||!Number.isSafeInteger(asset.size)||asset.size<=0)throw Error('数字人音频素材读回无效');
 return asset;
}
function bytesToBase64(bytes:Uint8Array){
 let binary='';
 for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
 return btoa(binary);
}
async function jsonBody(response:Response){
 try{return await response.json() as Record<string,unknown>;}catch{return {} as Record<string,unknown>;}
}
async function sha256(bytes:ArrayBuffer){
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}
async function waitFor(milliseconds:number,signal?:AbortSignal){
 await new Promise<void>((resolve,reject)=>{
  if(signal?.aborted){reject(signal.reason||new DOMException('Aborted','AbortError'));return;}
  const timer=setTimeout(done,milliseconds);
  function done(){signal?.removeEventListener('abort',abort);resolve();}
  function abort(){clearTimeout(timer);reject(signal?.reason||new DOMException('Aborted','AbortError'));}
  signal?.addEventListener('abort',abort,{once:true});
 });
}

export function commerceAudioUploadRequestId(candidate:Pick<CommerceAudioCandidate,'id'|'sha256'>){
 if(!/^[0-9a-f-]{36}$/iu.test(candidate.id)||!/^[0-9a-f]{64}$/iu.test(candidate.sha256))throw Error('带货音频稳定身份无效');
 return `commerce-audio-${candidate.id}-${candidate.sha256.slice(0,24).toLowerCase()}`;
}

export async function transferCommerceAudioToDigitalHuman(
 candidate:CommerceAudioCandidate,
 token:string,
 options:{fetcher?:FetchLike;signal?:AbortSignal;waiter?:(milliseconds:number,signal?:AbortSignal)=>Promise<void>}={},
):Promise<HumanAsset>{
 if(!token)throw Error('主站登录状态已失效，请重新登录');
 if(!AUDIO_TYPES.has(candidate.type)||!Number.isSafeInteger(candidate.size)||candidate.size<=0||candidate.size>COMMERCE_AUDIO_TRANSFER_MAX_BYTES)throw Error('该带货音频不符合数字人输入要求');
 const fetcher=options.fetcher||fetch;
 const sourceResponse=await fetcher(candidate.url,{method:'GET',cache:'no-store',credentials:'same-origin',signal:options.signal});
 if(!sourceResponse.ok)throw Error('带货音频暂时无法读取，请刷新后重试');
 const sourceBytes=await sourceResponse.arrayBuffer();
 if(sourceBytes.byteLength!==candidate.size)throw Error('带货音频大小与资产记录不一致，已停止复制');
 if(await sha256(sourceBytes)!==candidate.sha256.toLowerCase())throw Error('带货音频内容与资产记录不一致，已停止复制');

 const requestId=commerceAudioUploadRequestId(candidate);
 const prefixBase64=bytesToBase64(new Uint8Array(sourceBytes.slice(0,64*1024)));
 const authorization={Authorization:`Bearer ${token}`};
 const ticketResponse=await fetcher('/api/digital-human/upload-ticket',{
  method:'POST',headers:{...authorization,'Content-Type':'application/json','Idempotency-Key':requestId},cache:'no-store',signal:options.signal,
  body:JSON.stringify({requestId,category:'audio',size:candidate.size,contentType:candidate.type,originalName:candidate.name,prefixBase64}),
 });
 const ticket=await jsonBody(ticketResponse) as UploadTicket;
 if(!ticketResponse.ok)throw Error(customerError(ticket.error,'无法建立数字人音频复制，请稍后重试'));
 if(ticket.mode==='completed'&&ticket.asset)return assertHumanAudioAsset(ticket.asset);

 const blob=new Blob([sourceBytes],{type:candidate.type});
 if(ticket.mode==='proxy'){
  const form=new FormData();
  form.append('file',blob,candidate.name||'commerce-audio');
  form.append('category','audio');
  form.append('client_request_id',requestId);
  const response=await fetcher(text(ticket.uploadUrl)||'/api/digital-human/upload',{method:'POST',headers:authorization,body:form,cache:'no-store',signal:options.signal});
  const result=await jsonBody(response);
  if(!response.ok)throw Error(customerError(result.error,'带货音频复制未完成，请稍后重试'));
  return assertHumanAudioAsset(result.asset);
 }

 const uploadUrl=text(ticket.upload?.url),ticketId=text(ticket.ticketId),completeUrl=text(ticket.completeUrl)||'/api/digital-human/upload-session';
 if(!uploadUrl||!ticketId)throw Error('数字人音频上传票据不完整');
 let transferFailure:unknown;
 try{
  const response=await fetcher(uploadUrl,{method:'PUT',headers:ticket.upload?.headers||{'Content-Type':candidate.type},body:blob,signal:options.signal});
  if(!response.ok)transferFailure=Error('云存储上传未确认');
 }catch(error){transferFailure=error;}

 for(let attempt=0;attempt<3;attempt+=1){
 const response=await fetcher(completeUrl,{
   method:'POST',headers:{...authorization,'Content-Type':'application/json','Idempotency-Key':requestId},cache:'no-store',signal:options.signal,
   body:JSON.stringify({requestId,ticketId}),
  });
  const result=await jsonBody(response);
  if(response.ok&&result.asset)return assertHumanAudioAsset(result.asset);
  const retryable=result.code==='UPLOAD_NOT_VISIBLE'||result.code==='UPLOAD_COMPLETE_RETRY'||response.status===503;
  if(!retryable||attempt===2)throw Error(customerError(result.error,transferFailure?'带货音频未能上传，请检查网络后重试':'数字人音频复制暂时无法确认'));
  const retryAfter=Math.max(1,Math.min(5,Number(response.headers.get('Retry-After')||2)));
  await (options.waiter||waitFor)(retryAfter*1000,options.signal);
 }
 throw Error('数字人音频复制暂时无法确认');
}
