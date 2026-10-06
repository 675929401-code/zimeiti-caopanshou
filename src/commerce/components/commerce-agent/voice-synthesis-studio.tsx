'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,ArrowLeft,CheckCircle2,Clapperboard,Clock3,Download,Headphones,LoaderCircle,Mic2,RefreshCw,Volume2} from 'lucide-react';
import {api} from './runtime-ui';
import './voice-synthesis.css';

type VoiceParameters={speedRatio:number;pitch:number;emotion:string;format:'mp3'|'wav'|'ogg';sampleRate:16000|24000|48000};
type VoiceCatalogEntry={
 voiceId:string;name:string;description:string;gender:string;language:string;engine:'volcano';speakerId:string;
 modelId:string;providerModelId:string;providerResourceId:string;available:boolean;priceConfigured:boolean;generationReady:boolean;readinessMessage?:string;
};
type VoiceQuote={
 schema:'commerce-voice-quote/v1';id:string;status:'quoted'|'confirmed';voiceId:string;voiceName:string;modelId:string;
 providerModelId:string;providerResourceId:string;configHash:string;textHash:string;textLength:number;parameters:VoiceParameters;
 payableTotal:number;currency:'CNY';createdAt:number;expiresAt:number;jobId?:string;
};
type VoiceStatus='billing_pending'|'queued'|'running'|'submission_unknown'|'saving'|'succeeded'|'failed'|'cancelled';
type BillingState='charge_pending'|'not_charged'|'charged'|'refund_pending'|'refunded'|'revenue_pending'|'revenue_recorded'|'reconciliation_required';
type VoiceAsset={id:string;name:string;type:string;size:number;url?:string};
type CommerceVideoAsset={id:string;name:string;type:string;size:number;url:string};
type VoiceReplaceJob={
 id:string;requestId:string;requestedMode:'replace'|'mix';effectiveMode:'replace'|'mix';status:'queued'|'running'|'succeeded'|'failed';
 progress:number;error?:string;resultAsset?:CommerceVideoAsset;resultProbe?:{duration:number;hasAudio:boolean};
};
type VoiceJob={
 schema:'commerce-voice-job/v1';id:string;quoteId:string;status:VoiceStatus;voiceId:string;voiceName:string;modelId:string;
 providerModelId:string;textHash:string;textLength:number;parameters:VoiceParameters;payableTotal:number;currency:'CNY';
 billing:{state:BillingState;amount:number;balanceAfter?:number;chargedAt?:number;refundedAt?:number;revenueRecordedAt?:number;error?:string};
 dispatch?:{state:string;startedAt:number;acknowledgedAt?:number;completedAt?:number};asset?:VoiceAsset;error?:string;
 createdAt:number;updatedAt:number;events:Array<{at:number;stage:string}>;
};

const statusText:Record<VoiceStatus,string>={billing_pending:'等待再次确认支付',queued:'已进入队列',running:'正在合成',submission_unknown:'提交结果待人工对账',saving:'正在保存音频',succeeded:'已完成',failed:'已失败',cancelled:'已取消'};
const billingText:Record<BillingState,string>={charge_pending:'未完成扣费',not_charged:'未扣费',charged:'已扣费',refund_pending:'退款处理中',refunded:'已退款',revenue_pending:'收益记录中',revenue_recorded:'结算完成',reconciliation_required:'需要人工对账'};
const inProgress=new Set<VoiceStatus>(['queued','running','saving']);

function dateText(value:number|undefined){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleString('zh-CN');}
function money(value:number){return `¥${Number(value||0).toFixed(2)}`;}
function assetUrl(job:VoiceJob){return job.asset?.url||(job.asset?`/api/commerce/assets/${encodeURIComponent(job.asset.id)}`:'');}

