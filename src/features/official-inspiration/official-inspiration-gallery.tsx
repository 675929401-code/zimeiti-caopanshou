"use client";

import Image from "next/image";
import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Clock3,
  Copy,
  Download,
  Film,
  Flame,
  Gem,
  ImageIcon,
  Lightbulb,
  LogIn,
  Mountain,
  Music2,
  Palette,
  PanelsTopLeft,
  Play,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  UserRound,
  Video,
  Volume2,
  WandSparkles,
  X,
} from "lucide-react";
import { useApp } from "@/contexts/app-context";
import { useManjuShowcaseCatalog } from "@/components/app-route-shell";
import { applyManjuInspirationOverrides } from "@/lib/manju-showcase-runtime";
import { storeYoucaiMusicPrefill, storeYoucaiVideoPrefill } from "@/lib/youcai-agent-routing";
import { storeYoucaiAgentPrefill } from "@/lib/youcai-agent-prefill";
import { saveInspirationCanvasReference } from "./canvas-handoff";
import {
  INSPIRATION_CATEGORY_FILTERS,
  INSPIRATION_MEDIA_FILTERS,
  OFFICIAL_INSPIRATION_ITEMS,
  getInspirationSourceNote,
  type OfficialInspirationItem,
} from "./inspiration-data";
import styles from "./official-inspiration.module.css";
import { loadAdminUploadedInspiration } from "./admin-uploaded-inspiration";

type MediaFilter = (typeof INSPIRATION_MEDIA_FILTERS)[number];
type CategoryFilter = (typeof INSPIRATION_CATEGORY_FILTERS)[number];
type SortMode = "推荐" | "最新" | "最热";

const INSPIRATION_PAGE_SIZE = 16;
const COMPLETE_INSPIRATION_ITEMS = OFFICIAL_INSPIRATION_ITEMS.filter((item) => (
  item.availability !== "planned"
  && (item.mediaType === "图片" || Boolean(item.mediaPath))
));

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  全部分类: "全部分类",
  角色: "👤 角色",
  场景: "🏞️ 场景",
  道具: "💍 道具",
  风格: "🎨 风格",
  分镜: "🎬 分镜",
  成片: "🎞️ 成片",
  音乐: "🎵 音乐",
  语音: "🎙️ 语音",
  音频: "🎧 音频",
  音效: "🔊 音效",
  图片: "🖼️ 图片",
  视频: "🎥 视频",
  其他: "📁 其他",
};

const CATEGORY_ICONS = {
  全部分类: Sparkles,
  角色: UserRound,
  场景: Mountain,
  道具: Gem,
  风格: Palette,
  分镜: PanelsTopLeft,
  成片: Film,
  音乐: Music2,
  语音: Music2,
  音频: Music2,
  音效: Music2,
  图片: ImageIcon,
  视频: Video,
  其他: Sparkles,
} as const;

const MEDIA_ICONS = {
  全部: Sparkles,
  图片: ImageIcon,
  视频: Video,
  音频: Volume2,
  音乐: Music2,
} as const;

function matchesMediaFilter(item: OfficialInspirationItem, media: MediaFilter): boolean {
  if (media === "全部") return true;
  if (media === "音乐") return item.mediaType === "音频" && item.category === "音乐";
  return item.mediaType === media;
}

function getDisplayMediaLabel(item: OfficialInspirationItem): Exclude<MediaFilter, "全部"> {
  return item.mediaType === "音频" && item.category === "音乐" ? "音乐" : item.mediaType;
}

function getWorkbenchAction(item: OfficialInspirationItem): { href: string; label: string } | null {
  // 独立 AI 生图工作台已下线：图片类素材不再提供工作台入口。
  if (item.mediaType === "图片") return null;
  if (item.mediaType === "视频") {
    return { href: "/youcai/video", label: "进入视频工作台" };
  }
  if (item.category === "音乐") {
    return { href: "/youcai/tools/audio/minimax-music", label: "进入音乐工作台" };
  }
  return { href: "/youcai/tools/text/text-chat", label: "进入创作工作台" };
}

