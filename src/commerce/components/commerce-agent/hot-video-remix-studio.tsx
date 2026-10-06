'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowDown,ArrowLeft,ArrowUp,CheckCircle2,Clock3,Download,Film,FolderOpen,LoaderCircle,Music,Play,RefreshCw,Trash2,Video} from 'lucide-react';
import {AssetPicker} from './asset-picker';
import {api,type Runtime,type UIAsset} from './runtime-ui';
import type {MaterialSlot} from './catalog';
import './hot-video-remix.css';

type AspectRatio='9:16'|'16:9'|'1:1';
type ClipMode='automatic'|'manual';
type RemixStatus='queued'|'running'|'succeeded'|'failed';
type Snapshot={assetId:string;name:string;type:string;size:number;sha256:string;duration:number;hasAudio:boolean};
type Clip={assetId:string;start:number;duration:number;order:number};
type ClipDraft={start:string;duration:string};
type RemixSettings={targetDuration:number;aspectRatio:AspectRatio;preserveSourceAudio:boolean;bgmVolume:number;width:number;height:number;fps:number};
type ResultAsset={id:string;name:string;type:string;size:number;sha256:string;createdAt:string|number;source:string;jobId?:string;url?:string};
type RemixQuote={
 id:string;quoteId:string;requestId:string;createdAt:string|number;expiresAt:string|number;inputFingerprint:string;
 sourceSnapshots:Snapshot[];bgmSnapshot?:Snapshot;clipPlan:Clip[];settings:RemixSettings;
 pricing:{currency:'CNY';payableTotal:number;estimatedTotalCost:number;billingUnit:'local_free'};
 execution:{engine:'local-ffmpeg';networkRequired:false;walletRequired:false};
};
type RemixJob={
 id:string;quoteId:string;requestId:string;status:RemixStatus;createdAt:string|number;updatedAt:string|number;
 startedAt?:string|number;finishedAt?:string|number;progress:number;settings:RemixSettings;
 sourceSnapshots:Snapshot[];bgmSnapshot?:Snapshot;clipPlan:Clip[];events:{at:string|number;stage:string}[];
 resultAsset?:ResultAsset;error?:string;recoveryAttempts?:number;recoveredAt?:string|number;
};

const sourceSlot:MaterialSlot={id:'hot-remix-source',label:'二创源视频',min:1,max:3,kinds:['video']};
const bgmSlot:MaterialSlot={id:'hot-remix-bgm',label:'背景音乐',min:0,max:1,kinds:['audio']};
const statusText:Record<RemixStatus,string>={queued:'排队中',running:'处理中',succeeded:'已完成',failed:'处理失败'};

