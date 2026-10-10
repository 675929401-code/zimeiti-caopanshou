'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Film, Maximize2, Minimize2, Minus, Play, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';
import type { VideoTask } from '@/types/coze';
import { compactPublicVideoModelName, sortVideoHistoryBySubmission, videoHistoryTitle } from '@/lib/video-history-presentation';
import styles from './video-history-gallery.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MIN_PREVIEW_ZOOM = 70;
const MAX_PREVIEW_ZOOM = 140;
const PREVIEW_ZOOM_STEP = 10;

function clampPreviewZoom(value: number) {
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, value));
}

function shanghaiDayNumber(value: string | number | Date) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS);
  return Math.floor(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) / DAY_MS);
}

const INITIAL_SHANGHAI_DAY = shanghaiDayNumber(Date.now()) ?? 0;

function naturalDayGroup(createdAt: string, today: number) {
  const day = shanghaiDayNumber(createdAt);
  if (day === null) return { key: 'unknown', label: '时间未记录' };
  const ageDays = today - day;
  if (ageDays === 0) return { key: 'today', label: '今天' };
  if (ageDays === 1) return { key: 'yesterday', label: '昨天' };
  if (ageDays === 2) return { key: 'before-yesterday', label: '前天' };
  return { key: 'earlier', label: '更早记录' };
}

function safeImageUrl(value: string | undefined) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : '';
  } catch {
    return '';
  }
}

function videoTicketUrl(value: string | undefined) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate, 'http://video-workbench.local');
    const expectedPath = parsed.pathname === '/api/video/proxy' || parsed.pathname === '/api/video/proxy-download';
    const sameOriginPath = candidate.startsWith('/') && !candidate.startsWith('//');
    return sameOriginPath && expectedPath && parsed.searchParams.has('media_ticket') ? candidate : '';
  } catch {
    return '';
  }
}

