"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clapperboard,
  Clock3,
  FileText,
  Film,
  FolderOpen,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  Package,
  PanelsTopLeft,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  WandSparkles,
} from "lucide-react";
import { useApp } from "@/contexts/app-context";
import { safeGetItem } from "@/lib/safe-storage";
import {
  SHORT_DRAMA_ENTRY_CARDS,
  SHORT_DRAMA_FEATURED_TEMPLATE,
  SHORT_DRAMA_UTILITY_LINKS,
  SHORT_DRAMA_WORKFLOW_STEPS,
  type ShortDramaIconKey,
} from "@/lib/short-drama-navigation";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import type {
  ShortDramaProjectKind,
  ShortDramaProjectStatus,
  ShortDramaProjectSummary,
  ShortDramaProjectViewState,
} from "./types";
import styles from "@/app/short-drama/short-drama.module.css";

const ICONS: Record<ShortDramaIconKey, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  sparkles: Sparkles,
  clapperboard: Clapperboard,
  "book-open": BookOpen,
  upload: Upload,
  "file-text": FileText,
  users: Users,
  landmark: Landmark,
  package: Package,
  "panels-top-left": PanelsTopLeft,
  film: Film,
};

const PROJECT_STATUS_LABEL: Record<ShortDramaProjectStatus, string> = {
  draft: "草稿",
  processing: "处理中",
  ready: "可继续",
  failed: "需处理",
};

const MEMBER_STATUS_LABEL = {
  inactive: "未激活",
  trial: "试用中",
  active: "已激活",
  expired: "已到期",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeKind(value: unknown): ShortDramaProjectKind {
  if (
    value === "爽剧" ||
    value === "通用短剧" ||
    value === "旁白动画" ||
    value === "宠物故事" ||
    value === "正剧" ||
    value === "导入项目"
  ) return value;
  if (value === "melodrama") return "爽剧";
  if (value === "drama" || value === "long_form") return "正剧";
  if (value === "narrated_animation") return "旁白动画";
  if (value === "pet_story") return "宠物故事";
  if (value === "upload" || value === "import") return "导入项目";
  return "通用短剧";
}

function normalizeStatus(value: unknown): ShortDramaProjectStatus {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (["processing", "running", "queued", "generating", "生成中", "处理中"].includes(normalized)) return "processing";
  if (["ready", "active", "completed", "done", "可继续", "已完成"].includes(normalized)) return "ready";
  if (["failed", "error", "失败", "异常"].includes(normalized)) return "failed";
  return "draft";
}

function safeProjectHref(value: unknown, id: string): string {
  if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) return value;
  return `/tools/film-studio/projects/${encodeURIComponent(id)}`;
}

function normalizeProjects(payload: unknown): ShortDramaProjectSummary[] {
  let source: unknown[] = [];
  if (Array.isArray(payload)) {
    source = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.projects)) source = payload.projects;
    else if (Array.isArray(payload.items)) source = payload.items;
  }

  return source.filter(isRecord).map((item, index) => {
    const id = textValue(item.id ?? item.projectId, `project-${index + 1}`);
    const settings = isRecord(item.settings) ? item.settings : {};
    const sourcePayload = isRecord(item.sourcePayload) ? item.sourcePayload : {};
    const rawProgress = numberValue(item.progress ?? item.progressPercent ?? sourcePayload.progress, 0);
    const rawEpisodes = item.episodeCount ?? item.episodes ?? sourcePayload.episodeCount;
    const episodes = rawEpisodes === null || rawEpisodes === undefined
      ? null
      : Math.max(0, Math.round(numberValue(rawEpisodes, 0)));

    return {
      id,
      title: textValue(item.title ?? item.name, `未命名短剧 ${index + 1}`),
      kind: normalizeKind(item.kind ?? item.type ?? item.projectType),
      status: normalizeStatus(item.status),
      currentStage: textValue(item.currentStage ?? item.stage ?? sourcePayload.currentStage, "剧本"),
      progress: Math.min(100, Math.max(0, Math.round(rawProgress))),
      episodeCount: episodes,
      aspectRatio: textValue(item.aspectRatio ?? item.ratio ?? settings.aspectRatio, "未设置"),
      updatedAt: typeof item.updatedAt === "string"
        ? item.updatedAt
        : typeof item.updated_at === "string"
          ? item.updated_at
          : null,
      href: safeProjectHref(item.href, id),
    };
  });
}

