"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import {
  AlertCircle,
  CircleDollarSign,
  CopyPlus,
  LoaderCircle,
  LogIn,
  LogOut,
  PanelLeft,
  Sparkles,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ManualCanvas, type ManualCanvasDraftSnapshot } from "@/components/manual-canvas";
import { useApp } from "@/contexts/app-context";
import { canvasPublicAdmissionCapabilities, readCanvasPublicCatalog } from "@/lib/canvas-public-catalog-loader";
import { parseStoredWorkspace, STUDIO_STORAGE_KEY } from "@/lib/studio-storage";
import type {
  AspectRatio,
  CanvasVoiceOption,
  CanvasVoicePricing,
  CoverModel,
  StudioAsset,
  StoryboardCard,
  VideoModel,
} from "@/lib/studio-canvas-types";
import {
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
} from "@/lib/video-model-capabilities";
import {
  acknowledgeCanvasShowcaseReference,
  consumeInspirationCanvasReference,
  // Keep the historical call-site name while switching its implementation to
  // a non-destructive read. The handoff is consumed only after durable save.
  readCanvasShowcaseReference as consumeCanvasShowcaseReference,
  type InspirationCanvasHandoff,
} from "@/features/official-inspiration/canvas-handoff";
import {
  canvasScopedStorageKey,
  resolveCanvasAuthenticatedUserId,
  resolveCanvasStorageScope,
  rotateCanvasAnonymousScope,
  type CanvasStorageScope,
} from "@/lib/canvas-storage-scope";

const TOKEN_KEY = "auth_token";

type PublicRuntimeConfig = {
  defaults?: { imageModelId?: string; videoModelId?: string };
  health?: { disabledImageModelIds?: string[] };
};

function normalizePublicCanvasImageModel(value: unknown): CoverModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const capabilities = record.capabilities && typeof record.capabilities === "object"
    ? record.capabilities as Record<string, unknown>
    : {};
  const id = String(record.id || "").trim();
  if (!id) return null;
  const resolutionOptions = Array.isArray(capabilities.resolutionOptions)
    ? capabilities.resolutionOptions.map(String).filter(Boolean)
    : Array.isArray(record.resolution_options)
      ? record.resolution_options.map(String).filter(Boolean)
      : ["1K", "2K"];
  const defaultResolution = String(
    capabilities.defaultResolution
      || record.default_resolution
      || resolutionOptions[0]
      || "1K",
  );
  const supportsReferenceInput = Boolean(
    capabilities.supportsReferenceInput
      ?? capabilities.supportsImageInput
      ?? record.supports_reference_input
      ?? record.supports_image_input,
  );
  const maxReferenceImages = Math.max(0, Number(
    capabilities.maxReferenceImages ?? record.max_reference_images ?? 0,
  ) || 0);
  const maxCharacterReferences = Math.max(0, Number(
    capabilities.maxCharacterReferences ?? record.max_character_references ?? 0,
  ) || 0);
  const referenceInputMode = String(
    capabilities.referenceInputMode
      ?? record.reference_input_mode
      ?? (maxReferenceImages > 1 ? "multi" : supportsReferenceInput ? "single" : "none"),
  );
  const identityReferenceLevel = String(
    capabilities.identityReferenceLevel
      ?? record.identity_reference_level
      ?? (maxCharacterReferences > 1 ? "multi-subject" : supportsReferenceInput ? "single-subject" : "none"),
  );

  return {
    id,
    name: String(record.displayName || record.name || "图片模型"),
    model_name: id,
    provider: "platform_public",
    selling_price: Number(record.publicPrice ?? record.selling_price ?? 0) || 0,
    supports_image_input: supportsReferenceInput,
    supports_reference_input: supportsReferenceInput,
    reference_input_mode: referenceInputMode === "multi" ? "multi" : referenceInputMode === "single" ? "single" : "none",
    identity_reference_level: identityReferenceLevel === "multi-subject"
      ? "multi-subject"
      : identityReferenceLevel === "single-subject"
        ? "single-subject"
        : "none",
    max_reference_images: maxReferenceImages,
    max_character_references: maxCharacterReferences,
    reference_capability_label: String(capabilities.referenceCapabilityLabel ?? record.reference_capability_label ?? ""),
    capabilities: canvasPublicAdmissionCapabilities(record),
    resolution_options: resolutionOptions,
    default_resolution: resolutionOptions.includes(defaultResolution) ? defaultResolution : resolutionOptions[0],
  };
}

