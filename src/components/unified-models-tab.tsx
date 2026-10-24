"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import UnifiedModelDialog from "./unified-model-dialog";
import AdminVideoValidationDialog from "./admin-video-validation-dialog";
import AdminImageValidationDialog from "./admin-image-validation-dialog";
import PlatformConfigurationReleasePanel from "./admin/PlatformConfigurationReleasePanel";
import { modelConnectionSummary, formatModelPrice } from "@/lib/model-connection-summary";
import { getVideoBillingUnit } from "@/lib/video-model-capabilities";
import { normalizeDisplayText } from "@/lib/display-normalization";

// ── 模型类型定义 ──
type ModelType = "drawing" | "text" | "video" | "extract";

// ── 插件项定义（用于插件选择器） ──
interface PluginItem {
  id: string;
  name: string;
  type: string;
  subtype: string;
  role: string;
  description: string;
  is_active: boolean;
  price_per_use: number;
  cost_price: number;
  price_unit: string;
}

interface UnifiedModel {
  validation?: {
    passed: boolean;
    fingerprint_current: boolean;
    validated_at?: string | null;
    latency_ms?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    reason?: string;
  };
  id: string;
  model_name: string;
  name?: string;
  model_type: ModelType;
  display_name?: string;
  icon_url?: string;
  description?: string;
  is_active: boolean;
  is_hidden?: boolean;
  sort_order: number;
  // 计费
  billing_mode?: string;
  token_billing_enabled?: boolean;
  cost_per_use?: number;
  cost_price?: number;
  selling_price?: number;
  price_per_use?: number;
  currency?: string;
  // 模型配置
  api_endpoint?: string;
  endpoint?: string;
  api_key?: string;
  api_key_configured?: boolean;
  provider?: string;
  model_id?: string;
  protocol?: string;
  max_context_tokens?: number;
  max_reply_tokens?: number;
  timeout?: number;
  updated_at?: string;
  frequency_limit?: number;
  // 对话模型专属
  deep_thinking_type?: number;
  enable_web_search?: boolean;
  proxy_url?: string;
  temperature?: number;
  category?: string;
  user_access?: string;
  deduct_deep_think?: number;
  max_context_rounds?: number;
  response_format?: string;
  token_rounding_unit?: number;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  cached_cost_per_million?: number;
  profit_margin?: number;
  admin_notes?: string;
  // 统计
  usage_count?: number;
  total_tokens_used?: number;
  // 绘图模型专属
  default_size?: string;
  supported_sizes?: string[];
  // 视频模型专属
  default_duration?: number;
  max_duration?: number;
  api_protocol_config?: Record<string, unknown>;
  // 通道/健康
  channel_name?: string;
  channel_id?: string;
  agent_id?: string;
  protocol_type?: string;
  system_prompt?: string;
  image_parsing?: string;
  file_parsing?: string;
}

interface VideoChannelHealthView {
  channelId: string;
  isHealthy: boolean;
  healthRecorded: boolean;
  totalRequests: number;
  successRate: number;
  circuitState: "healthy" | "open" | "canary_ready" | "unverified";
  productionBlocked: boolean;
  consecutiveFailures: number;
  lastFailAt: string | null;
  lastError: string;
  lastErrorCode: string;
  updatedAt: string | null;
  recoveryEligibleAt: string | null;
  recoveryCanaryEligible: boolean;
  recoveryKey: string | null;
}

interface CredentialHealthItem {
  credentialId: string;
  modelId: string;
  modelName: string;
  kind: "image" | "text" | "video";
  purpose: string;
  provider: string;
  configured: boolean;
  storageMode: "isolated_binding" | "server_reference" | "legacy_restricted" | "missing";
  storageLabel: string;
  bindingUpdatedAt: string | null;
  active: boolean;
  validationStatus: "verified" | "pending" | "needs_attention" | "unverified" | "not_recorded";
  lastValidatedAt: string | null;
  validationExplanation: string;
}

interface CredentialHealthPayload {
  generatedAt: string;
  policy: {
    plaintextCredentialReturned: false;
    resolvedCredentialReturned: false;
    credentialSuffixReturned: false;
    editFieldsAreWriteOnly: true;
    configurationIdDerivedFromSecret: false;
    validationAndConfigurationSeparated: true;
  };
  summary: { total: number; configured: number; isolated: number; legacyReview: number; missing: number; verified: number };
  credentials: CredentialHealthItem[];
}

const MODEL_TYPE_CONFIG: Record<ModelType, { label: string; icon: string; color: string; bgColor: string; borderColor: string }> = {
  drawing: { label: "绘图模型", icon: "🎨", color: "text-purple-600", bgColor: "bg-purple-500/10", borderColor: "border-purple-500/20" },
  text: { label: "对话模型", icon: "💬", color: "text-blue-600", bgColor: "bg-blue-500/10", borderColor: "border-blue-500/20" },
  video: { label: "视频模型", icon: "🎬", color: "text-orange-600", bgColor: "bg-orange-500/10", borderColor: "border-orange-500/20" },
  extract: { label: "文案提取", icon: "📦", color: "text-teal-600", bgColor: "bg-teal-500/10", borderColor: "border-teal-500/20" },
};

interface Props {
  token: string | null;
  onModelsChange?: () => void;
  /** 允许新增、编辑、删除、排序、测试、真实生成验证和发布模型配置。 */
  canManageModels?: boolean;
  /** 允许读取和管理插件名称、价格、激活状态及插件配置。 */
  canManagePlugins?: boolean;
  /** 允许读取和保存文案提取等平台计费规则。 */
  canManagePaymentSettings?: boolean;
}

function toReadOnlyModel(model: UnifiedModel): UnifiedModel {
  return {
    id: String(model.id),
    model_name: "",
    name: model.name || model.display_name || "未命名模型",
    model_type: model.model_type,
    display_name: model.display_name,
    icon_url: model.icon_url,
    description: model.description,
    is_active: model.is_active,
    is_hidden: model.is_hidden,
    sort_order: model.sort_order,
    billing_mode: model.billing_mode,
    token_billing_enabled: model.token_billing_enabled,
    selling_price: model.selling_price,
    price_per_use: model.price_per_use,
    currency: model.currency,
    category: model.category,
    user_access: model.user_access,
    default_size: model.default_size,
    supported_sizes: model.supported_sizes,
    default_duration: model.default_duration,
    max_duration: model.max_duration,
  };
}

function withoutModelSecret(model: UnifiedModel): UnifiedModel {
  const next = { ...model };
  delete next.api_key;
  return next;
}

function isOperationalActive(model: UnifiedModel): boolean {
  return model.is_active !== false && (model.model_type !== "text" || model.user_access === "available");
}

