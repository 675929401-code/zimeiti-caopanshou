import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {get,list,put,transaction} from './store';
import {readAsset,validateMediaBytes,materializeAssets,type Asset} from './assets';
import {saveCanvasWithinTransaction} from './canvas-storage';
import {registerCanvasImportReview} from './canvas-import-review';
import {certifyMaterializedCanvas,registerMaterializedCanvasCertification,type MaterializedCanvasCertification} from './discovery-canvas-certification';
import type {CanvasDocument,CanvasImportReview,CanvasGraph} from '../shared/canvas-schema';
import {createImageReferenceDocument,validateImageReferenceDocument} from '../shared/image-reference-mentions';
import {getImageInputContract} from '../image-input-contract';
import {convertDiscoveryCanvas} from '../shared/discovery-canvas-import';
import type {DiscoveryCanvasIds,DiscoveryOwnedAssetMap} from '../shared/discovery-canvas-import-schema';
import type {DiscoveryAsset,DiscoveryCatalog,DiscoveryCopyResult,DiscoveryDraft,DiscoveryItem} from '../shared/discovery-catalog-types';

export class DiscoveryError extends Error {
 constructor(public code:string,message:string,public status=400,public issues:unknown[]=[],public detail?:unknown){super(message);this.name='DiscoveryError';}
}
function fail(code:string,message:string,status=400,issues:unknown[]=[]):never{throw new DiscoveryError(code,message,status,issues);}
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const uuid=(id:unknown):string=>{if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))fail('INVALID_ID','案例或操作编号无效');return id;};
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_SNAPSHOT','案例快照结构无效');return value as Record<string,unknown>;}
const catalogPath=()=>path.resolve(process.env.COMMERCE_DISCOVERY_CATALOG||'public/commerce/discovery/catalog.json');
const copyBucket='discovery-copies',likeBucket='discovery-likes';
type CopyMedia={mirror:DiscoveryAsset;asset:Asset};
type CopyRecord={id:string;owner:string;operationId:string;itemId:string;state:'pending'|'completed';createdAt:number;source:{itemSha256:string;capturedAt:string;sourceUrl:string;generation:unknown};media:CopyMedia[];result:DiscoveryCopyResult;lastError?:string};
type CanvasReview={id:string;owner:string;operationId:string;itemId:string;item:DiscoveryItem;itemSha256:string;createdAt:number;ids:DiscoveryCanvasIds;assetMap:DiscoveryOwnedAssetMap;mirrorIssues:unknown[];canvasId?:string;state?:'pending'|'completed';media?:CopyMedia[];graph?:CanvasGraph|null;importReview?:CanvasImportReview;certification?:MaterializedCanvasCertification;result?:DiscoveryCopyResult;lastError?:string};
const copyKey=(owner:string,operationId:string)=>digest(owner+'\0'+operationId);

