'use client';

import { useEffect, useRef, useState } from 'react';
import { AudioDownloadError, fetchAudioDownload } from '@/lib/vs/download-audio';

export default function AudioDownloadButton({ audioUrl, assetId, token, filename, className, children }: {
  audioUrl: string; assetId?: string; token?: string | null; filename: string; className?: string; children: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setError('');
    return () => { active.current?.abort(); active.current = null; };
  }, [audioUrl, assetId, token]);

  async function download() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const blob = await fetchAudioDownload({ origin: location.origin, audioUrl, assetId, token,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
      if (controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename.replace(/[\\/:*?"<>|\r\n]/g, '-');
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof AudioDownloadError ? failure.message : '音频下载失败，请稍后重试');
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }

  return <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    <button type="button" className={className} disabled={busy} aria-busy={busy} onClick={() => void download()}>
      {busy ? '正在下载…' : children}
    </button>
    {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
  </span>;
}
