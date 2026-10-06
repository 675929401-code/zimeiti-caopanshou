'use client';
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {IMAGE_RAIL_GROUPS,imageRailHref} from './image-rail-menu-data';
import './image-rail-menu.css';

export type ImageRailMenuProps={active:boolean;routeKey:string;children:ReactNode;onNavigate:(path:string)=>boolean|Promise<boolean>;onError?:(message:string)=>void};

/** Mirrors the observed desktop image sidebar menu; never fetches a catalogue or submits a task. */
export function ImageRailMenu({active,routeKey,children,onNavigate,onError}:ImageRailMenuProps){
 const id=useId(),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null),focusOnOpen=useRef<'first'|'last'|null>(null),suppressFocus=useRef(false),mounted=useRef(true);
 const [open,setOpen]=useState(false),[ready,setReady]=useState(false),[position,setPosition]=useState({left:80,top:12});
 const clearTimer=useCallback(()=>{if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}},[]);
 const close=useCallback(()=>{clearTimer();setOpen(false);setReady(false);focusOnOpen.current=null;},[clearTimer]);
 const keepOpen=useCallback(()=>{clearTimer();if(!suppressFocus.current&&window.matchMedia('(min-width:1024px)').matches)setOpen(true);},[clearTimer]);
 const requestClose=useCallback(()=>{clearTimer();timer.current=setTimeout(()=>{timer.current=null;setOpen(false);setReady(false);},120);},[clearTimer]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearTimer();};},[clearTimer]);
 useEffect(()=>{close();},[routeKey,close]);
 useLayoutEffect(()=>{
  if(!open)return;
  const update=()=>{
   const button=trigger.current,node=menu.current;if(!button||!node)return;
   if(window.innerWidth<1024){close();return;}
   const anchor=button.getBoundingClientRect(),rail=button.closest('[data-workspace-sidebar]')?.getBoundingClientRect();
   const height=node.getBoundingClientRect().height||360,width=264;
   let left=Math.max(anchor.right+10,rail?rail.right+8:0);
   if(left+width>window.innerWidth-12)left=Math.max(12,window.innerWidth-width-12);
   const top=Math.max(12,Math.min(Math.max(12,anchor.top-2),window.innerHeight-12-height));
   setPosition({left,top});
  };
  update();
  const frame=requestAnimationFrame(()=>{update();setReady(true);if(focusOnOpen.current){const links=menu.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]');const index=focusOnOpen.current==='last'?(links?.length||1)-1:0;links?.[index]?.focus();focusOnOpen.current=null;}});
  const observer=new ResizeObserver(update);if(menu.current)observer.observe(menu.current);
  window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
  return()=>{cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};
 },[open,close]);
 const moveFocus=(event:KeyboardEvent<HTMLElement>)=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();suppressFocus.current=true;trigger.current?.focus();suppressFocus.current=false;return;}
  const links=Array.from(menu.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')||[]),index=links.indexOf(document.activeElement as HTMLAnchorElement);
  let next:number|undefined;
  if(event.key==='Home')next=0;else if(event.key==='End')next=links.length-1;
  else if(event.key==='ArrowDown')next=index+2;else if(event.key==='ArrowUp')next=index-2;
  else if(event.key==='ArrowRight')next=index+1;else if(event.key==='ArrowLeft')next=index-1;
  if(next===undefined||!links.length)return;event.preventDefault();links[Math.max(0,Math.min(links.length-1,next))]?.focus();
 };
 const navigate=async(path:string)=>{try{const accepted=await onNavigate(path);if(accepted&&mounted.current)close();}catch(error){if(mounted.current)onError?.((error as Error).message||'图片技能入口暂时无法打开');}};
 return <>
  <button ref={trigger} type="button" className={active?'active':''} aria-current={active?'page':undefined} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined}
   onMouseEnter={keepOpen} onMouseLeave={requestClose} onFocus={keepOpen} onBlur={requestClose}
   onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowRight'||event.key==='Home'||event.key==='End'){event.preventDefault();focusOnOpen.current=event.key==='End'?'last':'first';if(open){const links=menu.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]');links?.[focusOnOpen.current==='last'?(links.length-1):0]?.focus();focusOnOpen.current=null;}else keepOpen();}else if(event.key==='Escape'){event.preventDefault();close();}}}
   onClick={()=>void navigate('/toolbox/image-generation')}>{children}</button>
  {open&&createPortal(<div id={id} ref={menu} role="menu" aria-label="AI 图片生成技能" className="ca-image-rail-menu" data-ready={ready} style={{left:position.left,top:position.top}}
   onMouseEnter={keepOpen} onMouseLeave={requestClose} onFocusCapture={keepOpen} onBlurCapture={requestClose} onKeyDown={moveFocus}>
   <div className="ca-image-rail-menu-content">{IMAGE_RAIL_GROUPS.map(group=><section className="ca-image-rail-menu-category" key={group.id} aria-labelledby={id+'-'+group.id}>
    <div className="ca-image-rail-menu-heading"><span aria-hidden="true"/><h3 id={id+'-'+group.id}>{group.label}</h3><span aria-hidden="true"/></div>
    <div className="ca-image-rail-menu-items">{group.items.map(item=>{const href='/commerce'+imageRailHref(item.sourceId);return <a key={item.sourceId} role="menuitem" href={href} onClick={event=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();void navigate(href);}}>
     <span className="ca-image-rail-menu-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true"><path d={item.iconPath} strokeLinecap="round" strokeLinejoin="round"/></svg></span><span className="ca-image-rail-menu-label">{item.label}</span>
    </a>;})}</div>
   </section>)}</div>
  </div>,document.body)}
 </>;
}
