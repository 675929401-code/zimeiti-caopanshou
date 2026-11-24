'use client';
import {useEffect, useState, type FormEvent} from 'react';
import {CommerceAgentAdminTab} from '@/components/admin/CommerceAgentAdminTab';

type Access = {token: string; permissions: string[]; expiresAt: string | null};
const required = ['agents.view', 'prompts.view', 'models.view'];

export function CommerceManagement() {
  const [access,setAccess]=useState<Access|null>(null), [unlock,setUnlock]=useState(false);
  const [status,setStatus]=useState('正在核对管理员权限…'), [revision,setRevision]=useState(0);
  const [password,setPassword]=useState(''), [busy,setBusy]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    let expiry:ReturnType<typeof setTimeout>|undefined;
    async function check(){
      const token=localStorage.getItem('auth_token')||'';
      if(!token){setAccess(null);setUnlock(false);setStatus('请先登录管理员账号');return;}
      try{
        const response=await fetch('/api/admin/access-control/self',{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:controller.signal});
        const body=await response.json();
        if(controller.signal.aborted)return;
        if(!response.ok || !required.every(key=>body.access?.permissionKeys?.includes(key))){setAccess(null);setUnlock(false);setStatus('此账号没有带货编导管理权限');return;}
        if(!['ready','maintenance'].includes(body.stepUp?.status)){setAccess(null);setUnlock(true);setStatus('查看编导正文需要验证管理员身份');return;}
        setUnlock(false);setAccess({token,permissions:body.access.permissionKeys,expiresAt:body.stepUp.expiresAt});
        clearTimeout(expiry);if(body.stepUp.expiresAt){const remaining=Date.parse(body.stepUp.expiresAt)-Date.now();if(Number.isFinite(remaining))expiry=setTimeout(recheck,Math.max(1,remaining));}
      }catch(e){if(!controller.signal.aborted)setStatus('权限读取失败，请重试');}
    }
    function recheck(){setAccess(null);setUnlock(false);setStatus('正在核对管理员权限…');setRevision(n=>n+1);}
    function storage(event:StorageEvent){if(!event.key || event.key==='auth_token')recheck();}
    void check();window.addEventListener('storage',storage);window.addEventListener('focus',check);
    return ()=>{controller.abort();clearTimeout(expiry);window.removeEventListener('storage',storage);window.removeEventListener('focus',check);};
  },[revision]);
  async function verify(event:FormEvent){
    event.preventDefault();if(busy)return;
    setBusy(true);
    try{
      const response=await fetch('/api/admin/access-control/unlock',{method:'POST',headers:{Authorization:'Bearer '+(localStorage.getItem('auth_token')||''),'Content-Type':'application/json'},body:JSON.stringify({password,mode:'auto'})});
      const body=await response.json();if(!response.ok)throw Error(body.error||'身份验证失败');
      setUnlock(false);setRevision(n=>n+1);
    }catch(e){setStatus((e as Error).message);}finally{setPassword('');setBusy(false);}
  }
  // 后台固定浅色主题：局部覆盖主站主题变量，避免主站暗色模式下卡片深底深字看不清。
  const adminTheme={'--background':'#ffffff','--card':'#ffffff','--border':'#e4e7ee','--foreground':'#1c2333','--muted-foreground':'#667085','--primary':'#2f6bff','--accent':'#f2f5fa'} as Record<string,string>;
  const pillLink:React.CSSProperties={display:'inline-flex',alignItems:'center',gap:6,borderRadius:999,padding:'7px 14px',fontSize:13,fontWeight:500,textDecoration:'none',boxShadow:'0 1px 2px rgba(16,24,40,.04)'};
  return <main className="commerce-root cs-management" style={{...adminTheme,minHeight:'100vh',padding:'28px clamp(16px,4vw,56px) 64px',background:'#f5f7fb',color:'#1c2333'} as React.CSSProperties}>
    <div style={{maxWidth:1240,margin:'0 auto'}}>
      <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:10}}>
        <a href="/commerce" style={{...pillLink,color:'#1c2333',background:'#fff',border:'1px solid #e4e7ee'}}>← 返回带货创作</a>
        <span style={{flex:1}}/>
        <a href="/admin?tab=workspace-models&view=overview&project=commerce" style={{...pillLink,color:'#2f6bff',background:'#eef3ff',border:'1px solid #d7e3ff'}}>模型池 · 带货 Agent 项目 →</a>
      </div>
      <header style={{marginTop:22,marginBottom:22}}>
        <h1 style={{fontSize:30,margin:0,fontWeight:700,letterSpacing:'-0.02em',color:'#1c2333'}}>带货创作管理</h1>
        <p style={{margin:'8px 0 0',color:'#667085',fontSize:14}}>卡片、提示词、模型路由与素材的统一后台；改动先存草稿，到「发布与回滚」发布后对会员生效。</p>
      </header>
      {access?<CommerceAgentAdminTab token={access.token} permissionKeys={access.permissions}/>:<section style={{background:'#fff',border:'1px solid #e4e7ee',borderRadius:16,padding:24,boxShadow:'0 1px 2px rgba(16,24,40,.05)'}}>
        <p role="status" style={{marginTop:0}}>{status}</p>
        {unlock?<form onSubmit={verify} style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:10}}><label style={{display:'flex',alignItems:'center',gap:8,fontSize:14}}>管理员验证口令 <input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required style={{border:'1px solid #e4e7ee',borderRadius:10,padding:'8px 12px',fontSize:14}}/></label> <button disabled={busy} style={{borderRadius:10,background:'#2f6bff',color:'#fff',padding:'8px 16px',fontSize:14,fontWeight:600,border:'none'}}>{busy?'正在验证…':'验证身份'}</button></form>:
        <div style={{display:'flex',gap:12,fontSize:14}}><button onClick={()=>setRevision(n=>n+1)} style={{border:'1px solid #e4e7ee',borderRadius:10,background:'#fff',padding:'8px 16px',fontSize:14,fontWeight:500}}>重新核对</button><a href="/login?redirect=%2Fcommerce%2Fmanage" style={{...pillLink,color:'#2f6bff',background:'#eef3ff',border:'1px solid #d7e3ff'}}>登录</a></div>}
      </section>}
    </div>
  </main>;
}
