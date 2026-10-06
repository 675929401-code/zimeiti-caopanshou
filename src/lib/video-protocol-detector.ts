/** Read-only configuration discovery. Generation and persistence belong to explicit workflows. */
import { SafeFetchError } from "./safe-fetch";
import { readVideoModelCatalog } from "./video-model-catalog";
import { modelEndpointError } from "./model-endpoint";
export interface DetectRequest {
  apiEndpoint: string;
  apiKey: string;
  modelName: string;
}

export interface DetectResult {
  success: boolean;
  protocolType: string;
  protocolName: string;
  modelName: string;       // 保留用户填写的精确模型 ID
  apiEndpoint: string;     // 保留用户填写的 API 端点
  keyValid: boolean;       // 密钥是否有效
  modelExists: boolean;    // 模型是否存在于平台
  features: string[];      // 检测到的特性
  error?: string;          // 错误信息
  suggestion?: string;     // 给用户的建议
  candidateModels: string[];  // 候选模型名列表（从平台模型列表中筛选出的相似模型）
  // 真实验证结果
  liveTest?: {
    tested: boolean;       // 是否执行了真实调用
    passed: boolean;       // 是否通过
    mode: "sync" | "async" | "unknown";  // 检测到的模式
    detail: string;        // 详细信息（视频URL / task_id / 错误）
    responseTime?: number; // 响应时间(ms)
  };
}

// ─── 协议注册表 ──────────────────────────────────────
interface ProtocolDef {
  id: string;
  name: string;
  description: string;
  keywords: string[];       // 模型名关键词
  domains: string[];        // 平台域名特征
  mode: "sync" | "async";  // 同步/异步
  endpoint: string;         // 标准端点路径
}

