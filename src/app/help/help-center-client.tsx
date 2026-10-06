"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  BookMarked,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileQuestion,
  Film,
  ImageIcon,
  Layers3,
  ListChecks,
  LockKeyhole,
  Maximize2,
  Pin,
  PlayCircle,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useApp } from "@/contexts/app-context";
import type {
  HelpArticle,
  HelpCategory,
  HelpCategoryId,
  PublicHelpCatalog,
  PublicHelpMedia,
} from "@/lib/help-center-domain";
import styles from "./help.module.css";
import { StoryboardModeShowcase } from "./storyboard-mode-showcase";

interface HelpCenterClientProps {
  initialSlug?: string;
  basePath?: "/help" | "/articles" | "/youcai/articles";
}

type HelpBasePath = NonNullable<HelpCenterClientProps["basePath"]>;

type CategoryFilter = "all" | HelpCategoryId;

const CATEGORY_ICONS: Record<HelpCategoryId, typeof BookOpen> = {
  "quick-start": Sparkles,
  guides: BookMarked,
  cases: Film,
  faq: FileQuestion,
  troubleshooting: AlertCircle,
};

function formatDate(value: string | null): string {
  if (!value) return "尚未发布";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待核验";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function mediaById(media: PublicHelpMedia[]): Map<string, PublicHelpMedia> {
  return new Map(media.map((item) => [item.id, item]));
}

function categoryById(categories: HelpCategory[]): Map<string, HelpCategory> {
  return new Map(categories.map((item) => [item.id, item]));
}

function sourceKindLabel(media: PublicHelpMedia): string {
  if (media.sourceKind === "generated_result") return "真实生成";
  if (media.sourceKind === "ui_capture") return "页面实拍";
  if (media.sourceKind === "test_fixture") return "示例素材";
  return "等待素材";
}

function Header({ detail, admin, basePath }: { detail: boolean; admin: boolean; basePath: HelpBasePath }) {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link className={styles.backButton} href="/" aria-label="返回应用广场">
          <ArrowLeft aria-hidden="true" />
          <span>返回</span>
        </Link>
        <div className={styles.brand}>
          <span className={styles.brandIcon}><BookOpen aria-hidden="true" /></span>
          <span>
            <strong>学习中心</strong>
            <small>使用说明、真实证据与故障排查</small>
          </span>
        </div>
        <div className={styles.headerActions}>
          {detail && <Link className={styles.headerLink} href={basePath}><Layers3 aria-hidden="true" /><span>全部文档</span></Link>}
          {admin && <Link className={styles.headerLink} href="/admin/help"><Settings2 aria-hidden="true" /><span>内容管理</span></Link>}
        </div>
      </div>
    </header>
  );
}

function LoadingState() {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite">
      <span className={styles.loadingIcon}><BookOpen aria-hidden="true" /></span>
      <div><strong>正在读取学习中心</strong><p>只加载帮助内容，不会触发任何付费生成。</p></div>
    </div>
  );
}

function EmptyState({ query, onReset }: { query: string; onReset: () => void }) {
  return (
    <div className={styles.emptyState} role="status">
      <Search aria-hidden="true" />
      <h2>没有找到匹配的文档</h2>
      <p>{query ? `没有文章同时匹配“${query}”和当前分类。` : "当前分类还没有已发布内容。"}</p>
      <button type="button" onClick={onReset}>清除筛选</button>
    </div>
  );
}

