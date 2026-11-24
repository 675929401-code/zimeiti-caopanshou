import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assetBytes, publicAsset, readIdempotentAsset, storeAsset, withAssetLease} from './assets';
import {runtimeDir} from './store';
import {runFFmpeg} from './media-tools';
import {probeVideoFile as probe, videoProbeInputArgs as inputArgs} from './video-file-probe';
import {deliverySizes, isVideoProductionSkill, keepAroundCuts, speechRates, verticalAdChecks, type Cut, type DeliverySize} from '../shared/member-video-production';

type Operation={skill?:unknown; action?:unknown; assetId?:unknown; cuts?:unknown; rate?:unknown; size?:unknown; mbps?:unknown;adMode?:unknown};


async function pauses(file:string,duration:number):Promise<Cut[]> {
  const log=await runFFmpeg([...inputArgs(file),'-vn','-map','0:a:0','-af','silencedetect=n=-36dB:d=0.6','-f','null','-'],90000,400000);
  const result:Cut[]=[];
  let start:number|undefined;
  for(const match of log.matchAll(/silence_(start|end):\s*([0-9.eE+-]+)/g)){
    if(match[1]==='start'){start=Number(match[2]);continue;}
    if(start===undefined)continue;
    const from=Math.max(0,Math.round((start+0.12)*100)/100);
    const to=Math.min(duration,Math.round((Number(match[2])-0.12)*100)/100);
    if(to>from)result.push({start:from,end:to});
    start=undefined;
  }
  return result;
}

function montage(keep:Cut[],rate:number){
  // Close the same source-time gaps on picture and sound. Video keeps its original variable frame timing.
  const select=keep.map(r=>'gte(t,'+r.start+')*lt(t,'+r.end+')').join('+');
  const gaps=keep.map((r,i)=>({at:r.start,elapsed:r.start-(i?keep[i-1].end:0)})).filter(g=>g.elapsed>0);
  const removed=gaps.map(g=>'gte(T,'+g.at+')*'+g.elapsed).join('+')||'0';
  const video="[0:v:0]setpts=PTS-STARTPTS,select='"+select+"',setpts='(PTS-("+removed+")/TB)/"+rate+"',scale=ceil(iw/2)*2:ceil(ih/2)*2[v]";
  const audio=keep.map((r,i)=>'[0:a:0]asetpts=PTS-STARTPTS,atrim=start='+r.start+':end='+r.end+',asetpts=PTS-STARTPTS[a'+i+']');
  const join=keep.map((_,i)=>'[a'+i+']').join('')+'concat=n='+keep.length+':v=0:a=1,atempo='+rate+'[a]';
  return [video,...audio,join].join(';');
}

