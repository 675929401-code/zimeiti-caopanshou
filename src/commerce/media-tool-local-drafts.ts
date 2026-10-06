import type {MediaTool,MediaToolDraft,MediaToolDraftState} from './server/media-tool-drafts';
import {validateEraseRegions} from './media-edit-regions';

export type LocalMediaDraft={version:1;ownerId:string;tool:MediaTool;baseRevision:number;updatedAt:number;state:MediaToolDraftState};
export const localMediaPrefix=(ownerId:string,tool:MediaTool)=>'ca-media-draft-v1:'+encodeURIComponent(ownerId)+':'+tool+':';
export function parseLocalMediaDraft(raw:string,ownerId:string,tool:MediaTool):LocalMediaDraft{
 if(raw.length>40000)throw Error('本地草稿内容过大');
 const value=JSON.parse(raw) as LocalMediaDraft,state=value?.state;
 if(value.version!==1||value.ownerId!==ownerId||value.tool!==tool||!Number.isSafeInteger(value.baseRevision)||value.baseRevision<0||!Number.isFinite(value.updatedAt)||!state||state.tool!==tool)throw Error('本地草稿身份或版本无效');
 if(typeof state.assetId!=='string'||state.assetId.length>80||typeof state.lastJobId!=='string'||state.lastJobId.length>80||!state.range||[state.range.start,state.range.end].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>300)||state.range.start>state.range.end||![720,1080,1440,2160].includes(state.resolution))throw Error('本地草稿设置无效');
 const regions=tool==='watermark'||tool==='subtitle'?validateEraseRegions(tool,state.regions):[];
 if(!Number.isSafeInteger(state.selected)||state.selected<0||state.selected>=Math.max(1,regions.length))throw Error('本地草稿选区无效');
 return {...value,state:{tool,assetId:state.assetId,regions,selected:state.selected,range:{start:state.range.start,end:state.range.end},resolution:state.resolution,lastJobId:state.lastJobId}};
}
export const mediaDraftState=(draft:MediaToolDraftState):MediaToolDraftState=>({tool:draft.tool,assetId:draft.assetId,regions:draft.regions,selected:draft.selected,range:draft.range,resolution:draft.resolution,lastJobId:draft.lastJobId});
export function localMediaDecision(local:LocalMediaDraft,server:MediaToolDraft|null):'confirmed'|'restore'|'conflict'{
 if(server&&JSON.stringify(local.state)===JSON.stringify(mediaDraftState(server)))return 'confirmed';
 return local.baseRevision===(server?.revision||0)?'restore':'conflict';
}
export function removeLocalMediaSnapshot(storage:Pick<Storage,'getItem'|'removeItem'>,key:string,expectedRaw:string){
 if(storage.getItem(key)!==expectedRaw)return false;storage.removeItem(key);return true;
}
