"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Film,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useApp } from "@/contexts/app-context";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { safeGetItem } from "@/lib/safe-storage";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import {
  readAgentWorkbenchHandoff,
  type AgentWorkbenchHandoffEnvelope,
} from "@/lib/agent-workbench-handoff";
import {
  parseStoryboardCanvasImport,
  type StoryboardCanvasImportPlan,
} from "@/lib/storyboard-canvas-bridge";
import {
  FILM_STUDIO_ENTRY_CARDS,
  FILM_STUDIO_WORKFLOW,
  type FilmStudioIconKey,
} from "./navigation";
import styles from "./youcai-film-studio.module.css";

const ENTRY_TEST_IDS = {
  爽剧: "film-entry-drama-script",
  通用短剧: "film-entry-general-script",
  正剧: "film-entry-long-script",
  上传剧本: "film-entry-upload-script",
} as const;

const ENTRY_GLYPHS: Record<FilmStudioIconKey, string> = {
  flame: "🔥",
  clapperboard: "🎬",
  "book-open": "📖",
  "file-up": "📄",
};

const PROJECT_STATUS_LABEL = {
  draft: "草稿",
  processing: "处理中",
  ready: "可继续",
  failed: "需处理",
} as const;

const READ_ONLY_PROJECTS_ENDPOINT = "/api/drama/projects";

type ProjectKind = "爽剧" | "通用短剧" | "正剧" | "导入项目";
type ProjectStatus = keyof typeof PROJECT_STATUS_LABEL;
type ProjectKindFilter = "all" | ProjectKind;
type ProjectSort = "created-desc" | "created-asc" | "updated-desc" | "title";

interface FilmProjectPreview {
  readonly assetId: string;
  readonly assetRole: string;
  readonly mimeType: string;
  readonly previewUrl: string;
  readonly createdAt: string;
}

interface FilmProject {
  readonly id: string;
  readonly title: string;
  readonly kind: ProjectKind;
  readonly status: ProjectStatus;
  readonly currentStage: string;
  readonly progress: number;
  readonly revision: number;
  readonly episodeCount: number | null;
  readonly aspectRatio: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly preview: FilmProjectPreview | null;
}

type ProjectViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out"; readonly reason: "missing-session" | "expired-session" }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "ready"; readonly projects: readonly FilmProject[] };

type AgentFilmHandoffState =
  | { readonly kind: "hidden" }
  | { readonly kind: "ready"; readonly handoff: AgentWorkbenchHandoffEnvelope; readonly plan: StoryboardCanvasImportPlan }
  | { readonly kind: "creating"; readonly handoff: AgentWorkbenchHandoffEnvelope; readonly plan: StoryboardCanvasImportPlan }
  | { readonly kind: "error"; readonly error: string; readonly handoff?: AgentWorkbenchHandoffEnvelope; readonly plan?: StoryboardCanvasImportPlan };

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

function projectApiError(payload: unknown): { code: string; message: string } {
  if (!isRecord(payload)) {
    return {
      code: "PROJECT_SERVICE_UNAVAILABLE",
      message: "项目服务暂时不可用，请稍后重试。",
    };
  }

  const code = typeof payload.code === "string" ? payload.code : "PROJECT_SERVICE_UNAVAILABLE";
  if (code === "MIGRATION_NOT_READY") {
    return {
      code,
      message: "影视项目服务正在准备中；当前可继续整理素材，稍后再创建项目。",
    };
  }
  if (code === "PROJECT_DATABASE_UNAVAILABLE") {
    return {
      code,
      message: "影视项目暂时无法读取，请稍后重试。",
    };
  }
  if (code === "AUTH_DATABASE_UNAVAILABLE" || code === "CATEGORY_DATABASE_UNAVAILABLE") {
    return {
      code,
      message: "账号服务暂时无法确认，请稍后重新登录并重试。",
    };
  }

  return {
    code,
    message: "项目服务暂时不可用，请稍后重试。",
  };
}

