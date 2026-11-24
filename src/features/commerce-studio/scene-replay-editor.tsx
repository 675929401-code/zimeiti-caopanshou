'use client';
import {useEffect,useState} from 'react';
import type {SceneReplay} from '@/commerce/server/scene-prompt-replays';
type Props={sceneId:string;canEdit:boolean;token:string};
export function SceneReplayEditor({sceneId,canEdit,token}:Props){
 const [open,show]=useState(false),[records,setRecords]=useState<SceneReplay[]>([]),[revision,refresh]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [source,setSource]=useState<SceneReplay['kind']>('对标会员实测'),[input,setInput]=useState(''),[output,setOutput]=useState(''),[finding,setFinding]=useState('');
 useEffect(()=>{if(!open)return;const abort=new AbortController();
  fetch('/api/admin/commerce/prompts?kind=scene-evidence&sceneId='+encodeURIComponent(sceneId),{cache:'no-store',signal:abort.signal,headers:{Authorization:'Bearer '+token}})
   .then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error||'读取实测失败');return data;})
   .then(v=>{if(!abort.signal.aborted){setRecords(v.records);setError('');}}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return ()=>abort.abort();
 },[open,sceneId,revision,token]);
 async function save(){if(busy)return;setBusy(true);setError('');
  try{const r=await fetch('/api/admin/commerce/prompts',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({kind:'scene-evidence',sceneId,source,input,output,finding})});
   const data=await r.json();if(!r.ok)throw Error(data.error||'登记失败');setInput('');setOutput('');setFinding('');refresh(n=>n+1);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <details onToggle={e=>show(e.currentTarget.open)}><summary>登记与查看后续实测</summary>{error&&<p role="alert">{error}</p>}
 {records.map(r=><details key={r.id}><summary>{r.kind} · {new Date(r.createdAt).toLocaleString('zh-CN')}</summary><p>{r.input}</p><p>{r.finding}</p><pre>{r.output}</pre></details>)}
 {canEdit&&<form onSubmit={e=>{e.preventDefault();void save();}}><label>样本来源 <select value={source} onChange={e=>setSource(e.target.value as SceneReplay['kind'])}><option>对标会员实测</option><option>本站实测</option></select></label>
 <label>素材、参数和要求<textarea aria-label="实测输入" rows={2} maxLength={2400} value={input} onChange={e=>setInput(e.target.value)}/></label>
 <label>实际返回内容<textarea aria-label="实测输出" rows={4} maxLength={20000} value={output} onChange={e=>setOutput(e.target.value)}/></label>
 <label>核对结果<textarea aria-label="实测核对结果" rows={2} maxLength={2000} value={finding} onChange={e=>setFinding(e.target.value)}/></label>
 <button disabled={busy||!input.trim()||!output.trim()||!finding.trim()}>保存实测记录</button></form>}</details>;
}