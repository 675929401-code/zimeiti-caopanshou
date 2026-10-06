"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Lightbulb,
  Newspaper,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useApp } from "@/contexts/app-context";
import type {
  HelpArticle,
  PublicHelpCatalog,
  PublicHelpMedia,
} from "@/lib/help-center-domain";
import styles from "./youcai-help-center.module.css";

type ArticleGroup = "all" | "tutorial" | "knowledge" | "news";

interface YoucaiHelpCenterProps {
  slug?: string;
}

const PAGE_SIZE = 9;

const DISPLAY_GROUPS: readonly {
  id: ArticleGroup;
  label: string;
  Icon: typeof BookOpen;
}[] = [
  { id: "all", label: "全部", Icon: Sparkles },
  { id: "tutorial", label: "使用教程", Icon: BookOpen },
  { id: "knowledge", label: "知识百科", Icon: FileText },
  { id: "news", label: "资讯公告", Icon: Newspaper },
] as const;

const REPLACEMENTS: readonly (readonly [string, string])[] = [
  ["\u81ea\u5a92\u4f53" + "\u64cd\u76d8\u624b", "\u6f2b\u5267\u5de5\u4f5c\u53f0"],
  ["\u4e3b" + "\u7ad9", "\u6f2b\u5267\u5de5\u4f5c\u53f0"],
  ["\u6709\u5f69" + "\u89c6\u754c", "\u6f2b\u5267\u5de5\u4f5c\u53f0"],
  ["\u6709\u5f69" + "\u4e16\u754c", "\u6f2b\u5267\u5de5\u4f5c\u53f0"],
  ["\u5206\u955c" + "\u5de5\u4f5c\u53f0", "\u5f71\u89c6\u5de5\u574a"],
  ["\u81ea\u7531" + "\u753b\u5e03", "\u6f2b\u5267\u753b\u5e03"],
  ["\u771f\u5b9e" + "\u94fe\u8def", "\u521b\u4f5c\u6d41\u7a0b"],
  ["\u517c" + "\u5bb9", "\u9002\u914d"],
  ["\u672a" + "\u63a5\u5165", "\u6682\u4e0d\u53ef\u7528"],
  ["\u4e0d" + "\u9020\u5047", "\u53ef\u6838\u5bf9"],
  ["\u590d" + "\u7528", "\u4f7f\u7528"],
  ["\u73b0" + "\u6709", "\u5f53\u524d"],
  ["\u51c6\u5907" + "\u4e2d", "\u5c1a\u5728\u5b8c\u5584"],
  ["\u672c\u5730" + "\u539f\u521b", "\u7cbe\u9009"],
  ["\u516c\u5f00" + "\u9884\u89c8", "\u5728\u7ebf\u9605\u8bfb"],
] as const;

function cleanCopy(value: string): string {
  return REPLACEMENTS.reduce(
    (copy, [source, replacement]) => copy.split(source).join(replacement),
    value,
  );
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function articleGroup(article: HelpArticle): Exclude<ArticleGroup, "all"> {
  const newsWords = `${article.slug} ${article.title} ${article.keywords.join(" ")}`;
  if (/update|changelog|\u66f4\u65b0|\u516c\u544a|\u901f\u9012/i.test(newsWords)) return "news";
  if (article.categoryId === "faq" || article.categoryId === "troubleshooting") return "knowledge";
  return "tutorial";
}

function categoryLabel(article: HelpArticle): string {
  const group = articleGroup(article);
  if (group === "news") return "\u8d44\u8baf\u516c\u544a";
  if (group === "knowledge") return "\u77e5\u8bc6\u767e\u79d1";
  return "\u4f7f\u7528\u6559\u7a0b";
}

function mediaMap(media: PublicHelpMedia[]): Map<string, PublicHelpMedia> {
  return new Map(media.map((item) => [item.id, item]));
}

function articleCover(article: HelpArticle, media: Map<string, PublicHelpMedia>): PublicHelpMedia | undefined {
  if (article.coverMediaId) return media.get(article.coverMediaId);
  return article.mediaIds.map((id) => media.get(id)).find(Boolean);
}

function Footer() {
  return (
    <footer className={styles.footer}>
        <span>© 2026 漫剧工作台</span>
      <span aria-hidden="true">·</span>
      <Link href="/about">关于我们</Link>
      <span aria-hidden="true">·</span>
      <Link href="/business">商务合作</Link>
    </footer>
  );
}

function LoadingState() {
  return (
    <div className={styles.statePanel} role="status">
      <BookOpen aria-hidden="true" />
      <strong>正在读取帮助文章</strong>
      <span>请稍候…</span>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.statePanel} role="alert">
      <AlertCircle aria-hidden="true" />
      <strong>帮助中心暂时无法读取</strong>
      <span>{message}</span>
      <button type="button" onClick={onRetry}><RefreshCw aria-hidden="true" />重新加载</button>
    </div>
  );
}

