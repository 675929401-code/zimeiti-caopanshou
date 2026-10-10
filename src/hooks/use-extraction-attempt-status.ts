'use client';
import { useCallback, useEffect, useState } from 'react';
import { clearBrowserClientAttemptsById } from '@/lib/extract-client-attempt';
type AttemptStatus = {
  attemptId: string; clientRequestId: string; state: 'running' | 'failed_unknown' | 'failed' | 'succeeded';
  netCharged: number; billingMessage: string; checkedAt: string; response?: unknown;
  contentRetained?: boolean; contentUnavailableReason?: string;
};

type AttemptStatusQuery = {
  message?: string;
  attemptId?: string;
  clientRequestId?: string;
  token: string;
  userId: string;
  mode: string;
};

export function useExtractionAttemptStatus(query: AttemptStatusQuery) {
  const parsedAttemptId = query.message?.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase() || '';
  const attemptId = query.attemptId?.trim().toLowerCase() || parsedAttemptId;
  const clientRequestId = query.clientRequestId?.trim() || '';
  const { token, userId, mode } = query;
  const identity = attemptId || clientRequestId;
  const [data, setData] = useState<AttemptStatus | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setData(null); setError(''); }, [identity, token]);
  useEffect(() => {
    if (!identity || !token) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    const schedule = () => {
      if (reads >= 60 || controller.signal.aborted) return;
      const delay = reads === 1 ? 2_000 : reads === 2 ? 3_000 : 5_000;
      timer = setTimeout(read, delay);
    };
    async function read() {
      setRefreshing(true); setError('');
      reads += 1;
      try {
        const params = new URLSearchParams(attemptId
          ? { attempt_id: attemptId }
          : { client_request_id: clientRequestId });
        const response = await fetch('/api/extract/status?' + params.toString(), {
          headers: { Authorization: 'Bearer ' + token }, cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        const value = await response.json();
        if (response.status === 404 && reads < 6) { schedule(); return; }
        if (!response.ok) throw new Error(value.error || '状态暂时无法读取，请稍后刷新');
        if (controller.signal.aborted) return;
        setData(value);
        if (value.state === 'failed' || value.state === 'succeeded') {
          clearBrowserClientAttemptsById('extract:' + userId + ':' + mode, value.clientRequestId);
        }
        if (value.state === 'running') schedule();
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : '状态暂时无法读取');
          if (reads < 6) schedule();
        }
      } finally { if (!controller.signal.aborted) setRefreshing(false); }
    }
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [attemptId, clientRequestId, identity, token, userId, mode, reload]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  return { attemptId: data?.attemptId || attemptId, clientRequestId, data, error, refreshing, refresh };
}
