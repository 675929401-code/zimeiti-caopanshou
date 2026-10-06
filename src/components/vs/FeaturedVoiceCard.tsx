'use client';
import VoicePortrait from '@/components/vs/VoicePortrait';

import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { loadPreview, clearCachedPreview } from '@/lib/vs/preview-cache';

export interface FeaturedVoiceData {
  speakerId: string;
  name: string;
  avatar?: string;
  tags?: string[];
  description: string;
  highlight?: string;
  gender?: string;
}

interface FeaturedVoiceCardProps {
  voice: FeaturedVoiceData;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onUseInWorkspace?: () => void;
  actionLabel?: string;
  compact?: boolean;
}

// 长卡片（推荐音色/热门音色/全部音色通用）— 横向布局，名字/标签 + 描述全展示，收藏按钮不挡内容
export default function FeaturedVoiceCard({ voice, isFavorite = false, onToggleFavorite, onUseInWorkspace, actionLabel = '使用', compact = false }: FeaturedVoiceCardProps) {
  const instanceId = useId().replace(/:/g, '');
  const nameId = `voice-name-${instanceId}`;
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef=useRef<HTMLAudioElement|null>(null),sequence=useRef(0),active=useRef(false);
  const stopRef=useRef<()=>void>(()=>{});
  const coordinator=()=>window as typeof window & {__voicePreviewStop?:()=>void};
  const stop=useCallback(()=>{sequence.current++;active.current=false;const audio=audioRef.current;if(audio){audio.pause();audio.onended=null;audio.onerror=null;if(audio.src.startsWith('blob:'))URL.revokeObjectURL(audio.src);audio.src='';audioRef.current=null;}setPreviewing(false);if(coordinator().__voicePreviewStop===stopRef.current)delete coordinator().__voicePreviewStop;},[]);
  stopRef.current=stop;
  async function handlePreview(event:React.MouseEvent){
    event.stopPropagation();if(active.current){stop();return;}
    coordinator().__voicePreviewStop?.();coordinator().__voicePreviewStop=stopRef.current;
    const ticket=++sequence.current;active.current=true;setPreviewError(null);setPreviewing(true);
    try{
      const {audioUrl}=await loadPreview(voice.speakerId);
      if(ticket!==sequence.current){if(audioUrl.startsWith('blob:'))URL.revokeObjectURL(audioUrl);return;}
      const audio=new Audio(audioUrl);audioRef.current=audio;
      audio.onended=()=>{if(ticket===sequence.current)stop();};
      audio.onerror=()=>{if(ticket===sequence.current){stop();void clearCachedPreview(voice.speakerId);setPreviewError('音频加载失败，请点击重新试听');}};
      await audio.play();
    }catch(error){if(ticket===sequence.current){stop();setPreviewError(error instanceof DOMException&&error.name==='NotAllowedError'?'浏览器尚未允许播放，请再次点击试听':error instanceof Error?error.message:'试听失败，请点击重试');}}
  }
  useEffect(()=>()=>{sequence.current++;active.current=false;const audio=audioRef.current;if(audio){audio.pause();if(audio.src.startsWith('blob:'))URL.revokeObjectURL(audio.src);}if(coordinator().__voicePreviewStop===stopRef.current)delete coordinator().__voicePreviewStop;},[]);

  return (
    <article aria-labelledby={nameId} data-voice-id={voice.speakerId} className={`group relative flex items-stretch gap-3 p-3 rounded-2xl border-2 border-[var(--vs-border)] bg-gradient-to-br from-[var(--vs-surface)]/85 to-[var(--vs-surface)]/55 hover:border-[var(--vs-accent)]/55 hover:shadow-md hover:shadow-[var(--vs-accent)]/10 hover:-translate-y-0.5 transition-all duration-200 ${compact ? 'h-[96px]' : 'h-[110px]'}`}>
      {/* 头像 + 试听按钮 */}
      <button
        onClick={handlePreview}
        aria-label={(previewing ? '停止试听 ' : '试听 ')+voice.name}
        className={`relative ${compact ? 'w-14 h-14' : 'w-16 h-16'} self-center rounded-2xl overflow-hidden shrink-0 ring-2 ring-[var(--vs-border)] hover:ring-[var(--vs-accent)]/70 transition-all active:scale-[0.96] shadow-md cursor-pointer`}
        title={previewing ? '停止试听' : '点击试听'}
      >
        <VoicePortrait speakerId={voice.speakerId} name={voice.name} gender={voice.gender} />
        <div className={`absolute inset-0 bg-[var(--vs-bg)]/80 flex items-center justify-center transition-opacity ${previewing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {previewing ? (
            <div className="flex gap-0.5">
              <span className="w-1 h-3.5 bg-[var(--vs-primary)] rounded-full animate-pulse" />
              <span className="w-1 h-3.5 bg-[var(--vs-primary)] rounded-full animate-pulse" style={{ animationDelay: '0.15s' }} />
              <span className="w-1 h-3.5 bg-[var(--vs-primary)] rounded-full animate-pulse" style={{ animationDelay: '0.3s' }} />
            </div>
          ) : (
            <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      </button>

      {/* 信息区 - 名字 + 标签 + 描述，预留收藏按钮空间 */}
      <div className={`min-w-0 flex-1 flex flex-col justify-center ${compact ? 'pr-16' : 'pr-12'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <h4 id={nameId} className={`${compact ? 'text-[14px]' : 'text-[15px]'} font-bold text-[var(--vs-text)] truncate leading-5`} title={voice.name}>{voice.name}</h4>
          <div className={`${compact ? 'hidden' : 'hidden md:flex'} items-center gap-1 shrink-0`}>
            {(voice.tags || []).slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold bg-[var(--vs-accent)]/15 text-[var(--vs-accent)] border border-[var(--vs-accent)]/30"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-1 text-sm leading-5 font-medium text-[var(--vs-text-secondary)] line-clamp-2" title={voice.description}>
          {voice.description}
        </p>
        {previewError && <p className="text-[11px] text-rose-300 mt-0.5">{previewError}</p>}
      </div>

      {/* 收藏桃心按钮 - 右上角 */}
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className={`absolute top-2.5 right-2.5 p-1.5 rounded-lg border transition-all z-10 active:scale-[0.92] cursor-pointer ${
            isFavorite
              ? 'bg-rose-500/20 border-rose-400/60 hover:bg-rose-500/30'
              : 'bg-[var(--vs-bg)]/70 border-[var(--vs-border)] hover:border-rose-300/60'
          }`}
          title={isFavorite ? '取消收藏' : '收藏'}
          aria-label={(isFavorite ? '取消收藏 ' : '收藏 ') + voice.name}
          aria-pressed={isFavorite}
        >
          <svg
            className={`w-4 h-4 transition-colors ${isFavorite ? 'text-rose-300' : 'text-[var(--vs-text-secondary)] hover:text-rose-300'}`}
            viewBox="0 0 24 24"
            fill={isFavorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        </button>
      )}

      {/* 操作按钮 - 右下角（桌面和手机均可用） */}
      {onUseInWorkspace && (
        <button
          onClick={(e) => { e.stopPropagation(); onUseInWorkspace(); }}
          className={`flex absolute bottom-2.5 right-2.5 z-10 items-center justify-center gap-1 ${compact ? 'px-2.5 py-1' : 'px-3 py-1.5'} text-sm font-bold text-[var(--vs-on-accent)] bg-[var(--vs-primary)] hover:opacity-90 rounded-lg transition-all active:scale-[0.96] cursor-pointer`}
          title={actionLabel === '合成' ? '在合成工作台打开' : '跳转到语音合成'}
        >
          {actionLabel}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.8}>
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </article>
  );
}
