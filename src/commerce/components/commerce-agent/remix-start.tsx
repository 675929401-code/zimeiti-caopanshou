'use client';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

const methods=[
 ['深度复刻','参考动作轮廓，替换人物、商品或背景','remix-modes/depth.png','/toolbox/depth-video-clone'],
 ['分镜复刻','参考原片分镜与节奏，用你的素材重新演绎','remix-modes/shots.png','/toolbox/hot-video-remix?mode=shots'],
 ['元素替换','精准替换原视频中的元素','remix-modes/elements.png','/toolbox/depth-video-clone?mode=elements'],
 ['超越复刻','拆透爆款底层逻辑，原创再造超越爆款','remix-modes/depth.png','/toolbox/hot-video-remix?mode=original'],
] as const;
const lessons=[
 ['.ca-depth-source','上传参考视频','建议使用 4–60 秒的参考片，观察动作、运镜与节奏。','动作与镜头参考'],
 ['[data-depth-role="product"]','上传要替换的商品图','选择主体清晰、没有遮挡的商品图，保留外形、颜色与细节。','商品外观参考'],
 ['[data-depth-role="person"]','上传要替换的人物图','替换人物时添加清晰的脸部或全身照。','人物外观参考'],
 ['.ca-depth-extra','填写补充说明','写明需要保留的口播或镜头，以及需要替换的商品信息。','全局约束'],
] as const;
export function RemixMethods({go,elements,ownerKey,showOnEntry}:{go:(path:string)=>void;elements:boolean;ownerKey:string;showOnEntry:boolean}){
 const [open,setOpen]=useState(showOnEntry),[step,setStep]=useState(-1),[box,setBox]=useState<DOMRect|null>(null);
 const root=useRef<HTMLDivElement>(null),next=useRef<HTMLButtonElement>(null),help=useRef<HTMLButtonElement>(null);
 const key=ownerKey+':remix-guide-v1';
 function chooseMethod(index:number){
   setOpen(false);
   if(index!==active){go(methods[index][3]);return;}
   if(!elements){try{if(!localStorage.getItem(key))setStep(0);}catch{}}
 }
 function finish(){try{localStorage.setItem(key,'1');}catch{}setStep(-1);root.current?.querySelector<HTMLButtonElement>('.cs-remix-trigger')?.focus({preventScroll:true});}
 useEffect(()=>{
   if(step<0)return;
   const target=root.current?.closest('.ca-depth-editor')?.querySelector(lessons[step][0]);if(!target)return;
   target.scrollIntoView({block:'nearest'});const measure=()=>setBox(target.getBoundingClientRect());measure();
   const observer=new ResizeObserver(measure);observer.observe(target);
   window.addEventListener('resize',measure);document.addEventListener('scroll',measure,true);
   next.current?.focus({preventScroll:true});
   return()=>{observer.disconnect();window.removeEventListener('resize',measure);document.removeEventListener('scroll',measure,true);};
 },[step]);
 useEffect(()=>{if(open)root.current?.querySelector<HTMLButtonElement>('.cs-remix-choices button[aria-pressed=true]')?.focus({preventScroll:true});},[open]);
 useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(root.current&&!root.current.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
 const active=elements?2:0;
 return <div className="cs-remix-methods" ref={root} onKeyDown={e=>{if(e.key==='Escape'&&open){e.stopPropagation();setOpen(false);root.current?.querySelector<HTMLButtonElement>('.cs-remix-trigger')?.focus({preventScroll:true});}}}><button type="button" className="cs-remix-trigger" aria-label="选择复刻方式" aria-expanded={open} onClick={()=>setOpen(!open)}><img src={'/commerce/'+methods[active][2]} alt=""/><span><b>{methods[active][0]}</b><small>{methods[active][1]}</small></span><span aria-hidden="true">⌄</span></button><div className="cs-remix-menu" role="dialog" aria-label="选择复刻方式" hidden={!open}><header><strong>选择复刻方式</strong><small>延续精彩，演绎不同</small><button type="button" ref={help} onClick={()=>{setOpen(false);setStep(0);}}>使用教程</button></header>
 <div className="cs-remix-choices">{methods.map(([name,description,img],i)=><button type="button" key={name} aria-pressed={active===i} aria-label={name} onClick={()=>chooseMethod(i)}><img src={'/commerce/'+img} alt=""/><span><b>{name}</b><small>{description}</small></span></button>)}</div></div>
 {step>=0&&box&&createPortal(<div className="cs-remix-tour" onKeyDown={e=>{if(e.key==='Escape')finish();if(e.key==='Tab'){e.preventDefault();const items=e.currentTarget.querySelectorAll('button');(document.activeElement===items[0]?items[1]:items[0])?.focus();}}}>
 <div className="cs-remix-highlight" style={{top:box.top-3,left:box.left-3,width:box.width+6,height:box.height+6}}/>
 <section role="dialog" aria-modal="true" aria-label="复刻使用教程" style={{left:Math.max(8,Math.min(window.innerWidth-348,box.right+20)),top:Math.max(8,Math.min(window.innerHeight-215,box.top))}}>
 <header><strong>{lessons[step][1]}</strong><button onClick={finish}>跳过</button></header><p>{lessons[step][2]}</p><small>{lessons[step][3]}</small><footer><span>{step+1} / 4</span><button ref={next} onClick={()=>step===3?finish():setStep(step+1)}>{step===3?'完成':'下一步'}</button></footer></section></div>,document.body)}</div>;
}