function normalizeKind(value: unknown): ProjectKind {
  if (value === "爽剧" || value === "melodrama") return "爽剧";
  if (value === "正剧" || value === "drama" || value === "long_form") return "正剧";
  if (value === "上传剧本" || value === "导入项目" || value === "upload" || value === "import") {
    return "导入项目";
  }
  return "通用短剧";
}

function normalizeStatus(value: unknown): ProjectStatus {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (["processing", "running", "queued", "generating", "生成中", "处理中"].includes(normalized)) {
    return "processing";
  }
  if (["ready", "active", "completed", "done", "可继续", "已完成"].includes(normalized)) {
    return "ready";
  }
  if (["failed", "error", "失败", "异常"].includes(normalized)) return "failed";
  return "draft";
}

function normalizeProjects(payload: unknown): FilmProject[] {
  let source: unknown[] = [];
  if (Array.isArray(payload)) {
    source = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.projects)) source = payload.projects;
    else if (Array.isArray(payload.items)) source = payload.items;
    else if (Array.isArray(payload.data)) source = payload.data;
    else if (isRecord(payload.data) && Array.isArray(payload.data.projects)) {
      source = payload.data.projects;
    }
  }

  return source.filter(isRecord).map((item, index) => {
    const settings = isRecord(item.settings) ? item.settings : {};
    const sourcePayload = isRecord(item.sourcePayload) ? item.sourcePayload : {};
    const sourceSummary = isRecord(sourcePayload.summary) ? sourcePayload.summary : {};
    const rawEpisodes = item.episodeCount ?? item.episodes ?? sourcePayload.episodeCount;

    return {
      id: textValue(item.id ?? item.projectId, `project-${index + 1}`),
      title: textValue(item.title ?? item.name, `未命名项目 ${index + 1}`),
      kind: normalizeKind(sourceSummary.genre ?? item.kind ?? item.type ?? item.projectType),
      status: normalizeStatus(item.status),
      currentStage: textValue(item.currentStage ?? item.stage ?? sourcePayload.currentStage, "剧本"),
      progress: Math.min(
        100,
        Math.max(0, Math.round(numberValue(item.progress ?? item.progressPercent ?? sourcePayload.progress, 0))),
      ),
      revision: Math.max(1, Math.round(numberValue(item.revision, 1))),
      episodeCount: rawEpisodes === null || rawEpisodes === undefined
        ? null
        : Math.max(0, Math.round(numberValue(rawEpisodes, 0))),
      aspectRatio: textValue(item.aspectRatio ?? item.ratio ?? settings.aspectRatio, "未设置"),
      createdAt: typeof item.createdAt === "string"
        ? item.createdAt
        : typeof item.created_at === "string"
          ? item.created_at
          : null,
      updatedAt: typeof item.updatedAt === "string"
        ? item.updatedAt
        : typeof item.updated_at === "string"
          ? item.updated_at
          : null,
      preview: null,
    };
  });
}

function normalizeProjectPreviews(payload: unknown): Map<string, FilmProjectPreview> {
  if (!isRecord(payload) || !Array.isArray(payload.previews)) return new Map();
  return new Map(payload.previews.flatMap((item): Array<[string, FilmProjectPreview]> => {
    if (!isRecord(item) || typeof item.projectId !== "string" || typeof item.assetId !== "string") return [];
    return [[item.projectId, {
      assetId: item.assetId,
      assetRole: textValue(item.assetRole, "asset"),
      mimeType: textValue(item.mimeType, ""),
      previewUrl: textValue(item.previewUrl, ""),
      createdAt: textValue(item.createdAt, ""),
    }]];
  }));
}

