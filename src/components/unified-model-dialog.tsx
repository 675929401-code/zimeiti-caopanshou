"use client";
import { createPortal } from "react-dom";
import { modelEndpointError, modelStationLabel } from "@/lib/model-endpoint";
import { useState, useEffect, useCallback, useRef } from "react";
import { formatModelPrice, modelConnectionSummary } from "@/lib/model-connection-summary";
import { getVideoBillingUnit } from "@/lib/video-model-capabilities";

// ── 视频协议选项 ──
const VIDEO_PROTOCOLS = [
  { value: "secure_skill_doubao_seedance", label: "渠道 A · Seedance 官方 Token", desc: "POST /api/v3/contents/generations/tasks；分组 37 专用密钥；按最终 Token 用量结算" },
  { value: "secure_skill_seedance_video", label: "Secure Skill · Seedance 2.5", desc: "POST /v1/videos；同密钥轮询；图片/视频/音频混合参考" },
  { value: "gaorui_video", label: "渠道 C · 高瑞视频", desc: "POST /v1/videos → GET /v1/videos/{id}" },
  { value: "secure_skill_video", label: "渠道 A · MiniMax H3", desc: "POST /v1/videos → GET /v1/videos/{id}" },
  { value: 'dashscope_wan_s2v', label: '阿里万相 · 照片说话', desc: '人像检测 → 照片与配音生成 → 原任务查询' },
  { value: 'dashscope_video_retalk', label: '阿里声动人像 · 视频改口型', desc: '源视频与新配音 → 原任务查询' },
  { value: 'volcengine_digital_human', label: '火山视觉 · 数字人', desc: 'AK/SK 签名；支持视频改口型和即梦 OmniHuman1.5 照片说话' },
  { value: "autodl_comfyui_workflow", label: "AutoDL官方 ComfyUI 工作流", desc: "按 workflow_id 精确映射输入；POST workflow → GET result/{task_id}" },
  { value: "autodl_comfyui_h3", label: "AutoDL托管渠道 · MiniMax H3", desc: "独立于其他 H3 中转渠道；POST workflow → GET result/{task_id}" },
  { value: "autodl_h3_selfhost", label: "AutoDL自租实例 · MiniMax H3", desc: "独立 Bearer 网关；POST /v1/video/generations → GET 同路径/{id}" },
  { value: "secure_skill_grok_video", label: "渠道A Grok 视频", desc: "POST /v1/videos -> GET /v1/videos/{id}" },
  { value: "secure_skill_flow_jobs", label: "渠道A Flow 视频", desc: "VEO / Omni：POST /v1/jobs → GET /v1/jobs/{id}" },
  { value: "secure_skill_wan3_video", label: "渠道A Wan3 视频", desc: "POST /v1/videos/generations → GET /v1/videos/tasks/{id}" },
  { value: "yunwu_video", label: "云雾视频统一格式", desc: "POST /v1/video/create → GET /v1/video/query" },
  { value: "grok_video", label: "Grok 视频（同步）", desc: "chat/completions 同步返回视频URL" },
  { value: "unified_video", label: "视频统一格式（异步）", desc: "chat/completions 异步返回 task_id" },
  { value: "kling_official", label: "可灵官方API", desc: "POST /kling/v1/videos/text2video → 轮询" },
  { value: "veo_newapi", label: "Veo NewAPI", desc: "POST /v1/videos → GET /v1/videos/{id}" },
  { value: "siliconflow_kling", label: "硅基流动 · 可灵", desc: "POST /v1/video/kling/generations" },
  { value: "siliconflow_vidu", label: "硅基流动 · Vidu", desc: "POST /v1/video/vidu/generations" },
  { value: "runway", label: "Runway", desc: "POST /v1/image_to_video" },
  { value: "openai_compatible", label: "OpenAI 兼容格式", desc: "标准 /v1/video/generations" },
];

const AUTODL_H3_ADMIN_NOTES = [
  "【内部渠道备注｜仅管理员可见】",
  "供应商：AutoDL.Art 托管 ComfyUI 工作流；工作流 ID：minimax_h3_image_audio_to_video_v2。",
  "计费口径：成本价字段填写默认 768p 的单秒成本 ¥0.07，不是 10 秒总成本；系统按实际提交时长结算。",
  "分档成本：480p ¥0.05/输出秒；768p ¥0.07/输出秒；1080p ¥0.11/输出秒。",
  "默认参数：10 秒、768p；允许 1–10 秒整数；仅 16:9/9:16；最多 9 张参考图 + 3 段参考音频。",
  "10 秒参考总成本：480p ¥0.50；768p ¥0.70；1080p ¥1.10。",
  "并发说明：允许多任务异步提交/排队，但平台未公开真实同时 RUNNING 数与 SLA，实测前不得承诺 2/3 路真并发。",
  "运维说明：上游不支持远程取消；提交后仍可能产生费用；成功结果短链需立即转存。",
  "密钥说明：数据库只保存 secret:// 引用；服务器从 AUTODL_COMFYUI_API_KEY 环境变量读取，本机开发才回退 Windows DPAPI 文件。禁止在备注或数据库中粘贴明文令牌。",
].join("\n");

const AUTODL_H3_SELFHOST_ADMIN_NOTES = [
  "【内部渠道备注｜仅管理员可见】",
  "渠道：AutoDL 自租 GPU 实例；与 AutoDL 托管 ComfyUI API 完全隔离。",
  "硬件型号不写入模型名称；实例换卡后必须先做单条 canary，再确认速度、显存和稳定性。",
  "模型：minimax-h3-turbo；Bearer 网关通过本机 SSH 回环隧道访问。",
  "原生时长：5/10/15 秒；分辨率档 480p；画幅 16:9/9:16/1:1。",
  "像素映射：864x480 / 480x864 / 768x768。无图走文生视频，有图才走图生视频。",
  "结果短链必须立即转存；不支持远程取消；不得运行一键付费探测。",
  "数据库只保存 secret://autodl-h3-selfhost，严禁复用托管 ComfyUI Token。",
  "当前仅限本地 V2.6 内测，不代表全国用户生产入口已获许可。",
].join("\n");

// ── 绘图模型供应商 ──
const DRAWING_PROVIDERS = [
  { value: "autodl_h3_selfhost", label: "AutoDL自租实例 · Qwen生图", defaultEndpoint: "http://127.0.0.1:16011/v1" },
  { value: "secure_skill", label: "渠道A", defaultEndpoint: "https://token.secure-skill.com/v1" },
  { value: "secure_skill_chat", label: "渠道A · Chat生图", defaultEndpoint: "https://token.secure-skill.com/v1" },
  { value: "vectorengine", label: "向量引擎", defaultEndpoint: "https://api.vectorengine.ai/" },
  { value: "zhipu", label: "智谱AI", defaultEndpoint: "https://open.bigmodel.cn/api/paas/" },
  { value: "siliconflow", label: "硅基流动", defaultEndpoint: "https://api.siliconflow.cn/" },
  { value: "openai", label: "OpenAI", defaultEndpoint: "https://api.openai.com/" },
  { value: "custom", label: "自定义", defaultEndpoint: "" },
];

const IMAGE_PROTOCOLS = [
  { value: "images_generations", label: "Images Generations", referenceTransport: "generations_url_array" },
  { value: "images_generations_async", label: "Images Generations 异步任务", referenceTransport: "generations_url_array" },
  { value: "images_edits", label: "Images Edits", referenceTransport: "edits_multipart_array" },
  { value: "chat_completions", label: "Chat Completions 生图", referenceTransport: "chat_inline_data" },
  { value: "google_generate_content", label: "Google generateContent 原生", referenceTransport: "chat_inline_data" },
] as const;

// ── 计费模式 ──
const BILLING_MODES = {
  drawing: [
    { value: "per_use", label: "按次收费（现金）", desc: "每次调用固定扣费，按售价/次收取" },
  ],
  text: [
    { value: "token", label: "关联 Token 计费", desc: "按输入/输出 Token 数量计费" },
  ],
  video: [
    { value: "per_use", label: "按生成收费（现金）", desc: "根据模型协议按次或按输出视频秒数结算" },
  ],
};

