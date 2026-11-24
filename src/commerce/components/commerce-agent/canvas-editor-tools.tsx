'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useReactFlow} from '@xyflow/react';
import {Plus,MousePointer2,Hand,Clapperboard,PanelsTopLeft,History,CircleHelp,Map,LayoutGrid,Sun,Moon,Minus,FileText,Image as Photo,Video,Music,FolderOpen,Download,X,ArrowRight,ArrowUp,Minimize2,Maximize2,Sparkles} from 'lucide-react';
import {type Runtime,type UIAsset} from './runtime-ui';
import {UserPromptLibrary} from './user-prompt-library';
import type {CanvasNodeData} from '../../shared/canvas-schema';
type Kind=CanvasNodeData['kind'];
type Panel='add'|'templates'|'history'|'help'|'';
type Props={id:string;busy:boolean;pan:boolean;setPan:(value:boolean)=>void;map:boolean;setMap:(value:boolean)=>void;dark:boolean;setDark:(value:boolean)=>void;zoom:number;arrange:()=>void;add:(kind:Kind)=>void;picker:()=>void;editor:()=>void;templates:ReactNode;assets:UIAsset[];useAsset:(a:UIAsset)=>void;canAdd:boolean};
const nodeTypes=[['text','文本',FileText],['image','图片',Photo],['video','视频',Video],['audio','音频',Music]] as const;
export function CanvasEditorTools(p:Props){
 const [panel,show]=useState<Panel>(''),root=useRef<HTMLDivElement>(null),flow=useReactFlow();
 useEffect(()=>{show('');},[p.id]);
 useEffect(()=>{if(!panel)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))show('');};const key=(e:KeyboardEvent)=>{if(e.key==='Escape')show('');};document.addEventListener('pointerdown',close);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key);};},[panel]);
 const toggle=(v:Panel)=>show(panel===v?'':v);
 return <div ref={root} className="cc-tools">
 <nav className="cc-dock" aria-label="画布工具"><button title="添加节点" aria-expanded={panel==='add'} disabled={!p.canAdd} onClick={()=>toggle('add')}><Plus/></button><hr/>
 <button title="鼠标工具" aria-pressed={!p.pan} onClick={()=>{p.setPan(false);show('');}}><MousePointer2/></button><button title="抓手工具" aria-pressed={p.pan} onClick={()=>{p.setPan(true);show('');}}><Hand/></button>
 <button aria-label="剪辑" onClick={p.editor}><Clapperboard/><small>剪辑</small></button><button aria-label="模版" aria-expanded={panel==='templates'} onClick={()=>toggle('templates')}><PanelsTopLeft/><small>模版</small></button><button aria-label="历史" aria-expanded={panel==='history'} onClick={()=>toggle('history')}><History/><small>历史</small></button><hr/>
 <button aria-label="帮助" aria-expanded={panel==='help'} onClick={()=>toggle('help')}><CircleHelp/><small>帮助</small></button></nav>
 {panel==='add'&&<section className="cc-flyout cc-add" aria-label="添加节点菜单"><strong>添加节点</strong>{nodeTypes.map(([kind,name,Icon])=><button disabled={!p.canAdd} key={kind} onClick={()=>{p.add(kind);show('');}}><Icon/>{name}</button>)}<hr/><button onClick={()=>{p.picker();show('');}}><FolderOpen/>从资产库选择</button></section>}
 {panel==='templates'&&<section className="cc-flyout cc-templates" aria-label="画布模版"><header>模版<button aria-label="关闭模版" onClick={()=>show('')}><X/></button></header>{p.templates}</section>}
 {panel==='help'&&<section className="cc-flyout cc-help" aria-label="画布帮助"><header>画布帮助<button aria-label="关闭帮助" onClick={()=>show('')}><X/></button></header><p>点「＋」添加节点。拖动右侧连接点到下一个节点的左侧连接点，将文字或素材传给下一步。</p><p>鼠标工具用来选中和移动节点，抓手工具用来平移画布。Shift 可多选，Ctrl + Z 撤销编辑。</p><a href="/commerce/help" target="_blank" rel="noreferrer">使用教程</a></section>}
 {panel==='history'&&<CanvasAssetHistory assets={p.assets} close={()=>show('')} use={asset=>{p.useAsset(asset);show('');}}/>}
 <nav className="cc-view" aria-label="画布视图"><button title="小地图" aria-pressed={p.map} onClick={()=>p.setMap(!p.map)}><Map/></button><button title="自动整理卡片" disabled={p.busy} onClick={p.arrange}><LayoutGrid/></button><button title={p.dark?'深色模式':'浅色模式'} aria-pressed={p.dark} onClick={()=>p.setDark(!p.dark)}>{p.dark?<Moon/>:<Sun/>}</button><i/><button title="缩小" disabled={p.zoom<=.1} onClick={()=>void flow.zoomOut()}><Minus/></button><output>{Math.round(p.zoom*100)}%</output><button title="放大" disabled={p.zoom>=4} onClick={()=>void flow.zoomIn()}><Plus/></button><button title="重置" onClick={()=>void flow.setViewport({x:0,y:0,zoom:1})}>重置</button></nav></div>;
}
function CanvasAssetHistory({assets,close,use}:{assets:UIAsset[];close:()=>void;use:(a:UIAsset)=>void}){
 const [type,setType]=useState<'image'|'video'>('image'),[desc,setDesc]=useState(true),[size,resize]=useState(160),[preview,setPreview]=useState<UIAsset|null>(null);
 const list=assets.filter(a=>a.type.startsWith(type+'/')).sort((a,b)=>(a.createdAt-b.createdAt)*(desc?-1:1));
 return <section role="dialog" aria-label="历史资产" className="cc-asset-history"><header>历史资产<div><button title="缩小素材卡片" disabled={size<=120} onClick={()=>resize(size-20)}><Minus/></button><button title="放大素材卡片" disabled={size>=260} onClick={()=>resize(size+20)}><Plus/></button><button title="关闭历史资产" onClick={close}><X/></button></div></header><nav>{(['image','video'] as const).map(k=><button aria-pressed={k===type} key={k} onClick={()=>{setType(k);setPreview(null);}}>{k==='image'?'图片历史':'视频历史'}</button>)}<button onClick={()=>setDesc(!desc)}>时间{desc?'降':'升'}序</button></nav>
 {preview?<div className="cc-asset-preview"><button onClick={()=>setPreview(null)}>返回历史资产</button>{preview.type.startsWith('video/')?<video src={preview.url} controls/>:<img src={preview.url} alt={preview.name}/>}</div>:<div className="cc-asset-list" style={{gridTemplateColumns:'repeat(auto-fill,minmax('+size+'px,1fr))'}}>{list.map(a=><article key={a.id}>{type==='video'?<video src={a.url} preload="metadata" muted/>:<img loading="lazy" src={a.url} alt={a.name}/>}<strong>{a.name}</strong><footer><button onClick={()=>setPreview(a)}>查看</button><button onClick={()=>use(a)}>使用</button><a href={'/api/commerce/assets/'+encodeURIComponent(a.id)+'?download=1'} download aria-label={'下载 '+a.name}><Download/></a></footer></article>)}{!list.length&&<p>暂无{type==='image'?'图片':'视频'}历史</p>}</div>}</section>;
}
export function CanvasConversation({id,ownerKey,runtime,context,close,insert}:{id:string;ownerKey:string;runtime:Runtime;context:string;close:()=>void;insert:(text:string)=>void}){
 const storageKey=ownerKey+':canvas-chat:'+id;
 const [thread,setThread]=useState(id),[threads,setThreads]=useState<string[]>([id]),[history,setHistory]=useState(false),[expanded,setExpanded]=useState(false);
 const [text,setText]=useState(''),[issue,setIssue]=useState(''),[sending,setSending]=useState(false);
 const input=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{try{const data=JSON.parse(localStorage.getItem(storageKey)||'null');if(!data||!Array.isArray(data.ids))return;
  const known:string[]=data.ids.filter((i:unknown)=>typeof i==='string'&&/^[a-f0-9-]{36}$/i.test(i));if(!known.includes(id))known.push(id);
  setThreads(known);setThread(known.includes(data.last)?data.last:id);}catch{}},[storageKey,id]);
 const conversation=runtime.conversations.find(c=>c.id===thread),messages=conversation?.messages||[];
 function openThread(value:string){const ids=Array.from(new Set([value,...threads]));setThreads(ids);setThread(value);setHistory(false);setText('');setIssue('');setExpanded(false);
  try{localStorage.setItem(storageKey,JSON.stringify({ids,last:value}));}catch{}
 }
 async function send(){if(sending||!text.trim())return;setIssue('');setSending(true);
  try{const prompt=[text.trim(),context&&'当前画布内容：\n'+context].filter(Boolean).join('\n\n');await runtime.submit({kind:'agent',conversationId:thread,purpose:'agent',prompt});setText('');}catch(e){setIssue((e as Error).message);}finally{setSending(false);}
 }
 return <aside className="cc-chat" aria-label="画布对话"><header><strong>{conversation?.title||'新对话'}</strong><button disabled={sending} aria-label="新建对话" onClick={()=>{if(messages.length||text.trim())openThread(crypto.randomUUID());else input.current?.focus();}}><Plus/>新建</button><button aria-label="历史对话" aria-expanded={history} onClick={()=>setHistory(!history)}><History/>历史</button><button title="收起对话" onClick={close}><ArrowRight/></button></header>
 {history&&<div className="cc-chat-history" aria-label="本画布历史对话">{runtime.conversations.filter(c=>threads.includes(c.id)).map(c=><button disabled={sending} key={c.id} onClick={()=>openThread(c.id)}>{c.title}</button>)}{!runtime.conversations.some(c=>threads.includes(c.id))&&<p>本画布暂无历史对话</p>}</div>}
 <section className={messages.length?'cc-chat-messages':'cc-chat-welcome'}>{messages.length?messages.map(m=><article key={m.id}><b>{m.role==='user'?'我':'编导'}</b><p>{m.content}</p>{m.role==='assistant'&&<button onClick={()=>insert(m.content)}>加入文本节点</button>}</article>):<div><h3>试试这些 AI 技能</h3><nav>{[['素材分析',Sparkles],['视频拆解',LayoutGrid],['视频脚本',Video]].map(([label,icon])=>{const Icon=icon as typeof Video,name=String(label);return <button key={name} onClick={()=>{setText(name+'：'+text);input.current?.focus();}}><Icon/>{name}</button>;})}</nav></div>}</section>
 <div className={'cc-chat-compose'+(expanded?' expanded':'')}><textarea ref={input} aria-label="画布对话要求" value={text} onChange={e=>setText(e.target.value)} placeholder="输入消息，描述你要处理的画布内容…"/><div className="cc-compose-tools"><button title={expanded?'收起输入':'展开输入'} onClick={()=>setExpanded(!expanded)}>{expanded?<Minimize2/>:<Maximize2/>}</button><UserPromptLibrary ownerKey={ownerKey} capture={async()=>({prompt_text:text,context_type:'canvas-chat',source_type:'canvas',metadata_json:{},reference_elements_json:[]})} onApply={item=>setText(item.prompt_text)} onNotice={runtime.notice}/></div><footer><button title="发送" aria-label="发送" disabled={!runtime.ready||sending||runtime.sending||!text.trim()} onClick={()=>void send()}><ArrowUp/></button></footer>{issue&&<p role="alert">{issue}</p>}</div></aside>;
}