/** Trusted, local published inventory. No network fallback to the source website. */
export async function discoveryCatalog():Promise<DiscoveryCatalog>{
 let text:string;try{const file=catalogPath(),stat=await fs.stat(file);if(stat.size>30*1024*1024)fail('CATALOG_INVALID','案例目录过大',503);text=await fs.readFile(file,'utf8');}catch(e){if(e instanceof DiscoveryError)throw e;return fail('CATALOG_NOT_READY','本地案例素材正在准备，请稍后重试',503);}
 let catalog:DiscoveryCatalog;try{catalog=JSON.parse(text.replace(/^\ufeff/,''));}catch{return fail('CATALOG_INVALID','案例目录格式无效',503);}
 if(catalog.schema!==1||!Array.isArray(catalog.items)||catalog.items.length>500||!catalog.order||!['video','image','canvas'].every(kind=>Array.isArray(catalog.order[kind as keyof typeof catalog.order])))fail('CATALOG_INVALID','案例目录结构无效',503);
 const ids=new Set<string>();for(const item of catalog.items){uuid(item.id);if(ids.has(item.id)||!['image','video','canvas'].includes(item.kind)||!Array.isArray(item.assets)||item.assets.length>500||typeof item.title!=='string'||!item.snapshot)fail('CATALOG_INVALID','案例目录有重复或无效条目',503);ids.add(item.id);}
 for(const kind of ['video','image','canvas'] as const)if(new Set(catalog.order[kind]).size!==catalog.order[kind].length||catalog.order[kind].some(id=>!catalog.items.some(item=>item.id===id&&item.kind===kind)))fail('CATALOG_INVALID','案例排序与内容不一致',503);
 if(catalog.homeOrder)for(const kind of ['video','image','canvas'] as const){const ids=catalog.homeOrder[kind];if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!catalog.items.some(item=>item.id===id&&item.kind===kind)))fail('CATALOG_INVALID','首页案例排序与内容不一致',503);}
 return catalog;
}
function itemIn(catalog:DiscoveryCatalog,id:string){const item=catalog.items.find(item=>item.id===uuid(id));if(!item)fail('DISCOVERY_NOT_FOUND','公开案例不存在',404);return item;}
function isLiked(owner:string|undefined,id:string){return !!owner&&get<{liked:boolean}>(likeBucket,digest(owner+'\0'+id),owner)?.liked===true;}
export async function discoveryHome(owner?:string){const catalog=await discoveryCatalog(),likedIds=owner?list<{itemId:string;liked:boolean}>(likeBucket,owner).filter(row=>row.liked&&catalog.items.some(item=>item.id===row.itemId)).map(row=>row.itemId):[];const order=catalog.homeOrder||catalog.order,homeIds=new Set(Object.values(order).flat());return {...catalog,items:catalog.items.filter(item=>homeIds.has(item.id)),order,likedIds:likedIds.filter(id=>homeIds.has(id)),totalAvailable:catalog.items.length};}
export async function discoveryItem(id:string,owner?:string){const item=itemIn(await discoveryCatalog(),id);return {item,liked:isLiked(owner,id)};}
export async function setDiscoveryLiked(owner:string,id:string,liked:unknown){if(typeof liked!=='boolean')fail('INVALID_LIKE','请明确收藏或取消收藏');const item=itemIn(await discoveryCatalog(),id);return transaction(()=>{const key=digest(owner+'\0'+id),old=get<{liked:boolean}>(likeBucket,key,owner);if(old?.liked!==liked)put(likeBucket,key,owner,{itemId:id,liked,updatedAt:Date.now()});return {itemId:id,liked,sourceLikes:item.sourceLikes,likeCount:item.sourceLikes+(liked?1:0)};});}