const TEXT_CONNECTION_PRESETS = [
  { value: "secure_skill", label: "Secure Skill · OpenAI 兼容", endpoint: "https://token.secure-skill.com/v1", protocol: "openai_chat" },
  { value: "lc_openai", label: "LConAI · OpenAI 兼容（备用节点）", endpoint: "https://s.lconai.com/v1", protocol: "openai_chat" },
  { value: "lc_openai_primary", label: "LConAI · OpenAI 兼容（候选，需验证）", endpoint: "https://n.lconai.com/v1", protocol: "openai_chat" },
  { value: "lc_anthropic", label: "LConAI · Anthropic 兼容（候选，需验证）", endpoint: "https://n.lconai.com/v1", protocol: "anthropic_messages" },
  { value: "gaorui", label: "高瑞 · OpenAI 兼容（候选，需验证）", endpoint: "https://gaorui.cc/v1", protocol: "openai_chat" },
  { value: "deepseek_official", label: "DeepSeek · 官方直连", endpoint: "https://api.deepseek.com/v1", protocol: "openai_chat" },
  { value: "openai_official", label: "OpenAI · 官方直连", endpoint: "https://api.openai.com/v1", protocol: "openai_chat" },
  { value: "anthropic_official", label: "Anthropic · 官方直连", endpoint: "https://api.anthropic.com/v1", protocol: "anthropic_messages" },
  { value: "custom", label: "自定义接口", endpoint: "", protocol: "openai_chat" },
] as const;

// ── 深度思考选项 ──
const DEEP_THINKING_OPTIONS = [
  { value: 0, label: "不开启", desc: "普通对话模式" },
  { value: 1, label: "全局思考", desc: "推理模型思考后由对话模型回答" },
  { value: 2, label: "自带思考", desc: "模型自身推理（o1/R1/QwQ等）" },
];

// ── Switch 组件 ──
function Switch({ checked, onChange, color = "var(--primary)" }: { checked: boolean; onChange: (v: boolean) => void; color?: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors"
      style={{ backgroundColor: checked ? color : "var(--border)" }}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

// ── Stepper 组件 ──
function Stepper({ value, onChange, min = 0, max = 9999, step = 1, unit }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <div className="flex items-center gap-0">
      <button type="button" onClick={() => onChange(Math.max(min, value - step))}
        className="w-8 h-8 flex items-center justify-center rounded-l-lg border border-r-0 border-[var(--border)] bg-[var(--background)] hover:bg-[var(--muted)]/30 text-[var(--foreground)] text-sm font-bold transition">−</button>
      <input type="number" value={value} onChange={e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))}
        className="w-16 h-8 text-center border-y border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-sm outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
      <button type="button" onClick={() => onChange(Math.min(max, value + step))}
        className="w-8 h-8 flex items-center justify-center rounded-r-lg border border-l-0 border-[var(--border)] bg-[var(--background)] hover:bg-[var(--muted)]/30 text-[var(--foreground)] text-sm font-bold transition">+</button>
      {unit && <span className="ml-2 text-xs text-[var(--muted-foreground)] shrink-0">{unit}</span>}
    </div>
  );
}

