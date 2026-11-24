'use client';
/* 左栏账户与「更多」菜单（2026-11-16，作者：网站开发）。
 * 头像只读主站现有 /api/auth/me 的真实资料；未登录时显示现有登录入口，不伪造头像或登录状态。 */
import {useEffect, useRef, useState} from 'react';
import {readPaymentWallet,subscribePaymentWallet} from '@/lib/payment-wallet-client';
import {BookOpen, ChevronRight, FileText, LayoutGrid, LogOut, Moon, MoreHorizontal, Palette, ShieldCheck, Sun, UserRound} from 'lucide-react';
import {STORAGE_KEYS} from '@/lib/storage-keys';
import {AnchoredPanel} from './reference-ui';

type AccountUser = {id?:string; role?: string; displayName?: string; username?: string; avatarUrl?: string};
export type RailAccountState = {status: 'loading' | 'ready' | 'anonymous'; user: AccountUser | null};

export function useRailAccount(): RailAccountState {
  const [account, setAccount] = useState<RailAccountState>({status: 'loading', user: null});
  useEffect(() => {
    let alive = true;let retry:ReturnType<typeof setTimeout>|undefined;
    const load = async () => {
      let token = '';
      try { token = localStorage.getItem('auth_token')?.trim() || ''; } catch { /* 读不到即按未登录处理 */ }
      if (!token) { if (alive) setAccount({status: 'anonymous', user: null}); return; }
      try {
        const response = await fetch('/api/auth/me', {cache: 'no-store', headers: {Authorization: `Bearer ${token}`}});
        if (!alive) return;
        if (response.status === 401 || response.status === 403) { setAccount({status: 'anonymous', user: null}); return; }
        if (!response.ok) {
          if(response.status===429||response.status>=500){const info=await response.json().catch(()=>({}));const seconds=Number(response.headers.get('retry-after')||info.retryAfter||3);if(alive)retry=setTimeout(()=>void load(),1000*Math.max(1,Number.isFinite(seconds)?seconds:3)+100);}
          return;
        }
        const body = await response.json() as {user?: AccountUser};
        if (alive && body.user) setAccount({status: 'ready', user: body.user});
      } catch { /* 网络失败保持中性占位，不显示假头像 */ }
    };
    void load();
    return () => { alive = false;clearTimeout(retry); };
  }, []);
  return account;
}

export function useMemberCashBalance(account:RailAccountState){
  const [wallet,setWallet]=useState<{userId:string;cashBalance:number}|null>(null);
  const id=account.status==='ready'?account.user?.id:undefined;
  useEffect(()=>{
    if(!id)return;
    let alive=true;
    const refresh=async()=>{
      const token=localStorage.getItem('auth_token');
      if(!token)return;
      const value=await readPaymentWallet(token);
      if(alive&&value?.userId===id)setWallet(value);
    };
    void refresh();
    const off=subscribePaymentWallet(changed=>{if(changed===id)void refresh();});
    window.addEventListener('focus',refresh);
    return ()=>{alive=false;off();window.removeEventListener('focus',refresh);};
  },[id]);
  if(!wallet||wallet.userId!==id)return null;
  return '¥'+wallet.cashBalance.toFixed(2);
}

export function HomeWallet({amount}:{amount:string|null}){
  const [open,setOpen]=useState(false);
  if(!amount)return null;
  return <div className="cs-home-wallet">
    <button type="button" aria-label={'钱包余额 '+amount} aria-expanded={open} data-popover-trigger onClick={()=>setOpen(!open)}><span aria-hidden="true">✦</span> {amount}</button>
    {open&&<AnchoredPanel className="cs-home-wallet-menu" label="钱包操作" onClose={()=>setOpen(false)}>
      <a href="/commerce/account?tab=records"><FileText size={16}/>收支记录</a>
    </AnchoredPanel>}
  </div>;
}

export function RailWallet({amount}:{amount:string|null}){
  if(!amount)return null;
  return <div className="cs-rail-wallet"><span aria-label={'现金余额 '+amount} title={'现金余额 '+amount}>{amount}</span></div>;
}

function policyLink(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, window.location.origin);
    return url.protocol === 'https:' || url.origin === window.location.origin ? url.href : undefined;
  } catch { return undefined; }
}

