"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  GripVertical,
  PackageSearch,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Video,
  X,
} from "lucide-react";
import PlatformConfigurationReleasePanel from "./PlatformConfigurationReleasePanel";
import { ModelBadge } from "@/components/model-badge";
import { isVideoCatalogDisplaySurface } from "@/lib/video-workspace-catalog";
import { publicVideoModelCompatibilityMessage } from "@/lib/video-model-public-status";
import type { WorkspaceModelKind, WorkspaceModelSurface } from "@/lib/workspace-model-policy";
import {
  WORKSPACE_PROJECT_NAVIGATION,
  type WorkspaceEmbeddedTab,
  type WorkspaceProjectId,
  type WorkspaceSpecializedTarget,
} from "@/lib/workspace-project-navigation";

type ModelKind = WorkspaceModelKind;
type SurfaceId = WorkspaceModelSurface;

type ModelIssue = { code: string; message: string };
type WorkspaceModel = {
  id: string;
  name: string;
  modelName: string;
  icon_url?: string | null;
  kind: ModelKind;
  assigned: boolean;
  compatible: boolean;
  publishable: boolean;
  catalogDisplayable: boolean;
  visibleNow: boolean;
  active: boolean;
  hidden: boolean;
  priceReady: boolean;
  activationReady: boolean;
  availabilityMessage: string;
  compatibilityCode?: string;
  capabilitiesVerified?: boolean;
  capabilityLabels: string[];
  issues: ModelIssue[];
  warnings: ModelIssue[];
  order: number | null;
  fallbackOrder: number;
  provider: string;
  providerUrl: string;
  providerHost: string;
  channelLabel: string;
  priceLabels: string[];
  costLabels: string[];
};

type WorkspaceSurface = {
  id: SurfaceId;
  kind: ModelKind;
  label: string;
  description: string;
  models: WorkspaceModel[];
};

type Catalog = { surfaces: WorkspaceSurface[] };
type OrderSaveState = "idle" | "dirty" | "saving" | "saved" | "failed";

const SPECIALIZED_COPY: Record<WorkspaceSpecializedTarget, { title: string; body: string }> = {
  "digital-human": { title: "数字人能力配置", body: "照片说话、视频换口型、音频和源视频要求在这里按能力校验，普通视频模型不会混入。" },
  "voice-studio": { title: "智音工坊配置", body: "集中管理音色、TTS 引擎、试听协议和计费规则。" },
  commerce: { title: "带货 Agent 配置", body: "每项操作独立绑定主模型、候补模型和能力要求，避免全局模型覆盖业务策略。" },
  "manju-workbench": { title: "漫剧工作台配置", body: "集中查看漫剧生产能力、依赖模型与语音配置。" },
  plugins: { title: "内容工具箱配置", body: "视频提取、格式处理和第三方能力按插件协议及输入合同管理。" },
};

