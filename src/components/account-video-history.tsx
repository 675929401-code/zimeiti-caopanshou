'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { VideoHistoryGallery } from './video-history-gallery';
import type { VideoTask } from '@/types/coze';

export function AccountVideoHistory({ token, surface, onRetry }: { token: string; surface: string; onRetry?: (task: VideoTask) => void }) {
  const [tasks, setTasks] = useState<VideoTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const offsetRef = useRef(0);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (offset?: number) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true);
    try {
      // A completed active task moves into the first terminal page. Refreshing
      // only the last loaded page would leave its old "processing" row forever.
      const targetOffset = offset ?? offsetRef.current;
      let pageOffset = offset ?? 0;
      let lastOffset = pageOffset;
      let nextOffset: number | null = null;
      const incoming = new Map<string, VideoTask>();
      do {
        const response = await fetch('/api/video/history?' + new URLSearchParams({ surface, limit: '200', offset: String(pageOffset) }), { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal, cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.tasks)) throw new Error('视频历史暂时无法读取');
        if (controller.signal.aborted) return;
        for (const task of result.tasks as VideoTask[]) incoming.set(task.id, task);
        lastOffset = pageOffset;
        nextOffset = Number.isSafeInteger(result.nextOffset) && result.nextOffset > pageOffset ? result.nextOffset : null;
        if (offset !== undefined || nextOffset === null || nextOffset > targetOffset) break;
        pageOffset = nextOffset;
      } while (!controller.signal.aborted);
      if (!controller.signal.aborted) {
        offsetRef.current = lastOffset;
        const refreshed = [...incoming.values()];
        setTasks(previous => offset !== undefined && offset > 0 ? Array.from(new Map([...previous, ...refreshed].map(item => [item.id, item])).values()) : refreshed);
        setNextOffset(nextOffset); setError('');
      }
    } catch { if (!controller.signal.aborted) setError('视频历史暂时无法读取，请刷新重试'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [token, surface]);
  useEffect(() => {
    offsetRef.current = 0; setTasks([]); void refresh(0);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => { window.clearInterval(timer); request.current?.abort(); };
  }, [refresh]);
  const retainedWorkbenchHistory = surface === 'storyboard-workbench' || surface === 'video-page';
  const visibleTasks = tasks;
  return <VideoHistoryGallery tasks={visibleTasks} loading={loading} error={error} onRefresh={() => { offsetRef.current = 0; void refresh(0); }} onRetry={onRetry} onLoadMore={nextOffset === null ? undefined : () => void refresh(nextOffset)} retentionDays={retainedWorkbenchHistory ? 3 : undefined} />;
}
