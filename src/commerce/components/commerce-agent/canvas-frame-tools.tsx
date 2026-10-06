'use client';
import {useEffect,useRef,useState} from 'react';import {api} from './runtime-ui';
import {frameInput,type FrameInput,type FrameMode,type ExtractedFrame,type FrameExtractionJob} from '../../frame-extraction-types';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION} from '../../shared/video-generation-capabilities';
type Reply={ownerId:string;job:FrameExtractionJob|null};
type Pending={ownerId:string;input:FrameInput};
const active=(job:FrameExtractionJob|null)=>!!job&&['queued','running'].includes(job.status);
export function CanvasFrameTools({assetId,contextKey='',remainingSlots=0,appliedTaskIds=[],onFrames,onNotice}:{assetId:string;contextKey?:string;remainingSlots?:number;appliedTaskIds?:string[];onFrames:(frames:ExtractedFrame[],taskId:string)=>void|Promise<void>;onNotice:(s:string)=>void}){
 const [mode,setMode]=useState<FrameMode>('shot-starts'),[job,setJob]=useState<FrameExtractionJob|null>(null),[pending,setPending]=useState<Pending|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[applying,setApplying]=useState(false),[applied,setApplied]=useState(''),[error,setError]=useState('');
 const state=useRef({ownerId:'',key:'',generation:0,sending:false,applying:false,autoAttempted:''});
 const validScope=(reply:Reply)=>{if(reply.ownerId!==state.current.ownerId)throw Error('登录账号已变化，请刷新画布后核对原任务');if(reply.job&&(reply.job.sourceAssetId!==assetId||reply.job.input.contextKey!==contextKey))throw Error('原抽帧任务不属于当前视频节点');};
 useEffect(()=>{
  const generation=++state.current.generation;let cancelled=false;setReady(false);setJob(null);setPending(null);setApplied('');setError('');state.current.autoAttempted='';
  if(!contextKey){setError('请先保存画布，确定视频节点后再抽帧');return;}
  void api<Reply>('/api/commerce/frame-extraction?assetId='+encodeURIComponent(assetId)+'&contextKey='+encodeURIComponent(contextKey)).then(async reply=>{
   if(cancelled||generation!==state.current.generation)return;if(!reply.ownerId)throw Error('无法确认当前抽帧账号');state.current.ownerId=reply.ownerId;state.current.key='ca-frame-request-v1:'+encodeURIComponent(reply.ownerId)+':'+encodeURIComponent(contextKey)+':'+assetId;
   let stored:Pending|null=null;try{const raw=localStorage.getItem(state.current.key);if(raw){const value=JSON.parse(raw) as Pending;const input=frameInput(value.input);if(value.ownerId===reply.ownerId&&input.assetId===assetId&&input.contextKey===contextKey)stored={ownerId:value.ownerId,input};}}catch{onNotice('原抽帧请求记录无法读取，当前只查询服务器已有任务。');}
   if(stored){reply=await api<Reply>('/api/commerce/frame-extraction?requestId='+encodeURIComponent(stored.input.requestId));if(cancelled||generation!==state.current.generation)return;validScope(reply);if(!reply.job)setPending(stored);}
   validScope(reply);setJob(reply.job);if(reply.job){setMode(reply.job.input.mode);try{if(localStorage.getItem(state.current.key+':applied:'+reply.job.id)==='1')setApplied(reply.job.id);}catch{}}
   setReady(true);
  }).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};
 },[assetId,contextKey]);
 useEffect(()=>{if(!active(job))return;let cancelled=false;const id=job!.id,generation=state.current.generation;const timer=setInterval(()=>{void api<Reply>('/api/commerce/frame-extraction?id='+encodeURIComponent(id)).then(reply=>{if(cancelled||generation!==state.current.generation)return;validScope(reply);if(!reply.job)throw Error('原抽帧任务不存在');setJob(reply.job);setError('');}).catch(e=>{if(!cancelled)setError('原任务查询失败：'+e.message);});},1000);return()=>{cancelled=true;clearInterval(timer);};},[job?.id,job?.status]);
 async function send(value:Pending){
  if(state.current.sending)return;state.current.sending=true;setBusy(true);setError('');const generation=state.current.generation;
  try{const reply=await api<Reply>('/api/commerce/frame-extraction',{...value.input,ownerId:value.ownerId});if(generation!==state.current.generation)return;validScope(reply);if(!reply.job)throw Error('抽帧任务未返回');setJob(reply.job);setPending(null);onNotice('抽帧请求已保存，可以关闭后查询原任务。');}
  catch(e){if(generation!==state.current.generation)return;try{const reply=await api<Reply>('/api/commerce/frame-extraction?requestId='+encodeURIComponent(value.input.requestId));validScope(reply);if(reply.job){setJob(reply.job);setPending(null);return;}}catch{}setPending(value);setError((e as Error).message+'。请先核对原请求；重试使用同一个请求号。');}
  finally{state.current.sending=false;if(generation===state.current.generation)setBusy(false);}
 }
 function start(){if(!ready||active(job)||state.current.sending||pending||remainingSlots<1)return;const value:Pending={ownerId:state.current.ownerId,input:{requestId:crypto.randomUUID(),assetId,mode,contextKey,remainingSlots:Math.min(100,remainingSlots)}};try{localStorage.setItem(state.current.key,JSON.stringify(value));}catch{onNotice('浏览器无法保留请求号，刷新后将按此视频节点查询服务器记录。');}state.current.autoAttempted='';setPending(value);void send(value);}
 async function applyResult(){
  if(!job||job.status!=='succeeded'||state.current.applying)return;
  const target=job,generation=state.current.generation;state.current.applying=true;setApplying(true);setError('');
  try{await onFrames(target.frames,target.id);if(generation!==state.current.generation)return;setApplied(target.id);try{localStorage.setItem(state.current.key+':applied:'+target.id,'1');}catch{}onNotice(`已把 ${target.frames.length} 帧保存到画布。`);}catch(e){if(generation===state.current.generation)setError('图片资产已保留，放入画布未完成：'+(e as Error).message);}finally{state.current.applying=false;if(generation===state.current.generation)setApplying(false);}
 }
 const alreadyApplied=!!job&&(applied===job.id||appliedTaskIds.includes(job.id));
 useEffect(()=>{if(job?.status==='succeeded'&&!alreadyApplied&&state.current.autoAttempted!==job.id){state.current.autoAttempted=job.id;void applyResult();}},[job?.id,job?.status,alreadyApplied]);
 async function checkOriginal(){if(!pending)return;try{const reply=await api<Reply>('/api/commerce/frame-extraction?requestId='+encodeURIComponent(pending.input.requestId));validScope(reply);if(reply.job){setJob(reply.job);setPending(null);setError('');}else setError('服务器尚未收到这个请求。可以使用原请求号重试提交。');}catch(e){setError((e as Error).message);}}
 return <section className="ca-frame-tools"><label>视频抽帧<select aria-label="视频抽帧方式" value={mode} disabled={busy||active(job)||!!pending} onChange={e=>setMode(e.target.value as FrameMode)}><option value="seconds">逐秒抽帧</option><option value="shot-starts">分镜首帧</option><option value="shot-boundaries">分镜首尾帧</option><option value="first">截取首帧</option><option value="last">截取尾帧</option></select></label>
  <small>视频画面最长 {COMMERCE_VIDEO_MAX_TOTAL_DURATION} 秒 · 当前可用 {remainingSlots} 个图片位置</small>
  <button disabled={!ready||busy||active(job)||!!pending||remainingSlots<1} onClick={start}>{busy?'正在提交…':active(job)?'正在提取…':'提取到画布'}</button>
  {pending&&<div role="status"><p>已保留原请求号，尚待服务器核对。</p><button disabled={busy} onClick={()=>void checkOriginal()}>核对原抽帧请求</button><button disabled={busy} onClick={()=>void send(pending)}>使用原请求号重试提交</button></div>}
  {job&&<div role="status"><p>{job.status==='succeeded'?`已提取 ${job.frames.length} 帧`:(job.status==='failed'||job.status==='interrupted')?job.error:`${job.phase==='saving'?'正在保存图片':'正在分析或提取画面'} · 已保存 ${job.frames.length}/${job.plannedCount??'—'} 帧`}</p>{job.status==='succeeded'&&(alreadyApplied?<p>已保存到当前画布</p>:<><p>图片资产已保存。放入画布时会核对实际缺失的节点与可用位置。</p><button disabled={applying} onClick={()=>void applyResult()}>{applying?'正在保存画布…':'将已提取图片放入画布'}</button></>)}{['failed','interrupted'].includes(job.status)&&!!job.frames.length&&<p>已有 {job.frames.length} 张图片保存在资产库，原任务不会重放。</p>}<small>任务 {job.id.slice(0,8)} · 来源 {job.sourceAssetId.slice(0,8)}</small></div>}
  {error&&<p role="alert">{error}</p>}
  {mode.startsWith('shot')&&<small>镜头检测采用本地画面变化分析，复杂运动与渐变可能需要人工核对。</small>}
 </section>;
}
