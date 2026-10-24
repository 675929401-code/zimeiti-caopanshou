'use client';

import React, { useState, useEffect, useRef } from 'react';
import AudioPlayer from '@/components/vs/AudioPlayer';
import { readBrowserWorkbenchIdentity } from '@/lib/workbench-user-storage';
import {
  MAX_REFERENCE_AUDIO_BYTES,
  REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS,
  REFERENCE_AUDIO_DURATION_OPTIONS,
  REFERENCE_AUDIO_MAX_DURATION_SECONDS,
  REFERENCE_AUDIO_MIN_DURATION_SECONDS,
} from '@/lib/vs/reference-audio-contract';
import { extractReferenceAudioFromShareLink } from '@/lib/vs/reference-audio-extraction';
import {
  ReferenceAudioChargeConfirm,
  ReferenceAudioRuntimeStatus,
  useReferenceAudioRuntimeGate,
} from '@/components/vs/ReferenceAudioExtractionGate';

interface SavedAudio {
  id: string;
  url: string;
  size: number;
  createdAt: string;
  name: string;
  format: string;
}

interface Props {
  onSelect: (audio: { url: string; name: string; source: 'saved' | 'link' | 'upload'; file?: File; assetId?: string }) => void;
  currentAudio?: { url?: string; name?: string } | null;
}

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem('auth_token');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export default function ReferenceAudioSelector({ onSelect, currentAudio }: Props) {
  const [mode, setMode] = useState<'link' | 'upload' | 'saved'>('link');
  const [savedAudios, setSavedAudios] = useState<SavedAudio[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [runtimeToken, setRuntimeToken] = useState('');
  const [showChargeConfirm, setShowChargeConfirm] = useState(false);
  const [maxDuration, setMaxDuration] = useState(REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS);
  const [selectedSaved, setSelectedSaved] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 试听状态
  const [playingFile, setPlayingFile] = useState<string | null>(null);
  const [playState, setPlayState] = useState<'idle' | 'playing' | 'paused'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 重命名状态
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 提取后命名弹窗
  const [showNameModal, setShowNameModal] = useState(false);
  const [pendingAudio, setPendingAudio] = useState<{ voice: SavedAudio; title: string } | null>(null);
  const [actionError, setActionError] = useState('');

  // 删除确认
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const runtimeGate = useReferenceAudioRuntimeGate(runtimeToken);

  useEffect(() => {
    setRuntimeToken(localStorage.getItem('auth_token') || '');
  }, []);

  const loadSaved = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/voice/upload', { headers: authHeaders() });
      const d = await res.json();
      if (res.ok && d.success && Array.isArray(d.voices)) {
        setSavedAudios(d.voices.map((voice: SavedAudio) => ({
          id: String(voice.id || ''),
          url: String(voice.url || ''),
          size: Number(voice.size || 0),
          createdAt: String(voice.createdAt || ''),
          name: String(voice.name || '未命名参考音频'),
          format: String(voice.format || 'WAV'),
        })).filter((voice: SavedAudio) => Boolean(voice.id && voice.url)));
        setActionError('');
      } else if (res.status === 401) {
        setSavedAudios([]);
        setActionError('登录后才能读取云端参考音频。');
      } else {
        setSavedAudios([]);
        setActionError(d.error || '参考音频列表暂时无法读取，请稍后刷新。');
      }
    } catch {
      setSavedAudios([]);
      setActionError('参考音频列表加载失败，请检查网络后刷新。');
    }
    finally { setLoading(false); }
  };

  useEffect(() => { loadSaved(); }, []);

  // 试听：修复暂停bug — 手动暂停保留 playingFile 以便恢复
  const handlePreview = async (audio: SavedAudio, e: React.MouseEvent) => {
    e.stopPropagation();
    setActionError('');

    if (playingFile === audio.id && playState === 'playing') {
      // 正在播放 → 暂停
      audioRef.current?.pause();
      setPlayState('paused');
    } else if (playingFile === audio.id && playState === 'paused') {
      // 已暂停 → 恢复播放
      try {
        await audioRef.current?.play();
        setPlayState('playing');
      } catch {
        setPlayState('paused');
        setActionError('试听未能开始，音频地址可能已过期；列表已刷新，请重新试听。');
        void loadSaved();
      }
    } else {
      // 切换其他音频
      audioRef.current?.pause();
      audioRef.current = null;
      const a = new Audio(audio.url);
      a.onended = () => { setPlayingFile(null); setPlayState('idle'); };
      a.onerror = () => {
        setPlayingFile(null);
        setPlayState('idle');
        setActionError('音频加载失败，音频地址可能已过期；列表已刷新，请重新试听。');
        void loadSaved();
      };
      audioRef.current = a;
      setPlayingFile(audio.id);
      try {
        await a.play();
        setPlayState('playing');
      } catch {
        setPlayingFile(null);
        setPlayState('idle');
        setActionError('浏览器未能播放该音频；列表已刷新，请重新试听。');
        void loadSaved();
      }
    }
  };

  useEffect(() => {
    return () => { audioRef.current?.pause(); };
  }, []);

  // 删除音频
  const handleDelete = async (audio: SavedAudio, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingFile) return;
    if (!window.confirm(`确认删除参考音频“${audio.name}”？删除后无法恢复。`)) return;
    setDeletingFile(audio.id);
    try {
      const res = await fetch('/api/voice/upload', {
        method: 'DELETE',
        headers: authHeaders(true),
        body: JSON.stringify({ id: audio.id }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        if (selectedSaved === audio.id) setSelectedSaved(null);
        if (playingFile === audio.id) {
          audioRef.current?.pause();
          setPlayingFile(null);
          setPlayState('idle');
        }
      } else {
        setActionError(d.error || '删除参考音频失败');
      }
    } catch { setActionError('删除参考音频失败'); }
    setDeletingFile(null);
    void loadSaved();
  };

  // 开始重命名
  const startRename = (audio: SavedAudio, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingFile(audio.id);
    setRenameValue(audio.name);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  // 保存重命名
  const saveRename = async () => {
    if (!renamingFile) return;
    try {
      const response = await fetch('/api/voice/upload', {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify({ id: renamingFile, name: renameValue.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success !== true) {
        setActionError(payload.error || '参考音频重命名失败');
        return;
      }
      setActionError('');
    } catch {
      setActionError('参考音频重命名失败，请稍后重试。');
      return;
    }
    setRenamingFile(null);
    loadSaved();
  };

  // 选择已保存音频
  const handleSelectSaved = (audio: SavedAudio) => {
    setSelectedSaved(audio.id);
    onSelect({ url: audio.url, name: audio.name, source: 'saved', assetId: audio.id });
  };

  // 从链接提取（含去重检查）
  const requestExtractLink = () => {
    if (!linkUrl.trim() || extracting) return;
    if (!runtimeGate.ready) {
      setActionError('视频解析通道或价格尚未就绪，暂不能提交链接提取。');
      return;
    }
    setActionError('');
    setShowChargeConfirm(true);
  };

  const handleExtractLink = async () => {
    if (!linkUrl.trim()) return;
    const identity = readBrowserWorkbenchIdentity();
    const token = localStorage.getItem('auth_token') || '';
    if (!identity?.userId || !token) {
      setActionError('登录后才能从分享链接提取参考音频。');
      return;
    }
    setExtracting(true);
    setShowChargeConfirm(false);
    setActionError('');
    try {
      const extracted = await extractReferenceAudioFromShareLink({
        shareText: linkUrl,
        duration: maxDuration,
        userId: identity.userId,
        token,
      });
      setPendingAudio({
        title: extracted.name,
        voice: {
          id: extracted.assetId,
          url: extracted.url,
          size: extracted.size,
          createdAt: extracted.createdAt,
          name: extracted.name,
          format: extracted.format,
        },
      });
      setRenameValue(extracted.name);
      setShowNameModal(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '链接音频提取失败');
    }
    finally { setExtracting(false); }
  };

  const persistAndSelectPending = async (requestedName: string) => {
    if (!pendingAudio) return;
    const name = requestedName.trim() || pendingAudio.title;
    let selectedUrl = pendingAudio.voice.url;
    try {
      const response = await fetch('/api/voice/upload', {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify({ id: pendingAudio.voice.id, name }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.success && payload.voice?.url) {
        selectedUrl = String(payload.voice.url);
        setActionError('');
      } else {
        setActionError(payload.error || '名称保存失败，请修正后重试。');
        return;
      }
    } catch {
      setActionError('名称保存失败，请稍后重试。');
      return;
    }
    onSelect({ url: selectedUrl, name, source: 'link', assetId: pendingAudio.voice.id });
    setShowNameModal(false);
    setPendingAudio(null);
    setRenameValue('');
    setLinkUrl('');
    loadSaved();
  };

  // 命名确认后保存并选中
  const confirmNameAndSelect = async () => {
    await persistAndSelectPending(renameValue);
  };

  // 上传文件
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_REFERENCE_AUDIO_BYTES) {
      setActionError('参考音频不能超过 15MB，请压缩或截短后重试。');
      e.target.value = '';
      return;
    }

    const localUrl = URL.createObjectURL(file);
    const form = new FormData();
    form.set('file', file);
    form.set('name', file.name.replace(/\.[^/.]+$/, ''));
    let selectedUrl = localUrl;
    let selectedAssetId = '';
    try {
      const response = await fetch('/api/voice/upload', {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.success && payload.voice?.url) {
        selectedUrl = String(payload.voice.url);
        selectedAssetId = String(payload.voice.id || '');
        setActionError('');
        void loadSaved();
      } else {
        setActionError(payload.error || '参考音频校验或云端保存失败，未选用该文件');
        URL.revokeObjectURL(localUrl);
        return;
      }
    } catch {
      setActionError('参考音频云端保存失败，未选用该文件');
      URL.revokeObjectURL(localUrl);
      return;
    }
    onSelect({
      url: selectedUrl,
      name: file.name,
      source: 'upload',
      file,
      assetId: selectedAssetId || undefined,
    });
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-4">
      {/* 隐藏的 audio 元素 */}
      <audio ref={audioRef as any} className="hidden" />
      {actionError && (
        <div className="rounded-xl border border-[var(--vs-border)] bg-[var(--vs-control-bg)] px-3 py-2 text-sm text-[var(--vs-text-secondary)]">
          {actionError}
        </div>
      )}

      <ReferenceAudioChargeConfirm
        open={showChargeConfirm}
        priceLabel={runtimeGate.priceLabel}
        busy={extracting}
        onCancel={() => setShowChargeConfirm(false)}
        onConfirm={() => void handleExtractLink()}
      />

      {/* 命名弹窗 */}
      {showNameModal && pendingAudio && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowNameModal(false)}>
          <div className="bg-[var(--vs-surface)] border border-[var(--vs-border)] rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-[var(--vs-text)] mb-2">确认参考音频</h3>
            <p className="text-sm text-[var(--vs-text-muted)] mb-1">原标题：{pendingAudio.title.slice(0, 40)}</p>
            <div className="my-4">
              <AudioPlayer audioUrl={pendingAudio.voice.url} />
            </div>
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmNameAndSelect()}
              placeholder="输入自定义名称（如：老王科普）"
              maxLength={30}
              className="w-full rounded-xl border border-[var(--vs-border)] bg-[var(--vs-control-bg)] px-4 py-3 text-sm text-[var(--vs-text)] placeholder:text-[var(--vs-text-muted)] focus:border-[var(--vs-primary)] focus:outline-none mb-4"
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={confirmNameAndSelect} className="flex-1 py-2.5 rounded-xl bg-[var(--vs-primary)] text-[var(--vs-on-accent)] border border-[var(--vs-primary)] hover:opacity-90 text-sm font-medium transition-colors">
                确认并选用
              </button>
              <button onClick={() => void persistAndSelectPending(pendingAudio.title)} className="flex-1 py-2.5 rounded-xl text-[var(--vs-text-secondary)] hover:text-[var(--vs-text)] text-sm transition-colors">
                使用原标题
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 模式切换 */}
      <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[var(--vs-surface)]/60 w-fit">
        {[
          { key: 'link' as const, label: '链接提取' },
          { key: 'upload' as const, label: '上传音频' },
          { key: 'saved' as const, label: '已保存' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            aria-pressed={mode === key}
            className={`px-3 py-1.5 text-sm rounded-lg transition-all ${
              mode === key
                ? 'bg-[var(--vs-control-hover)] text-[var(--vs-primary)] border border-[var(--vs-primary)]'
                : 'text-[var(--vs-text-secondary)] hover:text-[var(--vs-text)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 已保存列表 */}
      {mode === 'saved' && (
        <div>
          {loading ? (
            <div className="text-sm text-[var(--vs-text-muted)] py-4 text-center">加载中...</div>
          ) : savedAudios.length === 0 ? (
            <div className="text-sm text-[var(--vs-text-muted)] py-6 text-center border border-dashed border-[var(--vs-border)] rounded-xl">
              <p className="mb-1">还没有保存的参考音频</p>
              <p className="text-sm">通过“链接提取”或“上传音频”获取后自动保存</p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1 custom-scroll">
              {savedAudios.map((audio, idx) => (
                <div
                  key={audio.id}
                  className={`group w-full rounded-xl border transition-all ${
                    selectedSaved === audio.id
                      ? 'bg-[var(--vs-control-hover)] border-[var(--vs-primary)]'
                      : 'bg-[var(--vs-control-bg)] border-[var(--vs-border)] hover:border-[var(--vs-primary)]'
                  }`}
                >
                  {/* 主行：序号 + 播放 + 名称 + 操作按钮 */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    {/* 序号 */}
                    <span className="w-5 text-center text-sm text-[var(--vs-text-muted)] shrink-0 select-none">
                      {idx + 1}
                    </span>

                    {/* 播放/暂停/恢复 */}
                    <button
                      onClick={(e) => handlePreview(audio, e)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors"
                      title={playingFile === audio.id && playState === 'playing' ? '暂停' : playingFile === audio.id && playState === 'paused' ? '继续播放' : '试听'}
                    >
                      {playingFile === audio.id && playState === 'playing' ? (
                          <svg className="w-4 h-4 text-[var(--vs-primary)]" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : playingFile === audio.id && playState === 'paused' ? (
                        <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.14v14l11-7-11-7z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-[var(--vs-text-muted)] group-hover:text-[var(--vs-primary)]" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.14v14l11-7-11-7z" />
                        </svg>
                      )}
                    </button>

                    {/* 名称 + 元信息（点击选中） */}
                    <div className="flex-1 min-w-0 text-left">
                      {renamingFile === audio.id ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename();
                            if (e.key === 'Escape') setRenamingFile(null);
                          }}
                          onBlur={saveRename}
                           className="w-full bg-[var(--vs-surface)] border border-[var(--vs-primary)] rounded-lg px-2 py-1 text-sm text-[var(--vs-text)] focus:outline-none"
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <button type="button" onClick={() => handleSelectSaved(audio)} className="block w-full min-w-0 text-left">
                          <p className="text-sm text-[var(--vs-text)] truncate">{audio.name}</p>
                          <p className="text-sm text-[var(--vs-text-muted)]">
                            {formatSize(audio.size)} · {formatDate(audio.createdAt)} · {audio.format}
                          </p>
                        </button>
                      )}
                    </div>

                    {/* 操作按钮组（hover显示） */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                      {/* 下载 */}
                      <a
                        href={audio.url}
                        download={`${audio.name}.${audio.format.toLowerCase() || 'wav'}`}
                        onClick={(e) => e.stopPropagation()}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--vs-text-muted)] hover:text-[var(--vs-primary)] hover:bg-[var(--vs-control-hover)] transition-colors"
                        title="下载"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </a>
                      {/* 重命名 */}
                      <button
                        onClick={(e) => startRename(audio, e)}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--vs-text-muted)] hover:text-[var(--vs-primary)] hover:bg-[var(--vs-control-hover)] transition-colors shrink-0"
                        title="重命名"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      {/* 删除 */}
                      <button
                        onClick={(e) => handleDelete(audio, e)}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--vs-text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors shrink-0"
                        title="删除"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>

                    {/* 选中勾 */}
                    {selectedSaved === audio.id && (
                      <div className="w-5 h-5 rounded-full bg-[var(--vs-control-hover)] flex items-center justify-center shrink-0">
                        <svg className="w-3 h-3 text-[var(--vs-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={loadSaved}
            className="mt-2 text-sm text-[var(--vs-text-muted)] hover:text-[var(--vs-text)] transition-colors"
          >
            刷新列表
          </button>
          <p className="mt-1 text-sm text-[var(--vs-text-muted)]">
                持久存储：<code className="text-[var(--vs-text-muted)]">VOICE_REFERENCE_AUDIO_DIR</code>
          </p>
        </div>
      )}

      {/* 链接提取 */}
      {mode === 'link' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && requestExtractLink()}
              placeholder="粘贴抖音/小红书分享链接..."
              className="flex-1 rounded-xl border border-[var(--vs-border)] bg-[var(--vs-control-bg)] px-3 py-2 text-sm text-[var(--vs-text)] placeholder:text-[var(--vs-text-muted)] focus:border-[var(--vs-primary)] focus:outline-none"
            />
            <button
              onClick={requestExtractLink}
              disabled={extracting || !linkUrl.trim() || !runtimeGate.ready}
              className="px-3 py-2 rounded-xl bg-[var(--vs-primary)] text-[var(--vs-on-accent)] border border-[var(--vs-primary)] hover:opacity-90 text-sm font-medium transition-colors disabled:opacity-50 shrink-0"
            >
              {extracting ? '提取中...' : '提取'}
            </button>
          </div>
          <ReferenceAudioRuntimeStatus gate={runtimeGate} />
          {/* 截取时长选项 */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--vs-text-muted)]">截取前</span>
            {REFERENCE_AUDIO_DURATION_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => setMaxDuration(d)}
                className={`px-2 py-1 text-sm rounded-md border transition-colors ${
                  maxDuration === d
                    ? 'bg-[var(--vs-control-hover)] text-[var(--vs-primary)] border-[var(--vs-primary)]'
                    : 'text-[var(--vs-text-muted)] border-[var(--vs-border)] hover:border-[var(--vs-primary)]'
                }`}
              >
                {d}秒
              </button>
            ))}
          </div>
          {currentAudio && currentAudio.url && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--vs-control-bg)] border border-[var(--vs-border)]">
              <span className="text-sm text-[var(--vs-text)]">{currentAudio.name || '当前参考音频'}</span>
            </div>
          )}
          <div className="p-3 rounded-xl bg-[var(--vs-control-bg)] border border-[var(--vs-border)]">
            <p className="text-sm text-[var(--vs-text-secondary)] mb-1">
              官方支持参考音频 <b className="text-[var(--vs-text)]">{REFERENCE_AUDIO_MIN_DURATION_SECONDS}-{REFERENCE_AUDIO_MAX_DURATION_SECONDS}秒</b>，<b className="text-[var(--vs-text)]">20秒</b>为推荐值。太长会被截断且可能保留瑕疵。
            </p>
            <p className="text-sm text-[var(--vs-text-muted)]">
              推荐：单人声、低噪声、自然语气、无背景音乐；避免多人声、明显底噪或强背景音乐。
            </p>
          </div>
        </div>
      )}

      {/* 上传音频 */}
      {mode === 'upload' && (
        <div>
          <div
            role="button"
            tabIndex={0}
            aria-label="选择参考音频文件"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className="w-full rounded-xl border border-dashed border-[var(--vs-border)] bg-[var(--vs-control-bg)] px-4 py-6 text-sm text-[var(--vs-text-muted)] hover:border-[var(--vs-primary)] hover:text-[var(--vs-text)] cursor-pointer transition-colors text-center"
          >
            <p className="text-sm text-[var(--vs-text-muted)] mb-1">点击选择音频文件</p>
            <p className="text-sm text-[var(--vs-text-muted)]">支持 WAV / MP3 / M4A / AAC / OGG / Opus · 最大 15MB · 真实时长 14–30 秒</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.opus"
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>
      )}
    </div>
  );
}
