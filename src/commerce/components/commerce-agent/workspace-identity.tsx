'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {COMMERCE_SESSION_READY_EVENT} from '../../../app/commerce/commerce-auth-bridge';
import {migrateLegacyWorkspace,workspaceOwnerKey} from './workspace-storage';
type Session={user:{id:string};workspaceStorage?:{legacyOwner:boolean}};
export function WorkspaceIdentity({children}:{children:(ownerKey:string)=>ReactNode}){
 const [ownerKey,setOwnerKey]=useState(''),[error,setError]=useState(''),[authRequired,setAuthRequired]=useState(false),[attempt,setAttempt]=useState(0);
 const owner=useRef('');
 useEffect(()=>{let alive=true,working=false;async function check(){if(working)return;working=true;try{
  let mainToken='';try{mainToken=localStorage.getItem('auth_token')?.trim()||'';}catch{}
  if(!mainToken){if(alive){owner.current='';setOwnerKey('');setError('');setAuthRequired(true);}return;}
  const response=await fetch('/api/commerce/session',{cache:'no-store',headers:{Authorization:`Bearer ${mainToken}`}});const result=await response.json() as Session;
  if(!response.ok||!result.user?.id){if([401,403].includes(response.status)){if(alive){owner.current='';setOwnerKey('');setError('');setAuthRequired(true);}return;}throw Error('无法确认当前工作室账号，请重新连接');}
  if(!alive)return;const next=workspaceOwnerKey(result.user.id);
  if(owner.current!==next){owner.current='';setOwnerKey('');await migrateLegacyWorkspace(next,result.workspaceStorage?.legacyOwner===true);if(!alive)return;owner.current=next;setOwnerKey(next);}
  setAuthRequired(false);setError('');
 }catch(e){if(alive)setError((e as Error).message);}finally{working=false;}}
 void check();const timer=setInterval(()=>void check(),10000),focus=()=>void check();window.addEventListener('focus',focus);window.addEventListener(COMMERCE_SESSION_READY_EVENT,focus);document.addEventListener('visibilitychange',focus);
 return()=>{alive=false;clearInterval(timer);window.removeEventListener('focus',focus);window.removeEventListener(COMMERCE_SESSION_READY_EVENT,focus);document.removeEventListener('visibilitychange',focus);};},[attempt]);
 if(!ownerKey)return <div className="commerce-root"><div className="ca-empty" role={error?'alert':'status'}>{authRequired?<><p>请先登录主站账号，再进入带货 Agent 创作工作台。</p><a href="/login?redirect=%2Fcommerce">登录主站</a></>:error?<><p>{error}</p><button onClick={()=>setAttempt(n=>n+1)}>重新连接工作室</button></>:<p>正在读取工作室…</p>}</div></div>;
 return <>{error&&<div className="ca-notice" role="alert"><span>工作室连接暂时中断，当前编辑仍保留。</span><button onClick={()=>setAttempt(n=>n+1)}>重新连接</button></div>}{children(ownerKey)}</>;
}
