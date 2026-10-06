import fs from 'node:fs/promises';
import path from 'node:path';
import {runtimeDir} from './store';
import {runFFmpeg} from './media-tools';
import {assertAssetIntegrity,type Asset} from './assets';
export async function videoFrames(asset:Asset,jobId:string,executionToken:string|number=crypto.randomUUID(),guard:()=>boolean=()=>true){
 if(!guard())throw Error('参考视频所属任务的执行租约已经失效');await assertAssetIntegrity(asset);
 const source=path.join(runtimeDir(),'assets',asset.id),safeToken=String(executionToken).replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,80),dir=path.join(runtimeDir(),'media-work','frames-'+jobId+'-'+asset.id+'-'+safeToken);
 await fs.mkdir(dir,{recursive:true});try{const info=await runFFmpeg(['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i',source,'-frames:v','1','-f','null','-'],20000);if(!guard())throw Error('参考视频所属任务的执行租约已经失效');const m=info.match(/Duration: (\d+):(\d+):([\d.]+)/);const duration=m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):8;const step=Math.max(.25,duration/4);const pattern=path.join(dir,'frame-%02d.jpg');await runFFmpeg(['-hide_banner','-nostdin','-y','-protocol_whitelist','file,pipe','-i',source,'-vf',`fps=1/${step},scale=768:-2`,'-frames:v','4',pattern],40000);if(!guard())throw Error('参考视频所属任务的执行租约已经失效');const results=[];for(const name of (await fs.readdir(dir)).filter(n=>/^frame-\d+\.jpg$/.test(n)).sort()){const file=path.join(dir,name);results.push('data:image/jpeg;base64,'+(await fs.readFile(file)).toString('base64'));}if(!results.length)throw Error('参考视频无法提取画面');return results;}finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
