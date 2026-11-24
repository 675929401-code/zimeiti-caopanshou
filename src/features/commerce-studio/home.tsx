'use client';
import { useState, useRef, type ReactNode } from 'react';
import { ArrowUp, Plus, Mic, X } from 'lucide-react';
import {HomeWallet} from '@/commerce/components/commerce-agent/rail-account';
import { useHomeCatalog, baselineHomeCatalog, type HomeQuickTool } from '@/commerce/components/commerce-agent/use-home-catalog';
import { AnchoredPanel } from '@/commerce/components/commerce-agent/reference-ui';
const sceneMovies=new Set(['replicate','ecommerce','local','brand','drama']);
function SceneMedia({id,image,playing}:{id:string;image?:string;playing:boolean}){
  const path='/commerce/scene-previews/'+id;
  return <span className="cs-scene-media" aria-hidden="true">
    <img src={image||path+'.webp'} alt="" />
    {playing&&sceneMovies.has(id)&&<video src={path+'.mp4'} muted loop autoPlay playsInline
      onPlaying={e=>{e.currentTarget.style.opacity='1';}} />}
  </span>;
}
import {ComposerAddMenu} from './composer-add-menu';
import type {MemberSkill,SkillLibrary} from './member-skills';
type Props={ready:boolean;restoreError:string;retry:()=>void;images:{id:string;name:string}[];missing:boolean;prompt:string;change:(v:string)=>void;chosen:MemberSkill|null;chooseSkill:(item:MemberSkill|null)=>void;upload:()=>void;manage:()=>void;connector:(name:string)=>void;loadLibrary:()=>Promise<SkillLibrary>;attachments:ReactNode;hasAssets:boolean;attach:()=>void;submit:()=>void;mic:()=>void;listening:boolean;choose:(id:string)=>void;quick:(item:HomeQuickTool)=>void;children:ReactNode};
export function StudioHome(p:Props & {cashBalance:string|null}) {
  const [open,setOpen]=useState(false),[at,setAt]=useState<number|null>(null);
  const [preview,setPreview]=useState('');
  const previewEvents=(id:string)=>({
    onMouseEnter:()=>setPreview(id),onMouseLeave:()=>setPreview(''),
    onFocus:()=>setPreview(id),onBlur:()=>setPreview(''),
  });
  const input=useRef<HTMLTextAreaElement>(null);
  function insertImage(i:number){
    if(at===null)return;
    const token='@图片'+(i+1)+' ', end=at+token.length;
    p.change(p.prompt.slice(0,at)+token+p.prompt.slice(at+1));setAt(null);
    requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(end,end);});
  }
  const {scenarios,quickTools}=useHomeCatalog();
  const [lead,...cards]=scenarios;
  // 只有后台改过的图片才覆盖默认分镜预览；基线 image 字段服务于收藏弹窗，不用于首页缩略图。
  const baselineImage=new Map(baselineHomeCatalog().scenarios.map(item=>[item.id,(item as {image?:string}).image||'']));
  const sceneImage=(item:typeof lead)=>{const custom=(item as {image?:string}).image;return custom&&custom!==baselineImage.get(item.id)?custom:undefined;};
  return <main className="cs-home"><div className="cs-home-backdrop" aria-hidden="true"/><header className="cs-hero">
    <HomeWallet amount={p.cashBalance}/>
    <h1><span>自媒体操盘手，</span>懂带货业务场景的 AI 创作工具</h1>
    <div className="cs-composer" aria-busy={!p.ready} inert={!p.ready}><div className="cs-plus"><button title="添加素材、技能或连接器" aria-label="添加素材、技能或连接器" data-popover-trigger aria-expanded={open} onClick={()=>setOpen(!open)}><Plus size={20}/></button>{open&&<ComposerAddMenu close={()=>setOpen(false)} upload={p.upload} assets={p.attach} loadLibrary={p.loadLibrary} manage={p.manage} connector={p.connector} pick={skill=>{p.chooseSkill(skill);requestAnimationFrame(()=>input.current?.focus())}}/>}</div>
      {p.chosen&&<button className="cs-home-skill" aria-label={'移除技能 '+p.chosen.name} onClick={()=>p.chooseSkill(null)}>{p.chosen.name}<X size={12}/></button>}
      <textarea ref={input} aria-label="首页创作要求" rows={1} value={p.prompt} maxLength={10000} onChange={e=>{const end=e.target.selectionStart;p.change(e.target.value);setAt(e.target.value[end-1]==='@'?end-1:null);}} onClick={()=>setAt(null)} placeholder="结合参考、输入文字或 @ 主体，说说今天想做什么。" onKeyDown={e=>{if(e.key==='Escape'&&at!==null){e.preventDefault();setAt(null);return;}if(e.key==='Enter'&&at!==null)return;if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(p.prompt.trim()||p.hasAssets||p.chosen)p.submit();}}}/>
      <button title={p.listening?'停止语音输入':'语音输入'} aria-pressed={p.listening} onClick={p.mic}><Mic size={19}/></button><button className="cs-send" aria-label="开始创作" disabled={!p.prompt.trim()&&!p.hasAssets&&!p.chosen} onClick={p.submit}><ArrowUp size={18}/></button>
    {at!==null&&<AnchoredPanel className="cs-home-mentions" label="选择引用图片" onClose={()=>setAt(null)}>{p.images.length?p.images.map((item,i)=><button key={item.id} onClick={()=>insertImage(i)}>@图片{i+1} · {item.name}</button>):<span>请先添加参考图片</span>}</AnchoredPanel>}</div>{p.restoreError&&<p role="alert">{p.restoreError} <button onClick={p.retry}>重新读取首页草稿</button></p>}{p.missing&&<p role="alert">引用的图片已移除，请删除对应的 @图片 标记并重新选择。</p>}{p.hasAssets&&<div className="cs-home-attachments">{p.attachments}</div>}
    <nav className="cs-shortcuts" aria-label="快捷工具">{quickTools.map(item=><button key={item.icon} onClick={()=>p.quick(item)}><img width={20} height={20} alt="" src={item.icon}/>{item.name}</button>)}</nav>
    </header><section className="cs-scenes"><h2>你想做什么？ <small>选择创作目标快速开始</small></h2><div className="cs-scene-grid">
    <button className="cs-lead" disabled={!p.ready} {...previewEvents(lead.id)} onClick={()=>p.choose(lead.id)}><SceneMedia id={lead.id} image={sceneImage(lead)} playing={preview===lead.id}/><span><b>{lead.name}</b><small>{lead.description}</small></span></button>
    <div className="cs-mini-grid">{cards.map(item=><button key={item.id} disabled={!p.ready} {...previewEvents(item.id)} onClick={()=>p.choose(item.id)}><SceneMedia id={item.id} image={sceneImage(item)} playing={preview===item.id}/><span><b>{item.name}</b><small>{item.description}</small></span></button>)}</div></div></section>
    <div className="cs-feed">{p.children}</div></main>;
}
