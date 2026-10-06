"use client";

import {
  AlertTriangle,
  Box,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  JsonValue,
  ShortDramaEntity,
  ShortDramaEntityType,
} from "@/lib/short-drama/contracts";
import styles from "./film-studio-entity-panel.module.css";

type EditableEntityType = Extract<ShortDramaEntityType, "character" | "location" | "prop">;
type StorageMode = "native" | "compat";

interface FilmStudioEntityPanelProps {
  projectId: string;
  token: string;
  entityType: EditableEntityType;
  sourceItems: Array<Record<string, JsonValue>>;
  onCountChange?: (count: number) => void;
}

interface EditorState {
  mode: "create" | "edit";
  entityId: string | null;
  expectedRevision: number | null;
  entityKey: string;
  name: string;
  description: string;
  attributes: Record<string, JsonValue>;
  referenceAssetUri: string | null;
  assetVersions: EntityAssetVersion[];
}

interface EntityAssetVersion {
  id: string;
  uri: string;
  label: string;
  createdAt: string;
}

interface ApiFailure extends Error {
  code?: string;
}

interface PublicImageModel {
  id: string;
  displayName: string;
  variantLabel: string;
  publicPrice: number;
  capabilities: Record<string, unknown>;
}

interface PendingEntityGeneration {
  entityId: string;
  entityName: string;
  expectedEntityRevision: number;
  mode: "generate" | "repaint";
  layout: "single" | "three_view";
  clientRequestId: string;
  modelId: string;
  resolution: string;
  jobId: string;
}

const CONFIG = {
  character: {
    title: "角色档案",
    singular: "角色",
    sourceLabel: "角色设定",
    icon: Users,
    fields: [
      ["role", "角色定位"],
      ["profile", "人物简介"],
      ["personality", "性格"],
      ["appearance", "外观"],
      ["voiceDirection", "声音方向"],
    ],
  },
  location: {
    title: "场景档案",
    singular: "场景",
    sourceLabel: "场景设定",
    icon: ImageIcon,
    fields: [
      ["time", "时间"],
      ["atmosphere", "氛围"],
      ["episodeNumbers", "出现分集"],
    ],
  },
  prop: {
    title: "道具档案",
    singular: "道具",
    sourceLabel: "道具设定",
    icon: Box,
    fields: [
      ["category", "分类"],
      ["episodeNumbers", "出现分集"],
    ],
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textValue(item)).filter(Boolean).join("、");
  return fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function normalizeModels(value: unknown): PublicImageModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return [];
  return value.models.flatMap((model): PublicImageModel[] => {
    if (!isRecord(model) || typeof model.id !== "string") return [];
    return [{
      id: model.id,
      displayName: textValue(model.displayName, "未命名模型"),
      variantLabel: textValue(model.variantLabel),
      publicPrice: Math.max(0, finiteNumber(model.publicPrice)),
      capabilities: isRecord(model.capabilities) ? model.capabilities : {},
    }];
  });
}

function modelAvailable(model: PublicImageModel): boolean {
  return model.capabilities.available !== false;
}

function modelSupportsReference(model: PublicImageModel): boolean {
  return model.capabilities.supportsReferenceInput === true
    || finiteNumber(model.capabilities.maxReferenceImages) > 0;
}

function modelResolutionOptions(model: PublicImageModel | null): string[] {
  if (!model) return [];
  const configured = stringArray(model.capabilities.resolutionOptions);
  const fallback = textValue(model.capabilities.defaultResolution);
  return configured.length ? configured : fallback ? [fallback] : [];
}

function modelLabel(model: PublicImageModel): string {
  const variant = model.variantLabel ? ` · ${model.variantLabel}` : "";
  return `${model.displayName}${variant} · 报价 ${model.publicPrice.toFixed(2)}`;
}

