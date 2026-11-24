'use client';
import {useEffect,useId,useRef, type RefObject} from 'react';
import {DIRECTOR_LANGUAGES,DIRECTOR_SCRIPT_MIN as min,DIRECTOR_SCRIPT_MAX as max} from '../../shared/director-parameters';
import './director-parameter-menu.css';

type Props = {
  trigger: RefObject<HTMLButtonElement|null>;
  language: string;
  duration: number;
  disabled: boolean;
  onLanguage: (value:string)=>void;
  onDuration: (value:number)=>void;
  onClose: ()=>void;
};

export function DirectorParameterMenu({trigger,language,duration,disabled,onLanguage,onDuration,onClose}:Props) {
  const menu=useRef<HTMLDivElement>(null);
  const rangeId=useId();
  const percent=(duration-min)*100/(max-min);

  useEffect(()=>{
    const outside=(event:PointerEvent)=>{
      const target=event.target;
      if(target instanceof Node&&!menu.current?.contains(target)&&!trigger.current?.contains(target))onClose();
    };
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape')return;
      event.stopPropagation();
      onClose();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape,true);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);};
  },[onClose,trigger]);

  return <div ref={menu} className="cs-script-parameters" role="dialog" aria-label="编导语言与脚本时长">
    <div className="cs-script-caption" id={rangeId+'-lang'}>语言</div>
    <div className="cs-script-languages" role="group" aria-labelledby={rangeId+'-lang'}>
      {DIRECTOR_LANGUAGES.map(value=><button type="button" key={value} disabled={disabled}
        aria-pressed={value===language} onClick={()=>onLanguage(value)}>{value}</button>)}
    </div>
    <div className="cs-script-duration">
      <label htmlFor={rangeId} className="cs-script-caption">视频时长</label>
      <div className="cs-script-track">
        <input id={rangeId} type="range" aria-label="脚本对应视频时长" aria-valuetext={duration+' 秒'}
          min={min} max={max} step={1} value={duration} disabled={disabled} onChange={e=>onDuration(e.currentTarget.valueAsNumber)}
          style={{backgroundImage:`linear-gradient(to right, #171717 ${percent}%, #efefef ${percent}%)`}}/>
        <div className="cs-script-stops">
          <button type="button" disabled={disabled} aria-pressed={duration===min} onClick={()=>onDuration(min)}>{min}s</button>
          {duration!==min&&duration!==max&&<output htmlFor={rangeId} style={{left:`clamp(22px, ${percent}%, calc(100% - 24px))`}}>{duration}s</output>}
          <button type="button" disabled={disabled} aria-pressed={duration===max} onClick={()=>onDuration(max)}>{max}s</button>
        </div>
      </div>
    </div>
  </div>;
}