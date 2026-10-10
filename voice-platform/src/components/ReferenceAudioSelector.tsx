'use client';

import React, { useState, useEffect, useRef } from 'react';

interface SavedAudio {
  filename: string;
  url: string;
  size: number;
  createdAt: string;
  displayName: string;
  customName: boolean;
  source: 'link' | 'upload';
}

interface Props {
  onSelect: (audio: { url: string; name: string; source: 'saved' | 'link' | 'upload'; file?: File }) => void;
  currentAudio?: { url?: string; name?: string } | null;
}

export default function ReferenceAudioSelector({ onSelect, currentAudio }: Props) {
  const [mode, setMode] = useState<'link' | 'upload' | 'saved'>('link');
  const [savedAudios, setSavedAudios] = useState<SavedAudio[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [maxDuration, setMaxDuration] = useState(20); // 默认20秒（官方建议10-30秒，20秒为最佳平衡点）
  const [selectedSaved, setSelectedSaved] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 试听状态
  const [playingFile, setPlayingFile] = useState<string | null>(null);
  const [playState, setPlayState] = useState<'idle' | 'playing' | 'paused'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);

  // 重命名状态
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 提取后命名弹窗
  const [showNameModal, setShowNameModal] = useState(false);
  const [pendingAudio, setPendingAudio] = useState<{ url: string; title: string; filename?: string } | null>(null);

  // 删除确认
  const [deletingFile, setDeletingFile] = useState<string | null>(null);

  const authenticatedHeaders = (): HeadersInit => {
    const token = localStorage.getItem('auth_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const fetchOwnedAudioFile = async (url: string, filename: string): Promise<File | undefined> => {
    if (!url.startsWith('/voice-platform/api/reference-audio?')) return undefined;
    try {
      const response = await fetch(url, { headers: authenticatedHeaders() });
      if (!response.ok) return undefined;
      const blob = await response.blob();
      return new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    } catch {
      return undefined;
    }
  };

  const loadSaved = async () => {
    setLoading(true);
    try {
      const res = await fetch('/voice-platform/api/reference-audio', { headers: authenticatedHeaders() });
      const d = await res.json();
      if (d.success) setSavedAudios(d.data.files || []);
    } catch { /* 静默 */ }
    finally { setLoading(false); }
  };

  useEffect(() => { loadSaved(); }, []);

  // 试听：修复暂停bug — 手动暂停保留 playingFile 以便恢复
  const handlePreview = async (audio: SavedAudio, e: React.MouseEvent) => {
    e.stopPropagation();

    if (playingFile === audio.filename && playState === 'playing') {
      // 正在播放 → 暂停
      audioRef.current?.pause();
      setPlayState('paused');
    } else if (playingFile === audio.filename && playState === 'paused') {
      // 已暂停 → 恢复播放
      audioRef.current?.play().catch(() => {});
      setPlayState('playing');
    } else {
      // 切换其他音频
      audioRef.current?.pause();
      audioRef.current = null;
      if (audioObjectUrlRef.current) URL.revokeObjectURL(audioObjectUrlRef.current);
      try {
        const response = await fetch(audio.url, { headers: authenticatedHeaders() });
        if (!response.ok) throw new Error('REFERENCE_AUDIO_READ_FAILED');
        const objectUrl = URL.createObjectURL(await response.blob());
        audioObjectUrlRef.current = objectUrl;
        const a = new Audio(objectUrl);
        a.onended = () => { setPlayingFile(null); setPlayState('idle'); };
        a.onerror = () => { setPlayingFile(null); setPlayState('idle'); };
        audioRef.current = a;
        await a.play();
        setPlayingFile(audio.filename);
        setPlayState('playing');
      } catch {
        setPlayingFile(null);
        setPlayState('idle');
      }
    }
  };

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (audioObjectUrlRef.current) URL.revokeObjectURL(audioObjectUrlRef.current);
    };
  }, []);

  // 删除音频
  const handleDelete = async (audio: SavedAudio, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingFile) return;
    setDeletingFile(audio.filename);
    try {
      const res = await fetch('/voice-platform/api/reference-audio?filename=' + encodeURIComponent(audio.filename), {
        method: 'DELETE',
        headers: authenticatedHeaders(),
      });
      const d = await res.json();
      if (d.success) {
        if (selectedSaved === audio.filename) setSelectedSaved(null);
        if (playingFile === audio.filename) {
          audioRef.current?.pause();
          setPlayingFile(null);
          setPlayState('idle');
        }
      }
    } catch {}
    setDeletingFile(null);
    loadSaved();
  };

  // 开始重命名
  const startRename = (audio: SavedAudio, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingFile(audio.filename);
    setRenameValue(audio.displayName);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  // 保存重命名
  const saveRename = async () => {
    if (!renamingFile) return;
    try {
      await fetch('/voice-platform/api/reference-audio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authenticatedHeaders() },
        body: JSON.stringify({ filename: renamingFile, displayName: renameValue.trim() }),
      });
    } catch {}
    setRenamingFile(null);
    loadSaved();
  };

  // 选择已保存音频
  const handleSelectSaved = async (audio: SavedAudio) => {
    setSelectedSaved(audio.filename);
    const file = await fetchOwnedAudioFile(audio.url, audio.filename);
    if (!file) return;
    onSelect({ url: URL.createObjectURL(file), name: audio.displayName, source: 'saved', file });
  };

  // 从链接提取（含去重检查）
  const handleExtractLink = async () => {
    if (!linkUrl.trim()) return;
    setExtracting(true);
    try {
      const res = await fetch('/voice-platform/api/voice/link-clone/extract-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authenticatedHeaders() },
        body: JSON.stringify({ url: linkUrl.trim() }),
      });
      const d = await res.json();
      if (d.success) {
        setPendingAudio({
          url: d.data.localAudioUrl || d.data.audioUrl,
          title: d.data.title || '参考音频',
          filename: d.data.filename || undefined,
        });
        setShowNameModal(true);
        loadSaved();
      }
    } catch { /* 静默 */ }
    finally { setExtracting(false); }
  };

  // 命名确认后保存并选中
  const confirmNameAndSelect = async () => {
    if (!pendingAudio) return;
    const filename = pendingAudio.filename;
    
    const name = renameValue.trim() || pendingAudio.title;
    if (renameValue.trim() && filename) {
      try {
        await fetch('/voice-platform/api/reference-audio', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authenticatedHeaders() },
          body: JSON.stringify({ filename, displayName: renameValue.trim() }),
        });
      } catch {}
    }

    const file = pendingAudio.filename
      ? await fetchOwnedAudioFile(pendingAudio.url, pendingAudio.filename)
      : undefined;
    if (pendingAudio.url.startsWith('/voice-platform/api/reference-audio?') && !file) return;
    onSelect({
      url: file ? URL.createObjectURL(file) : pendingAudio.url,
      name,
      source: 'link',
      ...(file ? { file } : {}),
    });
    setShowNameModal(false);
    setPendingAudio(null);
    setRenameValue('');
    setLinkUrl('');
    loadSaved();
  };

  // 上传文件
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return;

    const url = URL.createObjectURL(file);
    onSelect({ url, name: file.name, source: 'upload', file });
  };

  const handleDownload = async (audio: SavedAudio, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await fetch(audio.url, { headers: authenticatedHeaders() });
      if (!response.ok) return;
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${audio.displayName}.${audio.filename.split('.').pop() || 'mp3'}`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch {}
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

      {/* 命名弹窗 */}
      {showNameModal && pendingAudio && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowNameModal(false)}>
          <div className="bg-vp-card border border-vp-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-vp-foreground mb-2">🎤 命名参考音色</h3>
            <p className="text-xs text-vp-muted-foreground mb-1">原标题：{pendingAudio.title.slice(0, 40)}</p>
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmNameAndSelect()}
              placeholder="输入自定义名称（如：老王科普）"
              maxLength={30}
              className="w-full rounded-xl border border-vp-border bg-vp-background/60 px-4 py-3 text-sm text-slate-200 placeholder:text-vp-muted-foreground focus:border-sky-400/40 focus:outline-none mb-4"
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={confirmNameAndSelect} className="flex-1 py-2.5 rounded-xl bg-sky-500/20 text-vp-primary border border-vp-border hover:bg-sky-500/30 text-sm font-medium transition-colors">
                确认并选用
              </button>
              <button onClick={() => {
                void (async () => {
                  const file = pendingAudio.filename
                    ? await fetchOwnedAudioFile(pendingAudio.url, pendingAudio.filename)
                    : undefined;
                  if (pendingAudio.url.startsWith('/voice-platform/api/reference-audio?') && !file) return;
                  onSelect({
                    url: file ? URL.createObjectURL(file) : pendingAudio.url,
                    name: pendingAudio.title,
                    source: 'link',
                    ...(file ? { file } : {}),
                  });
                  setShowNameModal(false);
                  setPendingAudio(null);
                  setLinkUrl('');
                })();
              }} className="flex-1 py-2.5 rounded-xl text-vp-muted-foreground hover:text-vp-foreground text-sm transition-colors">
                跳过命名
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 模式切换 */}
      <div className="flex items-center gap-1.5 p-1 rounded-xl bg-vp-background/60 w-fit">
        {[
          { key: 'link' as const, label: '链接提取', icon: '📎' },
          { key: 'upload' as const, label: '上传音频', icon: '📁' },
          { key: 'saved' as const, label: '已保存', icon: '💾' },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={`px-3 py-1.5 text-xs rounded-lg transition-all ${
              mode === key
                ? 'bg-sky-400/20 text-vp-primary border border-sky-400/30'
                : 'text-vp-muted-foreground hover:text-vp-foreground'
            }`}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      {/* 已保存列表 */}
      {mode === 'saved' && (
        <div>
          {loading ? (
            <div className="text-xs text-vp-muted-foreground py-4 text-center">加载中...</div>
          ) : savedAudios.length === 0 ? (
            <div className="text-xs text-vp-muted-foreground py-6 text-center border border-dashed border-slate-700/50 rounded-xl">
              <p className="mb-1">还没有保存的参考音频</p>
              <p className="text-[10px]">通过"链接提取"或"上传音频"获取后自动保存</p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1 custom-scroll">
              {savedAudios.map((audio, idx) => (
                <div
                  key={audio.filename}
                  className={`group w-full rounded-xl border transition-all ${
                    selectedSaved === audio.filename
                      ? 'bg-sky-400/10 border-sky-400/30'
                      : 'bg-vp-background/40 border-slate-700/30 hover:border-vp-border'
                  }`}
                >
                  {/* 主行：序号 + 播放 + 名称 + 操作按钮 */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    {/* 序号 */}
                    <span className="w-5 text-center text-[10px] text-vp-muted-foreground shrink-0 select-none">
                      {idx + 1}
                    </span>

                    {/* 播放/暂停/恢复 */}
                    <button
                      onClick={(e) => handlePreview(audio, e)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors"
                      title={playingFile === audio.filename && playState === 'playing' ? '暂停' : playingFile === audio.filename && playState === 'paused' ? '继续播放' : '试听'}
                    >
                      {playingFile === audio.filename && playState === 'playing' ? (
                        <svg className="w-4 h-4 text-sky-400" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : playingFile === audio.filename && playState === 'paused' ? (
                        <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.14v14l11-7-11-7z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-vp-muted-foreground group-hover:text-sky-400" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.14v14l11-7-11-7z" />
                        </svg>
                      )}
                    </button>

                    {/* 名称 + 元信息（点击选中） */}
                    <button
                      onClick={() => handleSelectSaved(audio)}
                      className="flex-1 min-w-0 text-left"
                    >
                      {renamingFile === audio.filename ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename();
                            if (e.key === 'Escape') setRenamingFile(null);
                          }}
                          onBlur={saveRename}
                          className="w-full bg-vp-background border border-sky-400/30 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none"
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          <p className="text-xs text-slate-200 truncate">{audio.displayName}</p>
                          <p className="text-[10px] text-vp-muted-foreground">
                            {formatSize(audio.size)} · {formatDate(audio.createdAt)}
                            {audio.customName && <span className="ml-1 text-sky-500">· 已命名</span>}
                          </p>
                        </>
                      )}
                    </button>

                    {/* 操作按钮组（hover显示） */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                      {/* 下载 */}
                      <button
                        onClick={(e) => void handleDownload(audio, e)}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-vp-muted-foreground hover:text-sky-400 hover:bg-sky-400/10 transition-colors"
                        title="下载"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </button>
                      {/* 重命名 */}
                      <button
                        onClick={(e) => startRename(audio, e)}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-vp-muted-foreground hover:text-sky-400 hover:bg-sky-400/10 transition-colors shrink-0"
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
                        className="w-6 h-6 rounded-md flex items-center justify-center text-vp-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors shrink-0"
                        title="删除"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>

                    {/* 选中勾 */}
                    {selectedSaved === audio.filename && (
                      <div className="w-5 h-5 rounded-full bg-sky-400/20 flex items-center justify-center shrink-0">
                        <svg className="w-3 h-3 text-vp-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
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
            className="mt-2 text-[10px] text-vp-muted-foreground hover:text-vp-muted-foreground transition-colors"
          >
            🔄 刷新列表
          </button>
          <p className="mt-1 text-[10px] text-slate-700">
                📁 持久存储：<code className="text-vp-muted-foreground">VOICE_REFERENCE_AUDIO_DIR</code>
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
              onKeyDown={(e) => e.key === 'Enter' && handleExtractLink()}
              placeholder="粘贴抖音/小红书分享链接..."
              className="flex-1 rounded-xl border border-vp-border bg-vp-background/60 px-3 py-2 text-xs text-slate-200 placeholder:text-vp-muted-foreground focus:border-sky-400/40 focus:outline-none"
            />
            <button
              onClick={handleExtractLink}
              disabled={extracting || !linkUrl.trim()}
              className="px-3 py-2 rounded-xl bg-sky-500/20 text-vp-primary border border-vp-border hover:bg-sky-500/30 text-xs font-medium transition-colors disabled:opacity-50 shrink-0"
            >
              {extracting ? '提取中...' : '提取'}
            </button>
          </div>
          {/* 截取时长选项 */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-vp-muted-foreground">截取前</span>
            {[10, 15, 20, 30].map(d => (
              <button
                key={d}
                onClick={() => setMaxDuration(d)}
                className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${
                  maxDuration === d
                    ? 'bg-sky-400/15 text-vp-primary border-sky-400/30'
                    : 'text-vp-muted-foreground border-slate-700/30 hover:border-vp-border'
                }`}
              >
                {d}秒
              </button>
            ))}
          </div>
          {currentAudio && currentAudio.url && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-400/5 border border-sky-400/15">
              <span className="text-xs text-vp-primary">🎤 {currentAudio.name || '当前参考音频'}</span>
            </div>
          )}
          <div className="p-3 rounded-xl bg-amber-400/5 border border-amber-400/10">
            <p className="text-[10px] text-amber-300/80 mb-1">
              📏 官方建议参考音频 <b className="text-amber-200">10-30秒</b>，<b className="text-amber-200">20秒</b>为最佳。太长会被截断且可能保留瑕疵。
            </p>
            <p className="text-[10px] text-amber-300/60">
              ✅ 单人声 · 低噪声 · 自然语气 · 无BGM &nbsp;|&nbsp; ❌ 多人声 · 底噪 · 情绪起伏大 · 带背景音乐
            </p>
          </div>
        </div>
      )}

      {/* 上传音频 */}
      {mode === 'upload' && (
        <div>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-xl border border-dashed border-vp-border bg-vp-background/40 px-4 py-6 text-xs text-vp-muted-foreground hover:border-sky-400/30 hover:text-vp-muted-foreground cursor-pointer transition-colors text-center"
          >
            <p className="text-sm text-vp-muted-foreground mb-1">📁 点击选择或拖拽音频文件</p>
            <p className="text-[10px] text-vp-muted-foreground">支持格式：WAV / MP3 / M4A / AAC / OGG / Opus · 最大 10MB · 建议时长 ≤30秒</p>
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
