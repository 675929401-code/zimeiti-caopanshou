import {get,put} from './store';

export type ModelVisibilityState={showOnly:Partial<Record<'agent'|'image'|'video',string[]>>};
const BUCKET='model-visibility',ID='state',OWNER='system';

export function modelVisibility():ModelVisibilityState{
 const raw=get<Partial<ModelVisibilityState>>(BUCKET,ID,OWNER)||{};
 const out:ModelVisibilityState={showOnly:{}};
 for(const kind of ['agent','image','video'] as const){
  const p=raw.showOnly?.[kind];
  out.showOnly[kind]=Array.isArray(p)?p.filter(x=>typeof x==='string'&&x.trim()):[];
 }
 return out;
}
export function setModelVisibility(kind:'agent'|'image'|'video',patterns:string[]):ModelVisibilityState{
 if(!['agent','image','video'].includes(kind))throw Error('模型类型无效');
 const clean=(patterns||[]).map(p=>String(p).trim().toLowerCase()).filter(p=>p&&p.length<=80);
 const o=modelVisibility();
 o.showOnly[kind]=clean;
 put(BUCKET,ID,OWNER,o);
 return o;
}
export function filterModelsByVisibility<T extends {id:string;displayName?:string;modelName?:string;name?:string}>(kind:'agent'|'image'|'video',list:T[]):T[]{
 const patterns=modelVisibility().showOnly[kind]||[];
 if(!patterns.length)return list;
 return list.filter(m=>{
  const hay=[m.id,m.displayName,m.modelName,m.name].filter(Boolean).join(' ').toLowerCase();
  return patterns.some(p=>hay.includes(p));
 });
}
