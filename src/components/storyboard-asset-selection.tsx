'use client';

import type { StoryboardVisualAssetPlan } from '@/lib/storyboard-workbench';
import './storyboard-asset-selection.css';

type Props = {
  plan: StoryboardVisualAssetPlan;
  assetIds: string[];
  disabled: boolean;
  segmentNumber?: number;
  mode?: 'project' | 'custom';
  referenceCount?: number;
  onChange: (assetIds: string[], mode?: 'project' | 'custom') => void;
};
export function StoryboardAssetSelection(props: Props) {
  const segment = props.segmentNumber;
  const title = segment ? '本段参考' : '项目默认参考';
  const label = segment ? '分段' + segment : '项目默认';
  return <details className="sbw-asset-selection" aria-label={label + '参考选择'}>
    <summary>{title} · {segment ? props.referenceCount + ' 张实际引用' : props.assetIds.length + ' 项'}{segment && props.mode === 'project' ? ' · 跟随项目' : segment ? ' · 单独选择' : ''}</summary>
    {segment ? <label className="sbw-asset-mode">引用方式<select aria-label={label + '参考方式'} value={props.mode || 'custom'} disabled={props.disabled} onChange={event => props.onChange(props.assetIds, event.target.value as 'project' | 'custom')}><option value="project">使用项目默认</option><option value="custom">单独选择</option></select></label> : <p>默认参考用于跟随项目的分段。背景最多选一张；新增场景可在各分段单独选择。</p>}
    <div className="sbw-asset-options">{props.plan.assets.map(asset => {
      const checked = props.assetIds.includes(asset.id);
      const disabled = props.disabled || Boolean(segment && props.mode === 'project');
      return <label key={asset.id}><input type="checkbox" aria-label={label + '选择' + asset.name} checked={checked} disabled={disabled} onChange={() => {
        let ids = props.assetIds.filter(id => id !== asset.id);
        if (!checked) {
          if (!segment && asset.role === 'environment') ids = ids.filter(id => props.plan.assets.find(item => item.id === id)?.role !== 'environment');
          ids.push(asset.id);
        }
        props.onChange(ids, segment ? 'custom' : undefined);
      }} />{asset.name}<small>{asset.role === 'environment' ? '背景' : asset.role === 'pet' ? '宠物' : asset.role === 'character' ? '人物' : '道具'}</small></label>;
    })}</div>
    {segment && <p>单独选择可全部取消，用于无人、无宠物或纯示意镜头。已提交任务沿用提交时的参考。</p>}
  </details>;
}