function normalizePublicCanvasVideoModel(value: unknown): VideoModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const capabilities = record.capabilities && typeof record.capabilities === "object"
    ? record.capabilities as Record<string, unknown>
    : {};
  const id = String(record.id || "").trim();
  if (!id) return null;

  const duration = getVideoDurationCapabilities({ ...record, ...capabilities });
  const resolution = getVideoResolutionCapabilities(record);
  const durationStep = Number(capabilities.durationStep);
  return {
    id,
    name: String(record.displayName || record.name || "视频模型"),
    modelName: id,
    // Public DTOs intentionally hide the internal channel/provider. Keep a
    // non-empty semantic provider so canvas retry policy never mistakes a
    // public model for an unidentified, provider-specific transport.
    provider: "platform_public",
    pricePerUse: Number(record.publicPrice ?? record.pricePerUse ?? 0) || 0,
    durationSeconds: duration.defaultDuration,
    minDuration: duration.minDuration,
    maxDuration: duration.maxDuration,
    durationMode: duration.mode,
    nativeDurations: duration.nativeDurations,
    durationStep: Number.isFinite(durationStep) && durationStep > 0 ? durationStep : 0.5,
    resolutionTier: resolution.defaultResolution,
    resolutionOptions: resolution.options,
    defaultResolution: resolution.defaultResolution,
    resolutionPrices: resolution.publicPrices,
    supportsImageInput: Boolean(capabilities.supportsImageInput ?? record.supportsImageInput),
    requiresImage: Boolean(capabilities.requiresImage ?? record.requiresImage),
    requiresSourceVideo: Boolean(capabilities.requiresSourceVideo ?? record.requiresSourceVideo),
    maxReferenceImages: Math.max(1, Number(capabilities.maxReferenceImages) || 1),
    supportsAudioInput: capabilities.supportsAudioInput === true,
    minReferenceAudios: Math.max(0, Number(capabilities.minReferenceAudios) || 0),
    maxReferenceAudios: Math.max(0, Number(capabilities.maxReferenceAudios) || 0),
    billingUnit: capabilities.billingUnit === "output_second" ? "output_second" : "per_use",
    workspaceSurfaces: Array.isArray(capabilities.workspaceSurfaces)
      ? capabilities.workspaceSurfaces.map(String)
      : ["ai-video"],
    supportsRemoteCancel: capabilities.supportsRemoteCancel !== false,
    aspectRatios: Array.isArray(capabilities.aspectRatios) ? capabilities.aspectRatios.map(String) : [],
    successRate: -1,
    capabilities: canvasPublicAdmissionCapabilities(record),
    api_protocol_config: {
      duration_step: Number.isFinite(durationStep) && durationStep > 0 ? durationStep : 0.5,
    },
  };
}

function normalizeCanvasVoiceOption(value: unknown): CanvasVoiceOption | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || "").trim();
  const speakerId = String(record.speakerId || "").trim();
  if (!id || !speakerId || record.isPublic === false) return null;
  return {
    id,
    name: String(record.name || speakerId),
    engine: String(record.engine || ""),
    speakerId,
    gender: String(record.gender || "unknown"),
    language: String(record.language || ""),
    category: String(record.category || ""),
    type: String(record.type || "official"),
    isPublic: record.isPublic !== false,
    isRecommended: typeof record.isRecommended === "boolean" ? record.isRecommended : null,
    description: typeof record.description === "string" ? record.description : undefined,
    styleTags: Array.isArray(record.styleTags) ? record.styleTags.map(String).filter(Boolean) : undefined,
  };
}

function normalizeCanvasVoicePricing(value: unknown): CanvasVoicePricing | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const modelId = String(record.modelId || "").trim();
  const sellPrice = Number(record.sellPrice);
  if (!modelId || !Number.isFinite(sellPrice) || sellPrice <= 0) return null;
  return {
    modelId,
    name: String(record.name || modelId),
    costPrice: Math.max(0, Number(record.costPrice) || 0),
    unit: String(record.unit || "次"),
    profitMargin: Math.max(0, Number(record.profitMargin) || 0),
    sellPrice,
  };
}

