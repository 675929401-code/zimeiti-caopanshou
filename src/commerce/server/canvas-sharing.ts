import fs from 'node:fs/promises';
import {assertCanvasExecutionAllowed} from './canvas-import-review';
import syncFs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {db,get,put,runtimeDir,transaction} from './store';
import {readAsset,assetBytes,validateMediaBytes,materializeAssets,type Asset} from './assets';
import {CanvasConflict,verifyCanvasAssets,saveCanvasWithinTransaction} from './canvas-storage';
import {normalizeCanvasGraph,canvasAssetIds,type CanvasDocument,type CanvasGraph} from '../shared/canvas-schema';
import {cloneGraph} from '../shared/canvas-graph-operations';
import {remapCanvasMentionDocument} from '../shared/canvas-mentions';
import type {CanvasSharePreview,CanvasShareOwnerView,CanvasShareAcceptance} from '../shared/canvas-sharing';

type Media={sourceId:string;assetRef:string;name:string;type:string;size:number;sha256:string};
type Share={id:string;owner:string;canvasId:string;title:string;revision:number;tokenHash:string;sealedToken:string;state:'preparing'|'failed'|'active'|'cancelled';createdAt:number;expiresAt:number;ttlSeconds:number;graph:CanvasGraph;media:Media[]};
type Acceptance={shareId:string;receiver:string;canvasId:string;state:'pending'|'accepted';title:string;graph:CanvasGraph;assets:Asset[];createdAt:number};
const bucket='canvas-shares',acceptedBucket='canvas-share-acceptances';
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const uuid=(id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('无效的分享对象');return id;};
export class CanvasShareUnavailable extends Error{constructor(){super('分享链接已失效或不存在');}}
function ttl(){const value=Number(process.env.COMMERCE_CANVAS_SHARE_TTL_SECONDS||86400);if(!Number.isInteger(value)||value<60||value>604800)throw Error('分享有效期配置须为 60 秒至 7 天');return value;}
function publicOrigin(){const url=new URL(process.env.COMMERCE_PUBLIC_ORIGIN||'http://127.0.0.1:5000');if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('分享网站地址配置无效');return url.origin;}
function tokenKey(){const directory=path.join(runtimeDir(),'canvas-sharing-secrets');syncFs.mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,'key-v1');if(!syncFs.existsSync(file)){const temporary=path.join(directory,randomUUID()+'.tmp');try{syncFs.writeFileSync(temporary,randomBytes(32),{flag:'wx',mode:0o600});try{syncFs.linkSync(temporary,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}finally{syncFs.rmSync(temporary,{force:true});}}const key=syncFs.readFileSync(file);if(key.length!==32)throw Error('分享密钥文件无效');return key;}
function seal(token:string){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',tokenKey(),nonce),encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64');}
function unseal(encoded:string){const bytes=Buffer.from(encoded,'base64'),decipher=createDecipheriv('aes-256-gcm',tokenKey(),bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');}
function byToken(token:string):Share|undefined{if(!/^[a-f0-9]{64}$/.test(token))return;const row=db().prepare('SELECT value FROM records WHERE bucket=? AND id=?').get(bucket,digest(token));return row?JSON.parse(String(row.value)):undefined;}
function currentShare(share:Share){return get<Share>(bucket,share.tokenHash,share.owner);}
function ensureActive(share:Share|undefined):Share{if(!share||share.state!=='active'||share.expiresAt<=Date.now()||!get('canvases',share.canvasId,share.owner))throw new CanvasShareUnavailable();assertCanvasExecutionAllowed(share.owner,share.canvasId);return share;}
function ownerShares(owner:string,canvasId:string):Share[]{return db().prepare('SELECT value FROM records WHERE bucket=? AND owner=? AND json_extract(value,\'$.canvasId\')=? ORDER BY json_extract(value,\'$.createdAt\') DESC,rowid DESC').all(bucket,owner,canvasId).map(row=>JSON.parse(String(row.value)));}
function putShare(share:Share){put(bucket,share.tokenHash,share.owner,share);}
function ownerView(share:Share):CanvasShareOwnerView{const source=get<CanvasDocument>('canvases',share.canvasId,share.owner);return {id:share.id,status:share.state==='cancelled'?'cancelled':!source?'source-deleted':share.expiresAt<=Date.now()?'expired':share.state,revision:share.revision,currentRevision:source?.revision||0,createdAt:share.createdAt,expiresAt:share.expiresAt,ttlSeconds:share.ttlSeconds,url:publicOrigin()+'/commerce/canvas-share/'+unseal(share.sealedToken)};}
export function readCanvasShare(owner:string,canvasId:string){if(!get<CanvasDocument>('canvases',uuid(canvasId),owner))throw Error('画布不存在或不属于当前账号');const share=ownerShares(owner,canvasId)[0];return {share:share?ownerView(share):null,ttlSeconds:ttl()};}
function mediaMetadata(owner:string,id:string):Media{uuid(id);const a=readAsset(id,owner);if(!a||!Number.isInteger(a.size)||a.size<1||a.size>150*1024*1024||!/^[a-f0-9]{64}$/.test(a.sha256)||!/^image\/(png|jpeg|webp)$|^video\/(mp4|webm|quicktime)$|^audio\/(mpeg|wav|mp4|ogg|webm|x-wav)$/.test(a.type))throw Error('分享素材不完整或不受支持');return {sourceId:id,assetRef:randomUUID(),name:a.name.slice(0,160),type:a.type,size:a.size,sha256:a.sha256};}
function mapGraph(graph:CanvasGraph,mapping:Record<string,string>,publicView=false){
 if(!graph.nodes.length)return normalizeCanvasGraph(graph);
 const copy=cloneGraph(graph,undefined,0).graph,identities=Object.fromEntries(copy.nodes.map(n=>[n.id,n.id]));
 for(const node of copy.nodes){const d=node.data;for(const key of ['assetIds','resultAssetIds'] as const)if(d[key])d[key]=d[key]!.map(id=>{const target=mapping[id];if(!target)throw Error('分享素材映射不完整');return target;});if(d.thumbnailAssetId){if(!mapping[d.thumbnailAssetId])throw Error('缩略图映射不完整');d.thumbnailAssetId=mapping[d.thumbnailAssetId];}if(d.mention_document)d.mention_document=remapCanvasMentionDocument(d.mention_document,{nodes:identities,assets:mapping,instances:Object.fromEntries(d.mention_document.mentions.flatMap(m=>m.instanceId?[[m.instanceId,randomUUID()]]:[]))});if(publicView)delete d.modelId;}
 return normalizeCanvasGraph(copy);
}
function verifyBytes(bytes:Buffer,media:Pick<Media,'type'|'size'|'sha256'>){if(bytes.length!==media.size||digest(bytes)!==media.sha256)throw Error('分享素材内容校验失败');validateMediaBytes(bytes,media.type);}
async function ensureFile(file:string,bytes:Buffer,sha256:string){
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});try{const current=await fs.readFile(file);if(digest(current)!==sha256)throw Error('副本文件内容不一致，已保留原文件');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});try{await fs.link(temp,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const current=await fs.readFile(file);if(digest(current)!==sha256)throw Error('副本文件内容不一致，已保留原文件');}}finally{await fs.rm(temp,{force:true});}
}
const snapshotFile=(share:Share,ref:string)=>path.join(runtimeDir(),'canvas-shares',uuid(share.id),uuid(ref));
export async function publishCanvasShare(owner:string,canvasId:string,expectedRevision:number){
 assertCanvasExecutionAllowed(owner,canvasId);
 publicOrigin();const duration=ttl();uuid(canvasId);if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw Error('请先保存画布再分享');
 const share=transaction(()=>{const canvas=get<CanvasDocument>('canvases',canvasId,owner);if(!canvas)throw Error('画布不存在或不属于当前账号');if(canvas.revision!==expectedRevision)throw new CanvasConflict('画布已变化，请保存当前版本后再分享');
  const existing=ownerShares(owner,canvasId).find(s=>s.revision===expectedRevision&&s.state!=='cancelled'&&s.expiresAt>Date.now());if(existing)return existing;
  const graph=normalizeCanvasGraph(canvas);verifyCanvasAssets(owner,graph);const ids=canvasAssetIds(graph);if(ids.length>300)throw Error('一次分享最多包含 300 份素材');const media=ids.map(id=>mediaMetadata(owner,id));if(media.reduce((size,m)=>size+m.size,0)>512*1024*1024)throw Error('一次分享的素材总量不能超过 512 MB');
  const token=randomBytes(32).toString('hex'),createdAt=Date.now(),record:Share={id:randomUUID(),owner,canvasId,title:canvas.title,revision:canvas.revision,tokenHash:digest(token),sealedToken:seal(token),state:'preparing',createdAt,expiresAt:createdAt+duration*1000,ttlSeconds:duration,graph:mapGraph(graph,Object.fromEntries(media.map(m=>[m.sourceId,m.assetRef]))),media};putShare(record);return record;
 });
 if(share.state==='active')return {share:ownerView(ensureActive(currentShare(share)))};
 try{
  for(const media of share.media){const current=currentShare(share);if(!current||current.state==='cancelled'||current.expiresAt<=Date.now())throw new CanvasShareUnavailable();const asset=readAsset(media.sourceId,owner);if(!asset)throw Error('原素材已删除，请重新保存画布');const bytes=await assetBytes(asset);verifyBytes(bytes,media);await ensureFile(snapshotFile(share,media.assetRef),bytes,media.sha256);}
  return transaction(()=>{const current=currentShare(share),canvas=get<CanvasDocument>('canvases',canvasId,owner);if(!current||current.state==='cancelled'||current.expiresAt<=Date.now())throw new CanvasShareUnavailable();if(!canvas||canvas.revision!==share.revision)throw new CanvasConflict('发布期间画布已变化，请保存后重新分享');for(const old of ownerShares(owner,canvasId))if(old.id!==share.id&&old.state!=='cancelled'){old.state='cancelled';putShare(old);}current.state='active';putShare(current);return {share:ownerView(current)};});
 }catch(error){transaction(()=>{const current=currentShare(share);if(current&&['preparing','failed'].includes(current.state)){current.state='failed';putShare(current);}});if(error instanceof CanvasConflict||error instanceof CanvasShareUnavailable)throw error;throw Error('分享素材保存失败，可重试继续同一份发布；原链接状态未改变。');}
}
export function revokeCanvasShare(owner:string,canvasId:string){return transaction(()=>{if(!get('canvases',uuid(canvasId),owner))throw Error('画布不存在或不属于当前账号');for(const share of ownerShares(owner,canvasId)){share.state='cancelled';putShare(share);}return {ok:true};});}
export function readPublicCanvasShare(token:string):CanvasSharePreview{
 const share=ensureActive(byToken(token));const graph=normalizeCanvasGraph(share.graph);for(const n of graph.nodes)delete n.data.modelId;
 return {title:share.title,revision:share.revision,createdAt:share.createdAt,expiresAt:share.expiresAt,graph,public_assets:share.media.map(m=>({assetRef:m.assetRef,name:m.name,type:m.type,size:m.size,previewUrl:`/api/commerce/v1/canvas-shares/${token}/assets/${m.assetRef}`,downloadUrl:`/api/commerce/v1/canvas-shares/${token}/assets/${m.assetRef}?download=1`}))};
}
export async function readCanvasShareMedia(token:string,assetRef:string){const share=ensureActive(byToken(token)),media=share.media.find(m=>m.assetRef===assetRef);if(!media)throw new CanvasShareUnavailable();const bytes=await fs.readFile(snapshotFile(share,media.assetRef));verifyBytes(bytes,media);ensureActive(currentShare(share));return {bytes,type:media.type,name:media.name};}
export function assertCanvasShareMediaActive(token:string,assetRef:string){const share=ensureActive(byToken(token));if(!share.media.some(m=>m.assetRef===assetRef))throw new CanvasShareUnavailable();}
const acceptanceId=(share:Share,receiver:string)=>digest(share.id+'\0'+receiver);
function acceptanceView(record:Acceptance):CanvasShareAcceptance{if(record.state==='pending')return {status:'pending'};const canvas=get<CanvasDocument>('canvases',record.canvasId,record.receiver);return canvas?{status:'accepted',canvasId:canvas.id,title:canvas.title,openUrl:'/canvas?open='+canvas.id}:{status:'deleted',canvasId:record.canvasId};}
export function readCanvasShareAcceptance(receiver:string,token:string):CanvasShareAcceptance{const share=byToken(token);if(!share)throw new CanvasShareUnavailable();const previous=get<Acceptance>(acceptedBucket,acceptanceId(share,receiver),receiver);if(previous?.state==='accepted')return acceptanceView(previous);ensureActive(share);return previous?acceptanceView(previous):{status:'none'};}
export async function acceptCanvasShare(receiver:string,token:string):Promise<CanvasShareAcceptance>{
 const share=byToken(token);if(!share)throw new CanvasShareUnavailable();const key=acceptanceId(share,receiver);
 const reservation=transaction(()=>{const previous=get<Acceptance>(acceptedBucket,key,receiver);if(previous?.state==='accepted')return previous;ensureActive(currentShare(share));if(previous)return previous;
  const createdAt=Date.now(),assets:Asset[]=share.media.map(m=>({id:randomUUID(),owner:receiver,name:m.name,type:m.type,size:m.size,sha256:m.sha256,createdAt,source:'upload'}));const graph=mapGraph(share.graph,Object.fromEntries(share.media.map((m,i)=>[m.assetRef,assets[i].id])));const result:Acceptance={shareId:share.id,receiver,canvasId:randomUUID(),state:'pending',title:share.title+' 副本',graph,assets,createdAt};put(acceptedBucket,key,receiver,result);return result;
 });
 if(reservation.state==='accepted')return acceptanceView(reservation);
 try{const specs=share.media.map((media,i)=>({asset:reservation.assets[i],loadBytes:async()=>{ensureActive(currentShare(share));const bytes=await fs.readFile(snapshotFile(share,media.assetRef));verifyBytes(bytes,media);return bytes;}}));
  return materializeAssets(receiver,specs,tx=>{const current=get<Acceptance>(acceptedBucket,key,receiver);if(!current)throw Error('复制记录不存在');if(current.state==='accepted'){tx.skip();return acceptanceView(current);}ensureActive(currentShare(share));tx.commit();saveCanvasWithinTransaction(receiver,{id:current.canvasId,ownerId:receiver,expectedRevision:0,title:current.title,...current.graph});current.state='accepted';put(acceptedBucket,key,receiver,current);return acceptanceView(current);});
 }catch(error){if(error instanceof CanvasShareUnavailable)throw error;throw Error('复制未完成，重试会继续同一份副本，不会重复创建。');}
}
