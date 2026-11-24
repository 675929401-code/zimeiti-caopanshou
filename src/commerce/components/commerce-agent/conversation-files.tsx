'use client';
import {useEffect,useRef,useState} from 'react';
import {Download,FileText,List,PanelRight,Plus,X} from 'lucide-react';
import type {Conversation} from '../../server/jobs';
import type {UIAsset,UIJob} from './runtime-ui';
import {ScriptContent} from './script-content';

type ChatFile={id:string;name:string;kind:'文档'|'图片'|'视频'|'音频'|'文件';group:'输出'|'来源';url?:string;text?:string};
type FileTab={key:string;fileId?:string};
export function replyFilename(title:string,id:string){
  return (title.trim()||'会话回复').replace(/[\\/:*?"<>|]/g,'_').slice(0,75)+'-'+id.slice(0,8)+'.md';
}
export function isDocumentReply(title:string,request:string,text:string){
  return /(?:文档|markdown|\.md\b|导出)/i.test(request) || (/(?:拆解|分镜|分析报告|脚本)/.test(title+' '+request) && text.length>=250);
}
export function saveReply(filename:string,text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function collectFiles(conversation:Conversation|undefined,assets:UIAsset[],jobs:UIJob[]):ChatFile[]{
  if(!conversation)return [];
  const files=new Map<string,ChatFile>(),byId=new Map(assets.map(asset=>[asset.id,asset]));
  function add(id:string,group:ChatFile['group']){
    const asset=byId.get(id);
    if(!asset||files.has(id))return;
    const kind=asset.type.startsWith('image/')?'图片':asset.type.startsWith('video/')?'视频':asset.type.startsWith('audio/')?'音频':asset.type.startsWith('text/')||asset.type==='application/pdf'?'文档':'文件';
    files.set(id,{id,name:asset.name,group,kind,url:'/api/commerce/assets/'+encodeURIComponent(id)});
  }
  conversation.messages.forEach((m,i)=>{
    if(m.role==='assistant'&&isDocumentReply(conversation.title,conversation.messages[i-1]?.content||'',m.content)){
      const id='reply-'+m.id;
      files.set(id,{id,name:replyFilename(conversation.title,m.id),group:'输出',kind:'文档',text:m.content});
    }
    for(const id of m.assetIds||[])add(id,m.role==='assistant'?'输出':'来源');
  });
  for(const job of jobs.filter(j=>j.input.conversationId===conversation.id)){
    for(const assetId of job.assetIds)add(assetId,'输出');
    for(const ref of job.input.references||[])add(ref.id,'来源');
  }
  return [...files.values()];
}
export function useConversationFiles(conversation:Conversation|undefined,assets:UIAsset[],jobs:UIJob[]){
  const [summary,setSummary]=useState(false),[opened,setOpened]=useState(false);
  const [tabs,setTabs]=useState<FileTab[]>([{key:'start'}]),[active,setActive]=useState('start');
  const menu=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{setSummary(false);setOpened(false);setTabs([{key:'start'}]);setActive('start');},[conversation?.id]);
  useEffect(()=>{
    if(!summary&&!opened)return;
    function outside(e:PointerEvent){if(!menu.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setSummary(false);}
    function escape(e:KeyboardEvent){if(e.key!=='Escape')return;if(summary){setSummary(false);trigger.current?.focus();}else setOpened(false);}
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[summary,opened]);
  const files=collectFiles(conversation,assets,jobs);
  const current=files.find(f=>f.id===tabs.find(t=>t.key===active)?.fileId);
  function preview(id:string){
    setSummary(false);setOpened(true);
    const existing=tabs.find(tab=>tab.fileId===id);
    if(existing){setActive(existing.key);return;}
    if(tabs.some(tab=>tab.key===active&&!tab.fileId)){setTabs(prev=>prev.map(t=>t.key===active?{...t,fileId:id}:t));return;}
    const key=crypto.randomUUID();setTabs(prev=>[...prev,{key,fileId:id}]);setActive(key);
  }
  function closeTab(key:string){
    const rest=tabs.filter(t=>t.key!==key);
    if(!rest.length){setTabs([{key:'start'}]);setActive('start');}
    else {setTabs(rest);if(active===key)setActive(rest.at(-1)!.key);}
  }
  const panelToggle=<button type="button" aria-label={opened?'关闭文件侧栏':'打开侧栏'} aria-expanded={opened} onClick={()=>{setSummary(false);setOpened(v=>!v);}}><PanelRight size={17}/></button>;
  const toolbar=<><button type="button" ref={trigger} aria-label="查看摘要" aria-expanded={summary} onClick={()=>setSummary(v=>!v)}><List size={17}/></button>{panelToggle}
    {summary&&<div ref={menu} className="cs-conversation-summary" role="dialog" aria-label="会话文件摘要">
    {(['输出','来源'] as const).map(group=><section key={group}><h3>{group}</h3>{files.some(f=>f.group===group)?files.filter(f=>f.group===group).map(f=><button type="button" key={f.id} aria-label={'预览'+f.name} onClick={()=>preview(f.id)}><span>{f.name}</span><small>{f.kind}</small></button>):<small>暂无{group}文件</small>}</section>)}</div>}</>;
  const sidebar=opened&&<aside className="cs-conversation-files" aria-label="聊天文件侧栏"><header><div role="tablist" aria-label="文件标签">
    {tabs.map(t=>{const name=files.find(f=>f.id===t.fileId)?.name||'新标签页';return <div key={t.key}><button role="tab" aria-selected={active===t.key} onClick={()=>setActive(t.key)}>{name}</button><button aria-label={'关闭'+name} onClick={()=>closeTab(t.key)}><X size={12}/></button></div>})}</div>
    <button aria-label="新建标签" onClick={()=>{const key=crypto.randomUUID();setTabs(v=>[...v,{key}]);setActive(key);}}><Plus size={16}/></button><button aria-label="关闭侧栏" onClick={()=>setOpened(false)}><PanelRight size={16}/></button></header>
    {current?<section className="cs-chat-file-preview"><header><strong>{current.name}</strong>{current.text!==undefined?<button onClick={()=>saveReply(current.name,current.text!)}><Download size={14}/>下载</button>:<a href={current.url+'?download=1'} download={current.name}><Download size={14}/>下载</a>}</header>
      {current.text!==undefined?<ScriptContent text={current.text}/>:current.kind==='图片'?<img src={current.url} alt={current.name}/>:current.kind==='视频'?<video controls src={current.url}/>:current.kind==='音频'?<audio controls src={current.url}/>:<p>{current.name} 可下载查看。</p>}</section>:
      <section><h3>聊天中的文件</h3><div className="cs-chat-file-grid">{files.map(f=><button key={f.id} aria-label={'预览'+f.name} onClick={()=>preview(f.id)}>{f.kind==='图片'?<img src={f.url} alt=""/>:f.kind==='视频'?<video aria-hidden="true" preload="metadata" src={f.url}/>:<FileText size={28}/>}<span>{f.name}</span></button>)}</div>{!files.length&&<p>你发送和聊天中生成的文件会显示在这里。</p>}</section>}</aside>;
  return {toolbar,panelToggle,sidebar,preview};
}