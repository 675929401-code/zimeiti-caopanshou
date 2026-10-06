"use client";
import { useState, useEffect, useCallback, useRef } from "react";

const PROTOCOL_OPTIONS = [
  { value: "suanlicheng_video", label: "算力橙 LC · MiniMax H3", desc: "先上传素材，再提交 /v1/h3/videos/generations 并异步轮询" },
  { value: "secure_skill_grok_video", label: "渠道A Grok 视频", desc: "POST /v1/videos -> GET /v1/videos/{id}" },
  { value: "secure_skill_flow_jobs", label: "渠道A Flow Jobs", desc: "VEO / Omni：POST /v1/jobs -> GET /v1/jobs/{id}" },
  { value: "secure_skill_wan3_video", label: "渠道A Wan3 视频", desc: "POST /v1/videos/generations -> GET /v1/videos/tasks/{id}" },
  { value: "openapi_video", label: "通用 OpenAPI（推荐）", desc: "配置驱动，填地址+密钥+模型名+字段映射即可，零代码，保存即生效", configDriven: true },
  { value: "yunwu_video", label: "云雾视频统一格式", desc: "POST /v1/video/create 提交 → GET /v1/video/query 轮询", configDriven: true },
  { value: "grok_video", label: "Grok 视频（同步）", desc: "通过 chat/completions 同步返回视频URL" },
  { value: "unified_video", label: "视频统一格式（异步）", desc: "通过 chat/completions 异步返回 task_id" },
  { value: "kling_official", label: "可灵官方API", desc: "POST /kling/v1/videos/text2video → 轮询" },
  { value: "veo_newapi", label: "Veo NewAPI", desc: "POST /v1/videos 提交 → GET /v1/videos/{id} 轮询", configDriven: true },
  { value: "siliconflow_kling", label: "硅基流动 · 可灵", desc: "POST /v1/video/kling/generations → 轮询" },
  { value: "siliconflow_vidu", label: "硅基流动 · Vidu", desc: "POST /v1/video/vidu/generations → 轮询" },
  { value: "runway", label: "Runway", desc: "POST /v1/image_to_video → 轮询 /v1/tasks/{id}" },
  { value: "replicate", label: "Replicate", desc: "POST /v1/predictions → 轮询 /v1/predictions/{id}" },
  { value: "openai_compatible", label: "OpenAI 兼容格式", desc: "标准 /v1/video/generations 格式" },
  { value: "kling", label: "可灵原生（兼容旧数据）", desc: "兼容旧数据" },
];

/** 判断协议是否走通用适配器（数据驱动） */
const CONFIG_DRIVEN_PROTOCOLS = new Set(["openapi_video", "veo_newapi", "yunwu_video", "gaorui_video"]);

/** 通用协议默认配置 */
const DEFAULT_API_PROTOCOL_CONFIG = {
  submit_path: "/v1/videos",
  poll_path: "/v1/videos/{id}",
  duration_field: "duration",
  image_field: "image",
  size_field: "size",
  video_url_path: "video_url",
  task_id_path: "id",
  status_path: "status",
  status_mapping: { completed: "success", failed: "failed", processing: "processing", queued: "queued" },
};

interface Props {
  model: Record<string, unknown> | null;
  onSave: (model: Record<string, unknown>) => void;
  onClose: () => void;
  onTest: (modelId: string) => void;
  testing: boolean;
  token?: string;
}

