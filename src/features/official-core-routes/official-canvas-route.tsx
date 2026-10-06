"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ImageOff, LogIn, Palette, Pause, Play, RotateCcw, Sparkles } from "lucide-react";
import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useManjuShowcaseCatalog } from "@/components/app-route-shell";
import { useApp } from "@/contexts/app-context";
import { CANVAS_SHARE_SHOWCASES } from "@/features/official-inspiration/canvas-showcase-data";
import { applyManjuCanvasOverrides } from "@/lib/manju-showcase-runtime";
import styles from "./official-canvas-route.module.css";

type CanvasShowcaseCard = (typeof CANVAS_SHARE_SHOWCASES)[number];

const SHOWCASE_COVER_PREVIEWS: Readonly<Record<string, string>> = {
  "/youcai-media/v1/canvas-showcases/paper-fox/06-cover.jpg": "/youcai-media/v1/canvas-showcases/paper-fox/06-cover.preview.webp",
  "/youcai-media/v1/canvas-showcases/m8/01-cockpit-family.jpg": "/youcai-media/v1/canvas-showcases/m8/01-cockpit-family.preview.webp",
};

function getShowcaseCoverPreview(path: string): string {
  const dedicatedPreview = SHOWCASE_COVER_PREVIEWS[path];
  if (dedicatedPreview) return dedicatedPreview;
  const match = path.match(/^\/youcai-media\/v1\/images\/([^/.]+)\.(?:png|jpe?g|webp)$/iu);
  if (!match) return path;
  return `/youcai-media/v1/thumbnails/${match[1]}.webp`;
}

function getShortDramaPreview(path: string): string {
  if (path === "/short-drama/hero-pipeline-v1.png") return "/short-drama/previews/hero-pipeline-v1.webp";
  if (path === "/short-drama/film-studio-promo-bg-v2.png") return "/short-drama/previews/film-studio-promo-bg-v2.webp";
  if (path === "/short-drama/inspiration-product-film-v1.png") return "/short-drama/previews/inspiration-product-film-v1.webp";
  return path;
}

function getBannerPreview(assetPath: string | undefined, posterPath: string): string {
  if (assetPath && /\.(?:png|jpe?g|webp|avif)$/iu.test(assetPath)) {
    return getShortDramaPreview(getShowcaseCoverPreview(assetPath));
  }
  return getShortDramaPreview(posterPath);
}

function SafeShowcaseCover({ showcase }: { showcase: CanvasShowcaseCard }) {
  const previewImage = getShowcaseCoverPreview(showcase.coverImage);
  const [imageSrc, setImageSrc] = useState(previewImage);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setImageSrc(previewImage);
  }, [previewImage, showcase.id]);

  if (failed) {
    return (
      <div className={styles.coverFallback} role="img" aria-label={`${showcase.title}封面素材待同步`}>
        <ImageOff size={26} aria-hidden="true" />
        <strong>素材待同步</strong>
        <span>封面素材暂不可用，请稍后刷新</span>
      </div>
    );
  }

  if (showcase.coverMediaType === "video") {
    return (
      <Image
        src={imageSrc}
        alt={showcase.coverAlt}
        fill
        sizes="(max-width: 760px) 100vw, (max-width: 1100px) 50vw, 25vw"
        unoptimized
        onError={() => {
          if (imageSrc !== showcase.coverImage) {
            setImageSrc(showcase.coverImage);
            return;
          }
          setFailed(true);
        }}
      />
    );
  }

  return (
    <Image
      src={imageSrc}
      alt={showcase.coverAlt}
      fill
      sizes="(max-width: 760px) 100vw, (max-width: 1100px) 50vw, 25vw"
      unoptimized
      onError={() => {
        if (imageSrc !== showcase.coverImage) {
          setImageSrc(showcase.coverImage);
          return;
        }
        setFailed(true);
      }}
    />
  );
}

