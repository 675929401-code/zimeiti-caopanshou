'use client';

import React, { useState, useRef, useEffect } from 'react';
import { getAvatarUrl, getInitials, getGradient } from '@/lib/avatar';
import { loadPreview } from '@/lib/preview-cache';

interface VoiceCardProps {
  id?: string;
  speakerId: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  gender?: string;
  type?: string;
  isFavorite?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onToggleFavorite?: () => void;
  onUseInWorkspace?: () => void;
  compact?: boolean;
  showActions?: boolean;
}

export default function VoiceCard({
  id,
  speakerId,
  name,
  description,
  category,
  tags = [],
  gender,
  type = 'official',
  isFavorite = false,
  selected = false,
  onSelect,
  onToggleFavorite,
  onUseInWorkspace,
  compact = false,
  showActions = true,
}: VoiceCardProps) {
  const [previewing, setPreviewing] = useState(false);
  const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  const avatarUrl = getAvatarUrl(speakerId, name, gender);
  const initials = getInitials(name);
  const gradient = getGradient(gender);

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewError(null);
    
    // 点击同一卡片：暂停/停止
    if (previewing && previewAudio) {
      previewAudio.pause();
      previewAudio.currentTime = 0;
      setPreviewing(false);
      // 清除全局引用
      (window as any).__voicePreviewAudio = null;
      (window as any).__voicePreviewStop = null;
      return;
    }
    
    // 停止其他卡片的播放
    if ((window as any).__voicePreviewStop) {
      (window as any).__voicePreviewStop();
    }
    
    setPreviewing(true);
    try {
      const { audioUrl } = await loadPreview(speakerId, category);
      const audio = new Audio(audioUrl);
      
      // 注册全局停止函数
      (window as any).__voicePreviewAudio = audio;
      (window as any).__voicePreviewStop = () => {
        audio.pause();
        audio.currentTime = 0;
        audio.onended = null;
        audio.onerror = null;
        setPreviewing(false);
      };
      
      audio.onended = () => {
        setPreviewing(false);
        (window as any).__voicePreviewAudio = null;
        (window as any).__voicePreviewStop = null;
      };
      audio.onerror = () => { setPreviewing(false); setPreviewError('试听失败'); };
      setPreviewAudio(audio);
      await audio.play();
    } catch (err: any) {
      setPreviewing(false);
      setPreviewError(err.message || '试听生成失败');
    }
  };

  useEffect(() => {
    return () => { if (previewAudio) previewAudio.pause(); };
  }, [previewAudio]);

  return (
    <div
      onClick={onSelect}
      className={`group relative flex items-center gap-3 p-3 rounded-2xl border bg-vp-card/70 backdrop-blur-sm transition-all duration-200 ${
        onSelect ? 'cursor-pointer' : ''
      } ${
        selected
          ? 'border-sky-300/70 ring-1 ring-vp-primary/20'
          : 'border-vp-border hover:border-sky-300/35 hover:bg-vp-background/80'
      }`}
    >
      {/* 收藏桃心按钮 - 右上角 */}
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className="absolute top-1.5 right-1.5 p-1 rounded-md bg-slate-950/50 border border-vp-border hover:border-rose-300/40 transition-all z-10 active:scale-[0.92]"
          title={isFavorite ? '取消收藏' : '收藏'}
        >
          <svg
            className={`w-3 h-3 transition-colors ${isFavorite ? 'text-rose-400' : 'text-vp-muted-foreground hover:text-rose-300'}`}
            viewBox="0 0 24 24"
            fill={isFavorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        </button>
      )}

      {/* 头像 + 试听 - 缩小尺寸 */}
      <button
        onClick={handlePreview}
        className="relative w-10 h-10 rounded-lg overflow-hidden shrink-0 ring-1 ring-vp-primary/15 hover:ring-vp-primary/60 transition-all active:scale-[0.96] cursor-pointer"
        title={previewing ? '停止试听' : '点击试听'}
      >
        {!imgError ? (
          <img src={avatarUrl} alt={name} className="w-full h-full object-cover" onError={() => setImgError(true)} loading="lazy" />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${gradient} flex items-center justify-center text-white text-xs font-bold`}>
            {initials}
          </div>
        )}
        <div className={`absolute inset-0 bg-slate-950/55 flex items-center justify-center transition-opacity ${previewing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {previewing ? (
            <div className="flex gap-0.5">
              <span className="w-0.5 h-2 bg-sky-200 rounded-full animate-pulse" />
              <span className="w-0.5 h-2 bg-sky-200 rounded-full animate-pulse" style={{ animationDelay: '0.15s' }} />
              <span className="w-0.5 h-2 bg-sky-200 rounded-full animate-pulse" style={{ animationDelay: '0.3s' }} />
            </div>
          ) : (
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      </button>

      {/* 信息区 */}
      <div className="min-w-0 flex-1 pr-6">
        <h4 className="text-xs font-semibold text-vp-foreground truncate leading-4">{name}</h4>
        {previewError && <p className="text-[10px] text-rose-300 mt-0.5">{previewError}</p>}
      </div>

      {/* 操作按钮 - 缩小 */}
      {onUseInWorkspace && (
        <button
          onClick={(e) => { e.stopPropagation(); onUseInWorkspace(); }}
          className="hidden md:flex shrink-0 items-center justify-center gap-1 px-2 py-1 text-[10px] font-medium text-slate-950 bg-sky-300 hover:bg-sky-200 rounded-md transition-colors"
          title="跳转到语音合成"
        >
          合成
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