export default function VideoModelDialog({ model, onSave, onClose, onTest, testing, token }: Props) {
  const isEdit = !!model?.id;
  const apiKeyConfigured = model?.api_key_configured === true;
  const [form, setForm] = useState({
    name: "",
    model_name: "",
    admin_notes: "",
    api_endpoint: "",
    api_key: "",
    protocol_type: "openapi_video",
    price_per_use: 1.0,
    cost_price: 0,
    duration_seconds: 5,
    max_duration: 10,
    supports_image_input: true,
    is_active: true,
    sort_order: 0,
    api_protocol_config: { ...DEFAULT_API_PROTOCOL_CONFIG } as Record<string, unknown>,
  });

  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<{
    success: boolean;
    protocolType: string;
    protocolName: string;
    modelName: string;
    features: string[];
    error?: string;
    suggestion?: string;
    keyValid?: boolean;
    candidateModels?: string[];
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
      const existingConfig = (model.api_protocol_config as Record<string, unknown>) || {};
      setForm({
        name: (model.name as string) || "",
        model_name: (model.model_name as string) || (model.name as string) || "",
        admin_notes: (model.admin_notes as string) || "",
        api_endpoint: (model.api_endpoint as string) || "",
        api_key: "",
        protocol_type: (model.protocol_type as string) || "openapi_video",
        price_per_use: Number(model.price_per_use) || 1.0,
        cost_price: Number(model.cost_price) || 0,
        duration_seconds: Number(model.duration_seconds) || 5,
        max_duration: Number(model.max_duration) || 10,
        supports_image_input: model.supports_image_input !== false,
        is_active: model.is_active !== false,
        sort_order: Number(model.sort_order) || 0,
        api_protocol_config: { ...DEFAULT_API_PROTOCOL_CONFIG, ...existingConfig },
      });
    }
  }, [model]);

  // 一键适配
  const handleAutoDetect = useCallback(async () => {
    if (!form.api_endpoint || (!form.api_key && !isEdit) || !form.model_name) {
      alert("请先填写 API地址、密钥 和 代理模型名");
      return;
    }

    setDetecting(true);
    setDetectResult(null);

    try {
      const res = await fetch("/api/video/detect-protocol", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          api_endpoint: form.api_endpoint,
          api_key: form.api_key,
          model_name: form.model_name,
          model_id: isEdit ? (model?.id as string) : undefined,
        }),
      });

      const data = await res.json();
      setDetectResult(data);

      // 无论验证是否通过，都回填检测到的协议、端点和模型名修正
      if (data.protocolType) {
        setForm(prev => ({
          ...prev,
          protocol_type: data.protocolType,
          model_name: data.modelName || prev.model_name,
          api_endpoint: data.apiEndpoint || prev.api_endpoint,
        }));
      }
    } catch {
      setDetectResult({
        success: false,
        protocolType: "",
        protocolName: "",
        modelName: "",
        features: [],
        error: "网络请求失败",
      });
    } finally {
      setDetecting(false);
    }
  }, [form.api_endpoint, form.api_key, form.model_name, isEdit, model, token]);

  // 阻止Backspace后退导航
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Backspace") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !(e.target as HTMLElement)?.isContentEditable) {
          e.preventDefault();
        }
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, []);

  const selectedProtocol = PROTOCOL_OPTIONS.find(p => p.value === form.protocol_type);

  // 利润计算
  const profit = form.price_per_use - form.cost_price;
  const profitMargin = form.cost_price > 0 ? ((profit / form.cost_price) * 100).toFixed(1) : "∞";

  // 真实验证状态
  const liveTest = detectResult?.liveTest;
  const liveTestPassed = liveTest?.tested && liveTest.passed;
  // 检测结果状态（放宽判断：密钥有效+协议可检测=部分成功）
  const isUpstreamBusy = liveTest?.tested && liveTest.passed && liveTest.detail?.includes("上游暂时繁忙");
  const detectPartialSuccess = detectResult && detectResult.keyValid && detectResult.protocolType && !liveTestPassed && !isUpstreamBusy;
  const liveTestFailed = liveTest?.tested && !liveTest.passed;

  return (
    <div ref={dialogRef} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[var(--card)] rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold">{isEdit ? "编辑视频模型" : "新增视频模型"}</h2>
          <button onClick={onClose} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-2xl leading-none">&times;</button>
        </div>

        <div className="space-y-5">
          {/* 用户可见信息 */}
          <div className="bg-[var(--primary)]/5 rounded-xl p-4 border border-[var(--primary)]/20">
            <p className="text-xs font-bold text-[var(--primary)] mb-3 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-[var(--primary)]" />
              用户可见信息
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold mb-1.5">模型名称 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="如：Sora、可灵V2大师版" className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none" />
                <p className="text-xs text-[var(--muted-foreground)] mt-1">展示给用户看的名称</p>
              </div>
              <div>
                <label className="block text-sm font-bold mb-1.5">售卖价(元/次) *</label>
                <input type="number" step="0.01" min="0" value={form.price_per_use}
                  onChange={e => setForm({ ...form, price_per_use: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none" />
                <p className="text-xs text-[var(--muted-foreground)] mt-1">用户选择模型时显示的价格</p>
              </div>
            </div>
          </div>

          {/* 进货价+利润 */}
          <div className="bg-green-500/5 rounded-xl p-4 border border-green-500/20">
            <p className="text-xs font-bold text-green-600 mb-3 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
              进货成本（仅管理员可见）
            </p>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-bold mb-1.5">进货价(元/次)</label>
                <input type="number" step="0.01" min="0" value={form.cost_price}
                  onChange={e => setForm({ ...form, cost_price: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-green-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1.5">利润(元/次)</label>
                <input type="number" step="0.01" value={profit.toFixed(2)}
                  onChange={e => {
                    const newProfit = parseFloat(e.target.value) || 0;
                    // 反算售价 = 进货价 + 利润
                    setForm({ ...form, price_per_use: Math.max(0, (form.cost_price || 0) + newProfit) });
                  }}
                  className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-green-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1.5">利润率</label>
                <input type="number" step="0.1" value={profitMargin}
                  onChange={e => {
                    const newMargin = parseFloat(e.target.value) || 0;
                    if (newMargin < 100 && (form.cost_price || 0) > 0) {
                      // 反算售价 = 进货价 / (1 - 利润率/100)
                      setForm({ ...form, price_per_use: Math.max(0, Number((form.cost_price / (1 - newMargin / 100)).toFixed(2))) });
                    }
                  }}
                  className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-green-500 outline-none" />
                </div>
              </div>
            </div>

          {/* 管理员备注 */}
          <div className="bg-orange-500/5 rounded-xl p-4 border border-orange-500/20">
            <p className="text-xs font-bold text-orange-500 mb-3 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-orange-500" />
              管理员备注（仅你可见）
            </p>
            <textarea value={form.admin_notes} onChange={e => setForm({ ...form, admin_notes: e.target.value })}
              placeholder="如：云雾AI中转、进货价0.3元、稳定度★★★、2026-05到期"
              rows={2} className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-orange-500 outline-none text-sm resize-none" />
          </div>

          {/* API配置 + 一键适配 */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-bold mb-1.5">代理模型名 *</label>
              <input value={form.model_name} onChange={e => setForm({ ...form, model_name: e.target.value })}
                placeholder="如：grok-video-3、veo3.1-fast（代理平台上的实际模型名）"
                className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none text-sm" />
              <p className="text-xs text-[var(--muted-foreground)] mt-1">代理平台（云雾AI/向量引擎等）上的实际模型标识</p>
            </div>

            <div>
              <label className="block text-sm font-bold mb-1.5">API 接口地址 *</label>
              <input value={form.api_endpoint} onChange={e => setForm({ ...form, api_endpoint: e.target.value })}
                placeholder="https://yunwu.ai/v1/chat/completions 或 https://api.vectorengine.ai/v1/..."
                className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none text-sm" />
            </div>

            <div>
              <label className="block text-sm font-bold mb-1.5">API 密钥 *</label>
              <input value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })}
                type="password" placeholder={apiKeyConfigured ? "已配置；留空保留原密钥" : "sk-xxxxxxxx"}
                className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none text-sm" />
            </div>

            {/* 一键适配按钮 */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleAutoDetect}
                disabled={detecting || !form.api_endpoint || (!form.api_key && !isEdit) || !form.model_name}
                className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 text-white font-bold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {detecting ? (
                  <>
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    正在适配验证...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    一键适配
                  </>
                )}
              </button>
              <span className="text-xs text-[var(--muted-foreground)]">
                自动检测协议 + 真实调用验证（可能需1-3分钟）
              </span>
            </div>

            {/* ── 检测结果：醒目展示 ── */}
            {detectResult && (
              <div className={`rounded-xl border-2 overflow-hidden ${
                liveTestPassed || isUpstreamBusy
                  ? "border-green-500"
                  : liveTestFailed
                    ? detectPartialSuccess
                      ? "border-yellow-500"  // 有协议但验证失败 = 黄色（部分成功）
                      : "border-red-500 animate-pulse"
                    : detectResult.success
                      ? "border-yellow-500"
                      : "border-red-500 animate-pulse"
              }`}>
                {/* 顶部状态栏 */}
                <div className={`px-4 py-3 flex items-center gap-3 ${
                  isUpstreamBusy
                    ? "bg-green-600 text-white"  // 上游繁忙也算通过，用绿色
                    : liveTestPassed
                      ? "bg-green-500 text-white"
                      : liveTestFailed
                        ? detectPartialSuccess
                          ? "bg-yellow-500 text-white"  // 部分成功 = 黄色
                          : "bg-red-500 text-white"
                        : detectResult.success
                          ? "bg-yellow-500 text-white"
                          : "bg-red-500 text-white"
                }`}>
                  <span className="text-2xl">
                    {isUpstreamBusy ? "⚡" : liveTestPassed ? "✓" : liveTestFailed ? (detectPartialSuccess ? "⚠" : "✗") : detectResult.success ? "⚠" : "✗"}
                  </span>
                  <div className="flex-1">
                    <p className="font-black text-base">
                      {isUpstreamBusy
                        ? "API连通确认 — 上游暂时繁忙，可直接保存"
                        : liveTestPassed
                          ? "验证通过 — 全部达标"
                          : liveTestFailed
                            ? detectPartialSuccess
                              ? `协议已检测 — 需修正模型名`
                              : "验证未通过 — 需要排查"
                            : detectResult.success
                              ? `协议匹配：${detectResult.protocolName}`
                              : `适配失败：${detectResult.error || "未知错误"}`
                      }
                    </p>
                    {liveTest && (
                      <p className="text-sm opacity-90 mt-0.5">
                        {liveTest.mode === "sync" ? "同步模式" : liveTest.mode === "async" ? "异步模式" : "未知模式"}
                        {liveTest.responseTime ? ` · 耗时 ${(liveTest.responseTime / 1000).toFixed(1)}s` : ""}
                        {detectResult.protocolType && ` · 协议: ${detectResult.protocolType}`}
                      </p>
                    )}
                  </div>
                </div>

                {/* 详情区域 */}
                <div className="p-4 bg-[var(--background)] space-y-3">
                  {/* 真实验证详情 */}
                  {liveTest && liveTest.tested && (
                    <div className={`rounded-lg p-3 text-sm ${
                      liveTestPassed || isUpstreamBusy
                        ? isUpstreamBusy
                          ? "bg-green-500/10 text-green-700 dark:text-green-400"
                          : "bg-green-500/10 text-green-700 dark:text-green-400"
                        : "bg-red-500/10 text-red-700 dark:text-red-400"
                    }`}>
                      <p className="font-bold mb-1">
                        {liveTestPassed ? "端到端验证结果" : isUpstreamBusy ? "API连通性确认" : "验证失败原因"}
                      </p>
                      <p className="text-xs">{liveTest.detail}</p>
                    </div>
                  )}

                  {/* 特性列表 */}
                  {detectResult.features.length > 0 && (
                    <div className="space-y-1">
                      {detectResult.features.map((f, i) => (
                        <p key={i} className="text-xs text-[var(--muted-foreground)] flex items-start gap-1.5">
                          <span className="mt-0.5 shrink-0">•</span>
                          <span>{f}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  {/* 建议 */}
                  {detectResult.suggestion && (
                    <div className="bg-orange-500/10 rounded-lg p-3 text-xs text-orange-600 dark:text-orange-400">
                      <span className="font-bold">排查建议：</span> {detectResult.suggestion}
                    </div>
                  )}

                  {/* 模型名修正 */}
                  {detectResult.modelName && detectResult.modelName !== form.model_name && (
                    <p className="text-xs">
                      <span className="text-[var(--muted-foreground)]">模型名修正：</span>
                      <span className="font-mono text-[var(--foreground)]">{detectResult.modelName}</span>
                    </p>
                  )}

                  {/* 候选模型列表 */}
                  {detectResult.candidateModels && detectResult.candidateModels.length > 0 && !liveTestPassed && (
                    <div className="mt-2">
                      <p className="text-xs font-bold text-[var(--foreground)] mb-1.5">相似视频模型（点击选择）：</p>
                      <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                        {detectResult.candidateModels.map((m) => (
                          <button
                            key={m}
                            onClick={() => {
                              setForm(prev => ({ ...prev, model_name: m }));
                              setDetectResult(prev => prev ? { ...prev, modelName: m } : null);
                            }}
                            className={`px-2 py-1 rounded text-xs font-mono transition ${
                              form.model_name === m
                                ? "bg-[var(--primary)] text-white"
                                : "bg-[var(--muted)]/30 text-[var(--foreground)] hover:bg-[var(--primary)]/20"
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 接口协议 */}
          <div>
            <label className="block text-sm font-bold mb-1.5">接口协议</label>
            <select value={form.protocol_type} onChange={e => {
              const newProto = e.target.value;
              setForm(prev => ({
                ...prev,
                protocol_type: newProto,
                // 切换到通用协议时自动加载默认配置
                api_protocol_config: CONFIG_DRIVEN_PROTOCOLS.has(newProto)
                  ? { ...DEFAULT_API_PROTOCOL_CONFIG }
                  : prev.api_protocol_config,
              }));
            }}
              className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none">
              {PROTOCOL_OPTIONS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            {selectedProtocol && (
              <p className="text-xs text-[var(--muted-foreground)] mt-1.5 flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--primary)]" />
                {selectedProtocol.desc}
              </p>
            )}
          </div>

          {/* 协议配置（仅通用协议显示） */}
          {CONFIG_DRIVEN_PROTOCOLS.has(form.protocol_type) && (
            <div className="bg-blue-500/5 rounded-xl p-4 border border-blue-500/20">
              <p className="text-xs font-bold text-blue-600 mb-3 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
                接口协议配置（保存即生效，无需改代码）
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold mb-1">提交路径</label>
                  <input value={String(form.api_protocol_config?.submit_path || "/v1/videos")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, submit_path: e.target.value } }))}
                    placeholder="/v1/videos" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">轮询路径</label>
                  <input value={String(form.api_protocol_config?.poll_path || "/v1/videos/{id}")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, poll_path: e.target.value } }))}
                    placeholder="/v1/videos/{id}" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">时长字段名</label>
                  <input value={String(form.api_protocol_config?.duration_field || "duration")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, duration_field: e.target.value } }))}
                    placeholder="duration" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">参考图字段名</label>
                  <input value={String(form.api_protocol_config?.image_field || "image")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, image_field: e.target.value } }))}
                    placeholder="image" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">分辨率字段名</label>
                  <input value={String(form.api_protocol_config?.size_field || "size")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, size_field: e.target.value } }))}
                    placeholder="size" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">视频URL路径</label>
                  <input value={String(form.api_protocol_config?.video_url_path || "video_url")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, video_url_path: e.target.value } }))}
                    placeholder="video_url 或 metadata.video_url" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">任务ID路径</label>
                  <input value={String(form.api_protocol_config?.task_id_path || "id")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, task_id_path: e.target.value } }))}
                    placeholder="id 或 data.task_id" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">状态字段路径</label>
                  <input value={String(form.api_protocol_config?.status_path || "status")}
                    onChange={e => setForm(prev => ({ ...prev, api_protocol_config: { ...prev.api_protocol_config, status_path: e.target.value } }))}
                    placeholder="status 或 data.status" className="w-full px-2.5 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-xs font-mono focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mt-3">
                提示：大部分平台默认值即可。gaorui 时长字段填 <code className="bg-[var(--muted)]/30 px-1 rounded">seconds</code>，参考图字段填 <code className="bg-[var(--muted)]/30 px-1 rounded">image_url</code>，视频URL路径填 <code className="bg-[var(--muted)]/30 px-1 rounded">metadata.video_url</code>
              </p>
            </div>
          )}

          {/* 参数配置 */}
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-bold mb-1.5">默认时长(秒)</label>
              <input type="number" min="1" value={form.duration_seconds}
                onChange={e => setForm({ ...form, duration_seconds: parseInt(e.target.value) || 5 })}
                className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none" />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1.5">最大时长(秒)</label>
              <input type="number" min="1" value={form.max_duration}
                onChange={e => setForm({ ...form, max_duration: parseInt(e.target.value) || 10 })}
                className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none" />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1.5">排序权重</label>
              <input type="number" min="0" value={form.sort_order}
                onChange={e => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2.5 rounded-lg border bg-[var(--background)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--primary)] outline-none" />
            </div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                <input type="checkbox" checked={form.supports_image_input}
                  onChange={e => setForm({ ...form, supports_image_input: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--primary)]" />
                图生视频
              </label>
              <span className="text-sm text-[var(--muted-foreground)]">保存后自动启用并在目录显示</span>
            </div>
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-between mt-8 pt-4 border-t">
          <button onClick={onClose} className="px-6 py-2.5 rounded-lg border hover:bg-[var(--muted)]/50 transition">
            取消
          </button>
          <div className="flex items-center gap-3">
            {isEdit && !!model?.id && (
              <button onClick={() => onTest(model.id as string)} disabled={testing}
                className="px-6 py-2.5 rounded-lg border border-[var(--primary)] text-[var(--primary)] hover:bg-[var(--primary)]/10 transition disabled:opacity-50">
                {testing ? "测试中..." : "测试连接"}
              </button>
            )}
            <button onClick={() => {
              if (!form.name || !form.api_endpoint || (!form.api_key && !(isEdit && apiKeyConfigured))) {
                alert("请填写模型名称、接口地址和密钥");
                return;
              }
              const saveModel = {
                ...form,
                model_name: form.model_name || form.name,
                price_per_use: form.cost_price,
              };
              onSave(isEdit ? { ...saveModel, id: model.id } : saveModel);
            }}
              className="px-8 py-2.5 rounded-lg bg-[var(--primary)] text-white font-bold hover:opacity-90 transition">
              {isEdit ? "保存修改" : "添加模型"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