const PROTOCOL_REGISTRY: ProtocolDef[] = [
  { id: "secure_skill_doubao_seedance", name: "渠道 A · Seedance 官方 Token", description: "POST /api/v3/contents/generations/tasks → 同密钥 GET /api/v3/contents/generations/tasks/{task_id}", keywords: ["doubao-seedance-2-0", "doubao-seedance-2-5"], domains: ["token.secure-skill.com"], mode: "async", endpoint: "/api/v3/contents/generations/tasks" },
  { id: "secure_skill_enterprise_video", name: "Secure Skill · video-企业 · 分组16", description: "POST /v1/videos → 同密钥 GET /v1/videos/{task_id}；固定720p，支持图片和音频参考", keywords: ["video-2.0-fast", "video-2.0-pro"], domains: ["token.secure-skill.com"], mode: "async", endpoint: "/v1/videos" },
  { id: "secure_skill_seedance_video", name: "Secure Skill · Seedance 2.5", description: "POST /v1/videos → 同密钥 GET /v1/videos/{task_id}；混合参考", keywords: ["seedance-2.5"], domains: ["token.secure-skill.com"], mode: "async", endpoint: "/v1/videos" },
  { id: "gaorui_video", name: "渠道 C · 高瑞视频", description: "POST /v1/videos → GET /v1/videos/{id}", keywords: [], domains: ["gaorui.cc"], mode: "async", endpoint: "/v1/videos" },
  {
    id: "autodl_comfyui_workflow",
    name: "AutoDL 托管 · ComfyUI 工作流",
    description: "按公开 workflow 元数据适配输入；POST workflow → GET result/{task_id}；原样 ComfyUI Token 鉴权",
    keywords: ["minimax_h3", "minimax-h3"],
    domains: ["autodl.art"],
    mode: "async",
    endpoint: "/api/v1/comfyui/comfyui_workflow/minimax_h3_image_audio_to_video_v2",
  },
  {
    id: "suanlicheng_video",
    name: "算力橙 LC · MiniMax H3",
    description: "POST /v1/h3/materials 上传素材 → POST /v1/h3/videos/generations 提交 → GET 同路径/{id} 轮询",
    keywords: ["minimax-h3"],
    domains: ["pro.nat6.net"],
    mode: "async",
    endpoint: "/v1/h3/videos/generations",
  },
  {
    id: "secure_skill_grok_video",
    name: "渠道A Grok 视频",
    description: "POST /v1/videos 提交 -> GET /v1/videos/{id} 轮询",
    keywords: ["grok-imagine-video"],
    domains: ["token.secure-skill.com", "secure-skill"],
    mode: "async",
    endpoint: "/v1/videos",
  },
  {
    id: "secure_skill_flow_jobs",
    name: "渠道A Flow 视频",
    description: "VEO / Omni 使用 POST /v1/jobs 提交并通过 GET /v1/jobs/{id} 轮询",
    keywords: ["veo_3_1", "omni_video_edit", "omni"],
    domains: ["token.secure-skill.com", "secure-skill"],
    mode: "async",
    endpoint: "/v1/jobs",
  },
  {
    id: "secure_skill_wan3_video",
    name: "渠道A Wan3 视频",
    description: "POST /v1/videos/generations 提交并通过 GET /v1/videos/tasks/{id} 轮询",
    keywords: ["wan3.0-video", "wan3.0-video-prime", "wan3.0", "wan3"],
    domains: ["token.secure-skill.com", "secure-skill"],
    mode: "async",
    endpoint: "/v1/videos/generations",
  },
  {
    id: "secure_skill_video",
    name: "渠道A MiniMax H3",
    description: "POST /v1/videos 提交并通过 GET /v1/videos/{id} 轮询",
    keywords: ["minimax-h3"],
    domains: ["token.secure-skill.com", "secure-skill"],
    mode: "async",
    endpoint: "/v1/videos",
  },
  {
    id: "lanmao_video",
    name: "蓝猫平台专属通道",
    description: "POST /v1/video/generations 同步提交 → POST /v1/video/generations/{id} 查询",
    keywords: ["grok-video-3"],
    domains: ["aijisu", "lanmao"],
    mode: "async",
    endpoint: "/v1/video/generations",
  },
  {
    id: "yunwu_video",
    name: "云雾视频统一格式",
    description: "POST /v1/video/create 提交 → GET /v1/video/query 轮询",
    keywords: ["grok-video", "grok_video", "grok video"],
    domains: ["yunwu.ai", "yunwu"],
    mode: "async",
    endpoint: "/v1/video/create",
  },
  {
    id: "grok_video",
    name: "Grok 视频（同步）",
    description: "通过 chat/completions 同步返回视频URL",
    keywords: ["grok"],
    domains: ["yunwu.ai", "yunwu"],
    mode: "sync",
    endpoint: "/v1/chat/completions",
  },
  {
    id: "unified_video",
    name: "视频统一格式（异步）",
    description: "通过 chat/completions 异步返回task_id",
    keywords: ["veo", "cogvideox", "cogvideo", "minimax-video", "hailuo", "sora"],
    domains: ["yunwu.ai", "yunwu", "vectorengine"],
    mode: "async",
    endpoint: "/v1/chat/completions",
  },
  {
    id: "siliconflow_kling",
    name: "硅基流动 · 可灵",
    description: "SiliconFlow中转的Kling可灵视频模型",
    keywords: ["kling", "kling-v1", "kling-v2"],
    domains: ["siliconflow"],
    mode: "async",
    endpoint: "/v1/video/kling/generations",
  },
  {
    id: "siliconflow_vidu",
    name: "硅基流动 · Vidu",
    description: "SiliconFlow中转的Vidu视频模型",
    keywords: ["vidu"],
    domains: ["siliconflow"],
    mode: "async",
    endpoint: "/v1/video/vidu/generations",
  },
  {
    id: "runway",
    name: "Runway",
    description: "Runway Gen-3/Gen-4视频生成",
    keywords: ["gen3", "gen4", "gen-3", "gen-4", "runway"],
    domains: ["runwayml", "runway"],
    mode: "async",
    endpoint: "/v1/image_to_video",
  },
  {
    id: "replicate",
    name: "Replicate",
    description: "Replicate平台视频模型",
    keywords: ["stable-video", "svd", "animateiff"],
    domains: ["replicate"],
    mode: "async",
    endpoint: "/v1/predictions",
  },
  {
    id: "openai_compatible",
    name: "OpenAI 兼容格式",
    description: "标准OpenAI视频生成格式 /v1/video/generations",
    keywords: [],
    domains: [],
    mode: "async",
    endpoint: "/v1/video/generations",
  },
];


export type ModelCatalogReader = (url: string, apiKey: string) => Promise<unknown>;
const readCatalog: ModelCatalogReader = readVideoModelCatalog;