export function OfficialCanvasRoute() {
  const { state } = useApp();
  const showcaseCatalog = useManjuShowcaseCatalog();
  const [bannerVideoActive, setBannerVideoActive] = useState(false);
  const [bannerVideoFailed, setBannerVideoFailed] = useState(false);
  const configuredShowcases = useMemo(
    () => applyManjuCanvasOverrides(CANVAS_SHARE_SHOWCASES, showcaseCatalog),
    [showcaseCatalog],
  );
  const bannerOverride = showcaseCatalog?.banners.overrides["canvas:0"];
  const bannerVideo = bannerOverride?.asset?.path || "/youcai-media/v1/featured/canvas-banner-youcai.mp4";
  const bannerPoster = bannerOverride?.poster?.path || "/short-drama/hero-pipeline-v1.png";
  const bannerPreview = getBannerPreview(bannerOverride?.asset?.path, bannerPoster);
  const authenticated = state.auth.isAuthenticated;
  const accountHref = authenticated
    ? "/youcai/free-canvas"
    : "/login?redirect=%2Fyoucai%2Ffree-canvas";

  useEffect(() => {
    setBannerVideoActive(false);
    setBannerVideoFailed(false);
  }, [bannerVideo]);

  return (
    <div className={styles.page} data-testid="official-canvas-page">
      <div className={styles.content}>
        {bannerOverride?.enabled === false ? null : (
          <div className={styles.banner} aria-label="无限画布工作流动态演示">
            <video
              key={`${bannerVideo}:${bannerVideoActive ? "active" : "poster"}`}
              className={styles.bannerVideo}
              aria-label="多模态节点工作流循环视频"
              autoPlay={bannerVideoActive}
              muted
              loop
              playsInline
              preload="none"
              poster={bannerPreview}
              onError={() => {
                setBannerVideoActive(false);
                setBannerVideoFailed(true);
              }}
            >
              {bannerVideoActive ? <source src={bannerVideo} type="video/mp4" /> : null}
            </video>
            <div className={styles.bannerGlow} aria-hidden="true" />
            <button
              className={styles.bannerControl}
              type="button"
              aria-pressed={bannerVideoActive}
              aria-label={bannerVideoActive ? "停止画布创作演示并释放视频流量" : bannerVideoFailed ? "重新加载画布创作演示" : "播放画布创作演示"}
              onClick={() => {
                setBannerVideoFailed(false);
                setBannerVideoActive((current) => !current);
              }}
            >
              {bannerVideoActive ? <Pause size={19} fill="currentColor" /> : bannerVideoFailed ? <RotateCcw size={19} /> : <Play size={19} fill="currentColor" />}
              <span>{bannerVideoActive ? "停止演示" : bannerVideoFailed ? "重新加载" : "播放演示"}</span>
            </button>
            <span className={styles.bannerLabel}>{bannerVideoActive ? "画布创作演示 · 静音循环" : bannerVideoFailed ? "视频加载失败 · 海报仍可用" : "海报预览 · 点击后按需加载视频"}</span>
          </div>
        )}

        <section className={styles.hero} aria-labelledby="canvas-heading">
          <div className={styles.heroCopy}>
            <span className={styles.heroIcon} aria-hidden="true"><Palette size={24} strokeWidth={2.2} /></span>
            <div>
              <h1 id="canvas-heading">无限画布</h1>
              <p>可视化编排 AI 工具，节点式搭建自定义创作工作流</p>
            </div>
          </div>
          <Link className={styles.loginButton} href={accountHref} prefetch={false}>
            <LogIn size={16} aria-hidden="true" />
            <span>{authenticated ? "创建画布" : "登录后使用"}</span>
          </Link>
        </section>

        <section className={styles.showcaseSection} aria-labelledby="showcase-heading">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="showcase-heading"><Sparkles size={18} aria-hidden="true" />从示例开始</h2>
              <p>查看完整创作流程，复制后即可继续编辑和创作。</p>
            </div>
            <span>当前发布 {configuredShowcases.length} 个创作工作流</span>
          </div>

          <div className={styles.showcaseGrid}>
            {configuredShowcases.map((showcase) => (
              <Link
                className={styles.showcaseCard}
                data-cover-media-type={showcase.coverMediaType}
                data-showcase-id={showcase.id}
                href={`/youcai/share/canvas/${showcase.id}`}
                prefetch={false}
                aria-label={`查看并复制${showcase.title}`}
                key={showcase.id}
              >
                <div className={styles.cover}>
                  <SafeShowcaseCover showcase={showcase} />
                  <span className={styles.featuredBadge}><Sparkles size={12} />精选示例</span>
                  {showcase.tag ? <span className={styles.tag}>{showcase.tag}</span> : null}
                </div>
                <div className={styles.cardBody}>
                  <h3>{showcase.title}</h3>
                  <p>{showcase.description}</p>
                  <div className={styles.cardActionRow}>
                    <span>查看并复制</span>
                    <span className={styles.arrowButton}>
                      <ArrowUpRight size={15} />
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {configuredShowcases.length === 0 ? <p>当前没有已发布的画布示例。</p> : null}
        </section>

        <section className={styles.myCanvasSection} aria-labelledby="my-canvas-heading">
          <h2 id="my-canvas-heading">我的画布</h2>
          <p>创建并管理属于你的创作空间。</p>
          <Link className={styles.createCard} href={accountHref} prefetch={false}>
            <span className={styles.createIcon}><LogIn size={23} /></span>
            <strong>{authenticated ? "创建新画布" : "登录后创建画布"}</strong>
            <small>可视化编排多模态创作</small>
          </Link>
        </section>
      </div>

      <footer className={styles.footer}>
        <span>© 2026 漫剧工作台</span>
        <span>·</span>
        <Link href="/youcai/about">关于我们</Link>
        <span>·</span>
        <Link href="/youcai/business">商务合作</Link>
      </footer>
    </div>
  );
}
