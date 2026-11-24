'use client';
import {useEffect,useRef,useState} from 'react';
import type {UIAsset} from '@/commerce/components/commerce-agent/runtime-ui';

type Item={key:string;name:string;description:string;image?:string};
function Directory({title,items,action,actionName,apply,applyName,children}:{title:string;items:Item[];action:()=>void;actionName:string;apply:(key:string)=>void;applyName:string;children?:React.ReactNode}){
 const [selected,setSelected]=useState('');const item=items.find(v=>v.key===selected);
 const last=useRef<HTMLButtonElement|null>(null),close=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(item)close.current?.focus();},[item?.key]);
 const dismiss=()=>{setSelected('');requestAnimationFrame(()=>last.current?.focus());};
 return <section className="cs-directory cs-record-directory"><header><h1>{title}</h1><button onClick={action}>{actionName}</button></header>
 <div className="cs-directory-content"><div className="cs-directory-items">{items.map(item=><button key={item.key} onClick={e=>{last.current=e.currentTarget;setSelected(item.key);}} aria-expanded={item.key===selected}>{item.image&&<img src={item.image} alt=""/>}<strong>{item.name}</strong>{item.description&&<small>{item.description}</small>}</button>)}{children}</div>
 {item&&<aside className={'cs-directory-drawer '+(item.image?'cs-role-drawer':'')} aria-label={item.name+'详情'} onKeyDown={e=>{if(e.key==='Escape')dismiss();}}><header><h2>{item.name}</h2><button ref={close} aria-label="关闭详情" onClick={dismiss}>×</button></header>{item.image&&<img src={item.image} alt={item.name}/>}<p>{item.description}</p><button onClick={()=>apply(item.key)}>{applyName}</button></aside>}</div></section>;
}
export function RoleDirectory({manage,apply}:{manage:()=>void;apply:(v:UIAsset)=>void}){
 const [assets,setAssets]=useState<UIAsset[]>([]),[error,setError]=useState(''),[page,setPage]=useState(0),[next,setNext]=useState<number|null>(null),[attempt,setAttempt]=useState(0),[pending,setPending]=useState(true);
 useEffect(()=>{const controller=new AbortController();setPending(true);setError('');fetch('/api/commerce/asset-library?collection=roles&kinds=image&offset='+page,{cache:'no-store',signal:controller.signal}).then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error||'角色读取失败');if(!controller.signal.aborted){setAssets(v=>page?[...v,...data.assets.filter((a:UIAsset)=>!v.some(b=>b.id===a.id))]:data.assets);setNext(data.nextOffset??null);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setPending(false);});return()=>controller.abort();},[page,attempt]);
 return <Directory title="AI 角色" items={assets.map(a=>({key:a.id,name:a.name,image:a.url,description:'角色参考图 · '+Math.ceil(a.size/1024)+' KB'}))} action={manage} actionName="选择或管理角色" applyName="带入创作" apply={key=>{const asset=assets.find(a=>a.id===key);if(asset)apply(asset);}}>
 {pending&&<p role="status">读取角色中…</p>}{error&&<p role="alert">{error} <button onClick={()=>setAttempt(v=>v+1)}>重试</button></p>}{!pending&&!error&&!assets.length&&<p>还没有角色，选择或上传人物参考图后即可复用。</p>}{next!==null&&!pending&&<button onClick={()=>setPage(next)}>加载更多角色</button>}</Directory>;
}