export async function memberVideoProduction(owner:string, body:Operation){
  const {skill,action,assetId}=body;
  if(typeof skill!=='string'||!isVideoProductionSkill(skill)||!['inspect','export'].includes(String(action))||typeof assetId!=='string'||!/^[a-f0-9-]{36}$/i.test(assetId))throw Error('视频处理请求无效');
  return withAssetLease(owner,assetId,async(source,guard)=>{
    if(!source?.type.startsWith('video/'))throw Error('请选择自己的视频素材');
    const folder=await fs.mkdtemp(path.join(runtimeDir(),'skill-video-'));
    try{
      const file=path.join(folder,'source'),output=path.join(folder,'result.mp4');
      await fs.writeFile(file,await assetBytes(source));
      const info=await probe(file);
      if(info.duration<=0||info.duration>300)throw Error('当前支持 5 分钟以内的素材，请先切出所需片段');
      if(skill!=='ad-spec'&&!info.audioCodec)throw Error('这段视频没有可处理的口播音轨');
      const automatic=skill==='ad-spec'&&body.adMode==='vertical';
      const checks=skill==='ad-spec'?verticalAdChecks(info,(await fs.stat(file)).size):undefined;
      if(action==='inspect')return {source:info,checks,pauses:skill==='ad-spec'?[]:await pauses(file,info.duration)};
      if(automatic&&checks?.every(check=>check.pass))return {asset:publicAsset(source),source:info,result:info,checks,unchanged:true};
      let args:string[], settings:unknown, label:string;
      if(skill==='ad-spec'){
        if(body.adMode!==undefined&&!['vertical','custom'].includes(String(body.adMode)))throw Error('未知的规格适配方式');
        const size=automatic?'720x1280':body.size,mbps=automatic?4:Number(body.mbps);
        if (automatic && info.duration < 4) {
          const missingSeconds = Math.ceil((4 - info.duration) * 1000) / 1000;
          throw Error('竖版素材至少需要 4 秒，当前还差 ' + missingSeconds + ' 秒，请补充原片内容');
        }
        if(typeof size!=='string'||!Object.hasOwn(deliverySizes,size)||![2,4,6,8,12].includes(mbps))throw Error('请选择有效的交付尺寸与目标码率');
        const preserveSize=automatic&&info.width*16===info.height*9&&info.width>=720&&info.width<=1440&&info.width%2===0&&info.height%2===0;
        const [w,h]=preserveSize?[info.width,info.height]:deliverySizes[size as DeliverySize];
        args=['-map','0:v:0','-map','0:a:0?','-vf','scale='+w+':'+h+':force_original_aspect_ratio=decrease:force_divisible_by=2,pad='+w+':'+h+':(ow-iw)/2:(oh-ih)/2,setsar=1','-b:v',mbps+'M','-maxrate',mbps+'M','-bufsize',2*mbps+'M'];
        if(automatic)args.push('-minrate',mbps+'M','-x264-params','nal-hrd=cbr');
        settings=automatic?['vertical',w,h,mbps]:[size,mbps];label='规格适配';
      }else{
        const rate=skill==='speech-cut'?1:Number(body.rate);
        if(!speechRates.some(n=>n===rate)||!Array.isArray(body.cuts)||body.cuts.length>160)throw Error('请核对语速和删减区间（每次最多 160 段）');
        if(body.cuts.some(c=>!c||typeof c!=='object'))throw Error('删减区间无效');
        const keep=keepAroundCuts(body.cuts as Cut[],info.duration);
        args=['-filter_complex_threads','2','-filter_complex',montage(keep,rate),'-map','[v]','-map','[a]','-fps_mode','vfr','-crf','20'];
        settings=[keep,rate];label=skill==='speech-cut'?'口播精剪':'节奏优化';
      }
      const key='member-video/v1/'+source.id+'/'+source.sha256+'/'+skill+'/'+createHash('sha256').update(JSON.stringify(settings)).digest('hex');
      const old=readIdempotentAsset(owner,key);
      if(old){
        await fs.writeFile(output,await assetBytes(old));const result=await probe(output);
        return {asset:publicAsset(old),source:info,result,checks:automatic?verticalAdChecks(result,(await fs.stat(output)).size):undefined};
      }
      await runFFmpeg([...inputArgs(file),...args,'-map_metadata','-1','-c:v','libx264','-threads','2','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output]);
      const result=await probe(output);
      const outputSize=(await fs.stat(output)).size;
      if(outputSize>150*1024*1024)throw Error('成片超过 150 MB，请降低码率或缩短片段');
      const resultChecks=automatic?verticalAdChecks(result,outputSize):undefined;
      const failures=resultChecks?.filter(check=>!check.pass);
      if(failures?.length)throw Error('成片复核未通过：'+failures.map(check=>check.name).join('、'));
      const asset=await storeAsset(owner,await fs.readFile(output),'video/mp4',source.name.replace(/\.[^.]+$/,'').slice(0,100)+'-'+label+'.mp4','generated',undefined,undefined,key,guard);
      return {asset:publicAsset(asset),source:info,result,checks:resultChecks};

    }finally{await fs.rm(folder,{recursive:true,force:true});}
  });
}
