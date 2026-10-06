import crypto from 'node:crypto';
import {get,put,list,remove} from './store';
import {readAsset} from './assets';

export type AssetGroup={id:string;owner:string;name:string;assetIds:string[];createdAt:number;updatedAt:number};

export function assetGroups(owner:string){return list<AssetGroup>('asset-groups',owner).sort((a,b)=>b.updatedAt-a.updatedAt);}
export function assetGroup(id:string,owner:string){return get<AssetGroup>('asset-groups',id,owner);}
export function createAssetGroup(owner:string,name:string,assetIds:string[]=[]){
  const clean=name.trim();if(!clean)throw Error('分组名称必填');
  for(const aid of assetIds){if(!readAsset(aid,owner))throw Error('素材不存在或不属于当前账号: '+aid.slice(0,8));}
  if(clean.length>60)throw Error('分组名称过长');
  const group:AssetGroup={id:crypto.randomUUID(),owner,name:clean,assetIds:[...new Set(assetIds)],createdAt:Date.now(),updatedAt:Date.now()};
  put('asset-groups',group.id,owner,group);return group;
}
export function updateAssetGroup(id:string,owner:string,patch:{name?:string;attachAssetIds?:string[];removeAssetIds?:string[]}){
  const group=get<AssetGroup>('asset-groups',id,owner);if(!group)throw Error('分组不存在');
  if(patch.name!==undefined){const clean=patch.name.trim();if(!clean)throw Error('分组名称必填');group.name=clean.slice(0,60);}
  if(patch.attachAssetIds?.length){for(const aid of patch.attachAssetIds){if(!readAsset(aid,owner))throw Error('素材不存在或不属于当前账号: '+aid.slice(0,8));}group.assetIds=[...new Set([...group.assetIds,...patch.attachAssetIds])];}
  if(patch.removeAssetIds?.length)group.assetIds=group.assetIds.filter(a=>!patch.removeAssetIds!.includes(a));
  group.updatedAt=Date.now();put('asset-groups',id,owner,group);return group;
}
export function deleteAssetGroup(id:string,owner:string){if(!get<AssetGroup>('asset-groups',id,owner))throw Error('分组不存在');remove('asset-groups',id,owner);return true;}
