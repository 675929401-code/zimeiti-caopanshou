import 'server-only';
import { createHash } from 'node:crypto';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import type { VideoGenerateParams, VideoModelConfig } from '@/lib/video-adapter';

export type DigitalDispatchInput = {
 providerKey: string; modelHash: string;
 inputs: { personAssetId: string; audioAssetId: string; mode: 'photo' | 'video'; durationChoice?: string; params: VideoGenerateParams };
};
export type DigitalDispatchJob = {
 task_id: string; user_id: string; provider_key: string; model_hash: string;
 inputs: DigitalDispatchInput['inputs']; state: string; lease_owner: string;
 provider_result_url?: string; error_code?: string; error_message?: string;
};
function canonical(value: unknown): unknown { if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value; }
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const queuedDigitalProtocol=(protocol:string)=>['dashscope_video_retalk','dashscope_wan_s2v','volcengine_digital_human'].includes(protocol);
export function digitalModelHash(model:VideoModelConfig){return hash([model.id,model.protocol_type,model.api_endpoint,model.model_name,model.api_key,model.api_protocol_config]);}
export function digitalProviderKey(model:VideoModelConfig){return hash([new URL(model.api_endpoint).origin,model.api_key]);}
export function buildDigitalDispatch(model:VideoModelConfig, inputs:DigitalDispatchInput['inputs']):DigitalDispatchInput {
 if(!queuedDigitalProtocol(model.protocol_type)||![inputs.personAssetId,inputs.audioAssetId].every(id=>/^[0-9a-f-]{36}$/i.test(id)))throw new Error('数字人排队素材无效');
 // Keep owned asset IDs, never signed URLs, bearer tokens or provider keys.
 const params={...inputs.params};delete params.onProviderRequest;delete params.imageUrl;delete params.sourceVideoUrl;delete params.audioUrl;delete params.imageUrls;delete params.audioUrls;delete params.lastFrameUrl;delete params.referenceImageUrl;
 return {providerKey:digitalProviderKey(model),modelHash:digitalModelHash(model),inputs:{...inputs,params}};
}
export async function digitalDispatchStatus(taskId:string,userId:string){
 const db=getSupabaseAdminClient();const {data,error}=await db.from('digital_video_dispatch_jobs').select('state,provider_key,created_at,error_message').eq('task_id',taskId).eq('user_id',userId).maybeSingle();
 if(error)throw new Error('数字人任务队列暂时无法读取');if(!data)return null;
 let position:number|undefined;
 if(data.state==='queued'){const count=await db.from('digital_video_dispatch_jobs').select('task_id',{count:'exact',head:true}).eq('provider_key',data.provider_key).eq('state','queued').lte('created_at',data.created_at);if(!count.error)position=count.count||1;}
 return {state:String(data.state),position,message:data.state==='queued'?(position?'排队中，前面还有 '+Math.max(0,position-1)+' 个任务':'排队中，轮到后自动开始'):data.state==='dispatching'?'正在提交任务':data.state==='submission_unknown'?'正在确认原任务，请勿重复生成':data.state==='finalizing'?'视频已生成，正在保存成品与结算':'正在生成视频'};
}