const SURFACE_TAB_LABELS: Partial<Record<SurfaceId, string>> = {
  "storyboard-image": "生图",
  "storyboard-video": "生视频",
  "film-studio-image": "生图",
  "film-studio-video": "生视频",
  "publish-center-image": "生图",
  "publish-center-video": "生视频",
  "commerce-generation-video": "普通视频生成",
  "commerce-video": "爆款视频复刻",
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作失败";
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function clampIndex(value: number, length: number) {
  return Math.max(0, Math.min(length - 1, value));
}

function toReadOnlyCatalog(catalog: Catalog): Catalog {
  return {
    surfaces: catalog.surfaces.map((surface) => ({
      ...surface,
      models: surface.models.map((model) => ({
        ...model,
        modelName: "",
        provider: "",
        providerUrl: "",
        providerHost: "",
        channelLabel: "",
        costLabels: [],
        issues: [],
        warnings: [],
        availabilityMessage: model.publishable ? model.availabilityMessage
          : publicVideoModelCompatibilityMessage(model.compatibilityCode) || "当前模型暂不可提交",
      })),
    })),
  };
}

export function WorkspaceModelsAdminTab({
  token,
  selectedProject = "storyboard",
  visibleProjectIds,
  canManage = false,
  onProjectChange,
  onOpenAdmin,
  renderAdminTarget,
  renderEmbeddedTab,
  renderCommerceAdmin,
}: {
  token: string;
  selectedProject?: WorkspaceProjectId;
  visibleProjectIds?: readonly WorkspaceProjectId[];
  canManage?: boolean;
  onProjectChange?: (project: WorkspaceProjectId) => void;
  onOpenAdmin: (target: WorkspaceSpecializedTarget) => void;
  renderAdminTarget?: (target: WorkspaceSpecializedTarget) => ReactNode;
  renderEmbeddedTab?: (tab: WorkspaceEmbeddedTab) => ReactNode;
  renderCommerceAdmin?: () => ReactNode;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [navItem, setNavItem] = useState<WorkspaceProjectId>(selectedProject);
  const [activeView, setActiveView] = useState<string>("");
  const [surfaceId, setSurfaceId] = useState<SurfaceId>("storyboard-image");
  const [draggedModelId, setDraggedModelId] = useState("");
  const [dragOver, setDragOver] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [draftOrders, setDraftOrders] = useState<Partial<Record<SurfaceId, string[]>>>({});
  const [orderSaveStates, setOrderSaveStates] = useState<Partial<Record<SurfaceId, OrderSaveState>>>({});
  const [workspaceReleaseRefreshKey, setWorkspaceReleaseRefreshKey] = useState(0);
  const [releasePanelExpandSignal, setReleasePanelExpandSignal] = useState(0);

  const visibleNavItems = useMemo(() => {
    if (!visibleProjectIds) return WORKSPACE_PROJECT_NAVIGATION;
    const allowedProjects = new Set<WorkspaceProjectId>(visibleProjectIds);
    return WORKSPACE_PROJECT_NAVIGATION.filter((item) => allowedProjects.has(item.id));
  }, [visibleProjectIds]);
  const activeNav = visibleNavItems.find((item) => item.id === navItem) || visibleNavItems[0] || null;
  const surfaceTabs = (activeNav?.surfaceIds || []).map((id) => ({
    id,
    label: SURFACE_TAB_LABELS[id] || catalog?.surfaces.find((surface) => surface.id === id)?.label.split(" · ").pop() || id,
  }));
  const effectiveView = activeNav?.id === "commerce" && (!activeView || activeView === "commerce-admin") ? "commerce-admin" : activeView;
  const commerceAdminView = effectiveView === "commerce-admin";

  useEffect(() => {
    const nextProject = visibleNavItems.some((item) => item.id === selectedProject)
      ? selectedProject
      : visibleNavItems[0]?.id;
    if (!nextProject) return;
    setNavItem((current) => current === nextProject ? current : nextProject);
    if (nextProject !== selectedProject) onProjectChange?.(nextProject);
  }, [onProjectChange, selectedProject, visibleNavItems]);

  useEffect(() => {
    if (!activeNav) return;
    const surfaces = activeNav.surfaceIds || [];
    setActiveView((current) => {
      if (activeNav.id === "commerce") {
        return current === "commerce-admin" || surfaces.includes(current as SurfaceId) ? current : "commerce-admin";
      }
      return surfaces.includes(current as SurfaceId) ? current : (surfaces[0] || "");
    });
  }, [activeNav]);

  useEffect(() => {
    if (activeView && activeView !== "commerce-admin") setSurfaceId(activeView as SurfaceId);
  }, [activeView]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/workspace-models", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const nextCatalog = await responseJson<Catalog>(response);
      setCatalog(canManage ? nextCatalog : toReadOnlyCatalog(nextCatalog));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [canManage, token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const surfaces = activeNav?.surfaceIds || [];
    if (surfaces.length > 0 && !surfaces.includes(surfaceId)) setSurfaceId(surfaces[0]);
    setPickerOpen(false);
    setPickerQuery("");
  }, [activeNav, surfaceId]);

  const currentSurface = catalog?.surfaces.find((surface) => surface.id === surfaceId) || null;
  const assignedModels = useMemo(() => {
    const assigned = currentSurface?.models.filter((model) => model.assigned) || [];
    const draft = draftOrders[surfaceId];
    if (!draft?.length) return assigned;
    const byId = new Map(assigned.map((model) => [model.id, model]));
    return [
      ...draft.map((id) => byId.get(id)).filter((model): model is WorkspaceModel => Boolean(model)),
      ...assigned.filter((model) => !draft.includes(model.id)),
    ];
  }, [currentSurface, draftOrders, surfaceId]);
  const currentOrderSaveState = orderSaveStates[surfaceId] || "idle";
  const mutating = busyKey.length > 0;
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return assignedModels;
    return assignedModels.filter((model) => [
      model.name,
      model.modelName,
      model.provider,
      model.providerHost,
      model.channelLabel,
      ...model.priceLabels,
      ...model.costLabels,
    ].join(" ").toLowerCase().includes(normalized));
  }, [assignedModels, query]);
  const candidateModels = useMemo(() => {
    const normalized = pickerQuery.trim().toLowerCase();
    const candidates = currentSurface?.models.filter((model) => !model.assigned) || [];
    if (!normalized) return candidates;
    return candidates.filter((model) => [
      model.name,
      model.modelName,
      model.provider,
      model.providerHost,
      model.channelLabel,
      ...model.capabilityLabels,
    ].join(" ").toLowerCase().includes(normalized));
  }, [currentSurface, pickerQuery]);

  const mutate = useCallback(async (body: Record<string, unknown>, key: string, success: string) => {
    if (!canManage) return;
    setBusyKey(key);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/admin/workspace-models", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await responseJson(response);
      setWorkspaceReleaseRefreshKey((value) => value + 1);
      await load();
      if (key.startsWith("assign:")) setReleasePanelExpandSignal((value) => value + 1);
      setNotice(success);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusyKey("");
    }
  }, [canManage, load, token]);

  const toggleAssignment = (model: WorkspaceModel, enabled: boolean) => {
    if (!canManage) return Promise.resolve();
    return mutate({
    action: "assign",
    kind: model.kind,
    surface: surfaceId,
    modelId: model.id,
    enabled,
    }, `assign:${model.id}`, enabled ? `${model.name} 已加入候选；请在发布闭环完成校验、预览和发布后生效` : `${model.name} 已加入移除候选；请在发布闭环完成校验、预览和发布后生效`);
  };

  const stageOrder = (models: WorkspaceModel[], success: string) => {
    if (!canManage || !currentSurface || models.length === 0) return;
    const targetSurface = currentSurface.id;
    setDraftOrders((current) => ({ ...current, [targetSurface]: models.map((model) => model.id) }));
    setOrderSaveStates((current) => ({ ...current, [targetSurface]: "dirty" }));
    setError("");
    setNotice(`${success}；这是“${currentSurface.label}”的独立草稿，请点击保存排序`);
  };

  const moveToIndex = (modelId: string, targetIndex: number, success = "当前项目模型顺序已保存") => {
    if (!canManage) return;
    const sourceIndex = assignedModels.findIndex((model) => model.id === modelId);
    if (sourceIndex < 0 || assignedModels.length < 2) return;
    const nextIndex = clampIndex(targetIndex, assignedModels.length);
    if (sourceIndex === nextIndex) return;
    const reordered = [...assignedModels];
    const [model] = reordered.splice(sourceIndex, 1);
    reordered.splice(nextIndex, 0, model);
    stageOrder(reordered, success);
  };

  const reorderRelative = (draggedId: string, targetId: string, position: "before" | "after") => {
    if (!canManage || !currentSurface || draggedId === targetId || query.trim()) return;
    const dragged = assignedModels.find((model) => model.id === draggedId);
    if (!dragged) return;
    const reordered = assignedModels.filter((model) => model.id !== draggedId);
    const targetIndex = reordered.findIndex((model) => model.id === targetId);
    if (targetIndex < 0) return;
    reordered.splice(position === "before" ? targetIndex : targetIndex + 1, 0, dragged);
    stageOrder(reordered, "拖拽顺序已修改");
  };

  const discardCurrentOrder = useCallback(() => {
    if (!currentSurface || currentOrderSaveState === "saving") return;
    const targetSurface = currentSurface.id;
    setDraftOrders((current) => {
      const next = { ...current };
      delete next[targetSurface];
      return next;
    });
    setOrderSaveStates((current) => ({ ...current, [targetSurface]: "idle" }));
    setError("");
    setNotice(`已放弃“${currentSurface.label}”的未保存排序，恢复已发布顺序`);
  }, [currentOrderSaveState, currentSurface]);

  const saveCurrentOrder = useCallback(async () => {
    if (!canManage || !currentSurface || currentOrderSaveState !== "dirty") return;
    const targetSurface = currentSurface.id;
    const modelIds = draftOrders[targetSurface] || [];
    if (modelIds.length === 0) return;
    setBusyKey(`order-save:${targetSurface}`);
    setOrderSaveStates((current) => ({ ...current, [targetSurface]: "saving" }));
    setNotice("");
    setError("");
    try {
      const requestJson = async <T,>(pathname: string, init: RequestInit = {}) => {
        const response = await fetch(pathname, {
          ...init,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
          cache: "no-store",
        });
        return responseJson<T>(response);
      };
      const staged = await requestJson<{ result?: { release?: { id?: string } } }>("/api/admin/workspace-models", {
        method: "POST",
        body: JSON.stringify({ action: "reorder", kind: currentSurface.kind, surface: targetSurface, modelIds }),
      });
      const releaseId = String(staged.result?.release?.id || "");
      if (!releaseId) throw new Error("排序候选缺少版本编号");
      await requestJson("/api/admin/workspace-model-releases", {
        method: "POST",
        body: JSON.stringify({ action: "validate", releaseId }),
      });
      const preview = await requestJson<{ preview?: { previewSha256?: string } }>(`/api/admin/workspace-model-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
      const previewSha256 = String(preview.preview?.previewSha256 || "");
      if (!/^[a-f0-9]{64}$/u.test(previewSha256)) throw new Error("排序差异预览指纹无效");
      await requestJson("/api/admin/workspace-model-releases", {
        method: "POST",
        body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
      });
      const readback = await requestJson<Catalog>("/api/admin/workspace-models");
      const readbackSurface = readback.surfaces.find((surface) => surface.id === targetSurface);
      const readbackOrder = readbackSurface?.models.filter((model) => model.assigned).map((model) => model.id) || [];
      if (readbackOrder.length !== modelIds.length || modelIds.some((id, index) => readbackOrder[index] !== id)) {
        throw new Error("排序发布后的数据库回读不一致");
      }
      setCatalog(readback);
      setDraftOrders((current) => {
        const next = { ...current };
        delete next[targetSurface];
        return next;
      });
      setOrderSaveStates((current) => ({ ...current, [targetSurface]: "saved" }));
      setWorkspaceReleaseRefreshKey((value) => value + 1);
      setNotice(`“${currentSurface.label}”排序已保存并发布，刷新页面仍会保持`);
      window.setTimeout(() => {
        setOrderSaveStates((current) => current[targetSurface] === "saved"
          ? { ...current, [targetSurface]: "idle" }
          : current);
      }, 3000);
    } catch (cause) {
      setDraftOrders((current) => {
        const next = { ...current };
        delete next[targetSurface];
        return next;
      });
      setOrderSaveStates((current) => ({ ...current, [targetSurface]: "failed" }));
      await load();
      setError(`排序保存失败：${messageOf(cause)}；已恢复服务器顺序`);
    } finally {
      setBusyKey("");
    }
  }, [canManage, currentOrderSaveState, currentSurface, draftOrders, load, token]);

  const specializedPanel = activeNav?.specializedTarget ? renderAdminTarget?.(activeNav.specializedTarget) : null;

  if (!activeNav) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-white px-6 py-12 text-center text-sm text-[#667085]">
        当前账号暂无可用工作台配置。
      </div>
    );
  }

  return (
    <div className="min-w-0" data-workspace-config-root data-workspace-project={activeNav.id}>
      <nav aria-label="工作台面包屑" className="flex flex-wrap items-center gap-1.5 text-xs text-[#667085]">
        <span>工作台配置</span>
        <span aria-hidden="true">/</span>
        <span className="font-semibold text-[#344054]">{activeNav.label}</span>
      </nav>

      {activeNav.embeddedTab ? (
        <section className="mt-4 min-w-0" data-workspace-embedded-tab={activeNav.embeddedTab}>
          {renderEmbeddedTab?.(activeNav.embeddedTab) ?? (
            <div className="rounded-lg border border-dashed border-[#d0d5dd] bg-[#f9fafb] px-6 py-12 text-center text-sm text-[#667085]">
              当前账号暂无该项配置的读取权限。
            </div>
          )}
        </section>
      ) : (
        <>
          <header className="mt-3 flex flex-wrap items-start justify-between gap-4 border-b border-[#e4e7ec] pb-4">
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-[#172033]">{activeNav.label}</h2>
              <p className="mt-1 max-w-4xl text-sm leading-6 text-[#667085]">
                {canManage
                  ? `${activeNav.description}。资源池负责接口、密钥、价格和验收；本页只决定该功能可选哪些模型、默认顺序，不保存提示词——提示词与业务在「卡片中心 / 提示词与知识」。`
                  : `${activeNav.description}。当前为只读视图，仅展示已开放模型的公开能力、状态和用户价格。`}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {!activeNav.specializedTarget && (
                <button type="button" onClick={() => void load()} disabled={loading} title="重新读取当前配置" className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[#d0d5dd] bg-white text-[#475467] hover:bg-[#f9fafb] disabled:opacity-50">
                  <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                </button>
              )}
            </div>
          </header>

          {!activeNav.specializedTarget && (surfaceTabs.length > 1 || activeNav.id === "commerce") && (
            <div role="tablist" aria-label="工作台视图" className="mt-4 inline-flex flex-wrap gap-1 rounded-lg bg-[#f2f4f7] p-1">
              {activeNav.id === "commerce" && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={commerceAdminView}
                  data-testid="workspace-tab-commerce-admin"
                  onClick={() => setActiveView("commerce-admin")}
                  className={`inline-flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${commerceAdminView ? "bg-white text-[#175cd3] shadow-sm" : "text-[#667085] hover:text-[#344054]"}`}
                >
                  带货创作后台
                </button>
              )}
              {surfaceTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={!commerceAdminView && effectiveView === tab.id}
                  data-testid={`workspace-tab-surface-${tab.id}`}
                  onClick={() => setActiveView(tab.id)}
                  className={`inline-flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${!commerceAdminView && effectiveView === tab.id ? "bg-white text-[#175cd3] shadow-sm" : "text-[#667085] hover:text-[#344054]"}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {!activeNav.specializedTarget && canManage && !commerceAdminView && (
            <div className="mt-4">
              <PlatformConfigurationReleasePanel
                token={token}
                kind="workspace-models"
                refreshKey={workspaceReleaseRefreshKey}
                expandSignal={releasePanelExpandSignal}
                onPublished={() => void load()}
              />
            </div>
          )}

          {activeNav.specializedTarget ? (
            <section className="mt-4 min-w-0">
              <div className="mb-5 border-b border-[#eaecf0] pb-4">
                <h3 className="text-base font-bold text-[#172033]">{SPECIALIZED_COPY[activeNav.specializedTarget].title}</h3>
                <p className="mt-1 text-sm leading-6 text-[#667085]">{SPECIALIZED_COPY[activeNav.specializedTarget].body}</p>
              </div>
              {specializedPanel || (
                <div className="flex min-h-56 flex-col items-center justify-center rounded-md border border-dashed border-[#d0d5dd] bg-[#f9fafb] px-6 text-center">
                  <PackageSearch className="h-7 w-7 text-[#667085]" />
                  <p className="mt-3 text-sm text-[#667085]">当前专项配置仍使用原有业务页面。</p>
                  <button type="button" onClick={() => onOpenAdmin(activeNav.specializedTarget!)} className="mt-4 rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1d4ed8]">打开配置</button>
                </div>
              )}
            </section>
          ) : commerceAdminView ? (
            <section className="mt-4 min-w-0" data-workspace-commerce-admin>
              {renderCommerceAdmin?.() ?? (
                <div className="rounded-lg border border-dashed border-[#d0d5dd] bg-[#f9fafb] px-6 py-12 text-center text-sm text-[#667085]">
                  当前账号没有带货创作后台的管理权限。
                </div>
              )}
            </section>
          ) : (
            <section className="mt-4 min-w-0">
              <div className="overflow-hidden rounded-md border border-[#d0d5dd] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eaecf0] px-4 py-3.5">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-[#172033]">{currentSurface?.label || "模型配置"}</h3>
                      {currentSurface && <span className="rounded bg-[#eff4ff] px-2 py-0.5 text-xs font-semibold text-[#175cd3]">{assignedModels.length} 已添加 · {currentSurface.models.length - assignedModels.length} 待添加</span>}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-[#667085]">{currentSurface?.description}</p>
                  </div>
                  <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                    <div className="relative w-full sm:w-64">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a2b3]" />
                      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已添加模型" className="h-10 w-full rounded-md border border-[#d0d5dd] bg-white py-2 pl-9 pr-3 text-sm text-[#344054] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/10" />
                    </div>
                    <button
                      type="button"
                      onClick={() => { setPickerQuery(""); setPickerOpen(true); }}
                      disabled={!canManage || !currentSurface || loading}
                      title={canManage ? "从模型池选择并添加到当前项目" : "解锁敏感操作后可添加模型"}
                      className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Plus className="h-4 w-4" />从模型池添加
                    </button>
                  </div>
                </div>

                {canManage && query.trim() && assignedModels.length > 1 && <div className="border-b border-[#fedf89] bg-[#fffaeb] px-4 py-2 text-xs text-[#93370d]">清空搜索词后可拖拽完整模型列表；置顶、序号和上下移动仍可使用。</div>}
                {notice && <div className="border-b border-[#abefc6] bg-[#ecfdf3] px-4 py-2 text-sm text-[#067647]">{notice}</div>}
                {error && <div className="border-b border-[#fecdca] bg-[#fef3f2] px-4 py-2 text-sm text-[#b42318]">{error}</div>}
                {canManage && currentSurface && (
                  <div
                    className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 ${currentOrderSaveState === "dirty" ? "border-[#fedf89] bg-[#fffaeb]" : currentOrderSaveState === "failed" ? "border-[#fecdca] bg-[#fef3f2]" : "border-[#eaecf0] bg-[#f9fafb]"}`}
                    data-testid="workspace-model-order-save-bar"
                    data-surface-id={currentSurface.id}
                    data-save-state={currentOrderSaveState}
                  >
                    <div>
                      <p className="text-sm font-semibold text-[#344054]">{currentSurface.label} · 独立排序</p>
                      <p className="mt-0.5 text-xs text-[#667085]">
                        {currentOrderSaveState === "dirty"
                          ? "顺序已在本页修改但尚未保存；不会影响其他导航项目。"
                          : currentOrderSaveState === "saving"
                            ? "正在校验、预览并发布当前项目排序…"
                            : currentOrderSaveState === "saved"
                              ? "排序已保存并通过刷新回读。"
                              : currentOrderSaveState === "failed"
                                ? "保存失败，已恢复服务器中的已发布顺序。"
                                : "当前顺序与已发布配置一致；修改后请点击保存排序。"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={discardCurrentOrder}
                        disabled={currentOrderSaveState !== "dirty" || mutating}
                        className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-semibold text-[#475467] hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        放弃修改
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveCurrentOrder()}
                        disabled={currentOrderSaveState !== "dirty" || mutating}
                        data-testid="workspace-model-order-save"
                        className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-md bg-[#2563eb] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {currentOrderSaveState === "saving" && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                        {currentOrderSaveState === "saving" ? "保存中…" : "保存排序"}
                      </button>
                    </div>
                  </div>
                )}

                {loading ? (
                  <div className="flex items-center justify-center gap-2 py-20 text-sm text-[#667085]"><RefreshCw className="h-4 w-4 animate-spin" />读取模型配置</div>
                ) : !currentSurface ? (
                  <div className="py-20 text-center text-sm text-[#b42318]">当前模型配置不存在，请重新加载</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[1240px] table-fixed text-left text-sm">
                      <thead className="bg-[#f9fafb] text-xs font-semibold text-[#475467]">
                        <tr>
                          <th className="w-[150px] px-4 py-3">当前页面</th>
                          <th className="w-[330px] px-4 py-3">{canManage ? "模型 / 渠道 / 价格" : "模型信息"}</th>
                          <th className="px-4 py-3" title="标签来自模型协议声明的能力与限制，不是提示词">能力与限制</th>
                          <th className="w-[235px] px-4 py-3">状态</th>
                          <th className="w-[230px] px-4 py-3">顺序</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredModels.map((model) => {
                          const assignedIndex = assignedModels.findIndex((entry) => entry.id === model.id);
                          const sorting = mutating;
                          const dropActive = dragOver?.id === model.id;
                          return (
                            <tr
                              key={model.id}
                              data-model-row={canManage ? model.id : undefined}
                              onDragOver={(event) => {
                                if (!canManage || !model.assigned || !draggedModelId || query.trim()) return;
                                event.preventDefault();
                                const bounds = event.currentTarget.getBoundingClientRect();
                                setDragOver({ id: model.id, position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" });
                              }}
                              onDrop={(event) => {
                                if (!canManage) return;
                                event.preventDefault();
                                if (draggedModelId && dragOver) reorderRelative(draggedModelId, model.id, dragOver.position);
                                setDraggedModelId("");
                                setDragOver(null);
                              }}
                              className={`min-h-[112px] border-t border-[#eaecf0] align-middle transition-colors ${dropActive ? (dragOver?.position === "before" ? "shadow-[inset_0_2px_0_#2563eb]" : "shadow-[inset_0_-2px_0_#2563eb]") : "hover:bg-[#fcfcfd]"}`}
                            >
                              <td className="px-4 py-3">
                                {canManage ? <button
                                  data-model-assignment={model.id}
                                  type="button"
                                  disabled={mutating}
                                  onClick={() => void toggleAssignment(model, false)}
                                  className="rounded-md border border-[#fda29b] bg-white px-3 py-2 text-xs font-semibold text-[#b42318] hover:bg-[#fef3f2] disabled:opacity-50"
                                  title="只从当前页面移除，不影响模型资源池或其他页面"
                                >
                                  从当前页面移除
                                </button> : <span className="rounded-md bg-[#f2f4f7] px-3 py-2 text-xs font-semibold text-[#667085]">仅查看</span>}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-start gap-3">
                                  <ModelBadge
                                    name={model.name}
                                    avatarUrl={model.icon_url}
                                    identity={[model.modelName, model.provider]}
                                    availability={model.publishable ? "ready" : "unavailable"}
                                  />
                                  <div className="min-w-0 flex-1">
                                <p className="line-clamp-2 font-semibold leading-5 text-[#172033]">{model.name}</p>
                                {canManage && <p className="mt-1 line-clamp-2 break-all text-xs leading-5 text-[#667085]">{model.modelName}</p>}
                                {canManage && <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-[#475467]">
                                  <span>{model.channelLabel || model.provider || "渠道待配置"}</span>
                                  {model.providerUrl && (
                                    <a href={model.providerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-[#175cd3] hover:underline">
                                      {model.providerHost || "服务商网站"}<ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                </div>}
                                <p className="mt-1 text-xs leading-5 text-[#067647]">{model.priceLabels.join(" · ") || "售价待配置"}</p>
                                {canManage && <p className="text-xs leading-5 text-[#667085]">{model.costLabels.join(" · ") || "成本待配置"}</p>}
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex max-w-xl flex-wrap gap-1.5">
                                  {model.capabilityLabels.map((label) => <span key={label} className="rounded border border-[#d0d5dd] bg-white px-2 py-1 text-xs text-[#475467]">{label}</span>)}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                {model.publishable ? (
                                  <p className="flex items-center gap-1.5 text-xs font-medium text-[#475467]"><ShieldCheck className="h-3.5 w-3.5 text-[#067647]" />已加入本页</p>
                                ) : (
                                  <div className="rounded-md border border-[#fedf89] bg-[#fffaeb] px-3 py-2 text-xs leading-5 text-[#93370d]">
                                    <p className="font-semibold">已添加，但当前不可提交</p>
                                    <p>{publicVideoModelCompatibilityMessage(model.compatibilityCode) || model.availabilityMessage || "当前配置不可用"}</p>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {canManage ? <div className="flex items-center gap-1.5">
                                    <span
                                      draggable={!sorting && !query.trim()}
                                      onDragStart={(event) => {
                                        setDraggedModelId(model.id);
                                        event.dataTransfer.effectAllowed = "move";
                                        event.dataTransfer.setData("text/plain", model.id);
                                      }}
                                      onDragEnd={() => { setDraggedModelId(""); setDragOver(null); }}
                                      title={query.trim() ? "清空搜索词后可拖拽" : "拖动排序"}
                                      className={`inline-flex h-8 w-8 items-center justify-center rounded border border-[#d0d5dd] bg-white text-[#667085] ${query.trim() ? "cursor-not-allowed opacity-40" : "cursor-grab active:cursor-grabbing"}`}
                                    >
                                      <GripVertical className="h-4 w-4" />
                                    </span>
                                    <input
                                      key={`${surfaceId}:${model.id}:${assignedIndex}`}
                                      type="number"
                                      min={1}
                                      max={assignedModels.length}
                                      defaultValue={assignedIndex + 1}
                                      aria-label={`${model.name} 排序序号`}
                                      disabled={sorting}
                                      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                                      onBlur={(event) => {
                                        const next = Number.parseInt(event.currentTarget.value, 10);
                                        if (Number.isFinite(next)) moveToIndex(model.id, next - 1, "序号顺序已修改");
                                        else event.currentTarget.value = String(assignedIndex + 1);
                                      }}
                                      className="h-8 w-12 rounded border border-[#d0d5dd] bg-white px-1 text-center text-xs font-semibold text-[#344054] outline-none focus:border-[#2563eb]"
                                    />
                                    <button type="button" title="置顶" disabled={assignedIndex <= 0 || sorting} onClick={() => moveToIndex(model.id, 0, "模型已置顶")} className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#d0d5dd] bg-white text-[#475467] hover:bg-[#f9fafb] disabled:opacity-30"><Pin className="h-3.5 w-3.5" /></button>
                                    <button type="button" title="上移" disabled={assignedIndex <= 0 || sorting} onClick={() => moveToIndex(model.id, assignedIndex - 1)} className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#d0d5dd] bg-white text-[#475467] hover:bg-[#f9fafb] disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                                    <button type="button" title="下移" disabled={assignedIndex < 0 || assignedIndex >= assignedModels.length - 1 || sorting} onClick={() => moveToIndex(model.id, assignedIndex + 1)} className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#d0d5dd] bg-white text-[#475467] hover:bg-[#f9fafb] disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                                </div> : <span className="text-xs font-semibold text-[#667085]">第 {assignedIndex + 1} 位</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {filteredModels.length === 0 && <div className="py-16 text-center text-sm text-[#667085]">当前页面尚未添加模型，请从模型池选择</div>}
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-[#667085]">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#079455]" />
                普通用户目录和生成接口会再次核对项目分配、能力合同与验收状态；绕过界面也不能提交不匹配模型。
              </div>
            </section>
          )}
        </>
      )}
      {canManage && pickerOpen && currentSurface && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[#101828]/45 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
          <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#d0d5dd] bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label={`从模型池添加到${currentSurface.label}`}>
            <div className="flex items-start justify-between gap-4 border-b border-[#eaecf0] px-5 py-4">
              <div>
                <h3 className="text-lg font-bold text-[#172033]">从模型池添加</h3>
                <p className="mt-1 text-sm leading-6 text-[#667085]">{isVideoCatalogDisplaySurface(currentSurface.id)
                  ? `可将尚未添加的视频模型加入“${currentSurface.label}”目录；输入不兼容或能力待核验的模型会显示原因并禁用生成。`
                  : `这里只显示适合“${currentSurface.label}”且尚未添加的模型；其他模型仍保留在资源池和适合它们的页面。`}</p>
              </div>
              <button type="button" onClick={() => setPickerOpen(false)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#667085] hover:bg-[#f2f4f7]" aria-label="关闭模型选择器"><X className="h-5 w-5" /></button>
            </div>
            <div className="border-b border-[#eaecf0] px-5 py-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a2b3]" />
                <input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="搜索模型、渠道或能力" className="h-11 w-full rounded-md border border-[#d0d5dd] bg-white py-2 pl-9 pr-3 text-sm text-[#344054] outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/10" />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              {candidateModels.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {candidateModels.map((model) => (
                    <article key={model.id} data-model-candidate={model.id} className="flex min-h-40 flex-col rounded-lg border border-[#d0d5dd] bg-white p-4 hover:border-[#84adff] hover:shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <ModelBadge
                          name={model.name}
                          avatarUrl={model.icon_url}
                          identity={[model.modelName, model.provider]}
                          availability={model.publishable ? "ready" : "unavailable"}
                        />
                        <div className="min-w-0 flex-1">
                          <h4 className="line-clamp-2 text-sm font-bold leading-5 text-[#172033]">{model.name}</h4>
                          <p className="mt-1 truncate text-xs text-[#667085]">{model.channelLabel || model.provider || model.modelName}</p>
                        </div>
                        <button type="button" disabled={mutating} onClick={() => void toggleAssignment(model, true)} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md bg-[#2563eb] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-50"><Plus className="h-3.5 w-3.5" />添加</button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {model.capabilityLabels.map((label) => <span key={label} className="rounded border border-[#d0d5dd] bg-[#f9fafb] px-2 py-1 text-xs text-[#475467]">{label}</span>)}
                      </div>
                      {!model.publishable && <p className="mt-2 text-xs leading-5 text-[#93370d]">加入后展示，当前不可提交：{publicVideoModelCompatibilityMessage(model.compatibilityCode) || model.availabilityMessage || "当前配置不可用"}</p>}
                      <p className="mt-auto pt-3 text-xs leading-5 text-[#067647]">{model.priceLabels.join(" · ") || "价格已在资源池配置"}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-52 flex-col items-center justify-center text-center">
                  <PackageSearch className="h-8 w-8 text-[#98a2b3]" />
                  <p className="mt-3 text-sm font-semibold text-[#344054]">{pickerQuery.trim() ? "没有匹配的未添加模型" : "没有其他可添加模型"}</p>
                  <p className="mt-1 text-xs leading-5 text-[#667085]">{pickerQuery.trim() ? "请调整搜索词或清空搜索。"
                    : isVideoCatalogDisplaySurface(currentSurface.id) ? "当前符合目录展示条件的模型均已添加；隐藏、退役或被限制的模型仍受资源池规则保护。"
                    : "不兼容当前页面的模型不会出现在这里，也不会被停用。"}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
