import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {json,errorResponse} from '@/commerce/server/http';
import {runtimeDir} from '@/commerce/server/store';
import {assetBytes,readAsset,publicAsset,storeAsset} from '@/commerce/server/assets';
import {runFFmpeg} from '@/commerce/server/media-tools';
import {parseSubtitles,renderSrt,renderAss,type Caption} from '@/commerce/shared/member-captions';

export const runtime='nodejs';
export const maxDuration=300;
const running=new Set<string>(),exec=promisify(execFile);
export async function POST(request:Request){
  let work='',holder='';
  try{
    sameOrigin(request);const user=requireIdentity(request);await authorizeCurrentCommerceIdentity(user);
    if(running.has(user.id)||running.size>=2)return json({error:'字幕任务正在处理，请稍后再试'},429);
    holder=user.id;running.add(holder);
    const {action,assetId,srt,highlight,language='auto'}=await request.json();
    if(!['recognize','srt','ass','burn'].includes(action)||!['auto','zh','en','th','vi'].includes(language)||typeof highlight!=='string'||highlight.length>80)throw Error('字幕参数无效');
    const asset=assetId&&readAsset(String(assetId),user.id);
    if(assetId&&(!asset||!(/^(audio|video)\//.test(asset.type))))throw Error('请选择自己的音视频素材');
    if((action==='recognize'||action==='burn')&&!asset)throw Error('请先选择音视频文件');
    if(action==='burn'&&!asset.type.startsWith('video/'))throw Error('硬字幕输出需要视频');
    work=await fs.mkdtemp(path.join(runtimeDir(),'caption-work-'));
    const input=path.join(work,'input');
    let duration=0;
    if(asset&&(action==='recognize'||action==='burn')){
      await fs.writeFile(input,await assetBytes(asset));
      const info=await runFFmpeg(['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i','input','-t','0','-f','null','-'],15000,64000,work);
      const stamp=info.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      duration=stamp?+stamp[1]*3600 + +stamp[2]*60 + +stamp[3]:0;
      if(!duration||duration>300)throw Error('请选择时长在 5 分钟内的音视频');
    }
    if(action==='recognize'){
      await runFFmpeg(['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i','input','-vn','-map','0:a:0','-ac','1','-ar','16000','-c:a','pcm_s16le','audio.wav'],45000,2000,work);
      const python=process.env.COMMERCE_DOCUMENT_PYTHON||path.join(runtimeDir(),'document-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
      const model=process.env.COMMERCE_WHISPER_MODEL||path.join(runtimeDir(),'speech-models','whisper-base');
      try{await exec(python,['-I','-B',path.resolve('integrations/commerce-captions/recognize.py'),model,language],{cwd:work,windowsHide:true,timeout:220000,maxBuffer:300000,env:{NODE_ENV:process.env.NODE_ENV,...Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','LD_LIBRARY_PATH'].flatMap(k=>process.env[k]?[[k,process.env[k]!]]:[])),OMP_NUM_THREADS:'3'}});}
      catch{return json({error:'语音识别未完成，请检查本机模型和音轨，或缩短片段重试'},422);}
      const report=JSON.parse(await fs.readFile(path.join(work,'segments.json'),'utf8')) as {language:string;rows:Caption[]};
      if(!report.rows.length)throw Error('没有识别到可读语音，请确认音轨后重试');
      return json({srt:renderSrt(report.rows),language:report.language,count:report.rows.length});
    }
    if(typeof srt!=='string')throw Error('请填写字幕');
    const rows=parseSubtitles(srt);
    const ass=renderAss(rows,highlight);
    let bytes:Buffer,ext:string,mime:string;
    if(action==='burn'){
      if(rows.some(row=>row.end>duration+0.12))throw Error('字幕结束时间超出视频时长');
      await fs.writeFile(path.join(work,'captions.ass'),ass);
      await runFFmpeg(['-nostdin','-protocol_whitelist','file,pipe','-i','input','-vf','ass=captions.ass','-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-threads','2','-c:a','aac','-movflags','+faststart','output.mp4'],210000,1000,work);
      bytes=await fs.readFile(path.join(work,'output.mp4'));ext='mp4';mime='video/mp4';
    }else{ext=action;mime='text/plain';bytes=Buffer.from(action==='ass'?ass:renderSrt(rows));}
    const name=(asset?.name?.replace(/\.[^.]+$/,'')||'字幕')+'-字幕.'+ext;
    const key='member-documents/'+createHash('sha256').update(name).update('\0').update(bytes).digest('hex');
    const result=await storeAsset(user.id,bytes,mime,name,'generated',undefined,undefined,key);
    return json({asset:publicAsset(result),count:rows.length});
  }catch(error){return errorResponse(error);}
  finally{if(work)await fs.rm(work,{recursive:true,force:true}).catch(()=>{});if(holder)running.delete(holder);}
}
