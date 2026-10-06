import type {UIAsset} from './runtime-ui';
async function read<T>(url:string,signal?:AbortSignal):Promise<T>{const response=await fetch(url,{cache:'no-store',signal});const result=await response.json();if(!response.ok)throw Error(result.error||'素材读取失败');return result;}
import {listMaterials} from './material-store';
export type MaterialReference={id:string;name:string;type:string;slot:string;serverId?:string};
export type RecoveredMaterial=MaterialReference&{url:string;size:number};
export function bindRecoveredMaterials(refs:MaterialReference[],owned:UIAsset[],local:{id:string;name:string;type:string;size:number;blob:Blob}[]){
 const usedIds=new Set<string>(),missing:string[]=[];
 const materials=refs.flatMap<RecoveredMaterial>(ref=>{let id=ref.id;if(!id||usedIds.has(id))id=crypto.randomUUID();usedIds.add(id);
  if(ref.serverId){const asset=owned.find(item=>item.id===ref.serverId);if(asset)return [{id,serverId:asset.id,name:asset.name,type:asset.type,size:asset.size,slot:ref.slot,url:asset.url}];}
  const stored=local.find(item=>item.id===ref.id);if(stored)return [{id,name:stored.name,type:stored.type,size:stored.size,slot:ref.slot,url:URL.createObjectURL(stored.blob)}];
  missing.push(ref.name||ref.serverId||ref.id);return [];
 });return {materials,missing};
}
export async function recoverMaterials(refs:MaterialReference[],namespace:string,signal?:AbortSignal){
 const timed=AbortSignal.timeout(20000),requestSignal=signal?AbortSignal.any([signal,timed]):timed;
 const verifyOwner=async()=>{const session=await read<{user?:{id?:string}}>('/api/commerce/session',requestSignal);if(!session.user?.id||namespace!=='commerce-agent:owner:'+session.user.id+':v2')throw Error('工作室账号已改变，请重新进入当前账号的创作页面');};
 const ids=[...new Set(refs.flatMap(ref=>ref.serverId?[ref.serverId]:[]))];let owned:UIAsset[]=[];
 if(refs.length)await verifyOwner();
 if(ids.length)owned=(await read<{assets:UIAsset[]}>('/api/commerce/asset-library?'+new URLSearchParams({ids:ids.join(','),limit:'100'}),requestSignal)).assets;
 const local=refs.some(ref=>!ref.serverId)?await listMaterials(namespace):[];
 if(refs.length)await verifyOwner();requestSignal.throwIfAborted();
 return bindRecoveredMaterials(refs,owned,local);
}
