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

export type ExtractionTrackingState = 'checking' | 'tracking' | 'retrying' | 'reconciliation' | 'paused' | 'terminal' | 'unavailable';

export function useExtractionAttemptStatus(query: AttemptStatusQuery) {
  const parsedAttemptId = query.message?.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase() || '';
  const attemptId = query.attemptId?.trim().toLowerCase() || parsedAttemptId;
  const clientRequestId = query.clientRequestId?.trim() || '';
  const { token, userId, mode } = query;
  const identity = attemptId || clientRequestId;
  const [data, setData] = useState<AttemptStatus | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [trackingState, setTrackingState] = useState<ExtractionTrackingState>('checking');
  const [reload, setReload] = useState(0);
  useEffect(() => { setData(null); setError(''); }, [identity, token]);
  useEffect(() => {
    if (!identity || !token) {
      setRefreshing(false);
      setTrackingState('unavailable');
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    let failures = 0;
    let inFlight = false;
    let terminal = false;
    let authenticationRequired = false;
    const schedule = (delay: number) => {
      if (controller.signal.aborted || terminal || authenticationRequired) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, delay);
    };
    async function read() {
      if (controller.signal.aborted || inFlight || terminal || authenticationRequired) return;
      if (document.visibilityState === 'hidden') {
        setTrackingState('paused');
        return;
      }
      inFlight = true;
      setRefreshing(true);
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
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          authenticationRequired = true;
          setTrackingState('unavailable');
          throw new Error('登录状态或访问权限已失效，请重新登录后刷新原请求状态');
        }
        if (!response.ok) throw new Error(value.error || '状态暂时无法读取，请稍后刷新');
        if (!value || !['running', 'failed_unknown', 'failed', 'succeeded'].includes(value.state)
          || (clientRequestId && value.clientRequestId !== clientRequestId)
          || (attemptId && value.attemptId !== attemptId)) {
          throw new Error('原请求状态返回不完整，正在重新查询');
        }
        failures = 0;
        setError('');
        setData(value);
        if (value.state === 'failed' || value.state === 'succeeded') {
          terminal = true;
          setTrackingState('terminal');
          clearBrowserClientAttemptsById('extract:' + userId + ':' + mode, value.clientRequestId);
        } else if (value.state === 'failed_unknown') {
          setTrackingState('reconciliation');
          schedule(30_000);
        } else if (value.state === 'running') {
          setTrackingState('tracking');
          schedule(reads === 1 ? 2_000 : reads === 2 ? 3_000 : reads < 30 ? 5_000 : 15_000);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : '状态暂时无法读取');
          if (!authenticationRequired) {
            failures += 1;
            setTrackingState('retrying');
            schedule(Math.min(30_000, 2_000 * 2 ** Math.min(failures - 1, 4)));
          }
        }
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setRefreshing(false);
      }
    }
    const resume = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        void read();
      }
    };
    setTrackingState('checking');
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    void read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [attemptId, clientRequestId, identity, token, userId, mode, reload]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  return { attemptId: data?.attemptId || attemptId, clientRequestId, data, error, refreshing, trackingState, refresh };
}
