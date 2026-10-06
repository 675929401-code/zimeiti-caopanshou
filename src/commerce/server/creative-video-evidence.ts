import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import {runtimeDir} from './store';
import {readAsset,validateMediaBytes,type Asset} from './assets';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION} from '../shared/video-generation-capabilities';

// A local evidence contract, not an implementation of the benchmark's private
// backend. Audio is preserved, never presented as understood or transcribed.
export const CREATIVE_EVIDENCE_VERSION='creative-video-evidence-v1';
export type CreativeVideoProfile={id:string;maxDurationSeconds:number;recommendedDurationSeconds:number;maxFrames?:number};
export const CREATIVE_VIDEO_PROFILES={
 tutorial30:{id:'tutorial-recommendation-30',maxDurationSeconds:30,recommendedDurationSeconds:30,maxFrames:24},
 component60:{id:'public-component-limit-60',maxDurationSeconds:60,recommendedDurationSeconds:30,maxFrames:24},
 longForm80:{id:'commerce-long-form-80',maxDurationSeconds:COMMERCE_VIDEO_MAX_TOTAL_DURATION,recommendedDurationSeconds:30,maxFrames:32},
} as const satisfies Record<string,CreativeVideoProfile>;
type Profile=Required<CreativeVideoProfile>;
type Artifact={file:string;sha256:string;bytes:number};
export type CreativeVideoFrame=Artifact&{id:string;timeSeconds:number;requestedTimeSeconds:number;width:number;height:number;reasons:string[]};
export type CreativeVideoEvidence={
 id:string;version:string;ownerHash:string;createdAt:number;profile:Profile;
 source:{assetId:string;sha256:string;bytes:number;type:string;name:string;durationSeconds:number;startTimestampSeconds:number;width:number;height:number;fps:number;packetCount:number};
 durationEvidence:{method:'video-packet-pts-plus-duration';timeBaseNumerator:number;timeBaseDenominator:number;headerDurationSeconds:number|null};
 cuts:{timeSeconds:number;scoreThreshold:number}[];
 frames:CreativeVideoFrame[];
 audio:{hasTrack:boolean;tracks:{streamIndex:number;codec:string;sampleRate:number|null;layout:string|null}[];extracted?:Artifact&{sampleRate:number;channels:number;durationSeconds:number;coverage:'first-audio-track-clipped-to-video-duration'};transcription:'not-performed';understanding:'not-performed'};
 facts:{missingAudioTrack:boolean;blackSegments:{start:number;end:number;duration:number}[];blackTail:{detected:boolean;start:number|null;end:number|null;pixelThreshold:number;pictureRatio:number;minDurationSeconds:number}};
 limitations:string[];profileEvidence:{tutorialRecommendationSeconds:30;publicComponentValidationSeconds:60;privateServerLimitVerified:false};
};
type PrepareOptions={expectedSourceSha256?:string;expectedPipelineVersion?:string;assertCurrent?:()=>void|Promise<void>};
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const ownerKey=(owner:string)=>sha(owner);
const hex=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9-]{36}$/;
const inFlight=new Map<string,Promise<CreativeVideoEvidence>>();
function profileValue(value:CreativeVideoProfile):Profile{
 if(!value||!/^[-a-zA-Z0-9_]{1,80}$/.test(value.id)||!Number.isFinite(value.maxDurationSeconds)||value.maxDurationSeconds<=0||value.maxDurationSeconds>COMMERCE_VIDEO_MAX_TOTAL_DURATION||!Number.isFinite(value.recommendedDurationSeconds)||value.recommendedDurationSeconds<=0||value.recommendedDurationSeconds>value.maxDurationSeconds||!Number.isInteger(value.maxFrames??24)||(value.maxFrames??24)<4||(value.maxFrames??24)>48)throw Error(`请指定有效的视频证据处理规则（最长不超过${COMMERCE_VIDEO_MAX_TOTAL_DURATION}秒）`);
 return {id:value.id,maxDurationSeconds:value.maxDurationSeconds,recommendedDurationSeconds:value.recommendedDurationSeconds,maxFrames:value.maxFrames??24};
}
function childPath(root:string,name:string){const resolved=path.resolve(root,name);if(resolved===path.resolve(root)||!resolved.startsWith(path.resolve(root)+path.sep))throw Error('视频证据路径越界');return resolved;}
async function ensureRoot(){const runtime=runtimeDir();await fs.mkdir(runtime,{recursive:true});const root=childPath(runtime,'creative-video-evidence');await fs.mkdir(root,{recursive:true,mode:0o700});if((await fs.lstat(root)).isSymbolicLink())throw Error('视频证据目录不能是链接');const realRuntime=await fs.realpath(runtime),realRoot=await fs.realpath(root);if(!realRoot.startsWith(realRuntime+path.sep))throw Error('视频证据目录越界');return root;}
async function regularFile(file:string){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('视频证据必须是普通文件');return stat;}
async function ownedSource(owner:string,assetId:string,expected?:string){
 if(!uuid.test(assetId))throw Error('参考视频ID无效');const asset=readAsset(assetId,owner);if(!asset||!asset.type.startsWith('video/'))throw Error('请选择当前账号拥有的视频');if(expected&&(!hex.test(expected)||asset.sha256!==expected))throw Error('参考视频版本已经改变');
 const source=childPath(path.join(runtimeDir(),'assets'),asset.id);const stat=await regularFile(source);if(stat.size<1||stat.size>150*1024*1024||stat.size!==asset.size)throw Error('参考视频字节大小与保存记录不一致');
 const bytes=await fs.readFile(source);validateMediaBytes(bytes,asset.type);if(sha(bytes)!==asset.sha256)throw Error('参考视频SHA校验失败，不能使用旧证据');return {asset,bytes};
}
// Same bundled FFmpeg resolution as media-tools, with a larger but bounded
// diagnostic buffer: scene logs must not silently lose early transitions.
async function ffmpeg(args:string[],timeout=90000){
 const executable=process.env.COMMERCE_FFMPEG_PATH||(existsSync(path.join(runtimeDir(),'bin','ffmpeg.exe'))?path.join(runtimeDir(),'bin','ffmpeg.exe'):(ffmpegPath&&existsSync(ffmpegPath)?ffmpegPath:'ffmpeg'));if(!executable)throw Error('本地视频处理程序未安装');
 return new Promise<string>((resolve,reject)=>{let log='',settled=false;const child=spawn(executable,['-hide_banner','-nostdin','-threads','2',...args],{windowsHide:true,shell:false,stdio:['ignore','ignore','pipe']});const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(log);};const timer=setTimeout(()=>{child.kill();finish(Error('视频证据处理超时'));},timeout);child.stderr.on('data',chunk=>{log+=chunk.toString();if(log.length>2*1024*1024){child.kill();finish(Error('视频诊断信息过多，请裁剪较短片段'));}});child.on('error',()=>finish(Error('本地视频处理程序无法启动')));child.on('close',code=>finish(code===0?undefined:Error('视频无法完整解码或提取证据')));});
}
async function artifact(file:string):Promise<Artifact>{const bytes=await fs.readFile(file);return {file:path.basename(file),sha256:sha(bytes),bytes:bytes.length};}
function durationFromHeader(log:string){const m=log.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);return m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):null;}
function packetFacts(text:string){
 const tb=text.match(/^#tb\s+0:\s*(\d+)\/(\d+)/m);if(!tb)throw Error('无法读取视频时间基准');const numerator=Number(tb[1]),denominator=Number(tb[2]);if(!numerator||!denominator)throw Error('视频时间基准无效');
 const packets=text.split(/\r?\n/).filter(line=>/^\s*0\s*,/.test(line)).map(line=>{const parts=line.split(',').map(s=>s.trim());return {pts:Number(parts[2]),duration:Number(parts[3])};});if(!packets.length||packets.length>100000||packets.some(p=>!Number.isFinite(p.pts)||!Number.isFinite(p.duration)||p.duration<=0))throw Error('视频包时间戳或帧时长无效');
 const start=Math.min(...packets.map(p=>p.pts)),end=Math.max(...packets.map(p=>p.pts+p.duration));return {numerator,denominator,start:start*numerator/denominator,duration:(end-start)*numerator/denominator,count:packets.length,timestamps:[...new Set(packets.map(p=>(p.pts-start)*numerator/denominator))].sort((a,b)=>a-b)};
}
function audioTracks(log:string){const input=log.split('Output #')[0];return [...input.matchAll(/Stream #0:(\d+)[^\r\n]*?Audio:\s*([^\r\n]+)/g)].map(m=>{const fields=m[2].split(',').map(s=>s.trim()),rate=fields.findIndex(s=>/^\d+ Hz$/.test(s));return {streamIndex:Number(m[1]),codec:fields[0],sampleRate:rate>=0?Number(fields[rate].split(' ')[0]):null,layout:rate>=0?fields[rate+1]||null:null};});}
function pcmWav(bytes:Buffer){if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('音频提取格式无效');let offset=12,rate=0,channels=0,bits=0,data=0;while(offset+8<=bytes.length){const name=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;if(start+length>bytes.length)throw Error('音频提取文件不完整');if(name==='fmt '&&length>=16){if(bytes.readUInt16LE(start)!==1)throw Error('音频提取不是PCM');channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);bits=bytes.readUInt16LE(start+14);}if(name==='data')data+=length;offset=start+length+(length%2);}if(!rate||!channels||!bits||!data)throw Error('音轨存在但未提取到有效音频');return {sampleRate:rate,channels,durationSeconds:data/(rate*channels*bits/8)};}
function chooseFrames(duration:number,fps:number,cuts:number[],max:number,timestamps:number[]){
 const last=timestamps.at(-1)??0,points=new Map<number,{reasons:Set<string>;requested:number}>();const add=(time:number,reason:string)=>{const requested=Math.max(0,Math.min(last,time)),t=timestamps.find(value=>value>=requested-1e-7)??last;const previous=points.get(t);if(previous)previous.reasons.add(reason);else points.set(t,{reasons:new Set([reason]),requested});};
 add(0,'first');add(last,'last');const uniform=Math.min(10,Math.max(2,Math.floor(max/2)));for(let i=1;i<uniform-1;i++)add(last*i/(uniform-1),'uniform');
 const candidates=cuts.flatMap(t=>[{time:Math.max(0,t-1/fps),reason:'before-cut'},{time:t,reason:'after-cut'}]);const remaining=max-points.size;const count=Math.min(remaining,candidates.length);for(let i=0;i<count;i++){const c=candidates[Math.floor(i*candidates.length/count)];add(c.time,c.reason);}return [...points].sort(([a],[b])=>a-b).map(([time,value])=>({time,requested:value.requested,reasons:[...value.reasons]}));
}
async function verifiedManifest(root:string,owner:string,id:string):Promise<CreativeVideoEvidence|undefined>{
 if(!hex.test(id))throw Error('视频证据ID无效');const directory=childPath(root,id);try{const stat=await fs.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('视频证据目录无效');const file=path.join(directory,'manifest.json');await regularFile(file);const raw=await fs.readFile(file,'utf8');if(raw.length>500000)throw Error('视频证据清单过大');const m=JSON.parse(raw) as CreativeVideoEvidence;if(m.id!==id||m.ownerHash!==ownerKey(owner)||m.version!==CREATIVE_EVIDENCE_VERSION)throw Error('视频证据来源或版本无效');const profile=profileValue(m.profile);const expectedId=sha(JSON.stringify({owner:ownerKey(owner),assetId:m.source.assetId,sha256:m.source.sha256,version:CREATIVE_EVIDENCE_VERSION,profile}));if(expectedId!==id)throw Error('视频证据指纹无效');if(!Array.isArray(m.frames)||!m.frames.length||m.frames.length>profile.maxFrames)throw Error('视频证据帧清单无效');const files=[...m.frames,...(m.audio.extracted?[m.audio.extracted]:[])];for(const a of files){if(!/^(?:frame-\d{3}\.jpg|audio\.wav)$/.test(a.file))throw Error('视频证据文件名无效');const source=childPath(directory,a.file);const stat=await regularFile(source);if(stat.size!==a.bytes||sha(await fs.readFile(source))!==a.sha256)throw Error('视频证据文件损坏');}return m;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
async function cleanup(directory:string){const root=await ensureRoot();const resolved=path.resolve(directory);if(!resolved.startsWith(root+path.sep)||!path.basename(resolved).startsWith('.work-'))throw Error('临时证据清理路径越界');if((await fs.lstat(resolved).catch(()=>null))?.isSymbolicLink())throw Error('临时证据目录不能是链接');await fs.rm(resolved,{recursive:true,force:true});}

export async function prepareCreativeVideoEvidence(owner:string,assetId:string,profile:CreativeVideoProfile,options:PrepareOptions={}):Promise<CreativeVideoEvidence>{
 const selected=profileValue(profile);if(options.expectedPipelineVersion&&options.expectedPipelineVersion!==CREATIVE_EVIDENCE_VERSION)throw Error('视频证据处理版本已经改变');await options.assertCurrent?.();const {asset,bytes}=await ownedSource(owner,assetId,options.expectedSourceSha256);const root=await ensureRoot(),id=sha(JSON.stringify({owner:ownerKey(owner),assetId,sha256:asset.sha256,version:CREATIVE_EVIDENCE_VERSION,profile:selected}));
 const cached=await verifiedManifest(root,owner,id);if(cached){await options.assertCurrent?.();return cached;}
 if(inFlight.has(id)){const result=await inFlight.get(id)!;await ownedSource(owner,assetId,asset.sha256);await options.assertCurrent?.();return result;}
 const task=buildEvidence(owner,asset,bytes,selected,root,id,options);inFlight.set(id,task);try{return await task;}finally{if(inFlight.get(id)===task)inFlight.delete(id);}
}
async function buildEvidence(owner:string,asset:Asset,bytes:Buffer,profile:Profile,root:string,id:string,options:PrepareOptions):Promise<CreativeVideoEvidence>{
 // Local preprocessing has no paid side effects. Process-local callers share a
 // promise; separate processes may compute in isolated temporary directories.
 // Atomic publication picks one valid cache without a crash-stale lock file.
 const work=childPath(root,'.work-'+id+'-'+crypto.randomUUID());const source=path.join(work,'source.bin');
 try{
  await fs.mkdir(work,{mode:0o700});await fs.writeFile(source,bytes,{flag:'wx',mode:0o600});await options.assertCurrent?.();
  const packetsFile=path.join(work,'packets.txt');const packetLog=await ffmpeg(['-y','-copyts','-protocol_whitelist','file,pipe','-i',source,'-map','0:v:0','-an','-c:v','copy','-f','framecrc',packetsFile]);if((await fs.stat(packetsFile)).size>12*1024*1024)throw Error('视频时间戳数据过多');const packets=packetFacts(await fs.readFile(packetsFile,'utf8'));if(packets.duration<=0||packets.duration>profile.maxDurationSeconds+1e-9)throw Error(`参考视频实际时长${packets.duration.toFixed(6)}秒，超出当前规则${profile.maxDurationSeconds}秒`);
  const firstLog=await ffmpeg(['-protocol_whitelist','file,pipe','-i',source,'-map','0:v:0','-an','-frames:v','1','-vf','showinfo','-f','null','-'],20000);const dimensions=firstLog.match(/\bs:(\d+)x(\d+)/);if(!dimensions)throw Error('无法读取实际解码的视频尺寸');const width=Number(dimensions[1]),height=Number(dimensions[2]);if(!width||!height||width*height>4096*4096)throw Error('参考视频尺寸超出当前证据处理能力');const fps=packets.count/packets.duration;if(!Number.isFinite(fps)||fps<=0||fps>240)throw Error('参考视频实际帧率超出当前处理能力');
  const scan=await ffmpeg(['-copyts','-protocol_whitelist','file,pipe','-i',source,'-map','0:v:0','-an','-vf',"blackdetect=d=0.1:pix_th=0.1:pic_th=0.98,select='gt(scene,0.3)',showinfo",'-f','null','-']);const normalize=(time:number)=>Math.max(0,Math.min(packets.duration,time-packets.start));const cuts=[...new Set([...scan.matchAll(/pts_time:([\d.-]+)/g)].map(m=>normalize(Number(m[1]))).filter(t=>t>1e-6&&t<packets.duration))].sort((a,b)=>a-b);if(cuts.length>500)throw Error('视频切镜过密，请先缩短素材');
  const blackSegments=[...scan.matchAll(/black_start:([\d.-]+) black_end:([\d.-]+) black_duration:([\d.]+)/g)].map(m=>({start:normalize(Number(m[1])),end:normalize(Number(m[2])),duration:Number(m[3])}));const tail=blackSegments.find(s=>s.end>=packets.duration-Math.max(.12,1.1/fps));const frames:CreativeVideoFrame[]=[];
  for(const [index,point] of chooseFrames(packets.duration,fps,cuts,profile.maxFrames,packets.timestamps).entries()){
   await options.assertCurrent?.();const file=path.join(work,`frame-${String(index+1).padStart(3,'0')}.jpg`);const log=await ffmpeg(['-y','-copyts','-ss',String(point.time),'-protocol_whitelist','file,pipe','-i',source,'-map','0:v:0','-an','-frames:v','1','-vf','scale=min(1024\\,iw):-2,showinfo','-q:v','2',file],20000);const timestamp=log.match(/pts_time:([\d.-]+)/);if(!timestamp)throw Error('视频帧缺少实际时间戳');const timeSeconds=normalize(Number(timestamp[1]));const a=await artifact(file);const metadata=await sharp(await fs.readFile(file)).metadata();const frameWidth=Number(metadata.width),frameHeight=Number(metadata.height);if(!Number.isFinite(frameWidth)||frameWidth<=0||!Number.isFinite(frameHeight)||frameHeight<=0||metadata.format!=='jpeg')throw Error('视频帧不是有效JPEG');frames.push({...a,id:'frame-'+(index+1),timeSeconds,requestedTimeSeconds:point.requested,width:frameWidth,height:frameHeight,reasons:point.reasons});
  }
  const tracks=audioTracks(packetLog);let extracted:CreativeVideoEvidence['audio']['extracted'];if(tracks.length){const file=path.join(work,'audio.wav');await ffmpeg(['-y','-protocol_whitelist','file,pipe','-i',source,'-map','0:a:0','-vn','-t',String(packets.duration),'-ac','1','-ar','16000','-c:a','pcm_s16le',file]);const pcm=pcmWav(await fs.readFile(file));extracted={...await artifact(file),...pcm,coverage:'first-audio-track-clipped-to-video-duration'};}
  await ownedSource(owner,asset.id,asset.sha256);await options.assertCurrent?.();
  const manifest:CreativeVideoEvidence={id,version:CREATIVE_EVIDENCE_VERSION,ownerHash:ownerKey(owner),createdAt:Date.now(),profile,source:{assetId:asset.id,sha256:asset.sha256,bytes:asset.size,type:asset.type,name:asset.name,durationSeconds:packets.duration,startTimestampSeconds:packets.start,width,height,fps,packetCount:packets.count},durationEvidence:{method:'video-packet-pts-plus-duration',timeBaseNumerator:packets.numerator,timeBaseDenominator:packets.denominator,headerDurationSeconds:durationFromHeader(packetLog)},cuts:cuts.map(timeSeconds=>({timeSeconds,scoreThreshold:.3})),frames,audio:{hasTrack:tracks.length>0,tracks,...(extracted?{extracted}:{}),transcription:'not-performed',understanding:'not-performed'},facts:{missingAudioTrack:tracks.length===0,blackSegments,blackTail:{detected:!!tail,start:tail?.start??null,end:tail?.end??null,pixelThreshold:.1,pictureRatio:.98,minDurationSeconds:.1}},limitations:['画面为带实际时间戳的选帧，不是逐帧人工阅读；密集切镜可能只抽取部分关键点。','切镜点来自FFmpeg scene=0.3图像差异阈值；相近亮度的硬切可能漏检，运动或闪光可能触发，不能等同全部语义分镜。','黑尾仅由像素阈值检测，不判断创作意图，也不自动裁切原视频。','音轨元数据与PCM文件已保留（如存在）；未进行语音转写、音乐识别或音频理解。','帧率为视频包数除以时间轴长度的平均值；可变帧率素材不能据此认定每帧等长。'],profileEvidence:{tutorialRecommendationSeconds:30,publicComponentValidationSeconds:60,privateServerLimitVerified:false}};
  await fs.unlink(source);await fs.unlink(packetsFile);await fs.writeFile(path.join(work,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});try{await fs.rename(work,childPath(root,id));}catch(error){const published=await verifiedManifest(root,owner,id);if(published)return published;throw error;}return manifest;
 }finally{if(await fs.stat(work).catch(()=>null))await cleanup(work);}
}
export async function readCreativeVideoEvidence(owner:string,id:string){const root=await ensureRoot();const manifest=await verifiedManifest(root,owner,id);if(!manifest)throw Error('视频证据不存在或尚未完成');await ownedSource(owner,manifest.source.assetId,manifest.source.sha256);return manifest;}
export async function creativeVideoEvidenceBytes(owner:string,id:string,file:string){const m=await readCreativeVideoEvidence(owner,id);const item=[...m.frames,...(m.audio.extracted?[m.audio.extracted]:[])].find(a=>a.file===file);if(!item)throw Error('视频证据文件不存在');const bytes=await fs.readFile(childPath(childPath(await ensureRoot(),id),item.file));if(sha(bytes)!==item.sha256)throw Error('视频证据文件损坏');return bytes;}
