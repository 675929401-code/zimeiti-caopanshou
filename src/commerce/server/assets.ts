import fs from 'node:fs/promises';
import path from 'node:path';
import {fetchPublic} from './public-network';
import {createHash} from 'node:crypto';
import {runtimeDir,get,put,list,remove,db,transaction,claimRecordLease,renewRecordLease,recordLeaseIsCurrent,releaseRecordLease,type DurableRecordLease} from './store';
import {storageManager} from '../../storage/object';

export type Asset={
  id:string;
  owner:string;
  name:string;
  type:string;
  size:number;
  sha256:string;
  createdAt:number;
  source:'upload'|'generated';
  jobId?:string;
  providerReferenceUrl?:string;
  providerReferenceKey?:string;
  providerReferenceProvider?:'tencent_cos';
  temporary?:{kind:'rolling-tail';parentJobId:string;segmentIndex:number};
  idempotencyKey?:string;
  folderId?:string;
  collection?:'assets'|'roles';
  assetGroupId?:'certified_real'|'virtual_human'|null;
  usageDeclaration?:string;
  updatedAt?:number;
};

export type PublicAsset=Pick<Asset,'id'|'name'|'type'|'size'|'sha256'|'createdAt'|'source'|'jobId'|'folderId'|'collection'|'assetGroupId'|'usageDeclaration'|'updatedAt'>&{url:string};

const ASSET_MUTATION_LEASE_BUCKET='commerce-asset-mutation-leases';
const ASSET_MUTATION_LEASE_MS=120_000;
type MutationGuard=()=>boolean;

