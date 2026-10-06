'use client';
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowUp,ChevronDown,Copy,LoaderCircle} from 'lucide-react';
import type {Runtime} from './runtime-ui';
import {ScriptContent} from './script-content';
import observed from './observed-catalog.json';
import {DIRECTOR_AUDIO_MAX_SECONDS,type DirectorApplication,type DirectorMessage,type DirectorPage,type DirectorReference,type DirectorSettings,type DirectorVideoSettings} from '../../server/director-conversation-schema';
import type {CommerceInputField} from '../../shared/configuration-types';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION} from '../../shared/video-generation-capabilities';
import './director-conversation.css';

export type DirectorPanelProps={
  runtime:Runtime;conversationId:string;prompt:string;setPrompt:(value:string)=>void;
  onSend:()=>void;onExit:()=>void;onUse:(text:string,jobId?:string)=>void;
  materials:ReactNode;hasMaterials:boolean;language:string;setLanguage:(value:string)=>void;
  duration:number;setDuration:(value:number)=>void;
  directorName?:string;getReferences?:()=>Promise<DirectorReference[]>;
  directorSpec?:{key:string;name:string;slots:{key:string;label:string}[];inputFields?:CommerceInputField[]};
  videoSettings?:DirectorVideoSettings;onApplied?:(value:DirectorApplication)=>void;
  setGenerateAudio?:(value:boolean)=>void;
};
type ResponseError=Error&{code?:string;status?:number};
async function request<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',signal});
  const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||'编导操作未完成'),{status:response.status,code:value.code});return value;
}
function mergeMessages(previous:DirectorMessage[],next:DirectorMessage[]){const rows=new Map(previous.map(m=>[m.id,m]));next.forEach(m=>rows.set(m.id,m));return [...rows.values()].sort((a,b)=>a.sequence-b.sequence);}
function referenceLabel(message:DirectorMessage,reference:DirectorReference,current?:DirectorPanelProps['directorSpec']){return (current?.key===message.settings.skillKey?current:undefined)?.slots.find(slot=>slot.key===reference.slot)?.label||observed.directors.find(d=>d.key===message.settings.skillKey)?.slots.find(slot=>slot.key===reference.slot)?.label||(reference.type?.startsWith('audio/')?'声音':'参考素材');}
const api='/api/commerce/director-conversations';