export function checkedDiscoveryMirror(asset:DiscoveryAsset):DiscoveryAsset&{mediaKind:'image'|'video'|'audio'} {
 const mediaKind=asset?.kind==='thumbnail'?'image':asset?.kind;
 const allowed=/^image\/(png|jpeg|webp)$|^video\/(mp4|webm|quicktime)$|^audio\/(mpeg|wav|mp4|ogg|webm|x-wav)$/;
 if(!asset||typeof asset.assetRef!=='string'||!asset.assetRef||asset.assetRef.length>200||!allowed.test(asset.mimeType)||!['image','video','audio'].includes(mediaKind)||!asset.mimeType.startsWith(mediaKind+'/'))fail('INVALID_MIRROR','案例参考素材类型或标识无效',422);
 if(!Number.isInteger(asset.bytes)||asset.bytes<1||asset.bytes>150*1024*1024||!/^[a-f0-9]{64}$/.test(asset.sha256)||typeof asset.url!=='string')fail('INVALID_MIRROR','案例参考素材缺少有效校验信息',422);
 if(!new RegExp('^/commerce/discovery/media/'+asset.sha256+'\\.[a-z0-9]{2,8}$').test(asset.url))fail('INVALID_MIRROR_PATH','仅允许复制已校验的本地案例媒体',422);
 return {...asset,mediaKind:mediaKind as 'image'|'video'|'audio'};
}
async function mirrorBytes(asset:DiscoveryAsset){
 checkedDiscoveryMirror(asset);const root=await fs.realpath(path.join(path.dirname(catalogPath()),'media')),candidate=await fs.realpath(path.join(root,path.posix.basename(asset.url))),relative=path.relative(root,candidate);
 if(relative.startsWith('..')||path.isAbsolute(relative)||relative.includes(path.sep))fail('INVALID_MIRROR_PATH','案例媒体路径超出镜像目录',422);
 const stat=await fs.stat(candidate);if(!stat.isFile()||stat.size!==asset.bytes)fail('MIRROR_MISMATCH','案例参考文件长度与公开快照不符',422);const bytes=await fs.readFile(candidate);
 if(bytes.length!==asset.bytes||digest(bytes)!==asset.sha256)fail('MIRROR_MISMATCH','案例参考文件校验失败',422);validateMediaBytes(bytes,asset.mimeType);return bytes;
}
export async function discoveryMedia(fileName:string){
 if(!/^[a-f0-9]{64}\.[a-z0-9]{2,8}$/i.test(fileName))fail('DISCOVERY_MEDIA_NOT_FOUND','案例媒体不存在',404);
 const url='/commerce/discovery/media/'+fileName,catalog=await discoveryCatalog(),matches=catalog.items.flatMap(item=>item.assets).filter(asset=>asset.url===url);
 if(!matches.length)fail('DISCOVERY_MEDIA_NOT_FOUND','案例媒体不存在',404);
 const first=matches[0];if(matches.some(asset=>asset.sha256!==first.sha256||asset.bytes!==first.bytes||asset.mimeType!==first.mimeType))fail('CATALOG_INVALID','案例媒体标识对应多个不同文件',503);
 return {bytes:await mirrorBytes(first),mimeType:first.mimeType,sha256:first.sha256,bytesLength:first.bytes};
}
function imageVideoDraft(item:DiscoveryItem,owner:string):{draft:DiscoveryDraft;media:CopyMedia[]}{
 if(item.kind==='canvas')return fail('CANVAS_CONVERSION_NOT_READY','画布模板需要完整转换核对，当前尚未开放复制',422,[{code:'CANVAS_CONTRACT_REQUIRED',message:'不得过滤节点或降级为普通生成'}]);
 const snap=object(item.snapshot),sourcePrompt=object(snap.prompt),generation=object(snap.generation);
 if(sourcePrompt.visible!==true||typeof sourcePrompt.text!=='string'||!sourcePrompt.text.trim()||sourcePrompt.text.length>20000)fail('PROMPT_UNAVAILABLE','案例没有可复制的完整公开提示词',422);
 if(generation.tool_slug!==(item.kind==='image'?'image-generation':'video-generation'))fail('UNSUPPORTED_CASE_OPERATION','案例功能类型不能静默转换为普通生成',422);
 const sourceSkill=generation.image_skill_id??generation.image_skill_key??generation.skill;if(sourceSkill!==undefined&&sourceSkill!=='default')fail('UNSUPPORTED_CASE_OPERATION','案例专项技能尚未建立完整复制映射，不能改为普通生成',422);
 if(!Array.isArray(snap.references)||snap.references.length>(item.kind==='image'?9:15))fail('REFERENCE_LIMIT','案例参考数量超出当前编辑器能力',422);
 const media:CopyMedia[]=[],used=new Set<string>(),counts={image:0,video:0,audio:0};
 const refs=snap.references.map(value=>{const ref=object(value),kind=String(ref.media_type);if(!['image','video','audio'].includes(kind)||item.kind==='image'&&kind!=='image')fail('REFERENCE_TYPE','案例参考类型不适用于当前功能',422);
  const sourceRole=ref.slot_key??ref.slot??ref.role;if(sourceRole!==undefined&&sourceRole!==null&&sourceRole!==(kind==='audio'?'sound':'reference'))fail('REFERENCE_ROLE_UNSUPPORTED','案例参考包含未适配的职责，不能静默改成普通参考',422);
  const assetRef=String(ref.asset_ref||''),mirrors=item.assets.filter(a=>a.assetRef===assetRef);if(!assetRef||used.has(assetRef)||mirrors.length!==1)fail('REFERENCE_IDENTITY','案例参考标识重复或缺少完整媒体',422);used.add(assetRef);
  const mirror=checkedDiscoveryMirror(mirrors[0]);if(mirror.mediaKind!==kind)fail('REFERENCE_TYPE','案例参考角色与媒体类型不一致',422);
  const number=++counts[kind as keyof typeof counts],expected=({image:'图片',video:'视频',audio:'音频'} as Record<string,string>)[kind]+number;if(ref.mention_label!==expected)fail('REFERENCE_NUMBERING','案例参考编号与公开顺序不一致，需核对后复制',422);
  const asset:Asset={id:randomUUID(),owner,name:String(mirror.name||expected).slice(0,160),type:mirror.mimeType,size:mirror.bytes,sha256:mirror.sha256,createdAt:Date.now(),source:'upload'};media.push({mirror,asset});
  return {instanceId:randomUUID(),assetId:asset.id,slot:kind==='audio'?'sound':'reference',name:expected,type:asset.type,sha256:asset.sha256,available:true};
 });
 if(counts.audio>3||counts.image+counts.video>12||media.reduce((sum,m)=>sum+m.asset.size,0)>512*1024*1024)fail('REFERENCE_LIMIT','案例参考超过当前复制容量',422);
 const prompt=sourcePrompt.text;for(const token of prompt.matchAll(/@(图片|视频|音频)(\d+)/g)){const kind=({图片:'image',视频:'video',音频:'audio'} as const)[token[1] as '图片'];if(Number(token[2])<1||String(Number(token[2]))!==token[2]||Number(token[2])>counts[kind])fail('REFERENCE_MISSING','案例提示词存在未提供的参考编号',422);}
 const metadata:DiscoveryDraft['metadata_json']={};
 for(const key of ['aspect_ratio','resolution'] as const)if(generation[key]!==undefined){if(typeof generation[key]!=='string'||generation[key].length>80)fail('INVALID_GENERATION','公开生成设置无效',422);metadata[key]=generation[key];}
 if(item.kind==='image'){
  metadata.image_skill_id='default';if(generation.output_format!==undefined){if(!['PNG','JPEG','WEBP'].includes(String(generation.output_format).toUpperCase()))fail('INVALID_GENERATION','案例图片格式不受支持',422);metadata.format=String(generation.output_format).toUpperCase();}
  const slots=getImageInputContract('default').slots.map(s=>s.id),instances=refs.map(r=>({instanceId:r.instanceId,assetId:r.assetId,slot:r.slot,name:r.name}));metadata.imageReferenceDocument=validateImageReferenceDocument(createImageReferenceDocument(prompt,instances,slots),prompt,instances,slots,{allowUnresolved:false});
 }else{
  if(generation.duration_seconds!==undefined){if(typeof generation.duration_seconds!=='number'||!Number.isFinite(generation.duration_seconds)||generation.duration_seconds<1||generation.duration_seconds>60)fail('INVALID_GENERATION','案例视频时长无效',422);metadata.duration=generation.duration_seconds;}
  if(generation.generate_audio!==undefined){if(typeof generation.generate_audio!=='boolean')fail('INVALID_GENERATION','案例声音开关无效',422);metadata.generate_audio=generation.generate_audio;}
 }
 return {draft:{title:item.title.slice(0,160),context_type:item.kind,prompt_text:prompt,metadata_json:metadata,reference_elements_json:refs},media};
}
function viewResult(record:CopyRecord):DiscoveryCopyResult{const result=structuredClone(record.result);if(result.kind!=='canvas')result.draft.reference_elements_json=result.draft.reference_elements_json.map(ref=>({...ref,available:readAsset(ref.assetId,record.owner)?.sha256===ref.sha256}));return result;}