export function RailAvatar({account, amount}: {account: RailAccountState; amount:string|null}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [dark, setDark] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [failure, setFailure] = useState('');
  const memberKey = account.user?.id ? 'commerce:appearance:'+account.user.id : '';
  useEffect(()=>{
    if (!memberKey) return;
    let saved=false;
    try { saved=localStorage.getItem(memberKey)==='dark'; } catch {}
    setDark(saved);
    document.body.dataset.commerceAppearance=saved?'dark':'light';
    return ()=>{delete document.body.dataset.commerceAppearance;};
  },[memberKey]);
  function changeAppearance() {
    const next = !dark;
    document.body.dataset.commerceAppearance=next?'dark':'light';
    setDark(next);
    try { if(memberKey)localStorage.setItem(memberKey,next?'dark':'light'); } catch {}
  }
  async function signOut() {
    if(exiting)return;
    setExiting(true);setFailure('');
    try {
      const token=localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      const response=await fetch('/api/auth/logout',{method:'POST',headers:token?{Authorization:'Bearer '+token}:undefined});
      if(!response.ok)throw Error('服务器暂未确认退出，请重试。');
      if(localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN)===token){
        localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);localStorage.removeItem(STORAGE_KEYS.AUTH_USER);
      }
      window.location.assign('/login?redirect=%2Fcommerce');
    } catch(e){setFailure(e instanceof Error?e.message:'退出失败，请重试。');setExiting(false);}
  }
  useEffect(() => {
    const close = (event: PointerEvent) => {if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open=false;};
    const escape = (event: KeyboardEvent) => {if(event.key==='Escape' && menu.current?.open){menu.current.open=false;menu.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return ()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[]);
  if (account.status !== 'ready' || !account.user) return <div className="ca-rail-avatar ca-rail-avatar-empty" aria-hidden="true" />;
  const name = account.user.displayName || account.user.username || '我的账号';
  return <details className="cc-account" ref={menu}><summary className="ca-rail-avatar" role="button" title="账户菜单" aria-label="账户菜单">
    {account.user.avatarUrl ? <img src={account.user.avatarUrl} alt="" /> : <span>{Array.from(name)[0]}</span>}
  </summary><nav className="cs-member-account-menu" aria-label="账户操作">
    <a className="cs-account-identity" href="/commerce/account">{account.user.avatarUrl?<img alt="" src={account.user.avatarUrl}/>:<UserRound size={20}/>}<span><strong>{name}</strong><small>✦ {amount??'—'}</small></span><ChevronRight size={14}/></a>
    <hr/>
    <a href="/commerce/account"><UserRound size={16}/>个人信息</a>
    <label className="cs-account-appearance"><Palette size={16}/>外观切换<button type="button" className="cs-account-theme" role="switch" aria-checked={dark} aria-label="深色模式" onClick={changeAppearance}><Sun size={13}/><Moon size={13}/></button></label>
    <hr/>
    {([[ '服务协议',policyLink(process.env.NEXT_PUBLIC_COMMERCE_TERMS_URL),FileText ],[ '隐私协议',policyLink(process.env.NEXT_PUBLIC_COMMERCE_PRIVACY_URL),ShieldCheck ]] as const).map(([label,href,Icon])=>href
      ?<a key={label} href={href} target="_blank" rel="noopener noreferrer"><Icon size={16}/>{label}</a>
      :<span className="cs-account-policy" key={label} aria-disabled="true"><Icon size={16}/>{label}<small>待发布</small></span>)}
    <button type="button" disabled={exiting} onClick={()=>void signOut()}><LogOut size={16}/>{exiting?'正在退出…':'退出登录'}</button>
    {failure&&<p role="alert">{failure}</p>}
  </nav></details>;
}

export function RailLogin({account}: {account: RailAccountState}) {
  if (account.status !== 'anonymous') return null;
  return <a className="ca-rail-login" href="/login?redirect=%2Fcommerce">登录</a>;
}

export function RailMore({openSkills,openSceneSkills,toggleScenes}: {openSkills: () => void;openSceneSkills:()=>void;toggleScenes?:()=>void}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="ca-rail-more" ref={root}>
    <button type="button" className="ca-rail-more-toggle" title="更多" aria-label="更多" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><MoreHorizontal size={20} /></button>
    {open && <div className="ca-rail-more-menu" role="menu" aria-label="更多">
      {toggleScenes&&<button type="button" role="menuitem" onClick={()=>{setOpen(false);toggleScenes();}}><LayoutGrid size={16}/><span>展开或收起场景栏</span></button>}
      <button type="button" role="menuitem" onClick={()=>{setOpen(false);openSceneSkills();}}><LayoutGrid size={16}/><span>创作技能</span></button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); openSkills(); }}><LayoutGrid size={16} /><span>技能广场</span></button>
      <a role="menuitem" href="/commerce/help" onClick={() => setOpen(false)}><BookOpen size={16} /><span>使用教程</span></a>
    </div>}
  </div>;
}
