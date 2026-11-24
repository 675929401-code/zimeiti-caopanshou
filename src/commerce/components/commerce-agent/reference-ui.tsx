'use client';
import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {ArrowUp,ChevronDown,Copy,LoaderCircle,Search,X,Check} from 'lucide-react';
import observed from './observed-catalog.json';
import type {Runtime} from './runtime-ui';
import {ScriptContent} from './script-content';
import {memberVideoBillingText,type MemberVideoBilling} from '../../shared/video-picker-catalog';
import {CommerceVideoPicker} from './video-model-picker';
import type {MaterialSlot} from './catalog';
import {DETAIL_QUALITY_OPTIONS,supportsWorkspaceQuality,type DetailImageQuality} from '../../shared/detail-image-quality';
import './image-parameter-menu.css';
import './video-settings.css';
import {DirectorConversationPanel,type DirectorPanelProps} from './director-conversation';
import {
 commerceVideoNativeDurationOptions,
  commerceVideoResolutionOptions,
  commerceVideoSupportsAudioToggle,
  commerceVideoTargetDurations,
  COMMERCE_VIDEO_MAX_TOTAL_DURATION,
} from '../../shared/video-generation-capabilities';

export {visualDirectorCatalog as DIRECTORS} from './personal-ip-cards';
export const observedImage=(name:string)=>observed.images.find(s=>s.name===name)||(name==='图片创作'?observed.images.find(s=>s.default):undefined);
export const PUBLIC_UI=observed;
export function AnchoredPanel({children,onClose,className='',label}:{children:ReactNode;onClose:()=>void;className?:string;label:string}){
 const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{const prior=document.activeElement as HTMLElement|null;const frame=requestAnimationFrame(()=>ref.current?.querySelector<HTMLElement>('input,button,select')?.focus({preventScroll:true}));function key(e:KeyboardEvent){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close.current();}if(e.key==='Tab'){const buttons=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]')||[]).filter(e=>e.getClientRects().length);if(!buttons.length)return;const first=buttons[0],last=buttons.at(-1)!;if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}function outside(e:PointerEvent){if(!ref.current?.contains(e.target as Node)&&!(e.target as Element).closest('[data-popover-trigger]'))close.current();}document.addEventListener('keydown',key,true);document.addEventListener('pointerdown',outside);return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',outside);prior?.focus();};},[]);
 return <div ref={ref} role="dialog" aria-label={label} className={'ca-anchored-panel '+className}>{children}</div>;
}
type PickItem={id:string;name:string;description:string;category:string;icon?:string;recommended?:boolean;order?:number};
export function CreationPicker({items,kind,onPick,onClose,initialCategory='推荐',selected='',onClear,inline=false}:{inline?:boolean;initialCategory?:string;selected?:string;onClear?:()=>void;items:PickItem[];kind:'image'|'video';onPick:(id:string)=>void;onClose:()=>void}){
 const [category,setCategory]=useState(initialCategory),[query,setQuery]=useState(''),[search,setSearch]=useState(false),[expanded,setExpanded]=useState(false);
 const stripRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{
   const strip=stripRef.current;
   if(!strip)return;
   function reveal(){
     if(!strip)return;
     const tab=strip.querySelector<HTMLElement>('[aria-pressed="true"]');
     if(!tab)return;
     const bounds=strip.getBoundingClientRect(),selected=tab.getBoundingClientRect();
     if(selected.right>bounds.right)strip.scrollLeft+=selected.right-bounds.right;
     else if(selected.left<bounds.left)strip.scrollLeft+=selected.left-bounds.left;
   }
   reveal();
   const resize=new ResizeObserver(reveal);resize.observe(strip);
   return ()=>resize.disconnect();
 },[category,kind]);
 const orderedCategories=kind==='image'?['人物','商品','场景','增强']:['电商带货','同城到店','短剧编导','品牌广告','剧情短片'];
 const categories=['推荐',...new Set([...orderedCategories,...items.map(i=>i.category)])];
 const recommendedOrder=kind==='image'?['face-turnaround','change-face','white-background','image-refine','change-cloth','product-use']:['ecommerce-spoken-selling','ecommerce-promotion-conversion','local-store-visit-record','local-store-group-buy-conversion','short-drama-emotional','face-slap-reversal'];
 const recommended=category==='推荐'&&!query;
 const rank=(item:PickItem)=>{const index=recommended?recommendedOrder.indexOf(item.id):-1;return index<0?(item.order??99)+recommendedOrder.length:index;};
 const matches=items.filter(item=>(query||recommended?query||item.recommended:item.category===category)&&(item.name+item.description).includes(query)).sort((a,b)=>rank(a)-rank(b));
 const visible=recommended?matches.slice(0,6):matches;
 function chooseCategory(value:string){setCategory(value);setQuery('');setExpanded(false);}
 function categoryTab(c:string){return <button key={c} aria-pressed={category===c} className={category===c?'selected':''} onClick={()=>chooseCategory(c)}>{c}</button>;}

 return <AnchoredPanel onClose={onClose} label={kind==='image'?'选择图片技能':'选择视频编导'} className={inline?"ca-creation-picker ca-inline-picker":"ca-creation-picker"}>{!inline&&<header><strong>你想创作什么？</strong><span>让每一个想法，都能成为{kind==='image'?'画面':'影像'}</span>{onClear&&<button className="cs-picker-clear" onClick={onClear}>清除选择</button>}</header>}{inline?<nav aria-label="创作分类">{categories.map(categoryTab)}</nav>:<nav className={kind==='video'?'cs-video-categories':undefined}>{kind==='video'?<><div className="cs-picker-tab-strip" ref={stripRef}>{categories.map(categoryTab)}</div><button className="cs-expand-categories" aria-label={expanded?'收起场景':'展开场景'} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><ChevronDown size={13}/></button></>:categories.map(categoryTab)}<label className="cs-picker-search" data-expanded={search||!!query}><Search size={13} aria-hidden="true"/><input type="search" aria-label="搜一搜" placeholder="搜一搜" value={query} onFocus={()=>{setSearch(true);setExpanded(false);}} onBlur={()=>setSearch(false)} onChange={e=>setQuery(e.target.value)}/></label></nav>}{!inline&&expanded&&<div role="group" aria-label="全部场景" className="cs-all-categories">{categories.map(categoryTab)}</div>}<div className="ca-creation-cards" data-category={category}>{visible.map(item=><button key={item.id} data-skill={item.id} aria-pressed={item.id===selected} onClick={()=>onPick(item.id)}>{item.icon&&<img src={item.icon} alt=""/>}<span><strong>{item.name}</strong><small>{item.description}</small></span></button>)}</div>{!visible.length&&<p>没有找到相关技能</p>}<footer>更多技能持续上线中</footer></AnchoredPanel>;
}
type ModelChoice={id:string;displayName:string;capabilities:Record<string,unknown>;verified?:boolean;generationReady?:boolean;readinessMessage?:string;configurationHint?:string;modeCompatible?:boolean;modeIncompatibleReasons?:string[];tier?:number;tierLabel?:string};
export function ModelPopover({items,selected,onSelect,onClose,children,routeOrder=false,imagePicker=false}:{imagePicker?:boolean;routeOrder?:boolean;children?:ReactNode;items:ModelChoice[];selected:string;onSelect:(id:string)=>void;onClose:()=>void}){
 if(routeOrder)return <AnchoredPanel onClose={onClose} label="选择生成模型" className="ca-video-model-menu"><CommerceVideoPicker items={items} selected={selected} onSelect={onSelect} onClose={onClose}/></AnchoredPanel>;
 const ordered=[...items].sort((a,b)=>(b.tier||1)-(a.tier||1));
 if(imagePicker)return <AnchoredPanel onClose={onClose} label="选择生图模型" className="ca-model-popover ca-image-model-popover">
  {ordered.map(m=>{
    const disabled=m.capabilities.available===false||m.modeCompatible===false;
    const references=Number(m.capabilities.maxReferenceImages)||1;
    const supportsReferences=Boolean(m.capabilities.supportsReferenceInput||m.capabilities.supportsImageInput);
    const detail=disabled?(m.modeIncompatibleReasons?.[0]||'当前设置不可用'):m.generationReady===false?'等待渠道验收':supportsReferences?`${m.capabilities.fixedImageQuality==='high'?'固定高画质 · ':''}最多 ${references} 张参考图`:'文字生图';
    return <button type="button" key={m.id} data-model-id={m.id} data-generation-ready={m.generationReady===true} data-selection-compatible={!disabled} aria-pressed={m.id===selected} aria-label={`选择模型 ${m.displayName}`} disabled={disabled} title={detail} onClick={()=>{onSelect(m.id);onClose();}}>
      <span><b>{m.displayName}</b><small>{detail}</small></span>{m.id===selected&&<Check size={15} aria-hidden="true"/>}
    </button>;
  })}
 </AnchoredPanel>;
 const rows=ordered.map(m=>{
  const disabled=m.capabilities.available===false||m.modeCompatible===false;
  const status=m.capabilities.available===false?'渠道暂不可用':m.modeCompatible===false?(m.modeIncompatibleReasons?.join('；')||'与当前参数不兼容'):m.generationReady===false?(m.readinessMessage||'生成验收中'):m.capabilities.supportsReferenceInput||m.capabilities.supportsImageInput?'支持参考素材':'文字生成';
  return <button key={m.id} data-model-id={m.id} data-generation-ready={m.generationReady===true?'true':'false'} data-selection-compatible={disabled?'false':'true'} aria-label={`选择模型 ${m.displayName}；${status}${m.configurationHint?`；${m.configurationHint}`:''}`} className={m.id===selected?'selected':''} disabled={disabled} title={[status,m.configurationHint].filter(Boolean).join(' · ')} onClick={()=>{if(disabled)return;onSelect(m.id);onClose();}}><span>{m.displayName}{m.tierLabel&&<small>{m.tierLabel}</small>}<small>{status}</small>{m.configurationHint&&<small className="ca-model-configuration-hint">{m.configurationHint}</small>}</span>{m.id===selected&&<Check size={15}/>}</button>;
 });
 return <AnchoredPanel onClose={onClose} label="选择生成模型" className="ca-model-popover">
  <strong>选择模型</strong><small>按当前素材与设置实时核对；费用以提交前报价为准。</small>{rows}
  {children}</AnchoredPanel>;
}
function strings(value:unknown){return Array.isArray(value)?[...new Set(value.map(String).filter(Boolean))]:[];}
export function mediaSettingsOptions(kind:'image'|'video',capabilities:Record<string,unknown>){
 const availableRatios=strings(capabilities.aspectRatios);
 const standardRatios=['21:9','16:9','4:3','1:1','3:4','9:16'];
 const configuredRatios=kind==='video'?[...standardRatios.filter(r=>availableRatios.includes(r)),...availableRatios.filter(r=>!standardRatios.includes(r))]:availableRatios;
 const ratios=kind==='image'
  ?['自适应',...(configuredRatios.length?configuredRatios:['16:9','4:3','1:1','3:4','9:16'])]
  :(configuredRatios.length?configuredRatios:['21:9','16:9','4:3','1:1','3:4','9:16']);
 const resolvedVideoResolutions=kind==='video'?commerceVideoResolutionOptions(capabilities):null;
 const configuredResolutions=kind==='video'?(resolvedVideoResolutions?.options||[]):strings(capabilities.resolutionOptions);
 const resolutions=configuredResolutions.length?configuredResolutions:(kind==='video'?['720p']:['1K','2K','4K']);
 const nativeDurations=kind==='video'?commerceVideoNativeDurationOptions(capabilities):[];
 const durationTargets=kind==='video'?commerceVideoTargetDurations(capabilities,{maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION}):[];
 const durationMin=durationTargets[0]||nativeDurations[0]||4;
 const durationMax=durationTargets.at(-1)||nativeDurations.at(-1)||durationMin;
 return {ratios,resolutions,nativeDurations,durationTargets,durationMin,durationMax,audioToggle:kind==='video'&&commerceVideoSupportsAudioToggle(capabilities)};
}
export function MediaSettings({kind,capabilities,memberBilling,compatibilityIssue,aspectRatio,resolution,format,duration,onRatio,onResolution,onFormat,onDuration,generateAudio,onGenerateAudio,imageQuality,onImageQuality,onClose}:{kind:'image'|'video';capabilities:Record<string,unknown>;memberBilling?:MemberVideoBilling;compatibilityIssue?:string;aspectRatio:string;resolution:string;format:string;duration:number;imageQuality?:DetailImageQuality;onImageQuality?:(value:DetailImageQuality)=>void;onRatio:(s:string)=>void;onResolution:(s:string)=>void;onFormat:(s:string)=>void;onDuration:(n:number)=>void;generateAudio?:boolean;onGenerateAudio?:(b:boolean)=>void;onClose:()=>void}){
 const options=mediaSettingsOptions(kind,capabilities);
 const imageQualities=kind==='image'?DETAIL_QUALITY_OPTIONS.filter(option=>supportsWorkspaceQuality(capabilities,option.value)):[];
 const currentDuration=options.durationTargets.reduce((closest,value)=>Math.abs(value-Number(duration))<Math.abs(closest-Number(duration))?value:closest,options.durationTargets[0]||options.durationMin);
 const currentDurationIndex=Math.max(0,options.durationTargets.indexOf(currentDuration));
 const nativeMax=options.nativeDurations.at(-1)||0;
 return <AnchoredPanel onClose={onClose} label={kind==='image'?'图片设置':'视频设置'} className={kind==='video'?'ca-media-settings ca-video-settings':'ca-media-settings'}>
  {kind==='video'&&compatibilityIssue&&<p className="ca-video-settings-issue" role="alert">{compatibilityIssue}</p>}
  <section><h3>{kind==='image'?'图片比例':'视频比例'}</h3><div className="ca-parameter-ratios">{options.ratios.map(r=><button key={r} className={aspectRatio===r?'selected':''} onClick={()=>onRatio(r)}><i style={{aspectRatio:r==='自适应'?'1':r.replace(':','/'),...(kind==='video'?{'--ratio':Number(r.split(':')[0])/Number(r.split(':')[1])||1}:{})}}/>{r}{kind==='image'&&aspectRatio===r&&<Check size={10}/>}</button>)}</div></section>
  <section><h3>分辨率</h3><div className="ca-parameter-choices">{options.resolutions.map(s=><button key={s} className={resolution.toLowerCase()===s.toLowerCase()?'selected':''} onClick={()=>onResolution(s)}>{kind==='image'?({['1K']:'标清　',['2K']:'高清　',['4K']:'超清　'}[s]):({['480p']:'标清 ',['720p']:'高清 ',['1080p']:'超清 ',['1080P']:'超清 '}[s]||'')}{kind==='video'?s.toUpperCase():s}{kind==='image'&&resolution.toLowerCase()===s.toLowerCase()&&<Check size={10}/>}</button>)}</div></section>
  {kind==='video'&&<section><h3>音频</h3><div className="ca-parameter-choices">{options.audioToggle?<><button className={generateAudio!==false?'selected':''} onClick={()=>onGenerateAudio?.(true)}>含音频</button><button className={generateAudio===false?'selected':''} onClick={()=>onGenerateAudio?.(false)}>静音</button></>:<button type="button" disabled={generateAudio!==false} onClick={()=>onGenerateAudio?.(true)}>模型默认</button>}</div></section>}
   {imageQualities.length>0&&<section><h3>图片画质</h3><div className="ca-parameter-choices" role="group" aria-label="图片画质">
     {imageQualities.map(option=><button key={option.value} type="button"
       title={option.label}
       aria-pressed={imageQuality===option.value} className={imageQuality===option.value?'selected':''} onClick={()=>onImageQuality?.(option.value)}>{option.label}</button>)}
   </div></section>}
   <section><h3>{kind==='image'?'输出格式':'时长'}{kind==='video'&&<span className="ca-video-billing-unit">{memberVideoBillingText(memberBilling,resolution)}</span>}</h3><div className="ca-parameter-choices">{kind==='image'?['PNG','JPEG'].map(f=><button key={f} className={format===f?'selected':''} onClick={()=>onFormat(f)}>{f}{format===f&&<Check size={10}/>}</button>):<div className="ca-video-duration"><input style={{'--progress':(currentDurationIndex/Math.max(1,options.durationTargets.length-1)*100)+'%'} as CSSProperties} aria-label="视频时长" aria-valuetext={currentDuration+' 秒'} type="range" min={0} max={Math.max(0,options.durationTargets.length-1)} step={1} value={currentDurationIndex} disabled={options.durationTargets.length<2} onChange={e=>onDuration(options.durationTargets[Number(e.target.value)]??currentDuration)}/><p style={{display:'flex',justifyContent:'space-between'}}><span>{options.durationMin}s</span><strong>{currentDuration}s</strong><span>{options.durationMax}s</span></p>{nativeMax>0&&currentDuration>nativeMax&&<small>此时长将分段生成</small>}</div>}</div></section>
 </AnchoredPanel>;
}
export function ImageExample({name}:{name:string}){const item=observedImage(name);return <div className="ca-image-example"><h2>{item?.example.title||'图片创作'}</h2><p>{item?.example.description||'上传参考图片，描述你的想法'}</p><div>{(item?.example.images.length?item.example.images:[observed.genericImage]).map((src,i)=><img key={src} src={src} alt={`${name}参考示例 ${i+1}`}/>)}</div></div>;}
export function DirectorPanel(props:DirectorPanelProps){return <DirectorConversationPanel {...props}/>;}

export function slotFromObserved(s:{key:string;label:string;min:number;max:number;kinds:string[];cover:string}):MaterialSlot{return {id:s.key,label:s.label,min:s.min,max:s.max,kinds:s.kinds as MaterialSlot['kinds']};}