function storeWorkbenchPrompt(item: OfficialInspirationItem): boolean {
  try {
    if (item.mediaType === "图片") return false;
    if (item.mediaType === "视频") {
      return storeYoucaiVideoPrefill(item.prompt);
    }
    if (item.category === "音乐") {
      return storeYoucaiMusicPrefill(item.prompt);
    }
    const prompt = item.prompt.trim();
    if (!prompt) return true;
    return storeYoucaiAgentPrefill(prompt);
  } catch {
    return false;
  }
}

function getVisibleCategories(
  media: MediaFilter,
  items: readonly OfficialInspirationItem[],
): readonly CategoryFilter[] {
  return INSPIRATION_CATEGORY_FILTERS.filter((item) => (
    item === "全部分类"
    || items.some((entry) => (
      entry.category === item && matchesMediaFilter(entry, media)
    ))
  ));
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

function getDownloadPath(item: OfficialInspirationItem) {
  if (item.availability === "planned") return "";
  if (item.mediaType === "图片") return item.imagePath;
  return item.mediaPath || "";
}

function DetailMedia({ item }: { item: OfficialInspirationItem }) {
  const readyMedia = item.availability !== "planned" && Boolean(item.mediaPath);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setFailed(false);
    setRetryKey(0);
  }, [item.id]);

  if (failed) {
    return (
      <div className={`${styles.detailPreview} ${styles.mediaError}`} data-ratio={item.imageRatio} role="alert">
        <AlertCircle size={30} />
        <strong>素材文件加载失败</strong>
        <small>文件仍保留在素材清单中；可重试读取，系统不会把加载失败显示成生成成功。</small>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setRetryKey((value) => value + 1);
          }}
        >
          <RefreshCw size={15} />重新加载
        </button>
      </div>
    );
  }

  if (item.mediaType === "视频" && readyMedia) {
    return (
      <div className={styles.detailPreview} data-media="video" data-ratio={item.imageRatio}>
        <video
          key={retryKey}
          aria-label={`${item.title}本地演示视频`}
          controls
          onError={() => setFailed(true)}
          playsInline
          poster={item.imagePath}
          preload="metadata"
          src={item.mediaPath}
        />
      </div>
    );
  }

  if (item.mediaType === "音频") {
    return (
      <div className={styles.detailPreview} data-media="audio" data-ratio={item.imageRatio}>
        <Image key={`${item.id}-cover-${retryKey}`} src={item.imagePath} alt={item.imageAlt} fill onError={() => setFailed(true)} sizes="(max-width: 760px) 92vw, 64vw" priority unoptimized />
        <div className={styles.audioPanel}>
          <span><Music2 size={25} /></span>
          <strong>{readyMedia ? "音频作品" : "音频创作方案"}</strong>
          <small>{readyMedia ? "点击播放作品。" : "查看声音设计与创作提示词。"}</small>
          {readyMedia ? <audio key={`${item.id}-audio-${retryKey}`} controls onError={() => setFailed(true)} preload="metadata" src={item.mediaPath} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.detailPreview} data-media={item.mediaType === "视频" ? "planned" : "image"} data-ratio={item.imageRatio}>
      <Image key={`${item.id}-image-${retryKey}`} src={item.imagePath} alt={item.imageAlt} fill onError={() => setFailed(true)} sizes="(max-width: 760px) 92vw, 64vw" priority unoptimized />
      {item.mediaType === "视频" ? (
        <div className={styles.plannedMediaNotice}>
          <Video size={24} />
          <strong>视频创作方案</strong>
          <small>查看视频设计与创作提示词。</small>
        </div>
      ) : null}
    </div>
  );
}

