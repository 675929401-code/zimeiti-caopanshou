'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '@/commerce/components/commerce-agent/runtime-ui';
import {SocialDownloads,SocialCandidates} from './social-video-details';
import type {SocialVideoResult} from '@/commerce/shared/social-video';

const endpoint='/api/commerce/studio/social-video';
const captions:Record<string,string>={quoted:'待确认',charging:'核对扣款',dispatching:'正在提交',polling:'正在解析',unknown:'原单待核对',saving:'正在保存原片',settling:'正在结算',done:'已完成',refunding:'正在退款',failed:'未交付'};
export function SocialVideoAction({skill}:{skill:string}){
 const [source,setSource]=useState(''),[job,setJob]=useState<SocialVideoResult>(),[history,setHistory]=useState<SocialVideoResult[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const lock=useRef(false),alive=useRef(true);
 const reload=useCallback(async()=>{const r=await api<{jobs:SocialVideoResult[]}>(endpoint);if(alive.current)setHistory(r.jobs.filter(j=>skill==='multi-download'||j.platform!=='xiaohongshu'));},[skill]);
 useEffect(()=>{alive.current=true;void reload().catch(()=>{});return()=>{alive.current=false;};},[reload]);
 const act=useCallback(async(action:'quote'|'confirm'|'refresh',id?:string)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{const r=await api<{job:SocialVideoResult}>(endpoint,action==='quote'?{action,source,skill}:{action,id});if(alive.current){setJob(r.job);if(r.job.status!=='quoted')await reload();}}
  catch(e){if(alive.current)setError((e as Error).message);}finally{lock.current=false;if(alive.current)setBusy(false);}
 },[source,reload,skill]);
 useEffect(()=>{if(!job||busy||error||!['polling','saving','settling','refunding'].includes(job.status))return;const t=setTimeout(()=>void act('refresh',job.id),3500);return()=>clearTimeout(t);},[job,busy,error,act]);
 return <section className="cs-document-action" aria-label="作品解析工作区"><label>{skill==='multi-download'?'抖音作品、小红书笔记或原视频链接':'抖音作品链接或作品号'}<input value={source} disabled={busy} onChange={e=>{setSource(e.target.value);setJob(undefined);}} placeholder="粘贴你有权使用的作品链接"/></label>
 {skill==='douyin-collect'&&<SocialCandidates history={history} choose={id=>{setSource(id);setJob(undefined);setError('');}}/>}
 <button disabled={busy||!source.trim()} onClick={()=>void act('quote')}>获取解析报价</button>
 {job&&<div><p>{captions[job.status]||job.status} · {job.mediaLink?'小红书媒体文件':(job.platform==='xiaohongshu'?'小红书笔记 ':'作品 ')+job.workId}</p>
 {job.status==='quoted'&&<button disabled={busy} onClick={()=>void act('confirm',job.id)}>{job.price===0?'免费解析原片':'确认解析并支付 ¥'+job.price.toFixed(2)}</button>}
 {job.status!=='quoted'&&!['done','failed','unknown'].includes(job.status)&&<button disabled={busy} onClick={()=>void act('refresh',job.id)}>刷新原单</button>}
 {job.error&&<p role="status">{job.error}</p>}
 {job.asset&&<><video controls preload="metadata" src={job.asset.url} style={{maxWidth:'100%',maxHeight:260}}/><p>{job.title}</p><a href={job.asset.url+'?download=1'} download={job.asset.name}>下载原片 MP4</a>
 {skill==='douyin-download'&&<SocialDownloads key={job.id} job={job}/>}
 {typeof job.likes==='number'&&<p>采集时点赞数 {job.likes}</p>}{job.caption&&<details open={skill==='douyin-collect'}><summary>口播文案</summary><p>{job.caption}</p></details>}</>}</div>}
 {error&&<p role="alert">{error}</p>}{history.length>0&&<details><summary>作品解析记录</summary>{history.map(h=><button key={h.id} disabled={busy} onClick={()=>{setError('');setJob(h);}}>{h.title||h.workId} · {captions[h.status]}</button>)}</details>}</section>;
}
