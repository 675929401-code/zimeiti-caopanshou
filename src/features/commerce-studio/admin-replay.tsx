'use client';
import { useState } from 'react';
import { createImageReferenceDocument, reconcileImageReferenceDocument, type ImageReferenceInstance } from '@/commerce/shared/image-reference-mentions';
import type { CommerceDirectorBinding } from '@/components/admin/commerce-director-bindings-panel';
const sampleText='让 @图片2 的演示者在 @图片3 的位置拿起 @图片1 的杯子并打开蓝色杯盖，最后特写 @图片1。保留参考光线，忽略海报，不添加文字。';
const base:ImageReferenceInstance[]=[
  {instanceId:'ref-product',assetId:'sample-cup-blue',slot:'product',name:'蓝盖杯'},
  {instanceId:'ref-presenter',assetId:'sample-person-apron',slot:'person',name:'浅色围裙演示者'},
  {instanceId:'ref-location',assetId:'sample-window',slot:'place',name:'窗边桌面'}
];
const roles=['product','person','place'];
export function AdminReplay({bindings,job}:{bindings:CommerceDirectorBinding[];job?:{id:string;status:string}|null}){
  const [sample,setSample]=useState('window'),[selected,setSelected]=useState(''),input=sampleText;
  const [result,setResult]=useState<{label:string;rows:{title:string;prompt:string;assets:string[]}[];refs:string[];version:string;unresolved:boolean}|null>(null);
  const binding=bindings.find(b=>b.key===selected)||bindings[0];
  function replay(){
    const source=createImageReferenceDocument(input,base,roles);
    const refs=sample==='missing'?base.filter(r=>r.slot!=='person'):base.map(r=>sample==='night'&&r.slot==='place'?{...r,assetId:'sample-night-counter',name:'夜间柜台'}:r);
    const doc=sample==='night'?createImageReferenceDocument(input,refs,roles):reconcileImageReferenceDocument(source,refs,roles);
    const missing=doc.mentions.some(m=>m.status!=='resolved');
    const used=(...slots:string[])=>[...new Set(doc.mentions.filter(m=>m.assetId&&m.slot&&slots.includes(m.slot)&&m.status==='resolved').map(m=>m.assetId!))];
    const place=refs.find(r=>r.slot==='place')?.name||'待指定场地';
    setResult({label:sample==='night'?'夜间柜台':sample==='missing'?'缺人物参考':'窗边桌面',rows:missing?[]:[
      {title:'拿起杯子',prompt:'演示者在'+place+'拿起蓝盖杯，保留场地光线，忽略背景海报。',assets:used('product','person','place')},
      {title:'打开杯盖',prompt:'近景记录开盖动作，保持蓝色杯盖与围裙外观。',assets:used('product','person')},
      {title:'杯盖特写',prompt:'特写蓝色杯盖，不添加文字。',assets:used('product')}],
      refs:doc.mentions.map(m=>m.label+' → '+(m.status==='resolved'?m.assetId:'缺少引用')),version:binding?.prompt?.versionId||binding?.prompt?.id||'未绑定',unresolved:missing});
  }
  return <section className="cs-admin-replay" aria-label="示例回放／拆解对照"><h3>示例回放／拆解对照</h3>
    <div className="cs-replay-select"><label>样本<select value={sample} onChange={e=>{setSample(e.target.value);setResult(null);}}><option value="window">蓝盖杯 · 窗边桌面</option><option value="night">仅换场景 · 夜间柜台</option><option value="missing">移除已引用人物</option></select></label>
    <label>编导配置<select value={binding?.key||''} onChange={e=>{setSelected(e.target.value);setResult(null);}}>{bindings.map(b=><option value={b.key} key={b.key}>{b.name} · v{b.prompt?.version??'—'}</option>)}</select></label><button onClick={replay}>运行离线回放</button></div>
    <div className="cs-replay-columns"><div><h4>原始叙述与素材职责</h4><p>{input}</p>
    {base.map((r,i)=><p key={r.instanceId}>@图片{i+1} · {['商品','演示者','场景'][i]} · {sample==='night'&&i===2?'夜间柜台':sample==='missing'&&i===1?'已移除':r.name}</p>)}</div>
    <div><h4>逐镜对照</h4>{result?<>{result.refs.map((r,i)=><small key={i}>{r}</small>)}{result.unresolved?<p role="alert">人物参考缺失，请重新绑定后再运行。</p>:result.rows.map(row=><article key={row.title}><b>{row.title}</b><p>{row.prompt}</p><small>{row.assets.join(' · ')}</small></article>)}</>:<p>选择样本后运行，核对每处引用与逐镜职责。</p>}</div></div>
    <footer>离线固定样例 · 无模型调用与扣费{result&&' · 对照配置 '+result.version}{job&&' · 独立真实验收任务 '+job.id+'（'+job.status+'）'}</footer></section>;
}
