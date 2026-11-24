'use client';
import {useEffect,useRef,useState,type PointerEvent} from 'react';
import {Upload,Download,SlidersHorizontal,Play,LoaderCircle,Plus,Trash2,Video,ArrowLeft,ChevronDown} from 'lucide-react';
import {api,type Runtime,type UIAsset} from './runtime-ui';
import type {EditJob} from '../../server/media-tools';
import {workspaceOwnerKey} from './workspace-storage';
import {ClipTimeline} from '@/features/commerce-studio/clip-timeline';
import {clipSequence,type ClipRange} from '@/features/commerce-studio/clip-sequence';
import {defaultEraseRegion,validateEraseRegions,validateEraseDuration,type EraseRegion} from '../../media-edit-regions';
import {EnhancementSettings} from './enhancement-settings';
import './media-tools.css';
type AssetReply={ownerId:string;localAsset:UIAsset|null};

export function MediaTools({name,runtime,ownerKey,onNotice,onBack,onMinimize,initialAssetId}:{name:string;runtime:Runtime;ownerKey:string;onNotice:(s:string)=>void;onBack:()=>void;onMinimize?:()=>void;initialAssetId?:string}){
 const tool=name==='画质增强'?'enhance':name==='水印擦除'?'watermark':name==='字幕擦除'?'subtitle':name==='人脸打码'?'mosaic':'trim';
 const erase=tool==='watermark'||tool==='subtitle'||tool==='mosaic';
 const [timedErase,setTimedErase]=useState(false);
 const [fps,setFps]=useState(0);
 const trimVideo=useRef<HTMLVideoElement>(null);
 const [segments,setSegments]=useState<ClipRange[]>([]);
 const [assetId,setAssetId]=useState(''),[range,setRange]=useState({start:0,end:10}),[resolution,setResolution]=useState(1080),[jobs,setJobs]=useState<EditJob[]>([]),[busy,setBusy]=useState(false);
 const [regions,setRegions]=useState<EraseRegion[]>([defaultEraseRegion(tool==='subtitle'?'subtitle':tool==='mosaic'?'mosaic':'watermark')]),[selected,setSelected]=useState(0);
 const [metadata,setMetadata]=useState<{duration:number;width:number;height:number}|null>(null),[mediaError,setMediaError]=useState('');
 const [lastJobId,setLastJobId]=useState('');
 const [restoredAsset,setRestoredAsset]=useState<UIAsset|null>(null);
 const [incomingState,setIncomingState]=useState<'pending'|'ready'|'failed'>(initialAssetId?'pending':'ready'),[incomingError,setIncomingError]=useState('');
 const [incomingAttempt,setIncomingAttempt]=useState(0);
 const incomingResolved=useRef('');
 const restoredRangeAsset=useRef('');
 const fileInput=useRef<HTMLInputElement>(null),stage=useRef<HTMLDivElement>(null),submitting=useRef(false);
 const drag=useRef<{index:number;x:number;y:number;region:EraseRegion;width:number;height:number;resize:boolean}|null>(null);
 const request=useRef<{key:string;fingerprint:string}|null>(null);
 const source=runtime.assets.find(a=>a.id===assetId)||(restoredAsset?.id===assetId?restoredAsset:undefined),latest=lastJobId?jobs.find(j=>j.id===lastJobId):jobs.find(j=>j.input.assetId===assetId&&j.input.tool===tool);
 const selectableAssets=restoredAsset&&!runtime.assets.some(a=>a.id===restoredAsset.id)?[restoredAsset,...runtime.assets]:runtime.assets;
 useEffect(()=>{setMetadata(null);setMediaError('');request.current=null;},[assetId,tool]);
 function selectAsset(id:string){if(!runtime.ready)return;setAssetId(id);setSegments([]);setTimedErase(false);if(assetId||!id){setRegions([defaultEraseRegion(tool==='subtitle'?'subtitle':tool==='mosaic'?'mosaic':'watermark')]);setSelected(0);}setLastJobId('');setRange({start:0,end:10});restoredRangeAsset.current='';}
 useEffect(()=>{
  if(!initialAssetId||!runtime.ready||incomingResolved.current===initialAssetId)return;
  let cancelled=false;
  if(assetId===initialAssetId){incomingResolved.current=initialAssetId;setIncomingState('ready');return;}
  setIncomingState('pending');setIncomingError('');
  void api<AssetReply>('/api/commerce/media-tool-drafts?tool='+tool+'&assetId='+encodeURIComponent(initialAssetId)).then(reply=>{
   if(cancelled)return;
   if(workspaceOwnerKey(reply.ownerId)!==ownerKey)throw Error('登录账号已变化，请重新载入工具');
   if(!reply.localAsset||!reply.localAsset.type.startsWith('video/'))throw Error('这条成片已不存在或当前账号无法读取，请回原任务核对');
   incomingResolved.current=initialAssetId;setRestoredAsset(reply.localAsset);selectAsset(initialAssetId);setIncomingState('ready');onNotice('已将所选成片带入剪辑设置');
  }).catch(error=>{if(!cancelled){setIncomingState('failed');setIncomingError((error as Error).message);}});
  return()=>{cancelled=true;};
 },[initialAssetId,runtime.ready,tool,ownerKey,incomingAttempt]);
 useEffect(()=>{let alive=true;async function poll(){try{const value=await api<{jobs:EditJob[]}>('/api/commerce/media-tools');if(alive)setJobs(value.jobs);}catch{}}void poll();const timer=setInterval(()=>void poll(),3000);return()=>{alive=false;clearInterval(timer);};},[]);
 let validationError=mediaError;
 if(erase){try{validateEraseRegions(tool,regions);if(metadata)validateEraseDuration(metadata.duration);}catch(error){validationError=(error as Error).message;}}
 const activeRegion=regions[selected]||regions[0];
 const area=regions.reduce((sum,region)=>sum+region.width*region.height,0)*100;
 const rounded=(value:number)=>Math.round(value*10000)/10000;
 function updateCoordinate(key:keyof EraseRegion,percent:number){
  if(!Number.isFinite(percent))return;
  setRegions(current=>current.map((region,index)=>{
   if(index!==selected)return region;
   const updated={...region};
   const upper=key==='x'?1-region.width:key==='y'?1-region.height:key==='width'?1-region.x:1-region.y;
   updated[key]=rounded(Math.min(upper,Math.max(key==='width'||key==='height'?.03:0,percent/100)));
   return updated;
  }));
 }
 function beginDrag(event:PointerEvent<HTMLElement>,index:number,resize=false){
  if(!runtime.ready)return;
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
   const input={assetId,tool,start:erase?0:range.start,end:erase?0:range.end,...(tool==='trim'&&segments.length?{segments:clipSequence(segments)}:{}),resolution,...(tool==='enhance'&&fps?{fps}:{}),...(erase?{boxes:regions,...(timedErase?{eraseWindow:clipSequence([range])[0]}:{})}: {})};
   const fingerprint=JSON.stringify(input);if(!request.current||request.current.fingerprint!==fingerprint)request.current={key:crypto.randomUUID(),fingerprint};
   const value=await api<{job:EditJob}>('/api/commerce/media-tools',{...input,requestId:request.current.key});request.current=null;
   setJobs(current=>[value.job,...current.filter(j=>j.id!==value.job.id)]);setLastJobId(value.job.id);onNotice('视频处理已提交，成片将保存到资产库。');
  }catch(e){onNotice((e as Error).message);}finally{submitting.current=false;setBusy(false);}
 }
 function addRegion(){if(regions.length>=4)return;setRegions(current=>[...current,{x:.1,y:.1,width:.2,height:.1}]);setSelected(regions.length);}
 function removeRegion(){if(regions.length<2)return;setRegions(current=>current.filter((_,index)=>index!==selected));setSelected(Math.max(0,selected-1));}
 const trim=tool==='trim';
 const title=tool==='watermark'?'视频去水印':tool==='subtitle'?'视频字幕擦除':name;
 const action=trim?'导出':tool==='watermark'?'开始去水印':tool==='subtitle'?'开始擦除':tool==='enhance'?'开始增强':'开始处理';
 const locked=!runtime.ready||incomingState!=='ready';
 const submitButton=<button className="ca-primary" title={action} disabled={locked||!assetId||busy||!!validationError||!metadata||latest?.status==='running'||latest?.status==='queued'} onClick={()=>void submit()}><Play size={16}/>{busy?'提交中…':action}</button>;
 const support=erase?'支持 30 秒以内的 MP4、WebM 或 MOV':'支持 5 分钟以内的 MP4、WebM 或 MOV';
 const video=source?<video ref={trimVideo} key={source.id+'-'+tool} controls src={source.url} onLoadedMetadata={event=>{const v=event.currentTarget;setMetadata({duration:v.duration,width:v.videoWidth,height:v.videoHeight});setMediaError('');if(restoredRangeAsset.current===source.id)restoredRangeAsset.current='';else setRange({start:0,end:Math.min(300,Math.floor(v.duration*10)/10)});}} onError={()=>setMediaError('视频无法读取，请重新上传有效文件')}/>:null;
 const inputPlayer=source?(erase?<div className="ca-erase-stage" ref={stage} style={{aspectRatio:metadata?metadata.width+'/'+metadata.height:'16/9',maxWidth:metadata?600*metadata.width/metadata.height+'px':undefined}}>
    {video}{metadata&&<div className="ca-erase-overlay">{regions.map((region,index)=><div key={index} role="button" tabIndex={0} aria-label={'擦除区域 '+(index+1)} aria-pressed={selected===index} className={'ca-erase-region'+(selected===index?' is-selected':'')} style={{left:region.x*100+'%',top:region.y*100+'%',width:region.width*100+'%',height:region.height*100+'%'}} onPointerDown={event=>beginDrag(event,index)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={()=>setSelected(index)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelected(index);}}}>
     <span className="ca-erase-region-label">{index+1}</span><span className="ca-erase-handle" title="拖动调整区域大小" onPointerDown={event=>beginDrag(event,index,true)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}/>
    </div>)}</div>}
   </div>:video):null;
 return <div data-media-tool={tool} className={'ca-utility cs-media-work'+(tool==='trim'?' cs-clip-editor':'')+(erase?' ca-erase-tool':'')}>
  {trim&&<header className="ca-section-head cs-clip-header"><button onClick={onBack} title="返回首页" aria-label="返回首页"><ArrowLeft size={17}/></button><h2>{title}</h2>{submitButton}{onMinimize&&<button onClick={event=>{event.currentTarget.closest('.cs-clip-editor')?.querySelectorAll('video').forEach(player=>player.pause());onMinimize();}} aria-label="收起" title="收起剪辑台"><ChevronDown size={15}/>收起</button>}</header>}
  <div className="ca-utility-body">{trim&&<section className="cs-clip-library"><h3>素材库</h3><div><button disabled={locked} onClick={()=>fileInput.current?.click()}><Plus size={22}/>上传视频</button>{selectableAssets.filter(asset=>asset.type.startsWith('video/')).map(asset=><button key={asset.id} disabled={locked} aria-pressed={assetId===asset.id} title={asset.name} onClick={()=>{if(asset.id!==assetId)selectAsset(asset.id);}}><video muted playsInline preload="none" src={asset.url+'#t=0.01'} aria-hidden="true"/><span>{asset.name}</span></button>)}</div></section>}<div className="ca-utility-preview">{!trim&&<h3>预览</h3>}
   {trim&&source?inputPlayer:!latest&&<div className="cs-tool-empty"><Video size={34} strokeWidth={1.3}/><p>{trim?'从素材库选择视频，开始剪辑。':'处理完成后会在这里预览'+(tool==='enhance'?'增强':tool==='watermark'?'去水印':'处理')+'后的视频。'}</p></div>}
   {latest&&<div className="ca-edit-result"><strong role="status">{latest.status==='succeeded'?'处理完成':latest.status==='failed'?latest.error:'正在处理视频…'}</strong>{latest.assetId?<><video controls src={'/api/commerce/assets/'+latest.assetId}/><a href={'/api/commerce/assets/'+latest.assetId+'?download=1'}><Download size={16}/>下载成片</a></>:latest.status!=='failed'&&<LoaderCircle className="ca-spin"/>}</div>}
  </div><aside className="cs-tool-settings" data-empty-clip={trim&&!source||undefined}>{trim?(source?<h3>片段设置</h3>:<div className="cs-tool-empty"><SlidersHorizontal size={28}/><p>选中一段轨道，查看配置</p></div>):<header><button onClick={onBack} aria-label="返回创作首页"><ArrowLeft size={17}/></button><h2>{title}</h2><button disabled={locked} onClick={()=>selectAsset('')}><Plus size={14}/>新建</button></header>}
   <div className="cs-tool-scroll" data-empty={!source||undefined}>
   {!trim&&<>{source&&<div className="cs-tool-input">{inputPlayer}</div>}<button className={source?"cs-tool-replace":"cs-tool-upload"} disabled={locked} onClick={()=>fileInput.current?.click()}><Upload size={25}/><strong>{source?'更换视频':'上传视频'}</strong><small>{source?source.name:support}</small></button>{tool==='watermark'&&!source&&<div className="cs-watermark-presets" aria-label="水印区域">
     {regions.map((region,index)=><button key={index} disabled={locked} aria-pressed={index===selected} onClick={()=>setSelected(index)}>水印区 {index+1}<small>{[region.x,region.y].map(v=>Math.round(v*100)).join(',')} / {[region.x+region.width,region.y+region.height].map(v=>Math.round(v*100)).join(',')}</small></button>)}
     <button disabled={locked||regions.length>=4} aria-label="添加擦除区域" onClick={addRegion}><Plus size={16}/></button>
     {regions.length>1&&<button disabled={locked} aria-label="删除选中区域" onClick={removeRegion}><Trash2 size={15}/></button>}
   </div>}<section className="cs-tool-guide"><h3>操作指引</h3><ol><li><b>上传视频</b><span>{support}，最大 150 MB。</span></li><li><b>{erase?'框选处理区域':'选择目标画质'}</b><span>{erase?'在原片画面拖动选区并调整边界。':'根据原片选择目标分辨率。'}</span></li><li><b>{action}</b><span>处理完成后可预览或下载成片。</span></li></ol></section></>}
   {incomingState==='pending'&&<p role="status">正在读取指定成片…</p>}{incomingError&&<div role="alert"><p>{incomingError}</p><button onClick={()=>setIncomingAttempt(n=>n+1)}>重新读取指定成片</button></div>}
   <fieldset hidden={trim&&!source} disabled={!runtime.ready||incomingState!=='ready'} style={{border:0,padding:0,margin:0,minWidth:0}}>
   <label className="cs-tool-material">素材<select aria-label="媒体工具素材" disabled={!runtime.ready} value={assetId} onChange={event=>selectAsset(event.target.value)}><option value="">选择视频素材</option>{selectableAssets.filter(asset=>asset.type.startsWith('video/')).map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
   {trim&&<button disabled={locked} onClick={()=>fileInput.current?.click()}><Upload size={16}/>更换视频</button>}
   <input hidden disabled={!runtime.ready} ref={fileInput} type="file" accept="video/mp4,video/webm,video/quicktime" onChange={async event=>{const file=event.target.files?.[0];event.target.value='';if(file)try{const asset=await runtime.upload(file);selectAsset(asset.id);}catch(error){onNotice((error as Error).message);}}}/>
   {erase?(source&&<div className="ca-erase-settings">
    <p>{metadata?'原片时长 '+metadata.duration.toFixed(2)+' 秒 · '+(timedErase?'指定时段处理':'全片处理'):'选择 30 秒以内的视频'}</p>
    <div className="ca-erase-region-actions"><strong>擦除区域 {regions.length}/{tool==='watermark'||tool==='mosaic'?4:1}</strong>{(tool==='watermark'||tool==='mosaic')&&<button aria-label="添加擦除区域" disabled={regions.length>=4} onClick={addRegion}><Plus size={14}/>增加</button>}</div>
    <div className="ca-erase-region-list">{regions.map((_,index)=><button key={index} className={selected===index?'is-selected':''} aria-pressed={selected===index} onClick={()=>setSelected(index)}>区域 {index+1}</button>)}<button aria-label="删除选中区域" disabled={regions.length===1} onClick={removeRegion}><Trash2 size={14}/></button></div>
    <p>拖动框体移动位置，拖动右下角调整大小；也可输入坐标。</p>
    <div className="ca-erase-coordinates">{([['x','左侧'],['y','顶部'],['width','宽度'],['height','高度']] as const).map(([key,label])=><label key={key}>{label}（%）<input type="number" min={key==='width'||key==='height'?3:0} max="100" step="0.1" aria-label={label+'百分比'} value={Math.round(activeRegion[key]*10000)/100} onChange={event=>updateCoordinate(key,Number(event.target.value))}/></label>)}</div>
    <p>总面积 {area.toFixed(1)}% / 50% · 每条边至少 3%</p>
    {tool==='watermark'&&<p>长边超过 2048 像素时，按比例压缩至 2K 后处理。</p>}
    <p className="ca-erase-method">本地 FFmpeg 区域修补。复杂背景可能留下修补痕迹。</p>
   </div>):(source||trim)&&<><label>开始时间（秒）<input type="number" step="0.1" min="0" disabled={locked||!metadata} value={range.start} onChange={event=>setRange({...range,start:Number(event.target.value)})}/></label><label>结束时间（秒）<input type="number" step="0.1" min="0" disabled={locked||!metadata} value={range.end} onChange={event=>setRange({...range,end:Number(event.target.value)})}/></label></>}
   {validationError&&<p role="alert" className="ca-erase-error">{validationError}</p>}
   {source&&(tool==='subtitle'||tool==='watermark')&&<section><label><input type="checkbox" checked={timedErase} onChange={e=>setTimedErase(e.target.checked)}/>仅处理指定时段</label>{timedErase&&<><label>擦除开始（秒）<input type="number" step="0.1" min="0" value={range.start} onChange={e=>setRange({...range,start:Number(e.target.value)})}/></label><label>擦除结束（秒）<input type="number" step="0.1" min="0" value={range.end} onChange={e=>setRange({...range,end:Number(e.target.value)})}/></label></>}</section>}
   <p>本地处理 · FFmpeg</p>
   </fieldset></div>
   {tool==='enhance'&&<EnhancementSettings resolution={resolution} fps={fps} setResolution={setResolution} setFps={setFps}/>}
   {!trim&&submitButton}
  </aside>{tool!=='trim'&&<aside className="cs-media-results"><h3>最近任务</h3>{jobs.filter(job=>job.input.tool===tool).slice(0,12).map(job=><button key={job.id} onClick={()=>{if(job.input.assetId!==assetId)selectAsset(job.input.assetId);setLastJobId(job.id);}}><span>{new Date(job.createdAt).toLocaleTimeString()}</span><small>{job.status==='succeeded'?'处理完成':job.status==='failed'?'失败':job.status==='queued'?'排队中':'处理中'}</small></button>)}{!jobs.some(job=>job.input.tool===tool)&&<p>暂无处理记录</p>}</aside>}</div>
  {tool==='trim'&&<ClipTimeline key={assetId} locked={locked} seek={seconds=>{if(trimVideo.current)trimVideo.current.currentTime=seconds;}} segments={segments} change={setSegments} canAdd={runtime.ready&&!!metadata&&incomingState==='ready'} add={()=>{try{if(!metadata||range.end>metadata.duration+.01)throw Error('片段超出原片时长');setSegments(clipSequence([...segments,{...range}]));return true;}catch(e){onNotice((e as Error).message);return false;}}}/>} 
 </div>;
}
