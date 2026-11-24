'use client';
/* 带货创作·我的账户（2026-11-23 视觉精致化）。
 * 复用主站真实接口：/api/auth/me 资料、/api/credits 钱包、/api/user/transactions 收支；
 * 不复制主站完整设置能力，充值与高级设置跳转主站 /profile。 */
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,ArrowDownToLine,ArrowUpFromLine,FileText,UserRound,Wallet} from 'lucide-react';
import {readPaymentWallet,subscribePaymentWallet,type PaymentWallet} from '@/lib/payment-wallet-client';
import {useRailAccount} from './rail-account';
import './member-account.css';

type TxItem={
  id:string;category:'credits'|'cash'|'video'|'payment';type:string;transactionType?:string;
  amount:number;balanceAfter?:number|null;description?:string;createdAt:string;
  modelName?:string|null;prompt?:string|null;status?:string;paymentMethod?:string;
};
type TxData={transactions:TxItem[];summary:{totalCashRecharged:number;totalCashConsumed:number;cashBalance:number;totalCreditsRecharged:number;totalCreditsConsumed:number;creditBalance:number};pagination:{page:number;pageSize:number;total:number}};

function readToken(){try{return localStorage.getItem('auth_token')?.trim()||'';}catch{return '';}}
function formatTime(value:string){const date=new Date(value);if(Number.isNaN(date.getTime()))return value;return date.toLocaleString('zh-CN',{hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
function isIncome(t:TxItem){return ['recharge','topup','refund'].includes(t.type)||(t.type==='admin_adjust'&&Number(t.amount)>0)||t.category==='payment';}
function describe(t:TxItem){
  if(t.category==='video')return ['视频生成',t.modelName,t.prompt].filter(Boolean).join(' · ');
  if(t.category==='payment')return t.status==='paid'?'充值到账':'支付订单 '+(t.status||'');
  return t.description||(t.type==='refund'?'退款到账':isIncome(t)?'充值到账':t.category==='credits'?'积分消耗':'现金消耗');
}
function amountText(t:TxItem){
  const value=Math.abs(Number(t.amount));
  if(t.category==='video')return (t.status==='completed'?'−':'')+'¥'+value.toFixed(2);
  if(t.category==='payment')return '+¥'+value.toFixed(2);
  const sign=isIncome(t)?'+':'−';
  return t.category==='credits'?sign+value+' 积分':sign+'¥'+value.toFixed(2);
}
function statusChip(t:TxItem){
  if(t.type==='refund')return <i className="ca-chip ok">退款</i>;
  if(t.category==='payment'&&t.status==='paid')return <i className="ca-chip ok">已到账</i>;
  if(t.category==='video'&&t.status==='failed')return <i className="ca-chip bad">失败</i>;
  if(t.category==='video'&&t.status&&t.status!=='completed')return <i className="ca-chip run">进行中</i>;
  return null;
}
const TX_TYPE_LABEL:Record<string,string>={cash:'现金',credits:'积分',video:'视频任务',payment:'充值订单'};

export function MemberAccount(){
  const account=useRailAccount();
  const [wallet,setWallet]=useState<PaymentWallet|null>(null);
  const [tab,setTab]=useState<'overview'|'records'>('overview');
  const [txType,setTxType]=useState<'all'|'cash'|'credits'>('all');
  const [txDirection,setTxDirection]=useState<'all'|'recharge'|'consume'>('all');
  const [txData,setTxData]=useState<TxData|null>(null);
  const [txLoading,setTxLoading]=useState(false);
  const [txError,setTxError]=useState('');
  const [recent,setRecent]=useState<TxItem[]|null>(null);
  const requestSeq=useRef(0);
  const userId=account.status==='ready'?account.user?.id:undefined;

  useEffect(()=>{const params=new URLSearchParams(window.location.search);if(params.get('tab')==='records')setTab('records');},[]);

  useEffect(()=>{
    if(!userId)return;
    let alive=true;
    const refresh=async()=>{const token=readToken();if(!token)return;const value=await readPaymentWallet(token);if(alive&&value?.userId===userId)setWallet(value);};
    void refresh();
    const off=subscribePaymentWallet(changed=>{if(changed===userId)void refresh();});
    window.addEventListener('focus',refresh);
    return()=>{alive=false;off();window.removeEventListener('focus',refresh);};
  },[userId]);

  /* 概览页“最近收支”独立拉取最新 5 条，与收支记录页的筛选互不影响 */
  useEffect(()=>{
    if(!userId)return;
    let alive=true;
    void (async()=>{
      const token=readToken();if(!token)return;
      try{
        const res=await fetch('/api/user/transactions?type=all&page=1&pageSize=5&transactionType=all',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
        const body=await res.json().catch(()=>null);
        if(alive&&res.ok&&body?.success)setRecent((body.data as TxData).transactions);
      }catch{/* 概览最近收支读取失败不阻塞页面 */}
    })();
    return()=>{alive=false;};
  },[userId]);

  const loadTransactions=useCallback(async(page:number,append:boolean)=>{
    const token=readToken();if(!token)return;
    const seq=++requestSeq.current;
    setTxLoading(true);setTxError('');
    try{
      const params=new URLSearchParams({type:txType,page:String(page),pageSize:'20',transactionType:txDirection});
      const res=await fetch('/api/user/transactions?'+params,{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      const body=await res.json().catch(()=>null);
      if(seq!==requestSeq.current)return;
      if(!res.ok||!body?.success)throw new Error('load failed');
      const data=body.data as TxData;
      setTxData(current=>append&&current?{...data,transactions:[...current.transactions,...data.transactions]}:data);
    }catch{if(seq===requestSeq.current)setTxError('收支记录暂时读取失败，请稍后重试。');}
    finally{if(seq===requestSeq.current)setTxLoading(false);}
  },[txType,txDirection]);

  useEffect(()=>{if(tab==='records'&&userId){setTxData(null);void loadTransactions(1,false);}},[tab,userId,loadTransactions]);

  function switchTab(next:'overview'|'records'){
    setTab(next);
    const url=next==='records'?'/commerce/account?tab=records':'/commerce/account';
    window.history.replaceState(null,'',url);
  }

  const name=account.user?.displayName||account.user?.username||'我的账号';
  const isAdmin=account.user?.role==='admin';
  const loaded=txData?txData.transactions.length:0;
  const total=txData?txData.pagination.total:0;
  const hasMore=txData?loaded<total:false;
  const nextPage=txData?Math.floor(loaded/txData.pagination.pageSize)+1:1;

  function txRow(t:TxItem){
    return <li key={t.category+'-'+t.id}>
      <span className={'ca-account-tx-icon '+(isIncome(t)?'in':'out')}>{isIncome(t)?<ArrowDownToLine size={14}/>:<ArrowUpFromLine size={14}/>}</span>
      <span className="ca-account-tx-main"><strong>{describe(t)}{statusChip(t)}</strong><small>{formatTime(t.createdAt)}</small></span>
      <span className="ca-account-tx-side"><b className={isIncome(t)?'in':'out'}>{amountText(t)}</b><i>{TX_TYPE_LABEL[t.category]||t.category}</i></span>
    </li>;
  }

  return <main className="ca-account">
    <header className="ca-account-header">
      <a className="ca-account-back" href="/commerce"><ArrowLeft size={17}/>返回创作首页</a>
      <a href="/commerce/account" className="ca-account-brand"><Wallet size={20}/><span>带货 Agent <strong>我的账户</strong></span></a>
      <a href="/profile" className="ca-account-mainsite">主站完整设置<ArrowUpRight size={15}/></a>
    </header>

    <div className="ca-account-title">
      <div className="ca-account-title-text">
        <h1>我的账户</h1>
        <p>余额、收支与会员资料跟随主站钱包实时同步。</p>
      </div>
      <div className="ca-account-tabs" role="tablist" aria-label="账户视图">
        <button role="tab" aria-selected={tab==='overview'} className={tab==='overview'?'active':''} onClick={()=>switchTab('overview')}>概览</button>
        <button role="tab" aria-selected={tab==='records'} className={tab==='records'?'active':''} onClick={()=>switchTab('records')}>收支记录</button>
      </div>
    </div>

    {account.status==='anonymous'&&<section className="ca-account-card ca-account-anonymous">
      <UserRound size={28}/>
      <h1>登录后查看账户</h1>
      <p>余额、收支记录与会员资料跟随主站账号。</p>
      <a className="ca-account-primary" href="/login?redirect=%2Fcommerce%2Faccount">去登录</a>
    </section>}

    {account.status!=='anonymous'&&tab==='overview'&&<>
      <section className="ca-account-card ca-account-profile" aria-label="账号资料">
        {account.user?.avatarUrl?<img className="ca-account-avatar" src={account.user.avatarUrl} alt=""/>:<span className="ca-account-avatar ca-account-avatar-fallback">{Array.from(name)[0]||'我'}</span>}
        <div className="ca-account-identity">
          <h1>{name}<i className={'ca-role-badge'+(isAdmin?' admin':'')}>{isAdmin?'管理员':'会员'}</i></h1>
          <p>{account.user?.username&&account.user.username!==name?`登录名 ${account.user.username}`:'主站会员账号'}</p>
        </div>
        <a className="ca-account-quiet" href="/profile">在主站管理资料<ArrowUpRight size={14}/></a>
      </section>

      <section className="ca-account-hero" aria-label="现金余额">
        <div className="ca-account-hero-main">
          <span className="ca-account-hero-label">现金余额（元）</span>
          <strong className="ca-account-hero-amount">{wallet?'¥'+wallet.cashBalance.toFixed(2):'读取中…'}</strong>
          <p className="ca-account-hero-note">带货创作的图片、视频与对话消费从现金余额扣费；充值与发票在主站完成。</p>
          <div className="ca-account-actions">
            <a className="ca-account-primary ca-account-primary-invert" href="/profile">去充值<ArrowUpRight size={15}/></a>
            <button type="button" className="ca-account-ghost" onClick={()=>switchTab('records')}><FileText size={15}/>查看收支记录</button>
          </div>
        </div>
        <div className="ca-account-hero-side">
          <span>积分余额</span>
          <strong>{wallet?String(wallet.credits):'—'}</strong>
          <small>主站会员积分</small>
        </div>
      </section>

      <section className="ca-account-card ca-account-recent" aria-label="最近收支">
        <div className="ca-account-card-head">
          <h2>最近收支</h2>
          <button type="button" className="ca-account-quiet" onClick={()=>switchTab('records')}>查看全部<ArrowUpRight size={14}/></button>
        </div>
        {!recent&&<p className="ca-account-note">正在读取最近收支…</p>}
        {recent&&!recent.length&&<p className="ca-account-note">暂无收支记录。</p>}
        {recent&&recent.length>0&&<ul className="ca-account-txlist">{recent.map(txRow)}</ul>}
      </section>
    </>}

    {account.status!=='anonymous'&&tab==='records'&&<section className="ca-account-card" aria-label="收支记录">
      <div className="ca-account-filters">
        <div className="ca-account-filter-row"><span>类型</span><div role="group" aria-label="账户类型">{([['all','全部'],['cash','现金'],['credits','积分']] as const).map(([key,label])=><button key={key} className={txType===key?'active':''} onClick={()=>setTxType(key)}>{label}</button>)}</div></div>
        <div className="ca-account-filter-row"><span>方向</span><div role="group" aria-label="收支方向">{([['all','全部'],['recharge','充值'],['consume','消费']] as const).map(([key,label])=><button key={key} className={txDirection===key?'active':''} onClick={()=>setTxDirection(key)}>{label}</button>)}</div></div>
      </div>
      {txError&&<p role="alert" className="ca-account-error">{txError}<button type="button" onClick={()=>void loadTransactions(1,false)}>重试</button></p>}
      {!txError&&!txData&&txLoading&&<p className="ca-account-note">正在读取收支记录…</p>}
      {txData&&!txData.transactions.length&&!txLoading&&<p className="ca-account-note">当前筛选下暂无记录。</p>}
      {txData&&<ul className="ca-account-txlist">
        {txData.transactions.map(txRow)}
      </ul>}
      {hasMore&&<button type="button" className="ca-account-secondary ca-account-more" disabled={txLoading} onClick={()=>void loadTransactions(nextPage,true)}>{txLoading?'读取中…':'加载更多'}</button>}
      {txData&&!hasMore&&txData.transactions.length>0&&<p className="ca-account-note">已显示全部 {total} 条记录。</p>}
    </section>}
  </main>;
}
