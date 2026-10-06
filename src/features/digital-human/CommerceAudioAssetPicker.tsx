'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import styles from '@/app/digital-human/workspace.module.css';
import type {HumanAsset} from './client-state';
import {transferCommerceAudioToDigitalHuman,type CommerceAudioCandidate} from './commerce-audio-bridge';

type Props={
 userId:string;
 token:string;
 disabled:boolean;
 audio:HumanAsset|null;
 onAudio:(asset:HumanAsset)=>void;
 onBusyChange?:(busy:boolean)=>void;
};

export function CommerceAudioAssetPicker({userId,token,disabled,audio,onAudio,onBusyChange}:Props){
 const [assets,setAssets]=useState<CommerceAudioCandidate[]>([]),[selectedId,setSelectedId]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const alive=useRef(true),controller=useRef<AbortController|null>(null),locked=useRef(false);
 const load=useCallback(async()=>{
  setLoading(true);setError('');
  try{
   const response=await fetch('/api/commerce/digital-human-audio-assets',{cache:'no-store',credentials:'same-origin'});
   const result=await response.json();
   if(!response.ok||!Array.isArray(result.assets))throw Error(result.error||'带货配音资产暂时无法读取');
   if(!alive.current)return;
   setAssets(result.assets);
   setSelectedId(current=>result.assets.some((item:CommerceAudioCandidate)=>item.id===current)?current:String(result.assets[0]?.id||''));
  }catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'带货配音资产暂时无法读取');}
  finally{if(alive.current)setLoading(false);}
 },[]);
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;controller.current?.abort();onBusyChange?.(false);};},[load,onBusyChange,userId]);
 async function choose(){
  if(locked.current||disabled||busy)return;
  const candidate=assets.find(item=>item.id===selectedId);if(!candidate)return;
  locked.current=true;setBusy(true);onBusyChange?.(true);setError('');setMessage('正在核验并复制音频到当前主站账号…');
  const active=new AbortController();controller.current=active;
  try{
   const value=await transferCommerceAudioToDigitalHuman(candidate,token,{signal:active.signal});
   if(!alive.current)return;
   onAudio(value);setMessage(`已用于当前数字人 · ${value.duration.toFixed(1)} 秒；未触发配音或视频生成。`);
  }catch(cause){if(alive.current&&!(cause instanceof DOMException&&cause.name==='AbortError'))setError(cause instanceof Error?cause.message:'带货配音复制未完成');}
  finally{if(controller.current===active)controller.current=null;locked.current=false;if(alive.current){setBusy(false);onBusyChange?.(false);}}
 }
 const selected=assets.find(item=>item.id===selectedId);
 return <div className={styles.speech} aria-label="带货 Agent 配音资产">
  <div className={styles.sectionLabel}><span>带货 Agent · 已完成配音</span><button type="button" disabled={loading||busy||disabled} onClick={()=>void load()}>刷新资产</button></div>
  <label className={styles.field}>选择当前账号的配音<select aria-label="选择带货配音资产" disabled={loading||busy||disabled||!assets.length} value={selectedId} onChange={event=>{setSelectedId(event.target.value);setError('');setMessage('');}}><option value="">{loading?'正在读取…':'请选择配音'}</option>{assets.map(item=><option key={item.id} value={item.id}>{item.name} · {(item.size/1024/1024).toFixed(2)} MB</option>)}</select></label>
  <p className={styles.hint}>只读取当前带货账号已持久化的音频；AI 生成音频还必须有成功任务回执。选择后会复制成当前主站账号的数字人输入，不触发模型生成或本站扣费。</p>
  <div className={styles.speechActions}><div><strong>{selected?selected.name:'暂无可用配音'}</strong><small>{selected?(selected.completionEvidence==='voice-job-succeeded'?'语音任务已完成':'已上传并持久化'):'可先在带货 Agent 的语音合成中制作配音'}</small></div><button className={styles.secondaryPrimary} type="button" disabled={loading||busy||disabled||!selected} onClick={()=>void choose()}>{busy?'正在复制…':audio&&message?'替换为所选配音':'用于当前数字人'}</button></div>
  {message&&<p className={styles.hint} role="status">{message}</p>}
  {error&&<p className={styles.inlineError} role="alert">{error}</p>}
 </div>;
}
