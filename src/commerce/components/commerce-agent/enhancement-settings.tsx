'use client';

import {useState} from 'react';
import {ChevronDown, SlidersHorizontal, Sparkles} from 'lucide-react';
import {AnchoredPanel} from './reference-ui';

const resolutions = [[720,'720P'],[1080,'1080P'],[1440,'2K'],[2160,'4K']] as const;
export function EnhancementSettings({resolution, fps, setResolution, setFps}: {
  resolution:number; fps:number; setResolution:(value:number)=>void; setFps:(value:number)=>void;
}) {
  const [open,setOpen]=useState<'version'|'settings'|null>(null);
  const resolutionLabel=resolutions.find(([size])=>size===resolution)?.[1]??'1080P';
  return <div className="cs-enhance-settings">
    <button type="button" data-popover-trigger aria-expanded={open==='version'} onClick={()=>setOpen(open==='version'?null:'version')}>
      <Sparkles size={15}/><span><small>版本</small><strong>标准版</strong></span><ChevronDown size={12}/>
    </button>
    <button type="button" data-popover-trigger aria-expanded={open==='settings'} onClick={()=>setOpen(open==='settings'?null:'settings')}>
      <SlidersHorizontal size={15}/><span><small>视频设置</small><strong>{resolutionLabel} · {fps?fps+'fps':'无'}</strong></span><ChevronDown size={12}/>
    </button>
    {open&&<AnchoredPanel key={open} label={open==='version'?'增强版本':'视频设置'} onClose={()=>setOpen(null)}>
      {open==='version'?<div className="cs-enhance-versions">
        <button type="button" aria-pressed="true" onClick={()=>setOpen(null)}><strong>标准版</strong><small>本地降噪、放大与锐化</small></button>
        <button type="button" disabled><strong>大模型版</strong><small>生成式细节重绘 · 通道待配置</small></button>
        <button type="button" disabled><strong>专业版</strong><small>专业增强通道待配置</small></button>
      </div>:<>
        <fieldset><legend>分辨率</legend>{resolutions.map(([size,label])=><button type="button" key={size} aria-pressed={resolution===size} onClick={()=>setResolution(size)}>{label}</button>)}</fieldset>
        <fieldset><legend>补帧</legend>{[0,30,60].map(value=><button type="button" key={value} aria-pressed={fps===value} onClick={()=>setFps(value)}>{value?value+'fps':'无'}</button>)}</fieldset>
      </>}
    </AnchoredPanel>}
  </div>;
}
