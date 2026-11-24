'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ChevronDown,ChevronLeft,ChevronRight,Cloud,Monitor} from 'lucide-react';

export function ChatWorkspaceMenu({children,onCloseModel}:{children:ReactNode;onCloseModel:()=>void}) {
  const [view,setView]=useState<'closed'|'environments'|'model'>('closed');
  const open=view!=='closed';
  const root=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    function dismiss(){setView('closed');onCloseModel();}
    function outside(event:PointerEvent){if(!root.current?.contains(event.target as Node))dismiss();}
    function key(event:KeyboardEvent){if(event.key==='Escape'){dismiss();trigger.current?.focus();}}
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',key);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};
  },[open,onCloseModel]);
  return <div className="cs-chat-environment" ref={root}>
    <button type="button" className="cs-chat-environment-trigger" ref={trigger} aria-label="选择运行环境，当前：临时工作区"
      aria-haspopup="dialog" aria-expanded={open} onClick={()=>{if(open)onCloseModel();setView(open?'closed':'environments');}}>
      <Cloud size={16}/><span>临时工作区</span><ChevronDown size={12}/>
    </button>
    {open&&<section role="dialog" aria-label="任务运行环境" className="cs-chat-environment-menu">
      {view==='environments'?<><h3>此任务使用的环境</h3>
      <button type="button" aria-pressed="true" onClick={()=>setView('model')}><Cloud size={16}/>临时工作区<ChevronRight size={12}/></button>
      <button type="button" disabled><Monitor size={16}/>个人云电脑 <small>未接入</small></button>
      </>:<><button type="button" aria-label="返回任务环境" onClick={()=>{onCloseModel();setView('environments');}}><ChevronLeft size={14}/>临时工作区</button><div className="cs-chat-environment-model">{children}</div></>}
    </section>}
  </div>;
}
