"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useManjuShowcaseCatalog } from "@/components/app-route-shell";
import { Clock3, Search } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import {
  CATEGORY_TABS,
  TOOL_CATEGORIES,
  type ToolCategory,
  type ToolDirectoryCard,
  type ToolTag,
} from "./tool-directory-data";
import styles from "./official-tool-directory.module.css";

type DirectoryFilter = "all" | ToolTag;

const FILTERS: readonly { value: DirectoryFilter; label: string; icon?: string }[] = [
  { value: "all", label: "全部标签" },
  { value: "热门", label: "热门", icon: "🔥" },
  { value: "推荐", label: "推荐", icon: "⭐" },
  { value: "新增", label: "新增", icon: "✨" },
  { value: "优惠", label: "优惠", icon: "💰" },
];

const TAG_ICONS: Record<ToolTag, string> = {
  热门: "🔥",
  推荐: "⭐",
  新增: "✨",
  优惠: "💰",
};

const MODEL_BINDING_PENDING_SLUGS = new Set([
  "drama-script",
  "kling-image", "openrouter-image", "qwen-image", "volcengine-image",
  "minimax-tts", "mimo-tts", "mimo-voice-design", "mimo-voice-clone",
  "seedance-video", "minimax-video", "kling-video",
  "happyhorse-t2v", "happyhorse-i2v", "happyhorse-r2v",
  "wanx-t2v", "wanx-i2v", "wanx-r2v", "wanx-video-edit", "volcengine-video",
]);

const LOCAL_EXTENSION_SLUGS = new Set([
  "minimax-music", "upload-script", "aliyun-erase-subtitles", "video-edit",
]);

function officialToolSlug(tool: ToolDirectoryCard): string {
  return tool.officialPath?.split("/").at(-1) || "";
}

function ToolCard({ tool }: { tool: ToolDirectoryCard }) {
  const slug = officialToolSlug(tool);
  const workspaceHref = tool.availability === "available"
    ? (tool.officialPath || tool.href)
    : undefined;
  const modelBindingPending = tool.availability === "available" && MODEL_BINDING_PENDING_SLUGS.has(slug);
  const localExtension = tool.availability === "available" && LOCAL_EXTENSION_SLUGS.has(slug);
  const displayedPrice = modelBindingPending
    ? "工作台内确认"
    : slug === "aliyun-erase-subtitles" || slug === "video-edit"
      ? "本地处理"
      : tool.price;
  const content = (
    <>
      <div className={styles.cardVisual} style={{ background: tool.accent }}>
        <span className={styles.cardEyebrow}>{tool.eyebrow}</span>
        <div className={styles.visualGlow} aria-hidden="true" />
        <tool.Icon size={48} strokeWidth={1.45} aria-hidden="true" />
        <strong>{tool.title}</strong>
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <h3>{tool.title}</h3>
          {tool.availability === "coming" ? (
            <span className={styles.comingState}><Clock3 size={12} aria-hidden="true" />即将上线</span>
          ) : tool.availability === "retired" ? (
            <span className={styles.comingState}><Clock3 size={12} aria-hidden="true" />已下线</span>
          ) : modelBindingPending ? (
            <span className={styles.contractState}>通用能力</span>
          ) : localExtension ? (
            <span className={styles.localState}>本地能力</span>
          ) : null}
        </div>
        <p>{tool.description}</p>
        <div className={styles.cardFooter}>
          <span className={styles.price}>{displayedPrice}</span>
          {tool.promotion ? <span className={styles.promotion}>{tool.promotion}</span> : null}
          <span className={styles.tags}>
            {tool.tags.map((tag) => <small key={tag}>{TAG_ICONS[tag]} {tag}</small>)}
          </span>
        </div>
      </div>
    </>
  );

  if (workspaceHref) {
    return (
      <Link
        className={styles.toolCard}
        data-availability={tool.availability}
        data-official-path={tool.officialPath}
        href={workspaceHref}
        aria-label={`打开${tool.title}`}
      >
        {content}
      </Link>
    );
  }

  return (
    <article className={styles.toolCard} data-disabled="true" data-official-path={tool.officialPath}>
      {content}
    </article>
  );
}

export function OfficialToolDirectory({ category }: { category: ToolCategory }) {
  const config = TOOL_CATEGORIES[category];
  const showcaseCatalog = useManjuShowcaseCatalog();
  const bannerOverride = showcaseCatalog?.banners.overrides[`${category}:0`];
  const bannerImage = bannerOverride?.poster?.path || bannerOverride?.asset?.path || config.bannerImage;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DirectoryFilter>("all");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");

  const visibleTools = useMemo(() => config.tools.filter((tool) => {
    const matchesFilter = filter === "all" || tool.tags.includes(filter);
    const haystack = `${tool.title} ${tool.description} ${tool.tags.join(" ")}`.toLocaleLowerCase("zh-CN");
    return matchesFilter && (!normalizedQuery || haystack.includes(normalizedQuery));
  }), [config.tools, filter, normalizedQuery]);

  return (
    <main
      className={styles.directoryPage}
      data-official-tool-directory="true"
      style={{ "--directory-accent": config.accent } as CSSProperties}
    >
      {bannerOverride?.enabled === false ? null : (
        <section
          className={styles.categoryBanner}
          aria-label={`${config.label}主题横幅`}
          style={{ "--banner-image": `url(${bannerImage})` } as CSSProperties}
        >
          <div className={styles.bannerMesh} aria-hidden="true" />
          <config.Icon size={58} strokeWidth={1.3} aria-hidden="true" />
          <div className={styles.bannerCopy}>
            <strong>{config.bannerTitle}</strong>
            <span>{config.bannerSubtitle}</span>
          </div>
        </section>
      )}

      <nav className={styles.categoryTabs} aria-label="创作类型">
        {CATEGORY_TABS.map((tab) => (
          <Link key={tab.category} href={tab.href} data-active={tab.category === category ? "true" : undefined}>
            <tab.Icon size={17} aria-hidden="true" />
            {tab.label}
          </Link>
        ))}
      </nav>

      <header className={styles.directoryHeading}>
        <config.Icon size={36} strokeWidth={1.8} aria-hidden="true" />
        <h1>{config.label}</h1>
        <p>{config.description}</p>
      </header>

      <section className={styles.toolControls} aria-label="工具筛选">
        <label className={styles.searchBox}>
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">搜索工具</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工具名称或描述"
          />
        </label>
        <div className={styles.filterGroup} role="group" aria-label="标签筛选">
          {FILTERS.map(({ value, label, icon }) => (
            <button key={value} type="button" data-active={filter === value ? "true" : undefined} onClick={() => setFilter(value)}>
              {icon ? <span aria-hidden="true">{icon}</span> : null}{label}
            </button>
          ))}
        </div>
        <span className={styles.toolCount}>{visibleTools.length} / {config.tools.length} 个工具</span>
      </section>

      {visibleTools.length > 0 ? (
        <section className={styles.toolGrid} aria-label={`${config.label}工具列表`}>
          {visibleTools.map((tool) => <ToolCard key={tool.title} tool={tool} />)}
        </section>
      ) : (
        <div className={styles.emptyState}>
          <Search size={28} aria-hidden="true" />
          <strong>没有找到相关工具</strong>
          <span>换个关键词或标签试试。</span>
        </div>
      )}

      <footer className={styles.directoryFooter}>© 2026 漫剧工作台 · 关于我们 · 商务合作 · 帮助中心</footer>
    </main>
  );
}