function payloadError(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  return textValue(payload.error ?? payload.message, fallback);
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "尚未保存时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function ProjectLibraryState({
  state,
  onRetry,
}: {
  state: ShortDramaProjectViewState;
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <div className={styles.projectSkeletonGrid} role="status" aria-label="正在加载短剧项目">
        {[0, 1, 2].map((item) => (
          <div className={styles.projectSkeleton} key={item} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ))}
        <span className={styles.srOnly}>正在加载短剧项目…</span>
      </div>
    );
  }

  if (state.kind === "signed-out") {
    return (
      <div className={styles.statePanel} data-tone="neutral">
        <LockKeyhole size={28} aria-hidden="true" />
        <div>
          <h3>登录后查看项目库</h3>
          <p>请先返回首页登录；登录后刷新项目库即可查看自己的项目。</p>
        </div>
        <Link className={styles.secondaryButton} href="/">返回主站登录</Link>
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div className={styles.statePanel} data-tone="notice">
        <LayoutDashboard size={28} aria-hidden="true" />
        <div>
          <h3>项目库服务尚未启用</h3>
          <p>{state.message} 上方创作入口和既有工作台仍可正常使用。</p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={onRetry}>
          <RefreshCw size={15} />
          重新检查
        </button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className={styles.statePanel} data-tone="danger" role="alert">
        <RefreshCw size={28} aria-hidden="true" />
        <div>
          <h3>项目库加载失败</h3>
          <p>{state.message}</p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={onRetry}>
          <RefreshCw size={15} />
          重试
        </button>
      </div>
    );
  }

  if (state.projects.length === 0) {
    return (
      <div className={styles.statePanel} data-tone="empty">
        <FolderOpen size={30} aria-hidden="true" />
        <div>
          <h3>还没有短剧项目</h3>
          <p>从上方任一可用入口开始。创建行为和数据写入由目标工作台负责。</p>
        </div>
        <Link className={styles.primaryButton} href={SHORT_DRAMA_ENTRY_CARDS[0].href}>
          创建第一个项目
          <ArrowRight size={15} />
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.projectGrid}>
      {state.projects.map((project) => (
        <Link className={styles.projectCard} href={project.href} key={project.id}>
          <div className={styles.projectCardTopline}>
            <span>{project.kind}</span>
            <span data-project-status={project.status}>{PROJECT_STATUS_LABEL[project.status]}</span>
          </div>
          <h3>{project.title}</h3>
          <dl className={styles.projectMeta}>
            <div><dt>当前阶段</dt><dd>{project.currentStage}</dd></div>
            <div><dt>画幅</dt><dd>{project.aspectRatio}</dd></div>
            <div><dt>集数</dt><dd>{project.episodeCount === null ? "未设置" : `${project.episodeCount} 集`}</dd></div>
          </dl>
          <div className={styles.projectProgress}>
            <span><i style={{ width: `${project.progress}%` }} /></span>
            <b>{project.progress}%</b>
          </div>
          <p className={styles.projectUpdated}><Clock3 size={14} />{formatUpdatedAt(project.updatedAt)}</p>
        </Link>
      ))}
    </div>
  );
}