export function FreeCanvasShell({ expectedShowcaseId }: { expectedShowcaseId?: string }) {
  const { state, checkAuth, logout } = useApp();
  const [storyboards, setStoryboards] = useState<StoryboardCard[]>([]);
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [imageModels, setImageModels] = useState<CoverModel[]>([]);
  const [videoModels, setVideoModels] = useState<VideoModel[]>([]);
  const [voiceOptions, setVoiceOptions] = useState<CanvasVoiceOption[]>([]);
  const [voicePricing, setVoicePricing] = useState<CanvasVoicePricing[]>([]);
  const [defaultImageModelId, setDefaultImageModelId] = useState("");
  const [defaultVideoModelId, setDefaultVideoModelId] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [connectedUser, setConnectedUser] = useState("");
  const [connectedUserId, setConnectedUserId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [canvasHandoff, setCanvasHandoff] = useState<InspirationCanvasHandoff | null>(null);
  const [canvasDraft, setCanvasDraft] = useState<ManualCanvasDraftSnapshot | null>(null);
  const [canvasStorageScope, setCanvasStorageScope] = useState<CanvasStorageScope | null>(null);
  const [identityRevision, setIdentityRevision] = useState(0);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const loadedShowcaseScopesRef = useRef(new Set<string>());

  const handleNotice = useCallback((message: string | null) => setNotice(message), []);
  const handleRequireLogin = useCallback(() => setLoginOpen(true), []);
  const handleLocalDraftChange = useCallback((draft: ManualCanvasDraftSnapshot) => {
    setCanvasDraft(draft);
  }, []);
  const handleReferencePersisted = useCallback((referenceId: string) => {
    acknowledgeCanvasShowcaseReference(referenceId);
    setCanvasDraft((current) => current?.referenceId === referenceId ? null : current);
    setCanvasHandoff((current) => current?.inspirationId === referenceId ? null : current);
  }, []);

  const loadBalance = useCallback(async (token: string) => {
    const response = await fetch("/api/bridge/balance", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      setBalance(null);
      return;
    }
    const data = await response.json() as { balance?: number };
    setBalance(Number(data.balance ?? 0));
  }, []);
  const handleBalanceRefresh = useCallback(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) void loadBalance(token);
  }, [loadBalance]);

  useEffect(() => {
    const handleIdentityStorage = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY || event.key === "auth_user") {
        setIdentityRevision((current) => current + 1);
      }
    };
    window.addEventListener("storage", handleIdentityStorage);
    return () => window.removeEventListener("storage", handleIdentityStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resolveIdentity = async () => {
      try {
        let token = localStorage.getItem(TOKEN_KEY);
        let userId = resolveCanvasAuthenticatedUserId({
          token,
          appUserId: state.auth.user?.id,
          connectedUserId,
          cachedAuthUser: localStorage.getItem("auth_user"),
        });
        // Some local/dev sessions are opaque rather than JWTs. Do not consume a
        // handoff or mount anonymous autosave until the existing auth source has
        // had one chance to rebuild auth_user from /api/auth/me.
        if (token && !userId) {
          setWorkspaceReady(false);
          setCanvasStorageScope(null);
          await checkAuth();
          if (cancelled) return;
          token = localStorage.getItem(TOKEN_KEY);
          userId = resolveCanvasAuthenticatedUserId({
            token,
            appUserId: state.auth.user?.id,
            connectedUserId,
            cachedAuthUser: localStorage.getItem("auth_user"),
          });
        }
        const nextScope = resolveCanvasStorageScope(localStorage, userId);
        if (!cancelled) setCanvasStorageScope((current) => current === nextScope ? current : nextScope);
      } catch {
        if (!cancelled) setCanvasStorageScope("anonymous-storage-unavailable");
      }
    };
    void resolveIdentity();
    return () => { cancelled = true; };
  }, [checkAuth, connectedUserId, identityRevision, state.auth.user?.id]);

  useEffect(() => {
    if (!canvasStorageScope) return;
    setWorkspaceReady(false);
    const timer = window.setTimeout(() => {
      const studioStorageKey = canvasScopedStorageKey(STUDIO_STORAGE_KEY, canvasStorageScope);
      const saved = parseStoredWorkspace(localStorage.getItem(studioStorageKey));
      setStoryboards(saved.project.storyboards);
      setAssets(saved.project.assets);
      setAspectRatio(saved.project.settings.aspectRatio);
      if (expectedShowcaseId) {
        const loadKey = `${canvasStorageScope}:${expectedShowcaseId}`;
        if (!loadedShowcaseScopesRef.current.has(loadKey)) {
          loadedShowcaseScopesRef.current.add(loadKey);
          const replayableHandoff = consumeCanvasShowcaseReference(expectedShowcaseId);
          if (replayableHandoff) {
            setCanvasHandoff(replayableHandoff);
            setCanvasDraft((current) => current?.referenceId === expectedShowcaseId ? current : null);
          } else {
            setCanvasHandoff((current) => current?.inspirationId === expectedShowcaseId ? current : null);
            setCanvasDraft((current) => current?.referenceId === expectedShowcaseId ? current : null);
          }
        }
      } else {
        const inspirationHandoff = consumeInspirationCanvasReference();
        if (inspirationHandoff) {
          setCanvasHandoff(inspirationHandoff);
          setCanvasDraft((current) => current?.referenceId === inspirationHandoff.inspirationId ? current : null);
        }
      }
      setWorkspaceReady(true);
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) void loadBalance(token);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canvasStorageScope, expectedShowcaseId, loadBalance]);

  useEffect(() => {
    if (state.auth.isAuthenticated || localStorage.getItem(TOKEN_KEY)) return;
    setConnectedUser("");
    setConnectedUserId("");
    setBalance(null);
  }, [state.auth.isAuthenticated]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const failures = new Set<string>();
    let runtime: PublicRuntimeConfig | null = null;
    let images: CoverModel[] | null = null;
    let videos: VideoModel[] | null = null;
    const updateDefaults = () => {
      if (!active) return;
      if (images) {
        const disabled = new Set(runtime?.health?.disabledImageModelIds || []);
        setImageModels(images.map(model => ({ ...model, capabilities: { ...model.capabilities,
          catalogHealthReady: runtime !== null, ...(disabled.has(model.id) ? { available: false, availabilityMessage: "当前生图通道暂停，请手动选择其他模型" } : {}) } })));
        if (runtime) setDefaultImageModelId(runtime.defaults?.imageModelId || "");
      }
      if (videos) { setVideoModels(videos); if (runtime) setDefaultVideoModelId(runtime.defaults?.videoModelId || ""); }
    };
    const read = async (label: string, url: string, shape: "models" | "runtime" | "voices" | "pricing", apply: (value: Record<string, unknown>) => void) => {
      try { const value = await readCanvasPublicCatalog(url, shape, controller.signal); if (active) apply(value); }
      catch { if (active) { failures.add(label); setNotice(`目录读取失败：${[...failures].join("、")}；其他已读取内容保留。`); } }
    };
    void Promise.allSettled([
      read("图片模型", "/api/cover-models?surface=free-canvas", "models", value => { images = (value.models as unknown[]).map(normalizePublicCanvasImageModel).filter((model): model is CoverModel => model !== null); updateDefaults(); }),
      read("视频模型", "/api/video/models?surface=free-canvas", "models", value => { videos = (value.models as unknown[]).map(normalizePublicCanvasVideoModel).filter((model): model is VideoModel => model !== null); updateDefaults(); }),
      read("通道状态", "/api/bridge/runtime-config", "runtime", value => { runtime = value.config as PublicRuntimeConfig; updateDefaults(); }),
      read("音色", "/api/voice/list?limit=500&page=1", "voices", value => setVoiceOptions(((value.data as { voices: unknown[] }).voices).map(normalizeCanvasVoiceOption).filter((voice): voice is CanvasVoiceOption => voice !== null))),
      read("语音价格", "/api/voice/pricing", "pricing", value => setVoicePricing((value.data as unknown[]).map(normalizeCanvasVoicePricing).filter((pricing): pricing is CanvasVoicePricing => pricing !== null))),
    ]);
    return () => { active = false; controller.abort(); };
  }, []);

  const accountConnected = useMemo(
    () => Boolean(state.auth.isAuthenticated || connectedUser || balance !== null),
    [balance, connectedUser, state.auth.isAuthenticated],
  );
  const noticeIsPositive = Boolean(notice && /^(?:正在|已)|已(?:生成|保存|切换|搭建|执行完成)/u.test(notice));
  const noticeIsWarning = Boolean(notice && /^(?:规则预览|生成能力提示)/u.test(notice));

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/bridge/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginName, password: loginPassword }),
      });
      const data = await response.json() as { token?: string; error?: string; user?: { id?: string; displayName?: string; username?: string } };
      if (!response.ok || !data.token) throw new Error(data.error || "连接失败");
      localStorage.setItem(TOKEN_KEY, data.token);
      setConnectedUser(data.user?.displayName || data.user?.username || loginName);
      setConnectedUserId(data.user?.id || "");
      setLoginPassword("");
      setLoginOpen(false);
      await Promise.all([loadBalance(data.token), checkAuth()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "连接失败");
    } finally {
      setLoginBusy(false);
    }
  }

  function disconnect() {
    logout();
    try {
      setCanvasStorageScope(rotateCanvasAnonymousScope(localStorage));
    } catch {
      setCanvasStorageScope("anonymous-storage-unavailable");
    }
    setConnectedUser("");
    setConnectedUserId("");
    setBalance(null);
  }

  return (
    <main
      className="free-page"
      data-canvas-shell="free-canvas"
      data-expected-showcase-id={expectedShowcaseId}
      data-imported-showcase-id={canvasHandoff?.inspirationId || canvasDraft?.referenceId}
      data-storage-scope={canvasStorageScope}
    >
      <header className="topbar free-page-header">
        <div className="brand-block">
          <div className="brand-mark free-brand-mark"><Sparkles size={18} /></div>
          <div><strong>AI 自由画布</strong><span>流程编排 · 分镜草稿 · 批量生成</span></div>
        </div>
        <nav className="mode-switch" aria-label="创作模式">
          <Link href="/"><PanelLeft size={15} />智能工程</Link>
          <Link className="active" href="/free-canvas"><CopyPlus size={15} />自由画布</Link>
        </nav>
        <div className="account-actions">
          <div className="balance"><CircleDollarSign size={16} /><span>{balance === null ? "--" : `¥${balance.toFixed(2)}`}</span></div>
          {accountConnected ? (
            <button className="icon-button" type="button" onClick={disconnect} title="断开主平台"><LogOut size={18} /></button>
          ) : (
            <button className="text-button" type="button" onClick={() => setLoginOpen(true)}><LogIn size={17} />连接主平台</button>
          )}
        </div>
      </header>

      {notice && <div className={`notice-bar free-page-notice ${noticeIsWarning ? "is-warning" : noticeIsPositive ? "is-positive" : ""}`}><AlertCircle size={16} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} title="关闭"><X size={16} /></button></div>}

      <div className="free-page-canvas">
        {workspaceReady ? (
          <ManualCanvas
            key={`${canvasStorageScope}:${expectedShowcaseId || canvasHandoff?.inspirationId || "default"}`}
            storyboards={storyboards}
            assets={assets}
            imageModels={imageModels}
            videoModels={videoModels}
            voiceOptions={voiceOptions}
            voicePricing={voicePricing}
            defaultImageModelId={defaultImageModelId}
            defaultVideoModelId={defaultVideoModelId}
            defaultAspectRatio={aspectRatio}
            initialReference={canvasHandoff}
            initialDraft={canvasDraft}
            preferredReferenceId={expectedShowcaseId || canvasHandoff?.inspirationId}
            storageScope={canvasStorageScope!}
            onNotice={handleNotice}
            onRequireLogin={handleRequireLogin}
            onBalanceRefresh={handleBalanceRefresh}
            onLocalDraftChange={handleLocalDraftChange}
            onReferencePersisted={handleReferencePersisted}
          />
        ) : (
          <div role="status" aria-live="polite">正在载入画布...</div>
        )}
      </div>

      {loginOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="dialog login-dialog" onSubmit={handleLogin}>
            <button className="dialog-close" type="button" onClick={() => setLoginOpen(false)} title="关闭"><X size={18} /></button>
            <div className="dialog-icon"><LogIn size={22} /></div>
            <h2>连接主平台</h2>
            <label className="field-group"><span>手机号或用户名</span><input value={loginName} onChange={(event) => setLoginName(event.target.value)} autoComplete="username" required /></label>
            <label className="field-group"><span>密码</span><input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" required /></label>
            <button className="primary-button full-button" type="submit" disabled={loginBusy}>{loginBusy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}连接</button>
          </form>
        </div>
      )}
    </main>
  );
}
