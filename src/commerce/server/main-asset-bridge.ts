import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/storage/database/supabase-client';
import {storageManager} from '@/storage/object';
import type {StorageProviderType} from '@/storage/object';
import {deleteAsset,readAsset,storeAsset,type Asset} from './assets';
import {get,put} from './store';

export const MAX_MAIN_ASSET_BYTES=150*1024*1024;
const MAIN_ASSET_READ_TIMEOUT_MS=120_000;
const MAIN_ASSET_IMPORT_BUCKET='main-asset-imports';
const MEDIA_TYPES=new Set([
 'image/png','image/jpeg','image/webp',
 'video/mp4','video/webm','video/quicktime',
 'audio/mpeg','audio/wav','audio/mp4','audio/ogg','audio/webm','audio/x-wav',
]);
const STORAGE_PROVIDERS=new Set<StorageProviderType>(['coze_s3','tencent_cos','local']);

export type MainAssetKind='image'|'video'|'audio';
export type MainAssetListRow={
 id:string;user_id:string;file_name:string|null;file_category:string|null;file_size:number|null;
 content_type:string|null;created_at:string|null;
};
export type MainAssetSourceRow=MainAssetListRow&{storage_key:string;storage_provider:string};
export type MainAssetListInput={kinds:MainAssetKind[];query:string;offset:number;limit:number};
export type MainAssetListItem={id:string;name:string;type:string;size:number;createdAt:number;source:'main';url:string};
export type PublicImportedAsset={id:string;name:string;type:string;size:number;createdAt:number;source:string;jobId?:string;url:string};
export type MainAssetImportRecord={
 schema:'commerce-main-asset-import/v1';mainSourceId:string;mainUserId:string;commerceAssetId:string;
 sha256:string;createdAt:number;
};

export interface MainAssetBridgeDependencies{
 listOwnedSources:(mainUserId:string,input:MainAssetListInput)=>Promise<{rows:MainAssetListRow[];total:number}>;
 findOwnedSource:(mainUserId:string,id:string)=>Promise<MainAssetSourceRow|null>;
 readBounded:(key:string,maxBytes:number,timeoutMs:number,provider:StorageProviderType)=>Promise<Buffer>;
 findImport:(owner:string,mainUserId:string,sourceId:string)=>MainAssetImportRecord|undefined;
 findCommerceAsset:(owner:string,id:string)=>Asset|undefined;
 storeCommerceAsset:(owner:string,bytes:Buffer,type:string,name:string)=>Promise<Asset>;
 saveImport:(owner:string,mainUserId:string,sourceId:string,value:MainAssetImportRecord)=>void;
 discardCommerceAsset:(owner:string,id:string)=>Promise<void>;
 now:()=>number;
}

function sourceKind(row:Pick<MainAssetListRow,'file_category'|'content_type'>):MainAssetKind|undefined{
 const category=String(row.file_category||'').toLowerCase();
 const type=String(row.content_type||'').split(';')[0].trim().toLowerCase();
 if(!['image','video','audio'].includes(category)||!MEDIA_TYPES.has(type)||!type.startsWith(category+'/'))return;
 return category as MainAssetKind;
}
function validSourceId(value:unknown):string{
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,160}$/u.test(value))throw Error('主站素材 ID 无效');
 return value;
}
function mappingId(owner:string,mainUserId:string,sourceId:string){
 return createHash('sha256').update(`${owner}\0${mainUserId}\0${sourceId}`).digest('hex');
}
function safeName(value:unknown,id:string){
 const name=String(value||'').replace(/[\r\n]/gu,' ').trim().slice(0,160);
 return name||`主站素材-${id.slice(0,8)}`;
}
function publicListItem(row:MainAssetListRow):MainAssetListItem|undefined{
 const kind=sourceKind(row),size=Number(row.file_size);
 if(!kind||row.user_id===''||!Number.isSafeInteger(size)||size<1||size>MAX_MAIN_ASSET_BYTES)return;
 const type=String(row.content_type).split(';')[0].trim().toLowerCase();
 const created=Date.parse(String(row.created_at||''));
 return {id:row.id,name:safeName(row.file_name,row.id),type,size,createdAt:Number.isFinite(created)?created:0,source:'main',url:`/api/storage/files/${encodeURIComponent(row.id)}/content`};
}
export function publicImportedAsset(asset:Asset):PublicImportedAsset{
 return {id:asset.id,name:asset.name,type:asset.type,size:asset.size,createdAt:asset.createdAt,source:asset.source,...(asset.jobId?{jobId:asset.jobId}:{}),url:`/api/commerce/assets/${asset.id}`};
}
export function parseMainAssetImportRequest(value:unknown):{id:string}{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('主站素材导入参数无效');
 const keys=Object.keys(value).sort();
 if(keys.length!==1||keys[0]!=='id')throw Error('主站素材导入只接受素材 ID');
 return {id:validSourceId((value as {id?:unknown}).id)};
}
export function parseMainAssetListInput(params:URLSearchParams):MainAssetListInput{
 const rawKinds=(params.get('kinds')||'image,video,audio').split(',').filter(Boolean);
 const kinds=[...new Set(rawKinds)] as MainAssetKind[];
 if(!kinds.length||kinds.some(kind=>!['image','video','audio'].includes(kind)))throw Error('主站素材类型无效');
 const query=(params.get('q')||'').trim();
 if(query.length>160)throw Error('主站素材搜索词过长');
 const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||30);
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('主站素材分页参数无效');
 return {kinds,query,offset,limit};
}