export function ShortDramaPortal() {
  const { state } = useApp();
  const [heroMotionAllowed, setHeroMotionAllowed] = useState(false);
  const [heroVideoFailed, setHeroVideoFailed] = useState(false);
  const [heroVideoReady, setHeroVideoReady] = useState(false);
  const [storedToken, setStoredToken] = useState<string | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [projectState, setProjectState] = useState<ShortDramaProjectViewState>({ kind: "loading" });

  useEffect(() => {
    setStoredToken(state.auth.token || safeGetItem(STORAGE_KEYS.AUTH_TOKEN));
    setAuthResolved(true);
  }, [state.auth.token]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => {
      setHeroMotionAllowed(!preference.matches);
      if (preference.matches) setHeroVideoReady(false);
    };
    syncPreference();
    preference.addEventListener("change", syncPreference);
    return () => preference.removeEventListener("change", syncPreference);
  }, []);

  const token = state.auth.token || storedToken;

  useEffect(() => {
    if (!authResolved) return;
    if (!token) {
      setProjectState({ kind: "signed-out" });
      return;
    }

    const controller = new AbortController();
    setProjectState({ kind: "loading" });

    void (async () => {
      try {
        const response = await fetch("/api/short-drama/projects", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => ({}));

        if (response.status === 401 || response.status === 403) {
          setProjectState({ kind: "signed-out" });
          return;
        }
        if (response.status === 404 || response.status === 501) {
          setProjectState({
            kind: "unavailable",
            message: "影视项目服务正在准备中，请稍后重试。",
          });
          return;
        }
        if (!response.ok) {
          throw new Error(payloadError(payload, "服务暂时不可用，请稍后重试。"));
        }

        setProjectState({ kind: "ready", projects: normalizeProjects(payload) });
      } catch (reason) {
        if (controller.signal.aborted) return;
        setProjectState({
          kind: "error",
          message: reason instanceof Error ? reason.message : "服务暂时不可用，请稍后重试。",
        });
      }
    })();

    return () => controller.abort();
  }, [authResolved, reloadKey, token]);

  const accountLabel = useMemo(() => {
    if (!authResolved) return "正在读取登录状态";
    if (!token || !state.auth.user) return "未登录";
    const memberStatus = state.auth.user.memberStatus;
    const statusLabel = memberStatus ? MEMBER_STATUS_LABEL[memberStatus] : "状态待服务端确认";
    return `${state.auth.user.displayName || state.auth.user.username} · ${statusLabel}`;
  }, [authResolved, state.auth.user, token]);

  return (
    <main className={styles.root}>
      <div className={styles.ambientOne} aria-hidden="true" />
      <div className={styles.ambientTwo} aria-hidden="true" />

      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link className={styles.brand} href="/" aria-label="返回自媒体操盘手主站">
            <span className={styles.brandMark}><WandSparkles size={20} /></span>
            <span><b>自媒体操盘手</b><small>影视工坊</small></span>
          </Link>
          <nav className={styles.topnav} aria-label="影视工坊导航">
            <a href="#projects">项目库</a>
            <a href="#workflow">六步流程</a>
            <Link href="/inspiration">灵感广场</Link>
            <a href="#projects">项目记录</a>
          </nav>
          <Link className={styles.topbarAction} href="/storyboard-workbench?entry=short-drama">
            进入工作台
            <ArrowRight size={15} />
          </Link>
        </header>

        <section className={styles.hero} aria-labelledby="short-drama-title">
          <Image
            className={styles.heroImage}
            src="/short-drama/previews/hero-pipeline-v1.webp"
            alt="影视创作工坊全流程横幅"
            fill
            priority
            sizes="(max-width: 900px) 100vw, 1240px"
          />
          {heroMotionAllowed && !heroVideoFailed && (
            <video
              className={`${styles.heroVideo} ${heroVideoReady ? styles.heroVideoReady : ""}`}
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              poster="/short-drama/previews/hero-pipeline-v1.webp"
              onCanPlay={() => setHeroVideoReady(true)}
              onError={() => setHeroVideoFailed(true)}
              aria-hidden="true"
            >
              <source src="/short-drama/hero-pipeline-loop-v1.webm" type="video/webm" />
              <source src="/short-drama/hero-pipeline-loop-v1.mp4" type="video/mp4" />
            </video>
          )}
          <div className={styles.heroOverlay} aria-hidden="true" />
          <div className={styles.heroContent}>
            <p className={styles.heroKicker}><Film size={16} />自媒体操盘手原创 AI 影视制作流程横幅</p>
            <h1 id="short-drama-title">从故事到成片，<br /><span>每一步都能回改。</span></h1>
            <p className={styles.heroDescription}>
              影视工坊负责组织剧本、角色、场景、道具、分镜和视频入口；实际生成继续复用主站现有工作台与服务端能力。
            </p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryButton} href="/storyboard-workbench?entry=short-drama&stage=script">
                开始创作
                <ArrowRight size={16} />
              </Link>
              <Link className={styles.glassButton} href="/inspiration">
                浏览原创灵感
              </Link>
            </div>
            <div className={styles.heroMetrics} aria-label="影视工坊能力概览">
              <span><b>6</b><small>制作阶段</small></span>
              <span><b>5</b><small>主站工作台</small></span>
              <span><b>0</b><small>入口自动生成</small></span>
            </div>
          </div>
        </section>

        <section className={styles.accountStrip} aria-label="账户状态提示">
          <span className={styles.accountIcon}><ShieldCheck size={20} /></span>
          <div>
            <strong>{accountLabel}</strong>
            <p>登录后可查看本人项目；生成能力和费用会在提交前根据当前服务状态确认。</p>
          </div>
          <span className={styles.accountBadge}>提交前确认</span>
        </section>

        <section className={styles.section} aria-labelledby="start-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>START</p>
              <h2 id="start-title">选择创作入口</h2>
            </div>
            <p>选择入口后再确认内容、模型和价格；当前页面不会自动生成。</p>
          </div>
          <div className={styles.entryGrid}>
            {SHORT_DRAMA_ENTRY_CARDS.map((entry) => {
              const Icon = ICONS[entry.icon];
              const content = (
                <>
                  <div className={styles.entryCardHeader}>
                    <span className={styles.entryIcon}><Icon size={24} strokeWidth={1.8} /></span>
                    <span className={styles.entryStatus}>
                      {entry.status === "available" ? "可用" : "暂不可用"}
                    </span>
                  </div>
                  <p className={styles.entryEyebrow}>{entry.eyebrow}</p>
                  <h3>{entry.title}</h3>
                  <p className={styles.entryDescription}>{entry.description}</p>
                  <ul>{entry.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
                  <span className={styles.entryCta}>
                    {entry.status === "available" ? "进入" : "暂不可用"}
                    {entry.status === "available" && <ArrowRight size={15} />}
                  </span>
                </>
              );

              return entry.href ? (
                <Link className={styles.entryCard} data-accent={entry.accent} href={entry.href} key={entry.key}>
                  {content}
                </Link>
              ) : (
                <article className={styles.entryCard} data-accent={entry.accent} data-disabled="true" key={entry.key}>
                  {content}
                </article>
              );
            })}
          </div>
        </section>

        <section className={styles.featuredTemplate} aria-labelledby="pet-template-title">
          <div className={styles.featuredTemplateIcon} aria-hidden="true">
            <WandSparkles size={26} />
          </div>
          <div className={styles.featuredTemplateCopy}>
            <p className={styles.eyebrow}>ADAPTED PROFILE</p>
            <h2 id="pet-template-title">{SHORT_DRAMA_FEATURED_TEMPLATE.title}</h2>
            <p>{SHORT_DRAMA_FEATURED_TEMPLATE.description}</p>
            <div className={styles.templateTags} aria-label="模板变量">
              {SHORT_DRAMA_FEATURED_TEMPLATE.variables.map((variable) => (
                <span key={variable}>变量 · {variable}</span>
              ))}
            </div>
            <div className={styles.templateConstraints} aria-label="模板硬约束">
              {SHORT_DRAMA_FEATURED_TEMPLATE.constraints.map((constraint) => (
                <span key={constraint}><CheckCircle2 size={13} />{constraint}</span>
              ))}
            </div>
          </div>
          <Link className={styles.primaryButton} href={SHORT_DRAMA_FEATURED_TEMPLATE.href}>
            使用该模板
            <ArrowRight size={15} />
          </Link>
        </section>

        <section className={styles.section} id="projects" aria-labelledby="projects-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>PROJECTS</p>
              <h2 id="projects-title">我的项目</h2>
            </div>
            <button
              className={styles.iconButton}
              type="button"
              onClick={() => setReloadKey((value) => value + 1)}
              aria-label={projectState.kind === "signed-out" ? "登录后刷新短剧项目" : "刷新短剧项目"}
              disabled={projectState.kind === "loading" || projectState.kind === "signed-out"}
            >
              <RefreshCw size={16} />
              {projectState.kind === "signed-out" ? "登录后刷新" : "刷新"}
            </button>
          </div>
          <ProjectLibraryState state={projectState} onRetry={() => setReloadKey((value) => value + 1)} />
        </section>

        <section className={styles.section} id="workflow" aria-labelledby="workflow-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>WORKFLOW</p>
              <h2 id="workflow-title">六步制作链路</h2>
            </div>
            <p>每一步都落到现有主站工具；不复制重复的生成能力。</p>
          </div>
          <ol className={styles.workflowList}>
            {SHORT_DRAMA_WORKFLOW_STEPS.map((workflow) => {
              const Icon = ICONS[workflow.icon];
              return (
                <li key={workflow.key}>
                  <Link className={styles.workflowCard} href={workflow.href}>
                    <span className={styles.workflowNumber}>{String(workflow.step).padStart(2, "0")}</span>
                    <span className={styles.workflowIcon}><Icon size={21} /></span>
                    <span className={styles.workflowCopy}>
                      <small>{workflow.key}</small>
                      <strong>{workflow.title}</strong>
                      <em>{workflow.description}</em>
                    </span>
                    <ArrowRight className={styles.workflowArrow} size={16} />
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="tools-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>CONNECTED TOOLS</p>
              <h2 id="tools-title">继续使用主站能力</h2>
            </div>
          </div>
          <div className={styles.utilityGrid}>
            {SHORT_DRAMA_UTILITY_LINKS.map((utility, index) => (
              <Link className={styles.utilityCard} href={utility.href} key={utility.href}>
                <span className={styles.utilityIndex}>{String(index + 1).padStart(2, "0")}</span>
                <h3>{utility.title}</h3>
                <p>{utility.description}</p>
                <span>{utility.label}<ArrowRight size={14} /></span>
              </Link>
            ))}
          </div>
        </section>

        <footer className={styles.footer}>
          <p><CheckCircle2 size={16} />门户页仅组织创作链路，不调用模型、不扣积分、不替代服务端鉴权。</p>
          <Link href="/">返回自媒体操盘手</Link>
        </footer>
      </div>
    </main>
  );
}
