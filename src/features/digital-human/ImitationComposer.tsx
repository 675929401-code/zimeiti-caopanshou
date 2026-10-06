'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import type {HumanAsset} from './client-state';
import AudioPlayer from '@/components/vs/AudioPlayer';
import styles from '@/app/digital-human/workspace.module.css';
import {fingerprintPendingAudioPayload,readPendingAudioAttempt,writePendingAudioAttempt,type PendingAudioAttempt} from './pending-audio-attempt';
type Draft={text:string;referenceId:string;assetId:string;applied:string;attempt?:PendingAudioAttempt};
const empty:Draft={text:'',referenceId:'',assetId:'',applied:''};
const fingerprint=(d:Draft)=>fingerprintPendingAudioPayload([d.text.trim(),d.referenceId]);
type Props={userId:string;token:string;disabled:boolean;maxSeconds:number;audio:HumanAsset|null;onAudio:(asset:HumanAsset)=>void;onReady:(ready:boolean)=>void;onPending:(pending:boolean)=>void};
const customerImitationError=(value:unknown,fallback:string)=>{const detail=typeof value==='string'?value.trim():'';if(/API|HTTP|provider|供应商|上游|渠道|密钥|后台|数据库|迁移|作业键|预占|终态|落库/iu.test(detail))return fallback;return detail||fallback;};
export function ImitationComposer({userId,token,disabled,maxSeconds,audio,onAudio,onReady,onPending}:Props){
 const key='digital-human:imitation:v1:'+userId;
 const [draft,setDraft]=useState<Draft>(empty),[ready,setReady]=useState(false),[reference,setReference]=useState<HumanAsset|null>(null);
 const [quote,setQuote]=useState<{reserveCredits:number;unitPrice:number}|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[uploading,setUploading]=useState(false);
 const [recoveredAssetId,setRecoveredAssetId]=useState('');
 const current=useRef(draft),alive=useRef(true),processing=useRef(false),apply=useRef(onAudio);
 useEffect(()=>{apply.current=onAudio;},[onAudio]);
 const headers=useCallback(()=>({Authorization:'Bearer '+token}),[token]);
 const store=useCallback((next:Draft)=>{try{writePendingAudioAttempt(localStorage,key,next.attempt);}catch{if(next.attempt){setError('浏览器无法保存配音任务编号，本次尚未提交');return false;}}if(next.text!==current.current.text||next.referenceId!==current.current.referenceId)setRecoveredAssetId('');current.current=next;setDraft(next);return true;},[key]);
 const asset=useCallback(async(id:string)=>{const response=await fetch('/api/digital-human/assets?id='+encodeURIComponent(id),{headers:headers(),cache:'no-store'});const data=await response.json();if(!response.ok||!data.assets?.[0])throw new Error(customerImitationError(data.error,'音频暂时无法读取'));return data.assets[0] as HumanAsset;},[headers]);
 useEffect(()=>{alive.current=true;try{const attempt=readPendingAudioAttempt(localStorage,key);current.current={...empty,attempt};setDraft(current.current);}catch{setError('原配音任务编号暂时无法读取');}setReady(true);
  void fetch('/api/voice/imitation-quote',{headers:headers(),cache:'no-store'}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(customerImitationError(result.message,'音色模仿价格暂时无法读取'));if(alive.current)setQuote(result.data);}).catch(error=>{if(alive.current)setError(customerImitationError(error.message,'音色模仿价格暂时无法读取'));});
  return()=>{alive.current=false;};
 },[key,headers,asset]);
 const stamp=fingerprint(draft),matched=!!audio&&((audio.id===draft.assetId&&stamp===draft.applied)||audio.id===recoveredAssetId);
 useEffect(()=>{onReady(matched&&!draft.attempt);},[matched,draft.attempt,onReady]);
 useEffect(()=>{onPending(!!draft.attempt||uploading);},[draft.attempt,uploading,onPending]);
 const recover=useCallback(async()=>{const attempt=current.current.attempt;if(!attempt||processing.current)return;processing.current=true;
  try{const response=await fetch('/api/voice/generation-status?'+new URLSearchParams({clientRequestId:attempt.key,phase:'seed-audio'}),{headers:headers(),cache:'no-store',signal:AbortSignal.timeout(15000)});const data=await response.json();if(!alive.current||current.current.attempt?.key!==attempt.key)return;
   if(!response.ok){setMessage('正在确认原配音任务，请稍候');return;}const task=data.data;
   if(task.state==='completed'&&task.assetId){const result=await asset(task.assetId);if(!alive.current)return;if(store({...current.current,attempt:undefined,assetId:result.id,applied:attempt.fingerprint})){setRecoveredAssetId(result.id);apply.current(result);setError('');setMessage('音色模仿完成 · '+result.duration.toFixed(1)+' 秒 · 实扣 '+(task.chargedCredits-task.refundedCredits)+' 积分');}}
   else if(['refunded','failed'].includes(task.state)){store({...current.current,attempt:undefined});setMessage('');setError('本次模仿未成功，已扣积分已退回。可调整素材后重试。');}
   else setMessage(task.state==='failed_unknown'?'正在确认原任务结果，暂不重复提交':'正在模仿声音，完成后自动用于数字人');
  }catch{if(alive.current)setMessage('连接暂时中断，正在查询原配音');}finally{processing.current=false;}
 },[headers,asset,store]);
 const activeAttemptKey=draft.attempt?.key;
 useEffect(()=>{if(!activeAttemptKey)return;void recover();const timer=setInterval(()=>void recover(),4000);return()=>clearInterval(timer);},[activeAttemptKey,recover]);
 async function upload(file:File){if(disabled||current.current.attempt||uploading)return;if(file.size>10*1024*1024){setError('参考音频不能超过10MB');return;}setUploading(true);setError('');try{const form=new FormData();form.append('file',file);form.append('category','audio');const response=await fetch('/api/digital-human/upload',{method:'POST',headers:headers(),body:form});const data=await response.json();if(!response.ok)throw new Error(customerImitationError(data.error,'参考音频上传失败，请重试'));if(alive.current&&store({...current.current,referenceId:data.asset.id}))setReference(data.asset);}catch(error){if(alive.current)setError(customerImitationError(error instanceof Error?error.message:'','上传失败'));}finally{if(alive.current)setUploading(false);}}
 async function generate(){if(disabled||uploading||current.current.attempt||!reference||!draft.text.trim()||!quote)return;
  const attempt={key:'digital-imitation-'+crypto.randomUUID(),fingerprint:stamp};if(!store({...draft,attempt}))return;setError('');setMessage('正在模仿声音…');
  let submitted=false;try{const fresh=await asset(reference.id);submitted=true;const response=await fetch('/api/voice/tts',{method:'POST',headers:{...headers(),'Content-Type':'application/json','Idempotency-Key':attempt.key},signal:AbortSignal.timeout(180000),body:JSON.stringify({textPrompt:'@音频1 用自然的语气朗读：'+draft.text.trim(),references:[{audioUrl:fresh.url}],format:'mp3',sampleRate:24000,client_request_id:attempt.key})});const data=await response.json();if(!alive.current)return;
   if(!response.ok&&[400,401,402,403,404,422,429].includes(response.status)&&!data.data?.requestId){store({...current.current,attempt:undefined});setError(response.status===402?'本站积分不足，请到智音工坊充值后重试':customerImitationError(data.message,'配音提交未成功'));setMessage('');}else void recover();
  }catch{if(alive.current){if(!submitted){store({...current.current,attempt:undefined});setError('参考音频暂时无法读取，请重新上传');setMessage('');}else setMessage('正在确认原配音，请勿重复提交');}}}
 const busy=disabled||uploading||!!draft.attempt;
 return <div className={styles.speech} aria-label="数字人音色模仿">
  <label className={styles.field}>参考声音<input aria-label="上传模仿参考音频" type="file" accept="audio/mpeg,audio/wav,audio/aac" disabled={busy||!ready} onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file);event.target.value='';}}/></label>
  <p className={styles.hint}>上传一段清晰人声，建议10–30秒，最大10MB。</p>
  {reference&&<AudioPlayer audioUrl={'/api/storage/files/'+reference.id+'/content'}/>}
  <label className={styles.field}>人物台词<textarea aria-label="模仿配音文案" rows={6} maxLength={1500} value={draft.text} disabled={busy||!ready} onChange={event=>store({...draft,text:event.target.value})} placeholder="输入希望人物说出的台词"/></label>
  <p className={styles.hint}>当前视频最长{maxSeconds}秒，请合成后试听确认。</p>
  <div className={styles.speechActions}><div><strong>{quote?'¥'+quote.unitPrice+'/分钟，按实际秒数折算':'正在读取价格…'}</strong><small>{quote?'预留 '+quote.reserveCredits+' 积分，成功退差额；失败全退。':''}</small></div><button className={styles.secondaryPrimary} disabled={busy||!ready||!reference||!draft.text.trim()||!quote} onClick={()=>void generate()}>{draft.attempt?'模仿中…':'模仿并合成配音'}</button></div>
  {error&&<p role="alert" className={styles.inlineError}>{error}</p>}{message&&<p role="status" className={styles.hint}>{message}</p>}
  {audio&&<><AudioPlayer audioUrl={'/api/storage/files/'+audio.id+'/content'}/><p className={styles.hint}>{matched?'已用于当前数字人':'参考声音或台词已改变，请重新合成'}</p></>}
  <Link className={styles.subtleLink} href="/voice-studio/imitate">在智音工坊查看模仿记录 →</Link>
 </div>;
}