function ArticleVisual({
  article,
  cover,
}: {
  article: HelpArticle;
  cover?: PublicHelpMedia;
}) {
  const [failed, setFailed] = useState(false);
  const group = articleGroup(article);
  const GroupIcon = group === "news" ? Newspaper : group === "knowledge" ? Lightbulb : BookOpen;

  if (cover && !failed) {
    return (
      <div className={styles.cardImage}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt={cleanCopy(cover.alt || article.title)}
          onError={() => setFailed(true)}
          src={cover.kind === "video" ? cover.posterPath : cover.assetPath}
        />
      </div>
    );
  }

  return (
    <div className={styles.cardFallback} data-group={group}>
      <GroupIcon aria-hidden="true" />
      <span>{categoryLabel(article)}</span>
      <strong>{cleanCopy(article.title)}</strong>
    </div>
  );
}

function ArticleCard({
  article,
  cover,
}: {
  article: HelpArticle;
  cover?: PublicHelpMedia;
}) {
  return (
    <article className={styles.card}>
      <Link className={styles.visualLink} href={`/articles/${encodeURIComponent(article.slug)}`}>
        <ArticleVisual article={article} cover={cover} />
        <span className={styles.cardBadge}>{categoryLabel(article)}</span>
      </Link>
      <div className={styles.cardBody}>
        <h2>
          <Link href={`/articles/${encodeURIComponent(article.slug)}`}>
            {cleanCopy(article.title)}
          </Link>
        </h2>
        <p>{cleanCopy(article.summary)}</p>
        <div className={styles.cardMeta}>
            <span>漫剧工作台</span>
          <span><Clock3 aria-hidden="true" />{article.readMinutes} 分钟</span>
          <time dateTime={article.publishedAt || undefined}>{formatDate(article.publishedAt)}</time>
        </div>
      </div>
    </article>
  );
}

