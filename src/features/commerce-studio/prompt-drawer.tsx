'use client';
import {useEffect,useRef} from 'react';
type Draft={name:string;promptKey:string;content:string;changeNote:string};
export function PromptDrawer({draft,version,busy,message,change,save,close}:{draft:Draft;version:string;busy:boolean;message:string;change:(value:Draft)=>void;save:()=>void;close:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=ref.current;node?.showModal();return()=>node?.close();},[]);
 return <dialog className="cs-prompt-drawer" ref={ref} aria-label="编辑编导提示词" onCancel={e=>{e.preventDefault();if(!busy)close();}}><header><h2>编辑编导提示词</h2><button disabled={busy} onClick={close}>关闭</button></header>
 <small>{draft.promptKey} · {version}</small><label>名称<input value={draft.name} onChange={e=>change({...draft,name:e.target.value})}/></label>
 <label>提示词正文<textarea rows={14} value={draft.content} onChange={e=>change({...draft,content:e.target.value})}/></label>
 <label>变更说明<input value={draft.changeNote} onChange={e=>change({...draft,changeNote:e.target.value})}/></label><footer><button disabled={busy||!draft.content.trim()} onClick={save}>保存新版本</button><p role="status">{message}</p></footer></dialog>;
}
