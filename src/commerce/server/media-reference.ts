import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {get,put,remove,db,transaction,claimRecordLease,releaseRecordLease,runtimeDir} from './store';
import {assetBytes,readAsset,mutateAsset,assertAssetIntegrity,withAssetLease,type Asset} from './assets';
import {storageManager} from '../../storage/object';
import {isPublicVideoAssetUrl} from '../../lib/video-public-url';
async function signingKey(){const file=path.join(runtimeDir(),'media-reference.key');try{return await fs.readFile(file);}catch{const key=randomBytes(32);try{await fs.writeFile(file,key,{flag:'wx',mode:0o600});return key;}catch{return fs.readFile(file);}}}
export function mediaOrigin(){return get<{origin:string}>('settings','media-origin','system')?.origin||'';}
export function saveMediaOrigin(origin:string){if(origin){const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('请填写本项目可公开访问的 HTTPS 域名');origin=url.origin;}put('settings','media-origin','system',{origin});}
function stableHttps(value:string){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}}
type ProviderReferenceIntent={schema:'commerce-provider-reference-intent/v1';id:string;assetId:string;owner:string;sha256:string;status:'upload_pending'|'uploaded';provider?:'tencent_cos';key?:string;url?:string;size?:number;createdAt:number;updatedAt:number};
export async function ensureProviderReference(asset:Asset,mutationGuard?:()=>boolean){
 const fresh=readAsset(asset.id,asset.owner);if(!fresh||fresh.sha256!==asset.sha256)throw Error('参考素材已删除或内容身份已变化');
 await assertAssetIntegrity(fresh);
 if(fresh.providerReferenceUrl&&stableHttps(fresh.providerReferenceUrl))return fresh;
 const intentId=`${fresh.id}:${fresh.sha256}`,updated=await mutateAsset(fresh.owner,fresh.id,async current=>{
  if(current.providerReferenceUrl&&stableHttps(current.providerReferenceUrl))return current;
  const previous=get<ProviderReferenceIntent>('provider-reference-intents',intentId,current.owner);
  if(previous?.status==='uploaded'&&previous.sha256===current.sha256&&previous.provider==='tencent_cos'&&previous.key&&previous.url&&stableHttps(previous.url)&&previous.size===current.size){current.providerReferenceUrl=previous.url;current.providerReferenceKey=previous.key;current.providerReferenceProvider=previous.provider;return current;}
  const category=current.type.startsWith('image/')?'image':current.type.startsWith('video/')?'video':current.type.startsWith('audio/')?'audio':null;
  if(!category)throw Error('该素材类型不能用于视频模型参考');
  if(mutationGuard&&mutationGuard()===false)throw Error('参考素材所属任务的执行租约已经失效');
  const now=Date.now();put('provider-reference-intents',intentId,current.owner,{schema:'commerce-provider-reference-intent/v1',id:intentId,assetId:current.id,owner:current.owner,sha256:current.sha256,status:'upload_pending',createdAt:previous?.createdAt||now,updatedAt:now} satisfies ProviderReferenceIntent);
  const bytes=await assetBytes(current);
  const extension=current.type==='image/jpeg'?'jpg':current.type.split('/')[1].replace('quicktime','mov').replace('mpeg','mp3').replace('x-wav','wav');
  const namespace=createHash('sha256').update(current.owner).digest('hex').slice(0,16);
  const fileName=current.temporary?`${current.id}-${current.sha256}.${extension}`:`${current.sha256}.${extension}`;
  const result=await storageManager.upload(bytes,fileName,current.type,{providerType:'tencent_cos',strictProvider:true,publicRead:true,category,userId:current.owner,source:'commerce-video-provider-reference-bridge',prefix:`commerce-provider-reference/${category}/${namespace}/`,fileName,requireOwnershipRecord:true,meta:{commerceAssetId:current.id,sha256:current.sha256}});
  put('provider-reference-intents',intentId,current.owner,{schema:'commerce-provider-reference-intent/v1',id:intentId,assetId:current.id,owner:current.owner,sha256:current.sha256,status:'uploaded',provider:result.provider==='tencent_cos'?'tencent_cos':undefined,key:result.key,url:result.url,size:result.size,createdAt:previous?.createdAt||now,updatedAt:Date.now()} satisfies ProviderReferenceIntent);
  if(mutationGuard&&mutationGuard()===false)throw Error('参考素材所属任务的执行租约已经失效');
  if(!result.isPublic||result.provider!=='tencent_cos'||result.size!==current.size||!isPublicVideoAssetUrl(result.url)||new URL(result.url).search)throw Error('参考素材转存后没有返回上游可访问的公开 COS 地址');
  current.providerReferenceUrl=result.url;current.providerReferenceKey=result.key;current.providerReferenceProvider='tencent_cos';return current;
 },mutationGuard);
 transaction(()=>{const intent=get<ProviderReferenceIntent>('provider-reference-intents',intentId,fresh.owner),current=readAsset(fresh.id,fresh.owner);if(intent?.status==='uploaded'&&current&&current.providerReferenceKey===intent.key&&current.providerReferenceUrl===intent.url)remove('provider-reference-intents',intentId,fresh.owner);});
 return updated;
}

