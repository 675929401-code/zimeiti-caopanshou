'use client';
import {useRef,useState} from 'react';

export type SavedCanary={
 id:string;releaseId:string;releaseVersion:number;scene:string;fingerprint:string;original:string;
 references:{id:string;slot:string}[];model:string;promptVersion:number;instructions:string;output:string;
 status:string;error?:string;assets:string[];quote:string;billingStatus?:string;billingId?:string;
};
export function SavedRunComparison({load,releaseId,candidates}:{candidates:string[];load:(id:string)=>Promise<SavedCanary>;releaseId?:string}){
 const [ids,setIds]=useState(['','']),[records,setRecords]=useState<SavedCanary[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const epoch=useRef(0);
 function edit(index:number,value:string){epoch.current++;setIds(ids.map((s,i)=>i===index?value:s));setRecords([]);setError('');setBusy(false);}
 async function compare(){
  const sequence=++epoch.current;setBusy(true);setError('');setRecords([]);
  try{
   const [a,b]=await Promise.all(ids.map(s=>load(s.trim())));
   if(epoch.current!==sequence)return;
   if(a.releaseId!==releaseId)throw Error('左侧任务的发布版本与当前生效版本不一致');
   if(a.releaseId===b.releaseId||!candidates.includes(b.releaseId))throw Error('请选用待发布候选配置版本的验收任务');
   if(a.scene!==b.scene||a.fingerprint!==b.fingerprint)throw Error('两次任务的场景、原始输入、参数或引用不同，请选择同一样本');
   setRecords([a,b]);
  }catch(e){if(epoch.current===sequence)setError((e as Error).message);}
  finally{if(epoch.current===sequence)setBusy(false);}
 }
 return <section className="cs-admin-replay" aria-label="对照已有编导运行"><h3>对照已有编导运行</h3><div className="cs-replay-select">
 {['已发布版本任务 ID','候选版本任务 ID'].map((label,i)=><label key={label}>{label}<input value={ids[i]} placeholder="粘贴卡片验收任务 ID" onChange={e=>edit(i,e.target.value)}/></label>)}
 <button disabled={busy||!releaseId||ids.some(s=>!s.trim())} onClick={()=>void compare()}>{busy?'读取中…':'读取两次记录'}</button></div>
 {error&&<p role="alert">{error}</p>}
 {records.length>0&&<div className="cs-replay-columns">{records.map((r,i)=><article key={r.id}><h4>{i?'候选':'已发布'} · v{r.releaseVersion} · {r.scene}</h4><p>{r.original}</p><small>{r.references.map(ref=>ref.slot+' · '+ref.id).join(' / ')}</small>
 <h4>编导输出</h4><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{r.output||r.error||'尚无输出'}</pre>
 <details><summary>当次指令与引用版本</summary><p>提示词 v{r.promptVersion} · {r.model}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{r.instructions}</pre></details>
 <footer>任务 {r.id} · {r.status}<br/>报价 {r.quote} · {r.billingStatus||'暂无结算回执'} {r.billingId||''}</footer>{r.assets.map(id=><p key={id}>产物 {id}</p>)}</article>)}</div>}</section>;
}
