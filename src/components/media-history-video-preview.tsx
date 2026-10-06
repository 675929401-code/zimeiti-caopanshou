"use client";

import { useEffect, useState } from "react";
import { requestMediaHistoryVideoUrl } from "@/lib/media-history-video-preview";

export function MediaHistoryVideoPreview({ previewPath, title, token }: {
  previewPath: string; title: string; token: string | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setSource(""); setFailed(false); setFrameReady(false);
    void requestMediaHistoryVideoUrl(previewPath, token, { signal: controller.signal })
      .then(url => { if (!controller.signal.aborted) setSource(url); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [previewPath, token, attempt]);

  return <div className="relative h-full w-full" data-native-video-preview>
    {source && !failed && <video
      key={source}
      src={`${source}#t=0.1`}
      controls playsInline preload="metadata"
      aria-label={`${title} 视频预览`}
      onLoadedMetadata={event => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
      }}
      onLoadedData={() => setFrameReady(true)}
      onError={() => setFailed(true)}
    />}
    {failed ? <button
      type="button"
      className="absolute inset-0 flex h-full w-full items-center justify-center bg-black/70 text-sm text-white"
      onClick={() => setAttempt(value => value + 1)}
    >预览暂不可用，点击重试</button> : !frameReady && <span
      className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-white/70"
      role="status"
    >正在读取视频预览…</span>}
  </div>;
}
