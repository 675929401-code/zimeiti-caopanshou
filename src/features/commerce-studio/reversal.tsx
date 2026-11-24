'use client';
import {workspaceInputs} from '@/commerce/shared/transient-workspace';
import {useEffect,useRef,useState} from 'react';
import type {CanvasDocument,CanvasNode} from '@/commerce/shared/canvas-schema';
import type {DirectorScene} from '@/commerce/shared/director-scenarios';
import {api} from '@/commerce/components/commerce-agent/runtime-ui';
import {storyboards} from './scene-storyboards';
import {shotText,storyboardShots} from './storyboard-plan';
import {videoPath} from './routes';

type Draft={facts:string[];duration:number;id:string;revision:number};
const newDraft=():Draft=>({facts:['','','',''],duration:15,id:crypto.randomUUID(),revision:0});
function loadDraft(key:string):Draft{
 const empty=newDraft();
 try{
  const raw=JSON.parse(workspaceInputs.get(key)||'null');
  const facts=Array.isArray(raw)?raw:raw?.facts;
  if(!Array.isArray(facts)||facts.length!==4||!facts.every(v=>typeof v==='string'&&v.length<=2000))return empty;
  return {...empty,facts,duration:[8,15,25,30,60].includes(raw.duration)?raw.duration:15,
   ...(raw.id&&/^[a-f0-9-]{36}$/i.test(raw.id)&&Number.isInteger(raw.revision)&&raw.revision>=0?{id:raw.id,revision:raw.revision}:{})};
 }catch{return empty;}
}
export function SceneStoryboard({scene,ownerKey,go,useScript,recovery,ready}:{scene:DirectorScene;ownerKey:string;recovery:React.ReactNode;ready:boolean;go:(path:string)=>void;useScript:(script:string,seconds:number)=>void}){
 const {name,fields}=storyboards[scene],storageKey=ownerKey+':storyboard:'+scene;
 const [draft,setDraft]=useState(()=>loadDraft(storageKey)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [saved,setSaved]=useState(false),[conflict,setConflict]=useState(false),pending=useRef(false);
 const shots=storyboardShots(scene,draft.facts,draft.duration),missing=shots.filter(s=>!s.fact);
 useEffect(()=>{try{workspaceInputs.set(storageKey,JSON.stringify(draft));}catch{setError('浏览器草稿保存失败，请保存到画布。');}},[draft,storageKey]);
 function update(diff:Partial<Draft>){setDraft(v=>({...v,...diff}));setError('');setSaved(false);}
 function complete(){
  if(missing.length){setError('请补充'+missing.map(s=>s.label).join('、'));return false;}
  return true;
 }
 async function save(asCopy=false){
  if(pending.current||!complete())return;
  pending.current=true;setBusy(true);setError('');
  const id=asCopy?crypto.randomUUID():draft.id;
  try{
   const {canvas:previous,ownerId}=await api<{canvas:CanvasDocument|null;ownerId:string}>('/api/commerce/canvases?id='+encodeURIComponent(id));
   const expected=asCopy?0:draft.revision;
   const nodes:CanvasNode[]=shots.map((shot,i)=>({id:shot.id,position:{x:80+i*340,y:120},data:{kind:'text',mode:'input',label:shot.label,prompt:shotText(shot),duration:shot.end-shot.start}}));
   const unchanged=previous&&nodes.every(n=>{const old=previous.nodes.find(row=>row.id===n.id);return old?.data.prompt===n.data.prompt&&old.data.label===n.data.label&&old.data.kind==='text';});
   if(!unchanged&&(previous?.revision||0)!==expected){setConflict(true);throw Error('画布已在其他页面修改。可打开原画布核对，或将这份改稿另存。');}
   const graph=previous?{...previous,nodes:previous.nodes.map(n=>{const next=nodes.find(row=>row.id===n.id);return next?{...n,data:{...n.data,...next.data}}:n;})}:
    {nodes,edges:nodes.slice(1).map((n,i)=>({id:'cause-'+i,source:nodes[i].id,target:n.id,data:{edgeType:'derived'},label:scene==='reversal-payoff'?'情节因果':'镜头顺序'})),groups:[],viewport:{x:30,y:30,zoom:.65},title:name+' · '+shots[0].fact.slice(0,36)};
   const canvas=unchanged?previous:(await api<{canvas:CanvasDocument}>('/api/commerce/canvases',{...graph,id,ownerId,expectedRevision:expected})).canvas;
   setDraft(v=>({...v,id,revision:canvas.revision}));setSaved(true);setConflict(false);
  }catch(e){setError((e as Error).message);if((e as Error).message.includes('其他页面修改'))setConflict(true);}finally{pending.current=false;setBusy(false);}
 }
 return <div className="cs-group-grid"><section className="cs-group-editor"><header><h2>{name}</h2><button onClick={()=>go(videoPath+'?scene='+scene+'&mode=director')}>返回编导</button></header>
 <div className="cs-group-scroll">{fields.map((label,i)=><label key={label}>{label}<textarea aria-label={label} rows={3} maxLength={2000} disabled={busy} value={draft.facts[i]} onChange={e=>update({facts:draft.facts.map((v,j)=>i===j?e.target.value:v)})}/></label>)}<label>脚本时长<select value={draft.duration} disabled={busy} onChange={e=>update({duration:Number(e.target.value)})}>{[8,15,25,30,60].map(s=><option key={s} value={s}>{s} 秒</option>)}</select></label></div>
 <footer>{error&&<p role="alert">{error}</p>}{saved&&<p role="status">已保存第 {draft.revision} 版</p>}<button className="cs-primary" disabled={busy} onClick={()=>void save()}>保存分镜画布</button>{conflict&&<button disabled={busy} onClick={()=>void save(true)}>另存为新画布</button>}</footer></section>
 <section className="cs-group-preview"><h2>分镜预览</h2>{recovery}{shots.map(shot=><article key={shot.id}><h3>{shot.start}–{shot.end}秒 · {shot.label}</h3><p>{shot.fact||'待填写'}</p><small>{shot.camera}</small></article>)}<button disabled={busy||!ready} onClick={()=>{if(complete())useScript(shots.map(shotText).join('\n\n'),draft.duration);}}>应用到视频创作</button></section>
 <aside className="cs-group-recent"><h2>我的创作</h2>{draft.revision>0&&<button onClick={()=>go('/canvas?open='+draft.id)}>打开可编辑画布</button>}<button onClick={()=>go('/canvas')}>查看已存画布</button></aside></div>;
}