export async function autoDetectVideoProtocol(req: DetectRequest, reader: ModelCatalogReader = readCatalog): Promise<DetectResult> {
  const error = modelEndpointError(req.apiEndpoint);
  const base: DetectResult = { success: false, protocolType: "", protocolName: "", modelName: req.modelName,
    apiEndpoint: req.apiEndpoint, keyValid: false, modelExists: false, features: [], candidateModels: [],
    liveTest: { tested: false, passed: false, mode: "unknown", detail: "仅检查配置，未提交生成任务" } };
  if (error) return { ...base, error };
  if (!req.apiKey || !req.modelName.trim()) return { ...base, error: "请填写密钥和模型 ID" };
  const url = new URL(req.apiEndpoint);
  const host = url.hostname.toLowerCase();
  const model = req.modelName.toLowerCase();
  const domainMatches = (domain: string) => domain.includes(".") && (host === domain || host.endsWith(`.${domain}`));
  const protocol = PROTOCOL_REGISTRY.find(p => p.domains.some(domainMatches) && p.keywords.some(k => model.includes(k)))
    || PROTOCOL_REGISTRY.find(p => p.domains.some(domainMatches) && p.keywords.length === 0);
  if (protocol) {
    base.protocolType = protocol.id; base.protocolName = protocol.name;
    base.features.push("根据接入站点和模型系列匹配协议建议，保存前请核对文档");
  }
  // These providers do not implement the OpenAI model directory contract.
  if (host === "autodl.art" || host.endsWith(".autodl.art") || !protocol) {
    return { ...base, error: protocol ? "该渠道需按专用接口文档核验，不能用通用模型目录确认密钥" : "未找到可靠的渠道协议匹配",
      suggestion: "保留当前配置，在高级设置中选择文档规定的协议；已保存模型可使用独立连接检查和真实生成验收。" };
  }
  // Keep a provider prefix such as /api; remove only known action/version suffixes.
  const prefix = url.pathname.replace(/\/v1(?:\/.*)?$/, "").replace(/\/+$/, "");
  const catalogUrl = `${url.origin}${prefix}/v1/models`;
  try {
    const data = await reader(catalogUrl, req.apiKey);
    if (!data || typeof data !== "object" || !Array.isArray((data as {data?: unknown}).data)) {
      return { ...base, error: "渠道未返回有效模型列表", suggestion: "可能需要专用列表接口；请核对该渠道的 API 文档。" };
    }
    const ids = ((data as {data: unknown[]}).data).flatMap(item => item && typeof item === "object" && typeof (item as {id?: unknown}).id === "string" ? [(item as {id: string}).id] : []);
    if (host === "token.secure-skill.com" && ids.includes("video-2.0-fast") && ids.includes("video-2.0-pro")) {
      const enterprise = PROTOCOL_REGISTRY.find(item => item.id === "secure_skill_enterprise_video");
      if (enterprise) {
        base.protocolType = enterprise.id;
        base.protocolName = enterprise.name;
        base.features = ["根据分组16密钥返回的企业模型目录匹配专用协议，保存前请核对文档"];
      }
    }
    base.keyValid = true;
    base.modelExists = ids.includes(req.modelName);
    base.candidateModels = ids.filter(id => id !== req.modelName && id.toLowerCase().includes(model.split(/[-_]/)[0])).slice(0, 8);
    if (!base.modelExists) return { ...base, error: "该密钥返回的目录中未找到此模型 ID", suggestion: "核对模型 ID 和令牌所属分组；目录可能不完整。不会自动替换为相似模型。" };
    return { ...base, success: true, features: [...base.features, "当前密钥可读取目录，模型 ID 精确匹配", "未生成、未扣费、未保存；生成能力仍需独立验收"] };
  } catch (failure) {
    const status = failure instanceof SafeFetchError ? failure.upstreamStatus : undefined;
    const message = status === 401 || status === 403 ? "密钥或渠道分组无访问权限"
      : status === 429 ? "渠道请求频率受限，请稍后检查"
      : status === 404 ? "该渠道没有此模型列表接口，请查阅 API 文档"
      : "模型目录读取失败，请检查 API 地址、网络或渠道服务状态";
    return { ...base, error: message };
  }
}

export function getSupportedProtocols() {
  return PROTOCOL_REGISTRY.map(p => ({ id: p.id, name: p.name, description: p.description, mode: p.mode }));
}