export async function sweepProviderReferenceIntents(now=Date.now(),ttlMs=24*60*60*1000,limit=50){
 const lease=claimRecordLease('commerce-maintenance-leases','provider-reference-intent-sweep','system',`${process.pid}:${crypto.randomUUID()}`,now,10*60_000);
 if(!lease)return {scanned:0,removed:0,busy:true};
 let scanned=0,removedCount=0;
 try{
  const rows=db().prepare("SELECT owner,value FROM records WHERE bucket='provider-reference-intents' AND updated<=? ORDER BY updated ASC LIMIT ?").all(now-ttlMs,Math.max(1,Math.min(500,Math.trunc(limit)||50))) as {owner:string;value:string}[];
  for(const row of rows){scanned++;const intent=JSON.parse(String(row.value)) as ProviderReferenceIntent;
   try{const removed=await withAssetLease(intent.owner,intent.assetId,async(current,guard)=>{
    if(intent.status==='uploaded'&&intent.key&&current?.providerReferenceKey!==intent.key){if(!guard())return false;const deleted=await storageManager.delete(intent.key,intent.provider);if(!deleted)return false;}
    return transaction(()=>{if(!guard())return false;const latest=get<ProviderReferenceIntent>('provider-reference-intents',intent.id,intent.owner);if(latest?.updatedAt!==intent.updatedAt)return false;remove('provider-reference-intents',intent.id,intent.owner);return true;});
   });if(removed)removedCount++;}catch{/* A live asset mutation owns this intent. */}
  }
  return {scanned,removed:removedCount,busy:false};
 }finally{releaseRecordLease(lease);}
}
export async function referenceUrl(asset:Asset){
 const current=readAsset(asset.id,asset.owner);if(!current||current.sha256!==asset.sha256)throw Error('参考素材已删除或内容身份已变化');await assertAssetIntegrity(current);
 if(current.providerReferenceUrl&&stableHttps(current.providerReferenceUrl))return current.providerReferenceUrl;
 const origin=mediaOrigin();if(!origin)throw Error('该模型需要公网参考素材。请在资产页导入公网链接，或在后台配置带货项目的公开素材地址。未提交生成。');
 const payload=Buffer.from(JSON.stringify({assetId:asset.id,owner:asset.owner,expires:Date.now()+72*3600000})).toString('base64url');const signature=createHmac('sha256',await signingKey()).update(payload).digest('base64url');return origin+'/api/commerce/media-reference/'+payload+'.'+signature;
}
export async function verifyReference(token:string){if(token.length>900)return;const [payload,signature,extra]=token.split('.');if(!payload||!signature||extra)return;const expected=createHmac('sha256',await signingKey()).update(payload).digest('base64url');if(expected.length!==signature.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return;try{const value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(!Number.isFinite(value.expires)||value.expires<Date.now()||value.expires>Date.now()+73*3600000)return;return readAsset(value.assetId,value.owner);}catch{return;}}