async function withAssetMutationLeases<T>(ids:string[],externalGuard:MutationGuard|undefined,work:(guard:MutationGuard)=>Promise<T>){
  if(externalGuard&&externalGuard()===false)throw Error('资产所属任务的执行租约已经失效');
  const holder=`${process.pid}:${crypto.randomUUID()}`;
  const leases:DurableRecordLease[]=[];
  // Asset bytes are keyed only by id on disk. Acquire a stable global order so
  // a batch cannot deadlock another writer that touches the same assets.
  const ordered=[...new Set(ids)].sort(),deadline=Date.now()+30_000;
  for(;;){
    let busy=false;
    for(const id of ordered){const lease=claimRecordLease(ASSET_MUTATION_LEASE_BUCKET,id,'system',holder,Date.now(),ASSET_MUTATION_LEASE_MS);if(!lease){busy=true;break;}leases.push(lease);}
    if(!busy)break;
    for(const held of leases.splice(0).reverse())try{releaseRecordLease(held);}catch{/* A newer token owns recovery. */}
    if(externalGuard?.()===false)throw Error('资产所属任务的执行租约已经失效');
    if(Date.now()>=deadline)throw Error('资产正在由另一执行器安全写入或清理，请稍后重试');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  let current=true;
  const guard=()=>current&&leases.every(lease=>recordLeaseIsCurrent(lease))&&(externalGuard?.()!==false);
  const heartbeat=setInterval(()=>{if(current)try{current=leases.every(lease=>renewRecordLease(lease,Date.now(),ASSET_MUTATION_LEASE_MS));}catch{current=false;}},Math.floor(ASSET_MUTATION_LEASE_MS/3));
  heartbeat.unref?.();
  try{return await work(guard);}
  finally{clearInterval(heartbeat);if(current)for(const lease of leases.reverse())try{releaseRecordLease(lease);}catch{/* A newer token owns recovery. */}}
}

async function withAssetMutationLease<T>(_owner:string,id:string,externalGuard:MutationGuard|undefined,work:(guard:MutationGuard)=>Promise<T>){return withAssetMutationLeases([id],externalGuard,work);}
export async function withAssetLease<T>(owner:string,id:string,work:(current:Asset|undefined,guard:MutationGuard)=>Promise<T>,externalGuard?:MutationGuard){return withAssetMutationLease(owner,id,externalGuard,guard=>work(readAsset(id,owner),guard));}

export function validateMediaBytes(bytes:Buffer,type:string){
  const first=bytes.subarray(0,16),ascii=first.toString('ascii');
  const matches=type==='image/png'
    ?first.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    :type==='image/jpeg'
      ?first[0]===255&&first[1]===216&&first[2]===255
      :type==='image/webp'
        ?ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP'
        :type.endsWith('/mp4')||type==='video/quicktime'
          ?ascii.slice(4,8)==='ftyp'
          :type.endsWith('/webm')
            ?first.subarray(0,4).equals(Buffer.from([26,69,223,163]))
            :type.endsWith('/wav')||type.endsWith('/x-wav')
              ?ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WAVE'
              :type==='audio/ogg'
                ?ascii.startsWith('OggS')
                :type==='audio/mpeg'
                  ?ascii.startsWith('ID3')||first[0]===255&&(first[1]&224)===224
                  :false;
  if(!matches)throw Error('文件内容与媒体类型不符，请上传有效的图片、视频或音频');
}

export function deterministicAssetId(owner:string,key:string){
  const hex=createHash('sha256').update(`${owner}\0${key}`).digest('hex').slice(0,32).split('');
  hex[12]='5';
  hex[16]=['8','9','a','b'][Number.parseInt(hex[16],16)%4];
  const value=hex.join('');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

export function readIdempotentAsset(owner:string,key:string){return readAsset(deterministicAssetId(owner,key),owner);}
export function publicAsset(asset:Asset):PublicAsset{
  const value:PublicAsset={id:asset.id,name:asset.name,type:asset.type,size:asset.size,sha256:asset.sha256,createdAt:asset.createdAt,source:asset.source,url:`/api/commerce/assets/${asset.id}`};
  if(asset.jobId)value.jobId=asset.jobId;
  if(asset.folderId)value.folderId=asset.folderId;
  if(asset.collection)value.collection=asset.collection;
  if(asset.assetGroupId!==undefined)value.assetGroupId=asset.assetGroupId;
  if(asset.usageDeclaration!==undefined)value.usageDeclaration=asset.usageDeclaration;
  if(asset.updatedAt!==undefined)value.updatedAt=asset.updatedAt;
  return value;
}

function globalAsset(id:string){
  const row=db().prepare("SELECT owner,value FROM records WHERE bucket='assets' AND id=?").get(id);
  return row?{owner:String(row.owner),asset:JSON.parse(String(row.value)) as Asset}:undefined;
}

function assertAssetMetadata(asset:Asset,bytes?:Buffer){
  if(!/^[a-f0-9-]{36}$/i.test(asset.id)||!asset.owner)throw Error('资产稳定身份无效');
  if(!Number.isFinite(asset.createdAt)||asset.createdAt<=0)throw Error('资产创建时间无效');
  if(asset.size<1||asset.size>150*1024*1024)throw Error('文件大小须为 1 字节至 150 MB');
  if(!/^image\/(png|jpeg|webp)$|^video\/(mp4|webm|quicktime)$|^audio\/(mpeg|wav|mp4|ogg|webm|x-wav)$/.test(asset.type))throw Error('此文件类型不支持');
  if(!/^[a-f0-9]{64}$/.test(asset.sha256))throw Error('资产内容哈希无效');
  if(bytes){
    if(bytes.length!==asset.size||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('资产记录与待保存文件不一致');
    validateMediaBytes(bytes,asset.type);
  }
}

function assertSameMaterializedAsset(current:Asset,candidate:Asset){
  const stable=(asset:Asset)=>({id:asset.id,owner:asset.owner,type:asset.type,size:asset.size,sha256:asset.sha256,source:asset.source,jobId:asset.jobId,temporary:asset.temporary,idempotencyKey:asset.idempotencyKey});
  if(JSON.stringify(stable(current))!==JSON.stringify(stable(candidate)))throw Error('同一资产身份对应了不同内容，已停止覆盖');
}

function assertAssetMutationKeepsIdentity(current:Asset,next:Asset){
  const immutable=(asset:Asset)=>({id:asset.id,owner:asset.owner,type:asset.type,size:asset.size,sha256:asset.sha256,createdAt:asset.createdAt,source:asset.source,jobId:asset.jobId,temporary:asset.temporary,idempotencyKey:asset.idempotencyKey});
  if(JSON.stringify(immutable(current))!==JSON.stringify(immutable(next)))throw Error('资产更新不得改变稳定身份、内容或来源归属');
}

export async function assertAssetIntegrity(asset:Asset){
  const bytes=await fs.readFile(path.join(runtimeDir(),'assets',asset.id));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==asset.size||sha256!==asset.sha256)throw Error('资产记录与本地文件不一致');
  validateMediaBytes(bytes,asset.type);
  return bytes;
}

async function repairStoredAssetBytes(target:string,bytes:Buffer){
  const directory=path.dirname(target);
  const token=`${process.pid}.${crypto.randomUUID()}`;
  const temporaryTarget=path.join(directory,`.${path.basename(target)}.${token}.repair.tmp`);
  const quarantineTarget=path.join(directory,`.${path.basename(target)}.${token}.corrupt`);
  const expected=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(temporaryTarget,bytes,{flag:'wx',mode:0o600});
  let quarantined=false;
  try{
    try{await fs.rename(target,quarantineTarget);quarantined=true;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{await fs.link(temporaryTarget,target);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const current=await fs.readFile(target);
      if(current.length!==bytes.length||createHash('sha256').update(current).digest('hex')!==expected)throw Error('资产修复期间目标文件发生冲突');
    }
    if(quarantined)await fs.rm(quarantineTarget,{force:true});
  }catch(error){
    if(quarantined){
      try{await fs.access(target);}catch{await fs.rename(quarantineTarget,target).catch(()=>undefined);}
    }
    throw error;
  }finally{
    await fs.rm(temporaryTarget,{force:true}).catch(()=>undefined);
  }
}

async function stageAssetBytes(candidate:Asset,bytes:Buffer,allowExisting:boolean){
  const existing=globalAsset(candidate.id),directory=path.join(runtimeDir(),'assets'),target=path.join(directory,candidate.id);
  if(existing){
    if(existing.owner!==candidate.owner)throw Error('资产身份已属于其他账号，已停止写入');
    if(!allowExisting)throw Error('随机资产身份发生冲突');
    assertSameMaterializedAsset(existing.asset,candidate);
    try{await assertAssetIntegrity(existing.asset);}
    catch{await repairStoredAssetBytes(target,bytes);await assertAssetIntegrity(existing.asset);}
    return;
  }
  const temporaryTarget=path.join(directory,`.${candidate.id}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  try{
    await fs.writeFile(temporaryTarget,bytes,{flag:'wx',mode:0o600});
    try{await fs.link(temporaryTarget,target);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const persisted=await fs.readFile(target);
      if(persisted.length!==bytes.length||createHash('sha256').update(persisted).digest('hex')!==candidate.sha256)throw Error('资产文件已经存在但内容不一致');
    }
  }finally{await fs.rm(temporaryTarget,{force:true}).catch(()=>undefined);}
}

export type MaterializationTransaction={assets:readonly Asset[];commit:()=>void;skip:()=>void};
export type FixedAssetMaterialization={asset:Asset;bytes?:Buffer;loadBytes?:()=>Promise<Buffer>};
/** Materializes fixed identities and the caller's state transition atomically. */
export async function materializeAssets<T>(owner:string,specs:FixedAssetMaterialization[],finalize:(tx:MaterializationTransaction)=>T,mutationGuard?:MutationGuard,options:{allowExisting?:boolean}={allowExisting:true}){
  const ids=specs.map(value=>value.asset.id),allowExisting=options.allowExisting!==false;
  if(new Set(ids).size!==ids.length)throw Error('同一批资产包含重复身份');
  if(specs.some(value=>value.asset.owner!==owner))throw Error('资产批次所属账号不一致');
  for(const {asset,bytes,loadBytes} of specs){assertAssetMetadata(asset);if(!bytes&&!loadBytes)throw Error('资产批次缺少内容读取器');if(bytes)assertAssetMetadata(asset,bytes);}
  return withAssetMutationLeases(ids,mutationGuard,async guard=>{
    for(const spec of specs){const bytes=spec.bytes||await spec.loadBytes!();assertAssetMetadata(spec.asset,bytes);await stageAssetBytes(spec.asset,bytes,allowExisting);if(!guard())throw Error('资产批次写入租约已经失效');}
    return transaction(()=>{
      if(!guard())throw Error('资产批次写入租约已经失效');
      let decision:'commit'|'skip'|undefined;
      const commit=()=>{if(decision)throw Error('资产批次事务已经作出决定');decision='commit';for(const {asset} of specs){const latest=globalAsset(asset.id);if(latest){if(latest.owner!==owner)throw Error('资产身份已属于其他账号，已停止写入');if(!allowExisting)throw Error('随机资产身份发生冲突');assertSameMaterializedAsset(latest.asset,asset);}else put('assets',asset.id,owner,asset);}};
      const skip=()=>{if(decision)throw Error('资产批次事务已经作出决定');decision='skip';};
      const result=finalize({assets:specs.map(value=>value.asset),commit,skip});
      if(!decision)throw Error('资产批次事务未明确提交或跳过');
      return result;
    });
  });
}

export async function materializeAsset(candidate:Asset,bytes:Buffer,mutationGuard?:MutationGuard,options:{allowExisting?:boolean}={allowExisting:true}){
  await materializeAssets(candidate.owner,[{asset:candidate,bytes}],tx=>{tx.commit();},mutationGuard,options);
  const stored=readAsset(candidate.id,candidate.owner);
  if(!stored)throw Error('资产记录保存失败');
  return stored;
}

/**
 * Commits already staged, byte-pinned asset files together with the caller's
 * synchronous domain transition. Prefer materializeAssets when bytes are in
 * memory; this variant is retained for large staged importers.
 */
export async function commitMaterializedAssetRecords<T>(owner:string,candidates:Asset[],commit:()=>T,mutationGuard?:MutationGuard){
  const ids=candidates.map(value=>value.id);
  if(new Set(ids).size!==ids.length)throw Error('同一批资产包含重复身份');
  if(candidates.some(value=>value.owner!==owner))throw Error('资产批次所属账号不一致');
  return withAssetMutationLeases(ids,mutationGuard,async guard=>{
    for(const candidate of candidates){assertAssetMetadata(candidate);const bytes=await fs.readFile(path.join(runtimeDir(),'assets',candidate.id));assertAssetMetadata(candidate,bytes);}
    return transaction(()=>{
      if(!guard())throw Error('资产批次写入租约已经失效');
      for(const candidate of candidates){
        const existing=globalAsset(candidate.id);
        if(existing){if(existing.owner!==owner)throw Error('资产身份已属于其他账号，已停止写入');assertSameMaterializedAsset(existing.asset,candidate);}
        else put('assets',candidate.id,owner,candidate);
      }
      return commit();
    });
  });
}

export async function storeAsset(
  owner:string,
  bytes:Buffer,
  type:string,
  name:string,
  source:Asset['source']='upload',
  jobId?:string,
  temporary?:Asset['temporary'],
  idempotencyKey?:string,
  mutationGuard?:MutationGuard,
){
  if(bytes.length===0||bytes.length>150*1024*1024)throw Error('文件大小须为 1 字节至 150 MB');
  if(!/^image\/(png|jpeg|webp)$|^video\/(mp4|webm|quicktime)$|^audio\/(mpeg|wav|mp4|ogg|webm|x-wav)$/.test(type))throw Error('此文件类型不支持');
  validateMediaBytes(bytes,type);
  const id=idempotencyKey?deterministicAssetId(owner,idempotencyKey):crypto.randomUUID(),asset:Asset={
    id,owner,name:name.slice(0,160),type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:Date.now(),source,
    ...(jobId?{jobId}:{}),...(temporary?{temporary}:{}),...(idempotencyKey?{idempotencyKey}:{}),
  };
  return materializeAsset(asset,bytes,mutationGuard,{allowExisting:!!idempotencyKey});
}

export const readAsset=(id:string,owner:string)=>get<Asset>('assets',id,owner);
export const assetBytes=(asset:Asset)=>assertAssetIntegrity(asset);
export const assets=(owner:string)=>list<Asset>('assets',owner);

export async function mutateAsset(owner:string,id:string,update:(current:Asset)=>Asset|Promise<Asset>,mutationGuard?:MutationGuard){
  return (await mutateAssets(owner,[id],async values=>[await update(values[0])],mutationGuard))[0];
}

export async function mutateAssets(owner:string,ids:string[],update:(current:Asset[])=>Asset[]|Promise<Asset[]>,mutationGuard?:MutationGuard,beforeCommit?:()=>void){
  const unique=[...new Set(ids)];if(unique.length!==ids.length||!unique.length)throw Error('资产更新列表无效');
  return withAssetMutationLeases(unique,mutationGuard,async guard=>{
    const current=unique.map(id=>{const value=readAsset(id,owner);if(!value)throw Error('素材不存在');return value;});
    const next=await update(structuredClone(current));
    if(next.length!==current.length)throw Error('资产批量更新不得改变成员数量');
    for(let i=0;i<next.length;i++)assertAssetMutationKeepsIdentity(current[i],next[i]);
    transaction(()=>{
      if(!guard())throw Error('资产更新租约已经失效');
      beforeCommit?.();
      for(let i=0;i<current.length;i++){const latest=readAsset(current[i].id,owner);if(!latest||JSON.stringify(latest)!==JSON.stringify(current[i]))throw Error('资产记录在更新期间发生变化，已停止覆盖');}
      for(const value of next)put('assets',value.id,owner,value);
    });
    return next;
  });
}

export async function deleteAsset(owner:string,id:string,expectedTemporary?:{parentJobId:string;isCurrent?:MutationGuard}){
  return withAssetMutationLease(owner,id,expectedTemporary?.isCurrent,async guard=>{
    const asset=readAsset(id,owner);
    if(!asset)throw Error('素材不存在');
    if(expectedTemporary&&(asset.source!=='generated'||asset.jobId!==expectedTemporary.parentJobId||asset.temporary?.kind!=='rolling-tail'||asset.temporary.parentJobId!==expectedTemporary.parentJobId))throw Error('只能清理当前滚动任务生成的临时尾帧');
    if(!expectedTemporary&&asset.jobId){
      const active=['queued','running','processing','saving','unknown'];
      const ownerJob=get<{status?:string}>('jobs',asset.jobId,owner),frameJob=get<{status?:string}>('frame-extractions',asset.jobId,owner);
      const hotRemixJob=get<{status?:string}>('hot-video-remix-jobs',asset.jobId,owner);
      const voiceReplaceJob=get<{status?:string}>('voice-replace-jobs',asset.jobId,owner);
      const voiceJob=get<{status?:string}>('voice-jobs',asset.jobId,owner);
      const voiceActive=['billing_pending','queued','running','saving','submission_unknown'];
      if([ownerJob,frameJob,hotRemixJob,voiceReplaceJob].some(value=>value&&active.includes(String(value.status)))||(voiceJob&&voiceActive.includes(String(voiceJob.status))))throw Error('生成任务仍在运行或保存，暂不能删除结果资产');
    }
    if(!expectedTemporary){
      const activeJobReference=db().prepare("SELECT 1 FROM records AS r, json_each(r.value,'$.input.references') AS ref WHERE r.bucket='jobs' AND r.owner=? AND json_extract(r.value,'$.status') IN ('queued','running','processing','saving','unknown') AND json_extract(ref.value,'$.id')=? LIMIT 1").get(owner,id);
      const activeFrameSource=db().prepare("SELECT 1 FROM records WHERE bucket='frame-extractions' AND owner=? AND json_extract(value,'$.sourceAssetId')=? AND json_extract(value,'$.status') IN ('queued','running') LIMIT 1").get(owner,id);
      const activeWorkflowReference=db().prepare("SELECT 1 FROM records AS r, json_each(r.value,'$.nodes') AS node, json_each(node.value,'$.data.assetIds') AS asset_id WHERE r.bucket='workflows' AND r.owner=? AND json_extract(r.value,'$.status') IN ('running','waiting','paused') AND asset_id.value=? LIMIT 1").get(owner,id);
      const activeHotRemixReference=db().prepare("SELECT 1 FROM records AS r WHERE r.bucket='hot-video-remix-jobs' AND r.owner=? AND json_extract(r.value,'$.status') IN ('queued','running') AND (json_extract(r.value,'$.bgmAssetId')=? OR EXISTS (SELECT 1 FROM json_each(r.value,'$.sourceAssetIds') AS source WHERE source.value=?)) LIMIT 1").get(owner,id,id);
      const activeVoiceReplaceReference=db().prepare("SELECT 1 FROM records WHERE bucket='voice-replace-jobs' AND owner=? AND json_extract(value,'$.status') IN ('queued','running') AND (json_extract(value,'$.videoSnapshot.assetId')=? OR json_extract(value,'$.audioSnapshot.assetId')=?) LIMIT 1").get(owner,id,id);
      if(activeJobReference||activeFrameSource||activeWorkflowReference||activeHotRemixReference||activeVoiceReplaceReference)throw Error('素材正在被已确认任务引用，任务结束前不能删除');
    }
    if(asset.providerReferenceKey){
      if(!guard())throw Error('资产清理租约已经失效');
      const deleted=await storageManager.delete(asset.providerReferenceKey,asset.providerReferenceProvider);
      if(!deleted)throw Error('临时素材的对象存储文件清理失败');
    }
    if(!guard())throw Error('资产清理租约已经失效');
    await fs.rm(path.join(runtimeDir(),'assets',asset.id),{force:true});
    transaction(()=>{
      if(!guard())throw Error('资产清理租约已经失效');
      const latest=readAsset(id,owner);if(!latest||latest.sha256!==asset.sha256||latest.createdAt!==asset.createdAt)throw Error('资产记录在清理期间发生变化，已停止覆盖');
      remove('assets',asset.id,owner);
    });
  });
}

export async function sweepAssetOrphans(now=Date.now(),ttlMs=24*60*60*1000,limit=200){
  const lease=claimRecordLease('commerce-maintenance-leases','asset-orphan-sweep','system',`${process.pid}:${crypto.randomUUID()}`,now,10*60_000);
  if(!lease)return {scanned:0,removed:0,missing:0,busy:true};
  let scanned=0,removedCount=0,missing=0;
  try{
    const directory=path.join(runtimeDir(),'assets');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const referenced=new Set((db().prepare("SELECT id FROM records WHERE bucket='assets'").all() as {id:string}[]).map(row=>String(row.id)));
    const entries=await fs.readdir(directory,{withFileTypes:true});
    for(const entry of entries){
      if(scanned>=Math.max(1,Math.min(2000,Math.trunc(limit)||200)))break;
      if(!entry.isFile())continue;scanned++;
      const target=path.join(directory,entry.name),stat=await fs.stat(target).catch(()=>undefined);if(!stat||now-stat.mtimeMs<ttlMs)continue;
      const temporary=entry.name.startsWith('.')&&(/\.tmp$|\.corrupt$/.test(entry.name));
      if(!temporary&&referenced.has(entry.name))continue;
      const id=temporary?(entry.name.match(/^\.([^.]*)\./)?.[1]||entry.name):entry.name;
      try{await withAssetMutationLease('system',id,undefined,async guard=>{if(!guard())throw Error('资产清理租约已经失效');if(!temporary&&db().prepare("SELECT 1 FROM records WHERE bucket='assets' AND id=? LIMIT 1").get(entry.name))return;await fs.rm(target,{force:true});removedCount++;});}catch{/* A live writer or newer record owns this path. */}
    }
    for(const row of db().prepare("SELECT value FROM records WHERE bucket='assets' LIMIT ?").all(Math.max(1,Math.min(2000,Math.trunc(limit)||200)))){
      const asset=JSON.parse(String(row.value)) as Asset;
      try{await fs.access(path.join(directory,asset.id));}catch{missing++;}
    }
    return {scanned,removed:removedCount,missing,busy:false};
  }finally{releaseRecordLease(lease);}
}

export const publicFetch=fetchPublic;

export async function downloadResult(url:string,expected:'image'|'video'|'audio'){
  if(url.startsWith('data:')){
    const match=url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!match||expected!=='image')throw Error('图片结果格式无效');
    return {bytes:Buffer.from(match[2],'base64'),type:match[1]};
  }
  const response=await publicFetch(url);
  if(!response.ok)throw Error(`结果下载失败（${response.status}），可重试保存原结果`);
  const type=(response.headers.get('content-type')||'').split(';')[0];
  if(!type.startsWith(`${expected}/`))throw Error('模型返回的媒体类型不正确');
  if(Number(response.headers.get('content-length'))>150*1024*1024)throw Error('生成文件过大');
  const reader=response.body?.getReader();
  if(!reader)throw Error('结果内容为空');
  const chunks:Buffer[]=[];
  let size=0;
  for(;;){
    const {value,done}=await reader.read();
    if(done)break;
    size+=value.length;
    if(size>150*1024*1024){await reader.cancel();throw Error('生成文件过大');}
    chunks.push(Buffer.from(value));
  }
  return {bytes:Buffer.concat(chunks),type};
}