export function createMainAssetBridge(dependencies:MainAssetBridgeDependencies){
 const importLocks=new Map<string,Promise<Asset>>();
 async function list(mainUserId:string,input:MainAssetListInput){
  if(!mainUserId)throw Error('主站账户绑定不存在');
  const result=await dependencies.listOwnedSources(mainUserId,input);
  const assets=result.rows
   .filter(row=>row.user_id===mainUserId&&input.kinds.includes(sourceKind(row) as MainAssetKind))
   .map(publicListItem).filter((asset):asset is MainAssetListItem=>Boolean(asset));
  return {assets,total:Math.max(assets.length,Number(result.total)||0),nextOffset:input.offset+result.rows.length<Number(result.total||0)?input.offset+result.rows.length:null};
 }
 async function importOne(owner:string,mainUserId:string,sourceId:string):Promise<Asset>{
  if(!owner||!mainUserId)throw Error('主站账户绑定不存在');
  const id=validSourceId(sourceId),lockKey=`${owner}\0${mainUserId}\0${id}`;
  const pending=importLocks.get(lockKey);if(pending)return pending;
  const work=(async()=>{
   const source=await dependencies.findOwnedSource(mainUserId,id);
   if(!source||source.id!==id||source.user_id!==mainUserId)throw Error('主站素材不存在或无权访问');
   const kind=sourceKind(source),size=Number(source.file_size);
   if(!kind)throw Error('只支持主站图片、视频或音频素材');
   if(!Number.isSafeInteger(size)||size<1||size>MAX_MAIN_ASSET_BYTES)throw Error('主站素材大小须为 1 字节至 150 MB');
   if(!STORAGE_PROVIDERS.has(source.storage_provider as StorageProviderType)||!source.storage_key)throw Error('主站素材存储记录无效');
   const previous=dependencies.findImport(owner,mainUserId,id);
   if(previous?.mainSourceId===id&&previous.mainUserId===mainUserId){
    const asset=dependencies.findCommerceAsset(owner,previous.commerceAssetId);
    if(asset)return asset;
   }
   const type=String(source.content_type).split(';')[0].trim().toLowerCase();
   const bytes=await dependencies.readBounded(source.storage_key,MAX_MAIN_ASSET_BYTES,MAIN_ASSET_READ_TIMEOUT_MS,source.storage_provider as StorageProviderType);
   if(bytes.length<1||bytes.length>MAX_MAIN_ASSET_BYTES)throw Error('主站素材大小须为 1 字节至 150 MB');
   const asset=await dependencies.storeCommerceAsset(owner,bytes,type,safeName(source.file_name,id));
   const record:MainAssetImportRecord={schema:'commerce-main-asset-import/v1',mainSourceId:id,mainUserId,commerceAssetId:asset.id,sha256:asset.sha256,createdAt:dependencies.now()};
   try{dependencies.saveImport(owner,mainUserId,id,record);}catch(error){await dependencies.discardCommerceAsset(owner,asset.id).catch(()=>undefined);throw error;}
   return asset;
  })();
  importLocks.set(lockKey,work);
  try{return await work;}finally{if(importLocks.get(lockKey)===work)importLocks.delete(lockKey);}
 }
 return {list,importOne};
}

const productionDependencies:MainAssetBridgeDependencies={
 async listOwnedSources(mainUserId,input){
  const db=getSupabaseAdminClient();
  let query=db.from('user_files')
   .select('id,user_id,file_name,file_category,file_size,content_type,created_at',{count:'exact'})
   .eq('user_id',mainUserId).in('file_category',input.kinds).in('content_type',[...MEDIA_TYPES])
   .gt('file_size',0).lte('file_size',MAX_MAIN_ASSET_BYTES)
   .order('created_at',{ascending:false}).range(input.offset,input.offset+input.limit-1);
  if(input.query)query=query.ilike('file_name',`%${input.query.replace(/[%,]/gu,'')}%`);
  const {data,error,count}=await query.abortSignal(AbortSignal.timeout(10_000));
  if(error)throw Error('主站素材列表读取失败');
  return {rows:(data||[]) as MainAssetListRow[],total:Number(count)||0};
 },
 async findOwnedSource(mainUserId,id){
  const {data,error}=await getSupabaseAdminClient().from('user_files')
   .select('id,user_id,storage_key,storage_provider,file_name,file_category,file_size,content_type,created_at')
   .eq('id',id).eq('user_id',mainUserId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if(error)throw Error('主站素材归属校验失败');
  return data as MainAssetSourceRow|null;
 },
 readBounded:(key,maxBytes,timeoutMs,provider)=>storageManager.readBounded(key,maxBytes,timeoutMs,provider),
 findImport:(owner,mainUserId,sourceId)=>get<MainAssetImportRecord>(MAIN_ASSET_IMPORT_BUCKET,mappingId(owner,mainUserId,sourceId),owner),
 findCommerceAsset:(owner,id)=>readAsset(id,owner),
 storeCommerceAsset:(owner,bytes,type,name)=>storeAsset(owner,bytes,type,name),
 saveImport:(owner,mainUserId,sourceId,value)=>put(MAIN_ASSET_IMPORT_BUCKET,mappingId(owner,mainUserId,sourceId),owner,value),
 discardCommerceAsset:(owner,id)=>deleteAsset(owner,id),
 now:()=>Date.now(),
};

export const mainAssetBridge=createMainAssetBridge(productionDependencies);
