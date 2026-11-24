'use client';
import {useState,useRef} from 'react';
import {api,type UIAsset} from '@/commerce/components/commerce-agent/runtime-ui';
import {deliverySizes,speechRates,type Cut,type DeliverySize,type SourceVideoInfo,type VideoInspection,type VideoProductionSkill} from '@/commerce/shared/member-video-production';
import './video-production-action.css';

type Result={asset:UIAsset;result:SourceVideoInfo;checks?:VideoInspection['checks'];unchanged?:boolean};
type Segment=Cut&{included:boolean};
const metric=(v:SourceVideoInfo)=>[v.width+'×'+v.height,v.codec.toUpperCase(),v.audioCodec?v.audioCodec.toUpperCase():'无音轨',v.duration.toFixed(2)+' 秒',v.fps?v.fps+' fps':'',v.bitrateKbps?v.bitrateKbps+' kb/s':''].filter(Boolean).join(' · ');

export function VideoProductionAction({skill,source}:{skill:VideoProductionSkill;source:UIAsset}){
  const [data,setData]=useState<VideoInspection|null>(null),[cuts,setCuts]=useState<Segment[]>([]);
  const [start,setStart]=useState(''),[end,setEnd]=useState(''),[rate,setRate]=useState(1);
  const [size,setSize]=useState<DeliverySize>('720x1280'),[mbps,setMbps]=useState(4);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null);
  const locked=useRef(false),player=useRef<HTMLVideoElement>(null);
  const ad=skill==='ad-spec';
  const [adMode,setAdMode]=useState<'vertical'|'custom'>('vertical');
  async function processVideo(action:'inspect'|'export'){
    if(locked.current)return;
    locked.current=true;setBusy(true);setError('');setResult(null);
    try{
      const input={skill,action,assetId:source.id};
      if(action==='inspect'){
        const inspected=await api<VideoInspection>('/api/commerce/studio/video-production',input);
        setData(inspected);setCuts(inspected.pauses.map(c=>({...c,included:true})));
      }else{
        setResult(await api<Result>('/api/commerce/studio/video-production',{...input,adMode:ad?adMode:undefined,size,mbps,rate,cuts:cuts.filter(c=>c.included).map(({start,end})=>({start,end}))}));
      }
    }catch(e){setError((e as Error).message);}finally{setBusy(false);locked.current=false;}
  }
  function addCut(){
    const from=Number(start),to=Number(end);
    if(!data||start===''||end===''||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to>data.source.duration){setError('请填写原片内有效的起止秒数');return;}
    setCuts(v=>[...v,{start:from,end:to,included:true}]);setError('');setResult(null);setStart('');setEnd('');
  }
  return <div className="cs-video-production">
    <video ref={player} aria-label="源视频预览" src={source.url} controls preload="metadata"/>
    <button type="button" disabled={busy} onClick={()=>void processVideo('inspect')}>{busy?'正在处理…':ad?'读取素材规格':'分析口播停顿'}</button>
    {data&&<fieldset disabled={busy} onChange={()=>setResult(null)}><legend>原片规格</legend>
      <p>{metric(data.source)}</p>
      {ad?<><label>适配方式 <select value={adMode} onChange={e=>setAdMode(e.target.value==='custom'?'custom':'vertical')}><option value="vertical">千川竖版自动适配</option><option value="custom">自定义转码</option></select></label>
        {adMode==='vertical'?<><ul>{data.checks?.map(c=><li key={c.name}>{c.pass?'通过':'需处理'} · {c.name}</li>)}</ul>
          <p>符合规格可直接下载原片，需修正的素材将在转码后重新检查。</p></>:<><label>输出尺寸 <select value={size} onChange={e=>setSize(e.target.value as DeliverySize)}>{Object.keys(deliverySizes).map(v=><option key={v}>{v}</option>)}</select></label>
        <label>目标视频码率 <select value={mbps} onChange={e=>setMbps(Number(e.target.value))}>{[2,4,6,8,12].map(n=><option key={n} value={n}>{n} Mb/s</option>)}</select></label>
        <p>按所选规格等比缩放并补边，输出 H.264 MP4。</p></>}</>:<>
        <p>{data.pauses.length?'勾选要删减的区间，可试听后调整。':'没有检测到长停顿，可手动标记重复或需要删减的片段。'}</p>
        <div className="cs-cut-list">{cuts.map((c,i)=><div key={i}><label><input type="checkbox" checked={c.included} onChange={e=>setCuts(all=>all.map((v,j)=>j===i?{...v,included:e.target.checked}:v))}/>{c.start.toFixed(2)}–{c.end.toFixed(2)} 秒</label>
          <button type="button" onClick={()=>{if(player.current){player.current.currentTime=Math.max(0,c.start-0.3);void player.current.play().catch(()=>{});}}}>试听</button></div>)}</div>
        <div className="cs-cut-range"><label>开始秒 <input type="number" min="0" step="0.01" value={start} onChange={e=>setStart(e.target.value)}/></label>
          <label>结束秒 <input type="number" min="0" step="0.01" value={end} onChange={e=>setEnd(e.target.value)}/></label>
          <button type="button" onClick={addCut}>添加删减区间</button></div>
        {skill==='speech-pace'&&<label>播放速度 <select value={rate} onChange={e=>setRate(Number(e.target.value))}>{speechRates.map(n=><option key={n} value={n}>{n}×</option>)}</select></label>}
      </>}
      <button type="button" onClick={()=>void processVideo('export')}>导出并保存视频</button>
    </fieldset>}
    {error&&<p role="alert">{error}</p>}
    {result&&<div>{result.checks&&<p role="status">{result.unchanged?'原片通过规格检查，已保留原文件':'转码完成，已复核交付规格'} · {result.checks.filter(c=>c.pass).length}/{result.checks.length} 项通过</p>}
      <video aria-label="导出成片预览" src={result.asset.url} controls preload="metadata"/><p>{metric(result.result)}</p><a href={result.asset.url+'?download=1'} download={result.asset.name}>下载成片</a></div>}
  </div>;
}
