import {normalizeCanvasGraph,type CanvasGroup,type CanvasViewport} from '../../shared/canvas-schema';
export type CanvasDraft={id:string;title:string;nodes:unknown[];edges:unknown[];groups?:CanvasGroup[];viewport?:CanvasViewport;revision?:number;updatedAt?:number};
export type LocalCanvasDraft={ownerId:string;baseRevision:number;at:number;value:CanvasDraft};
type StorageLike=Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>;
export const canvasDraftKey=(owner:string,id:string)=>`commerce-canvas-draft-v2:${owner}:${id}`;
export function canvasBody(draft:CanvasDraft){
 // Selection and React Flow measurements are UI state, not a new saved revision.
 // An invalid in-progress edit still gets an offline checkpoint for recovery.
 const raw={nodes:draft.nodes,edges:draft.edges,groups:draft.groups||[],viewport:draft.viewport||{x:0,y:0,zoom:1}};
 let graph;try{graph=normalizeCanvasGraph(raw);}catch{graph=raw;}
 return {id:draft.id,title:draft.title,...graph};
}
export function canvasLocalVersions(storage:StorageLike,owner:string,id:string){
 const prefix=canvasDraftKey(owner,id),result:Array<LocalCanvasDraft&{key:string;raw:string}>=[];
 if(!owner)return result;
 for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key!==prefix&&!key?.startsWith(prefix+':'))continue;try{const raw=storage.getItem(key)||'',v=JSON.parse(raw);if(v?.ownerId===owner&&v.value?.id===id&&Number.isFinite(v.at)&&Number.isInteger(v.baseRevision)&&Array.isArray(v.value.nodes)&&Array.isArray(v.value.edges))result.push({...v,key,raw});}catch{}}
 return result.sort((a,b)=>b.at-a.at||b.key.localeCompare(a.key));
}
export function checkpointCanvas(storage:StorageLike,owner:string,client:string,baseRevision:number,value:CanvasDraft){const draft={ownerId:owner,baseRevision,at:Date.now(),value:canvasBody(value)};storage.setItem(canvasDraftKey(owner,value.id)+':'+client,JSON.stringify(draft));return draft;}
export function acknowledgeCanvas(storage:StorageLike,owner:string,client:string,value:CanvasDraft,revision:number){const serialized=JSON.stringify(canvasBody(value)),ownKey=canvasDraftKey(owner,value.id)+':'+client;for(const saved of canvasLocalVersions(storage,owner,value.id)){if(JSON.stringify(canvasBody(saved.value))===serialized){if(storage.getItem(saved.key)===saved.raw)storage.removeItem(saved.key);}else if(saved.key===ownKey&&storage.getItem(saved.key)===saved.raw)storage.setItem(saved.key,JSON.stringify({ownerId:owner,baseRevision:revision,at:saved.at,value:saved.value}));}}
