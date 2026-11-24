'use client';
import {isMemberChatSkill,memberChatHint} from '@/commerce/shared/member-chat-skills';
import {isDubSkill} from '@/commerce/shared/dubbing';
import {DubbingAction} from '@/features/commerce-studio/dubbing-action';
import {SocialVideoAction} from '@/features/commerce-studio/social-video-action';
import {isSocialVideoSkill} from '@/commerce/shared/social-video';
import {RemotionAction} from '@/features/commerce-studio/remotion-action';
import {CaptionAction,TranslatedSubtitles} from '@/features/commerce-studio/caption-action';
import {MemberDocumentAction} from '@/features/commerce-studio/member-document-action';
import {isMemberDocumentSkill} from '@/commerce/shared/member-documents';
import {HtmlReplyDownload} from '@/features/commerce-studio/html-reply-download';
import {PdfPagesAction} from '@/features/commerce-studio/pdf-pages-action';
import {isVideoProductionSkill} from '@/commerce/shared/member-video-production';
import {VideoFileSkill} from '@/features/commerce-studio/video-file-skill';
import {SlidesAction} from '@/features/commerce-studio/slides-action';
import {WechatArticleAction} from '@/features/commerce-studio/wechat-article-action';
import {MarkdownWordAction} from '@/features/commerce-studio/markdown-word-action';
import {AnchoredPanel} from './reference-ui';
import {Mic,Blocks,ChevronRight} from 'lucide-react';
import './member-chat-layout.css';
import {AgentExecution} from './agent-execution';
import {ComposerAddMenu} from '@/features/commerce-studio/composer-add-menu';
import type {MemberSkill, SkillLibrary} from '@/features/commerce-studio/member-skills';
import {useConversationFiles,isDocumentReply,replyFilename,saveReply} from './conversation-files';
import {ScriptContent} from './script-content';
import {ImageRevision} from './image-revision';
import {planText} from '../../server/agent-plan-schema';
import './agent-execution.css';
import {useState,useEffect,useCallback,useRef} from 'react';
import {ArrowUp,Plus,Heart,Download,RotateCcw,Trash2,Image as ImageIcon,Video,MessageSquare,PanelLeft,Copy,Play,FolderOpen,Search,LoaderCircle,ExternalLink,SquarePen} from 'lucide-react';
import type {JobInput,Conversation} from '../../server/jobs';
export type UIJob={id:string;input:Omit<JobInput,'modelId'>&{modelId?:string};status:string;createdAt:number;updatedAt:number;model:{id?:string;displayName:string;publicPrice:number};text?:string;error?:string;assetIds:string[];providerTaskId?:string;billing?:{status:string;amount:number;updatedAt:number;balanceAfter?:number;lastError?:string;retryCount?:number};billingError?:string;billingRetries?:number;};
export type UIAsset={collection?:'assets'|'roles';id:string;name:string;type:string;size:number;createdAt:number;source:string;jobId?:string;url:string;};
export async function api<T=Record<string,unknown>>(url:string,body?:unknown,method?:string):Promise<T>{
 const requestMethod=method||(body?'POST':'GET'),attempts=requestMethod==='GET'?3:1;
 for(let attempt=0;attempt<attempts;attempt++){
  let response:Response;
  try{response=await fetch(url,{method:requestMethod,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),cache:'no-store'});}
  catch(error){if(attempt+1>=attempts)throw error;await new Promise(resolve=>setTimeout(resolve,attempt===0?350:900));continue;}
  let data:Record<string,unknown>;
  try{data=await response.json();}
  catch(error){if(attempt+1>=attempts)throw error;await new Promise(resolve=>setTimeout(resolve,attempt===0?350:900));continue;}
  if(response.ok)return data as T;
  if(response.status===429&&requestMethod==='GET'&&attempt+1<attempts){
   const seconds=Number(response.headers.get('Retry-After')||data.retryAfter||2);
   await new Promise(resolve=>setTimeout(resolve,(Number.isFinite(seconds)?Math.min(60,Math.max(1,seconds)):2)*1000+200));continue;
  }
  if(response.status>=500&&attempt+1<attempts){await new Promise(resolve=>setTimeout(resolve,attempt===0?350:900));continue;}
  throw Error(String(data.error||`请求失败 (${response.status})`));
 }
 throw Error('请求失败');
}
export const statusLabel:Record<string,string>={queued:'排队中',running:'生成中',processing:'生成中',saving:'保存中',succeeded:'已完成',failed:'生成失败',unknown:'待核对',save_failed:'结果待保存'};
export function useRuntime(onNotice:(text:string)=>void){
 const [ready,setReady]=useState(false),[allJobs,setJobs]=useState<UIJob[]>([]),[conversations,setConversations]=useState<Conversation[]>([]),[assets,setAssets]=useState<UIAsset[]>([]),[sending,setSending]=useState(false);
 type PendingQuote={id:string;submissionHold?:string;inputFingerprint:string;model:{id?:string;displayName:string};billingUnit:string;quantity:number;unitPrice:number;payableTotal:number;currency:'CNY';expiresAt:number};
 const refreshSequence=useRef(0);const requestKey=useRef<{key:string;fingerprint:string;quote?:PendingQuote}|null>(null);const submitting=useRef(false);
 const inFlight=useRef(0);
 const refresh=useCallback(async()=>{
  const sequence=++refreshSequence.current;
  inFlight.current++;
  try {
   await Promise.allSettled([
    api<{jobs:UIJob[]}>('/api/commerce/jobs').then(data=>{if(sequence===refreshSequence.current)setJobs(data.jobs);}),
    api<{conversations:Conversation[]}>('/api/commerce/conversations').then(data=>{if(sequence===refreshSequence.current)setConversations(data.conversations);}),
    api<{assets:UIAsset[]}>('/api/commerce/assets').then(data=>{if(sequence===refreshSequence.current)setAssets(data.assets);}),
   ]);
  } finally {inFlight.current--;}
 },[]);
 // WorkspaceIdentity mounted this account-specific body after validating the member.
 useEffect(()=>{setReady(true);void refresh();return()=>{refreshSequence.current++;};},[refresh]);
 useEffect(()=>{if(!ready)return;const timer=setInterval(()=>{if(!activeIdsRef.current&&!inFlight.current)void refresh();},15000);return()=>clearInterval(timer);},[ready,refresh]);
 const activeIds=allJobs.filter(j=>['queued','running','processing'].includes(j.status)).map(j=>j.id).sort().join(',');const activeIdsRef=useRef('');activeIdsRef.current=activeIds;
 useEffect(()=>{if(!ready||!activeIds)return;const streams=activeIds.split(',').map(id=>{const source=new EventSource('/api/commerce/jobs/events?id='+encodeURIComponent(id));source.addEventListener('job',event=>{const value=JSON.parse((event as MessageEvent).data) as UIJob;setJobs(current=>[value,...current.filter(j=>j.id!==value.id)].sort((a,b)=>b.createdAt-a.createdAt));if(['succeeded','failed','save_failed'].includes(value.status)){source.close();void refresh();}});return source;});return()=>streams.forEach(source=>source.close());},[activeIds,ready,refresh]);
 const upload=useCallback(async(file:File)=>{await api('/api/commerce/session');const form=new FormData();form.append('file',file);const response=await fetch('/api/commerce/assets',{method:'POST',body:form});const data=await response.json();if(!response.ok)throw Error(data.error||'素材上传失败');await refresh();setAssets(current=>[data.asset,...current.filter(a=>a.id!==data.asset.id)]);return data.asset as UIAsset;},[refresh]);
 const submit=useCallback(async(input:Omit<JobInput,'requestId'|'modelId'>&{modelId?:string})=>{
  if(submitting.current)throw Error('任务正在提交');
  if(!ready)throw Error('主站带货工作台尚未连接');
  submitting.current=true;setSending(true);
  const fingerprint=JSON.stringify(input);
  if(!requestKey.current||requestKey.current.fingerprint!==fingerprint)requestKey.current={key:crypto.randomUUID(),fingerprint};
  try{
   if(!requestKey.current.quote){
    const response=await api<{quote:PendingQuote}>('/api/commerce/quotes',input);
    if(response.quote.submissionHold){requestKey.current=null;throw Error(response.quote.submissionHold);}
    requestKey.current.quote=response.quote;
   }
   const quote=requestKey.current.quote;
   const result=await api<{job:UIJob}>('/api/commerce/jobs',{quoteId:quote.id,clientRequestId:requestKey.current.key,inputFingerprint:quote.inputFingerprint});
   requestKey.current=null;
   setJobs(current=>[result.job,...current.filter(j=>j.id!==result.job.id)]);
   await refresh();return result.job;
  }catch(error){
   const message=error instanceof Error?error.message:'';
   if(requestKey.current?.fingerprint===fingerprint&&/重新报价|报价已过期/.test(message))requestKey.current={key:crypto.randomUUID(),fingerprint};
   throw error;
  }finally{submitting.current=false;setSending(false);}
 },[ready,refresh]);
 return {ready,jobs:allJobs,conversations,assets,sending,refresh,upload,submit,notice:onNotice};
}
export type Runtime=ReturnType<typeof useRuntime>;
function RollingRetake({jobId,segments,onNotice}:{jobId:string;segments:number[];onNotice:(s:string)=>void}){
  const [busy,setBusy]=useState(-1);
  return <div style={{display:'flex',gap:6,flexWrap:'wrap',margin:'8px 0'}}>
    {segments.map((s,i)=><button key={i} disabled={busy>=0} onClick={async()=>{setBusy(i);try{await api('/api/commerce/jobs',{action:'rolling-retake',id:jobId,segment:i});onNotice('第 '+(i+1)+' 段重拍完成，成片已重新拼接');}catch(e){onNotice((e as Error).message);}finally{setBusy(-1);}}}>{busy===i?('重拍第'+(i+1)+'段中…'):('重拍第'+(i+1)+'段')}</button>)}
  </div>;
}
export function TaskPreview({job,onReuse,onRetry,favorite,onFavorite,onNotice}:{onNotice:(s:string)=>void;favorite?:boolean;onFavorite?:()=>void;job?:UIJob;onReuse:(job:UIJob)=>void;onRetry:()=>void}){return <div className="ca-result-view">{job?<><div className="ca-result-heading"><span className={`ca-job-status ca-job-${job.status}`}>{statusLabel[job.status]}</span><span>{job.model.displayName}</span><button onClick={onFavorite}><Heart size={14} fill={favorite?'currentColor':'none'}/>{favorite?'已收藏':'收藏'}</button><button onClick={()=>onReuse(job)}><RotateCcw size={14}/>再次编辑</button></div>{job.assetIds.length?<div className="ca-result-media">{job.assetIds.map(id=><div key={id}>{job.input.kind==='image'?<img src={`/api/commerce/assets/${id}`} alt="生成结果"/>:<video src={`/api/commerce/assets/${id}`} controls playsInline/>}<a href={`/api/commerce/assets/${id}?download=1`}><Download size={16}/>下载原文件</a></div>)}</div>:job.text?<ScriptContent text={job.text}/>:<div className="ca-execution-empty">{['running','queued','processing','saving'].includes(job.status)?<LoaderCircle className="ca-spin" size={32}/>:<Video size={32}/>}<strong>{statusLabel[job.status]}</strong><p>{job.error||'任务已保存，可以切换页面。结果会出现在任务队列和资产中。'}</p>{job.status==='unknown'&&<p>正在查询原任务；不会自动重复生成。</p>}{job.status==='save_failed'&&<button onClick={onRetry}>重试保存原结果</button>}</div>}{job.input.kind==='image'&&job.status==='succeeded'&&<ImageRevision key={job.id} jobId={job.id} onNotice={onNotice}/>}{job.input.rollingPlan&&job.status==='succeeded'&&<RollingRetake jobId={job.id} segments={job.input.rollingPlan.segments} onNotice={onNotice}/>}<footer><span>任务 {job.id.slice(0,8)}</span>{job.providerTaskId&&<span>上游 {job.providerTaskId}</span>}<span>{new Date(job.createdAt).toLocaleString('zh-CN')}</span></footer></>:<div className="ca-execution-empty"><Video size={32}/><p>点击右侧队列中带成片的任务即可预览</p></div>}</div>;}
export function TaskQueue({jobs,selected,onSelect,onClose,editing,drafts=[],selectedDraft,onSelectDraft,onRemoveDrafts}:{
  drafts?:{id:string;title:string;createdAt:number;number?:number}[];selectedDraft?:string;onSelectDraft?:(id:string)=>void;onRemoveDrafts?:(ids:string[])=>void;
  jobs:UIJob[];selected:string;onSelect:(id:string)=>void;onClose:()=>void;editing?:{selected:boolean;onSelect:()=>void}
}){
  return <aside className="ca-task-queue"><div className="cs-queue-heading">
    <button type="button" aria-label="收起最近任务" onClick={onClose}>最近 <ChevronRight size={12} aria-hidden="true"/></button>
    <button type="button" disabled={!drafts.length} onClick={()=>onRemoveDrafts?.(drafts.map(draft=>draft.id))}>清空草稿</button>
  </div>{jobs.some(j=>['queued','running','processing','saving'].includes(j.status))&&<div className="ca-queue-counts"><span>排队中<strong>{jobs.filter(j=>j.status==='queued').length}</strong></span><span>生成中<strong>{jobs.filter(j=>['running','processing','saving'].includes(j.status)).length}</strong></span></div>}{editing&&<button className={`ca-queue-card ${editing.selected?'active':''}`} aria-label="编辑中，返回当前草稿" aria-pressed={editing.selected} onClick={editing.onSelect}><span><SquarePen size={23}/></span><div><strong>编辑中</strong><small>当前创作</small></div></button>}{drafts.map(draft=><div className="cs-recent-draft" key={draft.id} data-active={selectedDraft===draft.id||undefined}>
    <button type="button" className="cs-draft-open" aria-label={'恢复草稿 '+draft.title} aria-pressed={selectedDraft===draft.id} onClick={()=>onSelectDraft?.(draft.id)}>
      <span><SquarePen size={20}/></span><div><strong>{'草稿('+draft.number+')'}</strong>{Number.isFinite(new Date(draft.createdAt).getTime())&&<time dateTime={new Date(draft.createdAt).toISOString()}>{new Date(draft.createdAt).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})}<br/>{new Date(draft.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>}</div>
    </button><button type="button" className="cs-draft-remove" aria-label={'删除草稿 '+draft.title} onClick={()=>onRemoveDrafts?.([draft.id])}><Trash2 size={13}/></button>
  </div>)}{jobs.map(j=><button key={j.id} className={`ca-queue-card ${selected===j.id?'active':''}`} onClick={()=>onSelect(j.id)}><span>{j.assetIds[0]?(j.input.kind==='image'?<img loading="lazy" decoding="async" src={`/api/commerce/assets/${j.assetIds[0]}`} alt="任务缩略图"/>:<Video size={24}/>):j.input.kind==='image'?<ImageIcon size={23}/>:<Video size={23}/>}</span><div><strong>{j.input.prompt.slice(0,22)||j.input.skillId}</strong><small>{statusLabel[j.status]}</small><em>{new Date(j.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</em></div></button>)}{!jobs.length&&!drafts.length&&!editing&&<p className="ca-queue-empty">还没有生成任务</p>}</aside>;}

function ReplyDocument({title,id,text,request,preview}:{title:string;id:string;text:string;request:string;preview:()=>void}){
  const filename=replyFilename(title,id);
  const download=()=>saveReply(filename,text);
  const isDocument=isDocumentReply(title,request,text);
  if(!isDocument)return <button type="button" className="cs-chat-text-export" onClick={download} aria-label="下载回复"><Download size={13}/>下载回复</button>;
  return <div className="cs-reply-document"><span aria-hidden="true">M</span><button className="cs-reply-file-name" type="button" aria-label={'预览'+filename} title={filename} onClick={preview}>{filename}</button><button type="button" onClick={download} aria-label="下载回复"><Download size={14}/>下载</button></div>;
}
export function ChatPanel({runtime,prompt,setPrompt,modelSelect,onSend,materials,onNew,onUse,conversationId,setConversationId,compact=false,onSkills,onSaveSkill,onConnectors,chooseSkill,loadLibrary,onAttach,onUpload,onMic,listening,selectedSkill,removeSkill,openSkillWorkspace}:{selectedSkill?:MemberSkill;removeSkill?:()=>void;openSkillWorkspace?:(path:string)=>void;onConnectors?:(name:string)=>void;chooseSkill?:(skill:MemberSkill)=>void;loadLibrary?:()=>Promise<SkillLibrary>;onAttach?:()=>void;onUpload?:()=>void;onMic?:()=>void;listening?:boolean;onSkills?:()=>void;onSaveSkill?:(text:string)=>void;runtime:Runtime;prompt:string;setPrompt:(s:string)=>void;modelSelect:React.ReactNode;onSend:()=>void;materials:React.ReactNode;onNew:()=>void;onUse:(text:string,kind:'image'|'video'|'canvas')=>void;conversationId:string;setConversationId:(s:string)=>void;compact?:boolean}){
 const [attachMenu,setAttachMenu]=useState(false);

 const [collapsed,setCollapsed]=useState(false);const end=useRef<HTMLDivElement>(null);const conversation=runtime.conversations.find(c=>c.id===conversationId);const pending=runtime.jobs.find(j=>j.input.conversationId===conversationId&&['queued','running','processing','unknown'].includes(j.status));
 useEffect(()=>{end.current?.scrollIntoView({block:'end'});},[conversation?.messages.length,pending?.status,pending?.text]);
 const memberChat=!!onSkills&&!compact;
 const files=useConversationFiles(memberChat?conversation:undefined,runtime.assets,runtime.jobs);
 const empty=memberChat&&!conversation?.messages.length&&!runtime.jobs.some(j=>j.input.conversationId===conversationId);
 return <div className={`ca-conversation ${memberChat?'cs-member-chat':''} ${empty?'cs-chat-empty':''} ${compact?'ca-conversation-compact':''} ${collapsed?'ca-history-collapsed':''}`}>{!compact&&!collapsed&&<aside className="ca-chat-history"><header>{memberChat?'Agent':'历史对话'}<button title="收起历史对话" onClick={()=>setCollapsed(true)}><PanelLeft size={17}/></button></header><button className="ca-chat-new" onClick={onNew}><SquarePen size={16}/><span>{memberChat?'新任务':'新对话'}</span></button>{onSkills&&<><button onClick={onSkills}><Copy size={16}/><span>技能·连接器</span></button><h3>最近</h3></>}{runtime.conversations.map(c=><button key={c.id} className={c.id===conversationId?'active':''} onClick={()=>setConversationId(c.id)}><MessageSquare size={14}/><span>{c.title}</span></button>)}</aside>}<section className="ca-chat-main">{memberChat&&<header className="cs-chat-thread-head">{empty?files.panelToggle:<><strong>{conversation?.title||'当前会话'}</strong>{files.toolbar}</>}</header>}{!compact&&collapsed&&<button className="ca-history-toggle" onClick={()=>setCollapsed(false)}>展开历史对话</button>}{empty&&<h1 className="cs-chat-heading">今天想做点什么？</h1>}<div className="ca-messages">{conversation?.messages.map((m,index)=><article key={m.id} id={'cs-chat-'+m.id} className={`ca-chat-message ca-message-${m.role}`}>{m.role==='assistant'?<><ScriptContent text={planText(m.content)}/><HtmlReplyDownload text={m.content} id={m.id}/><TranslatedSubtitles request={conversation.messages[index-1]?.content||''} text={m.content} apply={selectedSkill&&(selectedSkill.id==='subtitle-translate'||isDubSkill(selectedSkill.id))?s=>window.dispatchEvent(new CustomEvent('commerce-translated-captions',{detail:{thread:conversationId,srt:s}})):undefined}/></>:<div className="ca-message-text">{m.content}</div>}{!!m.assetIds?.length&&<div className="ca-chat-attachments">{m.assetIds.map(id=>{const asset=runtime.assets.find(item=>item.id===id),url='/api/commerce/assets/'+encodeURIComponent(id);return asset?.type.startsWith('image/')?<img key={id} src={url} alt={asset.name}/>:<a key={id} href={url+'?download=1'} download={asset?.name||true}>{asset?.name||'下载附件'}</a>;})}</div>}{m.role==='assistant'&&m.jobId&&(()=>{const billed=runtime.jobs.find(j=>j.id===m.jobId)?.billing;return billed&&(billed.status==='charged'||billed.status==='revenue_recorded'||billed.status==='refunded')&&billed.amount>0?<small role="note" className={'ca-message-cost'+(billed.status==='refunded'?' is-refunded':'')}>{billed.status==='refunded'?'已退款':'已消耗'} ¥{billed.amount.toFixed(2)}</small>:null})()}{m.role==='assistant'&&<div className="ca-message-actions"><button onClick={()=>void navigator.clipboard.writeText(m.content)}><Copy size={13}/>复制</button><button onClick={()=>onUse(m.content,compact?'video':'image')}>{compact?'应用到视频提示词':'用于图片'}</button>{!compact&&<><button onClick={()=>onUse(m.content,'video')}>用于视频</button><button onClick={()=>onUse(m.content,'canvas')}>放入画布</button>{onSaveSkill&&<button onClick={()=>onSaveSkill(m.content)}>保存为技能</button>}</>}</div>}{memberChat&&m.role==='assistant'&&m.content.trim()&&<ReplyDocument title={conversation?.title||'会话回复'} id={m.id} text={m.content} request={conversation.messages[index-1]?.role==='user'?conversation.messages[index-1].content:''} preview={()=>files.preview('reply-'+m.id)}/>}</article>)}{pending?.text&&<article className="ca-chat-message ca-message-assistant"><div className="ca-stream-text"><span>{pending.text.slice(0,Math.max(0,pending.text.length-50))}</span><span className="ca-stream-tail">{pending.text.slice(-50)}</span><span className="ca-stream-caret"/></div></article>}{pending&&<div className="ca-chat-pending"><LoaderCircle size={15} className="ca-spin"/>{pending.status==='unknown'?'正在核对原请求结果':'正在生成回复…'}</div>}{!compact&&<AgentExecution jobs={runtime.jobs} conversationId={conversationId} onNotice={runtime.notice}/>}<div ref={end}/></div>{memberChat&&!empty&&<small className="cs-chat-verification">AI生成可能有误 请核查重要信息</small>}<div className="ca-chat-composer"><div className="ca-chat-input">{selectedSkill&&<div className="cs-agent-skill-selection"><span><Blocks size={14}/>{selectedSkill.name}<button type="button" aria-label={'移除技能 '+selectedSkill.name} onClick={removeSkill}>×</button></span>{(isVideoProductionSkill(selectedSkill.id)||selectedSkill.id==='video-frame'||selectedSkill.id==='demux')?<VideoFileSkill key={conversationId+selectedSkill.id} runtime={runtime} skill={selectedSkill.id}/>:selectedSkill.id==='wechat-editor'?<WechatArticleAction key={conversationId}/>:selectedSkill.id==='slides'?<SlidesAction key={conversationId}/>:selectedSkill.id==='pdf-tools'?<PdfPagesAction key={conversationId}/>:selectedSkill.id==='markdown-docx'?<MarkdownWordAction key={conversationId} text={prompt} onText={setPrompt}/>:isDubSkill(selectedSkill.id)?<DubbingAction key={conversationId+selectedSkill.id} thread={conversationId} skill={selectedSkill.id} runtime={runtime} onTranslate={setPrompt}/>:isSocialVideoSkill(selectedSkill.id)?<SocialVideoAction key={conversationId+selectedSkill.id} skill={selectedSkill.id}/>:selectedSkill.id==='remotion'?<RemotionAction key={conversationId} runtime={runtime}/>: (selectedSkill.id==='captions'||selectedSkill.id==='subtitle-translate')?<CaptionAction key={conversationId+selectedSkill.id} thread={conversationId} runtime={runtime} translation={selectedSkill.id==='subtitle-translate'} onTranslate={setPrompt}/>:isMemberDocumentSkill(selectedSkill.id)?<MemberDocumentAction key={conversationId+selectedSkill.id} kind={selectedSkill.id} onAnalyze={sample=>setPrompt([prompt||'请分析下列工作表，指出可核对的统计结果和建议。',sample].join('\n\n'))}/>:isMemberChatSkill(selectedSkill.id)?<small>{memberChatHint(selectedSkill.id)}</small>:selectedSkill.route?<button type="button" onClick={()=>openSkillWorkspace?.(selectedSkill.route!)}>进入制作工作区</button>:<small role="status">此技能的执行功能尚未接入</small>}</div>}<div className="ca-hero-materials">{materials}</div><textarea aria-label={compact?'编导聊天输入':'Agent创作要求'} value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&(!selectedSkill||selectedSkill.route||isMemberChatSkill(selectedSkill.id))){e.preventDefault();if(runtime.ready&&!runtime.sending&&!pending&&prompt.trim())onSend();}}} placeholder={selectedSkill?.id==='markdown-docx'?'在此粘贴 Markdown 正文，或导入文件':memberChat?'描述你的想法':'结合参考、输入文字或 @ 主体，说说今天想做什么。'}/></div><div className="ca-composer-bottom">{memberChat&&<div className="cs-chat-attach"><button aria-label="添加素材、技能或连接器" aria-expanded={attachMenu} data-popover-trigger onClick={()=>setAttachMenu(v=>!v)}><Plus size={18}/></button>{attachMenu&&onUpload&&onAttach&&onSkills&&onConnectors&&chooseSkill&&loadLibrary&&<ComposerAddMenu close={()=>setAttachMenu(false)} upload={onUpload} assets={onAttach} manage={onSkills} loadLibrary={loadLibrary} pick={chooseSkill} connector={onConnectors}/>}</div>}{modelSelect}{memberChat&&<button className="cs-chat-mic" aria-label={listening?'停止语音输入':'语音输入'} aria-pressed={listening} onClick={onMic}><Mic size={17}/></button>}<button className="ca-send" title="发送消息" disabled={runtime.sending||!prompt.trim()||!!pending||!runtime.ready||!!selectedSkill&&!selectedSkill.route&&!isMemberChatSkill(selectedSkill.id)} onClick={onSend}><ArrowUp size={21}/></button></div></div></section>{memberChat&&files.sidebar}</div>;
}
