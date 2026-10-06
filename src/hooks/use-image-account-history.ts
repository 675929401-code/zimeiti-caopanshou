'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Item = { assetId: string; historyRecordId: string; prompt: string };
type RecordShape = { id: string; createdAt: number; mode: string; aspectRatio: string; modelName: string; resolution?: string; items: Item[] };
type Saved = { id: string; deleted: boolean };

export function useImageAccountHistory<T extends RecordShape>(token: string, retiredCacheKey: string) {
  const [history, setHistory] = useState<T[]>([]);
  const known = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const writing = useRef(false);

  const api = useCallback(async (path: string, options: RequestInit, signal: AbortSignal) => {
    const response = await fetch('/api/image-workbench/history' + path, { ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '账户历史同步失败，请重试');
    return result;
  }, [token]);

  const upload = useCallback(async (records: T[], signal: AbortSignal) => {
    const deleted = new Set<string>();
    // Import browser history in small batches without sending temporary URLs.
    for (let index = 0; index < records.length; index += 1) {
      if (signal.aborted) return deleted;
      const record = records[index];
      if (known.current.has(record.id)) continue;
      const result = await api('', { method: 'POST', body: JSON.stringify({ records: [{
        id: record.id, mode: record.mode, aspectRatio: record.aspectRatio, modelName: record.modelName,
        resolution: record.resolution,
        items: record.items.map(item => ({ assetId: item.assetId, historyRecordId: item.historyRecordId, prompt: item.prompt })),
      }] }) }, signal);
      if (signal.aborted) return deleted;
      for (const saved of result.saved as Saved[]) {
        known.current.add(saved.id);
        if (saved.deleted) deleted.add(saved.id);
      }
    }
    return deleted;
  }, [api]);

  const loadFirstPage = useCallback(async (signal: AbortSignal, deleted = new Set<string>()) => {
    const result = await api('?page=1', {}, signal);
    if (signal.aborted) return;
    if (!Array.isArray(result.records)) throw new Error('账户历史格式异常，请重试');
    for (const record of result.records as T[]) known.current.add(record.id);
    setHistory(current => {
      const pending = current.filter(record => !known.current.has(record.id) && !deleted.has(record.id));
      return [...pending, ...result.records].sort((a: T, b: T) => b.createdAt - a.createdAt);
    });
    setNextPage(result.nextPage);
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    writing.current = true;
    setReady(false); setSyncing(true); setError('');
    known.current.clear();
    // Account history is authoritative. Remove the retired browser copy so a
    // later page visit cannot re-import old records or create duplicate writes.
    try { localStorage.removeItem(retiredCacheKey); } catch { /* Browser storage may be unavailable. */ }
    void (async () => {
      try {
        await loadFirstPage(controller.signal);
        if (!controller.signal.aborted) setReady(true);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '账户历史同步失败');
      } finally {
        if (!controller.signal.aborted) { writing.current = false; setSyncing(false); }
      }
    })();
    return () => controller.abort();
  }, [retiredCacheKey, loadFirstPage, reload]);

  useEffect(() => {
    if (!ready || error || writing.current || !lifetime.current) return;
    const pending = history.filter(record => !known.current.has(record.id));
    if (!pending.length) return;
    const signal = lifetime.current.signal;
    writing.current = true; setSyncing(true);
    void (async () => {
      try { const deleted = await upload(pending, signal); await loadFirstPage(signal, deleted); }
      catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : '账户历史同步失败'); }
      finally { if (!signal.aborted) { writing.current = false; setSyncing(false); } }
    })();
  }, [history, ready, syncing, error, upload, loadFirstPage]);

  const refresh = useCallback(() => setReload(value => value + 1), []);
  const remove = useCallback(async (id?: string) => {
    if (!ready || writing.current || !lifetime.current) return;
    const signal = lifetime.current.signal;
    writing.current = true; setSyncing(true); setError('');
    try {
      await api(id ? '?id=' + encodeURIComponent(id) : '?all=1', { method: 'DELETE' }, signal);
      if (signal.aborted) return;
      setHistory(current => id ? current.filter(record => record.id !== id) : []);
      await loadFirstPage(signal);
    } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : '删除历史失败'); }
    finally { if (!signal.aborted) { writing.current = false; setSyncing(false); } }
  }, [api, loadFirstPage, ready]);

  const loadMore = useCallback(async () => {
    if (!nextPage || writing.current || !lifetime.current) return;
    const signal = lifetime.current.signal;
    writing.current = true; setSyncing(true); setError('');
    try {
      const result = await api('?page=' + nextPage, {}, signal);
      if (signal.aborted) return;
      if (!Array.isArray(result.records)) throw new Error('账户历史格式异常，请重试');
      for (const record of result.records as T[]) known.current.add(record.id);
      setHistory(current => [...new Map([...current, ...result.records].map((record: T) => [record.id, record])).values()]);
      setNextPage(result.nextPage);
    } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : '读取历史失败'); }
    finally { if (!signal.aborted) { writing.current = false; setSyncing(false); } }
  }, [api, nextPage]);

  return { history, setHistory, ready, syncing, error, refresh, remove, loadMore, hasMore: nextPage !== null };
}
