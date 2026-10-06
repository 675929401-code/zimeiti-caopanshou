'use client';
import {useEffect,useRef,useState} from 'react';
import {canvasLocalVersions,checkpointCanvas,acknowledgeCanvas,canvasBody as bodyOf,canvasDraftKey,type CanvasDraft,type LocalCanvasDraft as LocalDraft} from './canvas-local-drafts';
export {canvasDraftKey};export type {CanvasDraft};
export function useCanvasAutosave(value:CanvasDraft,opened:boolean,ownerId:string){
 const [status,setStatus]=useState(''),[conflict,setConflict]=useState(false),revisions=useRef(new Map<string,number>()),queue=useRef(Promise.resolve()),saved=useRef(new Map<string,string>()),blocked=useRef(new Set<string>()),current=useRef(value.id),latest=useRef(value),owner=useRef(ownerId),open=useRef(opened);
 const client=useRef(crypto.randomUUID()),sessionOwner=useRef(ownerId),adopted=useRef(new Map<string,{key:string;raw:string}>());sessionOwner.current=ownerId;
 current.current=value.id;latest.current=value;if(!opened||!owner.current)owner.current=ownerId;open.current=opened;
 function readLocal(id:string):LocalDraft|null{if(!owner.current)return null;try{const rows=canvasLocalVersions(localStorage,owner.current,id);return rows.find(row=>row.key===canvasDraftKey(owner.current,id)+':'+client.current)||rows[0]||null;}catch{return null;}}
 function persistLocal(draft:CanvasDraft){if(!owner.current||!draft.id)return;const serialized=JSON.stringify(bodyOf(draft));if(saved.current.get(draft.id)===serialized)return;const previous=readLocal(draft.id);try{checkpointCanvas(localStorage,owner.current,client.current,blocked.current.has(draft.id)?previous?.baseRevision??-1:revisions.current.get(draft.id)||0,draft);}catch{setStatus('本机草稿空间不足，请保存或导出当前画布');}}
 function accept(draft:CanvasDraft){revisions.current.set(draft.id,draft.revision||0);if(draft.updatedAt)saved.current.set(draft.id,JSON.stringify(bodyOf(draft)));else saved.current.delete(draft.id);setConflict(blocked.current.has(draft.id));setStatus(draft.updatedAt?'已保存':'等待同步本机草稿');}
 function restore(draft:CanvasDraft):CanvasDraft{
   accept(draft);let local=readLocal(draft.id);
   if(!local&&draft.updatedAt&&owner.current){try{const legacy=JSON.parse(localStorage.getItem('commerce-canvas-draft:'+draft.id)||'null');if(legacy?.value?.id===draft.id&&legacy.at>(draft.updatedAt||0)){local={ownerId:owner.current,baseRevision:-1,at:legacy.at,value:legacy.value};localStorage.setItem(canvasDraftKey(owner.current,draft.id),JSON.stringify(local));}}catch{}}
   if(!local)return draft;const versions=canvasLocalVersions(localStorage,owner.current,draft.id);
   const differentVersions=versions.filter(item=>JSON.stringify(bodyOf(item.value))!==JSON.stringify(bodyOf(draft)));if(!differentVersions.length){acknowledgeCanvas(localStorage,owner.current,client.current,draft,draft.revision||0);return draft;}
   if(JSON.stringify(bodyOf(local.value))===JSON.stringify(bodyOf(draft)))local=differentVersions[0];const selected=versions.find(item=>JSON.stringify(bodyOf(item.value))===JSON.stringify(bodyOf(local!.value)));if(selected)adopted.current.set(draft.id,{key:selected.key,raw:selected.raw});
   if(local.baseRevision!==(draft.revision||0)||new Set(differentVersions.map(item=>JSON.stringify(bodyOf(item.value)))).size>1){blocked.current.add(draft.id);setConflict(true);setStatus('本机与服务器或其他页面存在不同修改，已分别保留');}
   else{blocked.current.delete(draft.id);setConflict(false);setStatus('已恢复本机未同步修改');}
   return {...local.value,revision:draft.revision};
 }
 function discard(server:CanvasDraft){localStorage.removeItem(canvasDraftKey(owner.current,server.id)+':'+client.current);const selected=adopted.current.get(server.id);if(selected&&localStorage.getItem(selected.key)===selected.raw)localStorage.removeItem(selected.key);localStorage.removeItem('commerce-canvas-draft:'+server.id);adopted.current.delete(server.id);blocked.current.delete(server.id);setConflict(false);accept(server);}
 function save(draft:CanvasDraft=latest.current):Promise<CanvasDraft>{
   const body=bodyOf(draft),serialized=JSON.stringify(body),savedOwner=owner.current;persistLocal(draft);
   const work=queue.current.catch(()=>{}).then(async()=>{
     if(!savedOwner||owner.current!==savedOwner||sessionOwner.current!==savedOwner)throw Error('画布账号已变化，请重新打开当前账号的画布');
     if(blocked.current.has(draft.id))throw Error('本机与服务器画布有冲突，请先导出本机修改或选择服务器版本');
     if(saved.current.get(draft.id)===serialized)return {...draft,revision:revisions.current.get(draft.id)||0};
     if(current.current===draft.id)setStatus('保存中…');
     const response=await fetch('/api/commerce/canvases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,ownerId:savedOwner,expectedRevision:revisions.current.get(draft.id)||0})});
     const data=await response.json();if(!response.ok){if(response.status===409){blocked.current.add(draft.id);if(current.current===draft.id)setConflict(true);}throw Error(data.error||'画布保存失败');}
     const result=data.canvas as CanvasDraft;if(owner.current!==savedOwner||sessionOwner.current!==savedOwner)throw Error('画布保存期间账号已变化，请重新打开画布');revisions.current.set(draft.id,result.revision||0);saved.current.set(draft.id,serialized);
     acknowledgeCanvas(localStorage,savedOwner,client.current,draft,result.revision||0);
     if(current.current===draft.id)setStatus('已自动保存');return result;
   });
   queue.current=work.then(()=>{},error=>{if(current.current===draft.id)setStatus((error as Error).message);throw error;});queue.current.catch(()=>{});return work;
 }
 const serialized=JSON.stringify(bodyOf(value));
 useEffect(()=>{if(!opened||!ownerId||!value.id||saved.current.get(value.id)===serialized)return;persistLocal(value);if(blocked.current.has(value.id))return;const timer=setTimeout(()=>void save(JSON.parse(serialized)).catch(()=>{}),700);return()=>clearTimeout(timer);},[opened,ownerId,serialized]);
 useEffect(()=>{const checkpoint=()=>{if(open.current)persistLocal(latest.current);};window.addEventListener('pagehide',checkpoint);return()=>{checkpoint();window.removeEventListener('pagehide',checkpoint);};},[]);
 return {status,conflict,save,accept,restore,discard,localSnapshots:()=>canvasLocalVersions(localStorage,owner.current,current.current).map(({value,baseRevision,at})=>({value,baseRevision,at}))};
}