function updatedTimestamp(value: string | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatProjectTime(value: string | null): string {
  if (!value) return "暂无提交时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无提交时间";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function ProjectLibraryState({
  state,
  filtered,
  onRetry,
  onDelete,
  deletingProjectId,
}: {
  readonly state: ProjectViewState;
  readonly filtered: boolean;
  readonly onRetry: () => void;
  readonly onDelete: (project: FilmProject) => void;
  readonly deletingProjectId: string;
}) {
  if (state.kind === "loading") {
    return (
      <div className={styles.projectSkeletonGrid} role="status" aria-label="正在加载项目">
        {[0, 1, 2].map((item) => (
          <div className={styles.projectSkeleton} key={item} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ))}
        <span className={styles.srOnly}>正在加载项目…</span>
      </div>
    );
  }

  if (state.kind === "signed-out") {
    const expired = state.reason === "expired-session";
    return (
      <div className={styles.emptyPanel} data-auth-state={state.reason}>
        <Film size={29} aria-hidden="true" />
        <h3>{expired ? "登录状态已失效" : "登录后查看我的项目"}</h3>
        <p>
          {expired
            ? "项目数据未加载，请重新登录后再继续。"
            : "登录账号后可继续管理剧本、角色、场景、分镜与视频项目。"}
        </p>
        <Link className={styles.reloadButton} href="/login?redirect=%2Fyoucai%2Ftools%2Ffilm-studio">
          {expired ? "重新登录" : "去登录"}
        </Link>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className={styles.failurePanel} data-error-code={state.code} role="alert">
        <AlertTriangle size={29} aria-hidden="true" />
        <h3>项目加载失败</h3>
        <p>{state.message}</p>
        <button type="button" className={styles.reloadButton} onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          重新加载
        </button>
      </div>
    );
  }

  if (state.projects.length === 0) {
    return (
      <div className={styles.emptyPanel}>
        <Film size={28} aria-hidden="true" />
        <h3>{filtered ? "没有匹配的项目" : "暂无项目"}</h3>
        <p>{filtered ? "请调整项目名称或剧种筛选。" : "从上方选择一种创作方式开始。"}</p>
      </div>
    );
  }

  return (
    <div className={styles.projectGrid}>
      {state.projects.map((project) => (
        <article className={styles.projectCard} key={project.id}>
          <Link
            aria-label={`继续编辑项目：${project.title}`}
            className={styles.projectCardLink}
            data-testid="film-project-card-link"
            href={`/tools/film-studio/projects/${encodeURIComponent(project.id)}`}
          >
            <div className={styles.projectPreview} data-preview-role={project.preview?.assetRole || "none"}>
              {project.preview?.previewUrl ? (
                project.preview.mimeType.startsWith("video/") || project.preview.assetRole === "export" || project.preview.assetRole === "video"
                  ? (
                    <video
                      aria-label={`${project.title} 视频预览`}
                      muted
                      playsInline
                      preload="metadata"
                      src={project.preview.previewUrl}
                    />
                  )
                  : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={project.preview.previewUrl} alt={`${project.title} 图片预览`} />
                  )
              ) : (
                <span><Film size={28} aria-hidden="true" />尚无已归档媒体预览</span>
              )}
              {project.preview && (
                <b>{project.preview.assetRole === "export" ? "最终成片" : project.preview.assetRole === "video" ? "最新视频 TAKE" : "最新图片"}</b>
              )}
            </div>
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
            <p className={styles.projectUpdated}>
              <CalendarDays size={14} aria-hidden="true" />
              提交于 {formatProjectTime(project.createdAt)}
            </p>
          </Link>
          <button
            aria-label={`删除项目：${project.title}`}
            className={styles.projectDeleteButton}
            type="button"
            disabled={Boolean(deletingProjectId)}
            onClick={() => onDelete(project)}
          >
            {deletingProjectId === project.id
              ? <RefreshCw className={styles.spinning} size={14} />
              : <Trash2 size={14} />}
          </button>
        </article>
      ))}
    </div>
  );
}

export function YoucaiFilmStudioPortal() {
  const { state } = useApp();
  const router = useAppScopedRouter();
  const [storedToken, setStoredToken] = useState<string | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [promoSlide, setPromoSlide] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [projectState, setProjectState] = useState<ProjectViewState>({ kind: "loading" });
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<ProjectKindFilter>("all");
  const [sortOrder, setSortOrder] = useState<ProjectSort>("created-desc");
  const [agentHandoff, setAgentHandoff] = useState<AgentFilmHandoffState>({ kind: "hidden" });
  const agentHandoffConsumedRef = useRef(false);
  const [deletingProjectId, setDeletingProjectId] = useState("");

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("entry") !== "agent" || searchParams.get("handoff") !== "storyboard") return;
    if (agentHandoffConsumedRef.current) return;
    agentHandoffConsumedRef.current = true;
    const parsed = readAgentWorkbenchHandoff("film-studio");
    if (!parsed.ok) {
      setAgentHandoff({ kind: "error", error: parsed.error });
      return;
    }
    const plan = parseStoryboardCanvasImport(parsed.handoff.payload);
    if (!plan) {
      setAgentHandoff({ kind: "error", error: "Agent 分镜机器包未通过影视工坊校验，未创建项目。" });
      return;
    }
    setAgentHandoff({ kind: "ready", handoff: parsed.handoff, plan });
  }, []);

  useEffect(() => {
    setStoredToken(state.auth.token || safeGetItem(STORAGE_KEYS.AUTH_TOKEN));
    setAuthResolved(true);
  }, [state.auth.token]);

  const token = state.auth.token || storedToken;

  useEffect(() => {
    if (!authResolved) return;
    if (!token) {
      setProjectState({ kind: "signed-out", reason: "missing-session" });
      return;
    }

    const controller = new AbortController();
    setProjectState({ kind: "loading" });

    void (async () => {
      try {
        const response = await fetch(READ_ONLY_PROJECTS_ENDPOINT, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => ({}));

        if (response.status === 401 || response.status === 403) {
          setProjectState({ kind: "signed-out", reason: "expired-session" });
          return;
        }
        if (!response.ok) {
          setProjectState({ kind: "error", ...projectApiError(payload) });
          return;
        }
        const projects = normalizeProjects(payload);
        setProjectState({ kind: "ready", projects });
        if (projects.length > 0) {
          const previewResponse = await fetch(
            `/api/drama/projects/previews?ids=${encodeURIComponent(projects.map((project) => project.id).join(","))}`,
            {
              method: "GET",
              headers: { Authorization: `Bearer ${token}` },
              cache: "no-store",
              signal: controller.signal,
            },
          );
          const previewPayload: unknown = await previewResponse.json().catch(() => ({}));
          if (previewResponse.ok && !controller.signal.aborted) {
            const previews = normalizeProjectPreviews(previewPayload);
            setProjectState({
              kind: "ready",
              projects: projects.map((project) => ({
                ...project,
                preview: previews.get(project.id) || null,
              })),
            });
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setProjectState({
            kind: "error",
            code: "NETWORK_ERROR",
            message: "无法连接项目服务，请检查本地服务是否运行后再重试。",
          });
        }
      }
    })();

    return () => controller.abort();
  }, [authResolved, reloadKey, token]);

  const allProjects = useMemo(
    () => projectState.kind === "ready" ? projectState.projects : [],
    [projectState],
  );

  const visibleProjects = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase("zh-CN");
    const filtered = allProjects.filter((project) => {
      const matchesQuery = !query || project.title.toLocaleLowerCase("zh-CN").includes(query);
      const matchesKind = kindFilter === "all" || project.kind === kindFilter;
      return matchesQuery && matchesKind;
    });

    return [...filtered].sort((left, right) => {
      if (sortOrder === "title") return left.title.localeCompare(right.title, "zh-CN");
      if (sortOrder === "updated-desc") {
        return updatedTimestamp(right.updatedAt) - updatedTimestamp(left.updatedAt);
      }
      const difference = updatedTimestamp(left.createdAt) - updatedTimestamp(right.createdAt);
      return sortOrder === "created-asc" ? difference : -difference;
    });
  }, [allProjects, kindFilter, searchQuery, sortOrder]);

  const visibleProjectState: ProjectViewState = projectState.kind === "ready"
    ? { kind: "ready", projects: visibleProjects }
    : projectState;
  const filtersApplied = Boolean(searchQuery.trim()) || kindFilter !== "all";
  const projectCount = projectState.kind === "ready" ? projectState.projects.length : null;

  async function deleteProject(project: FilmProject) {
    if (
      !token
      || deletingProjectId
      || !window.confirm(`确认删除项目“${project.title}”？项目将从当前列表归档；进行中的生成任务会被服务端阻止删除。`)
    ) return;
    setDeletingProjectId(project.id);
    try {
      const response = await fetch(
        `/api/short-drama/projects/${encodeURIComponent(project.id)}?expectedRevision=${project.revision}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const failure = projectApiError(payload);
        throw new Error(`${failure.message}（${failure.code}）`);
      }
      setProjectState((current) => current.kind === "ready"
        ? { kind: "ready", projects: current.projects.filter((candidate) => candidate.id !== project.id) }
        : current);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "项目删除失败，请刷新后重试。");
    } finally {
      setDeletingProjectId("");
    }
  }

  async function confirmAgentFilmHandoff() {
    if (agentHandoff.kind !== "ready" || !token) {
      if (agentHandoff.kind === "ready" && !token) {
        setAgentHandoff({ ...agentHandoff, kind: "error", error: "请先登录；未登录状态不会创建影视工坊项目。" });
      }
      return;
    }
    const { handoff, plan } = agentHandoff;
    setAgentHandoff({ kind: "creating", handoff, plan });
    const sourceTitle = plan.sourceScript.replace(/\s+/gu, " ").trim().slice(0, 34);
    const title = sourceTitle ? `Agent 漫剧 · ${sourceTitle}`.slice(0, 120) : "Agent 漫剧项目";
    const clientRequestId = `agent-${handoff.handoff_id}`
      .replace(/[^A-Za-z0-9._:-]/gu, "-")
      .slice(0, 128);

    try {
      const response = await fetch("/api/short-drama/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": clientRequestId,
        },
        body: JSON.stringify({
          clientRequestId,
          title,
          description: `由创作 Agent 的 ${plan.schemaVersion} 稳定机器包创建，共 ${plan.segments.length} 个分镜生产段。`,
          projectType: "narrated_animation",
          sourcePayload: {
            schemaVersion: "agent-film-studio-import.v1",
            handoffId: handoff.handoff_id,
            sourceRoute: handoff.source_route,
            sourceScript: plan.sourceScript,
            summary: {
              genre: "漫剧",
              animationStyle: plan.settings.animationStyle,
              aspectRatio: plan.settings.aspectRatio,
            },
            segments: plan.segments,
            currentStage: "剧本",
            progress: 0,
            episodeCount: 1,
          },
          settings: {
            aspectRatio: plan.settings.aspectRatio,
            outputLanguage: "zh-CN",
            animationStyle: plan.settings.animationStyle.slice(0, 120),
            noCharacterSpeech: true,
            defaultShotDurationSeconds: plan.settings.targetDurationSeconds,
          },
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      const project = isRecord(payload) && isRecord(payload.project) ? payload.project : null;
      const projectId = project && typeof project.id === "string" ? project.id : "";
      if (!response.ok || !projectId) {
        const failure = projectApiError(payload);
        throw new Error(`${failure.message}（${failure.code}）`);
      }

      const readback = await fetch(`/api/short-drama/projects/${encodeURIComponent(projectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const readbackPayload: unknown = await readback.json().catch(() => ({}));
      const readbackProject = isRecord(readbackPayload) && isRecord(readbackPayload.project)
        ? readbackPayload.project
        : null;
      if (!readback.ok || readbackProject?.id !== projectId) {
        throw new Error("影视工坊项目已返回但读回校验失败，已停止交接跳转。请刷新项目库核对后再操作。");
      }

      router.push(`/tools/film-studio/projects/${encodeURIComponent(projectId)}?step=script`);
    } catch (error) {
      setAgentHandoff({
        kind: "error",
        handoff,
        plan,
        error: error instanceof Error ? error.message : "影视工坊项目创建失败；未调用媒体模型、未扣费。",
      });
    }
  }

  return (
    <div className={styles.root}>
      <main className={styles.content}>
        {agentHandoff.kind !== "hidden" && (
          <section
            className={styles.agentHandoffPanel}
            data-state={agentHandoff.kind}
            data-testid="agent-film-studio-handoff-preview"
            aria-live="polite"
          >
            <span className={styles.agentHandoffIcon}><Film size={22} aria-hidden="true" /></span>
            <div className={styles.agentHandoffCopy}>
              <strong>{agentHandoff.kind === "error" ? "Agent 交接尚未完成" : "创作 Agent → 影视工坊"}</strong>
              <p>
                {agentHandoff.kind === "error"
                  ? agentHandoff.error
                  : `${agentHandoff.plan.segments.length} 个分镜生产段 · ${agentHandoff.plan.settings.aspectRatio} · ${agentHandoff.plan.settings.animationStyle}。确认后只创建项目，不会生成图片或视频。`}
              </p>
            </div>
            <div className={styles.agentHandoffActions}>
              {agentHandoff.kind === "ready" && (
                <button
                  type="button"
                  data-testid="agent-film-studio-handoff-confirm"
                  onClick={() => void confirmAgentFilmHandoff()}
                >
                  确认创建项目
                </button>
              )}
              {agentHandoff.kind === "creating" && <button type="button" disabled>正在创建并读回校验…</button>}
              {agentHandoff.kind === "error" && agentHandoff.handoff && agentHandoff.plan && (
                <button
                  type="button"
                  onClick={() => setAgentHandoff({ kind: "ready", handoff: agentHandoff.handoff!, plan: agentHandoff.plan! })}
                >
                  重新检查并创建
                </button>
              )}
              {agentHandoff.kind === "error" && !agentHandoff.handoff && (
                <Link href="/tools/text/text-chat">返回创作 Agent</Link>
              )}
              <button className={styles.agentHandoffDismiss} type="button" onClick={() => setAgentHandoff({ kind: "hidden" })}>
                关闭
              </button>
            </div>
          </section>
        )}

        <section
          className={styles.promoBanner}
          data-slide={promoSlide}
          data-testid="film-studio-banner"
          aria-label="从脚本到成片的创作流程"
        >
          <span className={styles.promoOrb} aria-hidden="true" />
          <div className={styles.promoLead}>
            <span className={styles.promoMonth}>创作</span>
            <div>
              <h2><strong>从脚本到成片</strong> 连续创作</h2>
              <p>管理角色、场景与分镜，按镜头制作视频</p>
            </div>
          </div>
          <div className={styles.promoOffers}>
            <span><small>第一步</small><b>写脚本</b></span>
            <span><small>第二步</small><b>做分镜</b></span>
            <span><small>第三步</small><b>生成片</b></span>
          </div>
          <div className={styles.promoMinimum}>
            <small>费用随所选模型显示</small>
            <strong>提交前确认</strong>
          </div>
          <div className={styles.carouselControls} aria-label="宣传横幅切换">
            {[0, 1].map((slide) => (
              <button
                type="button"
                key={slide}
                className={promoSlide === slide ? styles.carouselActive : undefined}
                aria-label={`切换到第 ${slide + 1} 张`}
                aria-current={promoSlide === slide ? "true" : undefined}
                onClick={() => setPromoSlide(slide)}
              />
            ))}
          </div>
        </section>

        <section
          className={styles.workshopCard}
          data-testid="film-studio-overview"
          aria-labelledby="film-studio-title"
        >
          <div className={styles.workshopHeading}>
            <span className={styles.workshopIcon}><Film size={20} aria-hidden="true" /></span>
            <div>
              <h1 id="film-studio-title">影视创作工坊</h1>
              <p>从剧本到成片，全流程一站式创作</p>
            </div>
          </div>
          <div className={styles.workflowChips} aria-label="影视制作六步流程">
            {FILM_STUDIO_WORKFLOW.map((step, index) => (
              <span key={step}>
                <b>{step}</b>
                {index < FILM_STUDIO_WORKFLOW.length - 1 && <i aria-hidden="true">→</i>}
              </span>
            ))}
          </div>
        </section>

        <section className={styles.creationSection} aria-labelledby="start-title">
          <h2 id="start-title">开始创作</h2>
          <div className={styles.entryGrid}>
            {FILM_STUDIO_ENTRY_CARDS.map((entry) => {
              const content = (
                <>
                  <span className={styles.entryIcon} aria-hidden="true">{ENTRY_GLYPHS[entry.icon]}</span>
                  <span className={styles.entryCopy}>
                    <span className={styles.entryTitle}>
                      {entry.title}
                      {entry.status === "available" && <sup>+</sup>}
                    </span>
                    <span className={styles.entryDescription}>{entry.description}</span>
                  </span>
                </>
              );

              return entry.status === "available" && entry.href ? (
                <Link
                  className={styles.entryCard}
                  data-accent={entry.accent}
                  data-testid={ENTRY_TEST_IDS[entry.key]}
                  href={entry.href}
                  key={entry.key}
                >
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  className={styles.entryCard}
                  data-accent={entry.accent}
                  data-testid={ENTRY_TEST_IDS[entry.key]}
                  disabled
                  key={entry.key}
                >
                  {content}
                </button>
              );
            })}
          </div>
        </section>

        <section
          className={styles.projectsSection}
          data-testid="film-studio-projects"
          data-project-state={projectState.kind}
          id="projects"
          aria-labelledby="projects-title"
        >
          <div className={styles.projectsHeader}>
            <div className={styles.projectsTitle}>
              <h2 id="projects-title">我的项目</h2>
              {projectCount !== null && <span>{visibleProjects.length}/{projectCount}</span>}
            </div>
            <div className={styles.projectToolbar}>
              <label className={styles.searchField}>
                <Search size={17} aria-hidden="true" />
                <span className={styles.srOnly}>搜索项目</span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索项目名称"
                />
              </label>
              <select
                className={styles.selectField}
                aria-label="按剧种筛选"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as ProjectKindFilter)}
              >
                <option value="all">全部剧种</option>
                <option value="爽剧">爽剧</option>
                <option value="通用短剧">短剧</option>
                <option value="正剧">正剧</option>
                <option value="导入项目">导入项目</option>
              </select>
              <select
                className={styles.selectField}
                aria-label="项目排序"
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value as ProjectSort)}
              >
                <option value="created-desc">最新提交</option>
                <option value="created-asc">最早提交</option>
                <option value="updated-desc">最近更新</option>
                <option value="title">名称排序</option>
              </select>
              <button
                className={styles.refreshButton}
                type="button"
                disabled={projectState.kind === "loading"}
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <RefreshCw
                  className={projectState.kind === "loading" ? styles.spinning : undefined}
                  size={16}
                  aria-hidden="true"
                />
                刷新
              </button>
            </div>
          </div>
          <ProjectLibraryState
            state={visibleProjectState}
            filtered={filtersApplied && allProjects.length > 0}
            onRetry={() => setReloadKey((value) => value + 1)}
            onDelete={(project) => void deleteProject(project)}
            deletingProjectId={deletingProjectId}
          />
        </section>
      </main>

      <footer className={styles.footer}>
        <span>© 2026 漫剧工作台</span>
        <i>·</i><span>关于我们</span>
        <i>·</i><span>商务合作</span>
      </footer>
    </div>
  );
}
