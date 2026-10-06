import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runFFmpeg} from './media-tools';
import {storeAsset,assetBytes,deleteAsset,readAsset} from './assets';
import {runtimeDir,put,transaction} from './store';
import {createJob,runJob,refreshJob,recoverSavingJob,job,type Job,type JobInput} from './jobs';
import {providerCost} from './billing';
import {ensureProviderReference} from './media-reference';
import {COMMERCE_ROLLING_SEGMENT_SECONDS,planCommerceVideoSegments} from '../shared/video-generation-capabilities';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export const ROLLING_SEGMENT_SECONDS=COMMERCE_ROLLING_SEGMENT_SECONDS;
export function zeroCostRollingFixtureEnabled(){return process.env.NODE_ENV!=='production'&&process.env.COMMERCE_ALLOW_ZERO_COST_ROLLING_FIXTURE==='1';}

export type RollingExecutionPermit={isCurrent:()=>boolean};

class RollingLeaseLostError extends Error{constructor(){super('滚动任务执行租约已经失效，旧执行器已停止写入');this.name='RollingLeaseLostError';}}

function permitCurrent(permit?:RollingExecutionPermit){return permit?.isCurrent()!==false;}

export function rollingRequestId(parentId:string,segmentIndex:number,kind:'segment'|'retake'='segment',attempt=0):string{
  const hex=crypto.createHash('sha256').update(`commerce-rolling/v1:${parentId}:${kind}:${segmentIndex}:${attempt}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export function planSegments(duration:number,nativeDurations:number|readonly number[]):number[]|null{
  const supported=Array.isArray(nativeDurations)
    ? nativeDurations
    : Array.from({length:Math.max(0,Math.min(ROLLING_SEGMENT_SECONDS,Math.floor(Number(nativeDurations)))-3)},(_,index)=>index+4);
  return planCommerceVideoSegments(duration,supported);
}

export function rollingIncurredCost(value:Job,owner:string){
  const children=(value.rollingState?.childIds||[]).map((id)=>job(id,owner)).filter((child):child is Job=>Boolean(child?.dispatchedAt));
  return Math.round(children.reduce((sum,child)=>sum+providerCost(child).amount,0)*10000)/10000;
}

type StructuredRollingPrompt={story:string;materials:string;setting:string;shots:{start:number;end:number;title:string;body:string}[];forbid:string};
function section(text:string,title:string,nextTitles:string[]){
  const start=text.indexOf(`## ${title}`);if(start<0)return '';
  const bodyStart=start+`## ${title}`.length;
  const ends=nextTitles.map(next=>text.indexOf(`## ${next}`,bodyStart)).filter(value=>value>=0);
  return text.slice(bodyStart,ends.length?Math.min(...ends):text.length).trim();
}
export function parseStructuredRollingPrompt(text:string):StructuredRollingPrompt|null{
  const story=section(text,'剧情梗概',['素材与职责']);
  const materials=section(text,'素材与职责',['主体与全片设定']);
  const setting=section(text,'主体与全片设定',['镜头 / 时间轴']);
  const timeline=section(text,'镜头 / 时间轴',['始终禁止']);
  const forbid=section(text,'始终禁止',[]);
  if(!story||!materials||!setting||!timeline||!forbid)return null;
  const shots:{start:number;end:number;title:string;body:string}[]=[];
  const matcher=/\*\*\[镜头\d+：([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)s｜([^\]]+)\]\*\*\s*\n+\s*"([\s\S]*?)"(?=\s*\n+\s*\*\*\[镜头\d+：|\s*$)/gu;
  for(const match of timeline.matchAll(matcher)){const start=Number(match[1]),end=Number(match[2]);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;shots.push({start,end,title:match[3].trim(),body:match[4].trim()});}
  if(!shots.length)return null;
  return {story,materials,setting,shots,forbid};
}
function seconds(value:number){return Number.isInteger(value)?String(value):String(Math.round(value*1000)/1000);}
export function sliceStructuredRollingPrompt(text:string,start:number,end:number,isLast:boolean){
  const parsed=parseStructuredRollingPrompt(text);if(!parsed)return null;
  const selected=parsed.shots.filter(shot=>shot.start<end&&shot.end>start);
  if(!selected.length)throw Error(`结构化导演脚本在 ${start}-${end} 秒没有可执行镜头`);
  const setting=isLast?parsed.setting:parsed.setting.replace(/\n\n转化收尾：\n[\s\S]*?(?=\n\n声音：|$)/u,'');
  const shots=selected.map((shot,index)=>{
    const localStart=Math.max(start,shot.start)-start,localEnd=Math.min(end,shot.end)-start;
    return `**[镜头${index+1}：${seconds(localStart)}-${seconds(localEnd)}s｜${shot.title}]**\n\n"${shot.body}"`;
  });
  return ['## 剧情梗概',parsed.story,'## 素材与职责',parsed.materials,'## 主体与全片设定',setting,'## 镜头 / 时间轴',...shots,'## 始终禁止',parsed.forbid].join('\n\n');
}

export function compileSegmentPrompt(user:string,index:number,total:number,start:number,end:number,totalDuration:number,hasReferences=false,hasTailFrame=index>1):string{
  const structured=sliceStructuredRollingPrompt(user,start,end,index===total);
  if(structured)return [
    structured,
    '',
    `## 本段执行边界`,
    `本段为全片第 ${index}/${total} 段，覆盖全片 ${start}-${end} 秒；上方镜头时码已经换算为本段 0-${end-start} 秒。`,
    hasReferences?'按输入顺序持续使用原始商品、人物和场景参考，不得交换素材职责。':'本段没有原始外部参考素材。',
    ...(hasTailFrame?['最后一张 last-frame 是上一段真实尾帧，只约束本段开头最多5帧的构图、人物位置、动作趋势、服装、场景、光线与色调；必须立即自然续接新动作，不得冻结、复制、循环或长时间复现该尾帧。','声音必须延续上一段的说话人音色、语速、环境底噪与背景音乐节拍，不得重新开场、淡入或重复上一句。']:[]),
    index===total?'这是最后一段，按已确认脚本执行转化收尾。':'这不是最后一段，不得提前执行转化收尾。',
  ].join('\n');
  return [
    '## 素材与职责','',hasReferences?'按输入顺序持续使用原始商品、人物和场景参考，不得交换素材职责。':'无参考素材。',
    ...(hasTailFrame?['','最后一张 last-frame 是上一段真实尾帧，只约束本段开头最多5帧的构图、人物位置、动作趋势、服装、场景、光线与色调；必须立即自然续接新动作，不得冻结、复制、循环或长时间复现该尾帧，也不得用它替换原商品事实。']:[]),'',
    '## 主体与全片设定','',
    `以下主体、场景、人物与风格在全部 ${total} 段中保持完全一致，全片总时长 ${totalDuration} 秒。`,'',
    '# 镜头 / 时间轴','',
    `## [镜头${index}｜${start}-${end}s｜镜头内容]`,'',
    `- 主体与内容：${user}`,
    `- 本段为全片第 ${index}/${total} 段，覆盖 ${start}-${end} 秒。`,
    index>1?'- 衔接要求：本段紧接上一段结束画面顺势继续，人物位置、动作趋势、服装、场景、光线与色调完全一致，动作自然延续，不得重新开场。':'- 开场要求：自然进入场景，交代主体与环境。',
    '- 表演与真实感：真实带货口播氛围，画面稳定，轻微手持感。','',
    '# 保持与禁止','','## 始终保持','',
    '人物外貌、发型、服装、场景布置、光线方向与色调在全片所有段落中完全一致；不切换镜头风格。','',
    '## 始终禁止','',
    '画面出现字幕或水印；使用转场特效；人物换装或场景跳变；出现与上文无关的新主体。',
  ].join('\n');
}

export function preflightRollingJob(value:Pick<Job,'input'>){
 const plan=value.input.rollingPlan;if(!plan?.segments.length)throw Error('滚动视频缺少分段计划');
 const totalDuration=plan.segments.reduce((sum,duration)=>sum+duration,0),prompts:string[]=[];
 for(let index=0,start=0;index<plan.segments.length;index++){const end=start+plan.segments[index];prompts.push(compileSegmentPrompt(String(value.input.prompt||''),index+1,plan.segments.length,start,end,totalDuration,Boolean(value.input.references?.length),index>0));start=end;}
 if(prompts.some(prompt=>!prompt.trim()))throw Error('滚动视频存在空分段提示词');
 return prompts;
}


async function persist(value:Job,owner:string,stage?:string,permit?:RollingExecutionPermit){
  transaction(()=>{
    if(permit&&!permit.isCurrent())throw new RollingLeaseLostError();
    value.updatedAt=Date.now();
    if(stage)value.events=[...(value.events||[]),{at:Date.now(),stage}];
    put('jobs',value.id,owner,value);
  });
}

export async function cleanupRollingTailAssets(value:Job,owner:string,permit?:RollingExecutionPermit){
  const state=value.rollingState;if(!state)return;
  const ids=[...new Set(state.tailFrameAssetIds||[])];
  state.temporaryAssetsCleanupStatus='pending';state.temporaryAssetsCleanupAttempts=Number(state.temporaryAssetsCleanupAttempts||0)+1;state.temporaryAssetsCleanupRetryAt=undefined;state.temporaryAssetsCleanupError=undefined;value.rollingState={...state};await persist(value,owner,'rolling-tail-cleanup-pending',permit);
  try{for(const id of ids){if(!permitCurrent(permit))throw new RollingLeaseLostError();if(readAsset(id,owner))await deleteAsset(owner,id,{parentJobId:value.id,...(permit?{isCurrent:permit.isCurrent}:{})});}state.tailFrameAssetIds=[];state.temporaryAssetsCleanupStatus='complete';state.temporaryAssetsCleanedAt=Date.now();state.temporaryAssetsCleanupRetryAt=undefined;state.temporaryAssetsCleanupError=undefined;value.rollingState={...state};await persist(value,owner,'rolling-tail-cleanup-done',permit);}
  catch(error){if(error instanceof RollingLeaseLostError)throw error;state.temporaryAssetsCleanupStatus='failed';state.temporaryAssetsCleanupRetryAt=Date.now()+Math.min(300_000,15_000*2**Math.min(Number(state.temporaryAssetsCleanupAttempts||1)-1,4));state.temporaryAssetsCleanupError=error instanceof Error?error.message:'临时尾帧清理失败';value.rollingState={...state};await persist(value,owner,'rolling-tail-cleanup-failed',permit);}
}

export async function runRollingJob(value:Job,owner:string,permit?:RollingExecutionPermit){
  if(!permitCurrent(permit))return;
  const plan=value.input.rollingPlan!;
  const state=value.rollingState??{childIds:[],segmentIndex:0,segmentAssetIds:[],tailFrameAssetIds:[]};
  state.tailFrameAssetIds||=[];
  if(!value.rollingState){value.rollingState=state;await persist(value,owner,'rolling-start',permit);}
  state.segmentIndex=state.segmentAssetIds.length;
  const totalDuration=plan.segments.reduce((a,b)=>a+b,0);
  for(let i=state.segmentIndex;i<plan.segments.length;i++){
    if(!permitCurrent(permit))return;
    const start=plan.segments.slice(0,i).reduce((a,b)=>a+b,0);
    const end=start+plan.segments[i];
    const previousTail=i>0?state.tailFrameAssetIds[i-1]:undefined;
    const references=[...(value.input.references||[]),...(previousTail?[{id:previousTail,slot:'last-frame'}]:[])];
    const prompt=compileSegmentPrompt(String(value.input.prompt||''),i+1,plan.segments.length,start,end,totalDuration,references.length>0,Boolean(previousTail));
    const childInput:JobInput={requestId:rollingRequestId(value.id,i),kind:'video',modelId:value.model.id,prompt,duration:plan.segments[i],aspectRatio:value.input.aspectRatio,resolution:value.input.resolution,generateAudio:value.input.generateAudio,references,rollingChild:true,rollingParentJobId:value.id,rollingSegmentIndex:i};
    let child=null as Job|null;
    try{child=await createJob(owner,childInput,undefined,{rollingParentId:value.id,segmentIndex:i});}catch(error){
      if(error instanceof RollingLeaseLostError)throw error;value.status='failed';value.error=`滚动生成第 ${i+1} 段任务创建失败：${(error as Error).message}`;await persist(value,owner,`rolling-segment-${i+1}-create-failed`,permit);return;
    }
    state.childIds[i]=child.id;state.segmentIndex=i;
    value.rollingState={...state};
    await persist(value,owner,`rolling-segment-${i+1}-queued`,permit);
    if(child.status==='queued')void runJob(child.id,owner).catch(()=>{});
    let cursor=job(child.id,owner);
    for(let tries=0;tries<120;tries++){
      if(!permitCurrent(permit))return;
      if(cursor?.status==='saving')await recoverSavingJob(child.id,owner).catch(()=>{});else await refreshJob(child.id,owner).catch(()=>{});
      cursor=job(child.id,owner);
      if(!cursor||['succeeded','failed','save_failed','unknown'].includes(cursor.status))break;
      await sleep(15000);
    }
    if(cursor?.status==='unknown'){
      value.status='unknown';value.error=`滚动生成第 ${i+1}/${plan.segments.length} 段结果待核对；已固定原子任务 ${cursor.id.slice(0,8)}，不会创建替代任务或重复扣费`;
      await persist(value,owner,`rolling-segment-${i+1}-unknown`,permit);return;
    }
    if(!cursor||cursor.status!=='succeeded'||!cursor.assetIds.length){
      value.status='failed';value.error=`滚动生成第 ${i+1}/${plan.segments.length} 段未完成：${cursor?.error||'结果未知'}（已完成的分段保留在任务队列，未完成段不重复计费前请先核对原任务）`;
      await persist(value,owner,`rolling-segment-${i+1}-failed`,permit);return;
    }
    state.segmentAssetIds[i]=cursor.assetIds[0];
    if(i<plan.segments.length-1)state.tailFrameAssetIds[i]=(await extractLastFrameAsset(value,owner,cursor.assetIds[0],i,permit)).id;
    state.segmentIndex=i+1;
    value.rollingState={...state};
    await persist(value,owner,`rolling-segment-${i+1}-done`,permit);
  }
  if(!permitCurrent(permit))return;
  await persist(value,owner,'rolling-stitch',permit);
  try{
    const final=await stitchSegments(value,owner,state.segmentAssetIds,permit);
    if(!permitCurrent(permit))return;
    value.assetIds=[final.id];
    value.status='succeeded';value.error=undefined;
    value.rollingState={...state,finalEvidence:value.rollingState?.finalEvidence,restitchRetryAt:undefined,temporaryAssetsCleanupStatus:'pending'};
    await persist(value,owner,'rolling-done',permit);
    await cleanupRollingTailAssets(value,owner,permit);
  }catch(error){
    value.status='save_failed';value.error=`滚动分段已全部生成，拼接失败：${(error as Error).message}`;
    value.rollingState={...state,restitchAttempts:Number(state.restitchAttempts||0),restitchRetryAt:Date.now()+15_000};
    if(error instanceof RollingLeaseLostError)throw error;await persist(value,owner,'rolling-stitch-failed',permit);
  }
}

function verifiedRollingSegmentAssets(value:Job,owner:string){
  const plan=value.input.rollingPlan;
  const state=value.rollingState;
  if(!plan||!state||state.segmentAssetIds.length!==plan.segments.length||state.childIds.length!==plan.segments.length)throw Error('滚动父任务缺少完整分段，不能重新拼接');
  for(let index=0;index<plan.segments.length;index++){
    const child=job(state.childIds[index],owner);
    const asset=readAsset(state.segmentAssetIds[index],owner);
    if(!child||child.input.rollingParentJobId!==value.id||child.input.rollingSegmentIndex!==index||child.status!=='succeeded'||child.assetIds[0]!==state.segmentAssetIds[index])throw Error(`第 ${index+1} 段不是父任务已成功的原分段，不能重新拼接`);
    if(!asset||!asset.type.startsWith('video/'))throw Error(`第 ${index+1} 段视频资产已不存在，不能重新拼接`);
  }
  return [...state.segmentAssetIds];
}

/** Retry only the local concat/persistence stage. It never creates a child job,
 * submits a provider request, or changes the immutable parent quote. */
export async function restitchRollingJob(value:Job,owner:string,permit?:RollingExecutionPermit){
  const current=job(value.id,owner);
  if(!current||current.input.rollingChild||!current.input.rollingPlan)throw Error('滚动父任务不存在');
  if(current.status==='succeeded')return current;
  if(!['save_failed','saving'].includes(current.status))throw Error('滚动父任务当前不需要重新拼接');
  if(!permitCurrent(permit))return current;
  const segmentAssetIds=verifiedRollingSegmentAssets(current,owner);
  const attempts=Number(current.rollingState?.restitchAttempts||0)+1;
  current.status='saving';
  current.error=undefined;
  current.rollingState={...current.rollingState!,restitchAttempts:attempts,restitchRetryAt:undefined};
  await persist(current,owner,`rolling-restitch-${attempts}-started`,permit);
  try{
    const final=await stitchSegments(current,owner,segmentAssetIds,permit);
    if(!permitCurrent(permit))return job(current.id,owner)||current;
    current.assetIds=[final.id];
    current.status='succeeded';
    current.error=undefined;
    current.rollingState={...current.rollingState!,restitchRetryAt:undefined,temporaryAssetsCleanupStatus:'pending'};
    await persist(current,owner,`rolling-restitch-${attempts}-done`,permit);
    await cleanupRollingTailAssets(current,owner,permit);
  }catch(error){
    current.status='save_failed';
    current.error=`滚动分段保留完好，第 ${attempts} 次重新拼接失败：${(error as Error).message}`;
    current.rollingState={...current.rollingState!,restitchRetryAt:Date.now()+Math.min(300_000,15_000*2**Math.min(attempts,4))};
    if(error instanceof RollingLeaseLostError)throw error;await persist(current,owner,`rolling-restitch-${attempts}-failed`,permit);
  }
  return current;
}

async function extractLastFrameAsset(parent:Job,owner:string,videoAssetId:string,segmentIndex:number,permit?:RollingExecutionPermit){
  const asset=readAsset(videoAssetId,owner);
  if(!asset||!asset.type.startsWith('video/'))throw Error(`第 ${segmentIndex+1} 段结果不是可提取尾帧的视频`);
  const directory=path.join(runtimeDir(),'rolling',`${parent.id}-tail-${segmentIndex}-${Date.now()}`);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const source=path.join(directory,'segment.mp4'),output=path.join(directory,'tail.jpg');
  try{
    await fs.writeFile(source,await assetBytes(asset));
    await runFFmpeg(['-hide_banner','-nostdin','-y','-sseof','-0.12','-i',source,'-map','0:v:0','-an','-frames:v','1','-q:v','2',output],60_000);
    const bytes=await fs.readFile(output);
    return await ensureProviderReference(await storeAsset(owner,bytes,'image/jpeg',`滚动衔接尾帧-${segmentIndex+1}-${parent.id.slice(0,8)}.jpg`,'generated',parent.id,{kind:'rolling-tail',parentJobId:parent.id,segmentIndex},`rolling-tail:${parent.id}:${segmentIndex}`,permit?.isCurrent),permit?.isCurrent);
  }finally{
    await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
}

async function stitchSegments(value:Job,owner:string,segmentAssetIds:string[],permit?:RollingExecutionPermit){
  const directory=path.join(runtimeDir(),'rolling',value.id+'-stitch-'+Date.now());
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  try{
    const listFile=path.join(directory,'concat.txt');
    const lines:string[]=[];
    for(let i=0;i<segmentAssetIds.length;i++){
      const asset=readAsset(segmentAssetIds[i],owner);
      if(!asset)throw Error(`分段素材 ${i+1} 已不存在`);
      const part=path.join(directory,`segment-${i+1}.mp4`);
      await fs.writeFile(part,await assetBytes(asset));
      lines.push(`file '${part.replace(/\\/g, '/')}'`);
    }
    await fs.writeFile(listFile, lines.join('\n'));
    const output=path.join(directory,'rolling-film.mp4');
    const audioArgs=value.input.generateAudio===false
      ?['-an']
      :['-map','0:a?','-c:a','aac','-ar','48000','-ac','2','-af','aresample=48000:async=1:first_pts=0'];
    await runFFmpeg(['-hide_banner','-nostdin','-y','-f','concat','-safe','0','-i',listFile,'-map','0:v:0',...audioArgs,'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-r','24','-fps_mode','cfr','-movflags','+faststart',output],600000);
    const probe=await runFFmpeg(['-hide_banner','-nostdin','-i',output,'-map','0:v:0','-frames:v','1','-f','null','-'],60_000);
    const clock=probe.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/),fpsMatch=probe.match(/(?:,|\s)(\d+(?:\.\d+)?)\s+fps(?:,|\s)/);
    if(!clock||!fpsMatch)throw Error('拼接成片缺少可验证的时长或帧率');
    const durationSeconds=Number(clock[1])*3600+Number(clock[2])*60+Number(clock[3]),fps=Number(fpsMatch[1]),hasAudio=/Audio:\s/.test(probe);
    if(Math.abs(durationSeconds-value.input.rollingPlan!.segments.reduce((a,b)=>a+b,0))>1||!Number.isFinite(fps)||fps<=0)throw Error('拼接成片时长或帧率不符合父任务合同');
    if(value.input.generateAudio===true&&!hasAudio)throw Error('父任务要求声音，但拼接成片没有音轨');
    value.rollingState={...(value.rollingState||{childIds:[],segmentIndex:segmentAssetIds.length,segmentAssetIds}),finalEvidence:{durationSeconds,fps,hasAudio,segmentOrder:[...segmentAssetIds]}};
    const bytes=await fs.readFile(output);
    const total=segmentAssetIds.length?value.input.rollingPlan!.segments.reduce((a,b)=>a+b,0):0;
    return await storeAsset(owner,bytes,'video/mp4',`滚动成片-${total}s-${value.id.slice(0,8)}.mp4`,'generated',value.id,undefined,`rolling-final:${value.id}`,permit?.isCurrent);
  }finally{
    await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
}

export async function retakeSegment(value:Job,owner:string,segmentIndex:number){
  if(!zeroCostRollingFixtureEnabled())throw Error('长视频分段重拍的独立报价与精确扣款尚未完成，当前已停止付费重拍');
  const plan=value.input.rollingPlan!;
  if(!(segmentIndex>=0&&segmentIndex<plan.segments.length))throw Error('分段序号无效');
  if(!value.rollingState||value.rollingState.segmentAssetIds.length!==plan.segments.length)throw Error('仅支持已全部完成的滚动成片重拍分段');
  const state=value.rollingState;
  if(state.retakeChildId&&state.retakingSegment===segmentIndex){const current=job(state.retakeChildId,owner);if(current&&['queued','running','processing','saving','unknown'].includes(current.status))throw Error(`第 ${segmentIndex+1} 段已有重拍任务 ${current.id.slice(0,8)}，请先核对原任务`);}
  const start=plan.segments.slice(0,segmentIndex).reduce((a,b)=>a+b,0);
  const end=start+plan.segments[segmentIndex];
  let previousTail=segmentIndex>0?state.tailFrameAssetIds?.[segmentIndex-1]:undefined;
  if(segmentIndex>0&&(!previousTail||!readAsset(previousTail,owner))){previousTail=(await extractLastFrameAsset(value,owner,state.segmentAssetIds[segmentIndex-1],segmentIndex-1)).id;state.tailFrameAssetIds||=[];state.tailFrameAssetIds[segmentIndex-1]=previousTail;}
  const references=[...(value.input.references||[]),...(previousTail?[{id:previousTail,slot:'last-frame'}]:[])];
  const prompt=compileSegmentPrompt(String(value.input.prompt||''),segmentIndex+1,plan.segments.length,start,end,plan.segments.reduce((a,b)=>a+b,0),references.length>0,Boolean(previousTail));
  const attempt=Number(state.retakeAttempt||0)+1;
  state.retakeAttempt=attempt;state.retakingSegment=segmentIndex;
  value.rollingState={...state};
  await persist(value,owner,`retake-segment-${segmentIndex+1}-claimed`);
  const child=await createJob(owner,{requestId:rollingRequestId(value.id,segmentIndex,'retake',attempt),kind:'video',modelId:value.model.id,prompt,duration:plan.segments[segmentIndex],aspectRatio:value.input.aspectRatio,resolution:value.input.resolution,generateAudio:value.input.generateAudio,references,rollingChild:true,rollingParentJobId:value.id,rollingSegmentIndex:segmentIndex},undefined,{rollingParentId:value.id,segmentIndex});
  value.rollingState={...state,retakeChildId:child.id};
  await persist(value,owner,`retake-segment-${segmentIndex+1}-queued`);
  if(child.status==='queued')void runJob(child.id,owner).catch(()=>{});
  let cursor=job(child.id,owner);
  for(let tries=0;tries<120;tries++){
    await refreshJob(child.id,owner).catch(()=>{});
    cursor=job(child.id,owner);
    if(!cursor||['succeeded','failed','save_failed','unknown'].includes(cursor.status))break;
    await sleep(15000);
  }
  if(!cursor||cursor.status!=='succeeded'||!cursor.assetIds.length)throw Error(`第 ${segmentIndex+1} 段重拍未完成：${cursor?.error||'结果未知'}`);
  state.segmentAssetIds[segmentIndex]=cursor.assetIds[0];
  state.tailFrameAssetIds||=[];
  if(segmentIndex<plan.segments.length-1)state.tailFrameAssetIds[segmentIndex]=(await extractLastFrameAsset(value,owner,cursor.assetIds[0],segmentIndex)).id;
  value.rollingState={...state};
  await persist(value,owner,`retake-segment-${segmentIndex+1}-done`);
  const final=await stitchSegments(value,owner,state.segmentAssetIds);
  value.assetIds=[final.id];
  value.status='succeeded';
  await persist(value,owner,'retake-restitched');
  await cleanupRollingTailAssets(value,owner);
  return value;
}
