"use client";

import { AppScopedLink } from "@/components/app-scoped-link";
import { CircleAlert, PlayCircle, Tv } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { OFFICIAL_INSPIRATION_ITEMS } from "@/features/official-inspiration/inspiration-data";
import { PublicFooter } from "./official-public-page-shared";
import styles from "./official-public-pages.module.css";

const TV_COPY = {
  title: "漫剧TV",
  description: "创作者成品短剧展示，发布你的作品让更多人看到",
  background: "/short-drama/previews/inspiration-product-film-v1.webp",
} as const;

const TV_VIDEO_ITEMS = OFFICIAL_INSPIRATION_ITEMS
  .filter((item) => item.mediaType === "视频" && item.availability !== "planned" && Boolean(item.mediaPath))
  .sort((left, right) => {
    const leftPriority = left.category === "成片" ? 1 : 0;
    const rightPriority = right.category === "成片" ? 1 : 0;
    return rightPriority - leftPriority || right.popularity - left.popularity;
  })
  .slice(0, 6);

type TvVideoItem = (typeof TV_VIDEO_ITEMS)[number];

function LazyTvPlayer({ item }: { item: TvVideoItem }) {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <video
        autoPlay
        controls
        playsInline
        poster={item.imagePath}
        preload="metadata"
        src={item.mediaPath}
      />
    );
  }

  return (
    <button
      type="button"
      className={styles.tvPosterButton}
      aria-label={`播放${item.title}`}
      onClick={() => setArmed(true)}
    >
      <img src={item.imagePath} alt="" loading="lazy" decoding="async" />
      <span aria-hidden="true"><PlayCircle size={42} /></span>
      <small>点击后加载播放</small>
    </button>
  );
}

export function OfficialTvPage() {
  return (
    <div
      className={styles.showcasePage}
      data-kind="tv"
      data-page="youcai-tv"
      style={{ "--showcase-image": `url(${TV_COPY.background})` } as CSSProperties}
    >
      <div className={styles.showcaseShade} aria-hidden="true" />
      <header className={styles.showcaseContent} aria-labelledby="showcase-tv-title">
        <span className={styles.showcaseIcon} aria-hidden="true">
          <Tv size={42} strokeWidth={1.75} />
        </span>
        <h1 id="showcase-tv-title">{TV_COPY.title}</h1>
        <p>{TV_COPY.description}</p>
        <span className={styles.launchState} data-ready="true">
          <i aria-hidden="true" />已收录 {TV_VIDEO_ITEMS.length} 条本站可播放精选
        </span>
      </header>

      <main className={styles.tvCatalog}>
        <div className={styles.showcaseSectionHeading}>
          <div>
            <PlayCircle size={22} aria-hidden="true" />
            <span><strong>本站视频精选</strong><small>来自本地版本化灵感素材库</small></span>
          </div>
          <AppScopedLink href="/inspiration">查看全部视频与提示词</AppScopedLink>
        </div>
        {TV_VIDEO_ITEMS.length ? (
          <section className={styles.tvGrid} aria-label="漫剧 TV 视频精选">
            {TV_VIDEO_ITEMS.map((item) => (
              <article className={styles.tvCard} key={item.id}>
                <LazyTvPlayer item={item} />
                <div>
                  <span>{item.category} · 本站素材</span>
                  <h2>{item.title}</h2>
                  <p>{item.summary}</p>
                  <AppScopedLink href={`/inspiration?item=${encodeURIComponent(item.id)}`}>
                    查看来源与提示词
                  </AppScopedLink>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <section className={styles.showcaseEmptyState} role="status">
            <CircleAlert size={30} aria-hidden="true" />
            <h2>当前没有可播放的本站视频</h2>
            <p>素材清单没有返回可用本地视频，页面不会用演示图冒充成片。</p>
            <AppScopedLink href="/inspiration">返回灵感广场</AppScopedLink>
          </section>
        )}
        <p className={styles.showcaseTruthNote}>
          播放与浏览只读取本站已有文件，不会提交生成任务或产生积分扣费。
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
