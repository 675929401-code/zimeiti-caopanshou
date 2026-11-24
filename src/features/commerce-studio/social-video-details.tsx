'use client';
import {useState} from 'react';
import {api} from '@/commerce/components/commerce-agent/runtime-ui';
import type {SocialVideoResult} from '@/commerce/shared/social-video';

type FileAsset={name:string;url:string};
export function SocialDownloads({job}:{job:SocialVideoResult}){
 const [cover,setCover]=useState<FileAsset>(),[audio,setAudio]=useState<FileAsset>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function prepare(kind:'cover'|'audio'){
  if(busy||!job.asset)return;setBusy(true);setError('');
  try{
   if(kind==='cover'){const response=await api<{asset:FileAsset}>('/api/commerce/studio/social-video',{action:'cover',id:job.id});setCover(response.asset);}
   else{const response=await api<{audio:FileAsset}>('/api/commerce/studio/separate-audio',{assetId:job.asset.id});setAudio(response.audio);}
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div>{cover?<a href={cover.url+'?download=1'} download={cover.name}>下载作品封面</a>:<button disabled={busy} onClick={()=>void prepare('cover')}>提取作品封面</button>}
 {' · '}{audio?<a href={audio.url+'?download=1'} download={audio.name}>下载原声音轨</a>:<button disabled={busy} onClick={()=>void prepare('audio')}>提取原声音轨</button>}
 {error&&<p role="alert">{error}</p>}</div>;
}

type Candidate={workId:string;title:string;likes:number};
function parseCandidates(value:string){
 const rows:Candidate[]=[];
 for(const [index,line] of value.split(/\r?\n/).entries()){
  if(!line.trim())continue;
  const [source,count,...title]=line.trim().split(/[\t，,]/);
  const input=source.trim(),match=input.match(/^https:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/(\d{15,22})(?:[/?#].*)?$/);
  const workId=match?.[1]||input,likes=Number(count?.trim());
  if(!/^\d{15,22}$/.test(workId)||!/^\d+$/.test(count?.trim()||'')||!Number.isSafeInteger(likes))throw Error('第 '+(index+1)+' 行需要作品号和非负整数点赞数');
  rows.push({workId,likes,title:title.join('，').trim()||workId});
 }
 return rows;
}
export function SocialCandidates({history,choose}:{history:SocialVideoResult[];choose:(source:string)=>void}){
 const [pasted,setPasted]=useState(''),[minimum,setMinimum]=useState('0'),[result,setResult]=useState<Candidate[]>(),[error,setError]=useState('');
 function filter(){
  try{
   if(!/^\d+$/.test(minimum)||!Number.isSafeInteger(Number(minimum)))throw Error('请输入有效的最低点赞数');
   const saved=history.flatMap(j=>j.status==='done'&&typeof j.likes==='number'?[{workId:j.workId,title:j.title||j.workId,likes:j.likes}]:[]).reverse();
   const combined=[...saved,...parseCandidates(pasted)],unique=new Map(combined.map(r=>[r.workId,r]));
   setResult([...unique.values()].filter(r=>r.likes>=Number(minimum)).sort((a,b)=>b.likes-a.likes));setError('');
  }catch(e){setResult(undefined);setError((e as Error).message);}
 }
 return <details><summary>筛选已有候选作品</summary>
 <label>候选列表<textarea maxLength={80000} value={pasted} onChange={e=>{setPasted(e.target.value);setResult(undefined);}} placeholder="每行填写作品号、点赞数和可选标题，用逗号或制表符分隔。留空时筛选已采集作品。"/></label>
 <label>最低点赞数<input type="number" min="0" step="1" value={minimum} onChange={e=>{setMinimum(e.target.value);setResult(undefined);}}/></label>
 <button onClick={filter}>筛选候选作品</button>{error&&<p role="alert">{error}</p>}
 {result&&<div aria-live="polite"><p>符合条件 {result.length} 项</p>{result.map(r=><button key={r.workId} onClick={()=>choose(r.workId)}>{r.title} · {r.likes} 赞</button>)}</div>}</details>;
}

