import path from 'node:path';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {z} from 'zod';
import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {errorResponse,json} from '@/commerce/server/http';
import {runtimeDir} from '@/commerce/server/store';
import {readAsset,assetBytes,publicAsset,storeAsset,readIdempotentAsset} from '@/commerce/server/assets';
export const runtime='nodejs';
export const maxDuration=300;
const schema=z.object({portrait:z.boolean(),color:z.string().regex(/^#[a-fA-F0-9]{6}$/),scenes:z.array(z.object({
 title:z.string().trim().min(1).max(80),caption:z.string().trim().max(180),duration:z.number().int().min(1).max(10),imageId:z.string().uuid().optional()
})).min(1).max(8)});
const active=new Set<string>(),exec=promisify(execFile);
export async function POST(request:Request){
 let work='',holder='';
 try{
  sameOrigin(request);const user=requireIdentity(request);await authorizeCurrentCommerceIdentity(user);
  const input=schema.safeParse(await request.json());
  if(!input.success)return json({error:'请为每幕填写标题、1–10 秒时长及有效画面参数'},400);
  if(input.data.scenes.reduce((n,s)=>n+s.duration,0)>30)throw Error('单片最多 30 秒');
  if(active.has(user.id)||active.size>=2)return json({error:'已有动画正在渲染，请稍后再试'},429);
  active.add(user.id);holder=user.id;
  const keys:string[]=[],scenes=[];
  for(const scene of input.data.scenes){
   let image:string|undefined;
   if(scene.imageId){const asset=readAsset(scene.imageId,user.id);
    if(!asset?.type.startsWith('image/'))throw Error('请使用自己的图片素材');
    const bytes=await sharp(await assetBytes(asset),{limitInputPixels:40000000}).rotate().resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
    image='data:image/jpeg;base64,'+bytes.toString('base64');keys.push(asset.sha256);}
   scenes.push({title:scene.title,caption:scene.caption,duration:scene.duration,image});
  }
  const key='remotion/story-v1/'+createHash('sha256').update(JSON.stringify([input.data,keys])).digest('hex');
  const old=readIdempotentAsset(user.id,key);if(old)return json({asset:publicAsset(old)});
  work=await fs.mkdtemp(path.join(runtimeDir(),'remotion-work-'));
  await fs.writeFile(path.join(work,'scenes.json'),JSON.stringify({...input.data,scenes}));
  const engine=process.env.COMMERCE_REMOTION_DIR||path.join(runtimeDir(),'render-engine');
  const env:NodeJS.ProcessEnv={NODE_ENV:'production',...Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','TMPDIR','ProgramFiles','LOCALAPPDATA','HOME','LANG','LD_LIBRARY_PATH','PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'].flatMap(k=>process.env[k]?[[k,process.env[k]!]]:[]))};
  await fs.access(path.join(engine,'bundle','index.html')).catch(()=>{throw Error('Remotion 渲染模板尚未安装');});
  try{await exec(process.execPath,[path.join(engine,'render.cjs'),work],{cwd:engine,windowsHide:true,env,timeout:230000,maxBuffer:700000});}
  catch{throw Error('动画渲染失败，请检查服务端 Chromium 和渲染引擎');}
  const bytes=await fs.readFile(path.join(work,'output.mp4'));
  const asset=await storeAsset(user.id,bytes,'video/mp4','场景动画.mp4','generated',undefined,undefined,key);
  return json({asset:publicAsset(asset)});
 }catch(error){return errorResponse(error);}
 finally{if(work)await fs.rm(work,{recursive:true,force:true}).catch(()=>{});if(holder)active.delete(holder);}
}
