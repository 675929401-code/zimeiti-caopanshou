"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, FileImage, Film, LoaderCircle, Upload, WandSparkles } from "lucide-react";

import { COMMERCE_SESSION_READY_EVENT } from "@/app/commerce/commerce-auth-bridge";
import {
  COMMERCE_V2_DRAFT_SCHEMA,
  type ModelCapabilityProfile,
  type ProductionDraft,
  type ProductionMaterial,
  type ProductionPlan,
  type ProductionQuote,
} from "../domain/contracts";
import { assignDirectorMaterialRoles } from "../domain/director-material-contract";
import { compileProductionPlan } from "../domain/production-plan";
import "./workbench.css";

type PublicDirector = {
  key: string;
  name: string;
  description: string;
  category: string;
  recommended: boolean;
  isDefault: boolean;
  icon: string;
  registryVersion: string;
  promptVersion: string;
  outputProtocol: "director-script/v2";
  slots: Array<{ key: string; label: string; min: number; max: number; kinds: string[] }>;
};

type Catalog = {
  schema: "commerce-catalog/v2";
  workspaceKey: string;
  directors: PublicDirector[];
  models: { video: ModelCapabilityProfile[]; image: ModelCapabilityProfile[]; agent: ModelCapabilityProfile[] };
  boundaries: { paidSubmissionEnabled: boolean; reason: string };
};

type PlanResponse = { plan: ProductionPlan; planHash: string; sideEffects: Record<string, number> };
type QuoteResponse = {
  quote: ProductionQuote & { status: "quoted" | "expired" | "consumed"; createdAt: number };
  sideEffects: Record<string, number>;
  boundary: { confirmationEnabled: boolean; reason: string };
};
type DirectorMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "streaming" | "completed" | "failed" | "unknown";
  business?: { state: "needs_input" | "ready" | "invalid" | "legacy_unverified"; displayText: string; generationText?: string; error?: string };
};
type DirectorConversation = {
  id: string;
  latestScriptMessageId: string | null;
  activeJobId: string | null;
  messages: DirectorMessage[];
};
type DirectorQuoteResponse = {
  quote: { id: string; inputFingerprint: string; model: { displayName: string }; payableTotal: number; expiresAt: number };
  boundary: { confirmationEnabled: boolean; reason: string };
};
type PublicAsset = {
  id: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
  createdAt: number;
  source: "upload" | "generated";
  url: string;
};

function newVideoDraft(): ProductionDraft {
  return {
    schema: COMMERCE_V2_DRAFT_SCHEMA,
    id: crypto.randomUUID(),
    revision: 1,
    kind: "video",
    prompt: "",
    skillKey: "video-direct",
    modelId: null,
    materials: [],
    videoSettings: { aspectRatio: "9:16", resolution: "720p", durationSeconds: 10, generateAudio: true },
  };
}

function materialKind(type: string): ProductionMaterial["kind"] {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "audio";
}

function capabilitySummary(model: ModelCapabilityProfile) {
  const caps = model.capabilities;
  return [
    caps.resolutionOptions.join("/") || "清晰度由模型决定",
    caps.nativeDurations.length ? `原生 ${caps.nativeDurations.join("/")} 秒` : "原生时长未声明",
    caps.maxReferenceImages ? `参考图≤${caps.maxReferenceImages}` : "不接收参考图",
    caps.supportsSourceVideoInput ? `源视频≤${caps.maxReferenceVideos}` : "不接收源视频",
    caps.supportsGenerateAudioToggle ? "有声/静音可切换" : "声音开关未验证",
  ].join(" · ");
}

function temporaryCompatibility(draft: ProductionDraft, model: ModelCapabilityProfile) {
  try {
    const preview = compileProductionPlan({
      planId: "client-capability-preview",
      draft: { ...draft, modelId: model.id, prompt: draft.prompt.trim() || "能力核对占位" },
      model,
    });
    return preview.configurationIssues;
  } catch (error) {
    return [error instanceof Error ? error.message : "能力核对失败"];
  }
}

