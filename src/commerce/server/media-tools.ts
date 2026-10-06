import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import {runtimeDir,get,put,list,claim,transaction} from './store';
import {readAsset,storeAsset} from './assets';
import {validateEraseRegions,validateEraseDuration,type EraseRegion} from '../media-edit-regions';

export type EditInput={requestId:string;assetId:string;tool:'trim'|'enhance'|'watermark'|'subtitle'|'mosaic';start:number;end:number;resolution?:number;box?:EraseRegion;boxes?:EraseRegion[]};
export type EditJob={id:string;owner:string;input:EditInput;status:'queued'|'running'|'succeeded'|'failed';createdAt:number;updatedAt:number;assetId?:string;error?:string;recoveryAttempts?:number;recoveredAt?:number};
const state=globalThis as unknown as {commerceMediaActive?:Set<string>};const active=state.commerceMediaActive||=new Set<string>();
export const edits=(owner:string)=>list<EditJob>('media-edits',owner);
const save=(value:EditJob)=>{value.updatedAt=Date.now();put('media-edits',value.id,value.owner,value);};
export function createEdit(owner:string,input:EditInput){
 if(!/^[a-f0-9-]{36}$/.test(input.requestId)||!['trim','enhance','watermark','subtitle','mosaic'].includes(input.tool))throw Error('处理参数无效');
 const asset=readAsset(input.assetId,owner);if(!asset||!asset.type.startsWith('video/'))throw Error('请选择当前工作室的视频');
 const erase=input.tool==='watermark'||input.tool==='subtitle'||input.tool==='mosaic';
 if(!erase&&(!Number.isFinite(input.start)||!Number.isFinite(input.end)||input.start<0||input.end<=input.start||input.end-input.start>300))throw Error('请选择不超过 300 秒的有效时间范围');
 if(input.tool==='enhance'&&![720,1080,1440,2160].includes(Number(input.resolution)))throw Error('请选择目标分辨率');
 if(erase){const boxes=validateEraseRegions(input.tool as 'watermark'|'subtitle'|'mosaic',input.boxes??(input.box?[input.box]:undefined));input={...input,boxes,box:boxes[0],start:0,end:0};}
 if(edits(owner).filter(j=>['queued','running'].includes(j.status)).length>=2)throw Error('已有两个视频正在处理');
 const id=crypto.randomUUID();const result=claim(`${owner}:edit:${input.requestId}`,createHash('sha256').update(JSON.stringify(input)).digest('hex'),id);if(!result.created)return get<EditJob>('media-edits',result.id,owner)!;
 const value:EditJob={id,owner,input,status:'queued',createdAt:Date.now(),updatedAt:Date.now()};save(value);return value;
}
export function runFFmpeg(args:string[],timeout=300000){return new Promise<string>((resolve,reject)=>{const executable=process.env.COMMERCE_FFMPEG_PATH||(existsSync(path.join(runtimeDir(),'bin','ffmpeg.exe'))?path.join(runtimeDir(),'bin','ffmpeg.exe'):(ffmpegPath&&existsSync(ffmpegPath)?ffmpegPath:'ffmpeg'));if(!executable){reject(Error('视频处理程序未安装'));return;}const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],shell:false});let output='';const timer=setTimeout(()=>{child.kill();reject(Error('视频处理超时'));},timeout);child.stderr.on('data',chunk=>{output=(output+chunk.toString()).slice(-16000);});child.on('error',()=>{clearTimeout(timer);reject(Error('视频处理程序无法启动'));});child.on('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error('视频处理失败，请检查文件与选择的区域'));});});}
export async function probeEraseVideo(sourcePath:string){
 const info=await runFFmpeg(['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i',sourcePath,'-map','0:v:0','-an','-frames:v','1','-vf','showinfo','-f','null','-'],20000);
 const dimensions=info.match(/\bs:(\d+)x(\d+)/),clock=info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
 if(!dimensions||!clock)throw Error('无法读取视频尺寸或时长，请上传有效的视频文件');
 const duration=Number(clock[1])*3600+Number(clock[2])*60+Number(clock[3]);
 validateEraseDuration(duration);
 // FFmpeg's Duration header rounds to hundredths. Near the limit, use the
 // original video packet time base so e.g. 30.001 seconds cannot round down.
 if(duration>=29.99){
  const timeBase=info.match(/config in time_base:\s*(\d+)\/(\d+)/);
  if(!timeBase)throw Error('无法精确核对视频时长，请重新选择素材');
  const packets=await runFFmpeg(['-hide_banner','-nostdin','-debug_ts','-protocol_whitelist','file,pipe','-i',sourcePath,'-t','31','-map','0:v:0','-an','-c:v','copy','-f','null','-'],20000);
  const ends=[...packets.matchAll(/demuxer\+ffmpeg ->[^\r\n]*type:video pkt_pts:(-?\d+)[^\r\n]*?duration:(\d+) duration_time:/g)].map(match=>(Number(match[1])+Number(match[2]))*Number(timeBase[1])/Number(timeBase[2]));
  if(!ends.length)throw Error('无法精确核对视频时长，请重新选择素材');
  validateEraseDuration(Math.max(duration,...ends));
 }
 return {width:Number(dimensions[1]),height:Number(dimensions[2]),duration};
}

export function eraseFilters(tool:'watermark'|'subtitle'|'mosaic',boxes:EraseRegion[],width:number,height:number):string[]{
 const filters:string[]=[];
 if(tool==='mosaic'){
  const boxesM=validateEraseRegions('mosaic',boxes);
  let cur='0:v';const parts:string[]=[];
  boxesM.forEach((box,i)=>{
   const x=Math.max(0,Math.floor(box.x*width)),y=Math.max(0,Math.floor(box.y*height));
   const w=Math.max(2,Math.floor(box.width*width)),h=Math.max(2,Math.floor(box.height*height));
   const cw=Math.max(2,Math.floor(w/14)),ch=Math.max(2,Math.floor(h/14));
   const out=i===boxesM.length-1?'vout':'b'+i;
   parts.push(`[${cur}]split=2[bg${i}][fg${i}];`);
   parts.push(`[fg${i}]crop=${w}:${h}:${x}:${y},scale=${cw}:${ch}:flags=neighbor,scale=${w}:${h}:flags=neighbor[msk${i}];`);
   parts.push(`[bg${i}][msk${i}]overlay=${x}:${y}[${out}];`);
   cur=out;
  });
  return [parts.join('')];
 }
 if(tool==='watermark'&&Math.max(width,height)>2048){const factor=2048/Math.max(width,height);width=Math.max(2,Math.floor(width*factor/2)*2);height=Math.max(2,Math.floor(height*factor/2)*2);filters.push(`scale=${width}:${height}:flags=lanczos`);}
 for(const box of validateEraseRegions(tool,boxes)){
  // delogo requires a one-pixel border; edge selections retain that margin.
  const x=Math.max(1,Math.floor(box.x*width)),y=Math.max(1,Math.floor(box.y*height));
  const w=Math.min(width-x-2,Math.floor(box.width*width)),h=Math.min(height-y-2,Math.floor(box.height*height));
  if(w<2||h<2)throw Error('素材尺寸过小，所选区域无法处理');
  filters.push(`delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
 }
 return filters;
}
export function recoverStaleEdit(id:string,owner:string,now=Date.now(),staleAfterMs=10*60_000){
 return transaction(()=>{
  const value=get<EditJob>('media-edits',id,owner);
  if(!value||value.status!=='running'||value.updatedAt>now-staleAfterMs)return false;
  value.status='queued';value.error=undefined;value.recoveryAttempts=Number(value.recoveryAttempts||0)+1;value.recoveredAt=now;save(value);return true;
 });
}
export async function runEdit(id:string,owner:string){
 if(active.has(id))return;
 const value=transaction(()=>{const current=get<EditJob>('media-edits',id,owner);if(!current||current.status!=='queued')return undefined;current.status='running';save(current);return current;});
 if(!value)return;
 active.add(id);let output='';try{const source=readAsset(value.input.assetId,owner);if(!source)throw Error('源视频已删除');const sourcePath=path.join(runtimeDir(),'assets',source.id);const directory=path.join(runtimeDir(),'media-work');await fs.mkdir(directory,{recursive:true});output=path.join(directory,id+'.mp4');const input=value.input;const filters:string[]=[];
 if(input.tool==='enhance')filters.push(`hqdn3d=1.5:1.5:3:3,scale=-2:${input.resolution}:flags=lanczos,unsharp=5:5:0.5`);
 const erase=input.tool==='watermark'||input.tool==='subtitle'||input.tool==='mosaic';
 if(erase){const info=await probeEraseVideo(sourcePath);filters.push(...eraseFilters(input.tool as 'watermark'|'subtitle'|'mosaic',input.boxes??(input.box?[input.box]:[]),info.width,info.height));}
 if(input.tool==='mosaic'){await runFFmpeg(['-hide_banner','-nostdin','-y','-protocol_whitelist','file,pipe','-i',sourcePath,'-filter_complex',filters.join(','),'-map','[vout]','-map','0:a?','-map_metadata','-1','-c:v','libx264','-threads','2','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output]);}
 else{await runFFmpeg(['-hide_banner','-nostdin','-y','-protocol_whitelist','file,pipe',...(erase?[]:['-ss',String(input.start)]),'-i',sourcePath,...(erase?[]:['-t',String(input.end-input.start)]),'-map','0:v:0','-map','0:a?','-map_metadata','-1',...(filters.length?['-vf',filters.join(',')]:[]),'-c:v','libx264','-threads','2','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output]);}
 const result=await storeAsset(owner,await fs.readFile(output),'video/mp4',`${input.tool}-${source.name.replace(/\.[^.]+$/,'')}.mp4`,'generated',id,undefined,`media-edit:${id}`);value.assetId=result.id;value.status='succeeded';save(value);
 }catch(error){value.status='failed';value.error=error instanceof Error?error.message:'视频处理失败';save(value);}finally{active.delete(id);if(output)await fs.unlink(output).catch(()=>{});}}
