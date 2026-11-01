'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { workbenchUserStorageKey } from '@/lib/workbench-user-storage';

type Cursor = { before: string; beforeId: string } | null;
type ExtractionHistoryRecord = { id: string; pending?: boolean; status?: string };
export function useExtractionHistory<T extends ExtractionHistoryRecord>(token: string, userId: string) {
  const cacheKey = userId ? workbenchUserStorageKey('extract_account_history', userId) : '';
  const [history, setHistory] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [retryReady, setRetryReady] = useState(false);
  const [retryUnavailableReason, setRetryUnavailableReason] = useState('');
  const [next, setNext] = useState<Cursor>(null);
  const live = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mutating = useRef(false);
  const reloadAfterMutation = useRef(false);

  const read = useCallback(async (cursor: Cursor = null) => {
    if (!live.current || !token || !userId) return;
    if (mutating.current) { reloadAfterMutation.current = true; return; }
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const version = ++sequence.current;
    setLoading(true); setError('');
    try {
      const params = cursor ? '?before=' + encodeURIComponent(cursor.before) + '&before_id=' + cursor.beforeId : '';
      const response = await fetch('/api/extract/history' + params, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.records)) throw new Error(data.error || '提取历史暂时无法读取，请重试');
      if (!live.current || version !== sequence.current) return;
      setHistory(previous => {
        const records: T[] = cursor ? Array.from(new Map([...previous, ...data.records].map(item => [item.id, item])).values()) : data.records;
        return records;
      });
      setNext(data.next || null); setReady(true);
      setRetryReady(data.retryReady === true);
      setRetryUnavailableReason(typeof data.retryUnavailableReason === 'string' ? data.retryUnavailableReason : '');
    } catch (failure) {
      if (live.current && version === sequence.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : '提取历史读取失败');
    } finally { if (live.current && version === sequence.current) setLoading(false); }
  }, [token, userId]);

  useEffect(() => {
    live.current = true;
    setHistory([]);
    // Server history is the only durable source. Remove the retired browser
    // shadow for this account so deleted or corrected records cannot reappear.
    try { if (cacheKey) localStorage.removeItem(cacheKey); } catch { /* Browser storage may be restricted. */ }
    void read();
    return () => { live.current = false; controller.current?.abort(); };
  }, [read, cacheKey]);

  const hasActiveRecords = history.some(record => record.pending === true || ["loading", "pending", "running", "active"].includes(String(record.status || "")));
  useEffect(() => {
    if (!token || !userId) return;
    const refreshVisibleHistory = () => {
      if (document.visibilityState === "visible") void read();
    };
    // Completed-only history and initial read failures also need focus recovery.
    const interval = hasActiveRecords || Boolean(error)
      ? window.setInterval(refreshVisibleHistory, 15_000)
      : undefined;
    document.addEventListener("visibilitychange", refreshVisibleHistory);
    window.addEventListener("focus", refreshVisibleHistory);
    return () => {
      if (interval !== undefined) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisibleHistory);
      window.removeEventListener("focus", refreshVisibleHistory);
    };
  }, [token, userId, hasActiveRecords, error, read]);

  const refresh = useCallback(() => { void read(); }, [read]);
  const remove = useCallback(async (recordId?: string) => {
    if (!token || !userId || mutating.current || !ready) return;
    mutating.current = true; controller.current?.abort(); ++sequence.current;
    setLoading(true); setError('');
    let removed = false;
    try {
      const response = await fetch('/api/extract/history', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(recordId ? { recordId } : { clearAll: true }), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok || data.success !== true) throw new Error(data.error || '删除未成功，请重试');
      removed = true;
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '删除未成功，请重试'); }
    finally {
      mutating.current = false;
      if (live.current) {
        setLoading(false);
        if (removed || reloadAfterMutation.current) { reloadAfterMutation.current = false; void read(); }
      }
    }
  }, [token, userId, ready, read]);
  return { history, loading, ready, error, retryReady, retryUnavailableReason, refresh, remove, hasMore: Boolean(next), loadMore: () => { if (next && !loading) void read(next); } };
}
