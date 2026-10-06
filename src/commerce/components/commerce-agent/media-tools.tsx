'use client';
import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent} from 'react';
import {Upload,Download,Play,LoaderCircle,Plus,Trash2} from 'lucide-react';
import {api,type Runtime,type UIAsset} from './runtime-ui';
import type {EditJob} from '../../server/media-tools';
import type {MediaToolDraft,MediaToolDraftState} from '../../server/media-tool-drafts';
import {defaultEraseRegion,validateEraseRegions,validateEraseDuration,type EraseRegion} from '../../media-edit-regions';
import {localMediaPrefix,parseLocalMediaDraft,localMediaDecision,removeLocalMediaSnapshot,type LocalMediaDraft} from '../../media-tool-local-drafts';
import './media-tools.css';
type LocalEntry={key:string;raw:string;value:LocalMediaDraft};
type DraftReply={ownerId:string;draft:MediaToolDraft|null;assetMissing:boolean;asset:UIAsset|null;localAsset:UIAsset|null};

export function MediaTools({name,runtime,onNotice,onBack,initialAssetId}:{name:string;runtime:Runtime;onNotice:(s:string)=>void;onBack:()=>void;initialAssetId?:string}){
 const tool=name==='画质增强'?'enhance':name==='水印擦除'?'watermark':name==='字幕擦除'?'subtitle':name==='人脸打码'?'mosaic':'trim';
 const erase=tool==='watermark'||tool==='subtitle'||tool==='mosaic';
 const [assetId,setAssetId]=useState(''),[range,setRange]=useState({start:0,end:10}),[resolution,setResolution]=useState(1080),[jobs,setJobs]=useState<EditJob[]>([]),[busy,setBusy]=useState(false);
 const [regions,setRegions]=useState<EraseRegion[]>([defaultEraseRegion(tool==='subtitle'?'subtitle':tool==='mosaic'?'mosaic':'watermark')]),[selected,setSelected]=useState(0);
 const [metadata,setMetadata]=useState<{duration:number;width:number;height:number}|null>(null),[mediaError,setMediaError]=useState('');
 const [lastJobId,setLastJobId]=useState(''),[draftReady,setDraftReady]=useState(false),[draftStatus,setDraftStatus]=useState('正在读取草稿…');
 const [restoredAsset,setRestoredAsset]=useState<UIAsset|null>(null);
 const [incomingState,setIncomingState]=useState<'pending'|'ready'|'failed'>(initialAssetId?'pending':'ready'),[incomingError,setIncomingError]=useState('');
 const [incomingAttempt,setIncomingAttempt]=useState(0);
 const incomingResolved=useRef('');
 const [localIssue,setLocalIssue]=useState<{message:string;entries:LocalEntry[];invalid:{key:string;raw:string}[]}|null>(null);
 const draftState=useRef({clientId:crypto.randomUUID(),sequence:0,revision:0,saved:'',latest:'',writing:false,blocked:false,alive:true,ownerId:'',localKey:'',localRaw:'',recovered:[] as LocalEntry[],warned:false});
 const restoredRangeAsset=useRef('');
 const fileInput=useRef<HTMLInputElement>(null),stage=useRef<HTMLDivElement>(null),submitting=useRef(false);
 const drag=useRef<{index:number;x:number;y:number;region:EraseRegion;width:number;height:number;resize:boolean}|null>(null);
 const request=useRef<{key:string;fingerprint:string}|null>(null);
 const source=runtime.assets.find(a=>a.id===assetId)||(restoredAsset?.id===assetId?restoredAsset:undefined),latest=lastJobId?jobs.find(j=>j.id===lastJobId):jobs.find(j=>j.input.assetId===assetId&&j.input.tool===tool);
 const selectableAssets=restoredAsset&&!runtime.assets.some(a=>a.id===restoredAsset.id)?[restoredAsset,...runtime.assets]:runtime.assets;
 useEffect(()=>{setMetadata(null);setMediaError('');request.current=null;},[assetId,tool]);
 function selectAsset(id:string){if(!draftReady||draftState.current.blocked)return;setAssetId(id);setRegions([defaultEraseRegion(tool==='subtitle'?'subtitle':tool==='mosaic'?'mosaic':'watermark')]);setSelected(0);setLastJobId('');setRange({start:0,end:10});restoredRangeAsset.current='';}
 function persistLocal(snapshot=draftState.current.latest){
  const state=draftState.current;if(!state.ownerId||!snapshot||snapshot===state.saved||state.blocked)return '';
  try{const value:LocalMediaDraft={version:1,ownerId:state.ownerId,tool,baseRevision:state.revision,updatedAt:Date.now(),state:JSON.parse(snapshot)};
   if(state.localRaw){const prior=parseLocalMediaDraft(state.localRaw,state.ownerId,tool);if(prior.baseRevision===value.baseRevision&&JSON.stringify(prior.state)===snapshot&&localStorage.getItem(state.localKey)===state.localRaw)return state.localRaw;}
   const raw=JSON.stringify(value);localStorage.setItem(state.localKey,raw);state.localRaw=raw;state.warned=false;return raw;
  }catch{if(!state.warned&&state.alive){state.warned=true;onNotice('浏览器未能保存本地草稿，请等待服务器保存成功后再关闭。');}return '';}
 }
 function confirmedLocal(raw:string){const state=draftState.current;try{if(raw)removeLocalMediaSnapshot(localStorage,state.localKey,raw);for(const entry of state.recovered)removeLocalMediaSnapshot(localStorage,entry.key,entry.raw);state.recovered=[];}catch{}if(state.localRaw===raw)state.localRaw='';}
 function exportLocal(){if(!localIssue)return;const blob=new Blob([JSON.stringify(localIssue.entries.map(entry=>entry.value),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='媒体工具未保存草稿.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function discardLocal(){if(!localIssue)return;try{for(const entry of [...localIssue.entries,...localIssue.invalid])removeLocalMediaSnapshot(localStorage,entry.key,entry.raw);}catch{onNotice('无法清理本地草稿，请检查浏览器存储设置');return;}draftState.current.blocked=true;window.location.reload();}
 async function saveDraft(){
  const state=draftState.current;if(state.writing||state.blocked||!state.latest||state.latest===state.saved)return;
  state.writing=true;
  try{while(state.latest&&state.latest!==state.saved&&!state.blocked){
   const snapshot=state.latest,localRaw=persistLocal(snapshot);if(state.alive)setDraftStatus('正在保存草稿…');
   const response=await fetch('/api/commerce/media-tool-drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...JSON.parse(snapshot),ownerId:state.ownerId,expectedRevision:state.revision,clientId:state.clientId,sequence:++state.sequence}),keepalive:true});
   const data=await response.json();if(!response.ok){if(response.status===409||response.status===401||response.status===403)state.blocked=true;throw Error(data.error||'草稿保存失败');}
   if(data.ownerId!==state.ownerId){state.blocked=true;throw Error('登录账号已变化，请重新载入工具');}
   state.revision=Math.max(state.revision,data.draft.revision);state.saved=snapshot;confirmedLocal(localRaw);persistLocal();if(state.alive)setDraftStatus('草稿已自动保存');
  }}catch(error){if(state.alive)setDraftStatus((state.blocked?'':'草稿保存失败：')+(error as Error).message);}finally{state.writing=false;}
 }
 function flushDraft(){
  const state=draftState.current;if(state.blocked||!state.latest||state.latest===state.saved)return;
  persistLocal();void fetch('/api/commerce/media-tool-drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...JSON.parse(state.latest),ownerId:state.ownerId,expectedRevision:state.revision,clientId:state.clientId,sequence:++state.sequence}),keepalive:true}).catch(()=>{});
 }
 useEffect(()=>{
  const state=draftState.current;state.alive=true;let cancelled=false;
  if(runtime.ready)void api<DraftReply>('/api/commerce/media-tool-drafts?tool='+tool).then(async({ownerId,draft,assetMissing,asset})=>{
   if(cancelled)return;
   if(!ownerId)throw Error('无法确认工具草稿所属账号');
   let value:MediaToolDraftState=draft?{tool,assetId:assetMissing?'':draft.assetId,regions:draft.regions,selected:draft.selected,range:draft.range,resolution:draft.resolution,lastJobId:assetMissing?'':draft.lastJobId}:{tool,assetId:'',regions:erase?[defaultEraseRegion(tool)]:[],selected:0,range:{start:0,end:10},resolution:1080,lastJobId:''};
   const serverValue=JSON.stringify(value),entries:LocalEntry[]=[],invalid:{key:string;raw:string}[]=[];
   state.ownerId=ownerId;state.localKey=localMediaPrefix(ownerId,tool)+state.clientId;state.revision=draft?.revision||0;
   try{const keys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter((key):key is string=>!!key&&key.startsWith(localMediaPrefix(ownerId,tool)));
    for(const key of keys){const raw=localStorage.getItem(key);if(!raw)continue;try{const local=parseLocalMediaDraft(raw,ownerId,tool);if(localMediaDecision(local,draft)==='confirmed')removeLocalMediaSnapshot(localStorage,key,raw);else entries.push({key,raw,value:local});}catch{invalid.push({key,raw});}}
   }catch{onNotice('浏览器本地草稿不可读取，当前使用服务器版本。');}
   const variants=new Set(entries.map(entry=>JSON.stringify({base:entry.value.baseRevision,state:entry.value.state})));
   if(invalid.length||variants.size>1||entries.some(entry=>localMediaDecision(entry.value,draft)==='conflict')){
    state.blocked=true;setLocalIssue({message:'本地未保存内容与服务器版本需要核对。已保留本地内容，尚未覆盖服务器。',entries,invalid});
   }else if(entries.length){
    const pending=entries[0].value;let validated=asset;
    if(pending.state.assetId&&pending.state.assetId!==asset?.id){const reply=await api<DraftReply>('/api/commerce/media-tool-drafts?tool='+tool+'&assetId='+encodeURIComponent(pending.state.assetId));if(cancelled)return;if(reply.ownerId!==ownerId)throw Error('登录账号已变化，请重新载入工具');validated=reply.localAsset;}
    if(pending.state.assetId&&!validated){state.blocked=true;setLocalIssue({message:'本地草稿的原视频已不存在或当前账号无法使用。未覆盖服务器。',entries,invalid});}
    else{value=pending.state;asset=validated;state.recovered=entries;onNotice('已恢复当前账号未送达服务器的本地草稿，正在补保存。');}
   }
   state.saved=serverValue;state.latest=JSON.stringify(value);restoredRangeAsset.current=value.assetId;
   setRestoredAsset(asset);setAssetId(value.assetId);setRegions(value.regions.length?value.regions:[defaultEraseRegion(tool==='subtitle'?'subtitle':tool==='mosaic'?'mosaic':'watermark')]);setSelected(value.selected);setRange(value.range);setResolution(value.resolution);setLastJobId(value.lastJobId);setDraftReady(true);setDraftStatus(state.blocked?'本地草稿待核对':entries.length?'已恢复本地草稿，正在补保存…':draft?'已恢复工具草稿':'修改后自动保存');
   if(assetMissing)onNotice('原草稿素材已删除，请重新选择视频；其余设置已恢复。');
  }).catch(error=>{if(!cancelled)setDraftStatus('草稿读取失败：'+error.message);});
  window.addEventListener('pagehide',flushDraft);
  return()=>{cancelled=true;state.alive=false;window.removeEventListener('pagehide',flushDraft);flushDraft();};
 },[tool,runtime.ready]);
 useEffect(()=>{
  if(!initialAssetId||!draftReady||draftState.current.blocked||incomingResolved.current===initialAssetId)return;
  let cancelled=false;const ownerId=draftState.current.ownerId;
  if(assetId===initialAssetId){incomingResolved.current=initialAssetId;setIncomingState('ready');return;}
  setIncomingState('pending');setIncomingError('');
  void api<DraftReply>('/api/commerce/media-tool-drafts?tool='+tool+'&assetId='+encodeURIComponent(initialAssetId)).then(reply=>{
   if(cancelled)return;
   if(reply.ownerId!==ownerId)throw Error('登录账号已变化，请重新载入工具');
   if(!reply.localAsset||!reply.localAsset.type.startsWith('video/'))throw Error('这条成片已不存在或当前账号无法读取，请回原任务核对');
   if(draftState.current.blocked)throw Error('请先处理本地草稿冲突，再打开这条成片');
   incomingResolved.current=initialAssetId;setRestoredAsset(reply.localAsset);selectAsset(initialAssetId);setIncomingState('ready');onNotice('已将所选成片带入剪辑设置');
  }).catch(error=>{if(!cancelled){setIncomingState('failed');setIncomingError((error as Error).message);}});
  return()=>{cancelled=true;};
 },[initialAssetId,draftReady,tool,localIssue,incomingAttempt]);
 useLayoutEffect(()=>{
  if(!draftReady)return;
  try{if(erase)validateEraseRegions(tool,regions);}catch{setDraftStatus('选区无效，修正后自动保存');return;}
  draftState.current.latest=JSON.stringify({tool,assetId,regions:erase?regions:[],selected,range,resolution,lastJobId} satisfies MediaToolDraftState);
  persistLocal();
  const timer=setTimeout(()=>void saveDraft(),350);return()=>clearTimeout(timer);
 },[draftReady,tool,assetId,regions,selected,range,resolution,lastJobId]);
 useEffect(()=>{let alive=true;async function poll(){try{const value=await api<{jobs:EditJob[]}>('/api/commerce/media-tools');if(alive)setJobs(value.jobs);}catch{}}void poll();const timer=setInterval(()=>void poll(),3000);return()=>{alive=false;clearInterval(timer);};},[]);
 let validationError=mediaError;
 if(erase){try{validateEraseRegions(tool,regions);if(metadata)validateEraseDuration(metadata.duration);}catch(error){validationError=(error as Error).message;}}
 const activeRegion=regions[selected]||regions[0];
 const area=regions.reduce((sum,region)=>sum+region.width*region.height,0)*100;
 const rounded=(value:number)=>Math.round(value*10000)/10000;
 function updateCoordinate(key:keyof EraseRegion,percent:number){
  if(!Number.isFinite(percent)||draftState.current.blocked)return;
  setRegions(current=>current.map((region,index)=>{
   if(index!==selected)return region;
   const updated={...region};
   const upper=key==='x'?1-region.width:key==='y'?1-region.height:key==='width'?1-region.x:1-region.y;
   updated[key]=rounded(Math.min(upper,Math.max(key==='width'||key==='height'?.03:0,percent/100)));
   return updated;
  }));
 }
 function beginDrag(event:PointerEvent<HTMLElement>,index:number,resize=false){
  if(draftState.current.blocked)return;
  const bounds=stage.current?.getBoundingClientRect();if(!bounds)return;
  event.preventDefault();event.stopPropagation();setSelected(index);event.currentTarget.setPointerCapture(event.pointerId);
  drag.current={index,x:event.clientX,y:event.clientY,region:{...regions[index]},width:bounds.width,height:bounds.height,resize};
 }
 function moveDrag(event:PointerEvent<HTMLElement>){
  const current=drag.current;if(!current)return;
  const dx=(event.clientX-current.x)/current.width,dy=(event.clientY-current.y)/current.height,b=current.region;
  const updated=current.resize?{...b,width:rounded(Math.min(1-b.x,Math.max(.03,b.width+dx))),height:rounded(Math.min(1-b.y,Math.max(.03,b.height+dy)))}:{...b,x:rounded(Math.min(1-b.width,Math.max(0,b.x+dx))),y:rounded(Math.min(1-b.height,Math.max(0,b.y+dy)))};
  setRegions(value=>value.map((region,index)=>index===current.index?updated:region));
 }
 function endDrag(){drag.current=null;}
 async function submit(){
  if(submitting.current)return;submitting.current=true;setBusy(true);
  try{
   if(erase){validateEraseRegions(tool,regions);if(!metadata)throw Error('请等待视频信息加载完成');validateEraseDuration(metadata.duration);}
   const input={assetId,tool,start:erase?0:range.start,end:erase?0:range.end,resolution,...(erase?{boxes:regions}: {})};
   const fingerprint=JSON.stringify(input);if(!request.current||request.current.fingerprint!==fingerprint)request.current={key:crypto.randomUUID(),fingerprint};
   const value=await api<{job:EditJob}>('/api/commerce/media-tools',{...input,requestId:request.current.key});request.current=null;
   setJobs(current=>[value.job,...current.filter(j=>j.id!==value.job.id)]);setLastJobId(value.job.id);onNotice('视频处理已提交，成片将保存到资产库。');
  }catch(e){onNotice((e as Error).message);}finally{submitting.current=false;setBusy(false);}
 }
 const video=source?<video key={source.id+'-'+tool} controls src={source.url} onLoadedMetadata={event=>{const v=event.currentTarget;setMetadata({duration:v.duration,width:v.videoWidth,height:v.videoHeight});setMediaError('');if(restoredRangeAsset.current===source.id)restoredRangeAsset.current='';else setRange({start:0,end:Math.min(300,Math.floor(v.duration*10)/10)});}} onError={()=>setMediaError('视频无法读取，请重新上传有效文件')}/>:null;
 return <div className={'ca-utility'+(erase?' ca-erase-tool':'')}>
  <div className="ca-section-head"><div><h2>{name}</h2><p>{tool==='enhance'?'本地降噪、锐化和分辨率调整':erase?'选择固定区域，保留原片完整时长和声音':'选择片段，导出 MP4 成片'}</p></div><button onClick={onBack}>返回创作首页</button></div>
  <div className="ca-utility-body"><div className="ca-utility-preview">
   {source?(erase?<div className="ca-erase-stage" ref={stage} style={{aspectRatio:metadata?metadata.width+'/'+metadata.height:'16/9',maxWidth:metadata?600*metadata.width/metadata.height+'px':undefined}}>
    {video}{metadata&&<div className="ca-erase-overlay">{regions.map((region,index)=><div key={index} role="button" tabIndex={0} aria-label={'擦除区域 '+(index+1)} aria-pressed={selected===index} className={'ca-erase-region'+(selected===index?' is-selected':'')} style={{left:region.x*100+'%',top:region.y*100+'%',width:region.width*100+'%',height:region.height*100+'%'}} onPointerDown={event=>beginDrag(event,index)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={()=>setSelected(index)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelected(index);}}}>
     <span className="ca-erase-region-label">{index+1}</span><span className="ca-erase-handle" title="拖动调整区域大小" onPointerDown={event=>beginDrag(event,index,true)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}/>
    </div>)}</div>}
   </div>:video):<button disabled={!draftReady||draftState.current.blocked||incomingState!=='ready'} onClick={()=>fileInput.current?.click()}><Upload size={34}/><strong>添加视频</strong><span>{erase?'30 秒以内，MP4、WebM 或 MOV，最大 150 MB':'MP4、WebM 或 MOV，最大 150 MB'}</span>{tool==='watermark'&&<span>超过 2K（长边 2048）将自动压缩至 2K 后处理</span>}</button>}
   {latest&&<div className="ca-edit-result"><strong role="status">{latest.status==='succeeded'?'处理完成':latest.status==='failed'?latest.error:'正在处理视频…'}</strong>{latest.assetId?<><video controls src={'/api/commerce/assets/'+latest.assetId}/><a href={'/api/commerce/assets/'+latest.assetId+'?download=1'}><Download size={16}/>下载成片</a></>:latest.status!=='failed'&&<LoaderCircle className="ca-spin"/>}</div>}
  </div><aside><h3>处理设置</h3>
   <p role="status" className="ca-media-draft-status">{draftStatus}</p>{localIssue&&<div role="alert"><p>{localIssue.message}</p>{!!localIssue.entries.length&&<button onClick={exportLocal}>导出保留的本地草稿</button>}<button onClick={discardLocal}>舍弃本地草稿并使用服务器版本</button></div>}{(draftState.current.blocked||(!draftReady&&draftStatus.startsWith('草稿读取失败')))&&<button onClick={()=>window.location.reload()}>重新载入草稿</button>}{draftReady&&!draftState.current.blocked&&draftStatus.startsWith('草稿保存失败')&&<button onClick={()=>void saveDraft()}>重试保存草稿</button>}
   {incomingState==='pending'&&<p role="status">正在读取指定成片…</p>}{incomingError&&<div role="alert"><p>{incomingError}</p><button onClick={()=>setIncomingAttempt(n=>n+1)}>重新读取指定成片</button></div>}
   <fieldset disabled={!draftReady||draftState.current.blocked||incomingState!=='ready'} style={{border:0,padding:0,margin:0,minWidth:0}}>
   <label>素材<select aria-label="媒体工具素材" disabled={!draftReady} value={assetId} onChange={event=>selectAsset(event.target.value)}><option value="">选择视频素材</option>{selectableAssets.filter(asset=>asset.type.startsWith('video/')).map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
   <button disabled={!draftReady} onClick={()=>fileInput.current?.click()}><Upload size={16}/>上传视频</button>
   <input hidden disabled={!draftReady} ref={fileInput} type="file" accept="video/mp4,video/webm,video/quicktime" onChange={async event=>{const file=event.target.files?.[0];event.target.value='';if(file)try{const asset=await runtime.upload(file);selectAsset(asset.id);}catch(error){onNotice((error as Error).message);}}}/>
   {erase?<div className="ca-erase-settings">
    <p>{metadata?'原片时长 '+metadata.duration.toFixed(2)+' 秒 · 全片处理':'选择 30 秒以内的视频'}</p>
    <div className="ca-erase-region-actions"><strong>擦除区域 {regions.length}/{tool==='watermark'||tool==='mosaic'?4:1}</strong>{(tool==='watermark'||tool==='mosaic')&&<button aria-label="添加擦除区域" disabled={regions.length>=4} onClick={()=>{setRegions(current=>[...current,{x:.1,y:.1,width:.2,height:.1}]);setSelected(regions.length);}}><Plus size={14}/>增加</button>}</div>
    <div className="ca-erase-region-list">{regions.map((_,index)=><button key={index} className={selected===index?'is-selected':''} aria-pressed={selected===index} onClick={()=>setSelected(index)}>区域 {index+1}</button>)}<button aria-label="删除选中区域" disabled={regions.length===1} onClick={()=>{setRegions(current=>current.filter((_,index)=>index!==selected));setSelected(Math.max(0,selected-1));}}><Trash2 size={14}/></button></div>
    <p>拖动框体移动位置，拖动右下角调整大小；也可输入坐标。</p>
    <div className="ca-erase-coordinates">{([['x','左侧'],['y','顶部'],['width','宽度'],['height','高度']] as const).map(([key,label])=><label key={key}>{label}（%）<input type="number" min={key==='width'||key==='height'?3:0} max="100" step="0.1" aria-label={label+'百分比'} value={Math.round(activeRegion[key]*10000)/100} onChange={event=>updateCoordinate(key,Number(event.target.value))}/></label>)}</div>
    <p>总面积 {area.toFixed(1)}% / 50% · 每条边至少 3%</p>
    {tool==='watermark'&&<p>长边超过 2048 像素时，按比例压缩至 2K 后处理。</p>}
    <p className="ca-erase-method">本地 FFmpeg 区域修补。复杂背景可能留下修补痕迹。</p>
   </div>:<><label>开始时间（秒）<input type="number" step="0.1" min="0" value={range.start} onChange={event=>setRange({...range,start:Number(event.target.value)})}/></label><label>结束时间（秒）<input type="number" step="0.1" min="0" value={range.end} onChange={event=>setRange({...range,end:Number(event.target.value)})}/></label></>}
   {tool==='enhance'&&<label>目标分辨率<select value={resolution} onChange={event=>setResolution(Number(event.target.value))}>{[720,1080,1440,2160].map(value=><option key={value} value={value}>{value}P</option>)}</select></label>}
   {validationError&&<p role="alert" className="ca-erase-error">{validationError}</p>}
   <button className="ca-primary" disabled={!draftReady||!assetId||busy||!!validationError||(erase&&!metadata)||latest?.status==='running'||latest?.status==='queued'} onClick={()=>void submit()}><Play size={16}/>{busy?'提交中…':'开始处理'}</button>
   <p>本地处理，不调用付费模型。</p>
   </fieldset>
  </aside></div>
 </div>;
}