export default function UnifiedModelsTab({
  token,
  onModelsChange,
  canManageModels = false,
  canManagePlugins = false,
  canManagePaymentSettings = false,
}: Props) {
  // ── 状态 ──
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState<ModelType>("video");
  const [showDialog, setShowDialog] = useState(false);
  const [editingModel, setEditingModel] = useState<UnifiedModel | null>(null);
  const [dialogModelType, setDialogModelType] = useState<ModelType>("video");
  const [searchQuery, setSearchQuery] = useState("");
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [validatingVideo, setValidatingVideo] = useState<UnifiedModel | null>(null);
  const [validatingImage, setValidatingImage] = useState<UnifiedModel | null>(null);
  const [videoChannelHealth, setVideoChannelHealth] = useState<Record<string, VideoChannelHealthView>>({});
  const [videoHealthError, setVideoHealthError] = useState("");
  const [credentialHealth, setCredentialHealth] = useState<CredentialHealthPayload | null>(null);
  const [credentialHealthError, setCredentialHealthError] = useState("");
  const [showCredentialDetails, setShowCredentialDetails] = useState(false);
  const [modelPoolReleaseRefreshKey, setModelPoolReleaseRefreshKey] = useState(0);
  const [focusReleaseId, setFocusReleaseId] = useState<string | null>(null);
  const [textActions, setTextActions] = useState<Record<string, { busy?: "validate" | "activate"; message?: string; failed?: boolean }>>({});
  const textActionLocks = useRef(new Set<string>());
  const textConfigurationSnapshots = useRef(new Map<string, string>());
  const [quickAddText, setQuickAddText] = useState("");
  const [quickAddCredential, setQuickAddCredential] = useState("");
  const [quickAddBusy, setQuickAddBusy] = useState(false);
  const [quickAddMsg, setQuickAddMsg] = useState("");
  const [extractPrice, setExtractPrice] = useState<string>("");
  const [extractPriceSaving, setExtractPriceSaving] = useState(false);
  // 插件选择器状态
  const [singleTextPlugins, setSingleTextPlugins] = useState<PluginItem[]>([]);
  const [batchTextPlugins, setBatchTextPlugins] = useState<PluginItem[]>([]);
  const [videoPlugins, setVideoPlugins] = useState<PluginItem[]>([]);
  const [coverPlugins, setCoverPlugins] = useState<PluginItem[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginSaving, setPluginSaving] = useState<string | null>(null); // "shared" | "cover"
  // 本地选择状态（选择后需点击保存才生效）
  const [selectedSingleTextPluginId, setSelectedSingleTextPluginId] = useState<string>("");

  // ── 拖拽排序状态 ──
  const [draggedModelId, setDraggedModelId] = useState<string | null>(null);
  const [dragOverModelId, setDragOverModelId] = useState<string | null>(null);
  // 排序先留在页面草稿中；只有显式保存并完成候选校验、预览和发布后才算持久化。
  const [pendingOrderType, setPendingOrderType] = useState<ModelType | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Array<{ id: string; sort_order: number }>>([]);
  const [orderSaveState, setOrderSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "failed">("idle");
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after">("before");

  const authHeaders = useMemo<Record<string, string>>(
    () => token ? { Authorization: `Bearer ${token}` } : {} as Record<string, string>,
    [token],
  );

  // ── 加载模型列表 ──
  const loadModels = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setVideoHealthError("");
    setCredentialHealthError("");
    if (!canManageModels) {
      setVideoChannelHealth({});
      setCredentialHealth(null);
      setShowCredentialDetails(false);
    }
    try {
      const [res, healthRes, credentialRes] = await Promise.all([
        fetch("/api/admin/models", { headers: authHeaders }),
        canManageModels ? fetch("/api/video/channel-health", { headers: authHeaders }) : Promise.resolve(null),
        canManageModels ? fetch("/api/admin/credential-health", { headers: authHeaders }) : Promise.resolve(null),
      ]);
      if (res.ok) {
        const data = await res.json();
        const nextModels = ((data.models || []) as UnifiedModel[]).map(withoutModelSecret);
        setModels(canManageModels ? nextModels : nextModels.map(toReadOnlyModel));
      }
      if (healthRes?.ok) {
        const data = await healthRes.json();
        const healthMap: Record<string, VideoChannelHealthView> = {};
        for (const channel of (data.channels || []) as VideoChannelHealthView[]) {
          if (channel.channelId) healthMap[channel.channelId] = channel;
        }
        setVideoChannelHealth(healthMap);
      } else if (healthRes) {
        const data = await healthRes.json().catch(() => ({}));
        setVideoHealthError(data.error || "通道健康状态读取失败");
      }
      if (credentialRes?.ok) {
        setCredentialHealth(await credentialRes.json());
        setCredentialHealthError("");
      } else if (credentialRes) {
        const data = await credentialRes.json().catch(() => ({}));
        setCredentialHealth(null);
        setCredentialHealthError(data.error || "凭据安全状态读取失败");
      }
    } catch (error) {
      if (canManageModels) {
        setVideoHealthError(error instanceof Error ? error.message : "通道健康状态读取失败");
        setCredentialHealthError(error instanceof Error ? error.message : "凭据安全状态读取失败");
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, canManageModels]);

  useEffect(() => { loadModels(); }, [loadModels]);

  useEffect(() => {
    const changed = new Set<string>();
    const next = new Map<string, string>();
    for (const model of models.filter(item => item.model_type === "text")) {
      const snapshot = JSON.stringify([model.updated_at, model.model_name, model.api_endpoint, model.provider, model.protocol_type, model.api_protocol_config, model.max_reply_tokens, model.max_context_tokens, model.timeout]);
      const previous = textConfigurationSnapshots.current.get(model.id);
      if (previous && previous !== snapshot) changed.add(model.id);
      next.set(model.id, snapshot);
    }
    textConfigurationSnapshots.current = next;
    if (changed.size) setTextActions(prev => Object.fromEntries(Object.entries(prev).filter(([id, state]) => !changed.has(id) || state.busy)));
  }, [models]);

  useEffect(() => {
    if (canManageModels) return;
    setShowDialog(false);
    setEditingModel(null);
    setValidatingVideo(null);
    setValidatingImage(null);
    setQuickAddCredential("");
    setQuickAddText("");
    setQuickAddMsg("");
    setDraggedModelId(null);
    setDragOverModelId(null);
    setPendingOrderType(null);
    setPendingOrders([]);
    setOrderSaveState("idle");
  }, [canManageModels]);

  // ── 加载插件（三合一提取 + 封面） ──
  // 视频、单条文案、批量与搜索共用 active coze_multifunction_extract。
  // 仅统一配置区负责激活；其余能力只展示同一运行状态，避免角色漂移。
  const loadPlugins = useCallback(async () => {
    if (!token || !canManagePlugins) {
      setSingleTextPlugins([]);
      setBatchTextPlugins([]);
      setVideoPlugins([]);
      setCoverPlugins([]);
      setSelectedSingleTextPluginId("");
      return;
    }
    setPluginsLoading(true);
    try {
      const [sharedExtractRes, coverRes] = await Promise.all([
        fetch("/api/admin/plugins?role=coze_multifunction_extract", { headers: authHeaders }),
        fetch("/api/admin/plugins?role=cover_workflow", { headers: authHeaders }),
      ]);
      if (sharedExtractRes.ok) {
        const data = await sharedExtractRes.json();
        const plugins = (data.plugins || []) as PluginItem[];
        setSingleTextPlugins(plugins);
        setBatchTextPlugins(plugins);
        setVideoPlugins(plugins);
        // 同步本地选择状态为当前生效的插件
        const activePlugin = plugins.find(p => p.is_active);
        setSelectedSingleTextPluginId(activePlugin?.id || plugins[0]?.id || "");
      }
      if (coverRes.ok) {
        const data = await coverRes.json();
        setCoverPlugins((data.plugins || []) as PluginItem[]);
      }
    } catch { /* ignore */ }
    finally { setPluginsLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, canManagePlugins]);

  useEffect(() => { loadPlugins(); }, [loadPlugins]);

  // ── 保存插件切换（带role，确保互斥逻辑正确） ──
  const handleSavePlugin = async (pluginId: string, role: string, savingKey: string) => {
    if (!token || !canManagePlugins) return;
    setPluginSaving(savingKey);
    try {
      const res = await fetch("/api/admin/plugins", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ id: pluginId, is_active: true, role }),
      });
      if (res.ok) {
        await loadPlugins();
      } else {
        const data = await res.json();
        alert(data.error || "保存失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setPluginSaving(null);
    }
  };

  // ── 加载文案提取单价 ──
  useEffect(() => {
    if (!token || !canManagePlugins || !canManagePaymentSettings) {
      setExtractPrice("");
      return;
    }
    const loadExtractPrice = async () => {
      try {
        const res = await fetch("/api/settings/admin?scope=payment", { headers: authHeaders });
        if (res.ok) {
          const data = await res.json();
          setExtractPrice(String(data.settings?.extract_price_per_use ?? "0.02"));
        }
      } catch { /* ignore */ }
    };
    loadExtractPrice();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, canManagePaymentSettings, canManagePlugins]);

  // ── 按类型筛选 + 排序 ──
  const filteredModels = models
    .filter((m) => {
      const mt = String(m.model_type || "");
      if (mt !== activeType) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const endpoint = canManageModels ? String(m.api_endpoint || "") : "";
        const connection = canManageModels ? modelConnectionSummary(endpoint, m.api_protocol_config) : null;
        const haystack = (canManageModels
          ? [m.name, m.model_name, m.provider, endpoint, connection?.label, connection?.provider, connection?.host, connection?.group]
          : [m.name, m.display_name, m.description, m.category])
          .map((value) => String(value || "").toLowerCase())
          .join(" ");
        return haystack.includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      return (a.sort_order || 0) - (b.sort_order || 0)
        || String(a.id).localeCompare(String(b.id));
    });

  // ── extract 类型无模型列表，单独处理 ──
  const isExtractTab = canManagePlugins && activeType === "extract";
  const visibleModelTypes = (Object.keys(MODEL_TYPE_CONFIG) as ModelType[])
    .filter((type) => type !== "extract" || canManagePlugins);

  useEffect(() => {
    if (!canManagePlugins && activeType === "extract") setActiveType("video");
  }, [activeType, canManagePlugins]);

  // ── 按类型计数 ──
  const typeCounts: Record<string, number> = {};
  models.forEach((m) => {
    const mt = String(m.model_type || "unknown");
    typeCounts[mt] = (typeCounts[mt] || 0) + 1;
  });
  // extract 类型显示 "1"（代表有配置）
  if (canManagePlugins) typeCounts.extract = 1;

  const videoHealthSummary = useMemo(() => {
    const activeVideoModels = models.filter((model) => model.model_type === "video" && model.is_active !== false);
    const states = activeVideoModels.map((model) => videoChannelHealth[String(model.id)]);
    return {
      active: activeVideoModels.length,
      ready: states.filter((state) => state?.healthRecorded && !state.productionBlocked && state.circuitState === "healthy").length,
      blocked: states.filter((state) => state?.productionBlocked).length,
      unverified: states.filter((state) => !state?.healthRecorded || state.circuitState === "unverified").length,
    };
  }, [models, videoChannelHealth]);

  // ── 添加模型 ──
  const handleAdd = (type: ModelType) => {
    if (!canManageModels) return;
    setEditingModel(null);
    setDialogModelType(type);
    setShowDialog(true);
  };

  // ── 一句话添加视频模型（即见即所得）──
  const handleQuickAdd = async () => {
    if (!canManageModels || !quickAddText.trim() || !quickAddCredential.trim() || quickAddBusy) return;
    setQuickAddBusy(true); setQuickAddMsg("");
    try {
      const response = await fetch("/api/admin/video-models/quick-add", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ text: quickAddText, credential: quickAddCredential }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "添加失败");
      setQuickAddMsg("✅ 已建立待发布候选：" + (data.model?.name || "") + (data.model?.price ? "（售 ¥" + data.model.price + "）" : "") + "；完成差异预览和发布后才会生效");
      setQuickAddText("");
      setModelPoolReleaseRefreshKey((value) => value + 1);
      void loadModels();
    } catch (cause) {
      setQuickAddMsg(cause instanceof Error ? cause.message : "添加失败");
    } finally {
      setQuickAddCredential("");
      setQuickAddBusy(false);
    }
  };

  // ── 编辑模型 ──
  const handleEdit = (model: UnifiedModel) => {
    if (!canManageModels) return;
    setEditingModel(model);
    setDialogModelType(String(model.model_type) as ModelType);
    setShowDialog(true);
  };

  // ── 拖拽排序：只改页面草稿，等待管理员显式保存 ──
  const handleDragReorder = useCallback((draggedId: string, targetId: string, position: "before" | "after") => {
    if (!canManageModels) return;
    if (searchQuery.trim()) {
      alert("请先清空搜索词，再调整完整模型顺序");
      return;
    }
    if (pendingOrderType && pendingOrderType !== activeType) {
      alert(`请先保存或放弃${MODEL_TYPE_CONFIG[pendingOrderType].label}的排序，再调整其他类型`);
      return;
    }
    const idx = filteredModels.findIndex((m) => String(m.id) === draggedId);
    if (idx === -1) return;
    const draggedItem = filteredModels[idx];
    const reordered = filteredModels.filter((m) => String(m.id) !== draggedId);
    const targetIdx = reordered.findIndex((m) => String(m.id) === targetId);
    if (targetIdx === -1) return;
    const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
    reordered.splice(insertIdx, 0, draggedItem);

    // 按10递增分配新的 sort_order
    const orders = reordered.map((m, i) => ({ id: String(m.id), sort_order: (i + 1) * 10 }));

    setModels((prev) => prev.map((m) => {
      const order = orders.find((o) => o.id === String(m.id));
      return order ? { ...m, sort_order: order.sort_order } : m;
    }));
    setPendingOrderType(activeType);
    setPendingOrders(orders);
    setOrderSaveState("dirty");
  }, [activeType, canManageModels, filteredModels, pendingOrderType, searchQuery]);

  const discardPendingOrder = useCallback(async () => {
    if (orderSaveState === "saving") return;
    setPendingOrderType(null);
    setPendingOrders([]);
    setOrderSaveState("idle");
    await loadModels();
  }, [loadModels, orderSaveState]);

  const savePendingOrder = useCallback(async () => {
    if (!canManageModels || orderSaveState === "saving" || !pendingOrderType || pendingOrders.length === 0) return;
    setOrderSaveState("saving");
    try {
      const requestJson = async (pathname: string, init: RequestInit = {}) => {
        const response = await fetch(pathname, {
          ...init,
          headers: { "Content-Type": "application/json", ...authHeaders, ...(init.headers || {}) },
          cache: "no-store",
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
        return body;
      };
      const staged = await requestJson("/api/admin/models", {
        method: "PATCH",
        body: JSON.stringify({ model_type: pendingOrderType, orders: pendingOrders }),
      });
      const releaseId = String(staged.result?.release?.id || "");
      if (!releaseId) throw new Error("排序候选缺少版本编号");
      await requestJson("/api/admin/model-pool-releases", {
        method: "POST",
        body: JSON.stringify({ action: "validate", releaseId }),
      });
      const preview = await requestJson(`/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
      const previewSha256 = String(preview.preview?.previewSha256 || "");
      if (!/^[a-f0-9]{64}$/u.test(previewSha256)) throw new Error("排序差异预览指纹无效");
      await requestJson("/api/admin/model-pool-releases", {
        method: "POST",
        body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
      });
      const readback = await requestJson("/api/admin/models");
      const modelById = new Map(((readback.models || []) as UnifiedModel[]).map((model) => [String(model.id), model]));
      const mismatch = pendingOrders.find((order) => Number(modelById.get(order.id)?.sort_order) !== order.sort_order);
      if (mismatch) throw new Error("排序发布后的数据库读回不一致");
      setModels((((readback.models || []) as UnifiedModel[]).map(withoutModelSecret)));
      setPendingOrderType(null);
      setPendingOrders([]);
      setModelPoolReleaseRefreshKey((value) => value + 1);
      setOrderSaveState("saved");
      onModelsChange?.();
      setTimeout(() => setOrderSaveState("idle"), 3000);
    } catch (cause) {
      setPendingOrderType(null);
      setPendingOrders([]);
      await loadModels();
      setOrderSaveState("failed");
      alert(cause instanceof Error ? `排序保存失败：${cause.message}` : "排序保存失败，已恢复服务器顺序");
    }
  }, [authHeaders, canManageModels, loadModels, onModelsChange, orderSaveState, pendingOrderType, pendingOrders]);

  // ── 检查计费字段是否变更 ──
  const checkBillingChange = (formData: Record<string, unknown>, original: UnifiedModel | null): { changed: boolean; details: string[] } => {
    if (!original) return { changed: false, details: [] };
    if (original.model_type === "video") {
      const details: string[] = [];
      const oldPrice = Number(original.cost_per_use ?? original.price_per_use ?? original.selling_price ?? 0);
      const nextPrice = Number(formData.price_per_use ?? formData.cost_per_use ?? oldPrice);
      const oldCost = Number(original.cost_price ?? 0);
      const nextCost = Number(formData.cost_price ?? oldCost);
      if (oldPrice !== nextPrice) details.push(`售价: ${oldPrice} → ${nextPrice}`);
      if (oldCost !== nextCost) details.push(`成本价: ${oldCost} → ${nextCost}`);
      if (getVideoBillingUnit(original) !== getVideoBillingUnit(formData)) details.push("计费单位发生变化");
      const previous = (original.api_protocol_config || {}) as Record<string, unknown>;
      const next = (formData.api_protocol_config || previous) as Record<string, unknown>;
      for (const [key, label] of [["resolution_prices", "分辨率售价"], ["resolution_cost_prices", "分辨率成本"]]) {
        const before = (previous[key] || {}) as Record<string, unknown>;
        const after = (next[key] || {}) as Record<string, unknown>;
        if ([...new Set([...Object.keys(before), ...Object.keys(after)])].some(resolution =>
          before[resolution] === undefined || after[resolution] === undefined
            ? before[resolution] !== after[resolution]
            : Number(before[resolution]) !== Number(after[resolution]))) details.push(`${label}发生变化`);
      }
      return { changed: details.length > 0, details };
    }
    const billingFields: Array<{ key: string; label: string; formKey?: string }> = [
      { key: "cost_price", label: "进货价" },
      { key: "selling_price", label: "售价" },
      { key: "cost_per_use", label: "单次成本" },
      { key: "price_per_use", label: "单次售价" },
      { key: "input_cost_per_million", label: "输入成本(元/百万Token)" },
      { key: "output_cost_per_million", label: "输出成本(元/百万Token)" },
      { key: "cached_cost_per_million", label: "缓存成本(元/百万Token)" },
      { key: "profit_margin", label: "利润率(%)" },
    ];
    const details: string[] = [];
    for (const { key, label, formKey } of billingFields) {
      const fk = formKey || key;
      const oldVal = (original as unknown as Record<string, unknown>)[key];
      const newVal = formData[fk];
      if (newVal != null && oldVal != null && Number(newVal) !== Number(oldVal)) {
        details.push(`${label}: ${oldVal} → ${newVal}`);
      } else if (newVal != null && oldVal == null) {
        details.push(`${label}: (空) → ${newVal}`);
      } else if (newVal == null && oldVal != null) {
        details.push(`${label}: ${oldVal} → (空)`);
      }
    }
    return { changed: details.length > 0, details };
  };

  // ── 保存模型 ──
  const handleSave = async (formData: Record<string, unknown>) => {
    if (!token || !canManageModels) return;
    const isEdit = !!formData.id;

    // 编辑时检查计费字段变更，需二次确认
    if (isEdit && editingModel) {
      const { changed, details } = checkBillingChange(formData, editingModel);
      if (changed) {
        const confirmed = confirm(
          `⚠️ 计费规则变更确认\n\n` +
          `以下计费字段发生变更，将影响用户扣费金额：\n\n` +
          details.map(d => `• ${d}`).join("\n") +
          `\n\n变更后新提交的任务按新价格计费，已结算记录不受影响。\n确定保存？`
        );
        if (!confirmed) return;
      }
    }

    try {
      // The API deliberately returns 202 while a model is staged in the
      // candidate pool. Read the body in both success and error cases so the
      // operator sees the release id instead of assuming the model vanished.
      const res = await fetch("/api/admin/models", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(formData),
      });
      const data = await res.json().catch(() => ({})) as {
        error?: string;
        staged?: boolean;
        published?: boolean;
        result?: { release?: { id?: string; release_version?: string } };
      };
      if (!res.ok) {
        alert(`${data.error || "保存失败"}${data.error ? `（HTTP ${res.status}）` : ""}`);
        return;
      }
      setShowDialog(false);
      setEditingModel(null);
      setModelPoolReleaseRefreshKey((value) => value + 1);
      await loadModels();
      onModelsChange?.();
      if (data.staged && !data.published) {
        const release = data.result?.release;
        setFocusReleaseId(release?.id || null);
        const releaseLabel = release?.release_version || release?.id || "待发布候选";
        alert(`已保存为待发布候选（${releaseLabel}）。请在模型池发布面板完成校验、差异预览和发布后，才会进入现行模型目录。`);
      }
    } catch (error) {
      alert(error instanceof Error ? `保存失败：${error.message}` : "网络错误");
    }
  };

  const handleTextAction = async (model: UnifiedModel, action: "validate" | "activate") => {
    if (!token || !canManageModels || textActionLocks.current.has(model.id)) return;
    if (action === "validate" && !window.confirm(`对「${model.name || model.model_name}」执行一次真实文字验证？将调用已发布配置的供应商接口，产生供应商 Token 费用；不会自动重试。`)) return;
    if (action === "activate" && !(model.validation?.passed === true && model.validation.fingerprint_current === true)) return;
    textActionLocks.current.add(model.id);
    setTextActions(prev => ({ ...prev, [model.id]: { busy: action } }));
    try {
      const response = await fetch(action === "validate" ? "/api/admin/llm-test" : "/api/admin/models/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(action === "validate"
          ? { scope: "saved", model_id: model.id, model_type: "text" }
          : { id: model.id, model_type: "text" }),
      });
      const result = await response.json().catch(() => ({}));
      const passed = response.ok && (action === "validate" ? result.success === true && result.evidence?.evidenceRecorded === true : result.activated === true);
      const evidence = action === "validate" ? [
        result.latency != null ? `${result.latency}ms` : "",
        result.usage ? `输入 ${result.usage.prompt_tokens ?? "未知"} / 输出 ${result.usage.completion_tokens ?? "未知"} Token` : "",
        result.evidence?.checkedAt ? new Date(result.evidence.checkedAt).toLocaleString("zh-CN") : "",
      ].filter(Boolean).join(" · ") : "";
      setTextActions(prev => ({ ...prev, [model.id]: {
        failed: !passed,
        message: `${result.message || result.error || (passed ? "已启用，正在读回" : "操作未通过")}${evidence ? ` · ${evidence}` : ""}`,
      } }));
      await loadModels();
      if (action === "activate" && passed) onModelsChange?.();
    } catch (error) {
      setTextActions(prev => ({ ...prev, [model.id]: { failed: true, message: error instanceof Error ? error.message : "请求失败；未自动重试" } }));
    } finally {
      textActionLocks.current.delete(model.id);
      setTextActions(prev => ({ ...prev, [model.id]: { ...prev[model.id], busy: undefined } }));
    }
  };

  // ── 删除模型 ──
  const handleDelete = async (model: UnifiedModel) => {
    if (!canManageModels) return;
    const mt = String(model.model_type || "");
    const name = String(model.name || "");
    if (!confirm(`确认给模型「${name}」建立退役候选？发布前不会影响当前运行版本；发布后也可从历史版本建立回滚候选。`)) return;

    try {
      const params = new URLSearchParams({
        model_type: mt,
        id: String(model.id),
      });
      // 对话模型需要传 agent_id
      if (mt === "text" && model.agent_id) {
        params.set("agent_id", String(model.agent_id));
      }
      const res = await fetch(`/api/admin/models?${params.toString()}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (res.ok) {
        setModelPoolReleaseRefreshKey((value) => value + 1);
        loadModels();
        onModelsChange?.();
      } else {
        const data = await res.json();
        alert(data.error || "删除失败");
      }
    } catch {
      alert("网络错误");
    }
  };

  // ── 保存文案提取单价 ──
  const handleSaveExtractPrice = async () => {
    if (!token || !canManagePlugins || !canManagePaymentSettings) return;
    const price = Number(extractPrice);
    if (!extractPrice.trim() || !Number.isFinite(price) || price < 0) {
      alert("请输入有效的单价（不能为负数）");
      return;
    }
    setExtractPriceSaving(true);
    try {
      const res = await fetch("/api/settings/admin?scope=payment", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ extract_price_per_use: String(price) }),
      });
      if (res.ok) {
        alert("文案提取单价保存成功");
      } else {
        alert("保存失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setExtractPriceSaving(false);
    }
  };
  // ── 测试模型 ──
  const handleTest = async (modelId: string, modelType: string) => {
    if (!canManageModels) return;
    setTestingModelId(modelId);
    try {
      if (modelType === "text") {
        // 对话模型(LLM)：调用专用测试接口
        const model = models.find(m => String(m.id) === modelId || `agent-${m.agent_id}` === modelId);
        const res = await fetch("/api/admin/llm-test", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            agent_id: model?.agent_id || undefined,
            model_id: model?.id || undefined,
            model_type: modelType,
            api_endpoint: model?.api_endpoint || undefined,
            model_name: model?.model_name || undefined,
          }),
        });
        const data = await res.json();
        if (data.success) {
          const icon = data.rate_limited ? "⚠️" : "✅";
          alert(`${icon} ${data.message}${data.latency ? ` (${data.latency}ms)` : ""}`);
        } else {
          alert(`❌ ${data.message || "测试失败"}`);
        }
      } else if (modelType === "video") {
        // 视频模型：调用专用连通性测试接口（不消耗配额，GET /v1/models 轻量检测）
        const res = await fetch("/api/admin/video-test", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ modelId }),
        });
        const data = await res.json();
        if (data.success) {
          let msg = `✅ 连接检查通过（未生成视频）。${data.message || ""}`;
          if (data.latency) msg += ` (${data.latency}ms)`;
          alert(msg);
        } else {
          let msg = `连接检查未通过（未生成视频）：${data.message || "未知错误"}`;
          if (data.details) msg += `\n详情：${data.details}`;
          alert(msg);
        }
      } else if (modelType === "drawing") {
        // AutoDL 自租生图只做 GET /v1/models 无费用检查；其他旧模型保持原测试路径。
        const model = models.find(m => String(m.id) === modelId);
        const isAutodlH3Selfhost = model?.provider === "autodl_h3_selfhost";
        const res = await fetch(isAutodlH3Selfhost ? "/api/admin/image-test" : "/api/admin/llm-test", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(isAutodlH3Selfhost ? { modelId } : {
              api_endpoint: model?.api_endpoint || undefined,
              model_id: model?.id || undefined,
              model_type: modelType,
              model_name: model?.model_name || undefined,
            }),
        });
        const data = await res.json();
        if (data.success) {
          const icon = data.rate_limited ? "⚠️" : "✅";
          alert(`${icon} ${data.message}${data.latency ? ` (${data.latency}ms)` : ""}`);
        } else {
          alert(`❌ ${data.message || "测试失败"}`);
        }
      } else {
        alert("测试功能暂未支持该类型模型");
      }
    } catch {
      alert("测试请求失败");
    } finally {
      setTestingModelId(null);
    }
  };

  // ── 渲染模型卡片 ──
  const renderModelCard = (m: UnifiedModel) => {
    const mt = String(m.model_type || "") as ModelType;
    const tc = MODEL_TYPE_CONFIG[mt] || MODEL_TYPE_CONFIG.text;
    const isActive = isOperationalActive(m);
    const activationLabel = isActive ? "已启用" : mt === "text" && m.user_access === "pending_model_activation"
      ? m.validation?.passed === true && m.validation.fingerprint_current === true ? "已发布，待启用" : "已发布，待验证"
      : "已暂停";
    const name = normalizeDisplayText(m.name || m.display_name, "未命名");
    // Keep the internal model id unchanged for requests/forms, but repair a
    // mojibake display value in the administrator card.
    const modelName = canManageModels ? normalizeDisplayText(m.model_name || "") : "";
    const apiEndpoint = canManageModels ? String(m.api_endpoint || "") : "";
    const apiKeyConfigured = canManageModels && m.api_key_configured === true;
    const connection = modelConnectionSummary(apiEndpoint, m.api_protocol_config);
    const platformName = connection.label + " · " + connection.provider;
    const costPrice = canManageModels ? Number(m.cost_price) || 0 : 0;
    const costPerUse = Number(canManageModels
      ? (m.cost_per_use ?? m.price_per_use ?? m.selling_price ?? 0)
      : (m.selling_price ?? m.price_per_use ?? 0));
    const providerBillingUnit = (m.api_protocol_config as Record<string, unknown> | undefined)?.provider_billing_unit;
    const videoPriceUnit = providerBillingUnit === "token"
      ? "百万Token"
      : getVideoBillingUnit(m) === "output_second"
        ? "输出秒"
        : "次";
    const modelId = String(m.id);
    const channelHealth = canManageModels && mt === "video" ? videoChannelHealth[modelId] : undefined;

    // 维护备注属于历史记录，不能据此推断当前可用性或余额。
    const adminNotes = canManageModels ? normalizeDisplayText(m.admin_notes || "") : "";
    const category = normalizeDisplayText(m.category || "");
    const description = normalizeDisplayText(m.description || "");
    const iconValue = String(m.icon_url || "").trim();
    const iconIsImage = /^(?:https?:\/\/|\/|data:image\/)/iu.test(iconValue);

    const isDraggedOver = dragOverModelId === modelId;
    const isDragging = draggedModelId === modelId;

    return (
      <div
        key={modelId}
        data-model-card
        data-model-id={canManageModels ? modelId : undefined}
        draggable={canManageModels}
        onDragStart={(e) => {
          if (!canManageModels) {
            e.preventDefault();
            return;
          }
          setDraggedModelId(modelId);
          e.dataTransfer.effectAllowed = "move";
          const card = e.currentTarget.closest("[data-model-card]") as HTMLElement | null;
          if (card) e.dataTransfer.setDragImage(card, 20, card.offsetHeight / 2);
        }}
        onDragEnd={() => {
          setDraggedModelId(null);
          setDragOverModelId(null);
          setDragOverPosition("before");
        }}
        className={`relative rounded-xl border p-4 flex flex-wrap items-center gap-4 transition-all select-none bg-[var(--card)]/95 backdrop-blur-sm shadow-sm ${canManageModels ? "cursor-grab active:cursor-grabbing" : "cursor-default"} ${
          isDragging ? "opacity-40 scale-[0.98]" : ""
        } ${
          isDraggedOver && dragOverPosition === "before" ? "border-t-2 border-t-[var(--primary)]" : ""
        } ${
          isDraggedOver && dragOverPosition === "after" ? "border-b-2 border-b-[var(--primary)]" : ""
        } ${
          "border-[var(--border)] hover:border-[var(--primary)]/30"
        }`}
        onDragOver={(e) => {
          if (!canManageModels) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (draggedModelId === modelId) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          setDragOverModelId(modelId);
          setDragOverPosition(e.clientY < midY ? "before" : "after");
        }}
        onDragLeave={() => {
          if (dragOverModelId === modelId) {
            setDragOverModelId(null);
            setDragOverPosition("before");
          }
        }}
        onDrop={(e) => {
          if (!canManageModels) return;
          e.preventDefault();
          if (draggedModelId && draggedModelId !== modelId) {
            handleDragReorder(draggedModelId, modelId, dragOverPosition);
          }
          setDraggedModelId(null);
          setDragOverModelId(null);
          setDragOverPosition("before");
        }}
      >
        {/* 排序控制：拖拽手柄 + 序号输入 + 置顶 + 上下移动按钮 */}
        {canManageModels && <div className="flex flex-col items-center gap-0.5 shrink-0 py-1 px-1.5 rounded-lg bg-[var(--muted)]/30 select-none">
          {/* 置顶按钮 */}
          <button
            onClick={() => {
              const idx = filteredModels.findIndex((fm) => String(fm.id) === modelId);
              if (idx > 0) handleDragReorder(modelId, String(filteredModels[0].id), "before");
            }}
            disabled={filteredModels.findIndex((fm) => String(fm.id) === modelId) === 0}
            className="p-1 rounded-md hover:bg-[var(--primary)]/15 text-[var(--muted-foreground)] hover:text-[var(--primary)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors border border-transparent hover:border-[var(--primary)]/30"
            title="置顶（调整后请保存排序）"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
          </button>
          {/* 序号显示/输入：填写 1、2、3… 后回车或点保存生效 */}
          <input
            type="number"
            min={1}
            max={999}
            defaultValue={filteredModels.findIndex((fm) => String(fm.id) === modelId) + 1}
            key={`order-${modelId}-${filteredModels.length}`}
            className="w-10 text-center text-xs rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] py-0.5 focus:border-[var(--primary)] focus:outline-none"
            title="输入序号（第几位）后回车调整，再点击保存排序"
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const input = e.currentTarget;
              const target = Math.min(Math.max(1, Math.round(Number(input.value) || 1)), filteredModels.length);
              const currentIdx = filteredModels.findIndex((fm) => String(fm.id) === modelId);
              if (currentIdx === -1 || target - 1 === currentIdx) return;
              const anchor = filteredModels[target - 1];
              handleDragReorder(modelId, String(anchor.id), target - 1 < currentIdx ? "before" : "after");
            }}
            onBlur={(e) => { e.currentTarget.value = String(filteredModels.findIndex((fm) => String(fm.id) === modelId) + 1); }}
          />
          {/* 拖拽手柄 */}
          <div
            className="cursor-grab active:cursor-grabbing text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors p-1.5 rounded-md hover:bg-[var(--primary)]/15 border border-transparent hover:border-[var(--primary)]/30"
            title="拖拽排序"
          >
            <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="4" cy="2.5" r="1.8" /><circle cx="12" cy="2.5" r="1.8" />
              <circle cx="4" cy="8" r="1.8" /><circle cx="12" cy="8" r="1.8" />
              <circle cx="4" cy="13.5" r="1.8" /><circle cx="12" cy="13.5" r="1.8" />
            </svg>
          </div>
          {/* 上移/下移按钮 */}
          <div className="flex flex-col gap-0.5">
            <button
              onClick={() => {
                const idx = filteredModels.findIndex((fm) => String(fm.id) === modelId);
                if (idx > 0) handleDragReorder(modelId, String(filteredModels[idx - 1].id), "before");
              }}
              disabled={filteredModels.findIndex((fm) => String(fm.id) === modelId) === 0}
              className="p-1 rounded-md hover:bg-[var(--primary)]/15 text-[var(--muted-foreground)] hover:text-[var(--primary)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors border border-transparent hover:border-[var(--primary)]/30"
              title="上移"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
            </button>
            <button
              onClick={() => {
                const idx = filteredModels.findIndex((fm) => String(fm.id) === modelId);
                if (idx < filteredModels.length - 1) handleDragReorder(modelId, String(filteredModels[idx + 1].id), "after");
              }}
              disabled={filteredModels.findIndex((fm) => String(fm.id) === modelId) === filteredModels.length - 1}
              className="p-1 rounded-md hover:bg-[var(--primary)]/15 text-[var(--muted-foreground)] hover:text-[var(--primary)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors border border-transparent hover:border-[var(--primary)]/30"
              title="下移"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </div>
        </div>}
        {/* 状态指示灯 */}
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${isActive ? "bg-green-500" : "bg-gray-400"}`}
          title={activationLabel}
        />

        {/* 模型信息 */}
        <div className="flex-1 min-w-0 basis-52">
          <div className="flex items-center gap-2 flex-wrap">
            {iconValue && (iconIsImage
              ? <img src={iconValue} alt="" className="w-5 h-5 rounded object-cover shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              : <span aria-hidden="true" className="w-5 h-5 shrink-0 inline-flex items-center justify-center text-base leading-none">{iconValue}</span>)}
            <span className="font-bold text-[var(--foreground)]">{name}</span>
            {/* 平台标签 */}
            <span className={`text-xs px-2 py-0.5 rounded-full ${tc.bgColor} ${tc.color} font-medium`}>
              {tc.icon} {tc.label}
            </span>
            {canManageModels && <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--primary)]/10 text-[var(--primary)] font-medium">
              {platformName}
            </span>}
            {/* 计费标签 */}
            {mt === "video" && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-600 font-bold">
                ¥{formatModelPrice(costPerUse)}/{videoPriceUnit}
              </span>
            )}
            {mt === "drawing" && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-600 font-bold">
                ¥{formatModelPrice(costPerUse)}/次
              </span>
            )}
            {mt === "text" && (
              <>
                {category && category !== "通用" && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 font-medium">
                    {category}
                  </span>
                )}
                {(m.token_billing_enabled === true || String(m.billing_mode) === "token") ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-600 font-bold">
                    Token计费
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-600 font-bold">
                    {costPerUse}积分/次
                  </span>
                )}
              </>
            )}
            {canManageModels && mt !== "text" && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-600 font-bold">
                成本 ¥{formatModelPrice(costPrice)}/{mt === "video" ? videoPriceUnit : "次"}
              </span>
            )}
            {/* 协议标签(视频) */}
            {mt === "video" && m.protocol_type && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-500 font-medium">
                {String(m.protocol_type).toUpperCase()}
              </span>
            )}
          </div>
          <div className="text-xs text-[var(--muted-foreground)] mt-1 break-all">
            {canManageModels && modelName && <span className="mr-2">{modelName}</span>}
            {mt === "text" && description && <span className="mr-2">· {description}</span>}
            {mt === "text" && category && category !== "通用" && <span className="mr-2">· {category}</span>}
            {mt === "text" && m.image_parsing && m.image_parsing !== "none" && <span className="mr-2">· 图片解析:{m.image_parsing === "reverse" ? "逆向" : m.image_parsing === "gpt_vision" ? "GPT Vision" : "全局"}</span>}
            {mt === "text" && m.file_parsing && m.file_parsing !== "none" && <span className="mr-2">· 文件解析:{m.file_parsing === "reverse" ? "逆向" : "向量"}</span>}
            {mt === "text" && m.frequency_limit && m.frequency_limit > 0 && <span className="mr-2">· {m.frequency_limit}次/时</span>}
            {canManageModels && (apiEndpoint ? (
              <span><a href={(() => { try { const url = new URL(apiEndpoint); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? `${url.protocol}//${url.host}/` : undefined; } catch { return undefined; } })()} target="_blank" rel="noreferrer" className="font-medium text-blue-600 hover:underline">{connection.host || apiEndpoint}</a> · {apiKeyConfigured ? "密钥已配置" : "⚠ 未配置密钥"}</span>
            ) : (
              <span>未配置API</span>
            ))}
          </div>
          {canManageModels && mt === "text" && m.token_billing_enabled && <div className="text-xs text-[var(--muted-foreground)] mt-1 break-words">
            输入成本 ¥{formatModelPrice(m.input_cost_per_million)}/百万Token · 输出成本 ¥{formatModelPrice(m.output_cost_per_million)}/百万Token
            {Number(m.profit_margin) < 100 && <> · 输入售价 ¥{formatModelPrice(Number(m.input_cost_per_million || 0) / (1 - Number(m.profit_margin || 0) / 100))}/百万Token · 输出售价 ¥{formatModelPrice(Number(m.output_cost_per_million || 0) / (1 - Number(m.profit_margin || 0) / 100))}/百万Token</>}
          </div>}
          {canManageModels && <div className="text-xs text-[var(--muted-foreground)] mt-1">{connection.label} · {connection.kind === "relay" ? "渠道分组：" : "权限："}{connection.group}</div>}
          {canManageModels && mt === "text" && <div className="mt-2 space-y-1 text-xs text-[var(--muted-foreground)]" data-text-validation>
            <p>调用状态：{activationLabel}</p>
            <p>真实文字验证：{(m.validation?.passed === true && m.validation.fingerprint_current === true) ? "当前配置已通过" : m.validation?.reason || "尚无当前配置的有效证据"}</p>
            {m.validation?.validated_at && <p>证据时间 {new Date(m.validation.validated_at).toLocaleString("zh-CN")} · {m.validation.latency_ms ?? "未知"}ms · 输入 {m.validation.input_tokens ?? "未知"} / 输出 {m.validation.output_tokens ?? "未知"} Token</p>}
            {textActions[modelId]?.message && <p role="status" className={textActions[modelId].failed ? "text-red-600" : "text-emerald-700"}>{textActions[modelId].message}</p>}
            <p>目录显示与调用启用分别管理；验证失败不会隐藏或删除模型。</p>
          </div>}
          {canManageModels && (adminNotes || (channelHealth && mt === "video")) && <details className="mt-2 text-xs text-[var(--muted-foreground)]">
            <summary className="cursor-pointer">维护记录与检测详情</summary>
          {adminNotes && (
            <div className="text-xs mt-2 whitespace-pre-wrap break-words text-[var(--muted-foreground)]">
              {adminNotes}
            </div>
          )}
          {channelHealth && mt === "video" && (
            <div className="text-xs mt-1 text-[var(--muted-foreground)]">
              健康状态：{channelHealth.circuitState} · 连续失败 {channelHealth.consecutiveFailures} 次
              {channelHealth.lastFailAt ? ` · 最后失败 ${new Date(channelHealth.lastFailAt).toLocaleString("zh-CN")}` : ""}
              {channelHealth.updatedAt ? ` · 更新 ${new Date(channelHealth.updatedAt).toLocaleString("zh-CN")}` : ""}
              {channelHealth.lastError ? ` · ${channelHealth.lastErrorCode}: ${channelHealth.lastError}` : ""}
              {channelHealth.recoveryEligibleAt && !channelHealth.recoveryCanaryEligible
                ? ` · 可试运行时间 ${new Date(channelHealth.recoveryEligibleAt).toLocaleString("zh-CN")}`
                : ""}
            </div>
          )}
          </details>}
        </div>

        {/* 操作按钮 */}
        {canManageModels && <div className={mt === "video" || mt === "drawing" ? "flex flex-wrap items-center justify-end gap-2 shrink-0 max-w-md" : "flex items-center gap-2 shrink-0"} onPointerDown={(e) => e.stopPropagation()}>
          {mt === "text" && <>
            <button type="button" disabled={Boolean(textActions[modelId]?.busy)} onClick={() => void handleTextAction(m, "validate")} className="px-3 py-1.5 text-xs rounded-lg border border-orange-400 text-orange-600 disabled:opacity-50">{textActions[modelId]?.busy === "validate" ? "验证中…" : "真实文字验证（付费）"}</button>
            <button type="button" disabled={Boolean(textActions[modelId]?.busy) || (m.validation?.passed === true && m.validation.fingerprint_current === true) !== true || isActive} onClick={() => void handleTextAction(m, "activate")} className="px-3 py-1.5 text-xs rounded-lg border border-emerald-500 text-emerald-700 disabled:opacity-40">{textActions[modelId]?.busy === "activate" ? "启用中…" : isActive ? "已启用" : "启用当前配置"}</button>
          </>}
          {mt === "video" && (
            <button
              onClick={() => handleTest(String(m.id), mt)}
              disabled={testingModelId === String(m.id)}
              className="px-3 py-1.5 text-xs rounded-lg border border-[var(--primary)] text-[var(--primary)] hover:bg-[var(--primary)]/10 transition disabled:opacity-50"
            >
              {testingModelId === String(m.id) ? "检查中…" : "连接检查（不生成）"}
            </button>
          )}
          {mt === "video" && (
            <button
              onClick={() => setValidatingVideo(m)}
              className="px-3 py-1.5 text-xs rounded-lg border border-orange-400 text-orange-600 hover:bg-orange-500/10 transition"
            >
              真实生成验证
            </button>
          )}
          {mt === "drawing" && (
            <button type="button" onClick={() => setValidatingImage(m)} className="px-3 py-1.5 text-xs rounded-lg border border-orange-400 text-orange-600 hover:bg-orange-500/10 transition">真实生成验证</button>
          )}
          <button
            onClick={() => handleEdit(m)}
            className="px-3 py-1.5 text-xs rounded-lg border hover:bg-[var(--muted)]/50 transition"
          >
            编辑
          </button>
          <button
            onClick={() => handleDelete(m)}
            className="px-3 py-1.5 text-xs rounded-lg border border-red-300 text-red-500 hover:bg-red-50 transition"
          >
            删除
          </button>
        </div>}
      </div>
    );
  };

  const tc = MODEL_TYPE_CONFIG[activeType];

  return (
    <div className="space-y-4">
      {/* ── 标题区 ── */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold">模型资源池</h3>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            {canManageModels
              ? "管理模型接口、凭据、价格、能力声明和真实验收，不在这里配置工作台展示"
              : "查看已开放模型的名称、类型、启用状态、公开能力和用户售价"}
          </p>
        </div>
        {isExtractTab && canManagePlugins && <a href="/admin?tab=workspace-models&project=tools" className="px-4 py-2 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--accent)]">添加与管理插件</a>}
        {!isExtractTab && canManageModels && (
          <button
            onClick={() => handleAdd(activeType)}
            className="px-4 py-2 rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 transition flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 4v16m8-8H4" />
            </svg>
            添加{activeType === "drawing" ? "绘图模型" : activeType === "text" ? "对话模型" : activeType === "video" ? "视频模型" : "语音模型"}
          </button>
        )}
      </div>

      {token && canManageModels && (
        <PlatformConfigurationReleasePanel
          token={token}
          kind="model-pool"
          refreshKey={modelPoolReleaseRefreshKey}
          focusReleaseId={focusReleaseId}
          onPublished={() => { setTextActions({}); void loadModels(); onModelsChange?.(); alert("模型候选已发布。新增或变更的对话模型请从对应卡片执行真实文字验证，通过后再显式启用。"); }}
        />
      )}

      {canManageModels && <section
        data-testid="credential-safety-panel"
        className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-white">✓</span>
              <div>
                <h4 className="text-sm font-semibold text-[var(--foreground)]">凭据安全清单</h4>
                <p className="text-xs text-[var(--muted-foreground)]">只展示配置状态、安全编号、用途与真实验收状态；不返回明文、尾号或可解析密钥。</p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCredentialDetails((value) => !value)}
            className="rounded-lg border border-emerald-600/35 bg-[var(--card)] px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-500/10"
          >
            {showCredentialDetails ? "收起清单" : "查看安全清单"}
          </button>
        </div>
        {credentialHealth ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" data-testid="credential-safety-summary">
              {[
                ["模型总数", credentialHealth.summary.total],
                ["已配置", credentialHealth.summary.configured],
                ["引用或独立绑定", credentialHealth.summary.isolated],
                ["旧字段待迁移", credentialHealth.summary.legacyReview],
                ["未配置", credentialHealth.summary.missing],
                ["已有真实成功证据", credentialHealth.summary.verified],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2">
                  <div className="text-[11px] text-[var(--muted-foreground)]">{label}</div>
                  <div className="mt-1 text-lg font-semibold text-[var(--foreground)]">{value}</div>
                </div>
              ))}
            </div>
            {credentialHealth.summary.legacyReview > 0 && (
              <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                {credentialHealth.summary.legacyReview} 项仍使用受权限保护的旧版字段；可以运行，但应逐项迁移到独立凭据绑定或服务器密钥引用。迁移不等于调用成功，仍需单独做真实验收。
              </p>
            )}
            {showCredentialDetails && (
              <div className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1" data-testid="credential-safety-details">
                {credentialHealth.credentials.map((item) => {
                  const validationLabel = item.validationStatus === "verified" ? "真实成功"
                    : item.validationStatus === "pending" ? "待终态"
                      : item.validationStatus === "needs_attention" ? "需核对"
                        : item.validationStatus === "not_recorded" ? "未建统一证据" : "未验收";
                  return (
                    <div key={`${item.kind}:${item.modelId}`} className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-xs lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-[var(--foreground)]">{item.modelName}</div>
                        <div className="mt-0.5 font-mono text-[10px] text-[var(--muted-foreground)]">{item.credentialId}</div>
                      </div>
                      <div><span className="text-[var(--muted-foreground)]">用途：</span>{item.purpose}</div>
                      <div><span className="text-[var(--muted-foreground)]">存储：</span>{item.storageLabel}</div>
                      <div>
                        <span className="text-[var(--muted-foreground)]">验收：</span>{validationLabel}
                        <div className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{item.validationExplanation}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <p className="mt-3 text-xs text-amber-700">{credentialHealthError || "正在读取凭据安全状态…"}</p>
        )}
      </section>}

      {/* ── 视频模型快速候选：非敏感配置与只写密钥分离 ── */}
      {canManageModels && activeType === "video" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3" data-testid="secure-video-quick-add">
          <div className="flex items-center gap-2 flex-wrap">
          <input
            value={quickAddText}
            onChange={(e) => setQuickAddText(e.target.value)}
            placeholder="渠道地址 + 模型名 + 售价，例如：https://渠道地址/v1 model-name 售价1.2"
            aria-label="视频模型非敏感配置"
            className="min-w-[360px] flex-[2] px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-green-500"
          />
          <input
            type="password"
            value={quickAddCredential}
            onChange={(e) => setQuickAddCredential(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleQuickAdd(); }}
            placeholder="渠道密钥（只写，本页不回显）"
            aria-label="视频模型渠道密钥"
            autoComplete="new-password"
            className="min-w-[260px] flex-1 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-green-500"
          />
          <button
            onClick={() => void handleQuickAdd()}
            disabled={quickAddBusy || !quickAddText.trim() || !quickAddCredential.trim()}
            className="px-4 py-2 rounded-lg border border-green-500 text-green-600 text-sm font-medium hover:bg-green-500/10 transition disabled:opacity-50 whitespace-nowrap"
          >
            {quickAddBusy ? "校验建候选中…" : "校验并建立候选"}
          </button>
          </div>
          <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">密钥仅随本次 HTTPS 请求提交，响应与候选预览不含明文或尾号；这里只建立候选，不会绕过差异预览、真实验收和发布门禁。</p>
          {quickAddMsg && <p className="mt-2 text-xs text-[var(--muted-foreground)]">{quickAddMsg}</p>}
        </div>
      )}

      {/* ── 模型类型切换 ── */}
      <div className="flex items-center gap-2">
        {visibleModelTypes.map((type) => {
          const cfg = MODEL_TYPE_CONFIG[type];
          const count = typeCounts[type] || 0;
          const isActive = activeType === type;
          return (
            <button
              key={type}
              onClick={() => {
                if (pendingOrderType && pendingOrderType !== type) {
                  alert(`请先保存或放弃${MODEL_TYPE_CONFIG[pendingOrderType].label}的排序`);
                  return;
                }
                setActiveType(type);
              }}
              className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center gap-2 ${
                isActive
                  ? `${cfg.bgColor} ${cfg.color} border-2 ${cfg.borderColor} shadow-sm`
                  : "border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50"
              }`}
            >
              <span className="text-base">{cfg.icon}</span>
              {cfg.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? `${cfg.color} bg-white/50` : "bg-[var(--muted)]"}`}>
                {count}
              </span>
            </button>
          );
        })}

        {/* 搜索框 */}
        {!isExtractTab && (
          <div className="ml-auto relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索模型..."
              className="pl-9 pr-3 py-2 w-56 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition"
            />
          </div>
        )}
      </div>

      {canManageModels && activeType === "video" && (
        <details data-video-channel-health-summary className="rounded-lg border border-[#d0d5dd] bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-[#344054]">通道连接与健康详情（管理员）</summary>
          <div className="mt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-bold text-[#172033]">视频通道诊断</h4>
              <p className="mt-1 text-xs leading-5 text-[#667085]">诊断数据仅供管理员排查，不会改变模型的启用或显示状态。</p>
            </div>
            <button type="button" onClick={() => void loadModels()} disabled={loading} className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-semibold text-[#344054] hover:bg-[#f9fafb] disabled:opacity-50">
              {loading ? "刷新中..." : "刷新状态"}
            </button>
          </div>
          {videoHealthError ? (
            <div className="mt-3 rounded-md border border-[#d0d5dd] bg-[#f9fafb] px-3 py-2 text-xs text-[#667085]">{videoHealthError}</div>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <div className="rounded-md border border-[#eaecf0] bg-[#f9fafb] px-3 py-2.5"><p className="text-xs text-[#667085]">启用通道</p><p className="mt-1 text-lg font-bold text-[#172033]">{videoHealthSummary.active}</p></div>
              <div className="rounded-md border border-[#eaecf0] bg-[#f9fafb] px-3 py-2.5"><p className="text-xs text-[#667085]">最近正常</p><p className="mt-1 text-lg font-bold text-[#172033]">{videoHealthSummary.ready}</p></div>
              <div className="rounded-md border border-[#eaecf0] bg-[#f9fafb] px-3 py-2.5"><p className="text-xs text-[#667085]">需排查记录</p><p className="mt-1 text-lg font-bold text-[#172033]">{videoHealthSummary.blocked}</p></div>
              <div className="rounded-md border border-[#eaecf0] bg-white px-3 py-2.5"><p className="text-xs text-[#667085]">无终态证据</p><p className="mt-1 text-lg font-bold text-[#344054]">{videoHealthSummary.unverified}</p></div>
            </div>
          )}
          <div className="mt-3 border-t border-[#eaecf0] pt-3 text-xs text-[#667085]">
            供应商余额：当前渠道未接入受支持的只读余额接口；后台只展示真实鉴权、任务成功率、最近失败、熔断与恢复资格。
          </div>
          </div>
        </details>
      )}

      {canManageModels && !isExtractTab && (
        <div data-testid="model-order-save-bar" className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${
          orderSaveState === "dirty" ? "border-blue-300 bg-blue-50 text-blue-800"
          : orderSaveState === "saving" ? "border-blue-300 bg-blue-50 text-blue-800"
          : orderSaveState === "saved" ? "border-emerald-300 bg-emerald-50 text-emerald-800"
          : orderSaveState === "failed" ? "border-red-300 bg-red-50 text-red-800"
          : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]"
        }`}>
          <div>
            <p className="text-xs font-semibold">
              {orderSaveState === "dirty" ? `${MODEL_TYPE_CONFIG[pendingOrderType || activeType].label}排序已修改，尚未保存`
                : orderSaveState === "saving" ? "正在校验、预览并发布排序…"
                  : orderSaveState === "saved" ? "排序已发布，刷新页面仍会保持"
                    : orderSaveState === "failed" ? "排序保存失败，已恢复服务器顺序"
                      : "拖拽、置顶或输入序号后，请点击“保存排序”"}
            </p>
            <p className="mt-0.5 text-[11px] opacity-80">保存会为本次排序建立独立候选，并完成校验、差异预览、原子发布和数据库读回。</p>
          </div>
          <div className="flex items-center gap-2">
            {orderSaveState === "dirty" && (
              <button type="button" onClick={() => void discardPendingOrder()} className="rounded-lg border border-current/25 bg-white px-3 py-2 text-xs font-semibold hover:bg-white/70">
                放弃修改
              </button>
            )}
            <button
              type="button"
              data-testid="save-model-order"
              onClick={() => void savePendingOrder()}
              disabled={orderSaveState !== "dirty"}
              className="rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {orderSaveState === "saving" ? "保存中…" : "保存排序"}
            </button>
          </div>
        </div>
      )}

      {/* ── 模型配置说明 ── */}
      <div className={`rounded-xl p-4 border ${tc.borderColor} ${tc.bgColor}`}>
        <p className={`text-xs font-bold ${tc.color} mb-2 flex items-center gap-1.5`}>
          <span className={`inline-block w-2 h-2 rounded-full ${tc.color.replace("text-", "bg-")}`} />
          {tc.label}配置说明
        </p>
        <div className="text-xs text-[var(--muted-foreground)] space-y-1">
          {!canManageModels && !isExtractTab && (
            <>
              <p>• 只读账号仅显示用户侧可见的模型名称、能力、状态和售价</p>
              <p>• 渠道地址、模型内部标识、成本、凭据状态、维护记录和诊断信息均不在本页加载</p>
            </>
          )}
          {canManageModels && activeType === "video" && (
            <>
              <p>• 视频模型按各自配置按次或按输出秒计费，费用从本站钱包扣除；提交前展示本次费用</p>
              <p>• 接入站点与令牌分组确定渠道；接口协议决定请求格式。检查配置不会生成或自动保存。</p>
              <p>• 进价=向中转站支付的成本价，售价=向用户收取的费用</p>
            </>
          )}
          {canManageModels && activeType === "drawing" && (
            <>
              <p>• 绘图模型用于封面制作页面，用户选择模型后按次扣费（现金）</p>
              <p>• 也可选择封面工作流插件生成封面，在上方工作流插件区域切换</p>
              <p>• 成本价=向供应商支付的进价，售卖价=向用户收取的费用</p>
            </>
          )}
          {canManageModels && activeType === "text" && (
            <>
              <p>• 对话模型在此统一添加和管理，添加智能体时可直接选择已配置的模型</p>
              <p>• 支持两种计费模式：按次扣积分 / Token关联计费</p>
              <p>• 可指定代理地址(proxy_url)覆盖全局API，支持深度思考、联网搜索、图片/文件解析等高级配置</p>
            </>
          )}
          {canManagePlugins && activeType === "extract" && (
            <>
              <p>• 视频、单条文案、批量与搜索统一使用三合一提取插件</p>
              <p>• 在统一配置区激活一次即可，四项能力共用同一凭据和价格</p>
              <p>• 插件单价在「插件管理」中配置，提取失败不扣费</p>
            </>
          )}
        </div>
      </div>

      {/* ── 模型列表 / 提取插件选择 ── */}
      {isExtractTab ? (
        /* ── 三合一提取插件：统一配置，分能力展示状态 ── */
        <div className="space-y-6">

          {/* ====== 三合一提取统一配置 ====== */}
          <div className="rounded-xl border border-teal-500/20 bg-teal-500/5 p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-teal-500/10 flex items-center justify-center text-2xl">📝</div>
              <div>
                <h4 className="text-base font-bold text-[var(--foreground)]">三合一提取插件</h4>
                <p className="text-xs text-[var(--muted-foreground)]">统一管理视频下载、单条文案、博主批量与关键词搜索；同一时刻仅一个插件生效</p>
              </div>
            </div>

            {/* 文案提取单价兼容设置（仅当无插件时显示） */}
            {singleTextPlugins.length === 0 && canManagePaymentSettings && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm">⚠️</span>
                  <span className="text-sm font-semibold text-amber-600">尚未配置三合一提取插件，付费提交将保持关闭</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--muted-foreground)]">文案提取单价：</span>
                  <span className="text-lg font-bold text-[var(--muted-foreground)]">¥</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={extractPrice}
                    onChange={(e) => setExtractPrice(e.target.value)}
                    className="w-28 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-lg font-bold text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition"
                    placeholder="0.02"
                  />
                  <span className="text-sm text-[var(--muted-foreground)]">元/次</span>
                  <button
                    onClick={handleSaveExtractPrice}
                    disabled={extractPriceSaving}
                    className="ml-auto px-4 py-2 rounded-lg bg-teal-600 text-white font-bold hover:bg-teal-700 transition disabled:opacity-50"
                  >
                    {extractPriceSaving ? "保存中..." : "保存单价"}
                  </button>
                </div>
                <p className="text-xs text-[var(--muted-foreground)]">请在「插件管理」中添加三合一提取插件（role=coze_multifunction_extract）</p>
              </div>
            )}
            {singleTextPlugins.length === 0 && !canManagePaymentSettings && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-700">
                尚未配置三合一提取插件；价格规则需由负责计费的管理员维护。
              </div>
            )}

            {/* 插件下拉选择 + 保存按钮 */}
            {pluginsLoading ? (
              <div className="flex items-center justify-center py-6">
                <svg className="animate-spin w-5 h-5 text-teal-600" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="ml-2 text-sm text-[var(--muted-foreground)]">加载插件中...</span>
              </div>
            ) : singleTextPlugins.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-[var(--foreground)] shrink-0">选择插件：</label>
                  <select
                    value={selectedSingleTextPluginId}
                    onChange={(e) => setSelectedSingleTextPluginId(e.target.value)}
                    disabled={pluginSaving === "shared"}
                    className="flex-1 px-3 py-2.5 rounded-lg border border-teal-500/30 bg-[var(--card)] text-sm font-medium text-[var(--foreground)] outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/20 transition cursor-pointer disabled:opacity-50"
                  >
                    {singleTextPlugins.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — ¥{Number(p.price_per_use || 0).toFixed(2)}/次 {p.is_active ? '✓ 生效中' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      if (!selectedSingleTextPluginId) return;
                      const plugin = singleTextPlugins.find(p => p.id === selectedSingleTextPluginId);
                      if (plugin) handleSavePlugin(selectedSingleTextPluginId, plugin.role, "shared");
                    }}
                    disabled={pluginSaving === "shared" || !selectedSingleTextPluginId || selectedSingleTextPluginId === singleTextPlugins.find(p => p.is_active)?.id}
                    className="px-4 py-2.5 rounded-lg bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    {pluginSaving === "shared" ? "保存中..." : "保存并统一生效"}
                  </button>
                </div>
                {/* 选中插件与当前生效插件不一致时的提示 */}
                {selectedSingleTextPluginId && selectedSingleTextPluginId !== singleTextPlugins.find(p => p.is_active)?.id && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-600">
                    <span>⚠️</span>
                    <span>已选择新插件，保存后四项提取能力同时切换</span>
                  </div>
                )}
                {/* 当前生效插件详情 */}
                {(() => {
                  const activePlugin = singleTextPlugins.find(p => p.is_active);
                  if (!activePlugin) return null;
                  return (
                    <div className="flex items-center gap-3 p-3 rounded-xl border border-teal-500/30 bg-teal-500/8">
                      <div className="w-2.5 h-2.5 rounded-full bg-teal-500 shadow-sm shadow-teal-500/50 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-[var(--foreground)]">{activePlugin.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-500/20 text-teal-600 font-bold">生效中</span>
                        </div>
                        {activePlugin.description && (
                          <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{activePlugin.description}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs text-[var(--muted-foreground)]">单价</p>
                        <p className="text-sm font-bold text-teal-600">¥{Number(activePlugin.price_per_use || 0).toFixed(2)}/次</p>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div className="text-center py-6 text-[var(--muted-foreground)]">
                <span className="text-3xl block mb-2">📝</span>
                <p className="text-sm">暂无三合一提取插件</p>
                <p className="text-xs mt-1">请在「插件管理」中添加 role=coze_multifunction_extract 的插件</p>
              </div>
            )}
          </div>

          {/* ====== 批量与搜索能力（共用状态） ====== */}
          <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-violet-500/10 flex items-center justify-center text-2xl">📋</div>
              <div>
                <h4 className="text-base font-bold text-[var(--foreground)]">批量与搜索提取</h4>
                <p className="text-xs text-[var(--muted-foreground)]">共用上方三合一插件，不再设置独立通道</p>
              </div>
            </div>

            {pluginsLoading ? (
              <div className="flex items-center justify-center py-6 text-sm text-[var(--muted-foreground)]">读取统一配置中...</div>
            ) : (() => {
              const activePlugin = batchTextPlugins.find(p => p.is_active);
              return activePlugin ? (
                <div className="flex items-center gap-3 p-3 rounded-xl border border-violet-500/30 bg-violet-500/8">
                  <div className="w-2.5 h-2.5 rounded-full bg-violet-500 shadow-sm shadow-violet-500/50 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-[var(--foreground)]">{activePlugin.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-600 font-bold">共享生效</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">博主批量</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">关键词搜索</span>
                    </div>
                    <p className="text-xs text-[var(--muted-foreground)] mt-1">配置与价格继承自三合一提取插件</p>
                  </div>
                  <p className="text-sm font-bold text-violet-600 shrink-0">¥{Number(activePlugin.price_per_use || 0).toFixed(2)}/次</p>
                </div>
              ) : (
                <div className="text-center py-6 text-[var(--muted-foreground)]">
                  <span className="text-3xl block mb-2">📋</span>
                  <p className="text-sm">三合一提取插件尚未启用</p>
                  <p className="text-xs mt-1">请在上方统一配置区选择并保存</p>
                </div>
              );
            })()}
          </div>

          {/* ====== 视频提取能力（共用状态） ====== */}
          <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center text-2xl">🎬</div>
              <div>
                <h4 className="text-base font-bold text-[var(--foreground)]">视频提取</h4>
                <p className="text-xs text-[var(--muted-foreground)]">共用上方三合一插件，不再设置独立视频通道</p>
              </div>
            </div>

            {pluginsLoading ? (
              <div className="flex items-center justify-center py-6 text-sm text-[var(--muted-foreground)]">读取统一配置中...</div>
            ) : (() => {
              const activePlugin = videoPlugins.find(p => p.is_active);
              return activePlugin ? (
                <div className="flex items-center gap-3 p-3 rounded-xl border border-orange-500/30 bg-orange-500/8">
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-500 shadow-sm shadow-orange-500/50 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-[var(--foreground)]">{activePlugin.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-600 font-bold">共享生效</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">视频下载</span>
                    </div>
                    <p className="text-xs text-[var(--muted-foreground)] mt-1">配置与价格继承自三合一提取插件</p>
                  </div>
                  <p className="text-sm font-bold text-orange-600 shrink-0">¥{Number(activePlugin.price_per_use || 0).toFixed(2)}/次</p>
                </div>
              ) : (
                <div className="text-center py-6 text-[var(--muted-foreground)]">
                  <span className="text-3xl block mb-2">🎬</span>
                  <p className="text-sm">三合一提取插件尚未启用</p>
                  <p className="text-xs mt-1">请在上方统一配置区选择并保存</p>
                </div>
              );
            })()}
          </div>

          {/* ====== 计费规则说明 ====== */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
              <span className="text-sm font-semibold text-[var(--foreground)]">计费规则</span>
              <div className="space-y-2 text-xs text-[var(--muted-foreground)]">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0" />
                  视频、单条文案、批量与搜索共用三合一插件单价
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
                  按成功返回的有效结果条数结算
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0" />
                  四项能力使用同一凭据、成本价与售价
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                  提取失败不扣费
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                  管理员与用户统一计费
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
              <span className="text-sm font-semibold text-[var(--foreground)]">当前生效</span>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--muted-foreground)]">三合一提取：</span>
                  {singleTextPlugins.find(p => p.is_active) ? (
                    <span className="text-sm font-bold text-teal-600">{singleTextPlugins.find(p => p.is_active)!.name}（¥{Number(singleTextPlugins.find(p => p.is_active)!.price_per_use || 0).toFixed(2)}/次）</span>
                  ) : (
                    <span className="text-sm text-amber-600">未启用，付费提交已关闭</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {["视频下载", "单条文案", "博主批量", "关键词搜索"].map((capability) => (
                    <span key={capability} className="text-[11px] px-2 py-1 rounded-full border border-[var(--border)] bg-[var(--muted)]/45 text-[var(--muted-foreground)]">{capability}</span>
                  ))}
                </div>
              </div>
              <p className="text-[10px] text-[var(--muted-foreground)] mt-2">
                单价和凭据在「插件管理」中设置；此处激活一次，四项能力同步生效
              </p>
            </div>
          </div>
        </div>
      ) : loading ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">
          <svg className="animate-spin w-6 h-6 mx-auto mb-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          加载中...
        </div>
      ) : filteredModels.length === 0 ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">
          <span className="text-4xl block mb-3">{tc.icon}</span>
          <p className="text-lg font-medium">暂无{tc.label}</p>
          {!canManageModels ? (
            <p className="text-sm mt-1">当前没有可查看的模型</p>
          ) : activeType === "text" ? (
            <p className="text-sm mt-1">点击「添加对话模型」创建你的第一个对话模型</p>
          ) : (
            <p className="text-sm mt-1">点击「添加模型」添加你的第一个{tc.label.replace("模型", "")}模型</p>
          )}
          {canManageModels && activeType === "video" && typeCounts.video === 0 && (
            <button
              onClick={() => handleAdd("video")}
              className="mt-4 px-5 py-2.5 rounded-lg bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold hover:opacity-90 transition"
            >
              + 添加第一个视频模型
            </button>
          )}
          {canManageModels && activeType === "drawing" && typeCounts.drawing === 0 && (
            <button
              onClick={() => handleAdd("drawing")}
              className="mt-4 px-5 py-2.5 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 text-white font-bold hover:opacity-90 transition"
            >
              + 添加第一个绘图模型
            </button>
          )}
          {canManageModels && activeType === "text" && typeCounts.text === 0 && (
            <button
              onClick={() => handleAdd("text")}
              className="mt-4 px-5 py-2.5 rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-bold hover:opacity-90 transition"
            >
              + 添加第一个对话模型
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* ── 封面工作流插件选择器（仅绘图模型Tab显示） ── */}
          {canManagePlugins && activeType === "drawing" && coverPlugins.length > 0 && (
            <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center text-base">🔄</div>
                <div>
                  <h4 className="text-sm font-bold text-[var(--foreground)]">封面工作流插件</h4>
                  <p className="text-[10px] text-[var(--muted-foreground)]">选择封面生成使用的工作流插件，也可直接使用下方绘图模型</p>
                </div>
              </div>
              <div className="space-y-2">
                {coverPlugins.map((p) => {
                  const isActive = p.is_active;
                  return (
                    <div
                      key={p.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                        isActive
                          ? "border-purple-500/40 bg-purple-500/10"
                          : "border-[var(--border)] bg-[var(--card)] hover:border-[var(--foreground)]/20"
                      }`}
                    >
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isActive ? "bg-purple-500" : "bg-[var(--muted-foreground)]/30"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-[var(--foreground)]">{p.name}</span>
                          {isActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-600 font-bold">生效中</span>}
                        </div>
                        {p.description && <p className="text-[10px] text-[var(--muted-foreground)] truncate">{p.description}</p>}
                      </div>
                      <span className="text-xs font-bold text-purple-600 shrink-0">¥{Number(p.price_per_use || 0).toFixed(2)}/次</span>
                      {!isActive && (
                        <button
                          onClick={() => handleSavePlugin(p.id, p.role, "cover")}
                          disabled={pluginSaving === "cover"}
                          className="px-3 py-1 rounded-lg border border-purple-500/30 text-purple-600 text-[10px] font-bold hover:bg-purple-500/10 transition disabled:opacity-50 shrink-0"
                        >
                          {pluginSaving === "cover" ? "切换中..." : "切换"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {filteredModels.map((m) => renderModelCard(m))}
        </div>
      )}

      {/* ── 统计摘要 ── */}
      {!loading && models.length > 0 && (
        <div className={`grid gap-3 mt-4 ${visibleModelTypes.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
          {visibleModelTypes.map((type) => {
            const cfg = MODEL_TYPE_CONFIG[type];
            const count = typeCounts[type] || 0;
            const activeCount = models.filter(m => String(m.model_type) === type && isOperationalActive(m)).length;
            return (
              <div key={type} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-center">
                <span className="text-xl">{cfg.icon}</span>
                {type === "extract" ? (
                  <>
                    <div className={`text-lg font-bold ${cfg.color}`}>
                      {singleTextPlugins.find(p => p.is_active)
                        ? `¥${Number(singleTextPlugins.find(p => p.is_active)?.price_per_use || 0).toFixed(2)}`
                        : canManagePaymentSettings && extractPrice
                          ? `¥${Number(extractPrice).toFixed(2)}`
                          : "未配置"}
                    </div>
                    <div className="text-xs text-[var(--muted-foreground)]">{cfg.label}</div>
                    <div className="text-[10px] text-teal-500 mt-0.5">共享插件 {singleTextPlugins.filter(p => p.is_active).length}/{singleTextPlugins.length} · 四项同源</div>
                  </>
                ) : (
                  <>
                    <div className={`text-lg font-bold ${cfg.color}`}>{count}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">{cfg.label}</div>
                    <div className="text-[10px] text-green-500 mt-0.5">{activeCount} 启用中</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── 模型编辑对话框 ── */}
      {canManageModels && validatingImage && token && (
        <AdminImageValidationDialog
          key={validatingImage.id}
          modelId={String(validatingImage.id)}
          modelName={validatingImage.display_name || validatingImage.name || validatingImage.model_name}
          token={token}
          onClose={() => setValidatingImage(null)}
          onPublished={() => { void loadModels(); onModelsChange?.(); }}
        />
      )}
      {canManageModels && validatingVideo && token && (
        <AdminVideoValidationDialog
          key={validatingVideo.id}
          modelId={String(validatingVideo.id)}
          modelName={validatingVideo.display_name || validatingVideo.name || validatingVideo.model_name}
          listedPrice={validatingVideo.selling_price ?? validatingVideo.price_per_use}
          token={token}
          onClose={() => setValidatingVideo(null)}
          onPublished={() => { void loadModels(); onModelsChange?.(); }}
        />
      )}
      {canManageModels && showDialog && (
        <UnifiedModelDialog
          model={editingModel as Record<string, unknown> | null}
          modelType={dialogModelType as "drawing" | "text" | "video"}
          onSave={handleSave}
          onClose={() => { setShowDialog(false); setEditingModel(null); }}
          onTest={handleTest}
          testing={testingModelId !== null}
          token={token || undefined}
        />
      )}
    </div>
  );
}
