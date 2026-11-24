'use client';
import './video-model-picker.css';
import {useLayoutEffect,useRef,useState} from 'react';
import {videoPickerProfile,videoFamilyIcons} from '../../shared/video-picker-catalog';

type Choice = {
  id:string; displayName:string; capabilities:Record<string,unknown>; generationReady?:boolean;
  modeCompatible?:boolean; modeIncompatibleReasons?:string[]; readinessMessage?:string; configurationHint?:string;
};
type Props = {items:Choice[];selected:string;onSelect:(id:string)=>void;onClose:()=>void};

export function CommerceVideoPicker({items,selected,onSelect,onClose}:Props) {
  const list=useRef<HTMLDivElement>(null);
  const entries=items.map(model=>({model,profile:videoPickerProfile(model.displayName)}));
  const familyOf=(entry:typeof entries[number])=>entry.profile?.family||'其他模型';
  const families=[...new Set(entries.map(familyOf))];
  const [activeFamily,setActiveFamily]=useState(entries.find(entry=>entry.model.id===selected)?.profile?.family||families[0]);
  useLayoutEffect(()=>{
    const container=list.current;
    const row=container?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if(!container||!row)return;
    const bottom=row.getBoundingClientRect().bottom-container.getBoundingClientRect().bottom;
    if(bottom>0)container.scrollTop+=bottom;
  },[selected]);
  function jump(family:string) {
    const container=list.current;
    const row=container?.querySelector<HTMLElement>('[data-family="'+family+'"]');
    if(!container||!row)return;
    container.scrollTop+=row.getBoundingClientRect().top-container.getBoundingClientRect().top;
    setActiveFamily(family);
    row.focus({preventScroll:true});
  }
  return <>
    <nav aria-label="视频模型系列">{families.map(family=><button type="button" key={family} title={family}
      aria-label={'定位到 '+family} aria-pressed={activeFamily===family} onClick={()=>jump(family)}>
      {family==='其他模型'?'⋯':<img src={videoFamilyIcons[family]} alt=""/>}
    </button>)}</nav>
    <div className="ca-video-model-rows" ref={list}>
      {entries.map(entry=>{
        const {model,profile}=entry;
        const issue=model.modeCompatible===false?model.modeIncompatibleReasons?.join('、'):undefined;
        const status=issue||(model.generationReady===false?model.readinessMessage:'');
        const description=profile?.detail||'';
        return <button type="button" key={model.id} data-family={familyOf(entry)} data-model-id={model.id}
          data-generation-ready={model.generationReady===true} aria-pressed={model.id===selected}
          title={[model.displayName,status].filter(Boolean).join(' · ')}
          aria-label={['选择模型 '+model.displayName,status].filter(Boolean).join('，')}
          onClick={()=>{onSelect(model.id);onClose();}}>
          <span className="ca-video-brand-tile">{profile&&<img src={videoFamilyIcons[profile.family]} alt=""/>}</span>
          <span className="ca-video-option-copy"><span className="ca-video-option-name">{model.displayName}{profile?.name==='Seedance-2.5-Flash'&&<span className="ca-video-new">NEW</span>}</span>
            <span className="ca-video-option-summary">{description}</span></span>
        </button>;
      })}
    </div>
  </>;
}
