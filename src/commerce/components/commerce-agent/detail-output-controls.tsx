'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DETAIL_QUALITY_OPTIONS } from '../../shared/detail-image-quality';
import { api } from './runtime-ui';
import { AnchoredPanel } from './reference-ui';
import type { DetailConfig } from '../../server/detail-set-schema';

type ModelOption = { id: string; displayName: string; modeCompatible: boolean; capabilities?: { detailImageQualities?: string[]; detailDefaultQuality?: string; resolutionOptions?: string[] }; modeIncompatibleReasons?: string[] };
type Catalog = { models: ModelOption[]; userSelectable: boolean; defaultModelId: string | null; configurationMessage?: string };

export function DetailOutputControls({config, disabled, references, change}: {
  config: DetailConfig; disabled: boolean; references: number; change: (patch: Partial<DetailConfig>) => void;
}) {
  const [open, setOpen] = useState<'model' | 'settings' | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setCatalog(null); setFailure(false);
    const params = new URLSearchParams({kind:'image', operationId:'detail-set.generate',
      referenceImages:String(Math.max(1, references)), resolution:config.resolution});
    if (config.target_ratio) params.set('aspectRatio', config.target_ratio);
    api<Catalog>('/api/commerce/models?' + params).then(result => {
      if (current) setCatalog(result);
    }).catch(() => { if (current) setFailure(true); });
    return () => { current = false; };
  }, [references, config.resolution, config.target_ratio, attempt]);
  const activeId = config.image_model_id || catalog?.defaultModelId;
  const activeModel = catalog?.models.find(m => m.id === activeId);
  const activeName = activeModel?.displayName;
  const capabilities = activeModel?.capabilities;
  const qualities = capabilities?.detailImageQualities || [];
  const selectedQuality = config.image_quality || capabilities?.detailDefaultQuality;
  const qualityLabel = DETAIL_QUALITY_OPTIONS.find(option => option.value === selectedQuality && qualities.includes(option.value))?.label;
  const resolutions = capabilities?.resolutionOptions;
  const staleQuality = !!catalog && !!config.image_quality && !qualities.includes(config.image_quality);
  return <div className="cs-detail-output-controls">
    <button type="button" data-popover-trigger aria-label="模型" aria-expanded={open==='model'} disabled={disabled}
      onClick={() => setOpen(open==='model' ? null : 'model')}><small>模型</small><b>{activeName || (failure?'目录读取失败':!catalog?'读取中…':config.image_model_id?'已选模型暂不可用':'后台默认模型')}</b><ChevronDown size={14}/></button>
    <button type="button" data-popover-trigger aria-label="图片设置" aria-expanded={open==='settings'} disabled={disabled}
      onClick={() => setOpen(open==='settings' ? null : 'settings')}><small>图片设置</small><b>{[config.resolution, qualityLabel, config.output_format].filter(Boolean).join(' · ')}</b><ChevronDown size={14}/></button>
    {open && <AnchoredPanel onClose={() => setOpen(null)} label={open==='model'?'商详出图模型':'商详图片设置'} className={'cs-detail-output-panel'+(open==='settings'?' cs-detail-settings-panel':'')}>
      {open==='model' ? <>
        <strong>商详出图模型</strong>
        {failure && <button type="button" onClick={() => setAttempt(n=>n+1)}>重新读取模型目录</button>}
        {catalog?.configurationMessage && <p>{catalog.configurationMessage}</p>}
        {catalog?.userSelectable || config.image_model_id ? <button type="button" aria-pressed={!config.image_model_id} onClick={() => {change({image_model_id:undefined,image_quality:undefined});setOpen(null);}}>使用后台默认模型</button> : null}
        {catalog?.models.map(model => <button key={model.id} type="button" aria-pressed={model.id===activeId}
          disabled={!catalog.userSelectable || !model.modeCompatible} title={model.modeIncompatibleReasons?.join('、')}
          onClick={() => {change({image_model_id:model.id,image_quality:undefined});setOpen(null);}}>{model.displayName}</button>)}
        {catalog && !catalog.userSelectable && <p>管理员已为商详出图指定模型。</p>}
      </> : <>
        <div className="cs-output-setting" role="group" aria-label="分辨率">
          <div className="cs-output-title">分辨率</div>
          <div className="cs-output-choices">{(['1K','2K','4K'] as const).map((value,i)=><button key={value} type="button" disabled={disabled || (!!resolutions?.length && !resolutions.includes(value))}
            aria-pressed={config.resolution===value} onClick={()=>change({resolution:value})}>{['标清','高清','超清'][i]} {value}</button>)}</div>
        </div>
        <div className="cs-output-setting" role="group" aria-label="图片画质">
          <div className="cs-output-title">图片画质{config.image_quality ? <button type="button" disabled={disabled} onClick={()=>change({image_quality:undefined})}>{staleQuality?'所选画质不可用 · 使用模型默认':'使用模型默认'}</button> :
            !qualities.length && <small>{!catalog ? failure?'目录读取失败':'读取中…':'由模型控制'}</small>}</div>
          <div className="cs-output-choices">{DETAIL_QUALITY_OPTIONS.map(option=><button key={option.value} type="button" disabled={disabled || !qualities.includes(option.value)}
            aria-pressed={qualities.includes(option.value) && selectedQuality===option.value} onClick={()=>change({image_quality:option.value})}>{option.label}</button>)}</div>
        </div>
        <div className="cs-output-setting" role="group" aria-label="输出格式">
          <div className="cs-output-title">输出格式</div>
          <div className="cs-output-choices">{(['PNG','JPEG'] as const).map(value=><button key={value} type="button" disabled={disabled} aria-pressed={config.output_format===value} onClick={()=>change({output_format:value})}>{value}</button>)}</div>
        </div>
      </>}
    </AnchoredPanel>}
  </div>;
}
