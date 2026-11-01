"use client";

import { useEffect, useRef, useState } from "react";
import { MediaHistoryVideoNetworkError, requestMediaHistoryVideoUrl } from "@/lib/media-history-video-preview";
import { offlineAccessAllowed, subscribeOfflineAuthRevocation, suspendOfflineTask } from "@/lib/media-history-offline-auth";
import { StoryboardLocalVideoSession } from "@/lib/storyboard-local-video-cache";
import { subscribeVideoHistoryRemovals } from "@/lib/video-history-removal-sync";
import type { VideoHistorySurface } from "@/lib/video-history-policy";

type LocalVideo = { userId: string; surface: VideoHistorySurface; taskId: string };
const TASK_ID = /^[a-zA-Z0-9_-]{8,128}$/u;
const TICKET_TIMEOUT_MS = 15_000;
const FIRST_FRAME_TIMEOUT_MS = 20_000;

export function MediaHistoryVideoPreview({ previewPath, title, token, localVideo }: {
  previewPath: string; title: string; token: string | null; localVideo?: LocalVideo;
}) {
  const [attempt, setAttempt] = useState(0);
  const [sourceState, setSource] = useState("");
  const [sourceScope, setSourceScope] = useState("");
  const [localSource, setLocalSource] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureMessage, setFailureMessage] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userId = localVideo?.userId || "";
  const surface = localVideo?.surface;
  const taskId = localVideo?.taskId || "";
  // Keep previously rendered media out of a newly selected account even
  // before React has run the previous effect's cleanup.
  const scope = JSON.stringify([previewPath, token, userId, surface, taskId]);
  const source = sourceScope === scope ? sourceState : "";
  const currentFailure = sourceScope === scope && failed;
  const currentFrameReady = sourceScope === scope && frameReady;

  useEffect(() => {
    const controller = new AbortController();
    let session: StoryboardLocalVideoSession | null = null;
    let objectUrl = "";
    const clearTimer = () => { if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; } };
    const eligible = Boolean(token && userId && (surface === "video-page" || surface === "storyboard-workbench") && TASK_ID.test(taskId)
      && previewPath === `/api/video/storage/${taskId}`);
    const revokeLocal = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ""; } };
    const stop = () => { clearTimer(); controller.abort(); session?.dispose(); revokeLocal(); setSource(""); setFailureMessage("视频访问状态已变化，请联网重新验证。"); setFailed(true); };
    const startTimer = (message: string, duration: number) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        controller.abort(); session?.dispose(); revokeLocal();
        setSource(""); setFailureMessage(message); setFailed(true);
      }, duration);
    };
    const showSource = (url: string, local: boolean) => {
      if (controller.signal.aborted) return;
      setLocalSource(local); setSource(url);
      startTimer("视频加载较慢，请检查网络后重试。", FIRST_FRAME_TIMEOUT_MS);
    };
    const unsubscribe = eligible && surface
      ? subscribeVideoHistoryRemovals(userId, surface, ids => { if (ids.includes(taskId)) stop(); }, ids => { if (ids.includes(taskId)) stop(); })
      : () => {};
    const unsubscribeAuth = eligible && token ? subscribeOfflineAuthRevocation(userId, token, taskId, stop) : () => {};
    setSourceScope(scope); setSource(""); setFailed(false); setFailureMessage(""); setFrameReady(false); setLocalSource(false);
    startTimer("视频连接超时，请检查网络后重试。", TICKET_TIMEOUT_MS);
    void requestMediaHistoryVideoUrl(previewPath, token, { signal: controller.signal, userId: eligible ? userId : undefined })
      .then(url => showSource(url, false))
      .catch(async error => {
        if (controller.signal.aborted) return;
        // Only a failure to reach the server permits an offline copy. Any HTTP
        // denial, expired/deleted record or invalid ticket stays authoritative.
        if (!(error instanceof MediaHistoryVideoNetworkError) || !eligible || !token || !surface) {
          clearTimer(); setFailureMessage("视频暂时无法读取，请稍后重试。"); setFailed(true); return;
        }
        try {
          if (!await offlineAccessAllowed(userId, token, taskId) || controller.signal.aborted) { if (!controller.signal.aborted) { clearTimer(); setFailureMessage("视频暂时无法读取，请联网后重试。"); setFailed(true); } return; }
          session = new StoryboardLocalVideoSession(userId, token, fetch, surface);
          const blob = await session.load(taskId);
          if (controller.signal.aborted) return;
          if (!await offlineAccessAllowed(userId, token, taskId) || controller.signal.aborted) { if (!controller.signal.aborted) { clearTimer(); setFailureMessage("视频暂时无法读取，请联网后重试。"); setFailed(true); } return; }
          if (!blob || !blob.type.startsWith("video/")) { clearTimer(); setFailureMessage("本机视频副本不可用，请联网后重试。"); setFailed(true); return; }
          objectUrl = URL.createObjectURL(blob);
          if (controller.signal.aborted) { revokeLocal(); return; }
          showSource(objectUrl, true);
        } catch { if (!controller.signal.aborted) { clearTimer(); setFailureMessage("视频暂时无法读取，请稍后重试。"); setFailed(true); } }
        finally { session?.dispose(); session = null; }
      });
    return () => { clearTimer(); controller.abort(); session?.dispose(); unsubscribe(); unsubscribeAuth(); revokeLocal(); };
  }, [previewPath, token, userId, surface, taskId, scope, attempt]);

  return <div className="relative h-full w-full" data-native-video-preview>
    {source && !currentFailure && <video
      key={source}
      src={`${source}#t=0.1`}
      controls playsInline preload="metadata"
      aria-label={`${title} 视频预览`}
      onLoadedMetadata={event => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
      }}
      onLoadedData={() => { if (timerRef.current !== null) clearTimeout(timerRef.current); timerRef.current = null; setFrameReady(true); }}
      onError={() => { if (timerRef.current !== null) clearTimeout(timerRef.current); timerRef.current = null; if (userId && taskId) suspendOfflineTask(userId, taskId); setFailureMessage("视频无法播放，请重新加载。"); setFailed(true); }}
    />}
    {source && localSource && <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white">本机副本</span>}
    {currentFailure ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-5 text-center text-sm text-white" role="alert">
      <p>{failureMessage || "视频暂时无法预览，请重试。"}</p>
      <button type="button" className="rounded-md border border-white/25 bg-white/10 px-4 py-2 text-white" onClick={() => setAttempt(value => value + 1)}>预览暂不可用，点击重试</button>
    </div> : !currentFrameReady && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/70" role="status">正在加载视频，请稍候…</span>}
  </div>;
}
