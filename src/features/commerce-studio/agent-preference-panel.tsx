'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {SlidersHorizontal,Hand,ShieldCheck,AudioLines} from 'lucide-react';
import {preferenceRatios,preferenceResolutions,type AgentPreferences,type MediaPreferences,type PreferenceMedia,type PreferenceModel} from './agent-preferences';
import './agent-preference-panel.css';

type Props={preferences:AgentPreferences;models:Record<PreferenceMedia,PreferenceModel[]>;pending:boolean;ready:boolean;onChange:(kind:PreferenceMedia,field:keyof MediaPreferences,value:string)=>Promise<boolean>};
const tabs=['审批偏好','视频偏好','图片偏好'] as const;
export function AgentPreferencePanel({preferences,models,pending,ready,onChange}:Props){
 const [open,setOpen]=useState(false),[tab,setTab]=useState<typeof tabs[number]>('审批偏好');
 const [point,place]=useState({left:0,top:0}),[seconds,setSeconds]=useState('');
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null);
 const kind:PreferenceMedia=tab==='图片偏好'?'image':'video',value=preferences[kind];
 useEffect(()=>setSeconds(preferences.video.duration),[preferences.video.duration,open,kind]);
 useLayoutEffect(()=>{if(!open)return;
  function position(){const r=trigger.current?.getBoundingClientRect();if(!r)return;const width=Math.min(670,innerWidth-24),height=Math.min(382,innerHeight-24);place({left:Math.max(12,Math.min(r.left-4,innerWidth-width-12)),top:r.top-height-3>=12?r.top-height-3:Math.max(12,Math.min(r.bottom+8,innerHeight-height-12))});}
  position();const onDown=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setOpen(false);};
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}};
  window.addEventListener('resize',position);document.addEventListener('scroll',position,true);document.addEventListener('pointerdown',onDown);document.addEventListener('keydown',onKey);
  return()=>{window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);document.removeEventListener('pointerdown',onDown);document.removeEventListener('keydown',onKey);};
 },[open]);
 const locked=pending||!ready;
 const choose=(field:keyof MediaPreferences,option:string)=>{if(!locked)void onChange(kind,field,option);};
 function ratioIcon(option:string){
  if(!option)return <i aria-hidden="true"/>;
  const [width,height]=option.split(':').map(Number);
  const size=width<height?36*width/height:40;
  return <i aria-hidden="true" style={{width:size,aspectRatio:width/height}}/>;
 }
 function group(title:string,field:keyof MediaPreferences,options:string[],labels:Record<string,string>={}){
  return <fieldset><legend>{title}</legend><div className={'cs-pref-options'+(field==='ratio'?' cs-pref-ratios':'')}>{['',...options].map(option=><button type="button" key={option} disabled={locked} aria-pressed={value[field]===option} onClick={()=>choose(field,option)}>{field==='ratio'&&ratioIcon(option)}<span>{labels[option]||option||'智能'}</span></button>)}</div></fieldset>;
 }
 return <><button type="button" ref={trigger} className="cs-pref-trigger" aria-expanded={open} aria-haspopup="dialog" onClick={()=>{if(!open)setTab('审批偏好');setOpen(!open);}}><SlidersHorizontal size={15}/>偏好设置</button>{open&&createPortal(<section className={'cs-agent-pref'+(tab==='审批偏好'?' cs-pref-approval-tab':'')} ref={panel} role="dialog" aria-label="Agent 偏好设置" style={point}><div className="cs-pref-left"><nav aria-label="偏好分类">{tabs.map(label=><button key={label} type="button" aria-pressed={tab===label} onClick={()=>setTab(label)}>{label}</button>)}</nav>{tab!=='审批偏好'&&<><h3>模型选择</h3><div className="cs-pref-models">{[{id:'',name:'智能匹配模型',available:true},...models[kind]].map(m=><button type="button" key={m.id} disabled={locked||!m.available} aria-pressed={value.model===m.id} onClick={()=>choose('model',m.id)}><span>{m.id?<AudioLines size={15}/>:<SlidersHorizontal size={15}/>}</span><div><b>{m.name}</b><small>{m.id?m.available?'使用本站模型池中的模型':'当前路由未开放选择':'由 Agent 根据任务选择合适的模型'}</small></div></button>)}</div></>}</div><div className="cs-pref-right">
 {tab==='审批偏好'?<><h3>如何批准 Agent 操作？</h3><div className="cs-pref-approval"><button type="button" aria-pressed="true"><Hand size={16}/><b>请求批准</b><small>需要付费的制作操作由你批准</small></button><button type="button" disabled><ShieldCheck size={16}/><b>自动批准</b><small>本站制作任务目前需要逐笔确认报价</small></button></div></>:<>{group(kind==='image'?'图片比例':'视频比例','ratio',preferenceRatios[kind])}{group('分辨率','resolution',preferenceResolutions[kind],kind==='video'?{'480P':'标清 480P','720P':'高清 720P','1080P':'超清 1K'}:{'1K':'标清 1K','2K':'高清 2K','4K':'超清 4K'})}{kind==='video'?<fieldset><legend>时长</legend><div className="cs-pref-range"><input type="range" min="0" max="60" step="1" aria-label="视频时长" disabled={locked} value={Number(seconds)||0} onChange={e=>setSeconds(e.target.value==='0'?'':e.target.value)} onBlur={()=>{if(seconds!==value.duration)choose('duration',seconds);}} onPointerUp={e=>{const n=e.currentTarget.value;choose('duration',n==='0'?'':n);}} onKeyUp={e=>{if(['ArrowRight','ArrowLeft','Home','End','PageUp','PageDown','ArrowDown','ArrowUp'].includes(e.key))choose('duration',e.currentTarget.value==='0'?'':e.currentTarget.value);}}/><span>{seconds?seconds+' 秒':'智能'}</span><span>60 秒</span></div></fieldset>:<>{group('图片画质','quality',['标准','高','超高'])}{group('输出格式','format',['PNG','JPEG'])}</>}<small>智能：由 Agent 根据任务选择合适的配置。</small></>}
 </div></section>,document.body)}</>;
}