/** Saves either a byte-pinned materialized snapshot or a fail-closed review copy. */
async function copyCanvasReview(owner:string,item:DiscoveryItem,operationId:string):Promise<DiscoveryCopyResult> {
 const key=copyKey(owner,operationId),record=transaction(()=>{
  if(get<CopyRecord>(copyBucket,key,owner))fail('COPY_ID_CONFLICT','同一个操作号不能复制不同案例',409);
  const old=get<CanvasReview>('discovery-canvas-reviews',key,owner);
  if(old&&old.itemId!==item.id)fail('COPY_ID_CONFLICT','同一个操作号不能复制不同案例',409);
  if(old?.canvasId&&(old.importReview||old.certification)&&old.result)return old;
  // An old 422 reservation is upgraded using its frozen source, not today's catalog.
  const source=old?.item||item,ids:DiscoveryCanvasIds=old?.ids||{nodes:{},edges:{},groups:{}},assetMap:DiscoveryOwnedAssetMap={},mirrorIssues:CanvasImportReview['issues']=[],media:CopyMedia[]=[];
  for(const group of ['nodes','edges','groups'] as const){const values=source.snapshot[group];if(Array.isArray(values))for(const raw of values)if(raw&&typeof raw==='object'&&typeof raw.local_id==='string')ids[group][raw.local_id]||=randomUUID();}
  for(const asset of source.assets)try{
   const mirror=checkedDiscoveryMirror(asset);if(assetMap[asset.assetRef])throw new DiscoveryError('DUPLICATE_ASSET_REF','重复的公开素材标识');
   const id=old?.assetMap?.[asset.assetRef]?.id||randomUUID();assetMap[asset.assetRef]={id,kind:mirror.mediaKind};
   media.push({mirror,asset:{id,owner,name:String(mirror.name||asset.assetRef).slice(0,160),type:mirror.mimeType,size:mirror.bytes,sha256:mirror.sha256,createdAt:old?.createdAt||Date.now(),source:'upload'}});
  }catch(e){mirrorIssues.push({severity:'fatal',code:e instanceof DiscoveryError?e.code:'INVALID_MIRROR',path:'assets.'+asset.assetRef,message:e instanceof Error?e.message:'镜像信息无效'});}
  if(media.reduce((sum,m)=>sum+m.asset.size,0)>512*1024*1024)mirrorIssues.push({severity:'fatal',code:'COPY_CAPACITY_EXCEEDED',path:'assets',message:'素材超过单次复制容量，原图仅供审查；没有截断图或复制部分素材。'});
  const converted=convertDiscoveryCanvas(source.snapshot,{assetMap,ids}),representationReady=converted.ok&&!mirrorIssues.length,canvasId=randomUUID(),createdAt=old?.createdAt||Date.now(),sourceSha256=old?.itemSha256||digest(JSON.stringify(source));
  const certified=representationReady?certifyMaterializedCanvas(source,sourceSha256,converted,assetMap,createdAt):null;
  const issues:CanvasImportReview['issues']=[...mirrorIssues,...converted.issues,...(certified?[]:[{severity:'execution' as const,code:'DISCOVERY_CANVAS_EXECUTION_NOT_ADAPTED',path:'canvas',message:'待适配画布审查副本：原图已保留，执行语义尚未适配；不能运行、复制或分享。'}])];
  const preview:DiscoveryItem={id:source.id,kind:'canvas',title:source.title,description:source.description||'',coverUrl:'',sourceLikes:0,sourcePublishedAt:source.sourcePublishedAt||'',sourceUrl:'',capturedAt:source.capturedAt,assets:source.assets.map(a=>({assetRef:a.assetRef,kind:a.kind,role:a.role,name:a.name,mimeType:a.mimeType,url:a.url,sha256:a.sha256,bytes:a.bytes,width:a.width,height:a.height,duration:a.duration,sourceUrl:''})),snapshot:converted.sourceSnapshot as Record<string,unknown>};
  const importReview:CanvasImportReview|undefined=certified?undefined:{schemaVersion:1,status:'review-required',sourceItemId:source.id,sourceSha256,createdAt,representationReady,executionReady:false,issues,migration:converted.migration,preview};
  const result:DiscoveryCopyResult=certified?{operationId,itemId:item.id,status:'completed',kind:'canvas',canvasId,executionReady:true,executionMode:'materialized-snapshot',warnings:['已复制为可执行素材快照：节点、连线、分组和已有输出均已转为本账号素材。','该快照零付费执行且不会派发模型；隐藏提示词、模型映射与重新生成能力仍未认证。']}:{operationId,itemId:item.id,status:'completed',kind:'canvas',canvasId,executionReady:false,executionMode:'review-required',warnings:['已保存为待适配画布，可重开审查原图与问题；当前不能运行、复制或分享。',representationReady?'完整本地图结构已保留，执行仍未适配。':'原始图已完整保留；本地图结构尚有缺口，没有创建空白可执行画布。']};
  const value:CanvasReview={id:key,owner,operationId,itemId:item.id,item:source,itemSha256:sourceSha256,createdAt,ids,assetMap,mirrorIssues,canvasId,state:'pending',media:representationReady?media:[],graph:certified?.graph||(representationReady?converted.graph:null),...(importReview?{importReview}:{}),...(certified?{certification:certified.certification}:{}),result};
  put('discovery-canvas-reviews',key,owner,value);return value;
 });
 if(record.state==='completed'){if(!get('canvases',record.canvasId!,owner))fail('COPY_DELETED','原审查副本已删除，同一操作不会重建；请发起新复制',410);return record.result!;}
 try{
  return materializeAssets(owner,record.media!.map(media=>({asset:media.asset,loadBytes:()=>mirrorBytes(media.mirror)})),tx=>{
   const current=get<CanvasReview>('discovery-canvas-reviews',key,owner);if(!current?.canvasId||(!current.importReview&&!current.certification)||!current.result)fail('COPY_NOT_FOUND','画布复制预约不存在，请保留原操作号核对',409);
   if(current.state==='completed'){tx.skip();if(!get('canvases',current.canvasId,owner))fail('COPY_DELETED','原审查副本已删除，同一操作不会重建',410);return current.result;}
   tx.commit();
   if(current.importReview)registerCanvasImportReview(owner,current.canvasId,current.importReview,Object.values(current.ids.nodes));
   const graph=current.graph||{nodes:[],edges:[],groups:[],viewport:{x:0,y:0,zoom:1}};
   saveCanvasWithinTransaction(owner,{id:current.canvasId,ownerId:owner,expectedRevision:0,title:current.item.title+(current.certification?' · 素材快照':' · 待适配审查'),...graph});
   if(current.certification)registerMaterializedCanvasCertification(owner,current.canvasId,current.certification);
   current.state='completed';delete current.lastError;put('discovery-canvas-reviews',key,owner,current);
   put('discovery-canvas-review-results',key,owner,{itemId:current.itemId,operationId,canvasId:current.canvasId,itemSha256:current.itemSha256,checkedAt:Date.now(),executionReady:!!current.certification,executionMode:current.certification?.executionMode||'review-required',regenerationReady:current.certification?.regenerationReady||false,representationReady:current.certification?true:current.importReview!.representationReady,issues:current.importReview?.issues||[],sourceIssueCounts:current.certification?.sourceIssueCounts,migration:current.importReview?.migration,sourceSnapshot:current.importReview?.preview.snapshot});
   return current.result;
  });
 }catch(e){transaction(()=>{const current=get<CanvasReview>('discovery-canvas-reviews',key,owner);if(current?.state==='pending'){current.lastError=e instanceof DiscoveryError?e.code:'COPY_MEDIA_FAILED';put('discovery-canvas-reviews',key,owner,current);}});if(e instanceof DiscoveryError)throw e;return fail('COPY_MEDIA_FAILED','审查副本尚未保存完整，请重试继续同一次操作',503);}
}