function MediaThumb({ media }: { media?: PublicHelpMedia }) {
  const [failed, setFailed] = useState(false);
  if (!media || failed) {
    return <span className={styles.thumbFallback}><ImageIcon aria-hidden="true" /></span>;
  }
  return (
    <span className={styles.thumb}>
      {/* Public help evidence uses local, versioned static assets. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={media.kind === "video" ? media.posterPath : media.assetPath} alt="" onError={() => setFailed(true)} />
      {media.kind === "video" && <PlayCircle aria-hidden="true" />}
    </span>
  );
}

function ArticleRow({
  article,
  category,
  cover,
  basePath,
}: {
  article: HelpArticle;
  category?: HelpCategory;
  cover?: PublicHelpMedia;
  basePath: HelpBasePath;
}) {
  return (
    <article className={styles.articleRow}>
      <MediaThumb media={cover} />
      <div className={styles.rowBody}>
        <div className={styles.badgeRow}>
          <span className={styles.categoryBadge}>{category?.label || "使用说明"}</span>
          {article.pinned && <span className={styles.pinnedBadge}><Pin aria-hidden="true" />置顶</span>}
          {article.recommended && <span className={styles.recommendedBadge}>推荐</span>}
        </div>
        <h2><Link href={`${basePath}/${encodeURIComponent(article.slug)}`}>{article.title}</Link></h2>
        <p>{article.summary}</p>
        <div className={styles.rowMeta}>
          <span><Clock3 aria-hidden="true" />约 {article.readMinutes} 分钟</span>
          <span>发布于 {formatDate(article.publishedAt)}</span>
          {cover && <span><ShieldCheck aria-hidden="true" />{cover.evidenceLabel}</span>}
        </div>
      </div>
      <span className={styles.rowArrow} aria-hidden="true">
        <ChevronRight aria-hidden="true" />
      </span>
    </article>
  );
}

function CategoryRail({
  categories,
  articles,
  active,
  onChange,
}: {
  categories: HelpCategory[];
  articles: HelpArticle[];
  active: CategoryFilter;
  onChange: (category: CategoryFilter) => void;
}) {
  const items: Array<{ id: CategoryFilter; label: string; description: string; count: number; Icon: typeof BookOpen }> = [
    { id: "all", label: "全部文档", description: "浏览所有已发布说明", count: articles.length, Icon: Layers3 },
    ...categories.map((category) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      count: articles.filter((article) => article.categoryId === category.id).length,
      Icon: CATEGORY_ICONS[category.id],
    })),
  ];
  return (
    <aside className={styles.rail} aria-label="学习中心分类">
      <div className={styles.railHeading}><BookMarked aria-hidden="true" /><span><strong>文档分类</strong><small>{articles.length} 篇已发布</small></span></div>
      <nav className={styles.categoryNav}>
        {items.map(({ id, label, description, count, Icon }) => (
          <button key={id} type="button" className={active === id ? styles.categoryActive : ""} aria-pressed={active === id} onClick={() => onChange(id)}>
            <Icon aria-hidden="true" />
            <span><strong>{label}</strong><small>{description}</small></span>
            <em>{count}</em>
          </button>
        ))}
      </nav>
      <div className={styles.railNote}>
        <ShieldCheck aria-hidden="true" />
        <p><strong>证据规则</strong><span>案例只发布可追溯的真实生成结果；界面截图会明确标注“页面实拍”。</span></p>
      </div>
    </aside>
  );
}

function ImageDialog({ media, onClose }: { media: PublicHelpMedia; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, [onClose]);
  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={styles.imageDialog} role="dialog" aria-modal="true" aria-labelledby="help-image-title">
        <header><div><strong id="help-image-title">{media.title}</strong><span>{media.alt}</span></div><button ref={closeRef} type="button" onClick={onClose} aria-label="关闭图片预览"><X aria-hidden="true" /></button></header>
        <div className={styles.dialogImage}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media.assetPath} alt={media.alt} />
        </div>
        <p>{media.textSummary}</p>
      </section>
    </div>
  );
}

function EvidenceMedia({ media, onZoom }: { media: PublicHelpMedia; onZoom: (media: PublicHelpMedia) => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <article className={styles.evidenceCard}>
      <div className={styles.evidenceHeading}>
        <div><span className={styles.evidenceKind}>{sourceKindLabel(media)}</span><h3>{media.title}</h3></div>
        <span className={styles.evidenceVerified}><CheckCircle2 aria-hidden="true" />已核验</span>
      </div>
      <div className={styles.mediaStage} style={{ aspectRatio: media.aspectRatio.replace(":", " / ") }}>
        {failed ? (
          <div className={styles.mediaFailed} role="status"><AlertCircle aria-hidden="true" /><strong>媒体暂时不可用</strong><span>证据说明仍保留，可从来源页面重新核验。</span></div>
        ) : media.kind === "image" ? (
          <button type="button" onClick={() => onZoom(media)} aria-label={`放大查看：${media.title}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={media.assetPath} alt={media.alt} onError={() => setFailed(true)} />
            <span><Maximize2 aria-hidden="true" />点击放大</span>
          </button>
        ) : (
          <video controls preload="metadata" poster={media.posterPath || undefined} onError={() => setFailed(true)} aria-label={media.alt}>
            <source src={media.assetPath} type="video/mp4" />
            {media.captionsPath && <track kind="captions" src={media.captionsPath} srcLang="zh-CN" label="中文说明" default />}
            当前浏览器不支持视频播放。
          </video>
        )}
      </div>
      <p className={styles.mediaSummary}>{media.textSummary}</p>
      <div className={styles.evidenceCompare}>
        <section><strong>提示词摘要</strong><p>{media.promptSummary}</p></section>
        <section><strong>参数</strong><dl>{Object.entries(media.parameters).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></section>
        <section><strong>结果与来源</strong><p>{media.publicModelName} · {formatDate(media.generatedAt)}</p><Link href={media.sourcePage}>打开来源页面<ExternalLink aria-hidden="true" /></Link></section>
      </div>
    </article>
  );
}

function DetailPage({
  article,
  category,
  media,
  preview,
  basePath,
}: {
  article: HelpArticle;
  category?: HelpCategory;
  media: PublicHelpMedia[];
  preview: boolean;
  basePath: HelpBasePath;
}) {
  const [zoomed, setZoomed] = useState<PublicHelpMedia | null>(null);
  const toc = [
    ["scene", "适用场景"],
    ["prepare", "准备内容"],
    ["steps", "操作步骤"],
    ...(media.length ? [["evidence", "真实素材"]] : []),
    ["cost", "费用与等待"],
    ["success", "成功判定"],
    ["failure", "常见失败"],
  ];
  return (
    <>
      {preview && <div className={styles.previewBanner} role="status"><LockKeyhole aria-hidden="true" /><span><strong>后台预览</strong>这篇草稿不会对普通用户显示。</span></div>}
      <div className={styles.detailGrid}>
        <article className={styles.detailArticle}>
          <div className={styles.breadcrumb}><Link href={basePath}>全部文档</Link><ChevronRight aria-hidden="true" /><span>{category?.label}</span></div>
          <header className={styles.detailHeader}>
            <div className={styles.badgeRow}><span className={styles.categoryBadge}>{category?.label}</span>{article.pinned && <span className={styles.pinnedBadge}><Pin aria-hidden="true" />置顶</span>}{article.recommended && <span className={styles.recommendedBadge}>推荐</span>}</div>
            <h1>{article.title}</h1>
            <p>{article.summary}</p>
            <div className={styles.detailMeta}><span><Clock3 aria-hidden="true" />约 {article.readMinutes} 分钟</span><span>更新于 {formatDate(article.updatedAt)}</span><span><ShieldCheck aria-hidden="true" />素材来源已分级</span></div>
          </header>
          <div className={styles.lead}>{article.body.split(/\n{2,}/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
          <section id="scene" className={styles.detailSection}><h2><BookMarked aria-hidden="true" />适用场景</h2><p>{article.applicability}</p></section>
          <section id="prepare" className={styles.detailSection}><h2><ListChecks aria-hidden="true" />准备内容</h2><ul className={styles.checkList}>{article.preparation.map((item) => <li key={item}><CheckCircle2 aria-hidden="true" /><span>{item}</span></li>)}</ul></section>
          <section id="steps" className={styles.detailSection}><h2><Layers3 aria-hidden="true" />操作步骤</h2><ol className={styles.steps}>{article.steps.map((step, index) => <li key={`${step.title}-${index}`}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.body}</p></div></li>)}</ol></section>
          {media.length > 0 && <section id="evidence" className={styles.detailSection}><div className={styles.sectionHeading}><h2><ImageIcon aria-hidden="true" />真实素材与结果对照</h2><span>内部 task/run/history 标识仅管理员可见</span></div><div className={styles.evidenceList}>{media.map((item) => <EvidenceMedia key={item.id} media={item} onZoom={setZoomed} />)}</div></section>}
          <section id="cost" className={styles.detailSection}><h2><CircleDollarSign aria-hidden="true" />费用与等待说明</h2><div className={styles.infoCallout}>{article.costAndWait}</div></section>
          <section id="success" className={styles.detailSection}><h2><CheckCircle2 aria-hidden="true" />成功判定</h2><ul className={styles.successList}>{article.successCriteria.map((item) => <li key={item}>{item}</li>)}</ul></section>
          <section id="failure" className={styles.detailSection}><h2><AlertCircle aria-hidden="true" />常见失败与处理</h2><div className={styles.failureList}>{article.failures.map((failure) => <article key={failure.problem}><strong>{failure.problem}</strong><p>{failure.action}</p></article>)}</div></section>
          {article.notes && <div className={styles.note}><ShieldCheck aria-hidden="true" /><p><strong>证据与安全说明</strong><span>{article.notes}</span></p></div>}
          <footer className={styles.detailFooter}><Link href={basePath}><ArrowLeft aria-hidden="true" />返回全部文档</Link><Link href={article.returnPath}>{article.returnLabel}<ArrowUpRight aria-hidden="true" /></Link></footer>
        </article>
        <aside className={styles.toc} aria-label="本文目录"><strong>本文目录</strong><nav>{toc.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav></aside>
      </div>
      {zoomed && <ImageDialog media={zoomed} onClose={() => setZoomed(null)} />}
    </>
  );
}

export function HelpCenterClient({ initialSlug = "", basePath = "/help" }: HelpCenterClientProps) {
  const { state } = useApp();
  const token = state.auth.token || "";
  const admin = state.auth.user?.role === "admin";
  const [catalog, setCatalog] = useState<PublicHelpCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const preview = initialSlug && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("preview") === "1";
    const url = preview ? `/api/help?preview=${encodeURIComponent(initialSlug)}` : "/api/help";
    setLoading(true);
    setError("");
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as PublicHelpCatalog & { error?: string };
        if (!response.ok) throw new Error(data.error || "学习中心暂时不可用");
        return data;
      })
      .then((data) => !cancelled && setCatalog(data))
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "学习中心暂时不可用"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [initialSlug, token]);

  useEffect(() => {
    if (initialSlug) return;
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
      if (event.key !== "/" || editing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [initialSlug]);

  const mediaMap = useMemo(() => mediaById(catalog?.media || []), [catalog?.media]);
  const categoryMap = useMemo(() => categoryById(catalog?.categories || []), [catalog?.categories]);
  const activeArticle = initialSlug ? catalog?.articles.find((article) => article.slug === initialSlug) : undefined;
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = useMemo(() => (catalog?.articles || []).filter((article) => {
    if (category !== "all" && article.categoryId !== category) return false;
    if (!normalized) return true;
    const evidence = article.mediaIds.flatMap((id) => {
      const item = mediaMap.get(id);
      return item ? [item.textSummary, item.promptSummary, ...Object.entries(item.parameters).flatMap(([key, value]) => [key, value])] : [];
    });
    const haystack = [
      article.title, article.summary, article.body, ...article.keywords,
      categoryMap.get(article.categoryId)?.label || "", ...article.preparation,
      ...article.steps.flatMap((step) => [step.title, step.body]),
      article.costAndWait, ...article.successCriteria,
      ...article.failures.flatMap((failure) => [failure.problem, failure.action]),
      ...evidence,
    ].join(" ").toLocaleLowerCase("zh-CN");
    return haystack.includes(normalized);
  }), [catalog?.articles, category, categoryMap, mediaMap, normalized]);

  return (
    <div className={styles.helpRoot}>
      <a className={styles.skipLink} href="#help-main">跳到正文</a>
      <Header detail={Boolean(initialSlug)} admin={admin} basePath={basePath} />
      <main id="help-main" className={styles.page} tabIndex={-1}>
        <div className={styles.shell}>
          {!initialSlug && (
            <>
              <section className={styles.searchPanel} aria-labelledby="help-search-title">
                <div><span className={styles.searchIcon}><Search aria-hidden="true" /></span><span><h1 id="help-search-title">快速找到下一步</h1><p>搜索功能、错误、费用或案例；首屏直接浏览，不使用营销式大 Hero。</p></span></div>
                <label className={styles.searchBox}><span className="sr-only">搜索帮助文章</span><Search aria-hidden="true" /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：图片 URL、8 秒、下载" autoComplete="off" aria-keyshortcuts="/" /><kbd>/</kbd></label>
              </section>
              <StoryboardModeShowcase />
            </>
          )}

          {error ? (
            <div className={styles.errorState} role="alert"><AlertCircle aria-hidden="true" /><div><strong>学习中心加载失败</strong><p>{error}</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></div></div>
          ) : loading || !catalog ? <LoadingState /> : initialSlug ? (
            activeArticle ? <DetailPage article={activeArticle} category={categoryMap.get(activeArticle.categoryId)} media={activeArticle.mediaIds.map((id) => mediaMap.get(id)).filter(Boolean) as PublicHelpMedia[]} preview={catalog.preview} basePath={basePath} /> : (
              <div className={styles.notFound}><FileQuestion aria-hidden="true" /><h1>这篇文档尚未发布或不存在</h1><p>草稿只允许管理员通过预览入口查看。</p><Link href={basePath}>返回全部文档</Link></div>
            )
          ) : (
            <div className={styles.browserGrid}>
              <CategoryRail categories={catalog.categories} articles={catalog.articles} active={category} onChange={setCategory} />
              <section className={styles.listPanel}>
                <header className={styles.listHeader}><div><span>{category === "all" ? "全部文档" : categoryMap.get(category)?.label}</span><h2>{normalized ? `“${query.trim()}”的搜索结果` : "紧凑浏览，点开即用"}</h2></div><strong aria-live="polite" aria-atomic="true">共 {filtered.length} 篇</strong></header>
                {filtered.length ? <div className={styles.articleList}>{filtered.map((article) => <ArticleRow key={article.id} article={article} category={categoryMap.get(article.categoryId)} cover={article.coverMediaId ? mediaMap.get(article.coverMediaId) : undefined} basePath={basePath} />)}</div> : <EmptyState query={query.trim()} onReset={() => { setQuery(""); setCategory("all"); }} />}
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
