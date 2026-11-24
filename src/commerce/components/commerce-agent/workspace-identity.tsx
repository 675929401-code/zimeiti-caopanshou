'use client';
import {scopeWorkspaceInputs} from '@/commerce/shared/transient-workspace';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {COMMERCE_SESSION_READY_EVENT} from '../../../app/commerce/commerce-auth-bridge';
import {readCommerceSession} from '../../../app/commerce/session-read';
import {migrateLegacyWorkspace,workspaceOwnerKey} from './workspace-storage';
export function WorkspaceIdentity({children}:{children:(ownerKey:string)=>ReactNode}){
 const [ownerKey,setOwnerKey]=useState(''),[error,setError]=useState(''),[authRequired,setAuthRequired]=useState(false),[attempt,setAttempt]=useState(0);
 const owner=useRef(''),lastToken=useRef('');
 useEffect(()=>{
  let alive=true,working=false,retry:ReturnType<typeof setTimeout>|undefined,nextCheck=0;
  async function check(){
   let token='';try{token=localStorage.getItem('auth_token')?.trim()||'';}catch{}
   if(lastToken.current!==token){owner.current='';setOwnerKey('');lastToken.current=token;nextCheck=0;setError('');}
   if(!token){scopeWorkspaceInputs('');setAuthRequired(true);return;}
   if(working||Date.now()<nextCheck)return;
   working=true;
   try{
    const result=await readCommerceSession(token);if(!alive||lastToken.current!==token)return;
    if(result.status===429){const wait=1000*(result.retryAfter||2);nextCheck=Date.now()+wait;clearTimeout(retry);retry=setTimeout(()=>void check(),wait+100);setAuthRequired(false);return;}
    if(result.status===401||result.status===403){scopeWorkspaceInputs('');owner.current='';setOwnerKey('');setError('');setAuthRequired(true);return;}
    if(result.status!==200||!result.user?.id)throw Error('无法确认当前工作室账号，请重新连接');
    const next=workspaceOwnerKey(result.user.id);if(owner.current!==next){owner.current='';setOwnerKey('');await migrateLegacyWorkspace(next,result.workspaceStorage?.legacyOwner===true);if(!alive||lastToken.current!==token)return;scopeWorkspaceInputs(next);owner.current=next;setOwnerKey(next);}
    nextCheck=Date.now()+2000;setAuthRequired(false);setError('');
   }catch(e){if(alive)setError((e as Error).message);}finally{working=false;}
  }
  const visible=()=>{if(document.visibilityState!=='hidden')void check();};void check();const timer=setInterval(visible,30000);
  window.addEventListener('storage',visible);window.addEventListener('focus',visible);window.addEventListener(COMMERCE_SESSION_READY_EVENT,visible);document.addEventListener('visibilitychange',visible);
  return()=>{alive=false;clearTimeout(retry);clearInterval(timer);window.removeEventListener('storage',visible);window.removeEventListener('focus',visible);window.removeEventListener(COMMERCE_SESSION_READY_EVENT,visible);document.removeEventListener('visibilitychange',visible);};
 },[attempt]);
 if(!ownerKey)return <div className="commerce-root"><div className="ca-empty" role={error?'alert':'status'}>{authRequired?<><p>请先登录主站账号，再进入带货 Agent 创作工作台。</p><a href="/login?redirect=%2Fcommerce">登录主站</a></>:error?<><p>{error}</p><button onClick={()=>setAttempt(n=>n+1)}>重新连接工作室</button></>:<p>正在读取工作室…</p>}</div></div>;
 return <>{error&&<div className="ca-notice" role="alert"><span>工作室连接暂时中断，当前编辑仍保留。</span><button onClick={()=>setAttempt(n=>n+1)}>重新连接</button></div>}{children(ownerKey)}</>;
}
