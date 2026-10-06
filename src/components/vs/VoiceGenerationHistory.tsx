'use client';

import { useEffect, useState } from 'react';
import type { VoiceGeneration } from '@/lib/types';
import AudioDownloadButton from '@/components/vs/AudioDownloadButton';
import { canLoadVoiceHistoryForRetry, voiceHistoryRetryUnavailableReason } from '@/lib/voice-history-retry';

const PAGE_SIZE = 5;
type HistoryErrorKind = 'timeout' | 'auth' | 'response' | 'format' | 'network';
const HISTORY_ERROR_MESSAGES: Record<HistoryErrorKind, string> = {
  timeout: '读取生成历史超时，请稍后重试。',
  auth: '登录已失效或没有访问权限，请重新登录后重试。',
  response: '生成历史服务暂时无法响应，请重试。',
  format: '生成历史返回的数据格式异常，请重试。',
  network: '生成历史网络连接失败，请重试。',
};
class HistoryReadError extends Error {
  constructor(readonly kind: HistoryErrorKind) { super(kind); }
}

function playableUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export default function VoiceGenerationHistory({ token, refreshKey, onRestore }: { token?: string | null; refreshKey?: string; onRestore?: (item: VoiceGeneration) => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<VoiceGeneration[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedToken, setLoadedToken] = useState<string>();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorKind, setErrorKind] = useState<HistoryErrorKind>('network');
  const [errorDiagnostic, setErrorDiagnostic] = useState({ name: 'Error', stage: 'prepare', elapsedMs: 0 });
  const [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});

  useEffect(() => { setPage(1); }, [token, refreshKey]);
  useEffect(() => {
    setItems([]);
    setLoadedToken(undefined);
    setMediaErrors({});
    if (!open || !token) { setStatus('idle'); return; }
    const controller = new AbortController();
    setStatus('loading');
    void (async () => {
      const startedAt = Date.now();
      let readStage = 'prepare';
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
        readStage = 'request';
        const response = await fetch(`/api/voice/history?page=${page}&pageSize=${PAGE_SIZE}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
          signal,
        });
        if (response.status === 401 || response.status === 403) throw new HistoryReadError('auth');
        if (!response.ok) throw new HistoryReadError('response');
        readStage = 'decode';
        const payload = await response.json().catch((error: unknown) => {
          if (error instanceof Error && error.name === 'TimeoutError') throw error;
          throw new HistoryReadError('format');
        });
        readStage = 'validate';
        if (payload?.success !== true) throw new HistoryReadError('response');
        if (!Array.isArray(payload.data?.items)) throw new HistoryReadError('format');
        if (controller.signal.aborted) return;
        setItems(payload.data.items.filter((item: VoiceGeneration) => item && typeof item.id === 'string'));
        setTotal(Number.isFinite(payload.data.total) ? Math.max(0, payload.data.total) : 0);
        setLoadedToken(token);
        setStatus('ready');
      } catch (error) {
        if (!controller.signal.aborted) {
          const name = error instanceof Error && ['TypeError', 'TimeoutError', 'AbortError', 'SyntaxError', 'Error'].includes(error.name) ? error.name : 'Error';
          setErrorDiagnostic({ name, stage: readStage, elapsedMs: Date.now() - startedAt });
          setErrorKind(error instanceof HistoryReadError ? error.kind
            : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
          setStatus('error');
        }
      }
    })();
    return () => controller.abort();
  }, [open, token, page, revision, refreshKey]);

  useEffect(() => {
    if (!open || !token || loadedToken !== token || !items.some((item) => item.status === 'pending' || item.status === 'processing')) return;
    const refreshVisibleHistory = () => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    };
    const interval = window.setInterval(refreshVisibleHistory, 15_000);
    window.addEventListener('focus', refreshVisibleHistory);
    document.addEventListener('visibilitychange', refreshVisibleHistory);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisibleHistory);
      document.removeEventListener('visibilitychange', refreshVisibleHistory);
    };
  }, [items, loadedToken, open, token]);

  const refresh = () => { setPage(1); setRevision((value) => value + 1); };
  const visibleItems = loadedToken === token ? items : [];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const buttonClass = 'rounded-lg border border-[var(--vs-border)] px-3 py-2 text-sm hover:bg-[var(--vs-surface)] disabled:opacity-40';

  return (
    <section aria-label="生成历史" className="mb-6 rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-card)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="voice-generation-history-content" className="rounded-lg px-2 py-1 text-base font-semibold">
          {open ? '收起生成历史' : '生成历史'}
        </button>
        {open && token && <button type="button" className={buttonClass} disabled={status === 'loading'} onClick={refresh}>刷新历史</button>}
      </div>
      {open && <div id="voice-generation-history-content" className="mt-4" aria-busy={status === 'loading'}>
        {!token ? <p role="status" className="text-sm text-[var(--vs-text-muted)]">登录后可查看自己的生成历史。</p>
          : status === 'loading' || status === 'idle' || (status === 'ready' && loadedToken !== token) ? <p role="status" className="text-sm text-[var(--vs-text-muted)]">正在读取生成历史...</p>
            : status === 'error' ? <div role="alert" data-history-error={errorKind} data-history-error-name={errorDiagnostic.name} data-history-error-stage={errorDiagnostic.stage} data-history-error-ms={errorDiagnostic.elapsedMs} className="flex flex-wrap items-center gap-3 text-sm">
              <p>{HISTORY_ERROR_MESSAGES[errorKind]}</p>
              <button type="button" className={buttonClass} onClick={refresh}>重试读取历史</button>
            </div>
              : <>
                {visibleItems.length === 0 ? <p className="text-sm text-[var(--vs-text-muted)]">暂无生成记录。</p> : <ul className="space-y-3">
                  {visibleItems.map((item) => {
                    const audioUrl = item.status === 'success' ? playableUrl(item.outputAudioUrl) : undefined;
                    const canLoadForRetry = canLoadVoiceHistoryForRetry(item);
                    const awaitingReconciliation = item.terminalState === 'failed_unknown';
                    return <li key={item.id} data-generation-id={item.id} className="min-w-0 rounded-xl border border-[var(--vs-border)] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="font-medium">{item.voiceModelName || '语音合成'} · {item.status === 'success' ? '已完成' : awaitingReconciliation ? '待核对' : item.status === 'failed' ? '未完成' : '处理中'}</span>
                        <time dateTime={item.createdAt} className="text-xs text-[var(--vs-text-muted)]">{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
                      </div>
                      <p className="mt-2 break-words text-sm text-[var(--vs-text-muted)]">{(item.inputText || '').slice(0, 120)}{(item.inputText || '').length > 120 ? '…' : ''}</p>
                      {audioUrl ? <div className="mt-3 flex flex-wrap items-center gap-3">
                        <audio controls preload="none" src={audioUrl} aria-label="历史生成音频" className="max-w-full" onError={() => setMediaErrors((current) => ({ ...current, [item.id]: true }))} />
                        <AudioDownloadButton className={buttonClass} audioUrl={audioUrl} assetId={item.outputAssetId} token={token} filename={`voice-${item.id}.${item.outputFormat || 'mp3'}`}>下载历史音频</AudioDownloadButton>
                        {onRestore && <button type="button" className={buttonClass} onClick={() => onRestore(item)}>查看结果</button>}
                      </div> : <p className="mt-2 text-xs text-[var(--vs-text-muted)]">{item.status === 'success' ? '播放链接暂不可用，请刷新历史重新获取。' : awaitingReconciliation ? '任务结果与计费状态仍在核对，当前禁止重试。' : '此记录没有已交付音频。'}</p>}
                      {item.status === 'failed' && onRestore && (canLoadForRetry ? (
                          <button
                            type="button"
                            className={`${buttonClass} mt-3`}
                            title="载入原文和可恢复参数，核对音色与价格后再合成"
                            onClick={() => onRestore(item)}
                          >
                            载入后重试
                          </button>
                        ) : <p role="status" className="mt-3 text-xs text-amber-400">{voiceHistoryRetryUnavailableReason(item)}；不会自动提交。</p>
                      )}
                      {mediaErrors[item.id] && <p role="status" className="mt-2 text-xs text-amber-400">音频暂时无法播放，请刷新历史重新获取链接。</p>}
                    </li>;
                  })}
                </ul>}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="text-[var(--vs-text-muted)]">共 {total} 条 · 第 {page} / {pageCount} 页</span>
                  <div className="flex gap-2">
                    <button type="button" className={buttonClass} disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
                    <button type="button" className={buttonClass} disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button>
                  </div>
                </div>
              </>}
      </div>}
    </section>
  );
}
