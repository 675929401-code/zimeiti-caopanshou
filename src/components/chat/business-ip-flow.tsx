"use client";
import { BIP_STEPS, BIP_VERSION } from '@/lib/business-ip/catalog';
import type { Agent } from '@/types/coze';
import {useState} from 'react';
import {BusinessIpIntake} from './business-ip-intake';

export function BusinessIpFlow({value,conversationId,onChange,agents,disabled,onPrepare}:{value:string;conversationId:string;onChange:(id:string)=>void;agents:Agent[];disabled:boolean;onPrepare:(text:string)=>void}) {
 const [showIntake,setShowIntake]=useState(false);
 return <section className="bip-flow shrink-0 border-b border-[var(--border)] px-4 py-3 pr-14" aria-label="商业IP项目步骤">
  <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">本项目 · 商业IP闭环</strong><span className="text-xs text-[var(--text-secondary)]">v{BIP_VERSION} · 切换步骤沿用本对话资料</span><button type="button" disabled={disabled} onClick={()=>setShowIntake(true)} className="rounded-md border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-40">补充资料</button></div>
  <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
   {BIP_STEPS.map((step,index)=>{const agent=agents.find(a=>a.id===step.id);return <button key={step.id} type="button" aria-pressed={value===step.id} disabled={disabled||!agent||!agent.is_active||agent.user_access==='hidden'} onClick={()=>onChange(step.id)} className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40 ${value===step.id?'border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]':'border-[var(--border)]'}`}>{index+1}. {step.short}</button>;})}
  </div>
  <p className="mt-1 text-xs text-[var(--text-secondary)]">选好步骤后直接输入；可以补充或纠正信息。不同客户请新建对话。</p>
  {showIntake&&<BusinessIpIntake key={value} agentId={value} conversationId={conversationId} open supplement onClose={()=>setShowIntake(false)} onPrepare={text=>{onPrepare(text);setShowIntake(false);}} />}
 </section>;
}