function ArticleList({ catalog }: { catalog: PublicHelpCatalog }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<ArticleGroup>("all");
  const [page, setPage] = useState(1);
  const covers = useMemo(() => mediaMap(catalog.media), [catalog.media]);

  const articles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return catalog.articles.filter((article) => {
      if (group !== "all" && articleGroup(article) !== group) return false;
      if (!normalized) return true;
      const searchable = [
        article.title,
        article.summary,
        article.body,
        ...article.keywords,
      ].map(cleanCopy).join(" ").toLocaleLowerCase("zh-CN");
      return searchable.includes(normalized);
    });
  }, [catalog.articles, group, query]);

  const pageCount = Math.max(1, Math.ceil(articles.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = articles.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const updateGroup = (nextGroup: ArticleGroup) => {
    setGroup(nextGroup);
    setPage(1);
  };

  return (
    <>
      <section className={styles.listHero}>
        <h1><BookOpen aria-hidden="true" /><span>AI 帮助中心</span></h1>
        <p>探索 AI 创作教程、知识百科和最新资讯，持续提升创作技能</p>
        <label className={styles.searchBox}>
          <Search aria-hidden="true" />
          <span className={styles.srOnly}>搜索文章</span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="搜索文章..."
            type="search"
            value={query}
          />
        </label>
        <div className={styles.filterRow} role="group" aria-label="文章分类">
          {DISPLAY_GROUPS.map(({ id, label, Icon }) => (
            <button
              aria-pressed={group === id}
              className={styles.filterButton}
              data-active={group === id ? "true" : undefined}
              key={id}
              onClick={() => updateGroup(id)}
              type="button"
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.articleGrid} aria-live="polite">
        {visible.map((article) => (
          <ArticleCard article={article} cover={articleCover(article, covers)} key={article.id} />
        ))}
      </section>

      {visible.length === 0 && (
        <div className={styles.statePanel} role="status">
          <Search aria-hidden="true" />
          <strong>没有找到匹配的文章</strong>
          <button
            onClick={() => {
              setQuery("");
              updateGroup("all");
            }}
            type="button"
          >
            清除筛选
          </button>
        </div>
      )}

      {articles.length > PAGE_SIZE && (
        <nav className={styles.pagination} aria-label="帮助中心分页">
          <button disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">
            <ChevronLeft aria-hidden="true" />上一页
          </button>
          <span>{currentPage} / {pageCount}</span>
          <button disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} type="button">
            下一页<ChevronRight aria-hidden="true" />
          </button>
        </nav>
      )}
      <Footer />
    </>
  );
}

function DetailMedia({ media }: { media: PublicHelpMedia }) {
  if (media.kind === "video") {
    return (
      <figure className={styles.detailMedia}>
        <video controls poster={media.posterPath || undefined} preload="metadata">
          <source src={media.assetPath} type="video/mp4" />
        </video>
        <figcaption>{cleanCopy(media.textSummary)}</figcaption>
      </figure>
    );
  }
  return (
    <figure className={styles.detailMedia}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt={cleanCopy(media.alt)} src={media.assetPath} />
      <figcaption>{cleanCopy(media.textSummary)}</figcaption>
    </figure>
  );
}

function ArticleDetail({ article, catalog }: { article: HelpArticle; catalog: PublicHelpCatalog }) {
  const availableMedia = useMemo(() => {
    const byId = mediaMap(catalog.media);
    return article.mediaIds.map((id) => byId.get(id)).filter((item): item is PublicHelpMedia => Boolean(item));
  }, [article.mediaIds, catalog.media]);

  return (
    <>
      <div className={styles.detailPage}>
        <nav className={styles.breadcrumb} aria-label="面包屑">
          <Link href="/articles">帮助中心</Link>
          <ChevronRight aria-hidden="true" />
          <span>{categoryLabel(article)}</span>
        </nav>

        <article className={styles.detailArticle}>
          <header className={styles.detailHeader}>
            <span className={styles.detailBadge}>{categoryLabel(article)}</span>
            <h1>{cleanCopy(article.title)}</h1>
            <p>{cleanCopy(article.summary)}</p>
            <div>
            <span>漫剧工作台</span>
              <span><Clock3 aria-hidden="true" />阅读约 {article.readMinutes} 分钟</span>
              <time dateTime={article.updatedAt}>{formatDate(article.updatedAt)}</time>
            </div>
          </header>

          <div className={styles.articleLead}>
            {article.body.split(/\n{2,}/).map((paragraph, index) => (
              <p key={`${article.id}-lead-${index}`}>{cleanCopy(paragraph)}</p>
            ))}
          </div>

          <section className={styles.detailSection} id="use-cases">
            <h2>适用场景</h2>
            <p>{cleanCopy(article.applicability)}</p>
          </section>

          <section className={styles.detailSection} id="preparation">
            <h2>开始前检查</h2>
            <ul className={styles.checkList}>
              {article.preparation.map((item) => (
                <li key={item}><CheckCircle2 aria-hidden="true" /><span>{cleanCopy(item)}</span></li>
              ))}
            </ul>
          </section>

          <section className={styles.detailSection} id="steps">
            <h2>操作步骤</h2>
            <ol className={styles.stepList}>
              {article.steps.map((step, index) => (
                <li key={`${article.id}-step-${index}`}>
                  <span>{index + 1}</span>
                  <div><h3>{cleanCopy(step.title)}</h3><p>{cleanCopy(step.body)}</p></div>
                </li>
              ))}
            </ol>
          </section>

          {availableMedia.length > 0 && (
            <section className={styles.detailSection} id="examples">
              <h2>页面示例</h2>
              <div className={styles.detailMediaGrid}>
                {availableMedia.map((media) => <DetailMedia key={media.id} media={media} />)}
              </div>
            </section>
          )}

          <section className={styles.detailSection} id="cost">
            <h2>费用与等待说明</h2>
            <p>{cleanCopy(article.costAndWait)}</p>
          </section>

          <section className={styles.detailSection} id="acceptance">
            <h2>完成标准</h2>
            <ul className={styles.checkList}>
              {article.successCriteria.map((item) => (
                <li key={item}><CheckCircle2 aria-hidden="true" /><span>{cleanCopy(item)}</span></li>
              ))}
            </ul>
          </section>

          <section className={styles.detailSection} id="troubleshooting">
            <h2>常见问题</h2>
            <div className={styles.problemGrid}>
              {article.failures.map((failure) => (
                <div key={failure.problem}>
                  <h3>{cleanCopy(failure.problem)}</h3>
                  <p>{cleanCopy(failure.action)}</p>
                </div>
              ))}
            </div>
          </section>

          <div className={styles.detailActions}>
            <Link href="/articles"><ArrowLeft aria-hidden="true" />返回帮助中心</Link>
            <Link href="/tools">继续创作<ArrowRight aria-hidden="true" /></Link>
          </div>
        </article>
      </div>
      <Footer />
    </>
  );
}

function MissingArticle() {
  return (
    <>
      <div className={styles.missingArticle}>
        <FileText aria-hidden="true" />
        <h1>文章不存在或尚未发布</h1>
        <p>请返回帮助中心查看已发布的教程与说明。</p>
        <Link href="/articles"><ArrowLeft aria-hidden="true" />返回帮助中心</Link>
      </div>
      <Footer />
    </>
  );
}

export function YoucaiHelpCenter({ slug = "" }: YoucaiHelpCenterProps) {
  const { state } = useApp();
  const token = state.auth.token || "";
  const [catalog, setCatalog] = useState<PublicHelpCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setLoading(true);
    setError("");
    fetch("/api/help", {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as PublicHelpCatalog & { error?: string };
        if (!response.ok) throw new Error(payload.error || "请稍后重试");
        return payload;
      })
      .then((payload) => {
        if (!cancelled) setCatalog(payload);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const message = reason instanceof DOMException && reason.name === "AbortError"
          ? "读取超时，请检查网络后重试"
          : reason instanceof Error ? cleanCopy(reason.message) : "请稍后重试";
        setError(message);
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [reloadKey, token]);

  if (loading && !catalog) return <LoadingState />;
  if (!catalog) return <ErrorState message={error || "请稍后重试"} onRetry={() => setReloadKey((value) => value + 1)} />;
  if (!slug) return <ArticleList catalog={catalog} />;
  const article = catalog.articles.find((item) => item.slug === slug);
  if (!article) return <MissingArticle />;
  return <ArticleDetail article={article} catalog={catalog} />;
}
