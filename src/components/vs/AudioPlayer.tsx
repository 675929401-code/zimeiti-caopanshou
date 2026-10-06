'use client';
import { useEffect, useState } from 'react';
import { resolvePlayableAudio } from '@/lib/vs/owned-audio';
interface AudioPlayerProps { audioUrl:string; onDownload?:()=>void }
export default function AudioPlayer({audioUrl,onDownload}:AudioPlayerProps) {
 const [src,setSrc]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();let release=()=>{};setSrc('');setError('');
  void resolvePlayableAudio(audioUrl,controller.signal).then(result=>{if(controller.signal.aborted){result.release();return;}release=result.release;setSrc(result.url);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'音频暂时无法播放');});
  return()=>{controller.abort();release();};
 },[audioUrl,retry]);
 return <div className="space-y-3 rounded-xl border border-[var(--vs-border)] bg-[var(--vs-surface)]/40 p-3">
  {src ? <audio aria-label="试听生成配音" key={src} src={src} controls preload="metadata" className="w-full" onError={()=>setError('音频暂时无法播放，请重新加载')} /> : !error && <p role="status">正在加载音频…</p>}
  {error && <div role="alert" className="text-sm text-red-400">{error}<button className="ml-3 underline" onClick={()=>setRetry(value=>value+1)}>重新加载</button></div>}
  {onDownload && <button onClick={onDownload} className="text-sm text-[var(--vs-primary)]">下载音频</button>}
 </div>;
}
