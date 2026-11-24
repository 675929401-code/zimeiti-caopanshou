'use client';
import {useEffect,useState,type ReactNode} from 'react';
import type {Runtime,UIAsset} from '@/commerce/components/commerce-agent/runtime-ui';
import {groupBuyScene} from './group-buy';
const tabs=[['materials','素材'],['works','作品'],['recent','最近'],['favorites','收藏']] as const;
export function StudioLibrary({view,runtime,favorites,materials,discovery,go,useAsset:onUseAsset}:{view:string;runtime:Runtime;favorites:string[];materials:ReactNode;discovery:ReactNode;go:(path:string)=>void;useAsset:(asset:UIAsset)=>void}){
 const active=tabs.some(t=>t[0]===view)?view:'materials';
 const [projects,setProjects]=useState<{id:string;title:string;revision:number}[]>([]),[issue,setIssue]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{if(active!=='recent')return;const ac=new AbortController();setIssue('');void fetch('/api/commerce/studio/projects',{signal:ac.signal,cache:'no-store'}).then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error||'读取失败');setProjects(data.projects);}).catch(e=>{if(!ac.signal.aborted)setIssue(e.message);});return()=>ac.abort();},[active,attempt]);
 const works=runtime.assets.filter(a=>a.source==='generated'&&(active!=='favorites'||favorites.includes('job:'+a.jobId)));
 if(view==='materials'||view==='roles')return <>{materials}</>;
 return <section className="cs-library"><header><h1>资产库</h1><nav aria-label="资产分类">{tabs.map(([key,label])=><button key={key} aria-current={active===key?'page':undefined} onClick={()=>go('/assets?tab='+key)}>{label}</button>)}</nav></header>
 {active==='materials'?materials:active==='recent'?<div className="cs-library-grid">{issue&&<p role="alert">{issue} <button onClick={()=>setAttempt(n=>n+1)}>重试</button></p>}{!issue&&!projects.length&&<p>暂无团购项目</p>}{projects.map(p=><button key={p.id} onClick={()=>go('/toolbox/video-generation?scene='+groupBuyScene+'&projectId='+p.id)}>{p.title}<small>同城团购 · v{p.revision}</small></button>)}<button onClick={()=>go('/canvas')}>查看画布项目</button></div>:
 <><div className="cs-library-grid">{!works.length&&<p>{active==='works'?'暂无生成作品':'暂无收藏的生成作品'}</p>}{works.map(a=><article key={a.id}>{a.type.startsWith('image/')?<img src={a.url} alt={a.name}/>:a.type.startsWith('video/')?<video src={a.url} controls preload="metadata"/>:<audio src={a.url} controls/>}<b>{a.name}</b><a href={a.url+'?download=1'}>保存作品</a><button onClick={()=>onUseAsset(a)}>继续创作</button></article>)}</div>{active==='favorites'&&discovery}</>}
 </section>;
}