/** Reservation survives restart. Media becomes owned only with the completed draft transaction. */
export async function copyDiscoveryItem(owner:string,itemId:string,operationId:string):Promise<DiscoveryCopyResult>{
 uuid(itemId);uuid(operationId);const key=copyKey(owner,operationId);let reservation=get<CopyRecord>(copyBucket,key,owner);
 if(reservation&&reservation.itemId!==itemId)fail('COPY_ID_CONFLICT','同一个操作号不能复制不同案例',409);
 const review=get<CanvasReview>('discovery-canvas-reviews',key,owner);if(review){if(review.itemId!==itemId)fail('COPY_ID_CONFLICT','同一个操作号不能复制不同案例',409);return copyCanvasReview(owner,review.item,operationId);}
 if(!reservation){const item=itemIn(await discoveryCatalog(),itemId);if(item.kind==='canvas')return copyCanvasReview(owner,item,operationId);reservation=transaction(()=>{const current=get<CopyRecord>(copyBucket,key,owner);if(current){if(current.itemId!==itemId)fail('COPY_ID_CONFLICT','同一个操作号不能复制不同案例',409);return current;}if(get<CanvasReview>('discovery-canvas-reviews',key,owner))fail('COPY_ID_CONFLICT','同一个操作号不能复制不同案例',409);const {draft,media}=imageVideoDraft(item,owner);const result:DiscoveryCopyResult={operationId,itemId,status:'completed',kind:item.kind as 'image'|'video',draft};const value:CopyRecord={id:key,owner,operationId,itemId,state:'pending',createdAt:Date.now(),source:{itemSha256:digest(JSON.stringify(item)),capturedAt:item.capturedAt,sourceUrl:item.sourceUrl,generation:item.snapshot.generation},media,result};put(copyBucket,key,owner,value);return value;});}
 if(reservation.state==='completed')return viewResult(reservation);
 try{
  return materializeAssets(owner,reservation.media.map(media=>({asset:media.asset,loadBytes:()=>mirrorBytes(media.mirror)})),tx=>{const current=get<CopyRecord>(copyBucket,key,owner);if(!current)fail('COPY_NOT_FOUND','复制记录不存在，请保留原操作号重试',409);if(current.state==='completed'){tx.skip();return viewResult(current);}
   tx.commit();
   current.state='completed';delete current.lastError;put(copyBucket,key,owner,current);return viewResult(current);
  });
 }catch(e){transaction(()=>{const current=get<CopyRecord>(copyBucket,key,owner);if(current?.state==='pending'){current.lastError=e instanceof DiscoveryError?e.code:'COPY_MEDIA_FAILED';put(copyBucket,key,owner,current);}});if(e instanceof DiscoveryError)throw e;return fail('COPY_MEDIA_FAILED','案例复制未完成，请重试继续同一份草稿',503);}
}
