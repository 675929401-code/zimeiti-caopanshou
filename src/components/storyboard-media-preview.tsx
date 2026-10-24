"use client";
/* eslint-disable @next/next/no-img-element -- Media includes protected URLs and local Blob URLs. */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Eye, Film, Loader2, Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import { requestVideoAccessUrl } from "@/lib/storyboard-video-access";

export type PreviewMedia = {
  url: string;
  type: "image" | "video";
  poster?: string;
  taskId?: string;
  token?: string;
  currentTime?: number;
};

interface VideoPreviewProps {
  url: string;
  taskId?: string;
  token?: string;
  poster?: string;
  currentTime?: number;
  autoPlay?: boolean;
  style?: CSSProperties;
  onExpand?: (url: string, currentTime: number) => void;
}

const MAX_AUTOMATIC_TICKET_REFRESHES = 2;
const playbackPosition = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Shared by the card and the lightbox, with one bounded refresh sequence per media identity. */
function VideoPreview({ url, taskId, token, poster, currentTime, autoPlay = false, style, onExpand }: VideoPreviewProps) {
  const [src, setSrc] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playNotice, setPlayNotice] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const automaticRefreshesRef = useRef(0);
  const positionRef = useRef(playbackPosition(currentTime));
  const resumePlaybackRef = useRef(autoPlay);
  const mountedRef = useRef(false);
  const loadingRef = useRef(true);
  const replacingRef = useRef(false);

  const bindVideo = useCallback((element: HTMLVideoElement | null) => {
    if (!element) videoRef.current?.pause();
    videoRef.current = element;
  }, []);

  const loadSource = useCallback(async (source?: "origin") => {
    const sequence = ++sequenceRef.current;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    loadingRef.current = true;
    replacingRef.current = true;
    const video = videoRef.current;
    if (video) {
      if (video.readyState > 0) positionRef.current = playbackPosition(video.currentTime);
      const wasPlaying = !video.paused && !video.ended;
      video.pause();
      if (wasPlaying) resumePlaybackRef.current = true;
    }
    setLoading(true);
    setError("");
    setPlayNotice("");
    setSrc("");
    try {
      const nextUrl = taskId && token
        ? await requestVideoAccessUrl(taskId, token, { source, signal: controller.signal })
        : url;
      if (controller.signal.aborted || !mountedRef.current || sequence !== sequenceRef.current) return;
      if (!nextUrl) throw new Error("播放地址暂不可用，请刷新后重试");
      setSrc(nextUrl);
      loadingRef.current = false;
      setLoading(false);
    } catch (cause) {
      if (controller.signal.aborted || !mountedRef.current || sequence !== sequenceRef.current) return;
      setError(cause instanceof Error ? cause.message : "视频暂时无法播放，请刷新后重试");
      loadingRef.current = false;
      setLoading(false);
    }
  }, [taskId, token, url]);

  useEffect(() => {
    mountedRef.current = true;
    automaticRefreshesRef.current = 0;
    positionRef.current = playbackPosition(currentTime);
    resumePlaybackRef.current = autoPlay;
    void loadSource();
    return () => {
      mountedRef.current = false;
      sequenceRef.current++;
      requestRef.current?.abort();
      videoRef.current?.pause();
    };
  }, [autoPlay, currentTime, loadSource]);

  const retry = () => {
    automaticRefreshesRef.current = 0;
    void loadSource();
  };
  const onMediaError = () => {
    if (!mountedRef.current || loadingRef.current) return;
    if (taskId && token && automaticRefreshesRef.current < MAX_AUTOMATIC_TICKET_REFRESHES) {
      const attempt = ++automaticRefreshesRef.current;
      void loadSource(attempt === MAX_AUTOMATIC_TICKET_REFRESHES ? "origin" : undefined);
      return;
    }
    videoRef.current?.pause();
    setSrc("");
    setError("视频暂时无法播放，可能是链接失效或浏览器不支持该编码；请刷新播放地址后重试。");
  };

  if (!src) return <div className="sbw-empty-state sbw-playback-unavailable" aria-busy={loading}>
    {poster ? <img src={poster} alt="视频首帧封面" /> : loading ? <Loader2 /> : <Film />}
    <strong role={loading ? "status" : "alert"}>{loading ? "正在加载视频…" : error || "播放地址暂不可用"}</strong>
    {!loading && <button type="button" onClick={retry}>刷新播放地址</button>}
  </div>;

  return <>
    <video key={src} ref={bindVideo} src={src} poster={poster} controls playsInline preload="metadata" style={style}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        replacingRef.current = false;
        const duration = video.duration;
        const target = Number.isFinite(duration) && duration > 0 ? Math.min(positionRef.current, Math.max(0, duration - 0.05)) : positionRef.current;
        try { video.currentTime = target; } catch { /* Some streams become seekable only after loading data. */ }
        if (resumePlaybackRef.current) void video.play().catch(() => {
          if (mountedRef.current) setPlayNotice("浏览器暂未允许自动播放，请点击播放。");
        });
      }}
      onTimeUpdate={(event) => { positionRef.current = playbackPosition(event.currentTarget.currentTime); }}
      onPlay={() => { resumePlaybackRef.current = true; setPlayNotice(""); }}
      onPause={() => { if (!replacingRef.current) resumePlaybackRef.current = false; }}
      onError={onMediaError}
    />
    {onExpand && <button type="button" className="sbw-video-expand" title="放大播放" aria-label="放大播放视频" onClick={() => {
      const video = videoRef.current;
      const position = playbackPosition(video?.currentTime ?? positionRef.current);
      video?.pause();
      resumePlaybackRef.current = false;
      onExpand(src, position);
    }}><Eye /></button>}
    {playNotice && <p role="status">{playNotice}</p>}
  </>;
}