function dateText(value:string|number|undefined){if(value===undefined)return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN');}
function sizeText(bytes:number){return bytes>=1024*1024?`${(bytes/1024/1024).toFixed(2)} MB`:`${Math.max(0,Math.round(bytes/1024))} KB`;}
function resultUrl(job:RemixJob){return job.resultAsset?.url||job.resultAsset&&`/api/commerce/assets/${encodeURIComponent(job.resultAsset.id)}`||'';}
function secondsText(milliseconds:number){return (milliseconds/1000).toFixed(3).replace(/\.?0+$/,'');}
function clipNumber(value:string|undefined){return value?.trim()?Number(value):Number.NaN;}
function equalClipDrafts(sources:UIAsset[],targetDuration:number){
 if(!sources.length)return {} as Record<string,ClipDraft>;
 const totalMilliseconds=Math.round(targetDuration*1000),base=Math.floor(totalMilliseconds/sources.length);
 return Object.fromEntries(sources.map((asset,index)=>[asset.id,{start:'0',duration:secondsText(index===sources.length-1?totalMilliseconds-base*index:base)}]));
}

export function HotVideoRemixStudio({runtime,onBack,onNotice}:{runtime:Runtime;onBack:()=>void;onNotice:(message:string)=>void}){
 const [sources,setSources]=useState<UIAsset[]>([]),[bgm,setBgm]=useState<UIAsset|undefined>();
 const [targetDuration,setTargetDuration]=useState(30),[aspectRatio,setAspectRatio]=useState<AspectRatio>('9:16');
 const [clipMode,setClipMode]=useState<ClipMode>('automatic'),[clipDrafts,setClipDrafts]=useState<Record<string,ClipDraft>>({});
 const [preserveSourceAudio,setPreserveSourceAudio]=useState(true),[bgmVolume,setBgmVolume]=useState(0.18);
 const [picker,setPicker]=useState<'sources'|'bgm'|''>(''),[quote,setQuote]=useState<RemixQuote|null>(null);
 const [jobs,setJobs]=useState<RemixJob[]>([]),[selectedJob,setSelectedJob]=useState<RemixJob|null>(null);
 const [busy,setBusy]=useState<'quote'|'confirm'|'refresh'|''>(''),[error,setError]=useState('');
 const request=useRef<{fingerprint:string;id:string}>({fingerprint:'',id:''});
 const mounted=useRef(true);
 const manualClips=useMemo(()=>sources.map(asset=>({assetId:asset.id,start:clipNumber(clipDrafts[asset.id]?.start),duration:clipNumber(clipDrafts[asset.id]?.duration)})),[sources,clipDrafts]);
 const manualTotal=useMemo(()=>manualClips.reduce((sum,clip)=>sum+(Number.isFinite(clip.duration)?clip.duration:0),0),[manualClips]);
 const manualClipError=useMemo(()=>{
  if(clipMode!=='manual'||!sources.length)return '';
  const invalidStart=manualClips.findIndex(clip=>!Number.isFinite(clip.start)||clip.start<0);
  if(invalidStart>=0)return `第 ${invalidStart+1} 段开始秒必须是大于或等于 0 的数字。`;
  const invalidDuration=manualClips.findIndex(clip=>!Number.isFinite(clip.duration)||clip.duration<0.1);
  if(invalidDuration>=0)return `第 ${invalidDuration+1} 段片长必须是大于或等于 0.1 秒的数字。`;
  if(Math.abs(manualTotal-targetDuration)>0.02)return `手动片段合计 ${manualTotal.toFixed(2)} 秒，必须等于目标时长 ${targetDuration.toFixed(2)} 秒。`;
  return '';
 },[clipMode,sources.length,manualClips,manualTotal,targetDuration]);
 const settingsFingerprint=useMemo(()=>JSON.stringify({sourceAssetIds:sources.map(asset=>asset.id),bgmAssetId:bgm?.id||'',targetDuration,aspectRatio,preserveSourceAudio,bgmVolume,clipMode,clipDrafts:sources.map(asset=>clipDrafts[asset.id]||null)}),[sources,bgm,targetDuration,aspectRatio,preserveSourceAudio,bgmVolume,clipMode,clipDrafts]);

 const loadJobs=useCallback(async(silent=false)=>{
  if(!silent)setBusy('refresh');
  try{
   const result=await api<{jobs:RemixJob[]}>('/api/commerce/hot-video-remix');
   if(!mounted.current)return;
   setJobs(result.jobs||[]);
   setSelectedJob(current=>current?(result.jobs||[]).find(job=>job.id===current.id)||current:(result.jobs||[])[0]||null);
   setError('');
  }catch(reason){if(mounted.current&&!silent)setError((reason as Error).message);}
  finally{if(mounted.current&&!silent)setBusy('');}
 },[]);

 useEffect(()=>{mounted.current=true;void loadJobs(true);return()=>{mounted.current=false;};},[loadJobs]);
 useEffect(()=>{setQuote(null);setError('');},[settingsFingerprint]);
 useEffect(()=>{
  if(!jobs.some(job=>job.status==='queued'||job.status==='running'))return;
  const timer=setInterval(()=>void loadJobs(true),3000);
  return()=>clearInterval(timer);
 },[jobs,loadJobs]);

 function addSources(items:UIAsset[]){const next=[...sources,...items.filter(item=>!sources.some(value=>value.id===item.id))].slice(0,3);setSources(next);setClipDrafts(equalClipDrafts(next,targetDuration));setPicker('');}
 function removeSource(assetId:string){const next=sources.filter(value=>value.id!==assetId);setSources(next);setClipDrafts(equalClipDrafts(next,targetDuration));}
 function moveSource(index:number,direction:-1|1){setSources(current=>{const target=index+direction;if(target<0||target>=current.length)return current;const next=[...current];[next[index],next[target]]=[next[target],next[index]];return next;});}
 function updateClip(assetId:string,field:keyof ClipDraft,value:string){setClipDrafts(current=>({...current,[assetId]:{...(current[assetId]||{start:'0',duration:''}),[field]:value}}));}
 function chooseClipMode(mode:ClipMode){setClipMode(mode);if(mode==='manual'&&sources.some(asset=>!clipDrafts[asset.id]))setClipDrafts(equalClipDrafts(sources,targetDuration));}
 async function createQuote(){
  if(!sources.length){setError('请先选择 1–3 个源视频。');return;}
  if(clipMode==='manual'&&manualClipError){setError(manualClipError);return;}
  setBusy('quote');setError('');
  try{
   if(request.current.fingerprint!==settingsFingerprint)request.current={fingerprint:settingsFingerprint,id:crypto.randomUUID()};
   const result=await api<{quote:RemixQuote}>('/api/commerce/hot-video-remix',{action:'quote',requestId:request.current.id,sourceAssetIds:sources.map(asset=>asset.id),...(clipMode==='manual'?{clips:manualClips}:{}),...(bgm?{bgmAssetId:bgm.id}:{}),targetDuration,aspectRatio,preserveSourceAudio,bgmVolume});
   if(mounted.current)setQuote(result.quote);
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }
 async function confirm(){
  if(!quote)return;
  const accepted=window.confirm(`本次任务使用本机 FFmpeg 处理，应付 ¥${quote.pricing.payableTotal.toFixed(2)}，不调用外部模型、不扣主站钱包。是否开始？`);
  if(!accepted)return;
  setBusy('confirm');setError('');
  try{
   const result=await api<{job:RemixJob;created:boolean}>('/api/commerce/hot-video-remix',{action:'confirm',quoteId:quote.quoteId||quote.id});
   if(!mounted.current)return;
   setSelectedJob(result.job);setJobs(current=>[result.job,...current.filter(job=>job.id!==result.job.id)]);
   onNotice(result.created?'二创任务已保存并进入本地处理队列。':'原任务已存在，已读回当前进度。');
   void loadJobs(true);
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }
 async function selectHistory(job:RemixJob){
  setSelectedJob(job);setError('');
  try{const result=await api<{job:RemixJob}>(`/api/commerce/hot-video-remix?id=${encodeURIComponent(job.id)}`);if(mounted.current){setSelectedJob(result.job);setJobs(current=>[result.job,...current.filter(value=>value.id!==result.job.id)]);}}
  catch(reason){if(mounted.current)setError((reason as Error).message);}
 }

 const selectedUrl=selectedJob?resultUrl(selectedJob):'';
 return <section className="ca-hot-remix" aria-label="爆款视频二创工作台">
  <header className="ca-hot-remix-head">
   <button type="button" onClick={onBack}><ArrowLeft size={17}/>返回</button>
   <div><span>本地视频工具</span><h1>爆款视频二创</h1><p>按选定顺序截取 1–3 段源视频，统一画幅、帧率和声音后合成为新成片。</p></div>
   <div className="ca-hot-remix-free"><CheckCircle2 size={18}/><span><strong>¥0.00</strong>本机处理 · 不扣钱包</span></div>
  </header>

  <div className="ca-hot-remix-layout">
   <div className="ca-hot-remix-compose">
    <section className="ca-hot-remix-card">
     <div className="ca-hot-remix-title"><span>1</span><div><h2>源视频与顺序</h2><p>最多 3 个。列表顺序就是成片拼接顺序。</p></div><button type="button" disabled={sources.length>=3||!runtime.ready} onClick={()=>setPicker('sources')}><FolderOpen size={16}/>选择视频</button></div>
     <fieldset className="ca-hot-remix-clip-mode">
      <legend>选片方式</legend>
      <label className={clipMode==='automatic'?'active':''}><input type="radio" name="hot-remix-clip-mode" value="automatic" checked={clipMode==='automatic'} onChange={()=>chooseClipMode('automatic')}/><span><strong>自动均分</strong><small>按素材可用时长确定性分配，从各段中部截取。</small></span></label>
      <label className={clipMode==='manual'?'active':''}><input type="radio" name="hot-remix-clip-mode" value="manual" checked={clipMode==='manual'} onChange={()=>chooseClipMode('manual')}/><span><strong>手动片段</strong><small>逐段填写开始秒和片长，按列表顺序合成。</small></span></label>
     </fieldset>
     {clipMode==='manual'&&sources.length>0&&<div className={`ca-hot-remix-clip-summary ${manualClipError?'invalid':'valid'}`} aria-live="polite"><span>片段合计 <strong>{manualTotal.toFixed(2)} / {targetDuration.toFixed(2)} 秒</strong></span><button type="button" onClick={()=>setClipDrafts(equalClipDrafts(sources,targetDuration))}>按目标时长均分</button></div>}
     {sources.length?<ol className="ca-hot-remix-sources">{sources.map((asset,index)=><li key={asset.id}>
      <video src={asset.url} preload="metadata" muted playsInline/>
      <div className="ca-hot-remix-source-main"><strong><b>{index+1}</b>{asset.name}</strong><small>{sizeText(asset.size)}</small>{clipMode==='manual'&&<div className="ca-hot-remix-clip-fields"><label><span>开始秒</span><input aria-label={`第 ${index+1} 段开始秒`} type="number" min={0} step={0.1} inputMode="decimal" required value={clipDrafts[asset.id]?.start??'0'} onChange={event=>updateClip(asset.id,'start',event.target.value)}/></label><label><span>片段秒数</span><input aria-label={`第 ${index+1} 段片段秒数`} type="number" min={0.1} step={0.1} inputMode="decimal" required value={clipDrafts[asset.id]?.duration??''} onChange={event=>updateClip(asset.id,'duration',event.target.value)}/></label></div>}</div>
      <div className="ca-hot-remix-order"><button type="button" aria-label={`上移 ${asset.name}`} disabled={index===0} onClick={()=>moveSource(index,-1)}><ArrowUp size={15}/></button><button type="button" aria-label={`下移 ${asset.name}`} disabled={index===sources.length-1} onClick={()=>moveSource(index,1)}><ArrowDown size={15}/></button><button type="button" aria-label={`移除 ${asset.name}`} onClick={()=>removeSource(asset.id)}><Trash2 size={15}/></button></div>
     </li>)}</ol>:<button type="button" className="ca-hot-remix-empty" onClick={()=>setPicker('sources')}><Film size={34}/><strong>选择源视频</strong><span>从带货 Agent 或主站资产库选择，也可上传新视频</span></button>}
     {clipMode==='manual'&&manualClipError&&sources.length>0&&<p className="ca-hot-remix-clip-error" id="hot-remix-clip-error" role="alert">{manualClipError}</p>}
    </section>

    <section className="ca-hot-remix-card">
     <div className="ca-hot-remix-title"><span>2</span><div><h2>成片设置</h2><p>报价后会冻结素材指纹、截取计划和以下参数。</p></div></div>
     <div className="ca-hot-remix-fields">
      <label><span>目标时长</span><div><input aria-label="二创目标时长" type="number" min={2} max={60} step={1} value={targetDuration} onChange={event=>setTargetDuration(Math.min(60,Math.max(2,Number(event.target.value)||2)))}/><em>秒</em></div></label>
      <label><span>成片比例</span><select aria-label="二创成片比例" value={aspectRatio} onChange={event=>setAspectRatio(event.target.value as AspectRatio)}><option value="9:16">9:16 竖屏</option><option value="16:9">16:9 横屏</option><option value="1:1">1:1 方形</option></select></label>
      <label className="ca-hot-remix-toggle"><input type="checkbox" checked={preserveSourceAudio} onChange={event=>setPreserveSourceAudio(event.target.checked)}/><span><strong>保留源视频声音</strong><small>关闭后只保留背景音乐；未选背景音乐时输出无声视频</small></span></label>
     </div>
     <div className="ca-hot-remix-bgm">
      <Music size={20}/><div><strong>背景音乐（可选）</strong>{bgm?<><span>{bgm.name} · {sizeText(bgm.size)}</span><audio src={bgm.url} controls preload="metadata"/></>:<span>未选择背景音乐</span>}</div>
      <button type="button" disabled={!runtime.ready} onClick={()=>setPicker('bgm')}>{bgm?'更换':'选择音乐'}</button>{bgm&&<button type="button" aria-label="移除背景音乐" onClick={()=>setBgm(undefined)}><Trash2 size={15}/></button>}
     </div>
     {bgm&&<label className="ca-hot-remix-volume"><span>背景音乐音量 <strong>{Math.round(bgmVolume*100)}%</strong></span><input aria-label="背景音乐音量" type="range" min={0} max={1} step={0.01} value={bgmVolume} onChange={event=>setBgmVolume(Number(event.target.value))}/></label>}
    </section>

    <section className="ca-hot-remix-card ca-hot-remix-quote">
     <div className="ca-hot-remix-title"><span>3</span><div><h2>冻结计划并确认</h2><p>先生成零费用报价，再确认进入持久任务队列。</p></div></div>
     {!quote?<button type="button" className="ca-hot-remix-primary" aria-describedby={clipMode==='manual'&&manualClipError?'hot-remix-clip-error':undefined} disabled={!runtime.ready||!sources.length||!!busy||(clipMode==='manual'&&!!manualClipError)} onClick={()=>void createQuote()}>{busy==='quote'?<LoaderCircle className="ca-spin" size={17}/>:<Clock3 size={17}/>}生成 0 元处理报价</button>:<div className="ca-hot-remix-quote-detail">
      <div><span>应付金额<strong>¥{quote.pricing.payableTotal.toFixed(2)}</strong></span><span>执行方式<strong>本地 FFmpeg</strong></span><span>成片规格<strong>{quote.settings.aspectRatio} · {quote.settings.width}×{quote.settings.height} · {quote.settings.targetDuration} 秒</strong></span></div>
      <ol>{quote.clipPlan.map(clip=><li key={`${clip.assetId}:${clip.order}`}><b>{clip.order+1}</b><span>{quote.sourceSnapshots.find(asset=>asset.assetId===clip.assetId)?.name||clip.assetId}</span><small>{clip.start.toFixed(1)}s → {(clip.start+clip.duration).toFixed(1)}s</small></li>)}</ol>
      <p>报价有效至 {dateText(quote.expiresAt)}。素材内容或参数变化后必须重新报价。</p>
      <button type="button" className="ca-hot-remix-primary" disabled={!!busy} onClick={()=>void confirm()}>{busy==='confirm'?<LoaderCircle className="ca-spin" size={17}/>:<Play size={17}/>}确认并开始本地处理</button>
     </div>}
     {error&&<p className="ca-hot-remix-error" role="alert">{error}</p>}
    </section>
   </div>

   <aside className="ca-hot-remix-history">
    <header><div><h2>任务与成片</h2><p>任务可离开页面后继续，返回时按原记录读回。</p></div><button type="button" aria-label="刷新二创任务" disabled={busy==='refresh'} onClick={()=>void loadJobs()}><RefreshCw className={busy==='refresh'?'ca-spin':''} size={16}/></button></header>
    {selectedJob?<div className="ca-hot-remix-preview">
     <div className={`ca-hot-remix-status is-${selectedJob.status}`}><span>{statusText[selectedJob.status]}</span><em>{Math.max(0,Math.min(100,Math.round(selectedJob.progress||0)))}%</em></div>
     {selectedUrl?<video src={selectedUrl} controls playsInline preload="metadata"/>:<div className="ca-hot-remix-placeholder">{selectedJob.status==='failed'?<Film size={35}/>:<LoaderCircle className={selectedJob.status==='running'?'ca-spin':''} size={35}/>}<strong>{statusText[selectedJob.status]}</strong><span>{selectedJob.error||'任务已持久保存，处理完成后成片会显示在这里。'}</span></div>}
     {selectedJob.resultAsset&&<div className="ca-hot-remix-result"><span>{selectedJob.resultAsset.name}<small>{sizeText(selectedJob.resultAsset.size)}</small></span><a href={`${selectedUrl}?download=1`}><Download size={15}/>下载成片</a></div>}
     <dl><div><dt>画幅</dt><dd>{selectedJob.settings.aspectRatio}</dd></div><div><dt>时长</dt><dd>{selectedJob.settings.targetDuration} 秒</dd></div><div><dt>创建时间</dt><dd>{dateText(selectedJob.createdAt)}</dd></div></dl>
    </div>:<div className="ca-hot-remix-placeholder"><Video size={35}/><strong>还没有二创任务</strong><span>完成报价确认后，任务会持久显示在这里。</span></div>}
    <div className="ca-hot-remix-job-list">{jobs.map(job=><button type="button" key={job.id} className={selectedJob?.id===job.id?'active':''} onClick={()=>void selectHistory(job)}><span className={`is-${job.status}`}><Film size={17}/></span><div><strong>{job.sourceSnapshots.map(asset=>asset.name).join(' + ')}</strong><small>{statusText[job.status]} · {job.settings.targetDuration} 秒 · {dateText(job.createdAt)}</small></div></button>)}</div>
   </aside>
  </div>

  {picker==='sources'&&<AssetPicker runtime={runtime} slot={sourceSlot} existing={sources.map(asset=>({...asset,slot:sourceSlot.id}))} limits={{total:3,byKind:{video:3}}} onSelect={addSources} onClose={()=>setPicker('')}/>}
  {picker==='bgm'&&<AssetPicker runtime={runtime} slot={bgmSlot} existing={[]} limits={{total:1,byKind:{audio:1}}} onSelect={items=>{if(items[0])setBgm(items[0]);setPicker('');}} onClose={()=>setPicker('')}/>}
 </section>;
}