function InspirationCardMedia({ item }: { item: OfficialInspirationItem }) {
  const readyMedia = item.availability !== "planned" && Boolean(item.mediaPath);
  const [failed, setFailed] = useState(false);
  const [previewPath, setPreviewPath] = useState(item.previewPath);

  useEffect(() => {
    setFailed(false);
    setPreviewPath(item.previewPath);
  }, [item.id]);

  if (failed) {
    return (
      <span className={styles.cardMediaError} role="img" aria-label={`${item.title}素材预览加载失败`}>
        <AlertCircle size={22} />
        <strong>预览加载失败</strong>
        <small>打开详情可重试</small>
      </span>
    );
  }

  if (item.mediaType === "视频" && readyMedia) {
    return (
      <>
        <Image
          key={previewPath}
          src={previewPath || item.imagePath}
          alt={item.imageAlt}
          fill
          unoptimized
          onError={() => {
            if (previewPath !== item.imagePath) {
              setPreviewPath(item.imagePath);
              return;
            }
            setFailed(true);
          }}
          sizes="(max-width: 600px) 100vw, (max-width: 1000px) 50vw, 25vw"
        />
        <span className={styles.playIndicator}><Play size={20} fill="currentColor" /></span>
      </>
    );
  }

  if (item.mediaType === "音频") {
    return (
      <div className={styles.cardAudioVisual} data-ready={readyMedia || undefined}>
        <span className={styles.cardAudioIcon}><Volume2 size={25} /></span>
        <span className={styles.waveform} aria-hidden="true">
          {[12, 22, 32, 19, 38, 26, 15, 30, 21].map((height, index) => (
            <i key={`${item.id}-wave-${index}`} style={{ height }} />
          ))}
        </span>
        <strong>{readyMedia ? "点击查看并播放" : "音频创作方案"}</strong>
      </div>
    );
  }

  return (
    <Image
      key={previewPath}
      src={previewPath}
      alt={item.imageAlt}
      fill
      unoptimized
      onError={() => {
        if (previewPath !== item.imagePath) {
          setPreviewPath(item.imagePath);
          return;
        }
        setFailed(true);
      }}
      sizes="(max-width: 600px) 100vw, (max-width: 1000px) 50vw, 25vw"
    />
  );
}

