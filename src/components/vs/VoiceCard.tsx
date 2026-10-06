'use client';
import VoicePortrait from '@/components/vs/VoicePortrait';

import React, { useState, useRef, useEffect } from 'react';
import { getAvatarUrl, getInitials, getGradient } from '@/lib/vs/avatar';
import { loadPreview, clearCachedPreview } from '@/lib/vs/preview-cache';

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

type VoicePreviewWindow = Window & {
  __voicePreviewAudio?: HTMLAudioElement | null;
  __voicePreviewStop?: (() => void) | null;
};

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
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  const avatarUrl = getAvatarUrl(speakerId, name, gender);
  const initials = getInitials(name);
  const gradient = getGradient(gender);

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewError(null);
    const previewWindow = window as VoicePreviewWindow;

    // 点击同一卡片：暂停/停止
    const previewAudio = previewAudioRef.current;
    if (previewing && previewAudio) {
      previewAudio.pause();
      previewAudio.currentTime = 0;
      previewAudioRef.current = null;
      setPreviewing(false);
      previewWindow.__voicePreviewAudio = null;
      previewWindow.__voicePreviewStop = null;
      return;
    }

    // 停止其他卡片的播放
    if (previewWindow.__voicePreviewStop) {
      previewWindow.__voicePreviewStop();
    }

    setPreviewing(true);
    try {
      const { audioUrl } = await loadPreview(speakerId, category);
      const audio = new Audio();
      previewAudioRef.current = audio;

      previewWindow.__voicePreviewAudio = audio;
      previewWindow.__voicePreviewStop = () => {
        audio.pause();
        audio.currentTime = 0;
        audio.onended = null;
        audio.onerror = null;
        setPreviewing(false);
      };

      audio.onended = () => {
        setPreviewing(false);
        previewWindow.__voicePreviewAudio = null;
        previewWindow.__voicePreviewStop = null;
      };
      audio.onerror = () => {
        console.error('[VoiceCard Preview] audio.onerror:', { speakerId, errorCode: audio.error?.code });
        setPreviewing(false);
        void clearCachedPreview(speakerId);setPreviewError('音频加载失败，请点击重新试听');

      };
      audio.src = audioUrl;
      audio.load();

      // 等待浏览器解码完成
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 10000);
        audio.oncanplaythrough = () => { clearTimeout(timeout); resolve(); };
        const origError = audio.onerror;
        audio.onerror = (e) => {
          clearTimeout(timeout);
          if (origError) origError.call(audio, e);
          reject(new Error('音频加载失败'));
        };
      });

      await audio.play();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      setPreviewing(false);
      console.error('[VoiceCard Preview] error:', { speakerId, error: err.message, errorName: err.name });
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPreviewError('浏览器拦截了自动播放，请再次点击试听');
      } else if (err.message?.includes('429')) {
        setPreviewError('试听请求过于频繁，请稍后再试');
      } else {
        setPreviewError(err.message || '试听失败，请稍后重试');
      }

    }
  };

  useEffect(() => {
    return () => { previewAudioRef.current?.pause(); };
  }, []);

  return (
    <div
      onClick={onSelect}
      className={`group relative flex items-stretch gap-3 p-3.5 rounded-2xl border-2 bg-gradient-to-br from-[var(--vs-surface)]/85 to-[var(--vs-surface)]/55 backdrop-blur-sm transition-all duration-200 h-[112px] ${
        onSelect ? 'cursor-pointer' : ''
      } ${
        selected
          ? 'border-[var(--vs-accent)]/80 ring-2 ring-[var(--vs-accent)]/25 shadow-lg shadow-[var(--vs-accent)]/15'
          : 'border-[var(--vs-border)] hover:border-[var(--vs-accent)]/55 hover:shadow-md hover:shadow-[var(--vs-accent)]/10 hover:-translate-y-0.5'
      }`}
    >
      {/* 收藏桃心按钮 - 右上角 */}
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className={`absolute top-2.5 right-2.5 p-1.5 rounded-lg border transition-all z-10 active:scale-[0.92] cursor-pointer ${
            isFavorite
              ? 'bg-rose-500/20 border-rose-400/60 hover:bg-rose-500/30'
              : 'bg-[var(--vs-bg)]/60 border-[var(--vs-border)] hover:border-rose-300/60'
          }`}
          title={isFavorite ? '取消收藏' : '收藏'}
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

      {/* 头像 + 试听 */}
      <button
        onClick={handlePreview}
        className="relative w-14 h-14 self-center rounded-xl overflow-hidden shrink-0 ring-2 ring-[var(--vs-border)] hover:ring-[var(--vs-accent)]/70 transition-all active:scale-[0.96] cursor-pointer shadow-md"
        title={previewing ? '停止试听' : '点击试听'}
      >
        <VoicePortrait speakerId={speakerId} name={name} gender={gender} />
        <div className={`absolute inset-0 bg-[var(--vs-bg)]/65 flex items-center justify-center transition-opacity ${previewing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {previewing ? (
            <div className="flex gap-0.5">
              <span className="w-0.5 h-2.5 bg-sky-200 rounded-full animate-pulse" />
              <span className="w-0.5 h-2.5 bg-sky-200 rounded-full animate-pulse" style={{ animationDelay: '0.15s' }} />
              <span className="w-0.5 h-2.5 bg-sky-200 rounded-full animate-pulse" style={{ animationDelay: '0.3s' }} />
            </div>
          ) : (
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>
      </button>

      {/* 信息区 - 名字 + 描述，不截断名字 */}
      <div className="min-w-0 flex-1 flex flex-col justify-center pr-9">
        <h4 className="text-[15px] font-bold text-[var(--vs-text)] leading-5 line-clamp-1" title={name}>{name}</h4>
        {description && <p className="text-[13px] font-medium text-[var(--vs-text-secondary)] leading-[18px] line-clamp-2 mt-1" title={description}>{description}</p>}
        {previewError && <p className="text-[11px] text-rose-300 mt-0.5 leading-4">{previewError}</p>}
      </div>

      {/* 操作按钮 - 紧凑 + 醒目 */}
      {onUseInWorkspace && (
        <button
          onClick={(e) => { e.stopPropagation(); onUseInWorkspace(); }}
          className="hidden md:flex shrink-0 self-center items-center justify-center gap-1 px-3 py-1.5 text-[12px] font-bold text-[var(--vs-bg)] bg-gradient-to-r from-[var(--vs-accent)] to-[var(--vs-primary)] hover:from-[var(--vs-accent)]/90 hover:to-[var(--vs-primary)]/90 rounded-lg transition-all shadow-md shadow-[var(--vs-accent)]/25 hover:shadow-lg hover:shadow-[var(--vs-accent)]/40 active:scale-[0.96] cursor-pointer"
          title="跳转到语音合成"
        >
          合成
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.8}>
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