export function CommerceV2Workbench() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [draft, setDraft] = useState<ProductionDraft>(() => newVideoDraft());
  const [restored, setRestored] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [directorOpen, setDirectorOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savedAssets, setSavedAssets] = useState<PublicAsset[]>([]);
  const [directorConversation, setDirectorConversation] = useState<DirectorConversation | null>(null);
  const [directorQuote, setDirectorQuote] = useState<DirectorQuoteResponse | null>(null);
  const [directorBusy, setDirectorBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    let loaded = false;
    let loading = false;
    let retryAfterFlight = false;
    const loadCatalog = async () => {
      if (!active || loaded) return;
      if (loading) {
        retryAfterFlight = true;
        return;
      }
      loading = true;
      try {
        const response = await fetch("/api/commerce/v2/catalog", { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "新核心目录读取失败");
        const value = body as Catalog;
        if (!active) return;
        loaded = true;
        setCatalogError("");
        setCatalog(value);
        const key = `commerce-v2:${value.workspaceKey}:video-draft`;
        try {
          const saved = JSON.parse(localStorage.getItem(key) || "null") as ProductionDraft | null;
          const selected = saved?.schema === COMMERCE_V2_DRAFT_SCHEMA ? saved : newVideoDraft();
          const currentModel = value.models.video.find((model) => model.id === selected.modelId);
          const preferred = currentModel || value.models.video.find((model) => model.available) || value.models.video[0];
          setDraft({
            ...selected,
            modelId: preferred?.id || null,
            ...(selected.director ? { director: { ...selected.director, conversationId: selected.director.conversationId || crypto.randomUUID() } } : {}),
          });
        } catch {
          const preferred = value.models.video.find((model) => model.available) || value.models.video[0];
          setDraft({ ...newVideoDraft(), modelId: preferred?.id || null });
        }
        setRestored(true);
      } catch (error) {
        if (active) setCatalogError(error instanceof Error ? error.message : "新核心目录读取失败");
      } finally {
        loading = false;
        if (retryAfterFlight && !loaded) {
          retryAfterFlight = false;
          void loadCatalog();
        }
      }
    };
    const handleSessionReady = () => { void loadCatalog(); };
    window.addEventListener(COMMERCE_SESSION_READY_EVENT, handleSessionReady);
    // Existing commerce cookies also work when the main-site bridge is absent;
    // wait before probing so a normal first visit never races session binding.
    const fallback = window.setTimeout(handleSessionReady, 4_000);
    return () => {
      active = false;
      window.clearTimeout(fallback);
      window.removeEventListener(COMMERCE_SESSION_READY_EVENT, handleSessionReady);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let loaded = false;
    const loadAssets = async () => {
      if (!active || loaded) return;
      try {
        const response = await fetch("/api/commerce/v2/assets", { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "资产库读取失败");
        if (!active) return;
        loaded = true;
        setSavedAssets(body.assets as PublicAsset[]);
      } catch { /* 资产库失败不覆盖模型目录或本地草稿错误。 */ }
    };
    const handleSessionReady = () => { void loadAssets(); };
    window.addEventListener(COMMERCE_SESSION_READY_EVENT, handleSessionReady);
    const fallback = window.setTimeout(handleSessionReady, 4_000);
    return () => {
      active = false;
      window.clearTimeout(fallback);
      window.removeEventListener(COMMERCE_SESSION_READY_EVENT, handleSessionReady);
    };
  }, []);

  useEffect(() => {
    if (!catalog || !restored) return;
    localStorage.setItem(`commerce-v2:${catalog.workspaceKey}:video-draft`, JSON.stringify(draft));
  }, [catalog, draft, restored]);

  const selectedModel = catalog?.models.video.find((model) => model.id === draft.modelId) || null;
  const selectedDirector = catalog?.directors.find((director) => director.key === draft.director?.skillKey) || null;
  const modelRows = useMemo(() => (catalog?.models.video || []).map((model) => ({
    model,
    issues: temporaryCompatibility(draft, model),
  })), [catalog, draft]);

  function revise(patch: Partial<ProductionDraft>) {
    setDraft((current) => ({ ...current, ...patch, revision: current.revision + 1 }));
    setPlan(null);
    setQuote(null);
    setDirectorQuote(null);
  }

  function chooseDirector(director: PublicDirector | null) {
    revise(director ? {
      skillKey: director.key,
      materials: assignDirectorMaterialRoles(draft.materials, director.slots),
      director: {
        skillKey: director.key,
        registryVersion: director.registryVersion,
        promptVersion: director.promptVersion,
        outputProtocol: director.outputProtocol,
        conversationId: crypto.randomUUID(),
      },
    } : {
      skillKey: "video-direct",
      director: undefined,
      materials: draft.materials.map((material) => ({
        ...material,
        role: material.kind === "audio" ? "voice" : material.kind === "video" ? "source-video" : "reference-image",
      })),
    });
    setDirectorConversation(null);
    setDirectorQuote(null);
    setDirectorOpen(false);
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = [...files].slice(0, Math.max(0, 15 - draft.materials.length));
    if (!selected.length) return;
    setUploading(true);
    setNotice("正在校验文件字节并保存到当前账号资产库…");
    try {
      const uploaded: PublicAsset[] = [];
      for (const file of selected) {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch("/api/commerce/v2/assets", { method: "POST", body: form });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `素材“${file.name}”保存失败`);
        uploaded.push(body.asset as PublicAsset);
      }
      const additions = uploaded.map(assetMaterial);
      const nextMaterials = [...draft.materials, ...additions];
      revise({ materials: selectedDirector ? assignDirectorMaterialRoles(nextMaterials, selectedDirector.slots) : nextMaterials });
      setSavedAssets((current) => [...uploaded, ...current.filter((item) => !uploaded.some((asset) => asset.id === item.id))]);
      setNotice(`${uploaded.length} 个素材已完成字节校验、资产落盘和身份绑定；未调用模型或钱包。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "素材保存失败");
    } finally {
      setUploading(false);
    }
  }

  function assetMaterial(asset: PublicAsset): ProductionMaterial {
    const kind = materialKind(asset.type);
    return {
      instanceId: crypto.randomUUID(),
      assetId: asset.id,
      name: asset.name,
      kind,
      role: kind === "audio" ? "voice" : kind === "video" ? "source-video" : "reference-image",
      source: "asset-library",
      mimeType: asset.type,
      size: asset.size,
      sha256: asset.sha256,
    };
  }

  function addSavedAsset(asset: PublicAsset) {
    if (draft.materials.length >= 15) return setNotice("当前草稿最多选择 15 个素材。");
    if (draft.materials.some((item) => item.assetId === asset.id)) return setNotice("这个资产已经在当前草稿中。");
    const nextMaterials = [...draft.materials, assetMaterial(asset)];
    revise({ materials: selectedDirector ? assignDirectorMaterialRoles(nextMaterials, selectedDirector.slots) : nextMaterials });
    setNotice("已从资产库绑定素材；生产计划会在服务端重新核对归属和字节哈希。");
  }

  async function inspectPlan() {
    setPlanning(true);
    setNotice("");
    try {
      const response = await fetch("/api/commerce/v2/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "生产计划核对失败");
      setPlan(body as PlanResponse);
      setNotice(body.plan.confirmable ? "生产计划通过；付费提交仍保持关闭。" : "计划已生成，请按右侧问题补齐后再报价。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "生产计划核对失败");
    } finally {
      setPlanning(false);
    }
  }

  async function createQuoteSnapshot() {
    if (!plan?.plan.confirmable) return;
    setPlanning(true);
    setNotice("");
    try {
      const response = await fetch("/api/commerce/v2/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "报价快照创建失败");
      setQuote(body as QuoteResponse);
      setNotice("报价快照已保存并可读回；没有调用钱包、供应商或生成任务。");
    } catch (error) {
      setQuote(null);
      setNotice(error instanceof Error ? error.message : "报价快照创建失败");
    } finally {
      setPlanning(false);
    }
  }

  async function prepareDirectorQuote() {
    if (!selectedDirector || !draft.director?.conversationId) return;
    setDirectorBusy(true);
    setNotice("");
    try {
      const openResponse = await fetch("/api/commerce/v2/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", draft }),
      });
      const opened = await openResponse.json();
      if (!openResponse.ok) throw new Error(opened.error || "编导会话打开失败");
      setDirectorConversation(opened.conversation as DirectorConversation);
      const quoteResponse = await fetch("/api/commerce/v2/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "quote",
          draft,
          operationId: crypto.randomUUID(),
          expectedScriptMessageId: opened.conversation.latestScriptMessageId,
        }),
      });
      const quoted = await quoteResponse.json();
      if (!quoteResponse.ok) throw new Error(quoted.error || "编导报价失败");
      setDirectorQuote(quoted as DirectorQuoteResponse);
      setNotice("编导本轮报价已冻结；没有预扣、模型推理或付费调用。");
    } catch (error) {
      setDirectorQuote(null);
      setNotice(error instanceof Error ? error.message : "编导报价失败");
    } finally {
      setDirectorBusy(false);
    }
  }

  async function applyDirectorMessage(message: DirectorMessage) {
    if (!draft.director?.conversationId || !directorConversation) return;
    setDirectorBusy(true);
    try {
      const response = await fetch("/api/commerce/v2/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          draft,
          messageId: message.id,
          expectedScriptMessageId: directorConversation.latestScriptMessageId,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "编导脚本应用失败");
      revise({
        director: {
          ...draft.director,
          messageId: body.application.messageId,
          applicationId: body.application.id,
          script: body.application.script,
        },
      });
      setNotice("编导脚本已经按来源消息、配置和素材快照绑定到当前视频草稿。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "编导脚本应用失败");
    } finally {
      setDirectorBusy(false);
    }
  }

  const videoSettings = draft.videoSettings!;
  const resolutionOptions = selectedModel?.capabilities.resolutionOptions.length ? selectedModel.capabilities.resolutionOptions : ["720p"];
  const ratioOptions = selectedModel?.capabilities.aspectRatios.length ? selectedModel.capabilities.aspectRatios : ["16:9", "9:16", "1:1"];
  const durationOptions = selectedModel
    ? [...new Set([...selectedModel.capabilities.nativeDurations, ...(selectedModel.capabilities.supportsRollingContinuation ? [30, 60, 70, 80] : [])])].sort((a, b) => a - b)
    : [10];

  return <main className="cv2-root" data-testid="commerce-v2-workbench">
    <header className="cv2-header">
      <div><span className="cv2-eyebrow">带货 Agent · 新核心</span><h1>视频生产工作台</h1><p>素材、编导、模型、设置和生产状态使用同一份版本化合同。</p></div>
      <div className="cv2-boundary"><span>当前阶段</span><strong>零费用生产计划</strong><small>{catalog?.boundaries.reason || "正在读取执行边界…"}</small></div>
    </header>

    {catalogError && <div className="cv2-alert" role="alert"><AlertCircle size={18}/>{catalogError}</div>}
    <div className="cv2-grid">
      <section className="cv2-editor">
        <div className="cv2-toolbar">
          <div className="cv2-popover-anchor">
            <button type="button" aria-expanded={directorOpen} onClick={() => { setDirectorOpen((value) => !value); setModelOpen(false); setSettingsOpen(false); }}><WandSparkles size={17}/><span>创作方式<strong>{selectedDirector?.name || "直接创作"}</strong></span><ChevronDown size={15}/></button>
            {directorOpen && <div className="cv2-popover cv2-directors" role="dialog" aria-label="选择超级编导"><button className={!selectedDirector ? "selected" : ""} onClick={() => chooseDirector(null)}><strong>直接创作</strong><small>不经过编导对话，直接核对视频提示词</small></button>{catalog?.directors.map((director) => <button key={director.key} className={selectedDirector?.key === director.key ? "selected" : ""} onClick={() => chooseDirector(director)}><strong>{director.name}</strong><small>{director.category} · {director.description}</small></button>)}</div>}
          </div>
          <button className="cv2-new" onClick={() => { setDraft({ ...newVideoDraft(), modelId: catalog?.models.video.find((item) => item.available)?.id || null }); setPlan(null); setQuote(null); }}>新建</button>
        </div>

        {selectedDirector && <div className="cv2-director-state"><strong>{selectedDirector.name}</strong><span>19 编导固定目录 · 提示词版本 {selectedDirector.promptVersion.slice(0, 10)}</span><small>素材职责、会话、报价、回复校验和脚本应用使用同一版本绑定；真实推理仍等待费用授权。</small>{directorConversation?.messages.length ? <div className="cv2-director-history">{directorConversation.messages.slice(-4).map((message) => <article key={message.id}><b>{message.role === "user" ? "你" : selectedDirector.name}</b><p>{message.business?.displayText || message.content || (message.status === "pending" ? "等待回复…" : "")}</p>{message.role === "assistant" && message.status === "completed" && message.business?.state === "ready" && directorConversation.latestScriptMessageId === message.id && <button disabled={directorBusy} onClick={() => void applyDirectorMessage(message)}>应用这个脚本</button>}</article>)}</div> : null}<button className="cv2-director-quote" disabled={directorBusy || !draft.prompt.trim()} onClick={() => void prepareDirectorQuote()}>{directorBusy ? "正在核对…" : "核对本轮编导报价"}</button>{directorQuote && <div className="cv2-director-price"><span>{directorQuote.quote.model.displayName} · ¥{directorQuote.quote.payableTotal.toFixed(4)}</span><small>{directorQuote.boundary.reason}</small><button disabled>确认并生成编导回复（当前关闭）</button></div>}</div>}

        <div className="cv2-materials">
          <div className="cv2-section-title"><span>参考素材</span><small>{draft.materials.length} / 15</small></div>
          <div className="cv2-material-list">{draft.materials.map((material) => <article key={material.instanceId}><span>{material.kind === "image" ? <FileImage size={18}/> : <Film size={18}/>}</span><div><strong>{material.name}</strong>{selectedDirector ? <select aria-label={`${material.name}的素材职责`} value={selectedDirector.slots.some((slot) => slot.key === material.role) ? material.role : ""} onChange={(event) => revise({ materials: draft.materials.map((item) => item.instanceId === material.instanceId ? { ...item, role: event.target.value } : item) })}><option value="">选择素材职责</option>{selectedDirector.slots.filter((slot) => slot.kinds.includes(material.kind)).map((slot) => <option key={slot.key} value={slot.key}>{slot.label}（{slot.min}–{slot.max}）</option>)}</select> : <small>{material.role}</small>}<small>{material.assetId ? "已持久化" : "本轮临时素材"}</small></div><button aria-label={`移除 ${material.name}`} onClick={() => revise({ materials: draft.materials.filter((item) => item.instanceId !== material.instanceId) })}>×</button></article>)}<button disabled={uploading} className="cv2-add-material" onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle className="cv2-spin" size={20}/> : <Upload size={20}/>}<span>{uploading ? "正在保存素材" : "上传并保存素材"}</span></button></div>
          <input ref={fileInput} hidden multiple type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/webm" onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }}/>
          <div className="cv2-asset-library"><div><strong>当前账号资产库</strong><small>选择后绑定稳定资产 ID，刷新不会丢失</small></div>{savedAssets.length ? <div>{savedAssets.slice(0, 8).map((asset) => <button type="button" key={asset.id} disabled={draft.materials.some((item) => item.assetId === asset.id)} onClick={() => addSavedAsset(asset)}><span>{asset.name}</span><small>{asset.type.split("/")[0]} · {(asset.size / 1024 / 1024).toFixed(1)} MB</small></button>)}</div> : <p>资产库暂无可用素材，可先上传。</p>}</div>
        </div>

        <label className="cv2-prompt"><span>{selectedDirector ? "给编导的创作要求" : "视频创作要求"}</span><textarea value={draft.prompt} maxLength={20_000} onChange={(event) => revise({ prompt: event.target.value })} placeholder="说明商品、人物、场景、镜头、声音和转化目标；只写已确认事实。"/><small>{draft.prompt.length} / 20000</small></label>

        <div className="cv2-controls">
          <div className="cv2-popover-anchor">
            <button type="button" data-testid="commerce-v2-model-trigger" aria-expanded={modelOpen} onClick={() => { setModelOpen((value) => !value); setDirectorOpen(false); setSettingsOpen(false); }}><span>模型<strong>{selectedModel?.displayName || "尚未配置"}</strong></span><ChevronDown size={15}/></button>
            {modelOpen && <div className="cv2-popover cv2-models" role="dialog" aria-label="选择视频模型">{modelRows.length ? modelRows.map(({ model, issues }) => <button key={model.id} disabled={issues.length > 0} className={model.id === draft.modelId ? "selected" : ""} onClick={() => { revise({ modelId: model.id }); setModelOpen(false); }}><strong>{model.displayName}</strong><small>{capabilitySummary(model)}</small><em>{issues.length ? issues.join("；") : model.executionReady ? "当前输入兼容，执行已验收" : `当前输入兼容；${model.readinessMessage}`}</em></button>) : <p>主站模型目录尚未配置视频模型。</p>}</div>}
          </div>
          <div className="cv2-popover-anchor">
            <button type="button" data-testid="commerce-v2-settings-trigger" aria-expanded={settingsOpen} onClick={() => { setSettingsOpen((value) => !value); setDirectorOpen(false); setModelOpen(false); }}><span>视频设置<strong>{videoSettings.aspectRatio} · {videoSettings.resolution} · {videoSettings.durationSeconds}s · {videoSettings.generateAudio ? "含音频" : "静音"}</strong></span><ChevronDown size={15}/></button>
            {settingsOpen && <div className="cv2-popover cv2-settings" role="dialog" aria-label="视频设置"><fieldset><legend>画幅</legend>{ratioOptions.map((value) => <button key={value} className={videoSettings.aspectRatio === value ? "selected" : ""} onClick={() => revise({ videoSettings: { ...videoSettings, aspectRatio: value } })}>{value}</button>)}</fieldset><fieldset><legend>清晰度</legend>{resolutionOptions.map((value) => <button key={value} className={videoSettings.resolution.toLowerCase() === value.toLowerCase() ? "selected" : ""} onClick={() => revise({ videoSettings: { ...videoSettings, resolution: value } })}>{value}</button>)}</fieldset><fieldset><legend>时长</legend>{durationOptions.map((value) => <button key={value} className={videoSettings.durationSeconds === value ? "selected" : ""} onClick={() => revise({ videoSettings: { ...videoSettings, durationSeconds: value } })}>{value}s</button>)}</fieldset><fieldset><legend>声音</legend><button className={videoSettings.generateAudio ? "selected" : ""} onClick={() => revise({ videoSettings: { ...videoSettings, generateAudio: true } })}>含音频</button><button className={!videoSettings.generateAudio ? "selected" : ""} onClick={() => revise({ videoSettings: { ...videoSettings, generateAudio: false } })}>静音</button></fieldset></div>}
          </div>
        </div>

        <button className="cv2-primary" disabled={planning || !catalog || !draft.modelId} onClick={() => void inspectPlan()}>{planning ? <><LoaderCircle className="cv2-spin" size={18}/>正在核对</> : <>核对生产计划<small>不生成、不扣费</small></>}</button>
        {notice && <p className="cv2-notice" role="status">{notice}</p>}
      </section>

      <aside className="cv2-plan" aria-label="生产计划">
        <div className="cv2-section-title"><span>生产计划</span>{plan && <small>{plan.plan.planId.slice(0, 8)}</small>}</div>
        {!plan ? <div className="cv2-empty"><Film size={32}/><strong>等待核对</strong><p>这里会显示真实模型能力、分段、连续性、素材持久化和执行门禁。</p></div> : <>
          <div className={plan.plan.confirmable ? "cv2-plan-state ready" : "cv2-plan-state blocked"}>{plan.plan.confirmable ? <CheckCircle2 size={19}/> : <AlertCircle size={19}/>}<div><strong>{plan.plan.confirmable ? "计划合同通过" : "计划暂不可报价"}</strong><small>哈希 {plan.planHash.slice(0, 12)}</small></div></div>
          <dl><div><dt>模型快照</dt><dd>{plan.plan.model.displayName}<small>{plan.plan.model.configHash.slice(0, 12) || "无配置哈希"}</small></dd></div><div><dt>目标设置</dt><dd>{"durationSeconds" in plan.plan.settings ? `${plan.plan.settings.durationSeconds}s · ${plan.plan.settings.aspectRatio} · ${plan.plan.settings.resolution}` : `${plan.plan.settings.aspectRatio} · ${plan.plan.settings.resolution}`}</dd></div><div><dt>分段计划</dt><dd>{plan.plan.segments.map((segment) => `${segment.durationSeconds}s`).join(" + ")}<small>{plan.plan.segments.some((segment) => segment.continuitySource === "previous-final-frame") ? "真实尾帧续接" : "单段原生生成"}</small></dd></div></dl>
          {!!plan.plan.configurationIssues.length && <section><h2>配置问题</h2><ul>{plan.plan.configurationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></section>}
          {!!plan.plan.executionIssues.length && <section><h2>执行问题</h2><ul>{plan.plan.executionIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></section>}
          {!!plan.plan.warnings.length && <section><h2>计划说明</h2><ul>{plan.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>}
          {plan.plan.confirmable && !quote && <button className="cv2-quote" disabled={planning} onClick={() => void createQuoteSnapshot()}>{planning ? "正在冻结报价…" : "生成报价快照"}<small>仅保存快照，不预扣、不生成</small></button>}
          {quote && <div className="cv2-quote-card"><div><span>应付总额</span><strong>¥{quote.quote.payableTotal.toFixed(4)}</strong></div><dl><div><dt>计费</dt><dd>{quote.quote.quantity} × ¥{quote.quote.unitPrice.toFixed(4)}</dd></div><div><dt>有效期</dt><dd>{new Date(quote.quote.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</dd></div><div><dt>报价身份</dt><dd>{quote.quote.quoteId.slice(0, 12)}</dd></div></dl><p>{quote.boundary.reason}</p><button disabled>确认并开始生成（当前关闭）</button></div>}
          <div className="cv2-side-effects"><strong>{quote ? "报价快照副作用" : "本次核对副作用"}</strong><span>数据库 {quote ? "1（报价快照）" : "0"} · 钱包 0 · 供应商 0 · 付费生成 0</span></div>
        </>}
      </aside>
    </div>
  </main>;
}
