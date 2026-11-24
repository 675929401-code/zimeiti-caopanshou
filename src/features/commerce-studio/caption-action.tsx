'use client';
import {useEffect,useRef,useState} from 'react';
import {api,type Runtime} from '@/commerce/components/commerce-agent/runtime-ui';
import {parseSubtitles,renderSrt} from '@/commerce/shared/member-captions';

export function CaptionAction({runtime,translation,onTranslate,thread}:{thread:string;runtime:Runtime;translation:boolean;onTranslate:(s:string)=>void}){
  const [assetId,setAsset]=useState(''),[language,setLanguage]=useState('auto'),[target,setTarget]=useState('英文');
  const [bilingual,setBilingual]=useState(false),[srt,setSrt]=useState(''),[highlight,setHighlight]=useState('');
  const [result,setResult]=useState<{name:string;url:string}>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const lock=useRef(false);
  useEffect(()=>{const receive=(event:Event)=>{const data=(event as CustomEvent<{thread:string;srt:string}>).detail;if(data?.thread===thread){setSrt(data.srt);setResult(undefined);setError('');}};window.addEventListener('commerce-translated-captions',receive);return ()=>window.removeEventListener('commerce-translated-captions',receive);},[thread]);
  async function perform(work:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setResult(undefined);
    try{await work();}catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
  async function run(action:string){await perform(async()=>{
    const data=await api<{srt?:string;asset?:{name:string;url:string}}>('/api/commerce/studio/captions',{action,srt,highlight,assetId,language});
    if(data.srt)setSrt(data.srt);if(data.asset)setResult(data.asset);
  });}
  const sources=runtime.assets.filter(a=>/^(audio|video)\//.test(a.type));
  return <section className="cs-document-action" aria-label="字幕工作区"><fieldset disabled={busy} onChange={()=>{setResult(undefined);setError('');}}>
    <label>音视频<select value={assetId} onChange={e=>setAsset(e.target.value)}><option value="">从素材库选择</option>{sources.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
    <label>上传音视频<input type="file" accept="video/*,audio/*" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void perform(async()=>setAsset((await runtime.upload(file)).id));}}/></label>
    <label>原声语言<select value={language} onChange={e=>setLanguage(e.target.value)}>{[['auto','自动识别'],['zh','中文'],['en','英文'],['th','泰语'],['vi','越南语']].map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
    <button type="button" disabled={!assetId} onClick={()=>void run('recognize')}>识别语音并生成时间轴</button>
    <label>导入 SRT<input type="file" accept=".srt,text/plain" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void perform(async()=>{if(file.size>500000)throw Error('字幕文件过大');setSrt(renderSrt(parseSubtitles(await file.text())));});}}/></label>
    <label>校对字幕<textarea value={srt} onChange={e=>setSrt(e.target.value)} rows={5}/></label>
    <label>高亮词<input maxLength={80} value={highlight} onChange={e=>setHighlight(e.target.value)}/></label>
    {translation&&<><label>译为<select value={target} onChange={e=>setTarget(e.target.value)}>{['中文','英文','泰语','越南语'].map(v=><option key={v}>{v}</option>)}</select></label><label>字幕形式<select value={String(bilingual)} onChange={e=>setBilingual(e.target.value==='true')}><option value="false">单语</option><option value="true">双语</option></select></label>
    <button type="button" disabled={!srt.trim()} onClick={()=>void perform(async()=>{const text=renderSrt(parseSubtitles(srt));if(text.length>14000)throw Error('请分段翻译，每次最多 14000 个字符');onTranslate('请翻译为'+target+'，'+(bilingual?'每段保留原文并换行附译文':'每段仅保留译文')+'。\n\n原始 SRT\n'+text);})}>将字幕送入翻译对话</button></>}
    {['srt','ass','burn'].map(a=><button key={a} disabled={!srt.trim()||(a==='burn'&&!assetId)} type="button" onClick={()=>void run(a)}>{a==='burn'?'导出硬字幕视频':'导出 '+a.toUpperCase()}</button>)}
    </fieldset>{busy&&<small role="status">正在处理…</small>}{error&&<p role="alert">{error}</p>}{result&&<a download={result.name} href={result.url+'?download=1'}>下载 {result.name}</a>}</section>;
}
export function TranslatedSubtitles({request,text,apply}:{request:string;text:string;apply?:(v:string)=>void}){
  const mark='\n\n原始 SRT\n',start=request.indexOf(mark);
  if(start<0)return null;
  const match=/```srt\s*\r?\n([\s\S]+?)\r?\n```/i.exec(text);
  if(!match)return <small>回复中缺少 SRT 文件，可在当前对话要求重新输出。</small>;
  try{
    const original=parseSubtitles(request.slice(start+mark.length).split('\n\n创作偏好')[0]),translated=parseSubtitles(match[1]);
    if(original.length!==translated.length||original.some((row,i)=>row.start!==translated[i].start||row.end!==translated[i].end))throw Error();
    const value=renderSrt(translated);
    return <><button type="button" onClick={()=>{const url=URL.createObjectURL(new Blob([value],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='译文.srt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}}>下载译文 SRT</button>{apply&&<button type="button" onClick={()=>apply(value)}>使用已核对时间轴的译文</button>}</>;
  }catch{return <small>译文与原字幕时间轴不一致，请修正后导出。</small>;}
}