export function TicketedVideo(props: Omit<VideoPreviewProps, "autoPlay" | "style" | "currentTime"> & { token: string; onExpand: (url: string, currentTime: number) => void }) {
  return <div className="sbw-ticketed-video"><VideoPreview {...props} /></div>;
}

const PREVIEW_ZOOM_MIN = 0.7;
const PREVIEW_ZOOM_MAX = 1.4;
const PREVIEW_ZOOM_STEP = 0.1;

export function MediaLightbox({ media, onClose }: { media: PreviewMedia; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const close = useCallback(() => {
    dialogRef.current?.querySelectorAll("video").forEach((video) => video.pause());
    const fullscreenElement = document.fullscreenElement;
    if (fullscreenElement && dialogRef.current?.contains(fullscreenElement)) {
      void document.exitFullscreen().catch(() => undefined).finally(() => onCloseRef.current());
      return;
    }
    onCloseRef.current();
  }, []);

  useEffect(() => { setZoom(1); }, [media.url]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === dialogRef.current);
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape, true);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape, true);
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      previouslyFocused?.focus();
    };
  }, [close]);

  const updateZoom = (delta: number) => setZoom((current) => Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, Number((current + delta).toFixed(1)))));
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await dialogRef.current?.requestFullscreen();
  };

  return createPortal(<div ref={dialogRef} className="sbw-lightbox" role="dialog" aria-modal="true"
    aria-label={media.type === "video" ? "视频放大预览" : "故事板图片放大预览"}
    onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <div className="sbw-lightbox-toolbar" role="toolbar" aria-label="媒体预览工具栏">
      <button type="button" aria-label="缩小预览" title="缩小 10%" disabled={zoom <= PREVIEW_ZOOM_MIN} onClick={() => updateZoom(-PREVIEW_ZOOM_STEP)}><ZoomOut /></button>
      <output aria-live="polite" aria-label="当前缩放比例">{Math.round(zoom * 100)}%</output>
      <button type="button" aria-label="放大预览" title="放大 10%" disabled={zoom >= PREVIEW_ZOOM_MAX} onClick={() => updateZoom(PREVIEW_ZOOM_STEP)}><ZoomIn /></button>
      <button type="button" aria-label={isFullscreen ? "退出全屏" : "进入全屏"} title={isFullscreen ? "退出全屏" : "进入全屏"} onClick={() => void toggleFullscreen().catch(() => undefined)}><Maximize2 /></button>
      <button ref={closeButtonRef} type="button" aria-label="关闭预览" title="关闭预览（Esc）" onClick={close}><X /></button>
    </div>
    <div className="sbw-lightbox-stage" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      {media.type === "video"
        ? <VideoPreview {...media} autoPlay style={{ transform: `scale(${zoom})` }} />
        : <img src={media.url} alt="故事板原图预览" style={{ transform: `scale(${zoom})` }} />}
    </div>
  </div>, document.body);
}
