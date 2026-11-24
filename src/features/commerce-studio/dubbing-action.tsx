'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,type Runtime} from '@/commerce/components/commerce-agent/runtime-ui';
import {parseSubtitles,renderSrt} from '@/commerce/shared/member-captions';
import type {DubSkill,DubView} from '@/commerce/shared/dubbing';
const endpoint='/api/commerce/studio/dubbing',langs:Record<string,string>={zh:'中文',en:'英文',th:'泰语',vi:'越南语'};
const statuses:Record<string,string>={quoted:'待确认',ready:'正在按句配音',charging:'核对扣款',sending:'正在合成',unknown:'原单待核对',rendering:'正在合成画面与声音',settling:'正在结算',failed:'未交付',done:'已完成',refunding:'正在退款'};
export function DubbingAction({skill,runtime,thread,onTranslate}:{skill:DubSkill;runtime:Runtime;thread:string;onTranslate:(s:string)=>void}){
 const correction=skill==='speech-correction',[asset,setAsset]=useState(''),[lang,setLang]=useState(correction?'zh':'en'),[srt,setSrt]=useState(''),[rights,setRights]=useState(false),[job,setJob]=useState<DubView>(),[history,setHistory]=useState<DubView[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const lock=useRef(false),alive=useRef(true);const reload=useCallback(async()=>{const v=await api<{jobs:DubView[]}>(endpoint+'?skill='+skill);if(alive.current)setHistory(v.jobs);},[skill]);
 useEffect(()=>{alive.current=true;void reload().catch(()=>{});const receive=(event:Event)=>{const d=(event as CustomEvent<{thread:string;srt:string}>).detail;if(thread===d?.thread){setSrt(d.srt);setJob(undefined);}};window.addEventListener('commerce-translated-captions',receive);return()=>{alive.current=false;window.removeEventListener('commerce-translated-captions',receive);};},[thread,reload]);
 const perform=useCallback(async(fn:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(alive.current)setError((e as Error).message);}finally{lock.current=false;if(alive.current)setBusy(false);}},[]);
 const act=useCallback((action:'quote'|'confirm'|'refresh',id?:string)=>perform(async()=>{const v=await api<{job:DubView}>(endpoint,action==='quote'?{action,skill,assetId:asset,srt,lang,authorized:rights}:{action,id});if(alive.current){setJob(v.job);if(v.job.status!=='quoted')await reload();}}),[perform,skill,asset,srt,lang,rights,reload]);
 useEffect(()=>{if(!job||busy||error||!['ready','rendering','settling','refunding'].includes(job.status))return;const t=setTimeout(()=>void act('refresh',job.id),650);return()=>clearTimeout(t);},[job,busy,error,act]);
 return <section className="cs-document-action" aria-label="按句配音工作区"><fieldset disabled={busy} onChange={()=>setJob(undefined)}>
 <label>原片<select value={asset} onChange={e=>setAsset(e.target.value)}><option value="">从素材库选择</option>{runtime.assets.filter(a=>a.type.startsWith('video/')).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
 <label>上传原片<input type="file" accept="video/*" onChange={e=>{const f=e.target.files?.[0];if(f)void perform(async()=>{setAsset((await runtime.upload(f)).id);});}}/></label>
 <button disabled={!asset} onClick={()=>void perform(async()=>{const r=await api<{srt:string}>('/api/commerce/studio/captions',{action:'recognize',language:'auto',assetId:asset,highlight:''});setSrt(r.srt);setJob(undefined);})}>识别原片时间轴</button>
 <label>配音语言<select value={lang} onChange={e=>setLang(e.target.value)}>{Object.entries(langs).filter(([id])=>correction||id!=='zh').map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
 <label>{correction?'保留需更正的句段并修改错词':'核对目标语言台词与时间轴'}<textarea rows={6} value={srt} onChange={e=>setSrt(e.target.value)} placeholder="粘贴 SRT，或识别原片后编辑"/></label>
 {!correction&&<button disabled={!srt.trim()} onClick={()=>void perform(async()=>{const v=renderSrt(parseSubtitles(srt));if(v.length>14000)throw Error('单次翻译最多 14000 个字符');onTranslate('请翻译为'+langs[lang]+'，每段仅保留译文。\n\n原始 SRT\n'+v);})}>将时间轴送入翻译对话</button>}
 {skill!=='video-dub'&&<label><input type="checkbox" checked={rights} onChange={e=>setRights(e.target.checked)}/>我已取得原片说话人的声音使用授权</label>}
 <button disabled={!asset||!srt.trim()||(skill!=='video-dub'&&!rights)} onClick={()=>void act('quote')}>获取配音报价</button></fieldset>
 {job&&<div><p>{statuses[job.status]||job.status} · {job.progress}/{job.count} 句</p>{job.status==='quoted'?<button disabled={busy} onClick={()=>void act('confirm',job.id)}>确认配音并支付 ¥{job.price.toFixed(2)}</button>:!['done','unknown','failed'].includes(job.status)&&<button disabled={busy} onClick={()=>void act('refresh',job.id)}>继续核对原单</button>}
 {job.error&&<p role="status">{job.error}</p>}{job.video&&<><video controls preload="metadata" src={job.video.url} style={{maxHeight:260,maxWidth:'100%'}}/><a href={job.video.url+'?download=1'} download={job.video.name}>下载配音 MP4</a></>}{job.subtitles&&<a href={job.subtitles.url+'?download=1'} download={job.subtitles.name}>下载配音 SRT</a>}</div>}
 {error&&<p role="alert">{error}</p>}{history.length>0&&<details><summary>配音任务记录</summary>{history.map(j=><button key={j.id} disabled={busy} onClick={()=>{setJob(j);setError('');}}>{j.id.slice(0,8)} · {statuses[j.status]}</button>)}</details>}</section>;
}
