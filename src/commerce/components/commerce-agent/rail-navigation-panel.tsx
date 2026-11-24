'use client';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Blocks,MoreHorizontal,PanelLeft,PanelLeftClose,SquarePen,Trash2} from 'lucide-react';
type Props={label:string;panelTitle:string;children:ReactNode;content?:ReactNode;current:boolean;enabled:boolean;pinned:boolean;onPin:()=>void;history?:{id:string;title:string}[];go:()=>void;openChat?:(id?:string)=>void;openSkills?:()=>void;onRenameChat?:(id:string,title:string)=>void;onDeleteChat?:(id:string)=>void};
export function RailNavigationPanel({children,label,panelTitle,content,current,enabled,pinned,onPin,history=[],go,openChat,openSkills,onRenameChat,onDeleteChat}:Props){
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [left,setLeft]=useState<number|null>(null);
  const [menuFor,setMenuFor]=useState('');
  const [renaming,setRenaming]=useState<{id:string;value:string}|null>(null);
  const scrollPosition=useRef(0);
  const visible=enabled&&(left!==null||pinned);
  const mediaPanel=Boolean(content);
  useLayoutEffect(()=>{
    if(!visible)return;
    const scroller=panel.current?.querySelector<HTMLElement>(mediaPanel?'.cs-scenes-nav > div':':scope > div');
    if(!scroller)return;
    scroller.scrollTop=scrollPosition.current;
    const remember=()=>{scrollPosition.current=scroller.scrollTop;};
    scroller.addEventListener('scroll',remember,{passive:true});
    return ()=>scroller.removeEventListener('scroll',remember);
  },[visible,mediaPanel]);
  function cancel(){if(timer.current)clearTimeout(timer.current);timer.current=null;}
  function close(){cancel();setLeft(null);}
  function open(){cancel();if(enabled&&window.innerWidth>=1024&&trigger.current){const rail=trigger.current.closest('aside');setLeft(rail?.getBoundingClientRect().right??52);}}
  function schedule(){cancel();if(!pinned)timer.current=setTimeout(close,140);}
  useEffect(()=>{if(!enabled)close();return cancel;},[enabled]);
  useEffect(()=>{if(left===null)return;function outside(event:PointerEvent){if(!pinned&&!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();}function escape(event:KeyboardEvent){if(event.key==='Escape'){if(pinned)onPin();close();trigger.current?.focus();}}document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);window.addEventListener('resize',close);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('resize',close);};},[left,pinned,onPin]);
  function select(action:()=>void){close();action();}
  return <><button ref={trigger} title={label} aria-label={label} aria-expanded={enabled?(left!==null||pinned):undefined} aria-current={current?'page':undefined} className={current?'active':''}
    onPointerEnter={e=>{if(e.pointerType==='mouse')open();}} onPointerLeave={schedule} onKeyDown={e=>{if(enabled&&e.key==='ArrowRight'){e.preventDefault();open();requestAnimationFrame(()=>panel.current?.querySelector('button')?.focus());}}} onClick={()=>select(go)}>{children}</button>
    {(left!==null||pinned)&&enabled&&createPortal(<aside ref={panel} aria-label={panelTitle+' 导航'} className={'cs-agent-flyout'+(content?' cs-media-flyout':'')+(pinned?' cs-flyout-pinned':'')} style={{left:left??52}} onKeyDown={e=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;const items=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]'));const index=items.indexOf(document.activeElement as HTMLElement);if(index<0)return;e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,index+(e.key==='ArrowDown'?1:-1)))]?.focus();}} onPointerEnter={cancel} onPointerLeave={schedule} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))schedule();}} onFocus={cancel}>
      <header>{panelTitle}<button aria-label={pinned?'取消固定面板':'固定面板'} aria-pressed={pinned} onClick={()=>{onPin();if(pinned)close();}}>{pinned?<PanelLeftClose size={16}/>:<PanelLeft size={16}/>}</button></header>
      <div>{content||<><button onClick={()=>select(()=>openChat?.())}><SquarePen size={16}/>新任务</button>
      <button onClick={()=>select(()=>openSkills?.())}><Blocks size={16}/>技能·连接器</button>
      <h3>最近</h3>{history.map(c=><div key={c.id} className="cs-history-item">
        {renaming?.id===c.id
          ?<input className="cs-history-rename" value={renaming.value} autoFocus maxLength={60} aria-label="重命名会话"
            onChange={e=>setRenaming({id:c.id,value:e.target.value})}
            onKeyDown={e=>{if(e.key==='Enter'){const next=renaming.value.trim();setRenaming(null);if(next&&next!==c.title)onRenameChat?.(c.id,next);}if(e.key==='Escape')setRenaming(null);}}
            onBlur={()=>{const next=renaming.value.trim();setRenaming(null);if(next&&next!==c.title)onRenameChat?.(c.id,next);}}/>
          :<button title={c.title} onClick={()=>select(()=>openChat?.(c.id))}><span>{c.title}</span></button>}
        {(onRenameChat||onDeleteChat)&&renaming?.id!==c.id&&<div className="cs-history-actions">
          <button aria-label={c.title+' 的更多操作'} aria-expanded={menuFor===c.id} onClick={()=>setMenuFor(menuFor===c.id?'':c.id)}><MoreHorizontal size={14}/></button>
          {menuFor===c.id&&<div className="cs-history-menu" role="menu">
            {onRenameChat&&<button role="menuitem" onClick={()=>{setMenuFor('');setRenaming({id:c.id,value:c.title});}}><SquarePen size={13}/>重命名</button>}
            {onDeleteChat&&<button role="menuitem" className="cs-history-danger" onClick={()=>{setMenuFor('');onDeleteChat(c.id);}}><Trash2 size={13}/>删除</button>}
          </div>}
        </div>}
      </div>)}</>}</div></aside>,trigger.current?.closest('.commerce-root')||document.body)}</>;
}
