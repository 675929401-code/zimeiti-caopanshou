"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Star,
  Trash2,
  Video,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./film-studio-production-panel.module.css";
import { buildFilmVideoSubmission, canSubmitFilmVideo, filmJobModelLabel, filmVideoUnavailableReason } from "@/lib/short-drama/film-video-capabilities";

type ProductionStage = "storyboard" | "final";

interface ProductionShot {
  id: string;
  sequence: number;
  sceneKey: string | null;
  title: string;
  narration: string;
  visualDescription: string;
  imagePrompt: string;
  videoPrompt: string;
  negativePrompt: string;
  durationSeconds: number;
  aspectRatio: string;
  status: string;
  metadata: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface ProductionJob {
  id: string;
  publicJobId: string;
  shotId: string | null;
  stage: string;
  state: string;
  provider: string | null;
  upstreamTaskId: string | null;
  modelPublicId: string | null;
  requestPayload: Record<string, unknown>;
  resultPayload: Record<string, unknown>;
  billingSnapshot: Record<string, unknown>;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ProductionAsset {
  id: string;
  shotId: string | null;
  jobId: string | null;
  assetRole: string;
  provider: string;
  stableUri: string;
  previewUrl: string;
  mimeType: string | null;
  byteSize: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ProductionSnapshot {
  shots: ProductionShot[];
  jobs: ProductionJob[];
  assets: ProductionAsset[];
  timeline: ProductionTimelineClip[];
  projectRevision: number;
}

interface ProductionTimelineClip {
  id: string;
  shotId: string;
  assetId: string;
  enabled: boolean;
  startSeconds: number;
  endSeconds: number;
}

interface BatchGenerationPlan {
  kind: "image" | "video";
  modelId: string;
  resolution: string;
  duration: number;
  entries: Array<{
    shotId: string;
    shotSequence: number;
    clientRequestId: string;
  }>;
  nextIndex: number;
}

interface PublicModel {
  id: string;
  displayName: string;
  variantLabel: string;
  publicPrice: number;
  capabilities: Record<string, unknown>;
}

interface PanelCounts {
  shots: number;
  completedVideos: number;
}

interface ApiErrorPayload {
  error?: string;
  message?: string;
  code?: string;
}

class ProductionApiError extends Error {
  readonly code: string;

  constructor(message: string, code = "PRODUCTION_REQUEST_FAILED") {
    super(message);
    this.name = "ProductionApiError";
    this.code = code;
  }
}

const EMPTY_SNAPSHOT: ProductionSnapshot = {
  shots: [],
  jobs: [],
  assets: [],
  timeline: [],
  projectRevision: 1,
};
const ACTIVE_STATES = new Set([
  "accepted",
  "queued",
  "running",
  "result_staging",
  "persisting",
  "finalizing",
  "retry_wait",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);
}

function createClientRequestId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`.slice(0, 120);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function apiFailure(payload: unknown, fallback: string): ProductionApiError {
  const body = isRecord(payload) ? payload as ApiErrorPayload : {};
  return new ProductionApiError(
    textValue(body.error) || textValue(body.message) || fallback,
    textValue(body.code, "PRODUCTION_REQUEST_FAILED"),
  );
}

function validSnapshot(value: unknown): value is ProductionSnapshot {
  return isRecord(value)
    && Array.isArray(value.shots)
    && Array.isArray(value.jobs)
    && Array.isArray(value.assets)
    && Array.isArray(value.timeline)
    && Number.isInteger(value.projectRevision)
    && Number(value.projectRevision) >= 1;
}

function normalizeModels(value: unknown): PublicModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return [];
  return value.models.flatMap((model): PublicModel[] => {
    if (!isRecord(model) || typeof model.id !== "string") return [];
    const capabilities = isRecord(model.capabilities) ? model.capabilities : {};
    return [{
      id: model.id,
      displayName: textValue(model.displayName, "未命名模型"),
      variantLabel: textValue(model.variantLabel),
      publicPrice: Math.max(0, finiteNumber(model.publicPrice)),
      capabilities,
    }];
  });
}

function modelAvailable(model: PublicModel): boolean {
  return model.capabilities.available !== false;
}

function modelLabel(model: PublicModel): string {
  const variant = model.variantLabel ? ` · ${model.variantLabel}` : "";
  return `${model.displayName}${variant} · 报价 ${model.publicPrice.toFixed(2)}`;
}

function modelResolutionOptions(model: PublicModel | null): string[] {
  if (!model) return [];
  const options = stringArray(model.capabilities.resolutionOptions);
  const fallback = textValue(model.capabilities.defaultResolution);
  return options.length ? options : fallback ? [fallback] : [];
}

function modelDurationOptions(model: PublicModel | null): number[] {
  if (!model) return [];
  const native = numberArray(model.capabilities.nativeDurations);
  if (native.length) return [...new Set(native)].sort((a, b) => a - b);
  const fallback = finiteNumber(model.capabilities.defaultDuration, 0);
  return fallback > 0 ? [fallback] : [5, 10];
}

function newest<T extends { createdAt: string }>(items: T[]): T | null {
  return [...items].sort((left, right) => (
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  ))[0] || null;
}

function takeDuration(asset: ProductionAsset, shot: ProductionShot): number {
  return Math.max(0.1, finiteNumber(asset.metadata.durationSeconds, shot.durationSeconds || 5));
}

function selectedTake(
  shot: ProductionShot,
  assets: ProductionAsset[],
  role: "image" | "video",
): ProductionAsset | null {
  const candidates = assets.filter((asset) => asset.shotId === shot.id && (
    role === "video"
      ? asset.assetRole === "video"
      : asset.assetRole === "image" || asset.assetRole === "storyboard"
  ));
  const selectedId = role === "video"
    ? textValue(shot.metadata.selectedVideoAssetId)
    : textValue(shot.metadata.selectedImageAssetId);
  return candidates.find((asset) => asset.id === selectedId) || newest(candidates);
}

function createTimelineClip(shot: ProductionShot, asset: ProductionAsset): ProductionTimelineClip {
  return {
    id: createClientRequestId("timeline"),
    shotId: shot.id,
    assetId: asset.id,
    enabled: true,
    startSeconds: 0,
    endSeconds: takeDuration(asset, shot),
  };
}

function defaultTimeline(snapshot: ProductionSnapshot): ProductionTimelineClip[] {
  return [...snapshot.shots]
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((shot) => {
      const asset = selectedTake(shot, snapshot.assets, "video");
      return asset ? [createTimelineClip(shot, asset)] : [];
    });
}

function jobStateLabel(state: string): string {
  const labels: Record<string, string> = {
    accepted: "已建任务",
    queued: "队列中",
    running: "生成中",
    result_staging: "结果暂存中",
    persisting: "归档中",
    finalizing: "结算中",
    retry_wait: "等待重试",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[state] || state;
}

function jobStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    shot_planning: "镜头计划",
    entity_design: "实体图片",
    image_generation: "分镜图片",
    video_generation: "分镜视频",
    final_assembly: "统一成片",
  };
  return labels[stage] || stage;
}

function formatSubmittedAt(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return "提交时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function assetUrl(asset: ProductionAsset | null): string {
  return asset?.previewUrl || "";
}

function fileSizeLabel(value: number | null): string {
  if (!value || value <= 0) return "大小未知";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}

export function FilmStudioProductionPanel({
  stage,
  projectId,
  token,
  creationBlockedMessage,
  onCountsChange,
}: {
  stage: ProductionStage;
  projectId: string;
  token: string;
  creationBlockedMessage?: string;
  onCountsChange?: (counts: PanelCounts) => void;
}) {
  const [snapshot, setSnapshot] = useState<ProductionSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ProductionApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [pendingKey, setPendingKey] = useState("");
  const [imageModels, setImageModels] = useState<PublicModel[]>([]);
  const [videoModels, setVideoModels] = useState<PublicModel[]>([]);
  const [imageModelId, setImageModelId] = useState("");
  const [videoModelId, setVideoModelId] = useState("");
  const [imageResolution, setImageResolution] = useState("");
  const [videoResolution, setVideoResolution] = useState("");
  const [videoDuration, setVideoDuration] = useState(10);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [timelineClips, setTimelineClips] = useState<ProductionTimelineClip[]>([]);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [selectedShotIds, setSelectedShotIds] = useState<Set<string>>(() => new Set());
  const [batchRecovery, setBatchRecovery] = useState<BatchGenerationPlan | null>(null);
  const pollBusyRef = useRef(false);
  const timelineDirtyRef = useRef(false);
  const retryRequestIdsRef = useRef(new Map<string, string>());

  const endpoint = `/api/short-drama/projects/${encodeURIComponent(projectId)}/production`;

  const loadSnapshot = useCallback(async (options?: { silent?: boolean; signal?: AbortSignal }) => {
    if (!options?.silent) setLoading(true);
    else setRefreshing(true);
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: options?.signal,
      });
      const payload = await parseJsonResponse(response);
      if (!response.ok) throw apiFailure(payload, "生产数据读取失败");
      if (!validSnapshot(payload)) {
        throw new ProductionApiError("制作服务返回内容不完整，请刷新后重试。", "PRODUCTION_RESPONSE_INVALID");
      }
      setSnapshot(payload);
      if (!timelineDirtyRef.current) {
        setTimelineClips(payload.timeline.length ? payload.timeline : defaultTimeline(payload));
      }
      setError(null);
    } catch (requestError: unknown) {
      if (options?.signal?.aborted) return;
      setError(requestError instanceof ProductionApiError
        ? requestError
        : new ProductionApiError(requestError instanceof Error ? requestError.message : "生产数据读取失败"));
    } finally {
      if (!options?.signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [endpoint, token]);

  const postAction = useCallback(async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw apiFailure(payload, "生产操作失败");
    return payload;
  }, [endpoint, token]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSnapshot({ signal: controller.signal });
    return () => controller.abort();
  }, [loadSnapshot]);

  useEffect(() => {
    if (stage !== "storyboard") return;
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/cover-models?surface=film-studio", {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await parseJsonResponse(response);
        if (!response.ok) throw apiFailure(payload, "生图模型读取失败");
        return normalizeModels(payload);
      }),
      fetch("/api/video/models?surface=film-studio", {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await parseJsonResponse(response);
        if (!response.ok) throw apiFailure(payload, "视频模型读取失败");
        return normalizeModels(payload);
      }),
    ]).then(([nextImageModels, nextVideoModels]) => {
      const availableImages = nextImageModels.filter(modelAvailable);
      const availableVideos = nextVideoModels.filter((model) => !filmVideoUnavailableReason(model));
      setImageModels(nextImageModels);
      setVideoModels(nextVideoModels);
      setImageModelId((current) => current || availableImages[0]?.id || "");
      setVideoModelId((current) => current || availableVideos[0]?.id || "");
    }).catch((modelError: unknown) => {
      if (controller.signal.aborted) return;
      setError((current) => current || (modelError instanceof ProductionApiError
        ? modelError
        : new ProductionApiError(modelError instanceof Error ? modelError.message : "模型列表读取失败")));
    });
    return () => controller.abort();
  }, [stage]);

  const selectedImageModel = useMemo(
    () => imageModels.find((model) => model.id === imageModelId) || null,
    [imageModelId, imageModels],
  );
  const selectedVideoModel = useMemo(
    () => videoModels.find((model) => model.id === videoModelId) || null,
    [videoModelId, videoModels],
  );

  const imageResolutionOptions = useMemo(
    () => modelResolutionOptions(selectedImageModel),
    [selectedImageModel],
  );
  const videoResolutionOptions = useMemo(
    () => modelResolutionOptions(selectedVideoModel),
    [selectedVideoModel],
  );
  const videoDurationOptions = useMemo(
    () => modelDurationOptions(selectedVideoModel),
    [selectedVideoModel],
  );

  useEffect(() => {
    setImageResolution((current) => imageResolutionOptions.includes(current)
      ? current
      : imageResolutionOptions[0] || "");
  }, [imageResolutionOptions]);

  useEffect(() => {
    setVideoResolution((current) => videoResolutionOptions.includes(current)
      ? current
      : videoResolutionOptions[0] || "");
  }, [videoResolutionOptions]);

  useEffect(() => {
    setVideoDuration((current) => videoDurationOptions.includes(current)
      ? current
      : videoDurationOptions[0] || 10);
  }, [videoDurationOptions]);

  const completedVideoAssets = useMemo(() => {
    return [...snapshot.shots]
      .sort((left, right) => left.sequence - right.sequence)
      .flatMap((shot) => {
        const selected = selectedTake(shot, snapshot.assets, "video");
        return selected?.stableUri ? [selected] : [];
      });
  }, [snapshot.assets, snapshot.shots]);

  const allVideoAssets = useMemo(
    () => snapshot.assets
      .filter((asset) => asset.assetRole === "video" && asset.shotId && asset.stableUri)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [snapshot.assets],
  );

  const timelineIssue = useMemo(() => {
    const ids = new Set<string>();
    for (const clip of timelineClips) {
      if (ids.has(clip.id)) return "时间线片段编号重复";
      ids.add(clip.id);
      const shot = snapshot.shots.find((item) => item.id === clip.shotId);
      const asset = snapshot.assets.find((item) => item.id === clip.assetId);
      if (!shot || !asset || asset.assetRole !== "video" || asset.shotId !== shot.id || !asset.stableUri) {
        return "时间线包含已删除、未归档或不属于当前镜头的视频";
      }
      if (clip.startSeconds < 0 || clip.endSeconds <= clip.startSeconds || clip.endSeconds > takeDuration(asset, shot) + 0.05) {
        return `镜头 ${shot.sequence} 的入点或出点超出视频时长`;
      }
    }
    return "";
  }, [snapshot.assets, snapshot.shots, timelineClips]);

  const enabledTimelineCount = timelineClips.filter((clip) => clip.enabled).length;
  const assemblyTimelineIssue = timelineIssue
    || (enabledTimelineCount === 0 ? "至少启用一个视频片段" : "");
  const timelineDuration = timelineClips
    .filter((clip) => clip.enabled)
    .reduce((total, clip) => total + Math.max(0, clip.endSeconds - clip.startSeconds), 0);

  const finalExportAsset = useMemo(
    () => newest(snapshot.assets.filter((asset) => asset.assetRole === "export" && !asset.shotId && Boolean(asset.stableUri)
      && snapshot.jobs.some((job) => job.id === asset.jobId && job.stage === "final_assembly" && job.state === "succeeded"))),
    [snapshot.assets, snapshot.jobs],
  );

  const finalSubtitleAsset = useMemo(
    () => finalExportAsset ? snapshot.assets.find((asset) => asset.id === finalExportAsset.metadata.subtitleAssetId
      && asset.assetRole === "subtitle" && !asset.shotId && asset.jobId === finalExportAsset.jobId
      && asset.metadata.format === "srt" && Boolean(asset.stableUri)) : undefined,
    [finalExportAsset, snapshot.assets],
  );

  const missingVideoCount = useMemo(() => {
    const completedShotIds = new Set(completedVideoAssets.map((asset) => asset.shotId).filter(Boolean));
    return snapshot.shots.filter((shot) => !completedShotIds.has(shot.id)).length;
  }, [completedVideoAssets, snapshot.shots]);

  useEffect(() => {
    onCountsChange?.({
      shots: snapshot.shots.length,
      completedVideos: completedVideoAssets.length,
    });
  }, [completedVideoAssets.length, onCountsChange, snapshot.shots.length]);

  useEffect(() => {
    const valid = new Set(snapshot.shots.map((shot) => shot.id));
    setSelectedShotIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [snapshot.shots]);

  const activeJobs = useMemo(
    () => snapshot.jobs.filter((job) => ACTIVE_STATES.has(job.state)),
    [snapshot.jobs],
  );
  const orderedJobs = useMemo(
    () => [...snapshot.jobs].sort((left, right) => {
      const submittedAtDifference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      return submittedAtDifference || right.id.localeCompare(left.id);
    }),
    [snapshot.jobs],
  );

  useEffect(() => {
    if (activeJobs.length === 0) return;
    const timer = window.setInterval(() => {
      if (pollBusyRef.current) return;
      pollBusyRef.current = true;
      void Promise.all(activeJobs.map((job) => postAction({
        action: "poll_job",
        jobId: job.publicJobId,
      }))).then(() => loadSnapshot({ silent: true })).catch((pollError: unknown) => {
        setError(pollError instanceof ProductionApiError
          ? pollError
          : new ProductionApiError(pollError instanceof Error ? pollError.message : "任务状态刷新失败"));
      }).finally(() => {
        pollBusyRef.current = false;
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeJobs, loadSnapshot, postAction]);

  async function runAction(key: string, body: Record<string, unknown>, successMessage: string): Promise<boolean> {
    setPendingKey(key);
    setError(null);
    setNotice("");
    try {
      await postAction(body);
      setNotice(successMessage);
      await loadSnapshot({ silent: true });
      return true;
    } catch (actionError: unknown) {
      const mappedError = actionError instanceof ProductionApiError
        ? actionError
        : new ProductionApiError(actionError instanceof Error ? actionError.message : "生产操作失败");
      await loadSnapshot({ silent: true });
      setError(mappedError);
      return false;
    } finally {
      setPendingKey("");
    }
  }

  async function createPlan() {
    await runAction(
      "create-plan",
      { action: "create_plan", clientRequestId: createClientRequestId("plan") },
      "镜头计划已保存；本步骤没有提交生成或产生费用。",
    );
  }

  async function generateImage(shot: ProductionShot) {
    if (!selectedImageModel || !imageResolution) return;
    const approved = window.confirm(
      `为镜头 ${shot.sequence} 生成故事板图？\n${selectedImageModel.displayName} · ${imageResolution}\n报价 ${selectedImageModel.publicPrice.toFixed(2)}`,
    );
    if (!approved) return;
    await runAction(
      `image-${shot.id}`,
      {
        action: "generate_image",
        shotId: shot.id,
        clientRequestId: createClientRequestId(`image-${shot.sequence}`),
        modelId: selectedImageModel.id,
        resolution: imageResolution,
      },
      `镜头 ${shot.sequence} 的故事板图已保存。`,
    );
  }

  async function generateVideo(shot: ProductionShot) {
    if (!selectedVideoModel || !canSubmitFilmVideo(selectedVideoModel, videoResolution)) return;
    const approved = window.confirm(
      `使用已保存的镜头图片生成视频？\n${selectedVideoModel.displayName} · ${videoResolution || "模型默认规格"} · ${videoDuration} 秒\n报价 ${selectedVideoModel.publicPrice.toFixed(2)}`,
    );
    if (!approved) return;
    await runAction(
      `video-${shot.id}`,
      buildFilmVideoSubmission({
        model: selectedVideoModel,
        shotId: shot.id,
        clientRequestId: createClientRequestId(`video-${shot.sequence}`),
        resolution: videoResolution,
        duration: videoDuration,
      }),
      `镜头 ${shot.sequence} 的视频已提交，完成后自动保存。`,
    );
  }

  async function executeBatchGeneration(plan: BatchGenerationPlan) {
    const key = `batch-${plan.kind}`;
    setPendingKey(key);
    setError(null);
    setNotice("");
    for (let index = plan.nextIndex; index < plan.entries.length; index += 1) {
      const entry = plan.entries[index];
      const body = plan.kind === "image"
        ? {
            action: "generate_image",
            shotId: entry.shotId,
            clientRequestId: entry.clientRequestId,
            modelId: plan.modelId,
            ...(plan.resolution ? { resolution: plan.resolution } : {}),
          }
        : {
            action: "generate_video",
            shotId: entry.shotId,
            clientRequestId: entry.clientRequestId,
            modelId: plan.modelId,
            ...(plan.resolution ? { resolution: plan.resolution } : {}),
            duration: plan.duration,
          };
      let receivedResponse = false;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        receivedResponse = true;
        const payload = await parseJsonResponse(response);
        if (!response.ok) {
          setBatchRecovery(null);
          throw apiFailure(payload, `镜头 ${entry.shotSequence} 批量生成失败`);
        }
      } catch (batchError: unknown) {
        if (!receivedResponse) {
          setBatchRecovery({ ...plan, nextIndex: index });
          setError(new ProductionApiError(
            `镜头 ${entry.shotSequence} 提交后网络中断，批量任务已停止。点击“继续核对原批量请求”会复用同一请求编号。`,
            "BATCH_STATUS_UNKNOWN",
          ));
        } else {
          setError(batchError instanceof ProductionApiError
            ? batchError
            : new ProductionApiError(batchError instanceof Error ? batchError.message : "批量生成失败"));
        }
        await loadSnapshot({ silent: true });
        setPendingKey("");
        return;
      }
    }
    setBatchRecovery(null);
    setNotice(`${plan.entries.length} 个镜头的${plan.kind === "image" ? "图片" : "视频"}任务已依次提交；历史按提交时间保留每条记录。`);
    await loadSnapshot({ silent: true });
    setPendingKey("");
  }

  async function startBatchGeneration(kind: "image" | "video") {
    if (pendingKey || batchRecovery) return;
    const shots = snapshot.shots
      .filter((shot) => selectedShotIds.has(shot.id))
      .sort((left, right) => left.sequence - right.sequence);
    if (shots.length === 0) return;
    const model = kind === "image" ? selectedImageModel : selectedVideoModel;
    const resolution = kind === "image" ? imageResolution : videoResolution;
    if (!model || (kind === "image" ? !modelAvailable(model) : !canSubmitFilmVideo(model, resolution))) return;
    const stage = kind === "image" ? "image_generation" : "video_generation";
    const busy = shots.find((shot) => snapshot.jobs.some((job) => job.shotId === shot.id && job.stage === stage && ACTIVE_STATES.has(job.state)));
    if (busy) {
      setError(new ProductionApiError(`镜头 ${busy.sequence} 已有进行中的${kind === "image" ? "生图" : "视频"}任务，请先核对原任务。`, "BATCH_ACTIVE_JOB_EXISTS"));
      return;
    }
    if (kind === "video") {
      const missing = shots.find((shot) => !selectedTake(shot, snapshot.assets, "image"));
      if (missing) {
        setError(new ProductionApiError(`镜头 ${missing.sequence} 尚无已归档图片 TAKE，批量视频未提交。`, "BATCH_VIDEO_REFERENCE_REQUIRED"));
        return;
      }
    }
    const approved = window.confirm(
      `批量生成 ${shots.length} 个镜头的${kind === "image" ? "图片" : "视频"}？\n${model.displayName} · ${resolution || "模型默认规格"}${kind === "video" ? ` · ${videoDuration} 秒/镜头` : ""}\n按当前公开报价预计上限 ${(model.publicPrice * shots.length).toFixed(2)}\n系统逐条提交，网络状态不明时立即停止后续请求。`,
    );
    if (!approved) return;
    await executeBatchGeneration({
      kind,
      modelId: model.id,
      resolution,
      duration: videoDuration,
      entries: shots.map((shot) => ({
        shotId: shot.id,
        shotSequence: shot.sequence,
        clientRequestId: createClientRequestId(`batch-${kind}-${shot.sequence}`),
      })),
      nextIndex: 0,
    });
  }

  async function updateTake(
    shot: ProductionShot,
    asset: ProductionAsset,
    patch: { selected?: boolean; rating?: number | null; note?: string },
  ) {
    await runAction(
      `take-${asset.id}`,
      {
        action: "update_take",
        shotId: shot.id,
        assetId: asset.id,
        expectedShotRevision: shot.revision,
        ...patch,
      },
      patch.selected ? `已把该 ${asset.assetRole === "video" ? "视频" : "图片"}设为镜头 ${shot.sequence} 的当前 TAKE。` : "TAKE 评价已保存。",
    );
  }

  async function deleteTake(shot: ProductionShot, asset: ProductionAsset) {
    const approved = window.confirm("从当前项目删除这个 TAKE？历史任务与计费记录会保留，时间线中引用它的片段需要重新选择。");
    if (!approved) return;
    const succeeded = await runAction(
      `delete-take-${asset.id}`,
      {
        action: "delete_take",
        shotId: shot.id,
        assetId: asset.id,
        expectedShotRevision: shot.revision,
      },
      "TAKE 已从项目资产列表移除；任务与结算记录仍保留。",
    );
    if (succeeded) {
      setTimelineClips((current) => current.filter((clip) => clip.assetId !== asset.id));
      timelineDirtyRef.current = true;
    }
  }

  function editTimelineClip(id: string, patch: Partial<ProductionTimelineClip>) {
    timelineDirtyRef.current = true;
    setTimelineClips((current) => current.map((clip) => clip.id === id ? { ...clip, ...patch } : clip));
  }

  function moveTimelineClip(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= timelineClips.length) return;
    timelineDirtyRef.current = true;
    setTimelineClips((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function appendTimelineAsset(assetId: string) {
    const asset = snapshot.assets.find((item) => item.id === assetId && item.assetRole === "video") || null;
    const shot = asset ? snapshot.shots.find((item) => item.id === asset.shotId) || null : null;
    if (!asset || !shot) return;
    timelineDirtyRef.current = true;
    setTimelineClips((current) => [...current, createTimelineClip(shot, asset)]);
  }

  function resetTimeline() {
    timelineDirtyRef.current = true;
    setTimelineClips(defaultTimeline(snapshot));
  }

  async function saveTimeline() {
    if (timelineIssue) {
      setError(new ProductionApiError(timelineIssue, "TIMELINE_INVALID"));
      return;
    }
    setPendingKey("save-timeline");
    setError(null);
    setNotice("");
    try {
      await postAction({
        action: "save_timeline",
        expectedProjectRevision: snapshot.projectRevision,
        clips: timelineClips,
      });
      timelineDirtyRef.current = false;
      setNotice("时间线已写入项目版本；刷新页面后顺序、启用状态和入出点仍会恢复。");
      await loadSnapshot({ silent: true });
    } catch (saveError: unknown) {
      setError(saveError instanceof ProductionApiError
        ? saveError
        : new ProductionApiError(saveError instanceof Error ? saveError.message : "时间线保存失败"));
      await loadSnapshot({ silent: true });
    } finally {
      setPendingKey("");
    }
  }

  async function assembleFinal() {
    if (snapshot.shots.length === 0 || assemblyTimelineIssue) return;
    const approved = window.confirm(
      `将按当前时间线的 ${enabledTimelineCount} 个启用片段生成约 ${timelineDuration.toFixed(1)} 秒的统一 MP4${burnSubtitles ? "并添加旁白字幕" : ""}。\n该步骤在本地合成，不产生生成费用；是否继续？`,
    );
    if (!approved) return;
    await runAction(
      "assemble-final",
      {
        action: "assemble_final",
        clientRequestId: createClientRequestId("final-assembly"),
        burnSubtitles,
        timeline: timelineClips,
      },
      "统一成片已完成并写入稳定存储；刷新页面后仍可预览和下载。",
    );
  }

  async function downloadDurableAsset(asset: ProductionAsset, filename: string) {
    const isSubtitle = asset.assetRole === "subtitle";
    const label = isSubtitle ? "字幕" : "整片";
    const key = `download-${asset.id}`;
    setPendingKey(key);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/download?assetId=${encodeURIComponent(asset.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) throw apiFailure(await parseJsonResponse(response), `${label}下载失败，请稍后重试。`);
      const blob = await response.blob();
      const expectedType = isSubtitle ? "application/x-subrip" : "video/mp4";
      if (!blob.size || blob.type.split(";", 1)[0].trim().toLowerCase() !== expectedType) {
        throw new ProductionApiError(`${label}资产类型异常，已停止下载。`, "FINAL_DOWNLOAD_INVALID_TYPE");
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice(isSubtitle ? "已下载这份成片对应的 SRT 字幕。" : "统一成片已从当前项目的稳定资产下载。");
    } catch (downloadError: unknown) {
      setError(downloadError instanceof ProductionApiError
        ? downloadError
        : new ProductionApiError(downloadError instanceof Error ? downloadError.message : `${label}下载失败`));
    } finally {
      setPendingKey("");
    }
  }

  async function exportVideo(asset: ProductionAsset, shot: ProductionShot | null) {
    const job = snapshot.jobs.find((item) => item.id === asset.jobId) || null;
    if (!job?.publicJobId) {
      setError(new ProductionApiError("该视频缺少可核验的生产任务，不能导出。", "EXPORT_JOB_NOT_FOUND"));
      return;
    }
    const key = `export-${asset.id}`;
    setPendingKey(key);
    setError(null);
    setNotice("");
    try {
      const response = await fetch(`${endpoint}/export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jobId: job.publicJobId,
          targetDurationSeconds: Math.max(0.5, Math.min(60, shot?.durationSeconds || 5)),
        }),
      });
      if (!response.ok) {
        const payload = await parseJsonResponse(response);
        throw apiFailure(payload, "视频导出失败");
      }
      const blob = await response.blob();
      if (blob.type && blob.type !== "video/mp4") {
        throw new ProductionApiError("导出结果不是可用的 MP4，已停止下载。", "EXPORT_RESPONSE_INVALID");
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `shot-${shot?.sequence || "clip"}.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice(`镜头 ${shot?.sequence || "片段"} 已从当前账号的完成任务导出。`);
    } catch (exportError: unknown) {
      setError(exportError instanceof ProductionApiError
        ? exportError
        : new ProductionApiError(exportError instanceof Error ? exportError.message : "视频导出失败"));
    } finally {
      setPendingKey("");
    }
  }

  async function loadRetryCatalog(url: string, fallback: string): Promise<PublicModel[]> {
    const response = await fetch(url, { cache: "no-store" });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw apiFailure(payload, fallback);
    return normalizeModels(payload);
  }

  async function submitHistoryRetry(
    originalJob: ProductionJob,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    const key = `retry-${originalJob.id}`;
    setPendingKey(key);
    setError(null);
    setNotice("");
    let receivedResponse = false;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      receivedResponse = true;
      const payload = await parseJsonResponse(response);
      if (!response.ok) {
        retryRequestIdsRef.current.delete(originalJob.id);
        throw apiFailure(payload, "历史任务重新提交失败");
      }
      retryRequestIdsRef.current.delete(originalJob.id);
      setNotice(successMessage);
      await loadSnapshot({ silent: true });
    } catch (retryError: unknown) {
      if (!receivedResponse) {
        setError(new ProductionApiError(
          "网络在重新提交后中断，状态尚不明确。再次点击会复用同一请求编号，服务端不会重复付费提交。",
          "HISTORY_RETRY_STATUS_UNKNOWN",
        ));
      } else {
        setError(retryError instanceof ProductionApiError
          ? retryError
          : new ProductionApiError(retryError instanceof Error ? retryError.message : "历史任务重新提交失败"));
      }
      await loadSnapshot({ silent: true });
    } finally {
      setPendingKey("");
    }
  }

  async function retryFailedJob(job: ProductionJob) {
    if (job.state !== "failed" || pendingKey) return;
    const request = job.requestPayload;
    const requestId = retryRequestIdsRef.current.get(job.id)
      || createClientRequestId(`retry-${job.stage}`);
    retryRequestIdsRef.current.set(job.id, requestId);

    try {
      if (job.stage === "shot_planning") {
        if (!window.confirm("重新建立镜头计划？本步骤只保存计划，不会生成图片或视频。")) return;
        await submitHistoryRetry(job, { action: "create_plan", clientRequestId: requestId }, "失败的镜头计划已用新任务重新提交。");
        return;
      }
      if (job.stage === "final_assembly") {
        if (!window.confirm("按当前已保存时间线重新合成成片？该步骤在本地合成，不产生生成费用。")) return;
        await submitHistoryRetry(job, {
          action: "assemble_final",
          clientRequestId: requestId,
          burnSubtitles,
          timeline: timelineClips,
        }, "失败的成片合成已用新任务重新提交。");
        return;
      }

      const modelId = textValue(job.modelPublicId) || textValue(request.modelId);
      if (!modelId) throw new ProductionApiError("原任务没有可核验的模型编号，不能重新提交。", "HISTORY_MODEL_NOT_FOUND");

      if (job.stage === "entity_design") {
        const [models, entityResponse] = await Promise.all([
          loadRetryCatalog("/api/cover-models?surface=film-studio", "实体生图模型读取失败"),
          fetch(`/api/short-drama/projects/${encodeURIComponent(projectId)}/entities`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          }),
        ]);
        const entityPayload = await parseJsonResponse(entityResponse);
        if (!entityResponse.ok) throw apiFailure(entityPayload, "实体档案读取失败");
        const entityId = textValue(request.entityId);
        const entities = isRecord(entityPayload) && Array.isArray(entityPayload.entities)
          ? entityPayload.entities.filter(isRecord)
          : [];
        const entity = entities.find((candidate) => candidate.id === entityId);
        const model = models.find((candidate) => candidate.id === modelId && modelAvailable(candidate));
        if (!entity || !Number.isInteger(entity.revision)) {
          throw new ProductionApiError("原任务对应的实体已经不存在或版本无效。", "HISTORY_ENTITY_NOT_FOUND");
        }
        if (!model) throw new ProductionApiError("原实体生图模型当前已暂停，不能重新扣费提交。", "HISTORY_MODEL_UNAVAILABLE");
        const resolution = textValue(request.resolution) || modelResolutionOptions(model)[0] || "";
        const mode = request.mode === "repaint" ? "repaint" : "generate";
        if (!window.confirm(`重新提交实体图片任务？\n${model.displayName} · ${resolution || "模型默认规格"}\n单次公开报价 ${model.publicPrice.toFixed(2)}`)) return;
        await submitHistoryRetry(job, {
          action: "generate_entity_image",
          entityId,
          expectedEntityRevision: Number(entity.revision),
          clientRequestId: requestId,
          modelId,
          ...(resolution ? { resolution } : {}),
          mode,
          layout: request.layout === "three_view" ? "three_view" : "single",
        }, "失败的实体图片任务已用新请求编号提交；历史记录继续保留。");
        return;
      }

      const shot = snapshot.shots.find((candidate) => candidate.id === job.shotId);
      if (!shot) throw new ProductionApiError("原任务对应的镜头已经不存在，不能重新提交。", "HISTORY_SHOT_NOT_FOUND");
      if (job.stage === "image_generation") {
        const models = await loadRetryCatalog("/api/cover-models?surface=film-studio", "生图模型读取失败");
        const model = models.find((candidate) => candidate.id === modelId && modelAvailable(candidate));
        if (!model) throw new ProductionApiError("原生图模型当前已暂停，不能重新扣费提交。", "HISTORY_MODEL_UNAVAILABLE");
        const resolution = textValue(request.resolution) || modelResolutionOptions(model)[0] || "";
        if (!window.confirm(`重新提交镜头 ${shot.sequence} 生图？\n${model.displayName} · ${resolution || "模型默认规格"}\n单次公开报价 ${model.publicPrice.toFixed(2)}`)) return;
        await submitHistoryRetry(job, {
          action: "generate_image",
          shotId: shot.id,
          clientRequestId: requestId,
          modelId,
          ...(resolution ? { resolution } : {}),
        }, `镜头 ${shot.sequence} 的失败生图任务已用新请求编号提交。`);
        return;
      }
      if (job.stage === "video_generation") {
        const models = await loadRetryCatalog("/api/video/models?surface=film-studio", "视频模型读取失败");
        const model = models.find((candidate) => candidate.id === modelId && !filmVideoUnavailableReason(candidate));
        if (!model) throw new ProductionApiError("原视频模型当前不可用于图生视频，不能重新扣费提交。", "HISTORY_MODEL_UNAVAILABLE");
        const resolution = textValue(request.resolution) || modelResolutionOptions(model)[0] || "";
        const duration = Math.max(1, Math.min(60, finiteNumber(request.duration, 10)));
        if (!canSubmitFilmVideo(model, resolution)) {
          throw new ProductionApiError("原视频规格已不在当前模型能力范围内。", "HISTORY_MODEL_INPUT_UNAVAILABLE");
        }
        if (!window.confirm(`重新提交镜头 ${shot.sequence} 视频？\n${model.displayName} · ${resolution || "模型默认规格"} · ${duration} 秒\n单次公开报价 ${model.publicPrice.toFixed(2)}`)) return;
        await submitHistoryRetry(job, buildFilmVideoSubmission({
          model,
          shotId: shot.id,
          clientRequestId: requestId,
          resolution,
          duration,
        }), `镜头 ${shot.sequence} 的失败视频任务已用新请求编号提交。`);
        return;
      }
      retryRequestIdsRef.current.delete(job.id);
      throw new ProductionApiError("该类型历史任务暂不支持重新提交。", "HISTORY_RETRY_UNSUPPORTED");
    } catch (retryError: unknown) {
      setError(retryError instanceof ProductionApiError
        ? retryError
        : new ProductionApiError(retryError instanceof Error ? retryError.message : "历史任务重新提交失败"));
    }
  }

  async function recoverActiveJob(job: ProductionJob) {
    await runAction(
      `recover-${job.id}`,
      { action: "poll_job", jobId: job.publicJobId },
      "已核对原任务；正在恢复已有结果，没有新建生成请求。",
    );
  }

  if (loading) {
    return (
      <section className={styles.centerState} role="status">
        <LoaderCircle className={styles.spin} size={28} />
        <strong>正在读取镜头、任务与作品…</strong>
        <span>页面会按项目的实际进度显示状态。</span>
      </section>
    );
  }

  if (error && snapshot.shots.length === 0 && snapshot.jobs.length === 0) {
    const migrationMissing = error.code === "MIGRATION_NOT_READY";
    return (
      <section className={styles.blockedState} role="alert" data-code={error.code}>
        <AlertTriangle size={32} />
        <span className={styles.eyebrow}>成片制作暂不可用</span>
        <h2>{migrationMissing ? "影视生产服务正在准备中" : "影视生产服务暂时不可用"}</h2>
        <p>{migrationMissing ? "当前不会提交生成或产生费用，请稍后重新检查。" : error.message}</p>
        {migrationMissing && (
          <div className={styles.migrationHint}>
            已有剧本、角色和分镜草稿不会受影响；服务恢复后可继续制作。
          </div>
        )}
        <button type="button" onClick={() => void loadSnapshot()}>
          <RefreshCw size={16} />
          重新检查
        </button>
      </section>
    );
  }

  return (
    <section className={styles.root} data-testid={`film-project-${stage}-step`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>{stage === "storyboard" ? "STEP 05 · STORYBOARD" : "STEP 06 · PREVIEW / EXPORT"}</span>
          <h2>{stage === "storyboard" ? "分镜生产" : "完成视频与统一成片"}</h2>
          <p>
            {stage === "storyboard"
              ? "为每个镜头生成图片和视频，完成后自动保存。"
              : "按镜头顺序合成视频，支持旁白字幕和 MP4 下载。"}
          </p>
        </div>
        <button
          className={styles.refreshButton}
          type="button"
          disabled={refreshing || Boolean(pendingKey)}
          onClick={() => void loadSnapshot({ silent: true })}
        >
          <RefreshCw className={refreshing ? styles.spin : undefined} size={16} />
          刷新真实状态
        </button>
      </header>

      {(error || notice) && (
        <div className={styles.statusBar} data-tone={error ? "danger" : "success"} role={error ? "alert" : "status"}>
          {error ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
          <span>{error ? `${error.message}（${error.code}）` : notice}</span>
        </div>
      )}

      {stage === "storyboard" ? (
        <>
          {snapshot.shots.length === 0 ? (
            <div className={styles.emptyPlan}>
              <span><Clapperboard size={28} /></span>
              <h3>尚未建立镜头计划</h3>
              <p>可从当前项目已经保存的分段、剧本或动画拆解结果生成镜头记录。若项目没有可用来源，服务端会明确拒绝，不补造演示数据。</p>
              <button
                className={styles.primaryButton}
                type="button"
                disabled={pendingKey === "create-plan" || Boolean(creationBlockedMessage)}
                title={creationBlockedMessage || "从项目内容建立镜头计划"}
                onClick={() => void createPlan()}
              >
                {pendingKey === "create-plan" ? <LoaderCircle className={styles.spin} size={16} /> : <Sparkles size={16} />}
                {pendingKey === "create-plan" ? "写入镜头中…" : "从项目内容建立镜头计划"}
              </button>
              <small>{creationBlockedMessage || "此按钮只写入镜头计划，不调用生图或视频模型。"}</small>
            </div>
          ) : (
            <>
              <div className={styles.modelBar}>
                <div className={styles.modelGroup}>
                  <span><ImageIcon size={16} /> 生图模型</span>
                  <select aria-label="分镜生图模型" value={imageModelId} onChange={(event) => setImageModelId(event.target.value)}>
                    <option value="">暂无可用生图模型</option>
                    {imageModels.map((model) => (
                      <option disabled={!modelAvailable(model)} key={model.id} value={model.id}>
                        {modelLabel(model)}{modelAvailable(model) ? "" : " · 已暂停"}
                      </option>
                    ))}
                  </select>
                  <select aria-label="分镜图片分辨率" value={imageResolution} onChange={(event) => setImageResolution(event.target.value)}>
                    {imageResolutionOptions.map((resolution) => <option key={resolution}>{resolution}</option>)}
                  </select>
                  <button
                    className={styles.batchGenerateButton}
                    type="button"
                    disabled={!selectedShotIds.size || !selectedImageModel || !imageResolution || Boolean(pendingKey) || Boolean(batchRecovery)}
                    onClick={() => void startBatchGeneration("image")}
                  >
                    {pendingKey === "batch-image" ? <LoaderCircle className={styles.spin} size={14} /> : <Sparkles size={14} />}
                    批量生图
                  </button>
                </div>
                <div className={styles.modelGroup}>
                  <span><Video size={16} /> 视频模型</span>
                  <select aria-label="分镜视频模型" value={videoModelId} onChange={(event) => setVideoModelId(event.target.value)}>
                    <option value="">暂无可用视频模型</option>
                    {videoModels.map((model) => (
                      <option disabled={Boolean(filmVideoUnavailableReason(model))} key={model.id} value={model.id}>
                        {modelLabel(model)}{filmVideoUnavailableReason(model) ? ` · ${filmVideoUnavailableReason(model)}` : ""}
                      </option>
                    ))}
                  </select>
                  <select aria-label="分镜视频分辨率" disabled={!videoResolutionOptions.length} value={videoResolution} onChange={(event) => setVideoResolution(event.target.value)}>
                    {!videoResolutionOptions.length && <option value="">模型默认规格</option>}
                    {videoResolutionOptions.map((resolution) => <option key={resolution}>{resolution}</option>)}
                  </select>
                  <select aria-label="分镜视频时长" value={videoDuration} onChange={(event) => setVideoDuration(Number(event.target.value))}>
                    {videoDurationOptions.map((duration) => <option key={duration} value={duration}>{duration} 秒</option>)}
                  </select>
                  <button
                    className={styles.batchGenerateButton}
                    type="button"
                    disabled={!selectedShotIds.size || !canSubmitFilmVideo(selectedVideoModel, videoResolution) || Boolean(pendingKey) || Boolean(batchRecovery)}
                    onClick={() => void startBatchGeneration("video")}
                  >
                    {pendingKey === "batch-video" ? <LoaderCircle className={styles.spin} size={14} /> : <Video size={14} />}
                    批量视频
                  </button>
                </div>
                <div className={styles.batchSelectionSummary}>
                  <span>已选择 {selectedShotIds.size}/{snapshot.shots.length} 个镜头</span>
                  <button type="button" disabled={Boolean(pendingKey)} onClick={() => setSelectedShotIds(new Set(snapshot.shots.map((shot) => shot.id)))}>全选</button>
                  <button type="button" disabled={Boolean(pendingKey) || selectedShotIds.size === 0} onClick={() => setSelectedShotIds(new Set())}>清空</button>
                </div>
                {batchRecovery && (
                  <div className={styles.batchRecovery} data-testid="film-batch-generation-recovery">
                    <AlertTriangle size={16} />
                    <span>批量任务停在第 {batchRecovery.nextIndex + 1}/{batchRecovery.entries.length} 条；后续请求尚未提交。</span>
                    <button type="button" disabled={Boolean(pendingKey)} onClick={() => void executeBatchGeneration(batchRecovery)}>
                      <RefreshCw size={14} />继续核对原批量请求
                    </button>
                  </div>
                )}
              </div>

              <div className={styles.shotGrid}>
                {snapshot.shots.map((shot) => {
                  const shotAssets = snapshot.assets.filter((asset) => asset.shotId === shot.id);
                  const imageTakes = shotAssets.filter((asset) => (
                    (asset.assetRole === "image" || asset.assetRole === "storyboard")
                    && Boolean(asset.stableUri)
                  ));
                  const videoTakes = shotAssets.filter((asset) => asset.assetRole === "video" && Boolean(asset.stableUri));
                  const imageAsset = selectedTake(shot, imageTakes, "image");
                  const videoAsset = selectedTake(shot, videoTakes, "video");
                  const imageJob = newest(snapshot.jobs.filter((job) => job.shotId === shot.id && job.stage === "image_generation"));
                  const videoJob = newest(snapshot.jobs.filter((job) => job.shotId === shot.id && job.stage === "video_generation"));
                  const imageBusy = Boolean(imageJob && ACTIVE_STATES.has(imageJob.state));
                  const videoBusy = Boolean(videoJob && ACTIVE_STATES.has(videoJob.state));
                  return (
                    <article className={styles.shotCard} key={shot.id}>
                      <div className={styles.shotHeading}>
                        <span>{String(shot.sequence).padStart(2, "0")}</span>
                        <div>
                          <h3>{shot.title || `镜头 ${shot.sequence}`}</h3>
                          <small>{shot.aspectRatio} · 计划 {shot.durationSeconds} 秒 · 版本 {shot.revision}</small>
                        </div>
                        <label className={styles.shotSelect}>
                          <input
                            type="checkbox"
                            checked={selectedShotIds.has(shot.id)}
                            disabled={Boolean(pendingKey)}
                            onChange={(event) => setSelectedShotIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(shot.id);
                              else next.delete(shot.id);
                              return next;
                            })}
                          />
                          批量
                        </label>
                      </div>

                      <div className={styles.mediaPair}>
                        <div className={styles.mediaFrame}>
                          {assetUrl(imageAsset) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={assetUrl(imageAsset)} alt={`镜头 ${shot.sequence} 已持久化故事板`} />
                          ) : (
                            <span>
                              <ImageIcon size={24} />
                              {imageAsset ? "故事板已持久化，预览签名暂不可用" : "尚无持久化故事板"}
                            </span>
                          )}
                          {imageJob && (
                            <small data-state={imageJob.state}>
                              {jobStateLabel(imageJob.state)} · {Math.round(Math.max(0, Math.min(100, imageJob.progress)))}%
                            </small>
                          )}
                        </div>
                        <div className={styles.mediaFrame}>
                          {assetUrl(videoAsset) ? (
                            <video controls preload="metadata" src={assetUrl(videoAsset)} />
                          ) : (
                            <span>
                              <PlayCircle size={24} />
                              {videoAsset ? "视频已持久化，预览签名暂不可用" : "尚无完成视频"}
                            </span>
                          )}
                          {videoJob && (
                            <small data-state={videoJob.state}>
                              {jobStateLabel(videoJob.state)} · {Math.round(Math.max(0, Math.min(100, videoJob.progress)))}%
                            </small>
                          )}
                        </div>
                      </div>

                      {(imageTakes.length > 0 || videoTakes.length > 0) && (
                        <div className={styles.takeManager} data-testid={`film-takes-${shot.id}`}>
                          {([
                            { label: "图片 TAKE", role: "image" as const, items: imageTakes, selected: imageAsset },
                            { label: "视频 TAKE", role: "video" as const, items: videoTakes, selected: videoAsset },
                          ]).map((group) => group.items.length > 0 && (
                            <section className={styles.takeGroup} key={group.role}>
                              <div className={styles.takeGroupHeader}>
                                <strong>{group.label}</strong>
                                <span>{group.items.length} 个版本 · 可预览、评分、备注、切换或删除</span>
                              </div>
                              <div className={styles.takeStrip}>
                                {group.items.map((asset, takeIndex) => {
                                  const isSelected = group.selected?.id === asset.id;
                                  const rating = Math.max(0, Math.min(5, finiteNumber(asset.metadata.takeRating, 0)));
                                  const busy = pendingKey === `take-${asset.id}` || pendingKey === `delete-take-${asset.id}`;
                                  return (
                                    <article className={styles.takeCard} data-selected={isSelected} key={asset.id}>
                                      <div className={styles.takePreview}>
                                        {group.role === "image" && asset.previewUrl ? (
                                          // eslint-disable-next-line @next/next/no-img-element
                                          <img src={asset.previewUrl} alt={`镜头 ${shot.sequence} 图片 TAKE ${takeIndex + 1}`} />
                                        ) : group.role === "video" && asset.previewUrl ? (
                                          <video controls preload="metadata" src={asset.previewUrl} />
                                        ) : (
                                          <span>{asset.previewUrl ? "预览不可用" : "签名暂不可用"}</span>
                                        )}
                                        <small>{isSelected ? "当前使用" : `TAKE ${takeIndex + 1}`}</small>
                                      </div>
                                      <div className={styles.takeControls}>
                                        <button type="button" disabled={busy || isSelected || Boolean(pendingKey)} onClick={() => void updateTake(shot, asset, { selected: true })}>
                                          {isSelected ? <CheckCircle2 size={13} /> : <PlayCircle size={13} />}
                                          {isSelected ? "已选" : "设为当前"}
                                        </button>
                                        <div className={styles.takeRating} aria-label={`TAKE 评分 ${rating || "未评分"}`}>
                                          {[1, 2, 3, 4, 5].map((score) => (
                                            <button type="button" disabled={busy || Boolean(pendingKey)} data-active={score <= rating} key={score} title={`${score} 星`} onClick={() => void updateTake(shot, asset, { rating: score })}>
                                              <Star size={12} fill={score <= rating ? "currentColor" : "none"} />
                                            </button>
                                          ))}
                                        </div>
                                        <input
                                          aria-label={`${group.label}备注`}
                                          defaultValue={textValue(asset.metadata.takeNote)}
                                          disabled={busy || Boolean(pendingKey)}
                                          maxLength={200}
                                          placeholder="TAKE 备注"
                                          onBlur={(event) => {
                                            const next = event.currentTarget.value.trim();
                                            if (next !== textValue(asset.metadata.takeNote)) void updateTake(shot, asset, { note: next });
                                          }}
                                        />
                                        <button className={styles.takeDelete} type="button" disabled={busy || Boolean(pendingKey)} onClick={() => void deleteTake(shot, asset)}>
                                          <Trash2 size={13} />删除
                                        </button>
                                      </div>
                                    </article>
                                  );
                                })}
                              </div>
                            </section>
                          ))}
                        </div>
                      )}

                      <dl className={styles.shotCopy}>
                        {imageJob && <div><dt>图片任务模型</dt><dd>{filmJobModelLabel(imageJob.modelPublicId, imageModels)}</dd></div>}
                        {videoJob && <div><dt>视频任务模型</dt><dd>{filmJobModelLabel(videoJob.modelPublicId, videoModels)}</dd></div>}
                        <div><dt>旁白 / 剧情</dt><dd>{shot.narration || "未提供"}</dd></div>
                        <div><dt>画面说明</dt><dd>{shot.visualDescription || "未提供"}</dd></div>
                        <div><dt>生图提示词</dt><dd>{shot.imagePrompt || "未提供"}</dd></div>
                        <div><dt>视频提示词</dt><dd>{shot.videoPrompt || "未提供"}</dd></div>
                      </dl>

                      {(imageJob?.state === "failed" || videoJob?.state === "failed") && (
                        <div className={styles.jobError}>
                          <AlertTriangle size={15} />
                          <span>
                            {videoJob?.state === "failed"
                              ? `${filmJobModelLabel(videoJob.modelPublicId, videoModels)}：${videoJob.errorMessage || "视频任务失败"}（${videoJob.errorCode || "UPSTREAM_FAILED"}）`
                              : `${filmJobModelLabel(imageJob?.modelPublicId || null, imageModels)}：${imageJob?.errorMessage || "生图任务失败"}（${imageJob?.errorCode || "UPSTREAM_FAILED"}）`}
                          </span>
                        </div>
                      )}

                      <div className={styles.shotActions}>
                        <button
                          type="button"
                          disabled={!selectedImageModel || !imageResolution || imageBusy || Boolean(pendingKey)}
                          onClick={() => void generateImage(shot)}
                        >
                          {pendingKey === `image-${shot.id}` || imageBusy
                            ? <LoaderCircle className={styles.spin} size={15} />
                            : <ImageIcon size={15} />}
                          {imageAsset ? "重新付费生图" : "付费生成故事板图"}
                        </button>
                        <button
                          type="button"
                          disabled={!imageAsset || !canSubmitFilmVideo(selectedVideoModel, videoResolution) || videoBusy || Boolean(pendingKey)}
                          onClick={() => void generateVideo(shot)}
                        >
                          {pendingKey === `video-${shot.id}` || videoBusy
                            ? <LoaderCircle className={styles.spin} size={15} />
                            : <Video size={15} />}
                          {videoAsset ? "重新付费生成视频" : "付费生成镜头视频"}
                        </button>
                      </div>
                      {!imageAsset && <small className={styles.dependencyHint}>视频任务必须先有当前项目内已持久化的镜头图片。</small>}
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </>
      ) : (
        <div className={styles.finalStack}>
          <div className={styles.boundaryNotice}>
            <Film size={20} />
            <div>
              <strong>时间线只使用已持久化的视频 TAKE</strong>
              <span>可以排序、禁用、重复使用并设置入点和出点；本地导出不产生生成费用。</span>
            </div>
          </div>
          <section className={styles.timelinePanel} data-testid="film-studio-timeline-editor">
            <div className={styles.timelineHeader}>
              <div>
                <span className={styles.eyebrow}>EDITABLE TIMELINE</span>
                <h3>成片时间线</h3>
                <p>{enabledTimelineCount} 个启用片段 · 约 {timelineDuration.toFixed(1)} 秒 · 项目版本 {snapshot.projectRevision}</p>
              </div>
              <div className={styles.timelineToolbar}>
                <label>
                  <Plus size={14} />
                  <select aria-label="添加视频 TAKE 到时间线" value="" disabled={allVideoAssets.length === 0 || Boolean(pendingKey)} onChange={(event) => appendTimelineAsset(event.target.value)}>
                    <option value="">添加视频 TAKE…</option>
                    {allVideoAssets.map((asset) => {
                      const shot = snapshot.shots.find((item) => item.id === asset.shotId);
                      return <option key={asset.id} value={asset.id}>镜头 {shot?.sequence || "-"} · {shot?.title || "视频 TAKE"}</option>;
                    })}
                  </select>
                </label>
                <button type="button" disabled={Boolean(pendingKey)} onClick={resetTimeline}>恢复当前 TAKE 顺序</button>
                <button type="button" disabled={Boolean(timelineIssue) || Boolean(pendingKey)} onClick={() => void saveTimeline()}>
                  {pendingKey === "save-timeline" ? <LoaderCircle className={styles.spin} size={14} /> : <Save size={14} />}
                  保存时间线
                </button>
              </div>
            </div>
            {timelineIssue && <div className={styles.timelineIssue}><AlertTriangle size={14} />{timelineIssue}</div>}
            <div className={styles.timelineList}>
              {timelineClips.map((clip, index) => {
                const shot = snapshot.shots.find((item) => item.id === clip.shotId) || null;
                const asset = snapshot.assets.find((item) => item.id === clip.assetId) || null;
                const maxDuration = shot && asset ? takeDuration(asset, shot) : 0;
                return (
                  <article className={styles.timelineClip} data-enabled={clip.enabled} key={clip.id}>
                    <div className={styles.timelineIndex}>{String(index + 1).padStart(2, "0")}</div>
                    <div className={styles.timelinePreview}>
                      {asset?.previewUrl ? <video controls preload="metadata" src={asset.previewUrl} /> : <span>预览暂不可用</span>}
                    </div>
                    <div className={styles.timelineCopy}>
                      <strong>镜头 {shot?.sequence || "-"} · {shot?.title || "视频 TAKE"}</strong>
                      <span>{clip.assetId.slice(0, 8)} · 最长 {maxDuration.toFixed(1)} 秒</span>
                    </div>
                    <label className={styles.timelineEnabled}>
                      <input type="checkbox" checked={clip.enabled} disabled={Boolean(pendingKey)} onChange={(event) => editTimelineClip(clip.id, { enabled: event.target.checked })} />
                      启用
                    </label>
                    <label className={styles.timelineTime}>
                      <span>入点</span>
                      <input type="number" min={0} max={Math.max(0, maxDuration - 0.1)} step={0.1} value={clip.startSeconds} disabled={Boolean(pendingKey)} onChange={(event) => editTimelineClip(clip.id, { startSeconds: finiteNumber(event.target.value, 0) })} />
                    </label>
                    <label className={styles.timelineTime}>
                      <span>出点</span>
                      <input type="number" min={0.1} max={maxDuration} step={0.1} value={clip.endSeconds} disabled={Boolean(pendingKey)} onChange={(event) => editTimelineClip(clip.id, { endSeconds: finiteNumber(event.target.value, maxDuration) })} />
                    </label>
                    <div className={styles.timelineActions}>
                      <button type="button" aria-label="片段上移" disabled={index === 0 || Boolean(pendingKey)} onClick={() => moveTimelineClip(index, -1)}><ArrowUp size={14} /></button>
                      <button type="button" aria-label="片段下移" disabled={index === timelineClips.length - 1 || Boolean(pendingKey)} onClick={() => moveTimelineClip(index, 1)}><ArrowDown size={14} /></button>
                      <button type="button" aria-label="移除片段" disabled={Boolean(pendingKey)} onClick={() => {
                        timelineDirtyRef.current = true;
                        setTimelineClips((current) => current.filter((item) => item.id !== clip.id));
                      }}><Trash2 size={14} /></button>
                    </div>
                  </article>
                );
              })}
              {timelineClips.length === 0 && <div className={styles.timelineEmpty}>暂无时间线片段，请从已完成的视频 TAKE 中添加。</div>}
            </div>
          </section>
          <div className={styles.assemblyPanel}>
            <div>
              <span className={styles.eyebrow}>FINAL ASSEMBLY</span>
              <h3>生成可交付整片</h3>
              <p>
                已完成 {completedVideoAssets.length} / {snapshot.shots.length} 个镜头
                {missingVideoCount > 0 ? `，默认顺序还缺 ${missingVideoCount} 个；也可使用当前自定义时间线` : "，默认顺序完整"}。
              </p>
            </div>
            <label className={styles.subtitleOption}>
              <input
                type="checkbox"
                checked={burnSubtitles}
                disabled={Boolean(pendingKey)}
                onChange={(event) => setBurnSubtitles(event.target.checked)}
              />
              输出 SRT 并烧录旁白字幕
            </label>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={snapshot.shots.length === 0 || Boolean(assemblyTimelineIssue) || Boolean(pendingKey)}
              title={snapshot.shots.length === 0 ? "请先创建生产镜头" : assemblyTimelineIssue || "使用当前时间线生成统一成片"}
              onClick={() => void assembleFinal()}
            >
              {pendingKey === "assemble-final"
                ? <LoaderCircle className={styles.spin} size={16} />
                : <Clapperboard size={16} />}
              {finalExportAsset ? "重新生成统一成片" : "生成统一成片"}
            </button>
          </div>
          {finalExportAsset && (
            <article className={styles.finalMaster} data-testid="film-studio-final-master">
              {finalExportAsset.previewUrl ? (
                <video controls preload="metadata" src={finalExportAsset.previewUrl} />
              ) : (
                <div className={styles.finalMediaUnavailable}>
                  <AlertTriangle size={24} />
                  <span>统一成片已登记，但本次预览签名暂不可用；刷新后可恢复。</span>
                </div>
              )}
              <div className={styles.finalCopy}>
                <div>
                  <span>统一成片 · 已持久化</span>
                  <h3>项目最终 MP4</h3>
                  <small>
                    {finiteNumber(finalExportAsset.metadata.shotCount, snapshot.shots.length)} 个镜头 · {finiteNumber(finalExportAsset.metadata.totalDurationSeconds, 0).toFixed(1)} 秒 · {fileSizeLabel(finalExportAsset.byteSize)}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={Boolean(pendingKey)}
                  onClick={() => void downloadDurableAsset(finalExportAsset, `film-${projectId}.mp4`)}
                >
                  {pendingKey === `download-${finalExportAsset.id}`
                    ? <LoaderCircle className={styles.spin} size={15} />
                    : <Download size={15} />}
                  下载整片
                </button>
                {finalSubtitleAsset && (
                  <button
                    type="button"
                    disabled={Boolean(pendingKey)}
                    onClick={() => void downloadDurableAsset(finalSubtitleAsset, `film-${projectId}.srt`)}
                  >
                    {pendingKey === `download-${finalSubtitleAsset.id}`
                      ? <LoaderCircle className={styles.spin} size={15} />
                      : <Download size={15} />}
                    下载字幕 SRT
                  </button>
                )}
              </div>
            </article>
          )}
          {allVideoAssets.length === 0 ? (
            <div className={styles.emptyFinal}>
              <Film size={30} />
              <h3>暂无可核验的完成视频</h3>
              <p>请先在“分镜”步骤完成真实视频任务。只有成功终态、归档完成且属于当前项目的视频才会出现在这里。</p>
            </div>
          ) : (
            <>
              <h3 className={styles.clipHeading}>镜头片段</h3>
              <div className={styles.finalGrid}>
                {allVideoAssets.map((asset) => {
                const shot = snapshot.shots.find((item) => item.id === asset.shotId) || null;
                const selected = shot ? selectedTake(shot, snapshot.assets, "video")?.id === asset.id : false;
                return (
                  <article className={styles.finalCard} key={asset.id}>
                    {asset.previewUrl ? (
                      <video controls preload="metadata" src={asset.previewUrl} />
                    ) : (
                      <div className={styles.finalMediaUnavailable}>
                        <AlertTriangle size={24} />
                        <span>稳定视频资产已登记，但本次预览签名暂不可用；可刷新后重试。</span>
                      </div>
                    )}
                    <div className={styles.finalCopy}>
                      <div>
                        <span>镜头 {shot?.sequence || "-"} · {selected ? "当前 TAKE" : "历史 TAKE"}</span>
                        <h3>{shot?.title || "已完成视频片段"}</h3>
                        <small>{shot?.durationSeconds || "?"} 秒 · {fileSizeLabel(asset.byteSize)} · 已持久化</small>
                      </div>
                      <button
                        type="button"
                        disabled={Boolean(pendingKey)}
                        onClick={() => void exportVideo(asset, shot)}
                      >
                        {pendingKey === `export-${asset.id}`
                          ? <LoaderCircle className={styles.spin} size={15} />
                          : <Download size={15} />}
                        导出 MP4
                      </button>
                    </div>
                  </article>
                );
                })}
              </div>
            </>
          )}
        </div>
      )}
      <section className={styles.jobHistory} data-testid="film-production-job-history">
        <div className={styles.jobHistoryHeader}>
          <div>
            <span className={styles.eyebrow}>PROJECT TASK HISTORY</span>
            <h3>项目任务历史</h3>
            <p>按提交时间倒序展示。失败记录保留原错误与计费快照，可经确认后用新请求编号重新提交。</p>
          </div>
          <b>{orderedJobs.length} 条</b>
        </div>
        <div className={styles.jobHistoryList}>
          {orderedJobs.slice(0, historyLimit).map((job) => {
            const asset = newest(snapshot.assets.filter((candidate) => candidate.jobId === job.id));
            const billed = Math.max(0, finiteNumber(job.billingSnapshot.actualCashCharged));
            const canRetry = job.state === "failed" && [
              "shot_planning",
              "entity_design",
              "image_generation",
              "video_generation",
              "final_assembly",
            ].includes(job.stage);
            const active = ACTIVE_STATES.has(job.state);
            return (
              <article className={styles.jobHistoryItem} key={job.id} data-job-state={job.state}>
                <div className={styles.jobPreview}>
                  {asset?.previewUrl ? (
                    asset.mimeType?.startsWith("video/") || asset.assetRole === "video" || asset.assetRole === "export"
                      ? <video muted playsInline preload="metadata" src={asset.previewUrl} />
                      : <img src={asset.previewUrl} alt={`${jobStageLabel(job.stage)}结果预览`} />
                  ) : (
                    <span>{job.stage === "video_generation" || job.stage === "final_assembly" ? <Video size={20} /> : <ImageIcon size={20} />}</span>
                  )}
                </div>
                <div className={styles.jobHistoryCopy}>
                  <div>
                    <strong>{jobStageLabel(job.stage)}</strong>
                    <span data-job-state-label={job.state}>{jobStateLabel(job.state)}</span>
                  </div>
                  <small>
                    {formatSubmittedAt(job.createdAt)} · {filmJobModelLabel(job.modelPublicId, [...imageModels, ...videoModels])}
                    {billed > 0 ? ` · 实扣 ${billed.toFixed(2)}` : " · 实扣 0.00/待终态"}
                  </small>
                  {(job.errorMessage || job.errorCode) && (
                    <p>{job.errorMessage || "任务失败"}{job.errorCode ? `（${job.errorCode}）` : ""}</p>
                  )}
                  <code>{job.publicJobId}</code>
                </div>
                <div className={styles.jobHistoryActions}>
                  {active && (
                    <button
                      type="button"
                      disabled={Boolean(pendingKey)}
                      onClick={() => void recoverActiveJob(job)}
                    >
                      {pendingKey === `recover-${job.id}` ? <LoaderCircle className={styles.spin} size={14} /> : <RefreshCw size={14} />}
                      核对原任务
                    </button>
                  )}
                  {canRetry && (
                    <button
                      type="button"
                      disabled={Boolean(pendingKey)}
                      onClick={() => void retryFailedJob(job)}
                    >
                      {pendingKey === `retry-${job.id}` ? <LoaderCircle className={styles.spin} size={14} /> : <RefreshCw size={14} />}
                      重新提交
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {orderedJobs.length === 0 && (
            <div className={styles.jobHistoryEmpty}>尚无任务记录。首次生成前会先建立可追踪任务。</div>
          )}
        </div>
        {orderedJobs.length > historyLimit && (
          <button className={styles.historyMore} type="button" onClick={() => setHistoryLimit((value) => value + 20)}>
            再显示 {Math.min(20, orderedJobs.length - historyLimit)} 条
          </button>
        )}
      </section>
    </section>
  );
}
