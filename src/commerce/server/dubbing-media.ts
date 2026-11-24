import fs from 'node:fs/promises';
import path from 'node:path';
import type {Caption} from '../shared/member-captions';
import {runFFmpeg} from './media-tools';
function fileInput(name:string){return ['-protocol_whitelist','file,pipe','-i',name];}
export async function mediaInfo(file:string){
 const log=await runFFmpeg(['-hide_banner','-nostdin',...fileInput(file),'-t','0.05','-f','null','-'],30000);
 const h=log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);if(!h)throw Error('无法读取素材时长');
 return {duration:Number(h[1])*3600+Number(h[2])*60+Number(h[3]),audio:/Stream #\d+:\d+[^\n]*: Audio:/.test(log),video:/Stream #\d+:\d+[^\n]*: Video:/.test(log)};
}
export async function voiceReference(work:string,start:number,length:number){
 const name=path.join(work,'reference.wav');await runFFmpeg(['-y','-v','error','-nostdin','-ss',String(start),...fileInput(path.join(work,'source')),'-t',String(length),'-map','0:a:0','-ar','24000','-ac','1','-c:a','pcm_s16le',name],30000);
 return fs.readFile(name);
}
function tempoFilters(ratio:number){
 const chain:string[]=[];while(ratio>2){chain.push('atempo=2');ratio/=2;}chain.push('atempo='+ratio.toFixed(6));return chain.join(',');
}
export async function renderDub(work:string,rows:Caption[],duration:number,keepOriginal:boolean){
 const args=['-y','-hide_banner','-nostdin',...fileInput('source')],filters:string[]=[],tracks:string[]=[];
 for(const [index,row] of rows.entries()){
  const filename='line-'+index+'.audio';const info=await mediaInfo(path.join(work,filename));if(!info.audio||info.duration<=0)throw Error('配音未能解码');
  const length=row.end-row.start,argsIndex=index+1;args.push(...fileInput(filename));const delay=Math.round(row.start*1000);
  filters.push('['+argsIndex+':a]aresample=48000,'+tempoFilters(Math.max(1,info.duration/length))+',apad,atrim=duration='+length.toFixed(3)+',adelay='+delay+':all=1[a'+index+']');tracks.push('[a'+index+']');
 }
 if(keepOriginal){const ranges=rows.map(row=>'between(t,'+row.start.toFixed(3)+','+row.end.toFixed(3)+')').join('+');filters.unshift("[0:a:0]volume=0:enable='"+ranges+"'[original]");tracks.unshift('[original]');}
 filters.push(tracks.join('')+'amix=inputs='+tracks.length+':duration=longest:normalize=0,apad,atrim=duration='+duration.toFixed(3)+'[mix]');
 await runFFmpeg([...args,'-filter_complex',filters.join(';'),'-map','0:v:0','-map','[mix]','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-t',duration.toFixed(3),'-movflags','+faststart','result.mp4'],240000,12000,work);
 return fs.readFile(path.join(work,'result.mp4'));
}