export function VoiceSynthesisStudio({onBack,onNotice}:{onBack:()=>void;onNotice:(message:string)=>void}){
 const [voices,setVoices]=useState<VoiceCatalogEntry[]>([]),[voiceId,setVoiceId]=useState('');
 const [text,setText]=useState(''),[speedRatio,setSpeedRatio]=useState(1),[pitch,setPitch]=useState(0),[emotion,setEmotion]=useState('neutral');
 const [format,setFormat]=useState<VoiceParameters['format']>('mp3'),[sampleRate,setSampleRate]=useState<VoiceParameters['sampleRate']>(24000);
 const [quote,setQuote]=useState<VoiceQuote|null>(null),[jobs,setJobs]=useState<VoiceJob[]>([]),[selectedJob,setSelectedJob]=useState<VoiceJob|null>(null);
 const [busy,setBusy]=useState<'loading'|'quote'|'confirm'|'refresh'|'reconcile'|'request'|'retry-charge'|'cancel-charge'|'apply-load'|'apply-submit'|''>('loading'),[error,setError]=useState('');
 const [applyOpen,setApplyOpen]=useState(false),[videoAssets,setVideoAssets]=useState<CommerceVideoAsset[]>([]),[videoAssetId,setVideoAssetId]=useState(''),[replaceMode,setReplaceMode]=useState<'replace'|'mix'>('replace'),[replaceJob,setReplaceJob]=useState<VoiceReplaceJob|null>(null);
 const confirmRequest=useRef<{quoteId:string;clientRequestId:string}>({quoteId:'',clientRequestId:''});
 const replaceRequest=useRef<{fingerprint:string;requestId:string}>({fingerprint:'',requestId:''});
 const mounted=useRef(true);
 const characters=useMemo(()=>[...text.trim()].length,[text]);
 const parameters=useMemo<VoiceParameters>(()=>({speedRatio,pitch,emotion:emotion.trim().toLowerCase()||'neutral',format,sampleRate}),[speedRatio,pitch,emotion,format,sampleRate]);
 const inputFingerprint=useMemo(()=>JSON.stringify({voiceId,text:text.trim(),parameters}),[voiceId,text,parameters]);
 const selectedVoice=voices.find(voice=>voice.voiceId===voiceId);

 const loadJobs=useCallback(async(silent=false)=>{
  if(!silent)setBusy('refresh');
  try{
   const result=await api<{jobs:VoiceJob[]}>('/api/commerce/voice-synthesis');
   if(!mounted.current)return;
   setJobs(result.jobs||[]);
   setSelectedJob(current=>current?(result.jobs||[]).find(job=>job.id===current.id)||current:(result.jobs||[])[0]||null);
   if(!silent)setError('');
  }catch(reason){if(mounted.current&&!silent)setError((reason as Error).message);}
  finally{if(mounted.current&&!silent)setBusy('');}
 },[]);

 useEffect(()=>{
  mounted.current=true;
  void Promise.all([api<{voices:VoiceCatalogEntry[]}>('/api/commerce/voice-synthesis?action=catalog'),api<{jobs:VoiceJob[]}>('/api/commerce/voice-synthesis')])
   .then(([catalog,history])=>{
    if(!mounted.current)return;
    const rows=catalog.voices||[];setVoices(rows);
    setVoiceId(current=>current||rows.find(voice=>voice.available&&voice.priceConfigured)?.voiceId||rows[0]?.voiceId||'');
    setJobs(history.jobs||[]);setSelectedJob((history.jobs||[])[0]||null);setError('');
   })
   .catch(reason=>{if(mounted.current)setError((reason as Error).message);})
   .finally(()=>{if(mounted.current)setBusy('');});
  return()=>{mounted.current=false;};
 },[]);
 useEffect(()=>{setQuote(null);setError('');},[inputFingerprint]);
 useEffect(()=>{setApplyOpen(false);setVideoAssets([]);setVideoAssetId('');setReplaceJob(null);replaceRequest.current={fingerprint:'',requestId:''};},[selectedJob?.id]);
 useEffect(()=>{
  if(!jobs.some(job=>inProgress.has(job.status)))return;
  const timer=setInterval(()=>void loadJobs(true),4000);return()=>clearInterval(timer);
 },[jobs,loadJobs]);
 useEffect(()=>{
  if(!replaceJob||!['queued','running'].includes(replaceJob.status))return;
  const timer=setInterval(()=>{
   void api<{job:VoiceReplaceJob}>(`/api/commerce/voice-replace?id=${encodeURIComponent(replaceJob.id)}`)
    .then(result=>{if(mounted.current)setReplaceJob(result.job);})
    .catch(reason=>{if(mounted.current)setError((reason as Error).message);});
  },2500);
  return()=>clearInterval(timer);
 },[replaceJob]);

 async function createQuote(){
  if(!voiceId){setError('当前没有可选择的音色。');return;}
  if(!text.trim()){setError('请先填写要合成的文字。');return;}
  if(characters>5000){setError('合成文字超过 5000 字上限。');return;}
  setBusy('quote');setError('');
  try{
   const result=await api<{quote:VoiceQuote}>('/api/commerce/voice-synthesis',{action:'quote',voiceId,text:text.trim(),parameters});
   if(!mounted.current)return;
   setQuote(result.quote);
   confirmRequest.current={quoteId:result.quote.id,clientRequestId:crypto.randomUUID()};
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }

 async function confirmQuote(){
  if(!quote)return;
  const accepted=window.confirm(`将按冻结报价从主站现金钱包支付 ${money(quote.payableTotal)}。音色：${quote.voiceName}；模型：${quote.modelId}；供应商模型：${quote.providerModelId}。确认后才会提交语音供应商，是否继续？`);
  if(!accepted)return;
  if(confirmRequest.current.quoteId!==quote.id)confirmRequest.current={quoteId:quote.id,clientRequestId:crypto.randomUUID()};
  setBusy('confirm');setError('');
  try{
   const result=await api<{job:VoiceJob}>('/api/commerce/voice-synthesis',{action:'confirm',quoteId:quote.id,clientRequestId:confirmRequest.current.clientRequestId});
   if(!mounted.current)return;
   setSelectedJob(result.job);setJobs(current=>[result.job,...current.filter(job=>job.id!==result.job.id)]);
   onNotice(result.job.status==='queued'?'语音任务已确认并进入队列。':'已读回同一确认请求的任务状态，没有重复提交。');
   void loadJobs(true);
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }

 async function selectHistory(job:VoiceJob){
  setSelectedJob(job);setError('');
  try{
   const result=await api<{job:VoiceJob}>(`/api/commerce/voice-synthesis?id=${encodeURIComponent(job.id)}`);
   if(!mounted.current)return;
   setSelectedJob(result.job);setJobs(current=>[result.job,...current.filter(value=>value.id!==result.job.id)]);
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
 }

 async function resolveUnknown(action:'retry-save'|'request-reconciliation'){
  if(!selectedJob||selectedJob.status!=='submission_unknown')return;
  setBusy(action==='retry-save'?'reconcile':'request');setError('');
  try{
   const result=await api<{job:VoiceJob}>('/api/commerce/voice-synthesis',{action,id:selectedJob.id});
   if(!mounted.current)return;
   setSelectedJob(result.job);setJobs(current=>[result.job,...current.filter(job=>job.id!==result.job.id)]);
   onNotice(action==='retry-save'?'已仅检查原任务的幂等音频资产，没有重提供应商。':'人工对账申请已记录；管理员核验上游证据前不会退款或重提供应商。');
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }

 async function resolvePendingCharge(action:'retry-charge'|'cancel-pending-charge'){
  if(!selectedJob||selectedJob.status!=='billing_pending'||selectedJob.billing.state!=='charge_pending')return;
  if(action==='retry-charge'&&!window.confirm(`将再次确认同一幂等扣款 ${money(selectedJob.payableTotal)}；系统不会创建新的语音任务。是否继续？`))return;
  setBusy(action==='retry-charge'?'retry-charge':'cancel-charge');setError('');
  try{
   const result=await api<{job:VoiceJob}>('/api/commerce/voice-synthesis',{action,id:selectedJob.id});
   if(!mounted.current)return;
   setSelectedJob(result.job);setJobs(current=>[result.job,...current.filter(job=>job.id!==result.job.id)]);
   onNotice(action==='retry-charge'?'同一任务的幂等扣款已再次明确确认。':'待支付任务已取消，未调用供应商、未扣款。');
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }

 async function openApplyToVideo(){
  if(!selectedJob?.asset||selectedJob.status!=='succeeded')return;
  setBusy('apply-load');setError('');
  try{
   const result=await api<{assets:CommerceVideoAsset[]}>('/api/commerce/assets');
   if(!mounted.current)return;
   const videos=(result.assets||[]).filter(asset=>asset.type.startsWith('video/'));
   setVideoAssets(videos);setVideoAssetId(current=>videos.some(asset=>asset.id===current)?current:videos[0]?.id||'');setApplyOpen(true);
   if(!videos.length)setError('当前素材库没有可应用配音的视频，请先上传或生成视频。');
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }

 async function applyVoiceToVideo(){
  if(!selectedJob?.asset||!videoAssetId)return;
  const fingerprint=`${selectedJob.asset.id}:${videoAssetId}:${replaceMode}`;
  if(replaceRequest.current.fingerprint!==fingerprint)replaceRequest.current={fingerprint,requestId:crypto.randomUUID()};
  setBusy('apply-submit');setError('');
  try{
   const result=await api<{job:VoiceReplaceJob}>('/api/commerce/voice-replace',{action:'create',videoAssetId,audioAssetId:selectedJob.asset.id,mode:replaceMode,requestId:replaceRequest.current.requestId});
   if(!mounted.current)return;
   setReplaceJob(result.job);onNotice(result.job.status==='succeeded'?'已读回同一应用配音成片。':'应用配音任务已保存，本地媒体 worker 将继续处理。');
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy('');}
 }

 const url=selectedJob?assetUrl(selectedJob):'';
 return <main className="ca-voice" data-testid="commerce-voice-synthesis">
  <header className="ca-voice-head">
   <button type="button" onClick={onBack}><ArrowLeft size={17}/>返回</button>
   <div><span>COMMERCE VOICE</span><h1>语音合成</h1><p>报价与确认分离，现金价格和供应商配置在提交前冻结。</p></div>
   <div className="ca-voice-wallet"><Volume2 size={18}/><span>结算方式<strong>主站现金钱包</strong></span></div>
  </header>
  <div className="ca-voice-layout">
   <section className="ca-voice-compose">
    <div className="ca-voice-card">
     <div className="ca-voice-title"><span>1</span><div><h2>文字与音色</h2><p>报价只读取配置，不会扣费或提交供应商。</p></div></div>
     <label className="ca-voice-text"><span>合成文字 <b>{characters} / 5000</b></span><textarea value={text} maxLength={5000} onChange={event=>setText(event.target.value)} placeholder="输入要合成的商品口播、旁白或配音文字。"/></label>
     <label className="ca-voice-field"><span>音色</span><select value={voiceId} onChange={event=>setVoiceId(event.target.value)} disabled={busy==='loading'||!voices.length}><option value="">选择音色</option>{voices.map(voice=><option key={voice.voiceId} value={voice.voiceId} disabled={!voice.available||!voice.priceConfigured}>{voice.name} · {voice.language}{!voice.available?'（供应商未配置）':!voice.priceConfigured?'（价格未配置）':''}</option>)}</select></label>
      {selectedVoice&&<><div className="ca-voice-model"><span><small>音色说明</small><strong>{selectedVoice.description||`${selectedVoice.gender} · ${selectedVoice.language}`}</strong></span><span><small>模型</small><strong>{selectedVoice.modelId}</strong></span><span><small>供应商模型</small><strong>{selectedVoice.providerModelId}</strong></span><span><small>资源</small><strong>{selectedVoice.providerResourceId}</strong></span></div>{!selectedVoice.generationReady&&<p className="ca-voice-billing-error">{selectedVoice.readinessMessage||'真实语音验收证据尚未发布，暂不能付费提交。'}</p>}</>}
    </div>
    <div className="ca-voice-card">
     <div className="ca-voice-title"><span>2</span><div><h2>声音参数</h2><p>参数会写入报价快照；修改后必须重新报价。</p></div></div>
     <div className="ca-voice-fields">
      <label><span>语速 <b>{speedRatio.toFixed(2)}×</b></span><input type="range" min={0.5} max={2} step={0.05} value={speedRatio} onChange={event=>setSpeedRatio(Number(event.target.value))}/></label>
      <label><span>音调 <b>{pitch>0?'+':''}{pitch}</b></span><input type="range" min={-12} max={12} step={1} value={pitch} onChange={event=>setPitch(Number(event.target.value))}/></label>
      <label><span>情绪</span><input value={emotion} maxLength={40} onChange={event=>setEmotion(event.target.value)} placeholder="neutral"/></label>
      <label><span>格式</span><select value={format} onChange={event=>setFormat(event.target.value as VoiceParameters['format'])}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="ogg">OGG</option></select></label>
      <label><span>采样率</span><select value={sampleRate} onChange={event=>setSampleRate(Number(event.target.value) as VoiceParameters['sampleRate'])}><option value={16000}>16 kHz</option><option value={24000}>24 kHz</option><option value={48000}>48 kHz</option></select></label>
     </div>
     {!quote?<button className="ca-voice-primary" type="button" disabled={!!busy||!selectedVoice?.available||!selectedVoice?.priceConfigured||!text.trim()} onClick={()=>void createQuote()}>{busy==='quote'?<LoaderCircle className="ca-spin" size={17}/>:<Mic2 size={17}/>}获取准确报价</button>:<div className="ca-voice-quote" data-testid="commerce-voice-quote">
      <div><span><small>现金应付</small><strong>{money(quote.payableTotal)}</strong></span><span><small>音色</small><strong>{quote.voiceName}</strong></span><span><small>字符数</small><strong>{quote.textLength}</strong></span></div>
      <dl><div><dt>模型</dt><dd>{quote.modelId}</dd></div><div><dt>供应商模型</dt><dd>{quote.providerModelId}</dd></div><div><dt>报价过期</dt><dd>{dateText(quote.expiresAt)}</dd></div></dl>
      <p>确认时服务端会再次核对音色、价格、供应商配置和已发布的真实验收证据；任何变化都会要求重新报价。</p>
      <button className="ca-voice-primary" type="button" disabled={!!busy||!selectedVoice?.generationReady} onClick={()=>void confirmQuote()}>{busy==='confirm'?<LoaderCircle className="ca-spin" size={17}/>:<CheckCircle2 size={17}/>}明确确认并支付 {money(quote.payableTotal)}</button>
     </div>}
     {error&&<p className="ca-voice-error" role="alert">{error}</p>}
    </div>
   </section>
   <aside className="ca-voice-history">
    <header><div><h2>任务与结果</h2><p>页面关闭后可按任务记录继续读回。</p></div><button type="button" title="刷新历史" disabled={busy==='refresh'} onClick={()=>void loadJobs()}><RefreshCw className={busy==='refresh'?'ca-spin':''} size={16}/></button></header>
    <div className="ca-voice-preview">
     {selectedJob?<>
       <div className={`ca-voice-status is-${selectedJob.status}`}><span>{statusText[selectedJob.status]}</span><time>{dateText(selectedJob.updatedAt)}</time></div>
       {selectedJob.status==='billing_pending'&&selectedJob.billing.state==='charge_pending'&&<div className="ca-voice-unknown" role="alert"><AlertTriangle size={19}/><div><strong>本次扣费没有完成</strong><p>后台不会自动重试。你可以再次明确确认同一幂等扣款，或取消这个未扣款任务。</p><div><button type="button" disabled={!!busy} onClick={()=>void resolvePendingCharge('retry-charge')}>{busy==='retry-charge'?<LoaderCircle className="ca-spin" size={13}/>:<RefreshCw size={13}/>}再次确认支付</button><button type="button" disabled={!!busy} onClick={()=>void resolvePendingCharge('cancel-pending-charge')}>{busy==='cancel-charge'?<LoaderCircle className="ca-spin" size={13}/>:<AlertTriangle size={13}/>}取消未扣款任务</button></div></div></div>}
      {selectedJob.status==='submission_unknown'&&<div className="ca-voice-unknown" role="alert"><AlertTriangle size={19}/><div><strong>供应商提交结果未知，需要人工对账</strong><p>系统不会自动重发，也不会自动退款。可仅重查原任务已经保存的幂等音频，或提交人工对账申请；管理员核验上游结果和成本证据后才能处理终态。</p><div><button type="button" disabled={!!busy} onClick={()=>void resolveUnknown('retry-save')}>{busy==='reconcile'?<LoaderCircle className="ca-spin" size={13}/>:<RefreshCw size={13}/>}仅检查已保存音频</button><button type="button" disabled={!!busy} onClick={()=>void resolveUnknown('request-reconciliation')}>{busy==='request'?<LoaderCircle className="ca-spin" size={13}/>:<AlertTriangle size={13}/>}提交人工对账申请</button></div><small>未知终态不会自动轮询 · 任务号 {selectedJob.id}</small></div></div>}
       {url?<><audio controls preload="metadata" src={url}/><div className="ca-voice-result"><span><strong>{selectedJob.asset?.name||'语音结果'}</strong><small>{selectedJob.asset?.type} · {selectedJob.asset?.size?`${Math.max(1,Math.round(selectedJob.asset.size/1024))} KB`:''}</small></span><a href={`${url}${url.includes('?')?'&':'?'}download=1`} download><Download size={14}/>下载</a></div><div className="ca-voice-apply"><button type="button" disabled={!!busy} onClick={()=>void openApplyToVideo()}>{busy==='apply-load'?<LoaderCircle className="ca-spin" size={14}/>:<Clapperboard size={14}/>}应用到视频</button>{applyOpen&&<div><label><span>目标视频</span><select value={videoAssetId} disabled={!!busy||!videoAssets.length} onChange={event=>{setVideoAssetId(event.target.value);setReplaceJob(null);}}><option value="">请选择素材库视频</option>{videoAssets.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label><span>声音方式</span><select value={replaceMode} disabled={!!busy} onChange={event=>{setReplaceMode(event.target.value as 'replace'|'mix');setReplaceJob(null);}}><option value="replace">替换原音轨</option><option value="mix">保留少量原声并混合</option></select></label><button type="button" disabled={!!busy||!videoAssetId||!!replaceJob&&['queued','running'].includes(replaceJob.status)} onClick={()=>void applyVoiceToVideo()}>{busy==='apply-submit'?<LoaderCircle className="ca-spin" size={13}/>:<CheckCircle2 size={13}/>}确认应用（本地处理 ¥0）</button>{replaceJob&&<div className={`ca-voice-apply-status is-${replaceJob.status}`}><strong>{replaceJob.status==='succeeded'?'应用完成':replaceJob.status==='failed'?'应用失败':replaceJob.status==='running'?'正在应用配音':'已进入本地队列'}</strong><span>{replaceJob.error||replaceJob.resultProbe?replaceJob.error||`成片 ${replaceJob.resultProbe?.duration.toFixed(1)} 秒 · 已保留音轨`:'任务会在页面关闭后继续处理。'}</span>{replaceJob.resultAsset&&<a href={`${replaceJob.resultAsset.url}?download=1`} download><Download size={13}/>下载成片</a>}</div>}</div>}</div></>:<div className="ca-voice-placeholder">{inProgress.has(selectedJob.status)?<LoaderCircle className="ca-spin" size={28}/>:selectedJob.status==='failed'?<AlertTriangle size={28}/>:<Headphones size={28}/>}<strong>{statusText[selectedJob.status]}</strong><span>{selectedJob.error||'任务完成后，音频会出现在这里。'}</span></div>}
      <dl><div><dt>现金价格</dt><dd>{money(selectedJob.payableTotal)}</dd></div><div><dt>结算</dt><dd>{billingText[selectedJob.billing.state]}</dd></div><div><dt>音色</dt><dd>{selectedJob.voiceName}</dd></div><div><dt>模型</dt><dd>{selectedJob.modelId}</dd></div><div><dt>供应商</dt><dd>{selectedJob.providerModelId}</dd></div><div><dt>任务号</dt><dd title={selectedJob.id}>{selectedJob.id.slice(0,8)}</dd></div></dl>
      {selectedJob.billing.error&&<p className="ca-voice-billing-error">{selectedJob.billing.error}</p>}
     </>:<div className="ca-voice-placeholder"><Clock3 size={28}/><strong>暂无语音任务</strong><span>先获取准确报价，再明确确认提交。</span></div>}
    </div>
    <div className="ca-voice-job-list">{jobs.map(job=><button type="button" key={job.id} className={selectedJob?.id===job.id?'active':''} onClick={()=>void selectHistory(job)}><span className={`is-${job.status}`}>{job.status==='succeeded'?<CheckCircle2 size={15}/>:job.status==='submission_unknown'||job.status==='failed'?<AlertTriangle size={15}/>:<Mic2 size={15}/>}</span><div><strong>{job.voiceName} · {money(job.payableTotal)}</strong><small>{statusText[job.status]} · {dateText(job.updatedAt)}</small></div></button>)}</div>
   </aside>
  </div>
 </main>;
}
