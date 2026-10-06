'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowUp,ChevronDown,Copy,LoaderCircle,Search,X,Check} from 'lucide-react';
import observed from './observed-catalog.json';
import type {Runtime} from './runtime-ui';
import {ScriptContent} from './script-content';
import type {MaterialSlot} from './catalog';
import {DirectorConversationPanel,type DirectorPanelProps} from './director-conversation';
import {
 commerceVideoNativeDurationOptions,
  commerceVideoResolutionOptions,
  commerceVideoSupportsAudioToggle,
  commerceVideoTargetDurations,
  COMMERCE_VIDEO_MAX_TOTAL_DURATION,
} from '../../shared/video-generation-capabilities';

export const DIRECTORS=observed.directors;
export const observedImage=(name:string)=>observed.images.find(s=>s.name===name)||(name==='图片创作'?observed.images.find(s=>s.default):undefined);
export const PUBLIC_UI=observed;
export function AnchoredPanel({children,onClose,className='',label}:{children:ReactNode;onClose:()=>void;className?:string;label:string}){
 const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{const prior=document.activeElement as HTMLElement|null;const frame=requestAnimationFrame(()=>ref.current?.querySelector<HTMLElement>('input,button,select')?.focus());function key(e:KeyboardEvent){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close.current();}if(e.key==='Tab'){const buttons=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]')||[]).filter(e=>e.getClientRects().length);if(!buttons.length)return;const first=buttons[0],last=buttons.at(-1)!;if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}function outside(e:PointerEvent){if(!ref.current?.contains(e.target as Node)&&!(e.target as Element).closest('[data-popover-trigger]'))close.current();}document.addEventListener('keydown',key,true);document.addEventListener('pointerdown',outside);return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',outside);prior?.focus();};},[]);
 return <div ref={ref} role="dialog" aria-label={label} className={'ca-anchored-panel '+className}>{children}</div>;
}
type PickItem={id:string;name:string;description:string;category:string;icon?:string;recommended?:boolean;order?:number};
export function CreationPicker({items,kind,onPick,onClose}:{items:PickItem[];kind:'image'|'video';onPick:(id:string)=>void;onClose:()=>void}){
 const [category,setCategory]=useState('推荐'),[query,setQuery]=useState(''),[search,setSearch]=useState(false);
 const categories=['推荐',...(kind==='image'?['人物','商品','场景','增强']:['电商带货','同城到店','品牌广告','剧情短片'])];
 const visible=items.filter(i=>(query||category==='推荐'?query||i.recommended:i.category===category)&&(i.name+i.description).includes(query)).sort((a,b)=>(a.order||0)-(b.order||0));
 return <AnchoredPanel onClose={onClose} label={kind==='image'?'选择图片技能':'选择视频编导'} className="ca-creation-picker"><header><strong>你想创作什么？</strong><span>让每一个想法，都能成为{kind==='image'?'画面':'影像'}</span></header><nav>{categories.map(c=><button key={c} className={category===c?'selected':''} onClick={()=>{setCategory(c);setQuery('');}}>{c}</button>)}<button aria-label="搜索创作技能" onClick={()=>setSearch(!search)}><Search size={13}/>搜一搜</button></nav>{search&&<input autoFocus aria-label="搜索图片或编导技能" placeholder="搜索技能" value={query} onChange={e=>setQuery(e.target.value)}/>}<div className="ca-creation-cards">{visible.map(item=><button key={item.id} onClick={()=>onPick(item.id)}>{item.icon&&<img src={item.icon} alt=""/>}<span><strong>{item.name}</strong><small>{item.description}</small></span></button>)}</div>{!visible.length&&<p>没有找到相关技能</p>}<footer>更多技能持续上线中</footer></AnchoredPanel>;
}
type ModelChoice={id:string;displayName:string;capabilities:Record<string,unknown>;verified?:boolean;generationReady?:boolean;readinessMessage?:string;configurationHint?:string;modeCompatible?:boolean;modeIncompatibleReasons?:string[];tier?:number;tierLabel?:string};
export function ModelPopover({items,selected,onSelect,onClose}:{items:ModelChoice[];selected:string;onSelect:(id:string)=>void;onClose:()=>void}){
 return <AnchoredPanel onClose={onClose} label="选择生成模型" className="ca-model-popover"><strong>选择模型</strong><small>按当前素材与设置实时核对；费用以提交前报价为准。</small>{[...items].sort((a,b)=>(b.tier||1)-(a.tier||1)).map(m=>{
  const disabled=m.capabilities.available===false||m.modeCompatible===false;
  const status=m.capabilities.available===false?'渠道暂不可用':m.modeCompatible===false?(m.modeIncompatibleReasons?.join('；')||'与当前参数不兼容'):m.generationReady===false?(m.readinessMessage||'生成验收中'):m.capabilities.supportsReferenceInput||m.capabilities.supportsImageInput?'支持参考素材':'文字生成';
  return <button key={m.id} data-model-id={m.id} data-generation-ready={m.generationReady===true?'true':'false'} data-selection-compatible={disabled?'false':'true'} aria-label={`选择模型 ${m.displayName}；${status}${m.configurationHint?`；${m.configurationHint}`:''}`} className={m.id===selected?'selected':''} disabled={disabled} title={[status,m.configurationHint].filter(Boolean).join(' · ')} onClick={()=>{if(disabled)return;onSelect(m.id);onClose();}}><span>{m.displayName}{m.tierLabel&&<small>{m.tierLabel}</small>}<small>{status}</small>{m.configurationHint&&<small className="ca-model-configuration-hint">{m.configurationHint}</small>}</span>{m.id===selected&&<Check size={15}/>}</button>;
 })}</AnchoredPanel>;
}
function strings(value:unknown){return Array.isArray(value)?[...new Set(value.map(String).filter(Boolean))]:[];}
export function mediaSettingsOptions(kind:'image'|'video',capabilities:Record<string,unknown>){
 const configuredRatios=strings(capabilities.aspectRatios);
 const ratios=kind==='image'
  ?['自适应',...(configuredRatios.length?configuredRatios:['16:9','4:3','1:1','3:4','9:16'])]
  :(configuredRatios.length?configuredRatios:['21:9','16:9','4:3','1:1','3:4','9:16']);
 const resolvedVideoResolutions=kind==='video'?commerceVideoResolutionOptions(capabilities):null;
 const configuredResolutions=kind==='video'?(resolvedVideoResolutions?.options||[]):strings(capabilities.resolutionOptions);
 const resolutions=configuredResolutions.length?configuredResolutions:(kind==='video'?['720p']:['1K','2K','4K']);
 const nativeDurations=kind==='video'?commerceVideoNativeDurationOptions(capabilities):[];
 const durationTargets=kind==='video'?commerceVideoTargetDurations(capabilities,{minimum:4,maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION}):[];
 const durationMin=durationTargets[0]||nativeDurations[0]||4;
 const durationMax=durationTargets.at(-1)||nativeDurations.at(-1)||durationMin;
 return {ratios,resolutions,nativeDurations,durationTargets,durationMin,durationMax,audioToggle:kind==='video'&&commerceVideoSupportsAudioToggle(capabilities)};
}
export function MediaSettings({kind,capabilities,modelName,compatibilityIssue,aspectRatio,resolution,format,duration,onRatio,onResolution,onFormat,onDuration,generateAudio,onGenerateAudio,onClose}:{kind:'image'|'video';capabilities:Record<string,unknown>;modelName?:string;compatibilityIssue?:string;aspectRatio:string;resolution:string;format:string;duration:number;onRatio:(s:string)=>void;onResolution:(s:string)=>void;onFormat:(s:string)=>void;onDuration:(n:number)=>void;generateAudio?:boolean;onGenerateAudio?:(b:boolean)=>void;onClose:()=>void}){
 const options=mediaSettingsOptions(kind,capabilities);
 const currentDuration=options.durationTargets.reduce((closest,value)=>Math.abs(value-Number(duration))<Math.abs(closest-Number(duration))?value:closest,options.durationTargets[0]||options.durationMin);
 const currentDurationIndex=Math.max(0,options.durationTargets.indexOf(currentDuration));
 const nativeMax=options.nativeDurations.at(-1)||0;
 return <AnchoredPanel onClose={onClose} label={kind==='image'?'图片设置':'视频设置'} className="ca-media-settings">
  {kind==='video'&&<section><h3>能力核对</h3><p role={compatibilityIssue?'alert':'status'}>{compatibilityIssue||`当前按 ${modelName||'待选择模型'} 的已声明能力显示；素材或设置变化后会重新筛选模型。`}</p></section>}
  <section><h3>{kind==='image'?'图片比例':'视频比例'}</h3><div className="ca-parameter-ratios">{options.ratios.map(r=><button key={r} className={aspectRatio===r?'selected':''} onClick={()=>onRatio(r)}><i style={{aspectRatio:r==='自适应'?'1':r.replace(':','/')}}/>{r}{aspectRatio===r&&<Check size={10}/>}</button>)}</div></section>
  <section><h3>分辨率</h3><div className="ca-parameter-choices">{options.resolutions.map(s=><button key={s} className={resolution.toLowerCase()===s.toLowerCase()?'selected':''} onClick={()=>onResolution(s)}>{kind==='image'?({['1K']:'标清　',['2K']:'高清　',['4K']:'超清　'}[s]):({['480p']:'标清 ',['720p']:'高清 ',['1080p']:'超清 ',['1080P']:'超清 '}[s]||'')}{s}{resolution.toLowerCase()===s.toLowerCase()&&<Check size={10}/>}</button>)}</div></section>
  {kind==='video'&&<section><h3>音频</h3><div className="ca-parameter-choices">{options.audioToggle?<><button className={generateAudio!==false?'selected':''} onClick={()=>onGenerateAudio?.(true)}>含音频{generateAudio!==false&&<Check size={10}/>}</button><button className={generateAudio===false?'selected':''} onClick={()=>onGenerateAudio?.(false)}>静音{generateAudio===false&&<Check size={10}/>}</button></>:<button disabled>跟随模型默认音频</button>}</div></section>}
   <section><h3>{kind==='image'?'输出格式':'视频时长'}</h3><div className="ca-parameter-choices">{kind==='image'?['PNG','JPEG'].map(f=><button key={f} className={format===f?'selected':''} onClick={()=>onFormat(f)}>{f}{format===f&&<Check size={10}/>}</button>):<div><input aria-label="视频时长" type="range" min={0} max={Math.max(0,options.durationTargets.length-1)} step={1} value={currentDurationIndex} disabled={options.durationTargets.length<2} onChange={e=>onDuration(options.durationTargets[Number(e.target.value)]??currentDuration)}/><p style={{display:'flex',justifyContent:'space-between'}}><span>{options.durationMin}s</span><strong>{currentDuration}s</strong><span>{options.durationMax}s</span></p>{nativeMax>0&&currentDuration>nativeMax&&<small>超过单次原生时长时，将按该模型支持的时长自动分段并衔接。</small>}</div>}</div></section>
 </AnchoredPanel>;
}
export function ImageExample({name}:{name:string}){const item=observedImage(name);return <div className="ca-image-example"><h2>{item?.example.title||'图片创作'}</h2><p>{item?.example.description||'上传参考图片，描述你的想法'}</p><div>{(item?.example.images.length?item.example.images:[observed.genericImage]).map((src,i)=><img key={src} src={src} alt={`${name}参考示例 ${i+1}`}/>)}</div></div>;}
export function DirectorPanel(props:DirectorPanelProps){return <DirectorConversationPanel {...props}/>;}

export function slotFromObserved(s:{key:string;label:string;min:number;max:number;kinds:string[];cover:string}):MaterialSlot{return {id:s.key,label:s.label,min:s.min,max:s.max,kinds:s.kinds as MaterialSlot['kinds']};}