// ── RadioGroup 组件 ──
function RadioGroup<T extends string | number>({ options, value, onChange, color = "var(--primary)" }: {
  options: Array<{ value: T; label: string; desc?: string }>;
  value: T;
  onChange: (v: T) => void;
  color?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button key={String(opt.value)} type="button" onClick={() => onChange(opt.value)}
          className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-all border ${
            value === opt.value
              ? "text-white border-transparent shadow-sm"
              : "bg-[var(--background)] text-[var(--muted-foreground)] border-[var(--border)] hover:border-[var(--primary)]/40"
          }`}
          style={value === opt.value ? { backgroundColor: color } : undefined}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── HelpTip 组件 ──
function HelpTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex ml-1">
      <button type="button" onClick={() => setShow(!show)} onBlur={() => setTimeout(() => setShow(false), 150)}
        className="w-4 h-4 rounded-full border border-[var(--border)] text-[var(--muted-foreground)] text-[10px] flex items-center justify-center hover:border-[var(--primary)] hover:text-[var(--primary)] transition cursor-help">?</button>
      {show && (
        <div className="absolute left-0 top-6 z-50 w-56 p-2.5 rounded-lg bg-[var(--popover)] border border-[var(--border)] shadow-xl text-xs text-[var(--foreground)] leading-relaxed">
          {text}
        </div>
      )}
    </span>
  );
}

interface UnifiedModelDialogProps {
  model: Record<string, unknown> | null;
  modelType: "drawing" | "text" | "video";
  onSave: (model: Record<string, unknown>) => void;
  onClose: () => void;
  onTest?: (modelId: string, modelType: string) => void;
  testing?: boolean;
  token?: string;
}

type VideoDurationMode = "fixed" | "discrete" | "range";

const VIDEO_RESOLUTION_CHOICES = ["lite", "480p", "720p", "768p", "1080p", "2K", "4K"];

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNumberMap(value: unknown): Record<string, number> {
  const source = asObject(value);
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, raw]) => [key, Number(raw)] as const)
      .filter(([, amount]) => Number.isFinite(amount) && amount >= 0),
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : [];
}

function normalizeAdminResolution(value: string): string {
  const compact = value.trim().toLowerCase().replace(/\s+/g, "");
  if (compact === "lite") return "lite";
  if (compact === "2k" || compact === "1440p") return "2K";
  if (compact === "4k" || compact === "2160p") return "4K";
  return compact;
}

function normalizeResolutionPriceMap(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(asNumberMap(value)).map(([resolution, price]) => [normalizeAdminResolution(resolution), price]),
  );
}

export default function UnifiedModelDialog({
  model, modelType, onSave, onClose, onTest, testing, token,
}: UnifiedModelDialogProps) {
  const isEdit = !!model?.id;
  const apiKeyConfigured = model?.api_key_configured === true;

  // ── 通用表单 ──
  const [form, setForm] = useState({
    name: "",
    model_name: "",
    model_type: modelType,
    // 计费
    billing_mode: BILLING_MODES[modelType][0].value as string,
    cost_per_use: 0,       // 售价
    cost_price: 0,          // 进价
    // Token 计费
    token_billing_enabled: false,
    input_cost_per_million: "" as string,
    output_cost_per_million: "" as string,
    cached_cost_per_million: "0" as string,
    profit_margin: "16.666667" as string,
    token_rounding_unit: 0,
    // API
    api_endpoint: "",
    api_key: "",
    proxy_url: "",
    // 绘图专属
    provider: modelType === "text" ? "custom" : modelType === "video" ? "" : "vectorengine",
    supports_image_input: true,
    requires_image: false,
    // 视频专属
    protocol_type: modelType === "text" ? "openai_chat" : modelType === "drawing" ? "images_generations" : "unified_video",
    duration_seconds: 5,
    max_duration: 10,
    duration_mode: "fixed" as VideoDurationMode,
    duration_options_text: "",
    resolution_options: [] as string[],
    default_resolution: "",
    resolution_cost_prices: {} as Record<string, number>,
    resolution_prices: {} as Record<string, number>,
    api_protocol_config: {} as Record<string, unknown>,
    admin_notes: "",
    // 文案专属
    description: "",
    category: "通用",
    max_context_rounds: 0,
    max_context_tokens: 64000,
    max_reply_tokens: 0,
    timeout: 300,
    enable_web_search: false,
    deep_thinking_type: 0,
    deduct_deep_think: 1,
    temperature: "",
    response_format: "",
    user_access: "available",
    // 新增字段
    frequency_limit: 50,
    image_parsing: "none",
    file_parsing: "none",
    icon_url: "",
    // 通用
    is_active: true,
    sort_order: 0,
  });

  // ── 一键适配 ──
  const detectionEpoch = useRef(0);
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<{
    success: boolean;
    protocolType: string;
    protocolName: string;
    modelName: string;
    apiEndpoint?: string;
    features: string[];
    error?: string;
    suggestion?: string;
    liveTest?: {
      tested: boolean;
      passed: boolean;
      mode: "sync" | "async" | "unknown";
      detail: string;
      responseTime?: number;
    };
  } | null>(null);

  useEffect(() => {
    if (model) {
      const mt = (model.model_type as string) || modelType;
      const protocolConfig = asObject(model.api_protocol_config);
      const durationOptions = asStringArray(protocolConfig.duration_options)
        .map(Number)
        .filter(value => Number.isFinite(value) && value > 0);
      const configuredDurationMode: VideoDurationMode = protocolConfig.supports_duration === false || durationOptions.length === 1
        ? "fixed"
        : durationOptions.length > 1
          ? "discrete"
          : "range";
      const resolutionOptions = asStringArray(protocolConfig.resolution_options).map(normalizeAdminResolution);
      const configuredDefaultResolution = normalizeAdminResolution(String(protocolConfig.default_resolution || protocolConfig.resolution || resolutionOptions[0] || ""));
      setForm(prev => ({
        ...prev,
        model_type: mt as "drawing" | "text" | "video",
        name: (model.name as string) || "",
        model_name: (model.model_name as string) || "",
        billing_mode: mt === "text" ? "token" : ((model.billing_mode as string) || BILLING_MODES[mt as keyof typeof BILLING_MODES]?.[0]?.value || "per_use"),
        cost_per_use: Number(model.cost_per_use) || 0,
        cost_price: Number(model.cost_price) || 0,
        token_billing_enabled: mt === "text" || model.token_billing_enabled === true,
        input_cost_per_million: model.input_cost_per_million != null ? String(model.input_cost_per_million) : "",
        output_cost_per_million: model.output_cost_per_million != null ? String(model.output_cost_per_million) : "",
        cached_cost_per_million: model.cached_cost_per_million != null ? String(model.cached_cost_per_million) : "",
        profit_margin: model.profit_margin != null ? String(model.profit_margin) : "",
        token_rounding_unit: Number(model.token_rounding_unit) || 0,
        api_endpoint: (model.api_endpoint as string) || "",
        api_key: "",
        proxy_url: (model.proxy_url as string) || "",
        provider: (model.provider as string) || "vectorengine",
        supports_image_input: model.supports_image_input !== false,
        requires_image: model.requires_image === true,
        protocol_type: (model.protocol_type as string) || "unified_video",
        duration_seconds: Number(model.duration_seconds) || 5,
        max_duration: Number(model.max_duration) || 10,
        duration_mode: configuredDurationMode,
        duration_options_text: durationOptions.join(", "),
        resolution_options: resolutionOptions,
        default_resolution: configuredDefaultResolution,
        resolution_cost_prices: normalizeResolutionPriceMap(protocolConfig.resolution_cost_prices),
        resolution_prices: normalizeResolutionPriceMap(protocolConfig.resolution_prices),
        api_protocol_config: protocolConfig,
        admin_notes: (model.admin_notes as string) || "",
        description: (model.description as string) || "",
        category: (model.category as string) || "通用",
        max_context_rounds: model.max_context_rounds != null ? Number(model.max_context_rounds) : 0,
        max_context_tokens: Number(model.max_context_tokens) || 0,
        max_reply_tokens: model.max_reply_tokens != null ? Number(model.max_reply_tokens) : 0,
        timeout: model.timeout != null ? Number(model.timeout) : 300,
        enable_web_search: model.enable_web_search === true,
        deep_thinking_type: model.deep_thinking_type != null ? Number(model.deep_thinking_type) : 0,
        deduct_deep_think: model.deduct_deep_think != null ? Number(model.deduct_deep_think) : 1,
        temperature: model.temperature != null ? String(model.temperature) : "",
        response_format: (model.response_format as string) || "",
        user_access: (model.user_access as string) || "available",
        frequency_limit: model.frequency_limit != null ? Number(model.frequency_limit) : 50,
        image_parsing: (model.image_parsing as string) || "none",
        file_parsing: (model.file_parsing as string) || "none",
        icon_url: (model.icon_url as string) || "",
        is_active: model.is_active !== false,
        sort_order: Number(model.sort_order) || 0,
      }));
    }
  }, [model, modelType]);

  useEffect(() => {
    detectionEpoch.current += 1;
    setDetectResult(null);
  }, [form.api_endpoint, form.api_key, form.model_name, form.protocol_type]);

  // 一键适配
  const editingModelId = isEdit && model?.id ? String(model.id) : undefined;
  const handleAutoDetect = useCallback(async () => {
    if (form.protocol_type === "autodl_h3_selfhost") {
      alert("AutoDL 自租 H3 禁止一键付费探测；请保存后使用模型列表中的“测试”按钮执行 GET /v1/models 无费用检查。");
      return;
    }
    if (!form.api_endpoint || (!form.api_key && !editingModelId) || !form.model_name) {
      alert("请先填写 API地址、密钥 和 模型名");
      return;
    }
    const invalid = modelEndpointError(form.api_endpoint);
    if (invalid) { alert(invalid); return; }
    const epoch = ++detectionEpoch.current;
    setDetecting(true);
    setDetectResult(null);
    try {
      const res = await fetch("/api/video/detect-protocol", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          api_endpoint: form.api_endpoint,
          api_key: form.api_key,
          model_name: form.model_name,
          model_id: editingModelId,
          provider: form.provider,
          protocol_type: form.protocol_type,
        }),
      });
      const data = await res.json();
      if (epoch !== detectionEpoch.current) return;
      setDetectResult({ success: false, protocolType: "", protocolName: "", modelName: form.model_name, features: [], ...data });
    } catch {
      if (epoch !== detectionEpoch.current) return;
      setDetectResult({ success: false, protocolType: "", protocolName: "", modelName: "", features: [], error: "网络请求失败" });
    } finally {
      setDetecting(false);
    }
  }, [editingModelId, form.api_endpoint, form.api_key, form.model_name, form.protocol_type, form.provider, token]);

  // 阻止 Backspace 后退
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const priorFocus = document.activeElement as HTMLElement | null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el.querySelector<HTMLElement>('[role="dialog"]')?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const items = Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')).filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement?.getAttribute("role") === "dialog")) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
      if (e.key === "Backspace") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !(e.target as HTMLElement)?.isContentEditable) {
          e.preventDefault();
        }
      }
    };
    el.addEventListener("keydown", handler);
    return () => {
      el.removeEventListener("keydown", handler);
      document.body.style.overflow = priorOverflow;
      priorFocus?.focus();
    };
  }, []);

  const selectedProtocol = VIDEO_PROTOCOLS.find(p => p.value === form.protocol_type);
  const isAutoDLH3 = form.model_type === "video"
    && (form.protocol_type === "autodl_comfyui_h3" || form.protocol_type === "autodl_comfyui_workflow");
  const isAutoDLH3Selfhost = form.model_type === "video" && form.protocol_type === "autodl_h3_selfhost";
  const isProviderTokenBilling = form.model_type === "video"
    && form.api_protocol_config?.provider_billing_unit === "token";
  const videoPriceUnit = isProviderTokenBilling
    ? "元/百万Token"
    : isAutoDLH3 || getVideoBillingUnit(form) === "output_second"
      ? "元/输出秒"
      : "元/次";
  const connection = modelConnectionSummary(form.api_endpoint || form.proxy_url, form.api_protocol_config);
  const profit = form.cost_per_use - form.cost_price;
  const profitMargin = form.cost_price > 0 ? ((profit / form.cost_price) * 100).toFixed(1) : "—";
  const liveTest = detectResult?.liveTest;
  const liveTestPassed = liveTest?.tested && liveTest.passed;
  const liveTestFailed = liveTest?.tested && !liveTest.passed;

  // ── 对话模型的接口预设与 Token 售价预览 ──
  const normalizedTextEndpoint = (form.proxy_url || form.api_endpoint).trim().replace(/\/+$/, "");
  const selectedTextPreset = TEXT_CONNECTION_PRESETS.some(item => item.value === form.provider)
    ? form.provider
    : TEXT_CONNECTION_PRESETS.find(item =>
      item.value !== "custom" && item.endpoint.replace(/\/+$/, "") === normalizedTextEndpoint,
    )?.value || "custom";
  const calcInput = parseFloat(form.input_cost_per_million) || 0;
  const calcOutput = parseFloat(form.output_cost_per_million) || 0;
  const calcCached = parseFloat(form.cached_cost_per_million) || 0;
  const calcMargin = parseFloat(form.profit_margin) || 0;
  const inputSellPerMillion = calcMargin < 100 && calcInput > 0 ? calcInput / (1 - calcMargin / 100) : calcInput;
  const outputSellPerMillion = calcMargin < 100 && calcOutput > 0 ? calcOutput / (1 - calcMargin / 100) : calcOutput;
  const cachedSellPerMillion = calcMargin < 100 && calcCached > 0 ? calcCached / (1 - calcMargin / 100) : calcCached;

  const inputCls = "w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none text-sm";
  const labelCls = "block text-sm font-bold mb-1.5";

  // ── 模型类型标签颜色 ──
  const typeColors: Record<string, { bg: string; text: string; icon: string }> = {
    drawing: { bg: "bg-purple-500/10", text: "text-purple-600", icon: "🎨" },
    text: { bg: "bg-blue-500/10", text: "text-blue-600", icon: "💬" },
    video: { bg: "bg-orange-500/10", text: "text-orange-600", icon: "🎬" },
  };
  const typeLabels: Record<string, string> = { drawing: "绘图模型", text: "对话模型", video: "视频模型" };
  const tc = typeColors[form.model_type] || typeColors.text;

  // ══════════════════════════════════════════════════════════
  // 渲染对话模型的表单（对标参考图 80% 相似度）
  // ══════════════════════════════════════════════════════════
  const renderTextModelForm = () => (
    <div className="space-y-5" data-text-model-simple-form>
      <section className="rounded-xl border border-[var(--border)] p-4 space-y-4">
        <div>
          <h3 className="font-bold">接入与模型</h3>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">选择已配置接口会自动填入正确的 API 基础地址和协议；密钥仍由当前渠道单独提供。</p>
        </div>

        <div>
          <label className={labelCls}>中转站接口 <span className="text-red-500">*</span></label>
          <select
            aria-label="中转站接口"
            value={selectedTextPreset}
            onChange={event => {
              const preset = TEXT_CONNECTION_PRESETS.find(item => item.value === event.target.value);
              if (!preset) return;
              const endpoint = preset.endpoint || form.api_endpoint;
              setForm({
                ...form,
                provider: preset.value,
                protocol_type: preset.protocol,
                api_endpoint: endpoint,
                proxy_url: endpoint,
                api_protocol_config: {
                  ...form.api_protocol_config,
                  provider: preset.value,
                  protocol: preset.protocol,
                  auth_scheme: preset.value === "anthropic_official" ? "x-api-key" : "bearer",
                  ...(preset.protocol === "anthropic_messages" ? { protocol_version: "2023-06-01" } : {}),
                },
              });
            }}
            className={inputCls}
          >
            {TEXT_CONNECTION_PRESETS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>

        <div>
          <label className={labelCls}>接口协议 <span className="text-red-500">*</span></label>
          <select
            aria-label="对话模型接口协议"
            value={form.protocol_type}
            onChange={event => {
              const protocol = event.target.value;
              setForm({
                ...form,
                protocol_type: protocol,
                api_protocol_config: {
                  ...form.api_protocol_config,
                  provider: form.provider || "custom",
                  protocol,
                  auth_scheme: form.provider === "anthropic_official" ? "x-api-key" : "bearer",
                  ...(protocol === "anthropic_messages" ? { protocol_version: "2023-06-01" } : {}),
                },
              });
            }}
            className={inputCls}
          >
            <option value="openai_chat">OpenAI Chat Completions</option>
            <option value="anthropic_messages">Anthropic Messages</option>
          </select>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">协议随当前模型保存，不会根据域名或模型名自动猜测。</p>
        </div>

        <div>
          <label className={labelCls}>API 基础地址 <span className="text-red-500">*</span></label>
          <input
            type="url"
            name="model-provider-endpoint"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="接入站点 API 地址"
            value={form.proxy_url || form.api_endpoint}
            readOnly={selectedTextPreset !== "custom"}
            onChange={event => setForm({ ...form, proxy_url: event.target.value, api_endpoint: event.target.value })}
            placeholder="https://provider.example.com/v1"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            {selectedTextPreset === "custom" ? "自定义站点须填写其 API 基础地址，不要填写密钥管理页面地址。" : "该地址由所选接口协议自动维护。"}
          </p>
        </div>

        <div>
          <label className={labelCls}>API 密钥 <span className="text-red-500">*</span></label>
          <input
            name="model-provider-secret"
            autoComplete="new-password"
            spellCheck={false}
            aria-label="API 密钥"
            value={form.api_key}
            onChange={event => setForm({ ...form, api_key: event.target.value })}
            type="password"
            placeholder={apiKeyConfigured ? "已配置；留空保留原密钥" : "请填写当前渠道的模型密钥"}
            className={inputCls}
          />
          {apiKeyConfigured && <p className="mt-1 text-xs text-[var(--muted-foreground)]">原密钥不会返回浏览器；只有输入新值才会替换。</p>}
        </div>

        <div>
          <label className={labelCls}>模型名称 <span className="text-red-500">*</span></label>
          <input
            aria-label="模型名称"
            value={form.model_name}
            onChange={event => {
              const nextModelName = event.target.value;
              setForm({
                ...form,
                model_name: nextModelName,
                name: !isEdit || !form.name ? nextModelName : form.name,
              });
            }}
            placeholder="填写中转站目录中的精确模型 ID"
            className={inputCls}
          />
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] p-4 space-y-4" data-token-pricing>
        <div>
          <h3 className="font-bold">Token 成本与利润</h3>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">文案模型统一按实际 Token 用量结算。</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={labelCls}>输入成本 <span className="text-red-500">*</span></label>
            <input aria-label="输入成本" type="number" step="0.000001" min="0" value={form.input_cost_per_million}
              onChange={event => setForm({ ...form, input_cost_per_million: event.target.value })}
              placeholder="元/百万Token" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>输出成本 <span className="text-red-500">*</span></label>
            <input aria-label="输出成本" type="number" step="0.000001" min="0" value={form.output_cost_per_million}
              onChange={event => setForm({ ...form, output_cost_per_million: event.target.value })}
              placeholder="元/百万Token" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>缓存成本 <span className="text-red-500">*</span></label>
            <input aria-label="缓存成本" type="number" step="0.000001" min="0" value={form.cached_cost_per_million}
              onChange={event => setForm({ ...form, cached_cost_per_million: event.target.value })}
              placeholder="无缓存价填 0" className={inputCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>利润率(%) <span className="text-red-500">*</span></label>
          <input aria-label="利润率" type="number" step="0.000001" min="0" max="99.999999" value={form.profit_margin}
            onChange={event => setForm({ ...form, profit_margin: event.target.value })}
            placeholder="16.666667" className={inputCls} />
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">默认 16.666667% 对应真实成本加价 20%；售价 = 成本 ÷ (1 - 利润率)。</p>
        </div>

        {(calcInput > 0 || calcOutput > 0 || calcCached > 0) && (
          <div className="grid grid-cols-3 gap-3 rounded-lg bg-[var(--muted)]/20 p-3 text-xs">
            <div>输入售价：¥{inputSellPerMillion.toFixed(6)} / 百万Token</div>
            <div>输出售价：¥{outputSellPerMillion.toFixed(6)} / 百万Token</div>
            <div>缓存售价：¥{cachedSellPerMillion.toFixed(6)} / 百万Token</div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] p-4 space-y-4">
        <div>
          <h3 className="font-bold">上下文与思考</h3>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">只配置模型实际支持的上下文长度和原生思考能力。</p>
        </div>

        <div>
          <label className={labelCls}>上下文长度(Token) <span className="text-red-500">*</span></label>
          <input aria-label="上下文长度" type="number" min="1" step="1000" value={form.max_context_tokens}
            onChange={event => setForm({ ...form, max_context_tokens: parseInt(event.target.value) || 0 })}
            className={inputCls} />
        </div>

        <div>
          <label className={labelCls}>深度思考</label>
          <RadioGroup
            options={DEEP_THINKING_OPTIONS.filter(option => option.value !== 1)}
            value={form.deep_thinking_type === 2 ? 2 : 0}
            onChange={value => setForm({ ...form, deep_thinking_type: value, deduct_deep_think: value === 2 ? 2 : 1 })}
            color="var(--primary)"
          />
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">只有中转站明确支持该模型原生推理时才选择“自带思考”。</p>
        </div>
      </section>
    </div>
  );
  return createPortal(
    <div ref={dialogRef} className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="model-dialog-title" tabIndex={-1} style={{ backgroundColor: "rgb(from var(--background, #101b2b) r g b / 1)" }} className="bg-[#101b2b] text-[var(--foreground)] rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
        {/* ── 标题 ── */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm font-bold ${tc.bg} ${tc.text}`}>
              <span>{tc.icon}</span>
              {typeLabels[form.model_type]}
            </span>
            <h2 id="model-dialog-title" className="text-xl font-bold">{isEdit ? "编辑模型" : "新增模型"}</h2>
          </div>
          <button aria-label="关闭模型设置" onClick={onClose} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-2xl leading-none">&times;</button>
        </div>

        <div className="space-y-5">
          {form.model_type !== "text" && <div data-connection-summary className="rounded-xl border p-3 text-sm space-y-2">
            <p className="font-bold">接入来源：{connection.label} · {connection.provider}</p>
            <p className="text-xs text-[var(--muted-foreground)]">密钥由后台独立保存；更换接口站点须填写新站点密钥。模型名称不决定官方或中转身份。</p>
            {form.model_type === "video" && connection.kind === "relay" && <label className="block text-xs">渠道分组（与密钥所属分组一致）
              <input aria-label="渠道分组" autoComplete="off" value={String(form.api_protocol_config.connection_group || "")} onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, connection_group: e.target.value } }))} placeholder="例如：Seedance 视频 · 分组42；填写名称不会自动更换密钥权限" className={inputCls} />
            </label>}
          </div>}
          {/* ═══ 对话模型：使用新布局 ═══ */}
          {form.model_type === "text" && renderTextModelForm()}

          {/* ══════════════════════════════════════════════
              绘图/视频模型：保留原有布局
          ══════════════════════════════════════════════ */}
          {form.model_type !== "text" && (
            <>
              {/* 一、用户可见信息 */}
              <div className="bg-[var(--primary)]/5 rounded-xl p-4 border border-[var(--primary)]/20">
                <p className="text-xs font-bold text-[var(--primary)] mb-3 flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-[var(--primary)]" />
                  模型名称
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>模型名称 *</label>
                    <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                      placeholder={form.model_type === "drawing" ? "如：豆包 SeeDream 5.0" : "如：Sora、可灵V2大师版"}
                      className={inputCls} />
                    <p className="text-xs text-[var(--muted-foreground)] mt-1">展示给用户看的名称</p>
                  </div>
                  {form.model_type === "drawing" && (
                    <div className="space-y-3">
                      <div>
                      <label className={labelCls}>供应商</label>
                      <select value={form.provider} onChange={e => {
                        const p = DRAWING_PROVIDERS.find(d => d.value === e.target.value);
                        if (e.target.value === "autodl_h3_selfhost") {
                          setForm({
                            ...form,
                            provider: e.target.value,
                            name: form.name || "Qwen Image 2512 高清（AutoDL自租）",
                            model_name: "qwen-image-2512-hq",
                            api_endpoint: p?.defaultEndpoint || form.api_endpoint,
                            api_key: "secret://autodl-h3-selfhost",
                            supports_image_input: false,
                          });
                        } else {
                          setForm({ ...form, provider: e.target.value, api_endpoint: p?.defaultEndpoint || form.api_endpoint });
                        }
                      }} className={inputCls}>
                        {DRAWING_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                      </div>
                      <div>
                        <label className={labelCls}>接口协议 *</label>
                        <select value={form.protocol_type} onChange={e => {
                          const protocol = e.target.value;
                          const preset = IMAGE_PROTOCOLS.find(item => item.value === protocol);
                          setForm({
                            ...form,
                            protocol_type: protocol,
                            api_protocol_config: {
                              ...form.api_protocol_config,
                              protocol,
                              reference_transport: preset?.referenceTransport || "none",
                            },
                          });
                        }} className={inputCls}>
                          {!IMAGE_PROTOCOLS.some(item => item.value === form.protocol_type) && form.protocol_type && <option value={form.protocol_type}>{form.protocol_type}（当前配置）</option>}
                          {IMAGE_PROTOCOLS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                        <p className="mt-1 text-xs text-[var(--muted-foreground)]">每个生图模型独立绑定请求协议；保存后不会按站点或模型名改道。</p>
                      </div>
                    </div>
                  )}

                </div>
              </div>

              {/* 二、计费配置 */}
              <div className="bg-amber-500/5 rounded-xl p-4 border border-amber-500/20">
                <p className="text-xs font-bold text-amber-600 mb-3 flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                  计费配置
                </p>
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className={labelCls}>售价({videoPriceUnit})</label>
                      <input type="number" step="any" min="0" value={form.cost_per_use}
                        onChange={e => { const v = parseFloat(e.target.value); setForm({ ...form, cost_per_use: isNaN(v) ? 0 : v }) }}
                        className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>成本价({videoPriceUnit})</label>
                      <input type="number" step="any" min="0" value={form.cost_price}
                        onChange={e => { const v = parseFloat(e.target.value); setForm({ ...form, cost_price: isNaN(v) ? 0 : v }) }}
                        className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>成本加价率</label>
                      <input type="text" value={profitMargin === "—" ? "成本未设置" : `${profitMargin}%`} readOnly
                        className={`${inputCls} opacity-70`} />
                    </div>
                  </div>
                  {form.cost_per_use > 0 && form.cost_price > 0 && (
                    <div className="bg-amber-500/8 rounded-lg p-2.5 border border-amber-500/15 flex items-center justify-between text-xs">
                      <span className="text-[var(--muted-foreground)]">{isProviderTokenBilling ? "每百万Token利润" : videoPriceUnit.includes("输出秒") ? "每输出秒利润" : "单次利润"}</span>
                      <span className="font-bold text-amber-700 dark:text-amber-400">
                        {formatModelPrice(profit)} {videoPriceUnit}
                        <span className="ml-2 text-[var(--muted-foreground)] font-normal">
                          （成本加价 {profitMargin}%）
                        </span>
                      </span>
                    </div>
                  )}
                  <p className="text-xs text-[var(--muted-foreground)]">多规格模型的实际价格以高级参数内的分档配置为准；这里只显示基础价格。</p>
                  <p className="text-xs text-[var(--primary)]">
                    视频售价按供应商或运营价格表逐项填写，系统不会按统一百分比自动改价。
                  </p>
                </div>
              </div>

              {/* 三、API 连接配置 */}
              <div className="bg-green-500/5 rounded-xl p-4 border border-green-500/20">
                <p className="text-xs font-bold text-green-600 mb-3 flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                  接入站点与密钥
                </p>
                <div className="space-y-3">
                  <div>
                    <label className={labelCls}>模型 ID *</label>
                    <input value={form.model_name} onChange={e => setForm({ ...form, model_name: e.target.value })}
                      placeholder={form.model_type === "drawing" ? "如：doubao-seedream-5-0" : "如：grok-video-3、veo3.1-fast"}
                      className={inputCls} />
                  </div>
                  {form.model_type === "video" && (
                    <div>
                      <label className={labelCls}>渠道标识 *</label>
                      <input value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value.trim() })}
                        placeholder="例如：secure_skill、lconai、official"
                        className={inputCls} />
                      <p className="mt-1 text-xs text-[var(--muted-foreground)]">渠道与协议分别保存；同一渠道下的不同模型可选择不同协议。</p>
                    </div>
                  )}
                  <div>
                    <label className={labelCls}>接入站点 API 地址 *</label>
                    <input type="url" name="model-provider-endpoint" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="接入站点 API 地址" value={form.api_endpoint} onChange={e => setForm({ ...form, api_endpoint: e.target.value })}
                      placeholder="https://你的中转站/v1/"
                      className={inputCls} />
                  </div>
                  <p className="text-xs text-[var(--muted-foreground)]">{modelStationLabel(form.api_endpoint)}。同一站点可有不同令牌分组，请使用对应分组的密钥。</p>
                  {form.api_endpoint && modelEndpointError(form.api_endpoint) && <p role="alert" className="text-xs text-red-500">{modelEndpointError(form.api_endpoint)}</p>}
                  <div>
                    <label className={labelCls}>API 密钥 *</label>
                    <input name="model-provider-secret" autoComplete="new-password" spellCheck={false} aria-label="API 密钥" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })}
                      type="password" placeholder={apiKeyConfigured ? "已配置；留空保留原密钥" : "sk-xxxxxxxx"}
                      className={inputCls} />
                    {apiKeyConfigured && <p className="text-xs text-[var(--muted-foreground)] mt-1">原密钥不会返回浏览器；输入新值才会替换</p>}
                  </div>

                  {/* 视频专属: 一键适配 */}
                  {form.model_type === "video" && (
                    <>
                      <div className="flex items-center gap-3">
                        <button onClick={handleAutoDetect}
                          disabled={isAutoDLH3Selfhost || detecting || !form.api_endpoint || (!form.api_key && !editingModelId) || !form.model_name}
                          className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 text-white font-bold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
                          {detecting ? (
                            <>
                              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              正在检查配置...
                            </>
                          ) : (
                            <>
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                              </svg>
                              检查配置
                            </>
                          )}
                        </button>
                        <span className="text-xs text-[var(--muted-foreground)]">
                          {isAutoDLH3Selfhost ? "自租 H3 仅允许保存后执行 GET /v1/models 无费用测试" : "读取模型目录，不生成、不保存"}
                        </span>
                      </div>
                      {detectResult?.success && <button type="button" className="text-sm text-[var(--primary)] underline" onClick={() => {
                        setForm(prev => ({ ...prev, protocol_type: detectResult.protocolType }));
                      }}>使用协议建议（保存后生效）</button>}
                      {detectResult && (
                        <div className={`rounded-xl border-2 overflow-hidden ${
                          liveTestPassed ? "border-green-500" : liveTestFailed ? "border-red-500"
                            : detectResult.success ? "border-yellow-500" : "border-red-500"
                        }`}>
                          <div className={`px-4 py-3 flex items-center gap-3 ${
                            liveTestPassed ? "bg-green-500 text-white" : liveTestFailed ? "bg-red-500 text-white"
                              : detectResult.success ? "bg-yellow-500 text-white" : "bg-red-500 text-white"
                          }`}>
                            <span className="text-2xl">{liveTestPassed ? "✓" : liveTestFailed ? "✗" : detectResult.success ? "⚠" : "✗"}</span>
                            <div className="flex-1">
                              <p className="font-black text-base">
                                {liveTestPassed ? "验证通过" : liveTestFailed ? "验证未通过" : detectResult.success ? `配置检查通过：${detectResult.protocolName}` : `配置未确认：${detectResult.error || "未知错误"}`}
                              </p>
                            </div>
                          </div>
                          <div className="p-4 bg-[var(--background)] space-y-2">
                            {liveTest && liveTest.tested && (
                              <div className={`rounded-lg p-3 text-sm ${liveTestPassed ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-red-500/10 text-red-700 dark:text-red-400"}`}>
                                <p className="font-bold mb-1">{liveTestPassed ? "端到端验证结果" : "验证失败原因"}</p>
                                <p className="text-xs">{liveTest.detail}</p>
                              </div>
                            )}
                            {(detectResult.features || []).length > 0 && (
                              <div className="space-y-1">
                                {detectResult.features.map((f, i) => (
                                  <p key={i} className="text-xs text-[var(--muted-foreground)] flex items-start gap-1.5">
                                    <span className="mt-0.5 shrink-0">•</span><span>{f}</span>
                                  </p>
                                ))}
                              </div>
                            )}
                            {detectResult.suggestion && (
                              <div className="bg-orange-500/10 rounded-lg p-3 text-xs text-orange-600 dark:text-orange-400">
                                <span className="font-bold">排查建议：</span> {detectResult.suggestion}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* 视频专属: 协议选择 */}
                  {form.model_type === "video" && (
                    <details className="rounded-lg border border-[var(--border)] p-3">
                      <summary className="cursor-pointer text-sm font-semibold">高级：接口协议与预设</summary>
                      <p className="text-xs text-[var(--muted-foreground)] my-2">协议决定请求格式；同一渠道的不同模型可能使用不同协议。</p>
                      <label className={labelCls}>接口协议</label>
                      <select value={form.protocol_type} onChange={e => {
                        const protocolType = e.target.value;
                        if (protocolType === "autodl_comfyui_workflow") {
                          setForm({
                            ...form,
                            protocol_type: protocolType,
                            name: form.name || "MiniMax H3 · AutoDL官方多图参考",
                            model_name: "minimax_h3_lightx2v_v5",
                            api_endpoint: "https://www.autodl.art/api/v1",
                            api_key: "secret://autodl-comfyui",
                            provider: protocolType,
                            duration_mode: "range",
                            duration_seconds: 5,
                            max_duration: 10,
                            supports_image_input: true,
                            requires_image: true,
                            resolution_options: ["480p", "768p", "1080p"],
                            default_resolution: "768p",
                            resolution_cost_prices: { "480p": 0.01, "768p": 0.01, "1080p": 0.10 },
                            resolution_prices: { "480p": 0.01, "768p": 0.01, "1080p": 0.10 },
                            cost_price: 0.01,
                            cost_per_use: 0.01,
                            api_protocol_config: {
                              ...form.api_protocol_config,
                              workflow_id: "minimax_h3_lightx2v_v5",
                              workflow_input_mode: "multi_image",
                              supports_prompt: true,
                              required_reference_images: 1,
                              required_reference_audios: 0,
                              duration_step: 1,
                              default_duration: 5,
                              billing_unit: "output_second",
                              aspect_ratios: ["16:9", "9:16", "1:1"],
                              max_reference_images: 9,
                              max_reference_audios: 0,
                              supports_audio_input: false,
                              auto_generate_reference: false,
                              workspace_surfaces: ["ai-video", "storyboard"],
                              persist_result_immediately: true,
                              supports_remote_cancel: false,
                            },
                          });
                        } else if (protocolType === "autodl_comfyui_h3") {
                          setForm({
                            ...form,
                            protocol_type: protocolType,
                            name: form.name || "MiniMax H3 · AutoDL托管渠道（多图多音频）",
                            model_name: "minimax_h3_image_audio_to_video_v2",
                            api_endpoint: "https://www.autodl.art/api/v1",
                            provider: "autodl",
                            duration_mode: "range",
                            duration_seconds: 10,
                            max_duration: 10,
                            supports_image_input: true,
                            resolution_options: ["480p", "768p", "1080p"],
                            default_resolution: "768p",
                            resolution_cost_prices: { "480p": 0.05, "768p": 0.07, "1080p": 0.11 },
                            resolution_prices: { "480p": 0.05, "768p": 0.07, "1080p": 0.11 },
                            cost_price: 0.07,
                            cost_per_use: 0.07,
                            admin_notes: form.admin_notes || AUTODL_H3_ADMIN_NOTES,
                            api_protocol_config: {
                              ...form.api_protocol_config,
                              workflow_id: "minimax_h3_image_audio_to_video_v2",
                              duration_step: 1,
                              default_duration: 10,
                              billing_unit: "output_second",
                              aspect_ratios: ["16:9", "9:16"],
                              max_reference_images: 9,
                              max_reference_audios: 3,
                              supports_audio_input: true,
                              workspace_surfaces: ["ai-video", "storyboard"],
                              persist_result_immediately: true,
                              supports_remote_cancel: false,
                            },
                          });
                        } else if (protocolType === "autodl_h3_selfhost") {
                          setForm({
                            ...form,
                            protocol_type: protocolType,
                            name: form.name || "MiniMax H3 加速版（AutoDL自租）",
                            model_name: "minimax-h3-turbo",
                            api_endpoint: "http://127.0.0.1:16011/v1/video/generations",
                            api_key: "secret://autodl-h3-selfhost",
                            provider: "autodl_h3_selfhost",
                            duration_mode: "discrete",
                            duration_options_text: "5, 10, 15",
                            duration_seconds: 10,
                            max_duration: 15,
                            supports_image_input: true,
                            resolution_options: ["480p"],
                            default_resolution: "480p",
                            resolution_cost_prices: { "480p": 0 },
                            resolution_prices: { "480p": 0 },
                            cost_price: 0,
                            cost_per_use: 0,
                            admin_notes: form.admin_notes || AUTODL_H3_SELFHOST_ADMIN_NOTES,
                            api_protocol_config: {
                              ...form.api_protocol_config,
                              supports_duration: true,
                              duration_options: [5, 10, 15],
                              min_duration: 5,
                              max_duration: 15,
                              min_submit_duration: 5,
                              duration_step: 5,
                              default_duration: 10,
                              exact_duration_only: true,
                              resolution_options: ["480p"],
                              default_resolution: "480p",
                              resolution: "480p",
                              aspect_ratios: ["16:9", "9:16", "1:1"],
                              pixel_size_by_aspect_ratio: { "16:9": "864x480", "9:16": "480x864", "1:1": "768x768" },
                              auto_generate_reference: false,
                              persist_result_immediately: true,
                              supports_remote_cancel: false,
                              billing_unit: "per_use",
                              workspace_surfaces: ["ai-video"],
                            },
                          });
                        } else {
                          setForm({ ...form, protocol_type: protocolType });
                        }
                      }} className={inputCls}>
                        {!VIDEO_PROTOCOLS.some(p => p.value === form.protocol_type) && <option value={form.protocol_type}>{form.protocol_type}（当前配置）</option>}
                        {VIDEO_PROTOCOLS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                      {selectedProtocol && (
                        <p className="text-xs text-[var(--muted-foreground)] mt-1.5 flex items-center gap-1">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--primary)]" />
                          {selectedProtocol.desc}
                        </p>
                      )}
                    </details>
                  )}
                </div>
              </div>

              {/* 四、视频模型专属: 参数配置 */}
              {form.model_type === "video" && (
                <details className="bg-orange-500/5 rounded-xl p-4 border border-orange-500/20">
                  <summary className="text-xs font-bold text-orange-600 mb-3 flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-orange-500" />
                    参数配置（视频模型专属）
                  </summary>
                  <div className="grid grid-cols-4 gap-4">
                    <div>
                      <label className={labelCls}>时长能力</label>
                      <select value={form.duration_mode}
                        onChange={e => setForm({ ...form, duration_mode: e.target.value as VideoDurationMode })}
                        className={inputCls}>
                        <option value="fixed">固定时长</option>
                        <option value="discrete">多个固定档位</option>
                        <option value="range">连续范围</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>默认时长(秒)</label>
                      <input type="number" min="1" value={form.duration_seconds}
                        onChange={e => {
                          const duration = parseInt(e.target.value) || 5;
                          setForm({ ...form, duration_seconds: duration, max_duration: form.duration_mode === "fixed" ? duration : form.max_duration });
                        }} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>最大时长(秒)</label>
                      <input type="number" min="1" value={form.duration_mode === "fixed" ? form.duration_seconds : form.max_duration}
                        disabled={form.duration_mode === "fixed"}
                        onChange={e => setForm({ ...form, max_duration: parseInt(e.target.value) || 10 })} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>排序权重</label>
                      <input type="number" min="0" value={form.sort_order}
                        onChange={e => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })} className={inputCls} />
                    </div>
                  </div>
                  <div className="mt-4 flex items-center gap-5">
                    <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                      <input type="checkbox" checked={form.supports_image_input}
                        onChange={e => setForm({ ...form, supports_image_input: e.target.checked, requires_image: e.target.checked ? form.requires_image : false })}
                        className="w-4 h-4 rounded accent-orange-500" />
                      图生视频
                    </label>
                    <label className={`flex items-center gap-1.5 text-sm ${form.supports_image_input ? "cursor-pointer" : "opacity-50"}`}>
                      <input type="checkbox" checked={form.requires_image}
                        disabled={!form.supports_image_input}
                        onChange={e => setForm({ ...form, requires_image: e.target.checked })}
                        className="w-4 h-4 rounded accent-orange-500" />
                      必须上传图片
                    </label>
                    <span className="text-sm text-[var(--muted-foreground)]">保存后自动启用</span>
                  </div>
                  {form.duration_mode === "discrete" && (
                    <div className="mt-4">
                      <label className={labelCls}>可选时长档位（逗号分隔）</label>
                      <input value={form.duration_options_text}
                        onChange={e => setForm({ ...form, duration_options_text: e.target.value })}
                        placeholder="例如：5, 8, 10"
                        className={inputCls} />
                    </div>
                  )}

                  <div className="mt-5 border-t border-orange-500/20 pt-4">
                    <div className="mb-3">
                      <p className="text-sm font-bold text-[var(--foreground)]">分辨率与分档价格</p>
                      <p className="text-xs text-[var(--muted-foreground)] mt-1">勾选两个及以上时，用户端显示分辨率选择；默认档位用于首次进入。</p>
                    </div>
                    <div className="space-y-2">
                      {VIDEO_RESOLUTION_CHOICES.map(resolution => {
                        const enabled = form.resolution_options.includes(resolution);
                        return (
                          <div key={resolution} className={`grid grid-cols-[110px_1fr_1fr_100px] items-center gap-3 rounded-lg border px-3 py-2 ${enabled ? "border-orange-500/35 bg-[var(--background)]" : "border-[var(--border)] bg-[var(--muted)]/10 opacity-70"}`}>
                            <label className="flex items-center gap-2 text-sm font-semibold">
                              <input type="checkbox" checked={enabled} className="accent-orange-500"
                                onChange={e => {
                                  const options = e.target.checked
                                    ? [...form.resolution_options, resolution]
                                    : form.resolution_options.filter(item => item !== resolution);
                                  const defaultResolution = e.target.checked
                                    ? (form.default_resolution || resolution)
                                    : (form.default_resolution === resolution ? options[0] || "" : form.default_resolution);
                                  setForm({ ...form, resolution_options: options, default_resolution: defaultResolution });
                                }} />
                              {resolution}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                              成本 ¥{form.protocol_type === "autodl_comfyui_h3" || form.protocol_type === "autodl_comfyui_workflow" ? "/秒" : ""}
                              <input type="number" min="0" step="any" disabled={!enabled}
                                value={form.resolution_cost_prices[resolution] ?? ""}
                                onChange={e => setForm({ ...form, resolution_cost_prices: { ...form.resolution_cost_prices, [resolution]: Math.max(0, Number(e.target.value) || 0) } })}
                                className={`${inputCls} py-1.5`} />
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                              售价 ¥{form.protocol_type === "autodl_comfyui_h3" || form.protocol_type === "autodl_comfyui_workflow" ? "/秒" : ""}
                              <input type="number" min="0" step="any" disabled={!enabled}
                                value={form.resolution_prices[resolution] ?? ""}
                                onChange={e => setForm({ ...form, resolution_prices: { ...form.resolution_prices, [resolution]: Math.max(0, Number(e.target.value) || 0) } })}
                                className={`${inputCls} py-1.5`} />
                            </label>
                            <label className="flex items-center gap-2 text-xs font-medium">
                              <input type="radio" name="default-video-resolution" disabled={!enabled}
                                checked={form.default_resolution === resolution}
                                onChange={() => setForm({ ...form, default_resolution: resolution })}
                                className="accent-orange-500" />
                              默认
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </details>
              )}

              {/* 四、管理员备注 */}
              <details className="bg-orange-500/5 rounded-xl p-4 border border-orange-500/20">
                <summary className="text-xs font-bold text-orange-500 mb-3 flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-orange-500" />
                  管理员备注（仅内部管理员可见）
                </summary>
                <textarea value={form.admin_notes} onChange={e => setForm({ ...form, admin_notes: e.target.value })}
                  placeholder="填写供应商、计费单位、分档成本、并发边界与运维注意事项；不要粘贴明文令牌"
                  rows={isAutoDLH3 ? 9 : 2} className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-orange-500 outline-none text-sm resize-y" />
                <p className="mt-1.5 text-xs text-[var(--muted-foreground)]">该字段仅由管理员接口读取，不进入用户端模型列表或视频工作台。</p>
              </details>

              {/* 绘图模型: 排序 */}
              {form.model_type === "drawing" && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>排序权重</label>
                    <input type="number" min="0" value={form.sort_order}
                      onChange={e => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })} className={inputCls} />
                  </div>
                  <div className="flex items-end pb-2 text-sm text-[var(--muted-foreground)]">保存后自动启用并在目录显示</div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 底部按钮 ── */}
        <div className="flex items-center justify-between mt-8 pt-4 border-t">
          <button onClick={onClose} className="px-6 py-2.5 rounded-lg border hover:bg-[var(--muted)]/50 transition">
            取消
          </button>
          <div className="flex items-center gap-3">
            {/* 编辑模式：测试连接 */}
            {form.model_type === "text" && isEdit && !!model?.id && (
              <button onClick={async () => {
                try {
                  const res = await fetch("/api/admin/llm-test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    body: JSON.stringify({
                      agent_id: (model.agent_id as string) || undefined,
                      model_id: model.id,
                      model_type: form.model_type,
                      api_endpoint: form.api_endpoint || form.proxy_url || undefined,
                      api_key: form.api_key || undefined,
                      model_name: form.model_name || undefined,
                    }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    const icon = data.rate_limited ? "⚠️" : "✅";
                    alert(`${icon} ${data.message}${data.latency ? ` (${data.latency}ms)` : ""}`);
                  } else {
                    alert(`❌ ${data.message || "测试失败"}`);
                  }
                } catch {
                  alert("测试请求失败");
                }
              }}
                className="px-6 py-2.5 rounded-lg border border-[var(--primary)] text-[var(--primary)] hover:bg-[var(--primary)]/10 transition">
                测试连接
              </button>
            )}
            <button onClick={() => {
              const endpoint = form.model_type === "text" ? (form.proxy_url || form.api_endpoint) : form.api_endpoint;
              const invalid = modelEndpointError(endpoint);
              if (invalid) { alert(invalid); return; }
              if (!form.model_name || (form.model_type !== "text" && !form.name)) {
                alert("请填写模型名称");
                return;
              }
              if (!form.api_key && !(isEdit && apiKeyConfigured)) {
                alert("请填写API密钥");
                return;
              }
              if (form.model_type === "text") {
                const prices = [form.input_cost_per_million, form.output_cost_per_million, form.cached_cost_per_million];
                if (prices.some(value => value === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) {
                  alert("请完整填写输入、输出和缓存 Token 成本；没有缓存价时填 0");
                  return;
                }
                const margin = Number(form.profit_margin);
                if (form.profit_margin === "" || !Number.isFinite(margin) || margin < 0 || margin >= 100) {
                  alert("利润率必须在 0（含）到 100（不含）之间");
                  return;
                }
                if (!Number.isFinite(form.max_context_tokens) || form.max_context_tokens <= 0) {
                  alert("请填写模型实际支持的上下文长度");
                  return;
                }
              }
              const modelName = form.model_name || form.name;
              const discreteDurations = form.duration_options_text
                .split(/[,，\s]+/)
                .map(Number)
                .filter(value => Number.isFinite(value) && value > 0);
              const durationOptions = form.duration_mode === "fixed"
                ? [form.duration_seconds]
                : form.duration_mode === "discrete"
                  ? Array.from(new Set(discreteDurations)).sort((a, b) => a - b)
                  : [];
              if (form.model_type === "video" && form.duration_mode === "discrete" && durationOptions.length === 0) {
                alert("请至少填写一个可选时长档位");
                return;
              }
              if (form.model_type === "video" && form.resolution_options.length > 0 && !form.default_resolution) {
                alert("请选择默认分辨率");
                return;
              }
              const resolutionCostPrices = Object.fromEntries(
                form.resolution_options.map(resolution => [resolution, Number(form.resolution_cost_prices[resolution]) || 0]),
              );
              const resolutionPrices = Object.fromEntries(
                form.resolution_options.map(resolution => [resolution, Number(form.resolution_prices[resolution]) || 0]),
              );
              const baseVideoProtocolConfig = {
                ...form.api_protocol_config,
                supports_duration: form.duration_mode !== "fixed",
                duration_options: durationOptions,
                min_duration: form.duration_mode === "fixed"
                  ? form.duration_seconds
                  : (durationOptions[0] || form.duration_seconds),
                max_duration: form.duration_mode === "fixed"
                  ? form.duration_seconds
                  : (durationOptions.at(-1) || form.max_duration),
                min_submit_duration: form.duration_mode === "fixed"
                  ? form.duration_seconds
                  : (durationOptions[0] || form.duration_seconds),
                resolution_options: form.resolution_options,
                default_resolution: form.default_resolution || undefined,
                resolution: form.default_resolution || undefined,
                resolution_cost_prices: resolutionCostPrices,
                resolution_prices: resolutionPrices,
              };
              const protocolSpecificVideoConfig = form.protocol_type === "autodl_comfyui_workflow" ? {
                  workflow_id: String(form.api_protocol_config.workflow_id || form.model_name),
                  billing_unit: "output_second",
                  persist_result_immediately: true,
                  supports_remote_cancel: false,
                } : form.protocol_type === "autodl_comfyui_h3" ? {
                  workflow_id: "minimax_h3_image_audio_to_video_v2",
                  supports_duration: true,
                  min_duration: 1,
                  max_duration: 10,
                  min_submit_duration: 1,
                  duration_step: 1,
                  billing_unit: "output_second",
                  aspect_ratios: ["16:9", "9:16"],
                  max_reference_images: 9,
                  max_reference_audios: 3,
                  supports_audio_input: true,
                  workspace_surfaces: ["ai-video", "storyboard"],
                  persist_result_immediately: true,
                  supports_remote_cancel: false,
                } : form.protocol_type === "autodl_h3_selfhost" ? {
                  supports_duration: true,
                  duration_options: [5, 10, 15],
                  min_duration: 5,
                  max_duration: 15,
                  min_submit_duration: 5,
                  duration_step: 5,
                  default_duration: 10,
                  exact_duration_only: true,
                  resolution_options: ["480p"],
                  default_resolution: "480p",
                  resolution: "480p",
                  aspect_ratios: ["16:9", "9:16", "1:1"],
                  pixel_size_by_aspect_ratio: { "16:9": "864x480", "9:16": "480x864", "1:1": "768x768" },
                  auto_generate_reference: false,
                  persist_result_immediately: true,
                  supports_remote_cancel: false,
                  billing_unit: "per_use",
                  workspace_surfaces: ["ai-video"],
                } : {};
              const videoProtocolConfig = form.model_type === "video"
                ? Object.assign({}, baseVideoProtocolConfig, protocolSpecificVideoConfig)
                : undefined;
              const defaultResolutionCost = form.default_resolution
                ? resolutionCostPrices[form.default_resolution]
                : undefined;
              const defaultResolutionPrice = form.default_resolution
                ? resolutionPrices[form.default_resolution]
                : undefined;
              const saveData: Record<string, unknown> = {
                ...form,
                name: form.model_type === "text" ? (form.name.trim() || modelName) : form.name,
                model_name: modelName,
                model_type: form.model_type,
                billing_mode: form.model_type === "text" ? "token" : form.billing_mode,
                token_billing_enabled: form.model_type === "text" || form.billing_mode === "token",
                input_cost_per_million: form.input_cost_per_million !== "" && form.input_cost_per_million != null ? parseFloat(String(form.input_cost_per_million)) : null,
                output_cost_per_million: form.output_cost_per_million !== "" && form.output_cost_per_million != null ? parseFloat(String(form.output_cost_per_million)) : null,
                cached_cost_per_million: form.cached_cost_per_million !== "" && form.cached_cost_per_million != null ? parseFloat(String(form.cached_cost_per_million)) : null,
                profit_margin: form.profit_margin !== "" && form.profit_margin != null ? parseFloat(String(form.profit_margin)) : null,
                temperature: form.temperature !== "" && form.temperature != null ? parseFloat(String(form.temperature)) : null,
                response_format: form.response_format || null,
              };
              if (form.model_type === "text") {
                saveData.api_endpoint = endpoint;
                saveData.proxy_url = endpoint;
                saveData.cost_per_use = 0;
                saveData.cost_price = 0;
                saveData.token_rounding_unit = 0;
                saveData.enable_web_search = false;
                saveData.image_parsing = "none";
                saveData.file_parsing = "none";
                saveData.max_context_rounds = 0;
                saveData.api_protocol_config = {
                  ...form.api_protocol_config,
                  provider: form.provider || "custom",
                  protocol: form.protocol_type,
                  auth_scheme: form.provider === "anthropic_official" ? "x-api-key" : "bearer",
                  ...(form.protocol_type === "anthropic_messages" ? { protocol_version: "2023-06-01" } : {}),
                };
              } else if (form.model_type === "drawing") {
                const imageProtocol = IMAGE_PROTOCOLS.find(item => item.value === form.protocol_type);
                saveData.api_protocol_config = {
                  ...form.api_protocol_config,
                  protocol: form.protocol_type,
                  reference_transport: imageProtocol?.referenceTransport || form.api_protocol_config.reference_transport || "none",
                };
              } else {
                saveData.cost_per_use = defaultResolutionPrice ?? form.cost_per_use;
                saveData.price_per_use = defaultResolutionPrice ?? form.cost_per_use;
                saveData.cost_price = defaultResolutionCost ?? form.cost_price;
                saveData.profit_margin = null;
              }
              if (form.model_type === "video") {
                saveData.duration_seconds = form.duration_seconds;
                saveData.max_duration = form.duration_mode === "fixed"
                  ? form.duration_seconds
                  : (durationOptions.at(-1) || form.max_duration);
                saveData.api_protocol_config = videoProtocolConfig;
              }
              if (isEdit && model?.id) saveData.id = model.id;
              if (isEdit && model?.agent_id) saveData.agent_id = model.agent_id;
              onSave(saveData);
            }}
              className="px-8 py-2.5 rounded-lg bg-[var(--primary)] text-white font-bold hover:opacity-90 transition">
              {isEdit ? "保存修改" : "确认新增"}
            </button>
          </div>
        </div>
      </div>
    </div>, document.body
  );
}
