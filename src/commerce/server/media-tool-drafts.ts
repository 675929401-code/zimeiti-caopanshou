import {get,put,transaction} from './store';
import {readAsset} from './assets';
import type {EditJob} from './media-tools';
import {validateEraseRegions,type EraseRegion} from '../media-edit-regions';

export type MediaTool='watermark'|'subtitle'|'mosaic'|'enhance'|'trim';
export type MediaToolDraftState={tool:MediaTool;assetId:string;regions:EraseRegion[];selected:number;range:{start:number;end:number};resolution:number;lastJobId:string};
export type MediaToolDraft=MediaToolDraftState&{revision:number;updatedAt:number};
type StoredDraft=MediaToolDraft&{clientId:string;sequence:number};
export class MediaDraftConflict extends Error {constructor(){super('此工具草稿已在其他页面更新，请重新载入后编辑');}}
export function mediaTool(value:unknown):MediaTool{if(!['watermark','subtitle','mosaic','enhance','trim'].includes(String(value)))throw Error('媒体工具类型无效');return value as MediaTool;}
const key=(owner:string,tool:MediaTool)=>owner+':'+tool;
const publicDraft=({clientId:_,sequence:__,...draft}:StoredDraft):MediaToolDraft=>draft;
export function readMediaToolDraft(owner:string,tool:MediaTool,localAssetId=''){
 const value=get<StoredDraft>('media-tool-drafts',key(owner,tool),owner);
 const asset=value?.assetId?readAsset(value.assetId,owner):undefined;
 const publicAsset=(entry:typeof asset)=>entry?{id:entry.id,name:entry.name,type:entry.type,size:entry.size,createdAt:entry.createdAt,source:entry.source,...(entry.jobId?{jobId:entry.jobId}:{}),url:'/api/commerce/assets/'+entry.id}:null;
 if(localAssetId.length>80)throw Error('本地草稿素材参数无效');
 const localAsset=localAssetId?readAsset(localAssetId,owner):undefined;
 return {ownerId:owner,draft:value?publicDraft(value):null,assetMissing:!!value?.assetId&&!asset,asset:publicAsset(asset),localAsset:localAsset?.type.startsWith('video/')?publicAsset(localAsset):null};
}
export function saveMediaToolDraft(owner:string,input:unknown):MediaToolDraft{
 if(!input||typeof input!=='object')throw Error('草稿参数无效');
 const data=input as MediaToolDraftState&{expectedRevision:number;clientId:string;sequence:number},tool=mediaTool(data.tool);
 if(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<0||!Number.isSafeInteger(data.sequence)||data.sequence<1||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId))throw Error('草稿版本参数无效');
 if(typeof data.assetId!=='string'||data.assetId.length>80)throw Error('素材参数无效');
 if(data.assetId){const asset=readAsset(data.assetId,owner);if(!asset||!asset.type.startsWith('video/'))throw Error('草稿素材不存在或不属于当前账号');}
 const erase=tool==='watermark'||tool==='subtitle',regions=erase?validateEraseRegions(tool,data.regions):[];
 if(!Number.isSafeInteger(data.selected)||data.selected<0||data.selected>=Math.max(1,regions.length))throw Error('选中区域无效');
 if(!data.range||[data.range.start,data.range.end].some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>300)||data.range.end<data.range.start)throw Error('草稿时间范围无效');
 if(![720,1080,1440,2160].includes(data.resolution))throw Error('草稿分辨率无效');
 if(typeof data.lastJobId!=='string'||data.lastJobId.length>80)throw Error('草稿任务参数无效');
 if(data.lastJobId){const job=get<EditJob>('media-edits',data.lastJobId,owner);if(!job||job.input.assetId!==data.assetId||job.input.tool!==tool)throw Error('草稿任务不存在或与当前素材不匹配');}
 const state:MediaToolDraftState={tool,assetId:data.assetId,regions,selected:data.selected,range:{start:data.range.start,end:data.range.end},resolution:data.resolution,lastJobId:data.lastJobId};
 return transaction(()=>{
  const previous=get<StoredDraft>('media-tool-drafts',key(owner,tool),owner);
  if(previous?.clientId===data.clientId&&previous.sequence===data.sequence){const {revision:_,updatedAt:__,clientId:___,sequence:____,...prior}=previous;if(JSON.stringify(prior)!==JSON.stringify(state))throw new MediaDraftConflict();return publicDraft(previous);}
  // A final keepalive snapshot may overtake an in-flight save in the same tab.
  // Only its strictly newer sequence can supersede that tab's older revision.
  if(previous?.clientId===data.clientId&&data.sequence<previous.sequence)throw new MediaDraftConflict();
  const sameTabNewer=previous?.clientId===data.clientId&&data.sequence>previous.sequence&&data.expectedRevision<=previous.revision;
  if(data.expectedRevision!==(previous?.revision||0)&&!sameTabNewer)throw new MediaDraftConflict();
  const value:StoredDraft={...state,revision:(previous?.revision||0)+1,updatedAt:Date.now(),clientId:data.clientId,sequence:data.sequence};
  put('media-tool-drafts',key(owner,tool),owner,value);return publicDraft(value);
 });
}