export function DirectorConversationPanel(props:DirectorPanelProps){
  const {runtime,conversationId,prompt,setPrompt,onExit,onUse,materials,hasMaterials,language,setLanguage,duration,setDuration,directorName='默认编导',directorSpec:publishedDirectorSpec,getReferences,videoSettings,onApplied,setGenerateAudio}=props;
  const [page,setPage]=useState<DirectorPage|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[older,setOlder]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[audio,setAudio]=useState(videoSettings?.generateAudio??true),[loadEpoch,setLoadEpoch]=useState(0);
  const scope=useRef(conversationId),generation=useRef(0);if(scope.current!==conversationId){scope.current=conversationId;generation.current++;}
  const locked=useRef<string|null>(null),sequence=useRef(0),scroller=useRef<HTMLDivElement>(null),follow=useRef(true),alive=useRef(true),latestPrompt=useRef(prompt);latestPrompt.current=prompt;
  const observedSpec=observed.directors.find(d=>d.name===directorName||d.key===directorName)||observed.directors.find(d=>d.default)!;
  const spec:NonNullable<DirectorPanelProps['directorSpec']>=publishedDirectorSpec||{...observedSpec,inputFields:[]};
  const defaults=()=>Object.fromEntries((spec.inputFields||[]).filter(field=>!['spokenLanguage','scriptDuration','generateAudio'].includes(field.id)&&field.defaultValue!==undefined).map(field=>[field.id,field.defaultValue])) as DirectorSettings['selections'];
  const [selections,setSelections]=useState<DirectorSettings['selections']>(defaults);
  const settingsRef=useRef<DirectorSettings>({skillKey:spec.key,selections,spokenLanguage:language,durationSeconds:duration,generateAudio:audio});
  settingsRef.current={skillKey:spec.key,selections,spokenLanguage:language,durationSeconds:duration,generateAudio:audio};
  const configuredFields=(spec.inputFields||[]).filter(field=>!['spokenLanguage','scriptDuration','generateAudio'].includes(field.id));
  useEffect(()=>{setSelections(defaults());},[spec.key]);
  useEffect(()=>{setAudio(videoSettings?.generateAudio??true);},[videoSettings?.generateAudio]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!runtime.ready||!conversationId)return;const controller=new AbortController(),id=conversationId,epoch=generation.current;
    sequence.current++;locked.current=null;setBusy(false);setOlder(false);setPage(null);setError('');setLoading(true);follow.current=true;
    request<{conversation:DirectorPage}>(api,{action:'open',id,settings:settingsRef.current},controller.signal).then(result=>{if((alive.current&&scope.current===id&&generation.current===epoch)){setPage(result.conversation);setLoading(false);}}).catch(e=>{if(!controller.signal.aborted&&(alive.current&&scope.current===id&&generation.current===epoch)){setError(e.message);setLoading(false);}});
    return()=>controller.abort();
  },[conversationId,runtime.ready,loadEpoch,spec.key]);
  const refresh=useCallback(async()=>{
    const id=conversationId,epoch=generation.current,seq=++sequence.current;
    try{const result=await request<{conversation:DirectorPage}>(api+'?id='+encodeURIComponent(id));if(!alive.current||(!alive.current||scope.current!==id||generation.current!==epoch)||sequence.current!==seq)return;
      setPage(current=>current?{...result.conversation,messages:mergeMessages(current.messages,result.conversation.messages),hasMore:current.hasMore,nextCursor:current.nextCursor}:result.conversation);
    }catch(e){if(alive.current&&(alive.current&&scope.current===id&&generation.current===epoch)&&sequence.current===seq)setError((e as Error).message);}
  },[conversationId]);
  useEffect(()=>{
    if(!page?.activeJobId)return;const id=conversationId,epoch=generation.current,jobId=page.activeJobId;
    const stream=new EventSource('/api/commerce/jobs/events?id='+encodeURIComponent(jobId));let timer:ReturnType<typeof setTimeout>|undefined;
    const update=(event:MessageEvent)=>{if((!alive.current||scope.current!==id||generation.current!==epoch))return;try{const job=JSON.parse(event.data);if(job.id!==jobId)return;
      if(typeof job.text==='string')setPage(current=>current?.id===id?{...current,messages:current.messages.map(m=>m.jobId===jobId&&m.role==='assistant'?{...m,content:job.text}:m)}:current);
      if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},200);
      if(['succeeded','failed','save_failed'].includes(job.status))stream.close();
    }catch{void refresh();}};
    stream.addEventListener('job',update as EventListener);stream.onerror=()=>{void refresh();};
    const poll=setInterval(()=>void refresh(),2000);
    return()=>{stream.close();clearInterval(poll);if(timer)clearTimeout(timer);};
  },[page?.activeJobId,conversationId,refresh]);
  useEffect(()=>{const el=scroller.current;if(el&&follow.current)el.scrollTop=el.scrollHeight;},[page?.messages]);
  useEffect(()=>{if(!settingsOpen)return;function escape(e:KeyboardEvent){if(e.key==='Escape')setSettingsOpen(false);}document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[settingsOpen]);
  async function loadOlder(){if(older||!page?.nextCursor)return;const id=conversationId,epoch=generation.current,el=scroller.current,height=el?.scrollHeight||0;setOlder(true);
    try{const result=await request<{conversation:DirectorPage}>(api+'?id='+encodeURIComponent(id)+'&beforeMessageId='+encodeURIComponent(page.nextCursor));if((!alive.current||scope.current!==id||generation.current!==epoch))return;follow.current=false;setPage(current=>current?{...current,messages:mergeMessages(result.conversation.messages,current.messages),hasMore:result.conversation.hasMore,nextCursor:result.conversation.nextCursor}:result.conversation);requestAnimationFrame(()=>{if(el&&(alive.current&&scope.current===id&&generation.current===epoch))el.scrollTop+=el.scrollHeight-height;});}
    catch(e){if((alive.current&&scope.current===id&&generation.current===epoch))setError((e as Error).message);}finally{if((alive.current&&scope.current===id&&generation.current===epoch))setOlder(false);}
  }
  async function send(){
    if(locked.current||busy||loading||!runtime.ready||!page||page.activeJobId||!getReferences||(!prompt.trim()&&!hasMaterials))return;
    const id=conversationId,epoch=generation.current,token=crypto.randomUUID(),sentPrompt=prompt,sentSettings=settingsRef.current;locked.current=token;setBusy(true);setError('');
    try{const references=await getReferences();if((!alive.current||scope.current!==id||generation.current!==epoch))return;
      const payload={id,message:sentPrompt,expectedScriptMessageId:page.latestScriptMessageId,settings:sentSettings,references};
      const fingerprint=JSON.stringify(payload),key='commerce-director-operation:'+id;let pending:{id:string;fingerprint:string}|null=null;
      try{pending=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
      if(!pending||pending.fingerprint!==fingerprint)pending={id:crypto.randomUUID(),fingerprint};
      try{sessionStorage.setItem(key,JSON.stringify(pending));}catch{}
      const quoted=await request<{quote:{id:string;inputFingerprint:string;model:{displayName:string};payableTotal:number;expiresAt:number}}>(api,{action:'quote',...payload,operationId:pending.id});
      if((!alive.current||scope.current!==id||generation.current!==epoch))return;
      if(!window.confirm(`本轮编导将使用 ${quoted.quote.model.displayName}，应付 ¥${quoted.quote.payableTotal.toFixed(4)}。确认后从主站现金钱包预扣，是否继续？`)){try{sessionStorage.removeItem(key);}catch{}throw Error('已取消本轮编导付费任务');}
      await request<{job:{id:string}}>('/api/commerce/jobs',{quoteId:quoted.quote.id,clientRequestId:pending.id,inputFingerprint:quoted.quote.inputFingerprint});
      const result=await request<{conversation:DirectorPage}>(api+'?id='+encodeURIComponent(id));
      if((!alive.current||scope.current!==id||generation.current!==epoch))return;try{sessionStorage.removeItem(key);}catch{}
      follow.current=true;if(latestPrompt.current===sentPrompt)setPrompt('');setPage(current=>current?{...result.conversation,messages:mergeMessages(current.messages,result.conversation.messages),hasMore:current.hasMore,nextCursor:current.nextCursor}:result.conversation);void runtime.refresh();
    }catch(e){if((alive.current&&scope.current===id&&generation.current===epoch)){setError((e as ResponseError).message);void refresh();}}
    finally{if(locked.current===token){locked.current=null;if((alive.current&&scope.current===id&&generation.current===epoch))setBusy(false);}}
  }
  async function apply(message:DirectorMessage){
    if(locked.current||!getReferences||!videoSettings||!page)return;const id=conversationId,epoch=generation.current,token=crypto.randomUUID(),appliedSettings=settingsRef.current;locked.current=token;setBusy(true);setError('');
    try{const references=await getReferences();if((!alive.current||scope.current!==id||generation.current!==epoch))return;
      const {application}=await request<{application:DirectorApplication}>(api,{action:'apply',id,messageId:message.id,expectedScriptMessageId:page.latestScriptMessageId,settings:appliedSettings,references,videoSettings});
      if((!alive.current||scope.current!==id||generation.current!==epoch))return;if(onApplied)onApplied(application);else onUse(application.script,application.jobId);
    }catch(e){if((alive.current&&scope.current===id&&generation.current===epoch)){setError((e as Error).message);void refresh();}}finally{if(locked.current===token){locked.current=null;if((alive.current&&scope.current===id&&generation.current===epoch))setBusy(false);}}
  }
  const pending=page?.messages.find(m=>m.role==='assistant'&&m.jobId===page.activeJobId),canSend=!!getReferences&&!!page&&!page.activeJobId&&!busy&&!loading&&runtime.ready&&(!!prompt.trim()||hasMaterials);
  return <div className="ca-director-workspace ca-director-conversation" data-conversation-id={conversationId}>
    <div ref={scroller} className="ca-director-messages" onScroll={()=>{const el=scroller.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<72;}}>
      {loading&&<p className="ca-director-pending"><LoaderCircle className="ca-spin" size={14}/>正在恢复编导会话…</p>}
      {page?.hasMore&&<button className="ca-director-older" disabled={older||!!page.activeJobId} onClick={()=>void loadOlder()}>{older?'读取中…':'读取更早的对话'}</button>}
      {!loading&&!page?.messages.length&&<div className="ca-director-welcome"><img src={observed.directorGuide} alt=""/><h2>你想创作一条什么视频？</h2><div>{['直击产品核心痛点','利用新奇场景开场','制造强烈情绪反转','用反常识观点开场','真实痛点引出需求','强烈对比突出差异'].map(text=><button key={text} onClick={()=>setPrompt(prompt?prompt+'\n'+text:text)}>{text}</button>)}</div></div>}
      {page?.messages.map(message=><article key={message.id} data-message-id={message.id} data-status={message.status} data-business-state={message.business?.state||'unverified'} className={'ca-director-message ca-director-message-'+message.role}>
          {message.role==='user'&&message.references.length>0&&<div className="ca-director-history-assets">{message.references.map((r,i)=><figure key={(r.instanceId||r.id)+':'+i}>{r.type?.startsWith('image/')?<img loading="lazy" src={'/api/commerce/assets/'+r.id} alt={r.name||'参考素材'} onError={e=>{e.currentTarget.style.opacity='.25';}}/>:r.type?.startsWith('audio/')?<audio controls preload="none" src={'/api/commerce/assets/'+r.id}/>:<span>参考文件</span>}<figcaption>{i+1}. {r.name||'已失效素材'} · {referenceLabel(message,r,publishedDirectorSpec)}</figcaption></figure>)}</div>}
        {message.role==='assistant'?<>
          {message.business?.state==='needs_input'&&<p className="ca-director-business-note">待补充信息 · 本轮回复尚未形成可应用脚本</p>}
          {message.business?.state==='legacy_unverified'&&<p className="ca-director-business-note">旧格式未校验 · 原文保留，可复制或继续对话整理为新稿</p>}
          {message.business?.state==='invalid'&&<p className="ca-director-message-error" role="alert">{message.business.error}</p>}
          {['pending','streaming'].includes(message.status)&&message.outputProtocol?<><p className="ca-director-pending">正在分析素材并组织完整脚本…{message.content?` 已接收 ${message.content.length} 字符`:''}</p>{message.content&&<details className="ca-director-raw"><summary>查看实时原回复</summary><pre>{message.content}</pre></details>}</>:<ScriptContent text={message.business?.displayText??message.content}/>}
          {message.business?.state==='invalid'&&<details className="ca-director-raw"><summary>查看未通过校验的原回复</summary><pre>{message.content}</pre></details>}
        </>:<div>{message.content}</div>}
        {message.role==='assistant'&&message.status==='completed'&&<footer><button onClick={()=>void navigator.clipboard.writeText(message.business?.generationText||message.business?.displayText||message.content).catch(()=>setError('复制失败，请手动选择正文。'))}><Copy size={12}/>{message.business?.state==='ready'?'复制脚本':'复制回复'}</button>{message.business?.state==='ready'&&<button disabled={busy||!!page.activeJobId||page.latestScriptMessageId!==message.id||!videoSettings||!getReferences} onClick={()=>void apply(message)}>{page.latestScriptMessageId===message.id?'应用脚本，进入视频制作':'历史脚本'}</button>}</footer>}
        {message.role==='assistant'&&['failed','unknown'].includes(message.status)&&<p className="ca-director-message-error">{message.error||'本轮未完成，上一版脚本仍保留'}</p>}
      </article>)}
      {pending&&<p className="ca-director-pending"><LoaderCircle size={14} className="ca-spin"/>{pending.status==='unknown'?'原任务结果待核对，不会重复提交':'正在生成脚本…'}</p>}
    </div>
    <div className="ca-director-exit"><button onClick={onExit}>退出编导</button></div>
    {error&&<div className="ca-director-service-error" role="alert">{error}<button onClick={()=>page?void refresh():setLoadEpoch(x=>x+1)}>重新读取</button></div>}
    <div className="ca-director-composer"><fieldset disabled={busy} className="ca-director-attachments ca-director-material-fieldset">{materials}</fieldset>
      <small className="ca-director-apply-note">声音参考单个不超过 {DIRECTOR_AUDIO_MAX_SECONDS} 秒，仅供后续视频模型使用；编导不会收听或转写音频内容。</small>
      {configuredFields.length>0&&<fieldset disabled={busy} className="ca-director-configured-fields"><legend>本编导输入</legend>{configuredFields.map(field=><label key={field.id}><span>{field.title}{field.required?' *':''}</span>{field.type==='select'?<select value={String(selections[field.id]??field.defaultValue??'')} onChange={event=>setSelections(current=>({...current,[field.id]:event.target.value}))}><option value="">请选择</option>{field.options?.map(option=><option key={option} value={option}>{option}</option>)}</select>:field.type==='boolean'?<input type="checkbox" checked={Boolean(selections[field.id]??field.defaultValue??false)} onChange={event=>setSelections(current=>({...current,[field.id]:event.target.checked}))}/>:field.type==='number'?<input type="number" min={field.validation?.min} max={field.validation?.max} value={String(selections[field.id]??field.defaultValue??'')} onChange={event=>setSelections(current=>({...current,[field.id]:event.target.value===''?'':Number(event.target.value)}))}/>:field.type==='textarea'?<textarea maxLength={field.validation?.maxLength||2000} value={String(selections[field.id]??field.defaultValue??'')} onChange={event=>setSelections(current=>({...current,[field.id]:event.target.value}))}/>:<input type="text" maxLength={field.validation?.maxLength||500} value={String(selections[field.id]??field.defaultValue??'')} onChange={event=>setSelections(current=>({...current,[field.id]:event.target.value}))}/>} {field.description&&<small>{field.description}</small>}</label>)}</fieldset>}
      <textarea aria-label="编导聊天输入" value={prompt} maxLength={8000} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(canSend)void send();}}} placeholder="分析素材，并生成脚本"/>
      <footer><button aria-label="编导语言与脚本时长" aria-expanded={settingsOpen} disabled={busy} onClick={()=>setSettingsOpen(x=>!x)}>文 {language} · {duration}s <ChevronDown size={11}/></button><span>{busy?'提交中':pending?'生成中':'费用待确认'}</span><button className="ca-send" title="发送编导消息" disabled={!canSend} onClick={()=>void send()}><ArrowUp size={20}/></button></footer>
      {settingsOpen&&<fieldset disabled={busy} role="dialog" aria-label="编导语言与脚本时长" className="ca-director-settings ca-director-own-settings"><h3>语言</h3><div>{['中文','英文','泰国','马来西亚','巴西','不限'].map(value=><button key={value} aria-pressed={language===value} className={language===value?'selected':''} onClick={()=>setLanguage(value)}>{value}</button>)}</div><h3>视频时长</h3><input aria-label="脚本时长" type="range" min={4} max={COMMERCE_VIDEO_MAX_TOTAL_DURATION} value={duration} onChange={e=>setDuration(Number(e.target.value))}/><p>{duration} 秒</p><label><input type="checkbox" checked={audio} onChange={e=>{setAudio(e.target.checked);setGenerateAudio?.(e.target.checked);}}/>生成声音</label><button onClick={()=>setSettingsOpen(false)}>完成</button></fieldset>}
    </div>
    {page?.latestScriptMessageId&&<small className="ca-director-apply-note">应用会替换正文、参考素材及视频时长和声音设置；修改素材或设置后请重新创作脚本。</small>}
  </div>;
}