function InspirationDetailModal({
  item,
  onClose,
}: {
  item: OfficialInspirationItem;
  onClose: () => void;
}) {
  const router = useAppScopedRouter();
  const { state } = useApp();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [shareState, setShareState] = useState<"idle" | "shared" | "failed">("idle");
  const [handoffError, setHandoffError] = useState("");
  const downloadPath = getDownloadPath(item);
  const canDownload = Boolean(downloadPath);
  const authenticated = state.auth.isAuthenticated;
  const workbenchAction = getWorkbenchAction(item);
  const displayMediaLabel = getDisplayMediaLabel(item);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const copyPrompt = async () => {
    const copied = await writeClipboard(item.prompt);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  };

  const continueOnCanvas = () => {
    setHandoffError("");
    const saved = saveInspirationCanvasReference(item);
    if (!saved) {
      setHandoffError("无法保存灵感素材，请确认浏览器允许会话存储后重试。为避免丢失素材，本次不会打开空画布。");
      return;
    }
    router.push("/youcai/free-canvas");
  };

  const continueInWorkbench = () => {
    setHandoffError("");
    if (!workbenchAction) {
      setHandoffError("独立 AI 生图工作台已下线，图片类素材暂不支持直接带入工作台；请复制提示词到保留的创作模块使用。");
      return;
    }
    if (!storeWorkbenchPrompt(item)) {
      setHandoffError("无法把提示词保存到创作工作台，请确认浏览器允许站内存储后重试。本次不会打开没有素材提示词的空工作台。");
      return;
    }
    router.push(workbenchAction.href);
  };

  const shareItem = async () => {
    const url = new URL(router.scopeHref("/inspiration"), window.location.origin);
    url.searchParams.set("item", item.id);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: item.title, text: item.summary, url: url.toString() });
        setShareState("shared");
      } else {
        const copied = await writeClipboard(url.toString());
        setShareState(copied ? "shared" : "failed");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const copied = await writeClipboard(url.toString());
      setShareState(copied ? "shared" : "failed");
    }
    window.setTimeout(() => setShareState("idle"), 1800);
  };

  const downloadAsset = () => {
    if (!canDownload) return;
    if (!authenticated) {
      const redirect = `/youcai/inspiration?item=${encodeURIComponent(item.id)}`;
      router.push(`/login?redirect=${encodeURIComponent(redirect)}`);
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = downloadPath;
    anchor.download = downloadPath.split("/").pop() || `${item.id}-asset`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspiration-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <div>
            <span className={styles.authorBadge}><Sparkles size={13} />{item.authorName}</span>
            <span className={styles.detailType}>{displayMediaLabel} · {item.category}</span>
          </div>
          <button type="button" className={styles.closeButton} aria-label="关闭详情" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className={styles.modalContent}>
          <DetailMedia item={item} />
          <aside className={styles.promptPanel}>
            <div className={styles.promptHeading}>
              <span><Sparkles size={15} />创作提示词</span>
              <button type="button" onClick={copyPrompt}>
                {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
                {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
              </button>
            </div>
            <h2 id="inspiration-detail-title">{item.title}</h2>
            <p className={styles.detailSummary}>{item.summary}</p>
            <div className={styles.promptText}>{item.prompt}</div>
            <p className={styles.sourceNote}>
              {getInspirationSourceNote(item)}
            </p>
            {item.showcaseId ? (
              <Link className={styles.showcaseLink} href={`/share/canvas/${item.showcaseId}`}>
                <PanelsTopLeft size={15} />查看只读工作流
              </Link>
            ) : null}
          </aside>
        </div>

        {handoffError ? (
          <p className={styles.handoffError} role="alert" aria-live="assertive">{handoffError}</p>
        ) : null}

        <footer className={styles.modalFooter}>
          <button type="button" className={styles.copyAction} onClick={copyPrompt}>
            <Copy size={16} />复制完整提示词
          </button>
          <button type="button" className={styles.shareAction} onClick={shareItem}>
            {shareState === "shared" ? <Check size={16} /> : <Share2 size={16} />}
            {shareState === "shared" ? "已分享" : shareState === "failed" ? "分享失败" : "分享作品"}
          </button>
          <button
            type="button"
            className={styles.downloadAction}
            data-disabled={!canDownload || undefined}
            disabled={!canDownload}
            onClick={downloadAsset}
          >
            {!canDownload ? <Music2 size={16} /> : authenticated ? <Download size={16} /> : <LogIn size={16} />}
            {!canDownload ? "暂无文件" : authenticated ? "下载素材" : "登录后下载"}
          </button>
          <button type="button" className={styles.continueAction} onClick={continueOnCanvas}>
            进入创作画布<ArrowRight size={16} />
          </button>
          <button type="button" className={styles.workbenchAction} onClick={continueInWorkbench} disabled={!workbenchAction} data-disabled={!workbenchAction || undefined}>
            <WandSparkles size={16} />{workbenchAction?.label || "图片工作台已下线"}
          </button>
        </footer>
        <p className={styles.handoffNote}>进入画布或工作台只传递本站素材引用与提示词，不会自动生成内容，也不会自动扣费。</p>
      </section>
    </div>
  );
}

export function OfficialInspirationGallery() {
  const showcaseCatalog = useManjuShowcaseCatalog();
  const [uploadedItems, setUploadedItems] = useState<OfficialInspirationItem[]>([]);
  const [uploadedStatus, setUploadedStatus] = useState<"loading" | "ready" | "error">("loading");
  const [uploadedRevision, setUploadedRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [media, setMedia] = useState<MediaFilter>("全部");
  const [category, setCategory] = useState<CategoryFilter>("全部分类");
  const [sort, setSort] = useState<SortMode>("推荐");
  const [selected, setSelected] = useState<OfficialInspirationItem | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(INSPIRATION_PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setUploadedStatus("loading");
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void loadAdminUploadedInspiration(signal).then((items) => {
      if (controller.signal.aborted) return;
      setUploadedItems(items);
      setUploadedStatus("ready");
    }).catch(() => {
      if (controller.signal.aborted) return;
      setUploadedItems([]);
      setUploadedStatus("error");
    });
    return () => controller.abort();
  }, [uploadedRevision]);
  const configuredItems = useMemo(
    () => applyManjuInspirationOverrides([...uploadedItems, ...COMPLETE_INSPIRATION_ITEMS], showcaseCatalog),
    [showcaseCatalog, uploadedItems],
  );
  const visibleCategories = useMemo(
    () => getVisibleCategories(media, configuredItems),
    [configuredItems, media],
  );

  useEffect(() => {
    const sharedItemId = new URLSearchParams(window.location.search).get("item");
    if (!sharedItemId) return;
    const sharedItem = configuredItems.find((item) => item.id === sharedItemId);
    if (sharedItem) setSelected(sharedItem);
  }, [configuredItems]);

  useEffect(() => {
    if (selected && !configuredItems.some((item) => item.id === selected.id)) {
      setSelected(null);
    }
  }, [configuredItems, selected]);

  useEffect(() => {
    if (!visibleCategories.includes(category)) setCategory("全部分类");
  }, [category, visibleCategories]);

  useEffect(() => {
    setVisibleLimit(INSPIRATION_PAGE_SIZE);
  }, [category, media, query, sort]);

  const visibleItems = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return configuredItems
      .filter((item) => matchesMediaFilter(item, media))
      .filter((item) => category === "全部分类" || item.category === category)
      .filter((item) => {
        if (!keyword) return true;
        return [item.title, item.summary, item.prompt, item.category, item.mediaType]
          .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword));
      })
      .slice()
      .sort((left, right) => (
        sort === "推荐"
          ? 0
          : sort === "最热"
          ? right.popularity - left.popularity
          : Date.parse(right.createdAt) - Date.parse(left.createdAt)
      ));
  }, [category, configuredItems, media, query, sort]);

  const renderedItems = useMemo(
    () => visibleItems.slice(0, visibleLimit),
    [visibleItems, visibleLimit],
  );
  const hasMoreItems = renderedItems.length < visibleItems.length;

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMoreItems || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisibleLimit((current) => Math.min(current + INSPIRATION_PAGE_SIZE, visibleItems.length));
    }, { rootMargin: "520px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMoreItems, visibleItems.length]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <span className={styles.titleIcon}><Lightbulb size={24} /></span>
        <h1>灵感广场</h1>
        <p>浏览本站精选并保存到素材库的公共示例，查看提示词并继续进入画布或创作工作台</p>
      </header>

      <section className={styles.filterPanel} aria-label="筛选灵感作品">
        <label className={styles.searchBox}>
          <Search size={17} aria-hidden="true" />
          <span className={styles.srOnly}>搜索提示词或标题</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索提示词或文件名..."
          />
        </label>

        <div className={styles.filterRows}>
          <div className={styles.mediaFilters} aria-label="媒体类型">
            {INSPIRATION_MEDIA_FILTERS.map((item) => {
              const Icon = MEDIA_ICONS[item];
              return (
                <button key={item} type="button" data-active={media === item || undefined} onClick={() => setMedia(item)}>
                  <Icon size={14} />{item}
                </button>
              );
            })}
          </div>

          <div className={styles.categoryFilters} aria-label="素材分类">
            {visibleCategories.map((item) => {
              const Icon = CATEGORY_ICONS[item];
              return (
                <button key={item} type="button" data-active={category === item || undefined} onClick={() => setCategory(item)}>
                  {item === "全部分类" ? <Icon size={13} /> : null}{CATEGORY_LABELS[item]}
                </button>
              );
            })}
          </div>

          <div className={styles.sortFilters} aria-label="排序">
            {(["推荐", "最新", "最热"] as const).map((item) => (
              <button key={item} type="button" data-active={sort === item || undefined} onClick={() => setSort(item)}>
                {item === "推荐" ? <Sparkles size={13} /> : item === "最新" ? <Clock3 size={13} /> : <Flame size={13} />}{item}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.resultMeta} aria-live="polite" data-testid="inspiration-result-count">
        <span>当前显示 {renderedItems.length} / {visibleItems.length} 件匹配素材</span>
        <small>当前发布 {configuredItems.length} 件 · 基础素材库 224 件（162 图片、44 视频、18 音频）</small>
      </section>

      <div className={styles.resultMeta} role={uploadedStatus === "error" ? "alert" : "status"}>
        <span>{uploadedStatus === "loading" ? "正在读取平台素材…" : uploadedStatus === "error" ? "平台素材暂时读取失败，请重试。" : `平台素材 ${uploadedItems.length} 件`}</span>
        <button type="button" disabled={uploadedStatus === "loading"} onClick={() => setUploadedRevision((value) => value + 1)}>
          {uploadedStatus === "error" ? "重试读取素材" : "刷新上传素材"}
        </button>
      </div>

      {visibleItems.length ? (
        <section className={styles.gallery} aria-label="灵感作品列表">
          {renderedItems.map((item) => {
            const displayMediaLabel = getDisplayMediaLabel(item);
            const MediaIcon = MEDIA_ICONS[displayMediaLabel];
            return (
              <article className={styles.card} key={item.id}>
                <button type="button" className={styles.cardPreview} data-ratio={item.imageRatio} onClick={() => setSelected(item)}>
                  <InspirationCardMedia item={item} />
                  <span className={styles.mediaBadge} data-media={displayMediaLabel}><MediaIcon size={12} />{displayMediaLabel}</span>
                  <span className={styles.promptBadge}><Sparkles size={12} />查看提示词</span>
                  <span className={styles.assetStatus} data-planned={item.availability === "planned" || undefined}>
                    {item.availability === "planned" ? "方案" : item.mediaType === "图片" ? "详情" : "可播放"}
                  </span>
                  <span className={styles.previewOverlay}>
                    <strong>{item.title}</strong>
                    <small>查看详情</small>
                  </span>
                </button>
                <div className={styles.cardFooter}>
                  <span className={styles.avatar}><Sparkles size={12} /></span>
                  <span>{item.authorName}</span>
                  <small>♡ {item.likes ?? 0}</small>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <section className={styles.emptyState}>
          <Search size={28} />
          <h2>没有符合条件的原创示例</h2>
          <p>请切换媒体类型、素材分类或清空搜索条件。</p>
          <button type="button" onClick={() => { setMedia("全部"); setCategory("全部分类"); setQuery(""); }}>
            清空筛选
          </button>
        </section>
      )}

      {hasMoreItems ? (
        <div ref={loadMoreRef} className={styles.loadMore} role="status" aria-live="polite">
          <button
            type="button"
            onClick={() => setVisibleLimit((current) => Math.min(current + INSPIRATION_PAGE_SIZE, visibleItems.length))}
          >
            继续加载瀑布流
            <small>还剩 {visibleItems.length - renderedItems.length} 件</small>
          </button>
        </div>
      ) : null}

      <footer className={styles.pageFooter}>
          <span>© 2026 漫剧工作台 · 关于我们 · 商务合作</span>
        <Link href="/free-canvas">进入创作画布<ArrowRight size={14} /></Link>
      </footer>

      {selected ? <InspirationDetailModal item={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