async function requestHistoryPlaybackTicket(taskId: string, authToken: string) {
  const response = await fetch(`/api/video/access-ticket?${new URLSearchParams({ taskId, scope: 'playback' }).toString()}`, {
    headers: { Authorization: `Bearer ${authToken}` },
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({})) as { url?: string; error?: string };
  const ticketUrl = videoTicketUrl(result.url);
  const ticketPath = ticketUrl ? new URL(ticketUrl, 'http://video-workbench.local').pathname : '';
  if (!response.ok || !ticketUrl || ticketPath !== '/api/video/proxy') {
    throw new Error(result.error || '视频播放地址刷新失败');
  }
  return ticketUrl;
}

export function VideoHistoryGallery({ tasks, loading, error, onRefresh, onRetry, onDownload, selectedIds, onSelect, onLoadMore, hideFailures = false, hideToolbar = false, authToken }: {
  tasks: VideoTask[]; loading?: boolean; error?: string;
  onRefresh: () => void; onRetry?: (task: VideoTask) => void;
  onDownload?: (task: VideoTask) => void;
  selectedIds?: Set<string>; onSelect?: (id: string) => void;
  onLoadMore?: () => void;
  hideFailures?: boolean; hideToolbar?: boolean;
  authToken?: string | null;
}) {
  const [filter, setFilter] = useState('all');
  const [activePreviewTaskId, setActivePreviewTaskId] = useState<string | null>(null);
  const [activePlayback, setActivePlayback] = useState<{ taskId: string; url: string } | null>(null);
  const [loadingPreviewTaskId, setLoadingPreviewTaskId] = useState<string | null>(null);
  const [playbackErrorTaskId, setPlaybackErrorTaskId] = useState<string | null>(null);
  const [brokenPosterIds, setBrokenPosterIds] = useState<Set<string>>(() => new Set());
  const [today, setToday] = useState(INITIAL_SHANGHAI_DAY);
  const [portalReady, setPortalReady] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const previewRequestSequence = useRef(0);
  const previewShellRef = useRef<HTMLDivElement | null>(null);
  const activePreviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fullscreenWasActiveRef = useRef(false);
  const keepPreviewAfterFullscreenExitRef = useRef(false);
  useEffect(() => {
    const refreshNaturalDay = () => setToday(shanghaiDayNumber(Date.now()) ?? INITIAL_SHANGHAI_DAY);
    refreshNaturalDay();
    const timer = window.setInterval(refreshNaturalDay, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setPortalReady(true), []);
  const closePreview = useCallback(() => {
    previewRequestSequence.current += 1;
    setActivePreviewTaskId(null);
    setActivePlayback(null);
    setLoadingPreviewTaskId(null);
    setPreviewZoom(100);
    setPreviewFullscreen(false);
    fullscreenWasActiveRef.current = false;
    keepPreviewAfterFullscreenExitRef.current = false;
    const trigger = activePreviewTriggerRef.current;
    activePreviewTriggerRef.current = null;
    window.requestAnimationFrame(() => trigger?.focus());
  }, []);
  useEffect(() => {
    if (!activePreviewTaskId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      closePreview();
    };
    const onFullscreenChange = () => {
      const isPreviewFullscreen = document.fullscreenElement === previewShellRef.current;
      const exitedPreviewFullscreen = fullscreenWasActiveRef.current && !isPreviewFullscreen;
      fullscreenWasActiveRef.current = isPreviewFullscreen;
      setPreviewFullscreen(isPreviewFullscreen);
      if (exitedPreviewFullscreen) {
        const keepPreviewOpen = keepPreviewAfterFullscreenExitRef.current;
        keepPreviewAfterFullscreenExitRef.current = false;
        if (!keepPreviewOpen) closePreview();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.requestAnimationFrame(() => previewShellRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [activePreviewTaskId, closePreview]);
  const toggleFullscreen = async () => {
    const shell = previewShellRef.current;
    if (!shell) return;
    try {
      if (document.fullscreenElement === shell) {
        keepPreviewAfterFullscreenExitRef.current = true;
        await document.exitFullscreen();
      } else {
        keepPreviewAfterFullscreenExitRef.current = false;
        await shell.requestFullscreen();
      }
    } catch {
      setPreviewFullscreen(false);
    }
  };
  const openPreview = async (task: VideoTask, fallbackUrl: string, trigger: HTMLButtonElement) => {
    const requestSequence = ++previewRequestSequence.current;
    activePreviewTriggerRef.current = trigger;
    setPlaybackErrorTaskId(null);
    setLoadingPreviewTaskId(task.id);
    setActivePreviewTaskId(null);
    setActivePlayback(null);
    setPreviewZoom(100);
    try {
      const freshUrl = authToken
        ? await requestHistoryPlaybackTicket(task.id, authToken)
        : fallbackUrl;
      if (!freshUrl) throw new Error('视频播放地址不可用');
      if (requestSequence !== previewRequestSequence.current) return;
      setActivePlayback({ taskId: task.id, url: freshUrl });
      setActivePreviewTaskId(task.id);
    } catch {
      if (requestSequence === previewRequestSequence.current) setPlaybackErrorTaskId(task.id);
    } finally {
      if (requestSequence === previewRequestSequence.current) setLoadingPreviewTaskId(null);
    }
  };
  const active = (status: string) => ['pending','queued','processing','generating','finalizing','billing_pending'].includes(status);
  const labels: Record<string, string> = { pending:'等待确认', queued:'排队中', processing:'生成中', generating:'生成中', finalizing:'交付确认中', billing_pending:'费用确认中', completed:'已完成', failed:'失败', cancelled:'已取消', expired:'已过期' };
  const billingLabel = (task: VideoTask) => {
    const status = String(task.status);
    if (active(status)) return status === 'billing_pending' ? '费用：正在确认' : '费用：成功交付后扣费';
    if (task.status === 'completed') {
      return task.billingState && !['settled', 'not_required', 'exempt'].includes(task.billingState)
        ? '费用：待确认'
        : `实际扣费：¥${Number(task.priceCharged || 0).toFixed(2)}`;
    }
    if (Number(task.priceCharged || 0) > 0) return `实际扣费：¥${Number(task.priceCharged).toFixed(2)}`;
    return task.billingState && !['failed', 'submission_failed', 'not_required', 'cancelled', 'exempt'].includes(task.billingState)
      ? '费用：待确认'
      : '费用：未扣费';
  };
  const ordered = sortVideoHistoryBySubmission(tasks).filter(t => filter === 'all' || (filter === 'active' ? active(t.status) : t.status === filter));
  const groups = ordered.reduce<Array<{ key: string; label: string; tasks: VideoTask[] }>>((result, task) => {
    const group = naturalDayGroup(task.createdAt, today);
    const previous = result[result.length - 1];
    if (previous?.key === group.key) previous.tasks.push(task);
    else result.push({ key: group.key, label: group.label, tasks: [task] });
    return result;
  }, []);
  const filterOptions = [['all','全部'],['active','进行中'],['completed','已完成'], ...(!hideFailures ? [['failed','失败']] : []), ['cancelled','已取消'], ['expired','已过期']] as string[][];
  const activePreviewTask = activePreviewTaskId ? tasks.find(task => task.id === activePreviewTaskId) : undefined;
  const activePreviewSource = activePreviewTask && activePlayback?.taskId === activePreviewTask.id ? activePlayback.url : '';
  const activePreviewPoster = activePreviewTask && !brokenPosterIds.has(activePreviewTask.id)
    ? safeImageUrl(activePreviewTask.thumbnailUrl) || safeImageUrl(activePreviewTask.firstFrameUrl)
    : '';
  const previewPortal = portalReady && activePreviewTask && activePreviewSource
    ? createPortal(
      <div className={styles.previewModalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
        <div ref={previewShellRef} className={styles.previewModal} role="dialog" aria-modal="true" aria-labelledby="video-history-preview-title" tabIndex={-1}>
          <div className={styles.previewModalHeader}>
            <div>
              <strong id="video-history-preview-title">{videoHistoryTitle(activePreviewTask)}</strong>
              <span>放大预览 · 当前 {previewZoom}%</span>
            </div>
            <div className={styles.previewControls} aria-label="视频预览控制">
              <button type="button" aria-label="缩小视频" title={`缩小到最低 ${MIN_PREVIEW_ZOOM}%`} disabled={previewZoom <= MIN_PREVIEW_ZOOM} onClick={() => setPreviewZoom(value => clampPreviewZoom(value - PREVIEW_ZOOM_STEP))}><Minus size={17} /></button>
              <button type="button" aria-label="恢复 100%" title="恢复 100%" onClick={() => setPreviewZoom(100)}><RotateCcw size={16} /><span>{previewZoom}%</span></button>
              <button type="button" aria-label="放大视频" title={`放大到最高 ${MAX_PREVIEW_ZOOM}%`} disabled={previewZoom >= MAX_PREVIEW_ZOOM} onClick={() => setPreviewZoom(value => clampPreviewZoom(value + PREVIEW_ZOOM_STEP))}><Plus size={17} /></button>
              <button type="button" aria-label={previewFullscreen ? '退出全屏' : '进入全屏'} aria-pressed={previewFullscreen} title={previewFullscreen ? '退出全屏' : '进入全屏'} onClick={() => { void toggleFullscreen(); }}>{previewFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
              <button type="button" aria-label="关闭视频预览" title="关闭（ESC）" onClick={closePreview}><X size={18} /></button>
            </div>
          </div>
          <div className={styles.previewCanvas}>
            <div className={styles.previewZoomSurface} style={{ width: `${previewZoom}%`, height: `${previewZoom}%` }}>
              <video key={activePreviewSource} className={styles.previewModalVideo} controls autoPlay playsInline preload="metadata" poster={activePreviewPoster || undefined} src={activePreviewSource} aria-label={`预览 ${videoHistoryTitle(activePreviewTask)}`} onError={() => { closePreview(); setPlaybackErrorTaskId(activePreviewTask.id); }} onLoadedData={() => setPlaybackErrorTaskId(null)} />
            </div>
          </div>
          <p className={styles.previewModalHint}>缩放范围 {MIN_PREVIEW_ZOOM}%–{MAX_PREVIEW_ZOOM}% · 按 ESC 关闭</p>
        </div>
      </div>,
      document.body,
    )
    : null;

  return <><section className={styles.gallery} aria-label="视频生成历史">
    {!hideToolbar && <div className={styles.toolbar}><div><strong>视频生成记录</strong><p>按提交时间倒序 · 视频通过原始链路实时预览，源有效即可播放或下载</p></div><button type="button" onClick={onRefresh} disabled={loading}><RefreshCw size={14} />{loading ? '更新中…' : '刷新状态'}</button></div>}
    <div className={styles.filters}>{filterOptions.map(([key,label]) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.dayGroups}>{groups.map(group => <section className={styles.dayGroup} key={group.key} aria-labelledby={`video-history-${group.key}`}>
      <div className={styles.dayHeading}><h2 id={`video-history-${group.key}`}>{group.label}</h2><span>{group.tasks.length} 个任务</span></div>
      <div className={styles.grid}>{group.tasks.map(task => {
        const completed = task.status === 'completed';
        const thumbnail = safeImageUrl(task.thumbnailUrl);
        const firstFrame = safeImageUrl(task.firstFrameUrl);
        const referenceImage = safeImageUrl(task.referenceImageUrl);
        const selectedPoster = completed ? thumbnail || firstFrame : thumbnail || firstFrame || referenceImage;
        const poster = brokenPosterIds.has(task.id) ? '' : selectedPoster;
        const showingReferenceImage = !completed && Boolean(referenceImage) && selectedPoster === referenceImage;
        const playbackUrl = videoTicketUrl(task.videoUrl) || videoTicketUrl(task.storageUrl);
        const playable = completed && Boolean(authToken || playbackUrl);
        const title = videoHistoryTitle(task);
        const previewLoading = loadingPreviewTaskId === task.id;
        const playbackFailed = playbackErrorTaskId === task.id;
        const markPosterBroken = () => setBrokenPosterIds(previous => {
          const next = new Set(previous);
          next.add(task.id);
          return next;
        });
        return <article className={styles.card} key={task.id} data-video-history-task={task.id}>
          <div className={styles.preview}>
            {playable ? <button type="button" className={styles.previewTrigger} aria-label={`放大播放 ${title}`} title="放大播放视频" disabled={previewLoading} onClick={(event) => { void openPreview(task, playbackUrl, event.currentTarget); }}>
                {poster ? <img src={poster} alt="视频首帧" loading="lazy" onError={markPosterBroken} /> : <span className={styles.placeholder}><Film size={32} /><span>{previewLoading ? '正在刷新播放地址…' : playbackFailed ? '播放地址已失效，再次点击可换新' : '视频已完成'}</span></span>}
                <span className={styles.playCue} aria-hidden="true"><Play size={20} fill="currentColor" /></span>
              </button>
              : poster ? <><img src={poster} alt={showingReferenceImage ? '提交时的参考画面' : '视频首帧'} loading="lazy" onError={markPosterBroken} />{showingReferenceImage && <span className={styles.referenceBadge}>提交参考图</span>}</>
                : <div className={styles.placeholder}><Film size={32} /><span>{active(task.status) ? '生成完成后显示视频首帧' : completed ? '视频已完成，请刷新播放凭据' : '暂无视频画面'}</span></div>}
            <span className={styles.status} data-status={task.status}>{labels[task.status] || '待确认'}</span>
          </div>
          <div className={styles.details}><h3>{title}</h3><div className={styles.meta}>{compactPublicVideoModelName(task.modelName, '原模型')} · {task.resolution || task.aspectRatio || '默认规格'}{task.durationSeconds ? ` · ${task.durationSeconds}秒` : ''}</div><p className={styles.prompt} title={task.prompt}>{task.prompt || '图片或音频驱动任务'}</p>
            <p className={styles.billing} data-billing-state={task.billingState || 'unknown'}>{billingLabel(task)}</p>
            {playbackFailed && <p role="alert" className={styles.playbackError}>视频播放失败，请再次点击预览换新播放地址。</p>}
            {task.errorMessage && <p className={styles.error}>{task.errorMessage}</p>}
            <div className={styles.actions}>
              {onSelect && playable && <label><input type="checkbox" checked={selectedIds?.has(task.id) || false} onChange={() => onSelect(task.id)} />选择</label>}
              {completed && onDownload ? <button type="button" onClick={() => onDownload(task)}>下载到电脑</button> : playbackUrl ? <a href={playbackUrl} target="_blank" rel="noreferrer">打开视频</a> : null}
              {task.canRetry === true && (onRetry ? <button type="button" onClick={() => onRetry(task)}>重新提交</button> : <a href={`/video?retryTask=${encodeURIComponent(task.id)}`}>重新提交</a>)}
              {(active(task.status) || playbackFailed || completed && !playable || task.status === 'failed' && task.canRetry !== true) && <button type="button" onClick={onRefresh}>刷新状态</button>}
            </div>
          </div>
        </article>;
      })}</div>
    </section>)}</div>
    {!ordered.length && <p className={styles.empty}>{loading ? '正在读取视频历史…' : '此分类暂无视频记录'}</p>}
    {onLoadMore && <div className={styles.actions}><button type="button" onClick={onLoadMore} disabled={loading}>加载更早的提交</button></div>}
  </section>{previewPortal}</>;
}
