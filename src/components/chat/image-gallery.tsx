"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, X, Download, ZoomIn, Maximize2, Loader2, Send, Images } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  dispatchVideoTaskTransfer,
  makeOrderedImageFilename,
  makeVideoTaskTransferPayload,
  normalizeVideoTaskOrder,
} from "@/lib/video-task-transfer";

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface GeneratedImage {
  url: string;
  width?: number;
  height?: number;
  revisedPrompt?: string;
  order?: number;
  label?: string;
  title?: string;
  sourcePrompt?: string;
  filename?: string;
}

export interface ImageGalleryProps {
  images: GeneratedImage[];
  /** 是否正在生成中（显示骨架屏） */
  isGenerating?: boolean;
  /** 生成中的数量（骨架屏数量） */
  generatingCount?: number;
  /** 生成提示词 */
  prompt?: string;
  /** 最大缩略图列数（默认自适应） */
  maxColumns?: number;
}

// ═══════════════════════════════════════════════════════════
// 骨架屏组件
// ═══════════════════════════════════════════════════════════

function ImageSkeleton() {
  return (
    <div className="relative rounded-xl overflow-hidden bg-[var(--muted)]/40 aspect-square animate-pulse">
      <div className="absolute inset-0 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-[var(--muted-foreground)] animate-spin" />
      </div>
      {/* 闪光扫描线效果 */}
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 单张图片查看器（Overlay 展开态）
// ═══════════════════════════════════════════════════════════

function ImageViewer({
  images,
  currentIndex,
  onClose,
  onNavigate,
}: {
  images: GeneratedImage[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [direction, setDirection] = useState<"left" | "right" | null>(null);
  const image = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;

  // 键盘导航
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) {
        setDirection("left");
        onNavigate(currentIndex - 1);
      }
      if (e.key === "ArrowRight" && hasNext) {
        setDirection("right");
        onNavigate(currentIndex + 1);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [currentIndex, hasPrev, hasNext, onClose, onNavigate]);

  // 切换图片时重置加载状态
  useEffect(() => {
    setLoaded(false);
  }, [currentIndex]);

  const handleDownload = useCallback(async () => {
    try {
      const res = await fetch(image.url);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = makeOrderedImageFilename(image, currentIndex);
      link.click();
      window.URL.revokeObjectURL(url);
    } catch {
      // 降级：直接打开
      window.open(image.url, "_blank");
    }
  }, [image, image.url, currentIndex]);

  const handleSendToVideo = useCallback(() => {
    const order = normalizeVideoTaskOrder(image.order, currentIndex + 1);
    const payload = makeVideoTaskTransferPayload([{
      order,
      imageUrl: image.url,
      prompt: image.sourcePrompt || image.revisedPrompt || "",
      label: image.label || `任务${order}`,
      title: image.title || `图片${order}`,
      source: "chat-image",
    }], "single");
    if (!dispatchVideoTaskTransfer(payload)) {
      toast.error("临时交接失败，请稍后重试");
      return;
    }
    toast.success(`已发送图片到视频任务${order}`);
  }, [image, currentIndex]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-xl" />

      {/* 内容区 */}
      <div
        className="relative z-10 flex flex-col items-center max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between w-full mb-3 px-1">
          <span className="text-sm text-white/70">
            {currentIndex + 1} / {images.length}
            {image.revisedPrompt && (
              <span className="ml-3 text-white/40 text-xs truncate max-w-[300px] inline-block align-middle">
                {image.revisedPrompt.slice(0, 60)}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSendToVideo}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs"
              title="发送到视频任务"
            >
              <Send className="w-4 h-4" />
              发到任务{normalizeVideoTaskOrder(image.order, currentIndex + 1)}
            </button>
            <button
              onClick={handleDownload}
              className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title="下载"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 图片容器 */}
        <div className="relative flex items-center justify-center">
          {/* 加载中 */}
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-white/40 animate-spin" />
            </div>
          )}

          <img
            src={image.url}
            alt={`图片 ${currentIndex + 1}`}
            className={cn(
              "max-w-full max-h-[75vh] rounded-lg object-contain transition-all duration-300",
              loaded ? "opacity-100 scale-100" : "opacity-0 scale-95",
            )}
            onLoad={() => setLoaded(true)}
          />

          {/* 左右翻页按钮 */}
          {hasPrev && (
            <button
              onClick={() => { setDirection("left"); onNavigate(currentIndex - 1); }}
              className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white/70 hover:bg-black/60 hover:text-white transition-all backdrop-blur-sm"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          {hasNext && (
            <button
              onClick={() => { setDirection("right"); onNavigate(currentIndex + 1); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white/70 hover:bg-black/60 hover:text-white transition-all backdrop-blur-sm"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 底部指示器 */}
        {images.length > 1 && (
          <div className="flex items-center gap-1.5 mt-3">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={() => onNavigate(i)}
                className={cn(
                  "w-1.5 h-1.5 rounded-full transition-all duration-200",
                  i === currentIndex
                    ? "bg-[var(--primary)] w-4"
                    : "bg-white/30 hover:bg-white/50"
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 主组件：ImageGallery
// ═══════════════════════════════════════════════════════════

export function ImageGallery({
  images,
  isGenerating,
  generatingCount = 1,
  prompt,
  maxColumns,
}: ImageGalleryProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());

  // 计算网格列数
  const totalSlots = images.length + (isGenerating ? generatingCount : 0);
  const columns = maxColumns || (totalSlots <= 1 ? 1 : totalSlots <= 2 ? 2 : totalSlots <= 4 ? 2 : 3);

  const handleImageError = useCallback((index: number) => {
    setImageErrors((prev) => new Set(prev).add(index));
  }, []);

  const handleOpenViewer = useCallback((index: number) => {
    setViewerIndex(index);
  }, []);

  const handleCloseViewer = useCallback(() => {
    setViewerIndex(null);
  }, []);

  const handleNavigate = useCallback((index: number) => {
    setViewerIndex(index);
  }, []);

  const handleSendImageToVideo = useCallback((img: GeneratedImage, index: number) => {
    const order = normalizeVideoTaskOrder(img.order, index + 1);
    const payload = makeVideoTaskTransferPayload([{
      order,
      imageUrl: img.url,
      prompt: img.sourcePrompt || img.revisedPrompt || prompt || "",
      label: img.label || `任务${order}`,
      title: img.title || `图片${order}`,
      source: "chat-image",
    }], "single");
    if (!dispatchVideoTaskTransfer(payload)) {
      toast.error("临时交接失败，请稍后重试");
      return;
    }
    toast.success(`已发送图片到视频任务${order}`);
  }, [prompt]);

  const handleSendAllImagesToVideo = useCallback(() => {
    const payload = makeVideoTaskTransferPayload(
      images.map((img, index) => {
        const order = normalizeVideoTaskOrder(img.order, index + 1);
        return {
          order,
          imageUrl: img.url,
          prompt: img.sourcePrompt || img.revisedPrompt || prompt || "",
          label: img.label || `任务${order}`,
          title: img.title || `图片${order}`,
          source: "chat-image" as const,
        };
      }),
      "batch",
    );
    if (!dispatchVideoTaskTransfer(payload)) {
      toast.error("临时交接失败，请稍后重试");
      return;
    }
    toast.success(`已按顺序发送 ${payload.items.length} 张图片到视频任务卡片`);
    window.location.assign("/video");
  }, [images, prompt]);

  const handleDownloadImage = useCallback(async (img: GeneratedImage, index: number) => {
    try {
      const res = await fetch(img.url);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = makeOrderedImageFilename(img, index);
      link.click();
      window.URL.revokeObjectURL(url);
      toast.success(`已下载图片${normalizeVideoTaskOrder(img.order, index + 1)}`);
    } catch {
      window.open(img.url, "_blank");
    }
  }, []);

  const handleDownloadAllImages = useCallback(async () => {
    for (let i = 0; i < images.length; i++) {
      // 轻微错峰，避免浏览器拦截连续下载。
      setTimeout(() => void handleDownloadImage(images[i], i), i * 180);
    }
    toast.success(`已按序号触发下载 ${images.length} 张图片`);
  }, [handleDownloadImage, images]);

  // 单张图片：大图展示
  if (images.length === 1 && !isGenerating) {
    const img = images[0];
    const hasError = imageErrors.has(0);
    return (
      <div className="ig-single mt-2">
        <div className="mb-1.5 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => handleSendImageToVideo(img, 0)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--primary)]/35 bg-[var(--primary)]/10 px-2 py-1 text-[11px] font-medium text-[var(--primary)] hover:bg-[var(--primary)]/15"
          >
            <Send className="h-3 w-3" />
            发到任务{normalizeVideoTaskOrder(img.order, 1)}
          </button>
          <button
            type="button"
            onClick={() => handleDownloadImage(img, 0)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--background)]/55 px-2 py-1 text-[11px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]"
          >
            <Download className="h-3 w-3" />
            下载
          </button>
        </div>
        <div
          className="relative group rounded-xl overflow-hidden border border-[var(--border)] cursor-pointer transition-all duration-200 hover:border-[var(--primary)]/30 hover:shadow-lg hover:shadow-[var(--primary)]/5"
          onClick={() => !hasError && handleOpenViewer(0)}
        >
          {hasError ? (
            <div className="flex items-center justify-center h-48 bg-[var(--muted)]/30 text-[var(--muted-foreground)] text-sm">
              图片加载失败
            </div>
          ) : (
            <>
              <img
                src={img.url}
                alt={prompt || "生成的图片"}
                className="w-full max-h-[400px] object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                loading="lazy"
                onError={() => handleImageError(0)}
              />
              {/* Hover 遮罩 */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-200 flex items-center justify-center">
                <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-2 rounded-full bg-black/40 text-white">
                  <Maximize2 className="w-4 h-4" />
                </div>
              </div>
            </>
          )}
        </div>
        {viewerIndex !== null && (
          <ImageViewer
            images={images}
            currentIndex={viewerIndex}
            onClose={handleCloseViewer}
            onNavigate={handleNavigate}
          />
        )}
      </div>
    );
  }

  // 多张图片：网格展示
  return (
    <div className="ig-gallery mt-2">
      {/* 提示词标签 */}
      {prompt && (
        <div className="text-[11px] text-[var(--muted-foreground)] mb-1.5 truncate">
          {prompt.slice(0, 80)}{prompt.length > 80 ? "..." : ""}
        </div>
      )}

      {/* 图片网格 */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {images.map((img, i) => {
          const hasError = imageErrors.has(i);
          return (
            <div
              key={`ig-${i}-${img.url.slice(-20)}`}
              className="relative group rounded-xl overflow-hidden border border-[var(--border)] cursor-pointer transition-all duration-200 hover:border-[var(--primary)]/30 hover:shadow-lg hover:shadow-[var(--primary)]/5"
              onClick={() => !hasError && handleOpenViewer(i)}
            >
              {hasError ? (
                <div className="flex items-center justify-center aspect-square bg-[var(--muted)]/30 text-[var(--muted-foreground)] text-xs">
                  加载失败
                </div>
              ) : (
                <>
                  <img
                    src={img.url}
                    alt={`图片 ${i + 1}`}
                    className="w-full aspect-square object-cover transition-transform duration-300 group-hover:scale-105"
                    loading="lazy"
                    onError={() => handleImageError(i)}
                  />
                  {/* Hover 遮罩 */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-200 flex items-center justify-center">
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1.5 rounded-full bg-black/40 text-white">
                      <ZoomIn className="w-3.5 h-3.5" />
                    </div>
                  </div>
                  {/* 序号标签 */}
                  {images.length > 1 && (
                    <span className="absolute top-1.5 left-1.5 text-[10px] font-medium text-white bg-black/40 px-1.5 py-0.5 rounded-md backdrop-blur-sm">
                      {normalizeVideoTaskOrder(img.order, i + 1)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSendImageToVideo(img, i);
                    }}
                    className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
                    title="发送到视频任务"
                  >
                    <Send className="h-3 w-3" />
                    任务{normalizeVideoTaskOrder(img.order, i + 1)}
                  </button>
                </>
              )}
            </div>
          );
        })}

        {/* 生成中的骨架屏 */}
        {isGenerating && Array.from({ length: generatingCount }).map((_, i) => (
          <ImageSkeleton key={`skeleton-${i}`} />
        ))}
      </div>

      {/* 图片数量标签 */}
      {images.length > 1 && !isGenerating && (
        <div className="text-[10px] text-[var(--muted-foreground)] mt-1.5">
          共 {images.length} 张图片 · 点击查看大图
        </div>
      )}

      {/* 全屏查看器 */}
      {images.length > 1 && !isGenerating && (
        <div className="mt-1.5 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={handleDownloadAllImages}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--background)]/55 px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]"
          >
            <Download className="h-3 w-3" />
            全部下载
          </button>
          <button
            type="button"
            onClick={handleSendAllImagesToVideo}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--primary)] hover:bg-[var(--primary)]/15"
          >
            <Images className="h-3 w-3" />
            全部发到视频
          </button>
        </div>
      )}

      {viewerIndex !== null && (
        <ImageViewer
          images={images}
          currentIndex={viewerIndex}
          onClose={handleCloseViewer}
          onNavigate={handleNavigate}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// CSS 动画（shimmer 扫描线）
// ═══════════════════════════════════════════════════════════
// 注意：shimmer 动画需要在 globals.css 或组件 CSS 中定义
// 这里用内联 style 标签注入（仅限本组件使用）
export function ImageGalleryStyles() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      @keyframes shimmer {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(100%); }
      }
    `}} />
  );
}