function createClientRequestId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`.slice(0, 120);
}

function displayValue(value: unknown, fallback = "未填写"): string {
  const text = textValue(value);
  if (text) return text;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function sourceFingerprint(value: unknown): string {
  const text = JSON.stringify(value) || "source";
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourceEntityKey(
  entityType: EditableEntityType,
  item: Record<string, JsonValue>,
  index: number,
): string {
  return `source-${entityType}-${index + 1}-${sourceFingerprint(item)}`;
}

function manualEntityKey(entityType: EditableEntityType): string {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `manual-${entityType}-${id}`.slice(0, 120);
}

function parseEntity(value: unknown): ShortDramaEntity | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string"
    || typeof value.projectId !== "string"
    || typeof value.entityType !== "string"
    || typeof value.entityKey !== "string"
    || typeof value.name !== "string"
    || typeof value.revision !== "number"
  ) return null;
  return value as unknown as ShortDramaEntity;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function apiFailure(payload: unknown, fallback: string): ApiFailure {
  const error = new Error(
    isRecord(payload) && typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : fallback,
  ) as ApiFailure;
  if (isRecord(payload) && typeof payload.code === "string") error.code = payload.code;
  return error;
}

function sourceName(item: Record<string, JsonValue>, fallback: string): string {
  return textValue(item.name)
    || textValue(item.characterName)
    || textValue(item.title)
    || fallback;
}

function sourceDescription(item: Record<string, JsonValue>): string {
  return textValue(item.description)
    || textValue(item.profile)
    || textValue(item.appearance)
    || "";
}

function entityAssetVersions(entity: Pick<ShortDramaEntity, "attributes" | "referenceAssetUri">): EntityAssetVersion[] {
  const stored = Array.isArray(entity.attributes.assetVersions)
    ? entity.attributes.assetVersions
    : [];
  const versions = stored.flatMap((value): EntityAssetVersion[] => {
    if (!isRecord(value) || typeof value.uri !== "string" || !value.uri.trim()) return [];
    return [{
      id: typeof value.id === "string" && value.id ? value.id : `legacy-${sourceFingerprint(value.uri)}`,
      uri: value.uri.trim(),
      label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : "素材版本",
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    }];
  });
  if (entity.referenceAssetUri && !versions.some((version) => version.uri === entity.referenceAssetUri)) {
    versions.unshift({
      id: `legacy-${sourceFingerprint(entity.referenceAssetUri)}`,
      uri: entity.referenceAssetUri,
      label: "旧版参考图",
      createdAt: "",
    });
  }
  return versions.slice(0, 50);
}

function storageKeyFromUri(uri: string): string {
  const prefix = "object://tencent_cos/";
  if (!uri.startsWith(prefix)) return "";
  try {
    return decodeURIComponent(uri.slice(prefix.length));
  } catch {
    return "";
  }
}

export function FilmStudioEntityPanel({
  projectId,
  token,
  entityType,
  sourceItems,
  onCountChange,
}: FilmStudioEntityPanelProps) {
  const config = CONFIG[entityType];
  const stepKey = entityType === "location" ? "scene" : entityType;
  const Icon = config.icon;
  const endpoint = `/api/short-drama/projects/${encodeURIComponent(projectId)}/entities`;
  const productionEndpoint = `/api/short-drama/projects/${encodeURIComponent(projectId)}/production`;
  const [entities, setEntities] = useState<ShortDramaEntity[]>([]);
  const [storageMode, setStorageMode] = useState<StorageMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [imageModels, setImageModels] = useState<PublicImageModel[]>([]);
  const [imageModelId, setImageModelId] = useState("");
  const [imageResolution, setImageResolution] = useState("");
  const [modelLoading, setModelLoading] = useState(true);
  const [generationPending, setGenerationPending] = useState<PendingEntityGeneration | null>(null);
  const [pendingEntityId, setPendingEntityId] = useState("");
  const [batchPending, setBatchPending] = useState(false);
  const [threeView, setThreeView] = useState(entityType !== "location");

  const loadEntities = useCallback(async (options?: { silent?: boolean; signal?: AbortSignal }) => {
    if (options?.silent) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(`${endpoint}?entityType=${encodeURIComponent(entityType)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: options?.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "实体档案读取失败");
      const list = isRecord(payload) && Array.isArray(payload.entities)
        ? payload.entities.map(parseEntity).filter((item): item is ShortDramaEntity => Boolean(item))
        : [];
      const mode = isRecord(payload) && (payload.storageMode === "native" || payload.storageMode === "compat")
        ? payload.storageMode
        : response.headers.get("X-Short-Drama-Storage-Mode");
      setEntities(list);
      setStorageMode(mode === "compat" ? "compat" : "native");
      setError(null);
    } catch (cause) {
      if (!options?.signal?.aborted) {
        setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "实体档案读取失败"));
      }
    } finally {
      if (!options?.signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [endpoint, entityType, token]);

  useEffect(() => {
    const controller = new AbortController();
    void loadEntities({ signal: controller.signal });
    return () => controller.abort();
  }, [loadEntities]);

  useEffect(() => {
    const controller = new AbortController();
    setModelLoading(true);
    void fetch("/api/cover-models?surface=film-studio", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "实体生图模型读取失败");
      const models = normalizeModels(payload);
      setImageModels(models);
      setImageModelId((current) => (
        models.some((model) => model.id === current && modelAvailable(model))
          ? current
          : models.find(modelAvailable)?.id || ""
      ));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "实体生图模型读取失败"));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setModelLoading(false);
    });
    return () => controller.abort();
  }, []);

  const selectedImageModel = useMemo(
    () => imageModels.find((model) => model.id === imageModelId) || null,
    [imageModelId, imageModels],
  );
  const imageResolutionOptions = useMemo(
    () => modelResolutionOptions(selectedImageModel),
    [selectedImageModel],
  );

  useEffect(() => {
    setImageResolution((current) => imageResolutionOptions.includes(current)
      ? current
      : imageResolutionOptions[0] || "");
  }, [imageResolutionOptions]);

  useEffect(() => {
    const uris = [...new Set(entities.flatMap((entity) => (
      entityAssetVersions(entity).map((version) => version.uri)
    )))];
    const unresolved = uris.filter((uri) => !previewUrls[uri]);
    if (unresolved.length === 0) return;
    let active = true;
    void Promise.all(unresolved.map(async (uri) => {
      if (/^https:\/\//iu.test(uri)) return [uri, uri] as const;
      const key = storageKeyFromUri(uri);
      if (!key) return [uri, ""] as const;
      const response = await fetch(`/api/file?key=${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await readJson(response);
      return [uri, response.ok && isRecord(payload) && typeof payload.url === "string" ? payload.url : ""] as const;
    })).then((resolved) => {
      if (!active) return;
      setPreviewUrls((current) => ({
        ...current,
        ...Object.fromEntries(resolved.filter((entry) => Boolean(entry[1]))),
      }));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [entities, previewUrls, token]);

  const sourceDrafts = useMemo(() => {
    const persistedKeys = new Set(entities.map((entity) => entity.entityKey));
    return sourceItems.map((item, index) => ({
      item,
      index,
      key: sourceEntityKey(entityType, item, index),
    })).filter((source) => !persistedKeys.has(source.key));
  }, [entities, entityType, sourceItems]);

  useEffect(() => {
    onCountChange?.(entities.length + sourceDrafts.length);
  }, [entities.length, onCountChange, sourceDrafts.length]);

  function openNew() {
    setNotice("");
    setEditor({
      mode: "create",
      entityId: null,
      expectedRevision: null,
      entityKey: manualEntityKey(entityType),
      name: "",
      description: "",
      attributes: {},
      referenceAssetUri: null,
      assetVersions: [],
    });
  }

  function openSource(item: Record<string, JsonValue>, index: number) {
    setNotice("");
    setEditor({
      mode: "create",
      entityId: null,
      expectedRevision: null,
      entityKey: sourceEntityKey(entityType, item, index),
      name: sourceName(item, `未命名${config.singular}`),
      description: sourceDescription(item),
      attributes: { ...item },
      referenceAssetUri: null,
      assetVersions: [],
    });
  }

  function openEdit(entity: ShortDramaEntity) {
    setNotice("");
    setEditor({
      mode: "edit",
      entityId: entity.id,
      expectedRevision: entity.revision,
      entityKey: entity.entityKey,
      name: entity.name,
      description: entity.description,
      attributes: { ...entity.attributes },
      referenceAssetUri: entity.referenceAssetUri,
      assetVersions: entityAssetVersions(entity),
    });
  }

  function updateAttribute(key: string, value: string) {
    setEditor((current) => current
      ? { ...current, attributes: { ...current.attributes, [key]: value } }
      : current);
  }

  async function uploadReferenceVersion(file: File | null) {
    if (!editor || !file || uploading || pending) return;
    if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
      setError(apiFailure({}, "参考图片大小必须在 10MB 以内"));
      return;
    }
    setUploading(true);
    setError(null);
    setNotice("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("category", "image");
      const response = await fetch("/api/video/reference-upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const payload = await readJson(response);
      const fileResult = isRecord(payload) && isRecord(payload.file) ? payload.file : {};
      const uri = typeof fileResult.asset_ref === "string" ? fileResult.asset_ref.trim() : "";
      const previewUrl = typeof fileResult.url === "string" ? fileResult.url.trim() : "";
      if (!response.ok || !uri || !previewUrl) throw apiFailure(payload, "参考图片上传失败");
      const version: EntityAssetVersion = {
        id: globalThis.crypto?.randomUUID?.() || `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        uri,
        label: file.name.slice(0, 160) || `版本 ${editor.assetVersions.length + 1}`,
        createdAt: new Date().toISOString(),
      };
      setPreviewUrls((current) => ({ ...current, [uri]: previewUrl }));
      setEditor((current) => current ? {
        ...current,
        referenceAssetUri: uri,
        assetVersions: [...current.assetVersions, version].slice(-50),
      } : current);
      setNotice("图片已上传为新版本；点击“保存档案”后才会切换当前版本。");
    } catch (cause) {
      setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "参考图片上传失败"));
    } finally {
      setUploading(false);
    }
  }

  function selectReferenceVersion(uri: string) {
    setEditor((current) => current ? { ...current, referenceAssetUri: uri } : current);
  }

  function removeReferenceVersion(id: string) {
    setEditor((current) => {
      if (!current) return current;
      const next = current.assetVersions.filter((version) => version.id !== id);
      const currentStillExists = next.some((version) => version.uri === current.referenceAssetUri);
      return {
        ...current,
        assetVersions: next,
        referenceAssetUri: currentStillExists ? current.referenceAssetUri : next.at(-1)?.uri || null,
      };
    });
  }

  async function saveEditor() {
    if (!editor || !editor.name.trim() || pending) return;
    setPending("save");
    setNotice("");
    try {
      const editing = editor.mode === "edit" && editor.entityId && editor.expectedRevision;
      const response = await fetch(
        editing ? `${endpoint}/${encodeURIComponent(editor.entityId || "")}` : endpoint,
        {
          method: editing ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...(editing ? { expectedRevision: editor.expectedRevision } : { entityType }),
            entityKey: editor.entityKey,
            name: editor.name.trim(),
            description: editor.description.trim(),
            attributes: {
              ...editor.attributes,
              assetVersions: editor.assetVersions as unknown as JsonValue,
            },
            referenceAssetUri: editor.referenceAssetUri,
          }),
        },
      );
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "实体档案保存失败");
      setEditor(null);
      setNotice(editing ? "实体档案已更新并完成写后读回校验。" : "实体档案已创建并完成写后读回校验。");
      await loadEntities({ silent: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "实体档案保存失败"));
    } finally {
      setPending(null);
    }
  }

  async function deleteEntity(entity: ShortDramaEntity) {
    if (pending || !window.confirm(`确认移除${config.singular}“${entity.name}”？兼容层会保留软删除记录。`)) return;
    setPending("delete");
    setNotice("");
    try {
      const response = await fetch(
        `${endpoint}/${encodeURIComponent(entity.id)}?expectedRevision=${entity.revision}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "实体档案移除失败");
      setNotice("实体档案已移除，并保留恢复记录。");
      await loadEntities({ silent: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "实体档案移除失败"));
    } finally {
      setPending(null);
    }
  }

  async function submitEntityGeneration(
    entity: ShortDramaEntity,
    mode: "generate" | "repaint",
    existingRequest?: PendingEntityGeneration,
    skipConfirmation = false,
  ): Promise<"completed" | "unresolved" | "failed"> {
    const model = existingRequest
      ? imageModels.find((candidate) => candidate.id === existingRequest.modelId) || null
      : selectedImageModel;
    const resolution = existingRequest?.resolution || imageResolution;
    if (storageMode !== "native") {
      setError(apiFailure({ code: "PRODUCTION_MIGRATION_NOT_READY", error: "实体图片生成服务正在准备中，本次未提交生成或产生费用。" }, "实体生图不可用"));
      return "failed";
    }
    if (!model || !modelAvailable(model) || !resolution) {
      setError(apiFailure({ code: "ENTITY_IMAGE_MODEL_UNAVAILABLE", error: "请选择当前可用的生图模型与分辨率。" }, "实体生图模型不可用"));
      return "failed";
    }
    if (mode === "repaint" && (!entity.referenceAssetUri || !modelSupportsReference(model))) {
      setError(apiFailure({
        code: "ENTITY_REPAINT_NOT_READY",
        error: entity.referenceAssetUri
          ? "当前模型不支持参考图输入，请选择支持参考图的生图模型。"
          : "参考重绘前请先为实体保存一个当前图片版本。",
      }, "参考重绘不可用"));
      return "failed";
    }
    const request: PendingEntityGeneration = existingRequest || {
      entityId: entity.id,
      entityName: entity.name,
      expectedEntityRevision: entity.revision,
      mode,
      layout: entityType !== "location" && threeView ? "three_view" : "single",
      clientRequestId: createClientRequestId(`entity-${entity.id.slice(0, 8)}`),
      modelId: model.id,
      resolution,
      jobId: "",
    };
    if (!existingRequest && !skipConfirmation) {
      const approved = window.confirm(
        `${mode === "repaint" ? "参考当前版本重绘" : "首次生成"}${config.singular}“${entity.name}”？\n${model.displayName} · ${resolution} · ${request.layout === "three_view" ? "三视图" : "单视图"}\n单次公开报价 ${model.publicPrice.toFixed(2)}\n提交后会写入任务历史、稳定资产和实际结算记录。`,
      );
      if (!approved) return "failed";
    }

    setPendingEntityId(entity.id);
    setError(null);
    setNotice("");
    let receivedResponse = false;
    try {
      const response = await fetch(productionEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": request.clientRequestId,
        },
        body: JSON.stringify({
          action: "generate_entity_image",
          entityId: request.entityId,
          expectedEntityRevision: request.expectedEntityRevision,
          clientRequestId: request.clientRequestId,
          modelId: request.modelId,
          resolution: request.resolution,
          mode: request.mode,
          layout: request.layout,
        }),
      });
      receivedResponse = true;
      const payload = await readJson(response);
      if (!response.ok) {
        setGenerationPending(null);
        throw apiFailure(payload, "实体图片生成失败");
      }
      const job = isRecord(payload) && isRecord(payload.job) ? payload.job : {};
      const jobId = textValue(job.publicJobId) || textValue(job.id);
      const state = textValue(job.state);
      if (response.status === 202 || !["succeeded", "failed", "cancelled"].includes(state)) {
        setGenerationPending({ ...request, jobId });
        setNotice(`“${entity.name}”的原请求已登记。状态未明确前不会自动重提；可点击“核对原请求”。`);
        return "unresolved";
      }
      if (state !== "succeeded") {
        setGenerationPending(null);
        throw apiFailure(payload, `实体图片任务${state === "failed" ? "失败" : "已终止"}`);
      }
      setGenerationPending(null);
      setNotice(`“${entity.name}”图片已生成、归档并切换为当前版本。`);
      await loadEntities({ silent: true });
      return "completed";
    } catch (cause) {
      if (!receivedResponse) {
        setGenerationPending(request);
        const unknown = apiFailure({
          code: "ENTITY_IMAGE_STATUS_UNKNOWN",
          error: "网络在提交后中断，是否扣费尚不明确。系统不会自动重提；请使用“核对原请求”。",
        }, "实体图片请求状态未知");
        setError(unknown);
        return "unresolved";
      }
      setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "实体图片生成失败"));
      return "failed";
    } finally {
      setPendingEntityId("");
    }
  }

  async function reconcilePendingGeneration() {
    const request = generationPending;
    if (!request || pendingEntityId) return;
    const entity = entities.find((candidate) => candidate.id === request.entityId);
    if (!entity) {
      setError(apiFailure({ code: "ENTITY_NOT_FOUND", error: "原请求对应的实体已经不存在，无法核对。" }, "实体不存在"));
      return;
    }
    if (!request.jobId) {
      await submitEntityGeneration(entity, request.mode, request);
      return;
    }
    setPendingEntityId(entity.id);
    setError(null);
    try {
      const response = await fetch(productionEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "poll_job", jobId: request.jobId }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "原实体图片任务核对失败");
      const job = isRecord(payload) && isRecord(payload.job) ? payload.job : {};
      const state = textValue(job.state);
      if (state === "succeeded") {
        setGenerationPending(null);
        setNotice(`“${request.entityName}”的原请求已完成并恢复到图片版本。`);
        await loadEntities({ silent: true });
      } else if (state === "failed" || state === "cancelled") {
        setGenerationPending(null);
        setError(apiFailure({
          code: textValue(job.errorCode, "ENTITY_IMAGE_JOB_FAILED"),
          error: textValue(job.errorMessage, `原任务${state === "failed" ? "失败" : "已取消"}，可重新发起一次新请求。`),
        }, "原实体图片任务失败"));
      } else {
        setGenerationPending({ ...request, jobId: textValue(job.publicJobId) || request.jobId });
        setNotice(`原请求仍处于“${state || "处理中"}”，未重复调用模型。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "原实体图片任务核对失败"));
    } finally {
      setPendingEntityId("");
    }
  }

  async function batchGenerateMissingImages() {
    const missing = entities.filter((entity) => entityAssetVersions(entity).length === 0);
    if (
      batchPending
      || generationPending
      || storageMode !== "native"
      || !selectedImageModel
      || !imageResolution
      || missing.length === 0
    ) return;
    const approved = window.confirm(
      `为 ${missing.length} 个尚无图片的${config.singular}依次生成首图？\n${selectedImageModel.displayName} · ${imageResolution} · ${entityType !== "location" && threeView ? "三视图" : "单视图"}\n按当前公开报价预计上限 ${(selectedImageModel.publicPrice * missing.length).toFixed(2)}\n系统按顺序提交；任一任务状态不明确会立即停止后续提交。`,
    );
    if (!approved) return;
    setBatchPending(true);
    let completed = 0;
    try {
      for (const entity of missing) {
        const result = await submitEntityGeneration(entity, "generate", undefined, true);
        if (result !== "completed") {
          setNotice((current) => `${current ? `${current} ` : ""}批量任务已停止：${completed}/${missing.length} 个完成，未继续提交后续付费请求。`);
          return;
        }
        completed += 1;
      }
      setNotice(`批量首图完成：${completed}/${missing.length} 个实体均已生成、归档并写入结算记录。`);
    } finally {
      setBatchPending(false);
    }
  }

  if (loading) {
    return (
      <section className={styles.panel} data-testid={`film-project-${stepKey}-step`}>
        <div className={styles.loading}><LoaderCircle size={24} />正在读取真实实体档案…</div>
      </section>
    );
  }

  return (
    <section className={styles.panel} data-testid={`film-project-${stepKey}-step`}>
      <div className={styles.header}>
        <div>
          <span className={styles.eyebrow}>{config.sourceLabel} · 档案管理</span>
          <h2><Icon size={22} />{config.title}</h2>
          <p>剧本来源项会明确标记；保存后进入账号隔离、可修订的实体档案。</p>
        </div>
        <div className={styles.actions}>
          <span className={styles.modeBadge} data-mode={storageMode || "unknown"}>
            {storageMode === "compat" ? "档案可保存" : "制作服务可用"}
          </span>
          <button type="button" onClick={openNew}><Plus size={16} />新建{config.singular}</button>
          <button
            type="button"
            aria-label="刷新实体档案"
            disabled={refreshing}
            onClick={() => void loadEntities({ silent: true })}
          >
            <RefreshCw className={refreshing ? styles.spinning : undefined} size={16} />
          </button>
        </div>
      </div>

      {storageMode === "compat" && (
        <div className={styles.compatNotice} data-storage-mode="compat">
          <AlertTriangle size={18} />
          <span>
            当前可以编辑和保存角色、场景与道具档案；图片生成服务正在准备中，暂不会提交生成或产生费用。
          </span>
        </div>
      )}

      {error && (
        <div className={styles.error} role="alert" data-code={error.code || "UNKNOWN"}>
          <AlertTriangle size={18} />
          <span>{error.message}</span>
          <button type="button" onClick={() => setError(null)}>关闭</button>
        </div>
      )}
      {notice && <div className={styles.notice}>{notice}</div>}

      <div className={styles.generationBar} data-testid="film-entity-image-model-bar">
        <div>
          <strong><Sparkles size={16} />实体图片模型</strong>
          <span>每次提交前显示模型、规格与公开报价；生成完成后自动保存到当前项目。</span>
          {entityType !== "location" && (
            <label className={styles.threeViewToggle}>
              <input
                type="checkbox"
                checked={threeView}
                disabled={Boolean(pendingEntityId) || batchPending || generationPending !== null}
                onChange={(event) => setThreeView(event.target.checked)}
              />
              三视图设定稿（正面 / 侧面 / 背面）
            </label>
          )}
        </div>
        <label>
          <span>生图模型</span>
          <select
            aria-label="实体生图模型"
            disabled={modelLoading || Boolean(pendingEntityId)}
            value={imageModelId}
            onChange={(event) => setImageModelId(event.target.value)}
          >
            <option value="">{modelLoading ? "正在加载模型…" : "暂无可用生图模型"}</option>
            {imageModels.map((model) => (
              <option disabled={!modelAvailable(model)} key={model.id} value={model.id}>
                {modelLabel(model)}{modelAvailable(model) ? "" : " · 已暂停"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>图片规格</span>
          <select
            aria-label="实体图片分辨率"
            disabled={!imageResolutionOptions.length || Boolean(pendingEntityId)}
            value={imageResolution}
            onChange={(event) => setImageResolution(event.target.value)}
          >
            {!imageResolutionOptions.length && <option value="">模型默认规格</option>}
            {imageResolutionOptions.map((resolution) => <option key={resolution}>{resolution}</option>)}
          </select>
        </label>
        <span className={styles.quoteBadge}>
          {selectedImageModel
            ? `单次公开报价 ${selectedImageModel.publicPrice.toFixed(2)}`
            : "报价待模型就绪"}
        </span>
        <button
          className={styles.batchButton}
          type="button"
          disabled={
            batchPending
            || storageMode !== "native"
            || !selectedImageModel
            || !imageResolution
            || Boolean(pendingEntityId)
            || generationPending !== null
            || entities.every((entity) => entityAssetVersions(entity).length > 0)
          }
          onClick={() => void batchGenerateMissingImages()}
        >
          {batchPending ? <LoaderCircle className={styles.spinning} size={15} /> : <Sparkles size={15} />}
          {batchPending ? "批量生成中…" : "批量补齐首图"}
        </button>
      </div>

      {generationPending && (
        <div className={styles.pendingGeneration} data-testid="film-entity-generation-unresolved">
          <AlertTriangle size={18} />
          <div>
            <strong>原请求待核对：{generationPending.entityName}</strong>
            <span>{generationPending.clientRequestId}{generationPending.jobId ? ` · ${generationPending.jobId}` : ""}</span>
          </div>
          <button
            type="button"
            disabled={Boolean(pendingEntityId)}
            onClick={() => void reconcilePendingGeneration()}
          >
            {pendingEntityId ? <LoaderCircle className={styles.spinning} size={15} /> : <RefreshCw size={15} />}
            核对原请求
          </button>
        </div>
      )}

      {editor && (
        <div className={styles.editor} data-editor-mode={editor.mode}>
          <div className={styles.editorHeader}>
            <div>
              <span>{editor.mode === "edit" ? `版本 ${editor.expectedRevision}` : "新档案"}</span>
              <h3>{editor.mode === "edit" ? `编辑${config.singular}` : `创建${config.singular}`}</h3>
            </div>
            <button type="button" aria-label="关闭编辑器" onClick={() => setEditor(null)}><X size={17} /></button>
          </div>
          <div className={styles.formGrid}>
            <label className={styles.wide}>
              <span>名称 *</span>
              <input
                maxLength={160}
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </label>
            <label className={styles.wide}>
              <span>核心说明</span>
              <textarea
                maxLength={10_000}
                value={editor.description}
                onChange={(event) => setEditor({ ...editor, description: event.target.value })}
              />
            </label>
            {config.fields.map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <textarea
                  value={displayValue(editor.attributes[key], "")}
                  onChange={(event) => updateAttribute(key, event.target.value)}
                />
              </label>
            ))}
          </div>
          <div className={styles.versionEditor} data-testid="film-entity-image-versions">
            <div className={styles.versionHeader}>
              <div>
                <strong>图片版本</strong>
                <span>支持本地上传、保留多个版本并选择当前参考图；稳定对象地址写入实体档案。</span>
              </div>
              <label className={styles.uploadButton}>
                {uploading ? <LoaderCircle className={styles.spinning} size={16} /> : <Upload size={16} />}
                {uploading ? "上传中…" : "上传新版本"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={uploading || pending !== null}
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    event.target.value = "";
                    void uploadReferenceVersion(file);
                  }}
                />
              </label>
            </div>
            <div className={styles.versionGrid}>
              {editor.assetVersions.map((version, index) => (
                <div
                  className={styles.versionItem}
                  data-selected={editor.referenceAssetUri === version.uri ? "true" : undefined}
                  key={version.id}
                >
                  <button type="button" onClick={() => selectReferenceVersion(version.uri)}>
                    {previewUrls[version.uri]
                      ? <img src={previewUrls[version.uri]} alt={`${config.singular}图片版本 ${index + 1}`} />
                      : <ImageIcon size={22} />}
                    <span>版本 {String(index + 1).padStart(2, "0")}</span>
                  </button>
                  <button type="button" aria-label={`移除图片版本 ${index + 1}`} onClick={() => removeReferenceVersion(version.id)}>
                    <X size={13} />
                  </button>
                </div>
              ))}
              {editor.assetVersions.length === 0 && (
                <span className={styles.versionEmpty}>尚未上传图片版本。</span>
              )}
            </div>
          </div>
          <div className={styles.editorFooter}>
            <code>{editor.entityKey}</code>
            <button type="button" disabled={!editor.name.trim() || pending !== null} onClick={() => void saveEditor()}>
              {pending === "save" ? <LoaderCircle className={styles.spinning} size={16} /> : <Save size={16} />}
              保存档案
            </button>
          </div>
        </div>
      )}

      <div className={styles.grid}>
        {entities.map((entity) => (
          <article className={styles.card} key={entity.id} data-source="persisted">
            {entity.referenceAssetUri && previewUrls[entity.referenceAssetUri] && (
              <img
                className={styles.cardPreview}
                src={previewUrls[entity.referenceAssetUri]}
                alt={`${entity.name} 当前参考图`}
              />
            )}
            <div className={styles.cardHeading}>
              <span><Icon size={18} /></span>
              <div><small>已保存 · 版本 {entity.revision}</small><h3>{entity.name}</h3></div>
            </div>
            <p>{entity.description || "未填写核心说明"}</p>
            <dl>
              {config.fields.map(([key, label]) => (
                <div key={key}><dt>{label}</dt><dd>{displayValue(entity.attributes[key])}</dd></div>
              ))}
            </dl>
            <span className={styles.versionCount}>
              {entityAssetVersions(entity).length > 0
                ? `${entityAssetVersions(entity).length} 个图片版本`
                : "暂无图片版本"}
            </span>
            <div className={styles.cardActions}>
              <button
                type="button"
                disabled={
                  storageMode !== "native"
                  || !selectedImageModel
                  || !imageResolution
                  || Boolean(pendingEntityId)
                  || batchPending
                  || generationPending !== null
                }
                onClick={() => void submitEntityGeneration(entity, "generate")}
              >
                {pendingEntityId === entity.id ? <LoaderCircle className={styles.spinning} size={15} /> : <Sparkles size={15} />}
                {entityAssetVersions(entity).length ? "AI 新版本" : "AI 首次生成"}
              </button>
              <button
                type="button"
                disabled={
                  storageMode !== "native"
                  || !entity.referenceAssetUri
                  || !selectedImageModel
                  || !modelSupportsReference(selectedImageModel)
                  || !imageResolution
                  || Boolean(pendingEntityId)
                  || batchPending
                  || generationPending !== null
                }
                title={!entity.referenceAssetUri
                  ? "请先保存一个当前图片版本"
                  : selectedImageModel && !modelSupportsReference(selectedImageModel)
                    ? "当前模型不支持参考图"
                    : "按当前图片版本参考重绘"}
                onClick={() => void submitEntityGeneration(entity, "repaint")}
              >
                <RefreshCw size={15} />参考重绘
              </button>
              <button type="button" onClick={() => openEdit(entity)}><Pencil size={15} />编辑</button>
              <button type="button" disabled={pending !== null} onClick={() => void deleteEntity(entity)}><Trash2 size={15} />移除</button>
            </div>
          </article>
        ))}

        {sourceDrafts.map(({ item, index, key }) => (
          <article className={styles.card} key={key} data-source="script">
            <div className={styles.cardHeading}>
              <span><Icon size={18} /></span>
              <div><small>剧本来源 · 尚未独立持久化</small><h3>{sourceName(item, `未命名${config.singular}`)}</h3></div>
            </div>
            <p>{sourceDescription(item) || "未填写核心说明"}</p>
            <dl>
              {config.fields.map(([field, label]) => (
                <div key={field}><dt>{label}</dt><dd>{displayValue(item[field])}</dd></div>
              ))}
            </dl>
            <div className={styles.cardActions}>
              <button type="button" onClick={() => openSource(item, index)}><Save size={15} />保存为独立档案</button>
            </div>
          </article>
        ))}
      </div>

      {entities.length === 0 && sourceDrafts.length === 0 && (
        <div className={styles.empty}>
          <Icon size={28} />
          <strong>暂无{config.singular}数据</strong>
          <span>页面不会补造演示档案；可手动新建并真实保存。</span>
        </div>
      )}
    </section>
  );
}
