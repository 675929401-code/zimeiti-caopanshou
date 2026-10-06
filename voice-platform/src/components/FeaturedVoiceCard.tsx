'use client';

import React, { useState, useRef, useEffect } from 'react';
import { getAvatarUrl, getInitials, getGradient } from '@/lib/avatar';
import { loadPreview } from '@/lib/preview-cache';
import type { RecommendedVoice } from '@/lib/recommended-voices';

interface FeaturedVoiceCardProps {
  voice: RecommendedVoice;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onUseInWorkspace?: () => void;
}

// 紧凑型推荐音色卡片：模拟火山官方控制台首页"推荐音色"区块的卡片样式（横向布局）
export default function FeaturedVoiceCard({ voice, isFavorite = false, onToggleFavorite, onUseInWorkspace }: FeaturedVoiceCardProps) {
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const avatarUrl = getAvatarUrl(voice.speakerId, voice.name, '');
  const initials = getInitials(voice.name);
  const gradient = getGradient('');

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewError(null);
    if (previewing && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    try {
      const { audioUrl } = await loadPreview(voice.speakerId, '');
      const audio = new Audio(audioUrl);
      audio.onended = () => setPreviewing(false);
      audio.onerror = () => { setPreviewing(false); setPreviewError('试听失败'); };
      audioRef.current = audio;
      await audio.play();
    } catch (err: any) {
      setPreviewing(false);
      setPreviewError(err.message || '试听生成失败');
    }
  };

  useEffect(() => {
    return () => { if (audioRef.current) audioRef.current.pause(); };
  }, []);

  return (
    <div className="group relative flex items-center gap-3 p-3 rounded-2xl border border-vp-border bg-vp-card/65 hover:border-sky-300/35 hover:bg-vp-background/75 transition-all duration-200">
      {/* 收藏桃心按钮 */}
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className="absolute top-2 right-2 p-1.5 rounded-lg bg-slate-950/50 border border-vp-border hover:border-rose-300/40 transition-all z-10 active:scale-[0.92]"
          title={isFavorite ? '取消收藏' : '收藏'}
        >
          <svg
            className={`w-3.5 h-3.5 transition-colors ${isFavorite ? 'text-rose-400' : 'text-vp-muted-foreground hover:text-rose-300'}`}
            viewBox="0 0 24 24"
            fill={isFavorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        </button>
      )}

      {/* 头像 + 试听按钮 */}
      <button
        onClick={handlePreview}
        disabled={previewing}
        className="relative w-12 h-12 rounded-xl overflow-hidden shrink-0 ring-1 ring-vp-primary/15 hover:ring-vp-primary/60 transition-all active:scale-[0.96]"
        title={previewing ? '停止试听' : '点击试听'}
      >
        {!imgError ? (
          <img src={avatarUrl} alt={voice.name} className="w-full h-full object-cover" onError={() => setImgError(true)} loading="lazy" />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${gradient} flex items-center justify-center text-white text-sm font-bold`}>
            {initials}
          </div>
        )}
        <div className={`absolute inset-0 bg-slate-950/55 flex items-center justify-center transition-opacity ${previewing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {previewing ? (
            <div className="flex gap-0.5">
              <span className="w-1 h-3 bg-sky-200 rounded-full animate-pulse" />
              <span className="w-1 h-3 bg-sky-200 rounded-full animate-pulse" style={{ animationDelay: '0.15s' }} />
              <span className="w-1 h-3 bg-sky-200 rounded-full animate-pulse" style={{ animationDelay: '0.3s' }} />
            </div>
          ) : (
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      </button>

      {/* 信息区 */}
      <div className="min-w-0 flex-1 pr-8">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-vp-foreground truncate">{voice.name}</h4>
          <div className="hidden sm:flex items-center gap-1">
            {voice.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-sky-300/10 text-vp-primary border border-vp-border"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-1 text-[12px] text-vp-muted-foreground leading-5 line-clamp-2">
          {voice.description}
        </p>
        {previewError && <p className="text-[11px] text-rose-300 mt-0.5">{previewError}</p>}
      </div>

      {/* 操作按钮 */}
      {onUseInWorkspace && (
        <button
          onClick={(e) => { e.stopPropagation(); onUseInWorkspace(); }}
          className="hidden sm:flex shrink-0 items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-medium text-slate-950 bg-sky-300 hover:bg-sky-200 rounded-lg transition-colors"
          title="跳转到语音合成"
        >
          使用
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
