import { createHash } from "node:crypto";
import { seedanceRelayBody } from "./video-seedance-relay";
import { doubaoSeedanceTaskBody, isDoubaoSeedanceModel } from "./video-doubao-seedance-relay";
import { submitVolcDigitalHuman, pollVolcDigitalHuman } from './volcengine-digital-human';
import { submitVideoRetalk } from './digital-human-provider';
import { videoProviderFetch as fetch, withVideoProviderRequestAudit, type VideoProviderRequestReceipt } from "./video-provider-request-audit";
import { isProviderCancellationStatus } from "./video-cancellation";
/**
 * 多协议视频API适配器
 * 支持13+种视频生成协议，统一接口调用
 *
 * 【蓝猫通道隔离说明】
 * lanmao_video 协议委托给 video-lanmao-proxy.ts 独立模块处理：
 * - 提交：generateLanmaoVideo()
 * - 轮询：pollLanmaoVideo()
 * 隔离保证：蓝猫专属代码在独立文件中，不影响其他协议
 *
 * 协议列表：
 * 1. siliconflow_kling - 硅基流动·可灵
 * 2. siliconflow_vidu  - 硅基流动·Vidu
 * 3. openai_compatible - OpenAI兼容格式（标准 /v1/video/generations）
 * 4. unified_video     - 视频统一格式（通过 /v1/chat/completions 代理，异步返回task_id）
 * 5. grok_video        - Grok视频格式（通过 /v1/chat/completions 代理，同步返回视频URL）
 * 6. runway            - Runway Gen-3/4
 * 7. replicate         - Replicate平台
 * 8. kling             - 可灵原生协议（兼容旧数据）
 * 9. kling_official    - 可灵官方API协议（云雾AI中转 /kling/v1/videos/text2video）
 * 10. veo_newapi       - Veo NewAPI协议（OpenClaw等中转 POST /v1/videos 提交，GET /v1/videos/{id} 轮询）
 * 11. gaorui_video      - 高瑞视频协议（gaorui.cc 专用，POST /v1/videos 提交，GET /v1/videos/{id} 轮询）
 * 12. openapi_video     - 通用OpenAPI视频协议（数据驱动，配置即生效，无需改代码）
 * 13. lanmao_video      - 蓝猫视频专属通道（POST /v1/videos 异步提交，GET /v1/videos/{id} 轮询）
 * 14. secure_skill_video - 渠道A通用视频协议（OpenAI-style 异步视频接口）
 * 15. secure_skill_enterprise_video - Secure Skill 企业视频（POST /v1/videos，GET /v1/videos/{id}）
 * 15. secure_skill_flow_jobs - 渠道A Flow Jobs 协议（VEO / Omni，POST /v1/jobs，GET /v1/jobs/{id}）
 * 16. secure_skill_wan3_video - 渠道A Wan3 标准协议（POST /v1/videos/generations，GET /v1/videos/tasks/{id}）
 * 17. secure_skill_doubao_seedance - 渠道A Seedance 任务中转协议（POST/GET /api/v3/contents/generations/tasks）
 * 16. autodl_comfyui_h3 - AutoDL 托管 MiniMax H3（原样 Token、异步 task_id、多图/多音频）
 * 17. autodl_h3_selfhost - AutoDL 自租 GPU 实例 MiniMax H3（独立 Bearer 网关）
 *
 * 【openapi_video 协议说明】
 * 适用于所有遵循 POST提交+GET轮询 模式的视频API，通过 api_protocol_config JSONB 字段驱动差异：
 * - submit_path: 提交路径（如 /v1/videos）
 * - poll_path: 轮询路径（如 /v1/videos/{id}）
 * - duration_field: 时长字段名（如 seconds 或 duration）
 * - image_field: 参考图字段名（如 image_url 或 image）
 * - size_field: 分辨率字段名（如 size）
 * - video_url_path: 视频URL提取路径（如 metadata.video_url）
 * - task_id_path: 任务ID提取路径（如 id）
 * - status_path: 状态字段路径（如 status）
 * - status_mapping: 状态值映射（如 {"completed":"success","failed":"failed"}）
 * 管理员在后台填写API地址+密钥+模型名+协议配置 → 保存即生效，零代码。
 *
 * 实测结论（2026-05）：
 * - 云雾AI支持可灵官方API格式：POST /kling/v1/videos/text2video 提交，GET 同路径+task_id 轮询
 * - 可灵参数：{prompt, cfg_scale, mode:"std"|"pro", duration:"5"|"10", aspect_ratio}
 * - 可灵返回：{data: {task_id, task_status:"submitted"|"processing"|"succeed"|"failed"}}
 * - grok-video-3：同步模式，请求等待1-3分钟后返回视频URL（在content的Markdown中）
 * - veo系列：异步模式，立即返回task_id + content_url，需轮询（但部分平台轮询不通）
 * - Veo NewAPI协议：POST /v1/videos 提交返回{id/task_id, status:"in_progress"}，GET /v1/videos/{id} 轮询
 *   返回{status:"in_progress"|"completed"|"failed", progress:0-100, video_url}
 *   支持模型：veo_3_1, veo_3_1-4K, veo_3_1-fast, veo_3_1-fast-4K, veo_3_1-lite, veo_3_1-lite-4K
 * 11. yunwu_video       - 云雾视频专属通道（连接预检+双格式兼容+隔离保障，POST /v1/video/create 提交，GET /v1/video/query 轮询）
 *
 * 云雾视频专属通道（2026-06 独立隔离）：
 * - 提交：POST {base}/v1/video/create  {model, prompt, aspect_ratio, size, duration, images}
 * - 响应格式A（嵌套）：{data: {task_id: "task_xxx", status: "processing"}, code: 200}
 * - 响应格式B（根级）：{id: "grok:xxx", status: "processing", status_update_time}
 * - 轮询：GET {base}/v1/video/query?id={task_id}
 * - 轮询返回：{data: {status, video_url, progress}} 或 {status, video_url, progress}
 * - 状态流转：pending → image_downloading → video_generating → video_generation_completed →
 *   video_upsampling → video_upsampling_completed → completed
 * - 失败态：video_generation_failed, video_upsampling_failed, failed, error, terminated, cancelled
 * - 连接预检：5秒快速检测上游可达性，不可达立即反馈
 * - 隔离性：云雾专属代码路径，不影响其他平台
 *
 * 支持模型：grok-video-3, grok-video-3-10s, veo3.1-fast 等
 * 支持比例：16:9, 9:16, 1:1, 3:2, 2:3（2026-06-10 实测验证，直接透传用户选择即可）
 */

import { buildApiRootEndpoint, buildOpenAIEndpoint } from "./api-endpoints";
import { generateLanmaoVideo, pollLanmaoVideo } from "./video-lanmao-proxy";
import { generateSuanlichengVideo, pollSuanlichengVideo } from "./video-suanlicheng";
import { readSuanlichengMaterial } from "./video-suanlicheng-material";
import { extractPromptDurationSeconds } from "./video-prompt-timing";
import { generateAutodlH3SelfhostVideo, pollAutodlH3SelfhostVideo } from "./video-autodl-h3-selfhost";
import {
  AUTODL_COMFYUI_WORKFLOW_PROTOCOL,
  generateAutodlComfyuiWorkflow,
  pollAutodlComfyuiWorkflow,
} from "./video-autodl-comfyui-workflow";

export interface VideoGenerateParams {
  /** Authenticated server-side owner; never read this value from the request body. */
  inputOwnerId?: string;
  onProviderRequest?: (receipt: VideoProviderRequestReceipt) => Promise<void>;
  prompt: string;
  /** 首帧图/参考图URL（最通用的图生视频入口） */
  imageUrl?: string;
  /** 尾帧图URL（部分模型支持首尾帧控制，如可灵） */
  lastFrameUrl?: string;
  /** 参考图URL（风格参考，优先级低于首帧图） */
  referenceImageUrl?: string;
  /** 源视频URL（视频编辑模型如omni_flash_abra_edit需要） */
  sourceVideoUrl?: string;
  /** Explicitly preserve the full audio by extending VideoRetalk source frames. */
  videoExtension?: boolean;
  /** 参考音频URL（数字人口播、口型同步与多模态视频生成） */
  audioUrl?: string;
  /** 多参考图URL；支持多图工作流时按顺序映射到 ref_image_0..N */
  imageUrls?: string[];
  /** 多参考音频URL；支持多音频工作流时按顺序映射到 ref_audio_0..N */
  audioUrls?: string[];
  /** Whether the provider should keep or synthesize an output audio track. Reference audio remains an independent input. */
  generateAudio?: boolean;
  negativePrompt?: string;
  duration?: number;
  /** Reserved until an adapter explicitly maps the value to its provider payload. */
  fps?: string | number | null;
  /** Reserved until an adapter explicitly maps the value to its provider payload. */
  seed?: string | number | null;
  aspectRatio?: string;
  /** 像素分辨率，如 "1280x720"，部分协议需要像素尺寸而非比例 */
  resolution?: string;
  /** 分辨率等级，如 "720p"/"1080p"/"4k"，omni系列模型使用此参数 */
  resolutionTier?: string;
  /** API 路由可传入用户是否显式选择了参数；直接调用时有值即视为显式选择。 */
  userProvidedOptions?: {
    resolution?: boolean;
  };
  /** 供应商提交幂等键；只由明确支持的协议使用。 */
  idempotencyKey?: string;
}

export interface VideoTaskResult {
  taskId: string;
  status: "processing" | "queued" | "success" | "failed";
  videoUrl?: string;
  /** 异步任务的content_url，用于后续轮询 */
  contentUrl?: string;
  /** 上游生成进度；兼容 0-1 与 0-100，输出层统一换算为百分比 */
  progress?: number | null;
  error?: string;
  /** Provider explicitly reported a terminal cancellation, not a generic failure. */
  terminalState?: "cancelled";
  /** 视频URL需要服务端代理才能播放（如 /content 需认证的URL） */
  needsProxy?: boolean;
  /** A dispatched request without a reliable acknowledgement must not be resubmitted. */
  submissionOutcome?: "unknown";
  /** Redacted receipt facts for reconciling an unknown upstream submission. */
  submissionReceipt?: VideoSubmissionReceiptEvidence;
}

export interface VideoSubmissionReceiptEvidence {
  schemaVersion: 1;
  receiptState: "response_received" | "response_body_unreadable" | "transport_unavailable";
  endpointHost: string;
  providerRequestKeySha256: string;
  httpStatus?: number;
  contentType?: string;
  responseBodyBytes?: number;
  responseBodySha256?: string;
  responseParseState?: "json_object" | "json_non_object" | "empty" | "malformed" | "unreadable";
  locationPresent?: boolean;
  locationSha256?: string;
  candidateFieldPaths?: string[];
}

export interface VideoModelConfig {
  id: string;
  name: string;
  provider: string;
  api_endpoint: string;
  api_key: string;
  protocol_type: string;
  price_per_use: number;
  duration_seconds: number;
  supports_image_input: boolean;
  /** 代理平台的实际模型名（如 grok-video-3），与数据库id不同 */
  model_name?: string;
  /** 通用协议配置（数据驱动，仅 openapi_video 协议使用） */
  api_protocol_config?: ApiProtocolConfig;
}

/** 通用OpenAPI视频协议配置 — 数据驱动，配置即生效 */
export interface ApiProtocolConfig {
  /** 提交路径，如 /v1/videos（默认从 api_endpoint 推导） */
  submit_path?: string;
  /** 轮询路径，如 /v1/videos/{id}（{id}会被替换为任务ID） */
  poll_path?: string;
  /** 时长字段名，如 seconds 或 duration（默认 duration） */
  duration_field?: string;
  /** 用户目标时长选项；允许与供应商最小提交时长不同，成功后由本地裁切。 */
  duration_options?: number[];
  /** 供应商实时契约的最小提交时长。 */
  min_submit_duration?: number;
  /** 供应商工作流公开元数据中的最小时长。 */
  min_duration?: number;
  /** 供应商工作流公开元数据中的最大时长。 */
  max_duration?: number;
  /** 可选时长步长；1 表示只允许整数秒。 */
  duration_step?: number;
  /** 参考图字段名，如 image_url 或 image（默认 image） */
  image_field?: string;
  /** 参考图字段类型：single=单值（如 "url"），array=数组（如 ["url"]）（默认 single） */
  image_field_type?: "single" | "array";
  /** 分辨率字段名，如 size 或 resolution（默认 size） */
  size_field?: string;
  /** NewAPI 提交编码；未配置时保持历史 JSON 行为。 */
  request_format?: "json" | "multipart";
  /** multipart 的 size 值来源；Grok 使用画幅，Veo/Omni 通常使用像素尺寸。 */
  size_value_source?: "aspect_ratio" | "pixel_size" | "resolution";
  /** JSON 模式显式发送分辨率时的字段名。 */
  resolution_field?: string;
  /** 对用户启用的分辨率档；H3 增强档只有真实验收后才可进入该数组。 */
  resolution_options?: string[];
  default_resolution?: string;
  resolution?: string;
  /** 工作流公开支持的画幅。 */
  aspect_ratios?: string[];
  /** H3 用户展示标签，严格区分原生与后处理增强。 */
  resolution_labels?: Record<string, string>;
  /** H3 每档实际提交给基础工作流的像素尺寸。 */
  input_pixel_size_by_resolution?: Record<string, Record<string, string>>;
  /** H3 每档最终验收输出像素尺寸。 */
  output_pixel_size_by_resolution?: Record<string, Record<string, string>>;
  /** H3 网关 output_tier 映射；依次为 base / 1080p / 2K。 */
  gateway_output_tier_by_resolution?: Record<string, string>;
  /** 已公开的 resolution|duration|aspectRatio 组合。 */
  supported_combinations?: string[];
  /** 真实生成成功的组合，仅用于证据披露，不作公开白名单。 */
  direct_verified_combinations?: string[];
  combination_verification_mode?: Record<string, string>;
  verification_notice?: string;
  /** 视频URL提取路径（点分隔），如 metadata.video_url 或 video_url（默认 video_url） */
  video_url_path?: string;
  /** 任务ID提取路径（点分隔），如 id 或 data.task_id（默认 id） */
  task_id_path?: string;
  /** 状态字段提取路径（点分隔），如 status 或 data.status（默认 status） */
  status_path?: string;
  /** 状态值映射：平台原始值 → 系统标准值（success/failed/processing/queued） */
  status_mapping?: Record<string, string>;
  /** 进度字段提取路径（点分隔），如 progress（可选） */
  progress_path?: string;
  /** 轮询风格：path=路径参数 /v1/videos/{id}，query=查询参数 /v1/video/query?id=xxx（默认 path） */
  poll_style?: "path" | "query";
  /** 查询参数风格时的参数名（默认 id） */
  poll_param_name?: string;
  /** 宽高比字段名，如 aspect_ratio（可选，不设置则不发送该字段） */
  aspect_ratio_field?: string;
  /** NewAPI 特定模型不接受任何宽高比字段时显式省略；默认仍发送 ratio 以兼容既有模型。 */
  omit_aspect_ratio?: boolean;
  /** 数字人/视频编辑通道是否必须提供源视频。 */
  requires_source_video?: boolean;
  /** 数字人口播与口型同步使用的音频字段。 */
  audio_field?: string;
  /** 视频编辑通道使用的源视频字段。 */
  source_video_field?: string;
  /** 是否要求上游同时生成/保留音轨。 */
  generate_audio?: boolean;
  /** 协议明确接受用户音轨开关；未开启时禁止透传。 */
  supports_generate_audio_toggle?: boolean;
  /** 协议音轨开关字段名，默认 generate_audio。 */
  generate_audio_field?: string;
  /** 协议反向提示词字段名；未配置时不得猜测上游 schema。 */
  negative_prompt_field?: string;
  /** 托管工作流 ID（例如 minimax_h3_image_audio_to_video_v2）。 */
  workflow_id?: string;
  /** AutoDL ComfyUI 工作流的精确输入形态。 */
  workflow_input_mode?: "text" | "multi_image" | "first_last_frame" | "image_audio_lipsync" | "multi_image_audio";
  /** 工作流是否接收 prompt；对口型工作流为 false。 */
  supports_prompt?: boolean;
  /** 供应商明确支持时才发送 prompt_optimize；默认省略以兼容严格协议。 */
  prompt_optimize?: boolean;
  /** 提交前要求的最少参考图数量。 */
  required_reference_images?: number;
  /** 提交前要求的最少参考音频数量。 */
  required_reference_audios?: number;
  /** 是否必须同时提供首帧和尾帧。 */
  requires_first_frame?: boolean;
  requires_last_frame?: boolean;
  /** 最大参考图数量。 */
  max_reference_images?: number;
  /** 最大参考音频数量。 */
  max_reference_audios?: number;
  /** 是否支持参考音频。 */
  supports_audio_input?: boolean;
  /** false 时禁止系统在用户未上传图片时偷偷生成参考图。 */
  auto_generate_reference?: boolean;
  /** true 时仅接受 duration_options 中的原生时长，不做向上取整后裁切。 */
  exact_duration_only?: boolean;
  /** 画幅到供应商像素尺寸的审计配置。 */
  pixel_size_by_aspect_ratio?: Record<string, string>;
  /** 计费单位；output_second 表示按输出视频秒数计费。 */
  billing_unit?: "per_use" | "output_second";
  /** 允许模型出现的工作台。 */
  workspace_surfaces?: string[];
  /** 上游结果 URL 短效时，成功后立即转存到对象存储。 */
  persist_result_immediately?: boolean;
  /** 上游是否提供真实远程取消。 */
  supports_remote_cancel?: boolean;
  /** 远程取消使用的 HTTP 方法；仅在 supports_remote_cancel=true 时生效。 */
  cancel_method?: "POST" | "DELETE";
  /** 同源取消路径，可用 {id} 或 {task_id} 绑定上游任务编号。 */
  cancel_path?: string;
  /** 上游任务编号放入路径、查询参数或 JSON 请求体。 */
  cancel_task_id_placement?: "path" | "query" | "json";
  /** 查询参数或 JSON 字段名，默认 id。 */
  cancel_task_id_field?: string;
  /** 可选的同源状态确认路径；取消响应不是终态时读取该路径。 */
  cancel_confirm_path?: string;
}

const PRICED_PARAMETER_GUARDED_PROTOCOLS = new Set([
  "siliconflow_kling",
  "kling_official",
  "replicate",
  "autodl_comfyui_workflow",
  "autodl_comfyui_h3",
  "autodl_h3_selfhost",
]);

const BUILTIN_RESOLUTION_FIELD_PROTOCOLS = new Set([
  "autodl_comfyui_workflow",
  "autodl_comfyui_h3",
  "autodl_h3_selfhost",
]);

export type VideoParameterContractIssue = {
  status: 422;
  code: "VIDEO_PARAMETER_INVALID" | "VIDEO_PARAMETER_CONFLICT" | "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL";
  parameter: "duration" | "resolution" | "negativePrompt" | "generateAudio" | "fps" | "seed";
  message: string;
  acceptedValues?: Array<string | number>;
};

export class VideoParameterContractError extends Error {
  readonly status = 422 as const;
  readonly code: VideoParameterContractIssue["code"];
  readonly parameter: VideoParameterContractIssue["parameter"];
  readonly acceptedValues?: Array<string | number>;

  constructor(issue: VideoParameterContractIssue) {
    super(issue.message);
    this.name = "VideoParameterContractError";
    this.code = issue.code;
    this.parameter = issue.parameter;
    this.acceptedValues = issue.acceptedValues;
  }
}

function configuredPositiveDurations(config: VideoModelConfig): number[] {
  const configured = config.api_protocol_config?.duration_options;
  if (!Array.isArray(configured)) return [];
  return [...new Set(configured.map(Number).filter((value) => Number.isFinite(value) && value > 0))];
}

function requestedResolution(params: VideoGenerateParams): { value: string; explicit: boolean; conflict: boolean } {
  const pixel = typeof params.resolution === "string" ? params.resolution.trim() : "";
  const tier = typeof params.resolutionTier === "string" ? params.resolutionTier.trim() : "";
  const conflict = Boolean(pixel && tier && pixel.toLowerCase() !== tier.toLowerCase());
  return {
    value: tier || pixel,
    explicit: params.userProvidedOptions?.resolution ?? Boolean(pixel || tier),
    conflict,
  };
}

/**
 * Guard the priced parameters whose legacy adapters previously omitted or
 * altered values. A configured field is the explicit protocol declaration;
 * absent declarations fail closed instead of guessing an upstream schema.
 */
export function validateVideoParameterContract(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): VideoParameterContractIssue | null {
  const fpsProvided = params.fps !== undefined
    && params.fps !== null
    && String(params.fps).trim() !== "";
  if (fpsProvided) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
      parameter: "fps",
      message: "当前视频适配器尚未承诺帧率参数会原样提交，本次未计费、未提交上游",
    };
  }

  const seedProvided = params.seed !== undefined
    && params.seed !== null
    && String(params.seed).trim() !== "";
  if (seedProvided) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
      parameter: "seed",
      message: "当前视频适配器尚未承诺随机种子会原样提交，本次未计费、未提交上游",
    };
  }

  if (!PRICED_PARAMETER_GUARDED_PROTOCOLS.has(config.protocol_type)) return null;

  const parsedDuration = Number(params.duration ?? config.duration_seconds);
  if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_INVALID",
      parameter: "duration",
      message: "视频时长必须是大于 0 的有限数值，本次未提交上游",
    };
  }
  const configuredDurations = configuredPositiveDurations(config);
  const acceptedDurations = configuredDurations.length > 0
    ? configuredDurations
    : config.protocol_type === "kling_official"
      ? [5, 10]
      : [];
  if (acceptedDurations.length > 0 && !acceptedDurations.includes(parsedDuration)) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
      parameter: "duration",
      message: `当前协议不支持 ${parsedDuration} 秒；可选原生时长：${acceptedDurations.join("/")} 秒`,
      acceptedValues: acceptedDurations,
    };
  }

  if ((params.resolution !== undefined && typeof params.resolution !== "string")
    || (params.resolutionTier !== undefined && typeof params.resolutionTier !== "string")) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_INVALID",
      parameter: "resolution",
      message: "分辨率格式无效，本次未提交上游",
    };
  }
  const resolution = requestedResolution(params);
  if (resolution.conflict) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_CONFLICT",
      parameter: "resolution",
      message: "分辨率与分辨率档位不一致，本次未提交上游",
    };
  }
  const resolutionField = String(config.api_protocol_config?.resolution_field || "").trim()
    || (BUILTIN_RESOLUTION_FIELD_PROTOCOLS.has(config.protocol_type) ? "resolution" : "");
  if (resolution.explicit && resolution.value && !resolutionField) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
      parameter: "resolution",
      message: `当前协议未声明分辨率字段，不能安全提交 ${resolution.value}`,
    };
  }

  if (params.negativePrompt !== undefined && typeof params.negativePrompt !== "string") {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_INVALID",
      parameter: "negativePrompt",
      message: "反向提示词格式无效，本次未提交上游",
    };
  }
  const negativePrompt = typeof params.negativePrompt === "string" ? params.negativePrompt.trim() : "";
  const negativePromptField = config.protocol_type === "siliconflow_kling"
    ? "negative_prompt"
    : String(config.api_protocol_config?.negative_prompt_field || "").trim();
  if (negativePrompt && !negativePromptField) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
      parameter: "negativePrompt",
      message: "当前协议不支持反向提示词，本次未提交上游",
    };
  }

  if (params.generateAudio !== undefined && typeof params.generateAudio !== "boolean") {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_INVALID",
      parameter: "generateAudio",
      message: "音轨开关格式无效，本次未提交上游",
    };
  }
  if (params.generateAudio !== undefined && config.api_protocol_config?.supports_generate_audio_toggle !== true) {
    return {
      status: 422,
      code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
      parameter: "generateAudio",
      message: "当前协议不支持音轨开关，本次未提交上游",
    };
  }

  return null;
}

export function assertVideoParameterContract(config: VideoModelConfig, params: VideoGenerateParams): void {
  const issue = validateVideoParameterContract(config, params);
  if (issue) throw new VideoParameterContractError(issue);
}

// ─── SiliconFlow Kling 适配器 ────────────────────────
function siliconFlowError(data: Record<string, unknown>, fallback: string): string {
  const error = data.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const message = safeStr(record.message) || safeStr(record.msg) || safeStr(record.code);
    if (message) return message;
  }
  return safeStr(data.message) || safeStr(data.reason) || fallback;
}

function siliconFlowVideoUrl(data: Record<string, unknown>): string {
  const results = Array.isArray(data.results) ? data.results : [];
  for (const item of results) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const url = safeStr((item as Record<string, unknown>).url);
      if (url) return url;
    }
  }
  return secureSkillVideoUrl(data);
}

async function submitSiliconFlowVideo(
  config: VideoModelConfig,
  params: VideoGenerateParams,
  body: Record<string, unknown>,
  provider: "Kling" | "Vidu",
): Promise<VideoTaskResult> {
  const providerRequestKey = secureSkillProviderRequestKey(params);
  const acknowledgement = await videoSubmitOnce(config.api_endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...secureSkillIdempotencyHeaders(providerRequestKey),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(config.api_endpoint, providerRequestKey));
  }

  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(config.api_endpoint, providerRequestKey, acknowledgement);
  const taskId = secureSkillTaskIdFromBody(data)
    || secureSkillTaskIdFromLocation(resp.headers.get("Location"), config.api_endpoint, ["generations"]);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, `SiliconFlow ${provider}`, submissionReceipt);

  const status = secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "queued"));
  const videoUrl = siliconFlowVideoUrl(data);
  if (status === "success" && !videoUrl) {
    return { taskId, status: "processing", progress: extractVideoTaskProgress(data) };
  }
  return {
    taskId,
    status,
    videoUrl: status === "success" ? videoUrl : undefined,
    error: status === "failed" ? siliconFlowError(data, `${provider} 视频生成失败`) : undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function pollSiliconFlowVideo(
  config: VideoModelConfig,
  taskId: string,
  provider: "Kling" | "Vidu",
): Promise<VideoTaskResult> {
  const pollUrl = `${config.api_endpoint.replace(/\/+$/u, "")}/${encodeURIComponent(taskId)}`;
  let resp: Response;
  try {
    resp = await fetch(pollUrl, {
      method: "GET",
      headers: { "Authorization": `Bearer ${config.api_key}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return {
      taskId,
      status: "processing",
      progress: null,
      error: `${provider} 状态查询暂时中断，正在自动重试: ${String((error as Error)?.message || "network error").slice(0, 160)}`,
    };
  }

  const data = await safeParseJson(resp);
  if (resp.status === 429 || resp.status >= 500) {
    return {
      taskId,
      status: "processing",
      progress: null,
      error: `${provider} 状态接口暂时异常（HTTP ${resp.status}），正在重试`,
    };
  }
  if (!resp.ok) {
    return {
      taskId,
      status: "failed",
      progress: 0,
      error: siliconFlowError(data, `${provider} 状态查询失败（HTTP ${resp.status}）`).slice(0, 300),
    };
  }

  const rawStatus = data.status || secureSkillGet(data, "data.status");
  if (!rawStatus && data.error) {
    return { taskId, status: "failed", progress: 0, error: siliconFlowError(data, `${provider} 视频生成失败`) };
  }
  const status = secureSkillStatus(String(rawStatus || "processing"));
  const videoUrl = siliconFlowVideoUrl(data);
  if (status === "success" && !videoUrl) {
    return {
      taskId,
      status: "processing",
      progress: extractVideoTaskProgress(data),
      error: `SiliconFlow ${provider} 已完成渲染，正在等待视频 URL`,
    };
  }
  return {
    taskId,
    status,
    videoUrl: status === "success" ? videoUrl : undefined,
    error: status === "failed" ? siliconFlowError(data, `${provider} 视频生成失败`) : undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function generateSiliconFlowKling(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const protocolConfig = config.api_protocol_config || {};
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    duration: Number(params.duration ?? config.duration_seconds ?? 5),
    aspect_ratio: params.aspectRatio || "16:9",
  };
  if (params.imageUrl) body.image = params.imageUrl;
  if (params.lastFrameUrl) body.tail_image = params.lastFrameUrl;
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  const resolution = requestedResolution(params).value;
  const resolutionField = String(protocolConfig.resolution_field || "").trim();
  if (resolution && resolutionField) body[resolutionField] = resolution;
  if (params.generateAudio !== undefined) {
    body[String(protocolConfig.generate_audio_field || "generate_audio")] = params.generateAudio;
  }

  return submitSiliconFlowVideo(config, params, body, "Kling");
}

async function pollSiliconFlowKling(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  return pollSiliconFlowVideo(config, taskId, "Kling");
}

// ─── SiliconFlow Vidu 适配器 ─────────────────────────
async function generateSiliconFlowVidu(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    duration: params.duration || config.duration_seconds || 8,
    aspect_ratio: params.aspectRatio || "16:9",
  };
  if (params.imageUrl) body.image = params.imageUrl;
  if (params.lastFrameUrl) body.tail_image = params.lastFrameUrl;

  return submitSiliconFlowVideo(config, params, body, "Vidu");
}

async function pollSiliconFlowVidu(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  return pollSiliconFlowVideo(config, taskId, "Vidu");
}

// ─── OpenAI兼容格式适配器 ───────────────────────────
async function generateOpenAICompatible(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const modelName = config.model_name || config.id;
  // 优先使用前端传递的像素分辨率(如"1280x720")，否则根据aspectRatio映射
  const sizeFromResolution = params.resolution || "";
  const sizeFallback: Record<string, string> = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "720x720",
    "4:3": "960x720",
    "3:4": "720x960",
  };
  const size = sizeFromResolution || sizeFallback[params.aspectRatio || "16:9"] || "1280x720";
  const body: Record<string, unknown> = {
    model: modelName,
    prompt: params.prompt,
    size,
    duration: params.duration || config.duration_seconds || 5,
    aspect_ratio: params.aspectRatio || "16:9",
  };
  if (params.imageUrl) body.image_url = params.imageUrl;
  if (params.lastFrameUrl) body.last_frame_url = params.lastFrameUrl;
  if (params.referenceImageUrl) body.reference_image_url = params.referenceImageUrl;

  const resp = await fetch(config.api_endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();

  // 兼容两种响应格式
  // 标准OpenAI格式: { id, status, data: [...] }
  // 代理统一格式: { code: 200, data: { task_id, task_status, ... } }
  if (data.code !== undefined && data.data) {
    const taskData = data.data;
    if (data.code !== 200 && data.code !== 0) {
      throw new Error(data.message || "API返回错误");
    }
    const status = mapUnifiedStatus(taskData.task_status);
    return {
      taskId: taskData.task_id || taskData.id || "",
      status,
      videoUrl: taskData.video_url || taskData.url || "",
      error: status === "failed"
        ? (taskData.error?.message || taskData.error || data.message || "生成失败")
        : undefined,
    };
  }

  // 标准OpenAI格式
  const status = mapUnifiedStatus(data.status);
  return {
    taskId: data.id || data.task_id || "",
    status,
    videoUrl: data.data?.[0]?.url || data.output?.url || data.video_url || "",
    error: status === "failed"
      ? (data.error?.message || data.error || data.message || "生成失败")
      : undefined,
  };
}

async function pollOpenAICompatible(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/v1(?:\/.*)?$/, "");
  const pollUrl = `${baseUrl}/v1/video/generations/${taskId}`;

  const resp = await fetch(pollUrl, {
    headers: { "Authorization": `Bearer ${config.api_key}` },
  });

  if (resp.status === 429) {
    return {
      taskId,
      status: "processing",
      progress: null,
      error: "上游状态查询限流（HTTP 429），正在自动重试",
    };
  }
  if (!resp.ok) throw new Error(`Poll failed: ${resp.status}`);

  const data = await resp.json();

  // 兼容代理统一格式
  if (data.code !== undefined && data.data) {
    const taskData = data.data;
    if (data.code !== 200 && data.code !== 0) {
      return { taskId, status: "failed", error: data.message || "查询失败" };
    }
    const status = mapUnifiedStatus(taskData.task_status);
    if (status === "success") {
      return { taskId, status: "success", videoUrl: taskData.video_url || taskData.url || "" };
    }
    if (status === "failed") {
      return { taskId, status: "failed", error: taskData.error?.message || taskData.error || data.message || "生成失败" };
    }
    return { taskId, status: "processing" };
  }

  // 标准OpenAI格式
  const status = mapUnifiedStatus(data.status);
  if (status === "success") {
    return { taskId, status: "success", videoUrl: data.data?.[0]?.url || data.output?.url || "" };
  }
  if (status === "failed") {
    return { taskId, status: "failed", error: data.error?.message || data.error || data.message || "生成失败" };
  }
  return { taskId, status: "processing" };
}

// ─── Grok视频适配器（同步模式，通过chat/completions）────────
// 实测：云雾AI的grok-video-3走chat/completions端点
// 特点：同步等待1-3分钟，直接在choices[0].message.content中返回视频URL（Markdown格式）
async function generateGrokVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const modelName = config.model_name || config.id;
  // 通过chat/completions端点提交，同步等待视频生成
  const chatEndpoint = config.api_endpoint.replace(/\/v1\/video\/generations/, "/v1/chat/completions");

  const body: Record<string, unknown> = {
    model: modelName,
    messages: [{ role: "user", content: params.prompt }],
    stream: false,
    aspect_ratio: params.aspectRatio || "16:9",
    size: params.resolution || "",
    duration: params.duration || config.duration_seconds || 10,
  };
  if (params.imageUrl) {
    let content = `${params.prompt}\n首帧图片: ${params.imageUrl}`;
    if (params.lastFrameUrl) content += `\n尾帧图片: ${params.lastFrameUrl}`;
    if (params.referenceImageUrl) content += `\n风格参考: ${params.referenceImageUrl}`;
    body.messages = [{ role: "user", content }];
  } else if (params.referenceImageUrl) {
    body.messages = [{ role: "user", content: `${params.prompt}\n风格参考: ${params.referenceImageUrl}` }];
  }

  const resp = await fetch(chatEndpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Grok Video API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();

  // 检查是否有generated_assets（异步模式fallback）
  const assets = data.generated_assets;
  if (assets && assets.task_id) {
    return {
      taskId: assets.task_id,
      status: "processing",
      contentUrl: assets.content_url || assets.url || "",
      videoUrl: assets.video_url || "",
    };
  }

  // 同步模式：从content中提取视频URL
  const content = data.choices?.[0]?.message?.content || "";
  if (content) {
    // 检查是否包含错误信息
    if (content.includes("失败") || content.includes("错误") || content.includes("error")) {
      return {
        taskId: data.id || "",
        status: "failed",
        error: content.slice(0, 200),
      };
    }

    // 从Markdown中提取视频URL: [点击下载视频](URL) 或 ![](URL)
    const videoUrlMatch = content.match(/\[点击下载视频\]\(([^)]+\.mp4)\)/) ||
                          content.match(/\[.*?下载.*?\]\(([^)]+\.mp4)\)/) ||
                          content.match(/(https?:\/\/[^\s)]+\.mp4)/);
    const videoUrl = videoUrlMatch ? videoUrlMatch[1] : "";

    if (videoUrl) {
      return {
        taskId: data.id || "",
        status: "success",
        videoUrl,
      };
    }

    // 可能还在生成中（包含进度信息）
    if (content.includes("当前进度") || content.includes("progress")) {
      return {
        taskId: data.id || "",
        status: "processing",
        error: "视频生成中，请稍后重试",
      };
    }

    // 包含视频链接但不是.mp4格式
    const anyUrlMatch = content.match(/(https?:\/\/[^\s)]+)/);
    if (anyUrlMatch) {
      return {
        taskId: data.id || "",
        status: "success",
        videoUrl: anyUrlMatch[1],
      };
    }
  }

  // 没有有效内容
  return {
    taskId: data.id || "",
    status: "processing",
    error: "未收到视频生成结果，请稍后重试",
  };
}

async function pollGrokVideo(config: VideoModelConfig, taskId: string, contentUrl?: string): Promise<VideoTaskResult> {
  // Grok视频同步模式不需要轮询
  // 如果走到这里说明是异步fallback，使用content_url轮询
  // 如果有contentUrl，复用unified_video的轮询逻辑查询视频状态
  if (contentUrl) {
    return pollUnifiedVideo(config, taskId, contentUrl);
  }
  // 没有contentUrl时，无法查询，返回processing等待
  return { taskId, status: "processing", error: "Grok视频异步模式，等待content_url轮询" };
}

// ─── 视频统一格式适配器（异步模式，通过chat/completions）────────
// 实测：云雾AI/向量引擎的veo系列走chat/completions端点
// 特点：立即返回task_id + content_url，需轮询content_url获取视频
async function generateUnifiedVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const modelName = config.model_name || config.id;
  // 通过chat/completions端点提交
  const chatEndpoint = config.api_endpoint.replace(/\/v1\/video\/generations/, "/v1/chat/completions");

  const body: Record<string, unknown> = {
    model: modelName,
    messages: [{ role: "user", content: params.prompt }],
    stream: false,
    aspect_ratio: params.aspectRatio || "16:9",
    size: params.resolution || "",
  };
  if (params.imageUrl) {
    let content = `${params.prompt}\n参考图片: ${params.imageUrl}`;
    if (params.lastFrameUrl) content += `\n尾帧图片: ${params.lastFrameUrl}`;
    if (params.referenceImageUrl) content += `\n风格参考: ${params.referenceImageUrl}`;
    body.messages = [{ role: "user", content }];
  } else if (params.referenceImageUrl) {
    body.messages = [{ role: "user", content: `${params.prompt}\n风格参考: ${params.referenceImageUrl}` }];
  }

  const resp = await fetch(chatEndpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Video API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();

  // 检查是否有generated_assets（异步模式的标准响应）
  const assets = data.generated_assets;
  if (assets && assets.task_id) {
    return {
      taskId: assets.task_id,
      status: "processing",
      contentUrl: assets.content_url || assets.url || "",
      videoUrl: assets.video_url || "",
    };
  }

  // 同步模式fallback：content中包含视频URL
  const content = data.choices?.[0]?.message?.content || "";
  if (content) {
    if (content.includes("失败") || content.includes("错误") || content.includes("error")) {
      return {
        taskId: data.id || "",
        status: "failed",
        error: content.slice(0, 200),
      };
    }

    const videoUrlMatch = content.match(/\[点击下载视频\]\(([^)]+\.mp4)\)/) ||
                          content.match(/(https?:\/\/[^\s)]+\.mp4)/);
    if (videoUrlMatch) {
      return {
        taskId: data.id || "",
        status: "success",
        videoUrl: videoUrlMatch[1],
      };
    }

    // 检查是否是任务提交成功的文本
    const taskIdMatch = content.match(/task_id:\s*(task_\S+)/);
    if (taskIdMatch) {
      const contentUrlMatch = content.match(/content_url:\s*(https?:\/\/\S+)/);
      return {
        taskId: taskIdMatch[1],
        status: "processing",
        contentUrl: contentUrlMatch ? contentUrlMatch[1] : "",
      };
    }
  }

  // 未知响应格式
  return {
    taskId: data.id || "",
    status: "processing",
    error: "未收到有效的任务信息",
  };
}

async function pollUnifiedVideo(config: VideoModelConfig, taskId: string, contentUrl?: string): Promise<VideoTaskResult> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.api_key}`,
    "Accept": "application/json",
  };

  const toRecord = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  );
  const toText = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const toProgress = (value: unknown): number | null => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const extractError = (data: Record<string, unknown>, fallback: string) => {
    const nestedError = toRecord(data.error);
    const nestedData = toRecord(data.data);
    const nestedDataError = toRecord(nestedData?.error);
    return toText(data.error)
      || toText(nestedError?.message)
      || toText(data.error_message)
      || toText(data.message)
      || toText(nestedData?.error)
      || toText(nestedDataError?.message)
      || toText(nestedData?.error_message)
      || toText(nestedData?.message)
      || fallback;
  };
  const parseSnapshot = (raw: Record<string, unknown>): VideoTaskResult | null => {
    const nested = toRecord(raw.data);
    const payload = nested || raw;
    const detail = toRecord(payload.detail) || toRecord(raw.detail);
    const output = toRecord(payload.output) || toRecord(raw.output);
    const video = toRecord(payload.video) || toRecord(raw.video);
    const result = toRecord(payload.result) || toRecord(raw.result);
    const rawStatus = toText(payload.status)
      || toText(payload.task_status)
      || toText(payload.state)
      || toText(raw.status)
      || toText(raw.task_status)
      || toText(raw.state);
    const status = rawStatus.toLowerCase();
    const videoUrl = toText(payload.video_url)
      || toText(payload.videoUrl)
      || toText(payload.url)
      || toText(payload.video)
      || toText(output?.url)
      || toText(output?.video_url)
      || toText(video?.video_url)
      || toText(video?.url)
      || toText(result?.video_url)
      || toText(result?.url)
      || toText(raw.video_url)
      || toText(raw.videoUrl)
      || toText(raw.url);
    const progress = toProgress(payload.progress ?? detail?.progress_pct ?? raw.progress);
    const successStatuses = new Set([
      "completed", "success", "succeeded", "succeed", "done",
      "video_generation_completed", "video_upsampling_completed",
    ]);
    const failedStatuses = new Set([
      "failed", "error", "cancelled", "canceled", "expired", "terminated",
      "video_generation_failed", "video_upsampling_failed",
    ]);

    if (successStatuses.has(status)) {
      if (!videoUrl) {
        return {
          taskId,
          status: "processing",
          progress: null,
          error: "上游已生成成功，正在等待播放地址",
        };
      }
      return { taskId, status: "success", videoUrl, progress: progress ?? 1 };
    }
    if (failedStatuses.has(status)) {
      return { taskId, status: "failed", error: extractError(raw, `视频生成失败（${rawStatus || "未知状态"}）`) };
    }
    if (videoUrl) return { taskId, status: "success", videoUrl, progress: progress ?? 1 };

    const code = toText(raw.code).toLowerCase();
    if (code && !["0", "200", "ok", "success"].includes(code)) {
      return { taskId, status: "failed", error: extractError(raw, `上游返回错误：${code}`) };
    }
    if (status) {
      const queued = ["queued", "pending", "waiting", "submitted", "created", "initializing"]
        .some((candidate) => status.includes(candidate));
      return {
        taskId,
        status: queued && !progress ? "queued" : "processing",
        progress,
        error: extractError(raw, queued ? "上游已接收任务，正在排队" : "上游正在生成视频"),
      };
    }
    return null;
  };
  const isPrivateQueryHost = (hostname: string) => {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local")) return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
    return !host.includes(".");
  };

  // 跟踪轮询失败次数，连续多策略返回task_not_exist则判定为任务丢失
  let taskNotExistCount = 0;
  let transientQueryError = "";

  // 策略1: 优先使用contentUrl/queryUrl（代理平台返回的查询URL）
  // 仅替换代理返回的内网地址；公网查询地址必须原样保留。
  if (contentUrl) {
    try {
      const apiBaseHost = new URL(config.api_endpoint).host;
      let fixedUrl = contentUrl;
      try {
        const urlObj = new URL(contentUrl);
        if (urlObj.host !== apiBaseHost && isPrivateQueryHost(urlObj.hostname)) {
          urlObj.host = apiBaseHost;
          fixedUrl = urlObj.toString();
        }
      } catch { /* URL解析失败，使用原始URL */ }

      const resp = await fetch(fixedUrl, { headers, signal: AbortSignal.timeout(15000) });
      const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
      if (resp.ok) {
        const code = toText(data.code).toLowerCase();
        if (code === "task_not_exist" || code === "invalid_relay_mode") {
          taskNotExistCount++;
        } else {
          const snapshot = parseSnapshot(data);
          if (snapshot) return snapshot;
        }
      } else if ([401, 402, 403].includes(resp.status)) {
        return { taskId, status: "failed", error: extractError(data, `上游拒绝查询（HTTP ${resp.status}）`) };
      } else if (resp.status === 404) {
        taskNotExistCount++;
      } else {
        transientQueryError = extractError(data, `上游查询暂时异常（HTTP ${resp.status}）`);
      }
    } catch (error) {
      transientQueryError = error instanceof Error ? error.message : "上游查询地址暂时不可用";
    }
  }

  // 策略2: 通过代理平台的 /v1/videos/{taskId} 查询
  const baseUrl = config.api_endpoint.replace(/\/v1(?:\/.*)?$/, "");
  const pollUrl = `${baseUrl}/v1/videos/${taskId}`;

  try {
    const resp = await fetch(pollUrl, { headers, signal: AbortSignal.timeout(15000) });
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    if (resp.ok) {
      const code = toText(data.code).toLowerCase();
      if (code === "task_not_exist" || code === "invalid_relay_mode") {
        taskNotExistCount++;
      } else {
        const snapshot = parseSnapshot(data);
        if (snapshot) return snapshot;
      }
    } else if ([401, 402, 403].includes(resp.status)) {
      return { taskId, status: "failed", error: extractError(data, `上游拒绝查询（HTTP ${resp.status}）`) };
    } else if (resp.status === 404) {
      taskNotExistCount++;
    } else {
      transientQueryError = extractError(data, `上游状态接口暂时异常（HTTP ${resp.status}）`);
    }
  } catch (error) {
    transientQueryError = error instanceof Error ? error.message : "上游状态接口暂时不可用";
  }

  // 策略3: 通过runwayml格式查询（部分代理平台支持）
  try {
    const runwayUrl = `${baseUrl}/runwayml/v1/tasks/${taskId}`;
    const resp = await fetch(runwayUrl, { headers, signal: AbortSignal.timeout(15000) });
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    if (resp.ok) {
      const status = toText(data.status) || toText(data.state);
      if (toText(data.error) === "task_not_exist" || (toText(data.id) === "" && status === "failed")) {
        taskNotExistCount++;
      } else {
        const snapshot = parseSnapshot(data);
        if (snapshot) return snapshot;
      }
    } else if ([401, 402, 403].includes(resp.status)) {
      return { taskId, status: "failed", error: extractError(data, `上游拒绝查询（HTTP ${resp.status}）`) };
    } else if (resp.status === 404) {
      taskNotExistCount++;
    } else {
      transientQueryError = extractError(data, `备用状态接口暂时异常（HTTP ${resp.status}）`);
    }
  } catch (error) {
    transientQueryError = error instanceof Error ? error.message : "备用状态接口暂时不可用";
  }

  // 多个策略都返回 task_not_exist → 说明任务在上游不存在，立即失败
  // "上游终止我终止"——不需要傻等超时，快速反馈给用户
  if (taskNotExistCount >= 2) {
    return {
      taskId,
      status: "failed",
      error: "上游平台无法查询任务状态（task_not_exist），视频可能未成功提交。请更换模型或稍后重试。"
    };
  }

  // 不把未知响应伪装成“排队中”；保留任务并把真实查询异常反馈给前端。
  return {
    taskId,
    status: "processing",
    progress: null,
    error: transientQueryError || "尚未取得上游任务状态，系统正在继续查询",
  };
}

// ─── 可灵原生协议（兼容旧数据）────────────────────────
async function generateKling(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  return generateSiliconFlowKling(config, params);
}

async function pollKling(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  return pollSiliconFlowKling(config, taskId);
}

// ─── 可灵官方协议（云雾AI中转 /kling/v1/videos/text2video）────────
// 实测：云雾AI支持可灵官方API格式，提交走 /kling/v1/videos/text2video，轮询同路径+task_id
// 参数格式：{prompt, cfg_scale, mode:"std"|"pro", duration:"5"|"10", aspect_ratio}
// 返回格式：{data: {task_id, task_status:"submitted"|"processing"|"succeed"|"failed", task_result:{videos:[{url,duration}]}}}
async function generateKlingOfficial(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  // 直接使用数据库中配置的api_endpoint作为提交URL
  // text2video: https://yunwu.ai/kling/v1/videos/text2video
  // image2video: https://yunwu.ai/kling/v1/videos/image2video
  const submitUrl = config.api_endpoint;

  // 可灵官方API参数
  const protocolConfig = config.api_protocol_config || {};
  const durationSec = Number(params.duration ?? config.duration_seconds ?? 10);
  // mode根据model_name判断：kling-video-pro=专业版，其他=标准版
  const mode = (config.model_name || "").includes("pro") ? "pro" : "std";

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    cfg_scale: 0.5,
    mode,
    duration: String(durationSec),
    aspect_ratio: params.aspectRatio || "16:9",
  };

  // 图生视频支持
  if (params.imageUrl) {
    body.image = params.imageUrl;
    body.image_type = "url";
  }
  // 可灵支持尾帧图（首尾帧控制）
  if (params.lastFrameUrl) {
    body.tail_image = params.lastFrameUrl;
    body.tail_image_type = "url";
  }
  // 参考图（风格参考）
  if (params.referenceImageUrl) {
    body.reference_image = params.referenceImageUrl;
    body.reference_image_type = "url";
  }
  const resolution = requestedResolution(params).value;
  const resolutionField = String(protocolConfig.resolution_field || "").trim();
  if (resolution && resolutionField) body[resolutionField] = resolution;
  const negativePromptField = String(protocolConfig.negative_prompt_field || "").trim();
  if (params.negativePrompt && negativePromptField) body[negativePromptField] = params.negativePrompt;
  if (params.generateAudio !== undefined) {
    body[String(protocolConfig.generate_audio_field || "generate_audio")] = params.generateAudio;
  }

  const resp = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Kling官方API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();

  // 检查上游错误（HTTP 200也可能含错误）
  const errMsg = data.error?.message || data.error?.msg ||
                 (typeof data.error === "string" ? data.error : "") ||
                 data.message || "";
  if (errMsg) {
    return {
      taskId: "",
      status: "failed",
      error: `上游错误: ${errMsg.slice(0, 200)}`,
    };
  }

  const taskId = data.data?.task_id || data.task_id || "";
  const taskStatus = data.data?.task_status || data.task_status || "";

  if (!taskId) {
    return {
      taskId: "",
      status: "failed",
      error: "未获取到任务ID，提交可能失败",
    };
  }

  // submitted = 刚提交（排队中）
  const isQueued = ["submitted", "created", "pending"].some(s => taskStatus.toLowerCase().includes(s));
  return {
    taskId,
    status: isQueued ? "queued" : "processing",
  };
}

async function pollKlingOfficial(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  // 轮询路径 = 提交路径 + /{taskId}
  // text2video → https://yunwu.ai/kling/v1/videos/text2video/{taskId}
  // image2video → https://yunwu.ai/kling/v1/videos/image2video/{taskId}
  const pollUrl = `${config.api_endpoint}/${taskId}`;

  const resp = await fetch(pollUrl, {
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`Kling轮询失败: ${resp.status}`);
  }

  const data = await resp.json();

  // 检查错误
  const errMsg = data.error?.message || data.error?.msg ||
                 (typeof data.error === "string" ? data.error : "");
  if (errMsg) {
    return { taskId, status: "failed", error: `上游错误: ${errMsg.slice(0, 200)}` };
  }

  const taskStatus = (data.data?.task_status || data.task_status || "").toLowerCase();
  const taskMsg = data.data?.task_status_msg || "";

  // 成功
  if (taskStatus === "succeed") {
    const videos = data.data?.task_result?.videos || [];
    const videoUrl = videos[0]?.url || "";
    if (videoUrl) {
      return { taskId, status: "success", videoUrl };
    }
    return { taskId, status: "failed", error: "视频生成成功但未返回URL" };
  }

  // 失败
  if (taskStatus === "failed") {
    return { taskId, status: "failed", error: taskMsg || "视频生成失败" };
  }

  // 排队中
  if (["submitted", "created", "pending"].some(s => taskStatus.includes(s))) {
    return { taskId, status: "queued" };
  }

  // 渲染中
  return { taskId, status: "processing" };
}

// ─── Runway 适配器 ──────────────────────────────────
function configuredProtocolPollUrl(
  config: VideoModelConfig,
  taskId: string,
  defaultPath: (endpoint: URL) => string,
): string {
  const endpoint = new URL(config.api_endpoint);
  const configuredPath = String(config.api_protocol_config?.poll_path || "").trim();
  const template = configuredPath || defaultPath(endpoint);
  const withTaskId = template.replace(/\{(?:id|task_id)\}/giu, encodeURIComponent(taskId));
  if (/^https?:\/\//iu.test(withTaskId)) return withTaskId;
  if (withTaskId.startsWith("/")) return new URL(withTaskId, endpoint.origin).toString();

  const endpointDirectory = endpoint.pathname.endsWith("/")
    ? endpoint.pathname
    : endpoint.pathname.replace(/\/[^/]*$/u, "/");
  return new URL(`${endpointDirectory}${withTaskId}`, endpoint.origin).toString();
}

function runwayPollUrl(config: VideoModelConfig, taskId: string): string {
  return configuredProtocolPollUrl(config, taskId, endpoint => {
    const submitPath = endpoint.pathname.replace(/\/+$/u, "");
    const terminalSubmitPath = /\/(?:image_to_video|text_to_video|video_to_video)$/iu;
    if (terminalSubmitPath.test(submitPath)) {
      return `${submitPath.replace(terminalSubmitPath, "")}/tasks/{id}`;
    }
    const versionPrefix = submitPath.match(/^(.*\/v\d+)(?:\/.*)?$/iu)?.[1];
    return `${versionPrefix || submitPath}/tasks/{id}`;
  });
}

function replicatePollUrl(config: VideoModelConfig, taskId: string): string {
  return configuredProtocolPollUrl(
    config,
    taskId,
    endpoint => `${endpoint.pathname.replace(/\/+$/u, "")}/{id}`,
  );
}

async function generateRunway(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const body: Record<string, unknown> = {
    promptText: params.prompt,
    model: config.model_name || config.id,
    duration: params.duration || config.duration_seconds || 5,
    ratio: params.aspectRatio || "16:9",
  };
  if (params.imageUrl) body.promptImage = params.imageUrl;
  if (params.lastFrameUrl) body.lastFrameImage = params.lastFrameUrl;
  if (params.referenceImageUrl) body.referenceImage = params.referenceImageUrl;

  const resp = await fetch(config.api_endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "X-Runway-Version": "2024-11-06",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Runway API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  return { taskId: data.id || "", status: "processing" };
}

async function pollRunway(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const resp = await fetch(runwayPollUrl(config, taskId), {
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "X-Runway-Version": "2024-11-06",
    },
  });

  if (resp.status === 429) {
    return { taskId, status: "processing", progress: null, error: "Runway 状态查询限流（HTTP 429），正在自动重试" };
  }
  if (!resp.ok) throw new Error(`Poll failed: ${resp.status}`);

  const data = await resp.json();
  const status = data.status;

  if (status === "SUCCEEDED") {
    return { taskId, status: "success", videoUrl: data.output?.[0] || "" };
  }
  if (["FAILED", "CANCELED", "CANCELLED"].includes(status)) {
    return { taskId, status: "failed", error: data.error || "生成失败" };
  }
  return { taskId, status: "processing" };
}

// ─── Replicate 适配器 ──────────────────────────────
async function generateReplicate(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const protocolConfig = config.api_protocol_config || {};
  const input: Record<string, unknown> = {
    prompt: params.prompt,
    image: params.imageUrl || undefined,
    aspect_ratio: params.aspectRatio || "16:9",
    duration: Number(params.duration ?? config.duration_seconds ?? 5),
  };
  if (params.lastFrameUrl) input.last_frame_image = params.lastFrameUrl;
  if (params.referenceImageUrl) input.reference_image = params.referenceImageUrl;
  const resolution = requestedResolution(params).value;
  const resolutionField = String(protocolConfig.resolution_field || "").trim();
  if (resolution && resolutionField) input[resolutionField] = resolution;
  const negativePromptField = String(protocolConfig.negative_prompt_field || "").trim();
  if (params.negativePrompt && negativePromptField) input[negativePromptField] = params.negativePrompt;
  if (params.generateAudio !== undefined) {
    input[String(protocolConfig.generate_audio_field || "generate_audio")] = params.generateAudio;
  }

  const body = {
    version: config.model_name || config.id,
    input,
  };

  const resp = await fetch(config.api_endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Token ${config.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Replicate API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  return { taskId: data.id || "", status: "processing" };
}

async function pollReplicate(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const resp = await fetch(replicatePollUrl(config, taskId), {
    headers: { "Authorization": `Token ${config.api_key}` },
  });

  if (resp.status === 429) {
    return { taskId, status: "processing", progress: null, error: "Replicate 状态查询限流（HTTP 429），正在自动重试" };
  }
  if (!resp.ok) throw new Error(`Poll failed: ${resp.status}`);

  const data = await resp.json();
  const status = data.status;

  if (status === "succeeded") {
    const output = Array.isArray(data.output) ? data.output[0] : data.output;
    return { taskId, status: "success", videoUrl: output || "" };
  }
  if (status === "failed" || status === "canceled" || status === "cancelled") {
    return { taskId, status: "failed", error: data.error || "生成失败" };
  }
  return { taskId, status: "processing" };
}

// ─── 工具函数 ──────────────────────────────────────
function mapUnifiedStatus(status: unknown): "processing" | "success" | "failed" {
  const normalized = String(status || "").trim().toLowerCase();
  if (["success", "completed", "succeeded"].includes(normalized)) return "success";
  if (["failed", "error", "cancelled", "canceled", "terminated"].includes(normalized)) return "failed";
  return "processing";
}

// ─── Veo NewAPI 适配器（OpenClaw等中转站） ─────────────────
/**
 * Veo NewAPI 协议
 * 提交：POST /v1/videos  {model, prompt, size, duration, images, metadata}
 * 轮询：GET /v1/videos/{task_id}
 * 返回：{id/task_id, status:"in_progress"|"completed"|"failed", progress:0-100, video_url}
 * 支持模型：veo_3_1, veo_3_1-4K, veo_3_1-fast, veo_3_1-fast-4K, veo_3_1-lite, veo_3_1-lite-4K
 */
async function generateVeoNewAPI(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/v1\/?$/, "");
  const submitUrl = `${baseUrl}/v1/videos`;

  // 构建size参数：根据aspect_ratio映射到像素分辨率
  const ratio = params.aspectRatio || "16:9";
  const sizeFromResolution = params.resolution || "";
  let size: string;
  if (sizeFromResolution) {
    size = sizeFromResolution;
  } else if (ratio === "16:9") {
    size = "1280x720";
  } else if (ratio === "9:16") {
    size = "720x1280";
  } else if (ratio === "1:1") {
    size = "720x720";
  } else if (ratio === "4:3") {
    size = "960x720";
  } else if (ratio === "3:4") {
    size = "720x960";
  } else {
    size = "1280x720";
  }
  const orientation = ratio === "16:9" || ratio === "4:3" ? "landscape" : ratio === "9:16" || ratio === "3:4" ? "portrait" : "square";

  const durationValue = params.duration || config.duration_seconds || 8;
  const body: Record<string, unknown> = {
    model: config.model_name || "veo_3_1-fast",
    prompt: params.prompt,
    size,
    duration: durationValue,
    retry_times: 3,
    metadata: {
      aspect_ratio: params.aspectRatio || "16:9",
      orientation,
      enhance_prompt: true,
    },
  };

  // 图片输入（openclaw 使用 image 字段）
  if (params.imageUrl) {
    body.image = params.imageUrl;
  }
  // 尾帧图
  if (params.lastFrameUrl) {
    body.last_frame_image = params.lastFrameUrl;
  }
  // 参考图（风格参考）
  if (params.referenceImageUrl) {
    body.reference_image = params.referenceImageUrl;
  }

  const resp = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    let errMsg = `Veo NewAPI ${resp.status}: ${errText.slice(0, 300)}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.message) errMsg = errJson.message;
      if (errJson.error?.message) errMsg = errJson.error.message;
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }

  const data = await resp.json() as Record<string, unknown>;

  // 提取 task_id（可能在不同字段）
  const taskId = (data.id as string) || (data.task_id as string) || ((data.data as Record<string, unknown>)?.id as string);
  if (!taskId) {
    const errMsg = (data as Record<string, unknown>).message || (data as Record<string, unknown>).error || JSON.stringify(data).slice(0, 200);
    throw new Error(`Veo NewAPI 未返回task_id: ${errMsg}`);
  }

  const status = (data.status as string) || "in_progress";

  return {
    taskId,
    status: status === "in_progress" || status === "queued" || status === "pending" ? "queued" : "processing",
    progress: (data.progress as number) || null,
  };
}

async function pollVeoNewAPI(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/v1\/?$/, "");
  const pollUrl = `${baseUrl}/v1/videos/${taskId}`;

  const resp = await fetch(pollUrl, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Accept": "application/json",
    },
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    let errMsg = `Veo NewAPI poll ${resp.status}: ${errText.slice(0, 300)}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.message) errMsg = errJson.message;
      if (errJson.code === "task_not_exist") errMsg = "task_not_exist";
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }

  const data = await resp.json() as Record<string, unknown>;
  const status = String(data.status || "").toLowerCase();

  if (status === "completed" || status === "succeeded" || status === "success") {
    // video_url可能在多个位置：顶层、metadata.url、output.media_url/output.video_url
    const videoUrl =
      (data.video_url as string) ||
      ((data.metadata as Record<string, unknown>)?.url as string) ||
      ((data.output as Record<string, unknown>)?.media_url as string) ||
      ((data.output as Record<string, unknown>)?.video_url as string) ||
      (data.media_url as string) ||
      "";
    return {
      taskId,
      status: "success",
      videoUrl,
      progress: (data.progress as number) || 100,
    };
  }

  if (status === "failed" || status === "error" || status === "failure" || status === "terminated" || status === "cancelled") {
    const errorData = data.error as Record<string, unknown> | undefined;
    let errMsg = (errorData?.message as string) || (data.message as string) || "视频生成失败";
    if (status === "terminated" || status === "cancelled") {
      errMsg = errMsg.includes("终止") ? errMsg : `上游已终止任务: ${errMsg}`;
    }
    return {
      taskId,
      status: "failed",
      error: errMsg,
      progress: data.progress as number || null,
    };
  }

  // in_progress / queued / pending / submitted / processing
  const isQueued = status === "queued" || status === "pending" || status === "submitted";
  return {
    taskId,
    status: isQueued ? "queued" : "processing",
    progress: data.progress as number || null,
  };
}

// ─── 高瑞视频专属通道（gaorui_video）──────────────────────────
/**
 * 高瑞视频协议（gaorui_video）
 * 独立专属通道，隔离于通用 openapi_video，确保高瑞平台变更不影响其他平台
 *
 * 提交：POST https://gaorui.cc/v1/videos  {model, prompt, size, seconds, quality, image_url/image_urls}
 * 轮询：GET  https://gaorui.cc/v1/videos/{task_id}
 * 下载：GET  https://gaorui.cc/v1/videos/{task_id}/content（二进制流，降级备用）
 *
 * 模型差异：
 * - grok-imagine-1.0-video：文生/图生，image_urls(数组，可选)，时长6/10/12/16/20秒
 * - grok-imagine-video-1.5-preview：仅图生，image_url(单值，必传)，时长4-15秒
 *
 * 轮询响应格式：
 *   processing: {id, task_id, object, model, status:"processing", progress, created_at}
 *   completed:  {id, task_id, object, model, status:"completed", progress:100, video_url, output:{url}}
 *
 * 设计原则（参照云雾通道隔离保障模式）：
 * 1. 连接预检——快速检测上游可达性，不可达立即反馈
 * 2. 提交重试——3次指数退避，避免网络抖动误判失败
 * 3. 状态严格同步——上游在跑我们就等，上游说成功才成功，上游说失败才失败
 * 4. 下载降级——video_url 优先，output.url 兜底，content 接口最后保障
 * 5. 超时保护——提交60秒，轮询30秒，防止无限挂起
 * 6. 隔离性——高瑞专属代码路径，不影响其他平台
 */

/** 高瑞通道专用日志前缀 */
const GR_LOG = "[高瑞通道]";

function isDeterministicGaoruiModelError(message: string) {
  return /model_not_found|no available channel|unsupported model|model (?:is )?not (?:found|supported)|模型(?:不存在|已下架|不支持)|无可用(?:模型)?通道/i.test(message);
}

function videoSubmissionUnknown(submissionReceipt?: VideoSubmissionReceiptEvidence): VideoTaskResult {
  return {
    taskId: "", status: "processing", progress: null, submissionOutcome: "unknown",
    error: "上游提交结果尚未确认，请保留原任务，暂不要重复生成",
    submissionReceipt,
  };
}

/** Only scalar, nonempty provider IDs are acknowledgements; an object or boolean is not a task. */
function videoSubmissionTaskId(...values: unknown[]): string {
  for (const value of values) {
    const id = typeof value === "string" ? value.trim()
      : typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "";
    if (id && !/[\s\u0000-\u001f\u007f]/u.test(id)) return id;
  }
  return "";
}

type VideoSubmissionResponseMetadata = {
  bodyBytes?: number;
  bodySha256?: string;
  parseState: "json_object" | "json_non_object" | "empty" | "malformed" | "unreadable";
};

/** This helper is used by submission only. It never retries a dispatched POST. */
async function videoSubmitOnce(url: string, init: RequestInit): Promise<{
  resp: Response;
  data: Record<string, unknown>;
  responseMetadata: VideoSubmissionResponseMetadata;
} | null> {
  try {
    const resp = await fetch(url, init);
    let responseText: string;
    try {
      responseText = await resp.text();
    } catch {
      return { resp, data: {}, responseMetadata: { parseState: "unreadable" } };
    }
    const bodyBytes = Buffer.byteLength(responseText, "utf8");
    const bodySha256 = createHash("sha256").update(responseText, "utf8").digest("hex");
    if (!responseText.trim()) {
      return { resp, data: {}, responseMetadata: { bodyBytes, bodySha256, parseState: "empty" } };
    }
    try {
      const parsed: unknown = JSON.parse(responseText);
      const object = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      return {
        resp,
        data: object ? parsed as Record<string, unknown> : { _raw: parsed },
        responseMetadata: { bodyBytes, bodySha256, parseState: object ? "json_object" : "json_non_object" },
      };
    } catch {
      return { resp, data: {}, responseMetadata: { bodyBytes, bodySha256, parseState: "malformed" } };
    }
  } catch {
    return null;
  }
}

function videoSubmissionWithoutTask(
  resp: Response,
  data: Record<string, unknown>,
  provider: string,
  submissionReceipt?: VideoSubmissionReceiptEvidence,
): VideoTaskResult {
  const nested = data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data as Record<string, unknown> : {};
  const details = [data, nested].flatMap(record => {
    const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as Record<string, unknown> : {};
    return [record.message, record.error, record.detail, record.code, record.status, error.message, error.code, error.type];
  }).filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(": ");
  // Some providers wrap explicit refusals in HTTP 200/503. A generic error/5xx
  // does not establish that generation was rejected and must remain unknown.
  const refused = isDeterministicGaoruiModelError(details)
    || /no[_ ]+(?:available[_ ]+)?accounts?(?:[_ ]+available)?|insufficient[_ ](?:quota|balance|credits)|invalid[_ ](?:api[_ ]?key|request|parameter|argument)|unauthorized|authentication[_ ]error|permission[_ ]denied|content[_ ]policy[_ ]violation|\btask_failed\b|\brejected\b|无可用账号|余额不足|配额不足/iu.test(details);
  if ((resp.status >= 400 && resp.status < 500) || refused) {
    return {
      taskId: "",
      status: "failed",
      error: `${provider}: ${(details || `上游拒绝提交（HTTP ${resp.status}）`).slice(0, 300)}`,
      submissionReceipt,
    };
  }
  return videoSubmissionUnknown(submissionReceipt);
}

const SECURE_SKILL_RECEIPT_ID_FIELDS = ["task_id", "id", "request_id", "requestId", "video_id", "job_id"] as const;
const SECURE_SKILL_RESERVED_LOCATION_SEGMENTS = new Set([
  "content", "generations", "health", "health_check", "jobs", "status", "tasks", "video", "videos",
]);

function receiptSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureSkillProviderRequestKey(params: VideoGenerateParams): string {
  const supplied = String(params.idempotencyKey || "").trim();
  if (/^[A-Za-z0-9._:-]{8,240}$/u.test(supplied)) return supplied;
  if (supplied) return `video-${receiptSha256(supplied).slice(0, 48)}`;
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function secureSkillIdempotencyHeaders(
  providerRequestKey: string,
  includeLegacyHeader = false,
): Record<string, string> {
  return {
    "X-Idempotency-Key": providerRequestKey,
    ...(includeLegacyHeader ? { "Idempotency-Key": providerRequestKey } : {}),
  };
}

/** Secure Skill task IDs are opaque scalars, never URLs, query strings, or response objects. */
function secureSkillReceiptTaskId(value: unknown): string {
  const id = videoSubmissionTaskId(value);
  if (!id || id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) return "";
  return SECURE_SKILL_RESERVED_LOCATION_SEGMENTS.has(id.toLowerCase()) ? "" : id;
}

function secureSkillReceiptRecords(data: Record<string, unknown>): Array<{ path: string; record: Record<string, unknown> }> {
  const records = [{ path: "", record: data }];
  const rootTask = data.task;
  if (rootTask && typeof rootTask === "object" && !Array.isArray(rootTask)) {
    records.push({ path: "task.", record: rootTask as Record<string, unknown> });
  }
  const nestedData = data.data;
  if (nestedData && typeof nestedData === "object" && !Array.isArray(nestedData)) {
    const record = nestedData as Record<string, unknown>;
    records.push({ path: "data.", record });
    const nestedTask = record.task;
    if (nestedTask && typeof nestedTask === "object" && !Array.isArray(nestedTask)) {
      records.push({ path: "data.task.", record: nestedTask as Record<string, unknown> });
    }
  }
  return records;
}

function secureSkillTaskIdFromBody(data: Record<string, unknown>): string {
  for (const { record } of secureSkillReceiptRecords(data)) {
    for (const field of SECURE_SKILL_RECEIPT_ID_FIELDS) {
      const id = secureSkillReceiptTaskId(record[field]);
      if (id) return id;
    }
  }
  return "";
}

function secureSkillTaskIdFromLocation(
  location: string | null,
  endpoint: string,
  collectionSegments: readonly string[] = ["videos"],
): string {
  const raw = location?.trim() || "";
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) return "";
  // A bare opaque ID is permitted. Values containing URL syntax must pass the
  // same-host, protocol-specific collection/{id} check; query values are never IDs.
  if (!/[/?#]/u.test(raw)) return secureSkillReceiptTaskId(raw);
  try {
    const endpointUrl = new URL(endpoint);
    const locationUrl = new URL(raw, endpointUrl);
    if (locationUrl.host !== endpointUrl.host || locationUrl.protocol !== endpointUrl.protocol) return "";
    const segments = locationUrl.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
    if (segments.length < 2) return "";
    const collection = segments[segments.length - 2].toLowerCase();
    const allowedCollections = new Set(collectionSegments.map(segment => segment.toLowerCase()));
    if (!allowedCollections.has(collection)) return "";
    return secureSkillReceiptTaskId(segments[segments.length - 1]);
  } catch {
    return "";
  }
}

function secureSkillSubmissionReceipt(
  endpoint: string,
  providerRequestKey: string,
  response?: { resp: Response; data: Record<string, unknown>; responseMetadata: VideoSubmissionResponseMetadata },
): VideoSubmissionReceiptEvidence {
  let endpointHost = "invalid";
  try { endpointHost = new URL(endpoint).host || "invalid"; } catch { /* Keep a non-sensitive sentinel. */ }
  if (!response) {
    return {
      schemaVersion: 1,
      receiptState: "transport_unavailable",
      endpointHost,
      providerRequestKeySha256: receiptSha256(providerRequestKey),
    };
  }
  const location = response.resp.headers.get("Location");
  const mime = (response.resp.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  const candidateFieldPaths = secureSkillReceiptRecords(response.data).flatMap(({ path, record }) =>
    SECURE_SKILL_RECEIPT_ID_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(record, field)).map(field => `${path}${field}`),
  );
  return {
    schemaVersion: 1,
    receiptState: response.responseMetadata.parseState === "unreadable" ? "response_body_unreadable" : "response_received",
    endpointHost,
    providerRequestKeySha256: receiptSha256(providerRequestKey),
    httpStatus: response.resp.status,
    contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(mime) ? mime : undefined,
    responseBodyBytes: response.responseMetadata.bodyBytes,
    responseBodySha256: response.responseMetadata.bodySha256,
    responseParseState: response.responseMetadata.parseState,
    locationPresent: Boolean(location),
    locationSha256: location ? receiptSha256(location) : undefined,
    candidateFieldPaths,
  };
}

/** 高瑞平台连接预检（快速检测上游可达性） */
export async function checkGaoruiHealth(apiEndpoint: string, apiKey: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const baseUrl = apiEndpoint.replace(/\/v1\/?$/, "");
  const start = Date.now();
  try {
    // 用一个无效task_id探测，只要服务器响应即可（404也算健康）
    const resp = await fetch(`${baseUrl}/v1/videos/health_check`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const ms = Date.now() - start;
    return { ok: resp.status < 500, ms };
  } catch {
    const ms = Date.now() - start;
    return { ok: false, ms, error: ms >= 9000 ? "连接超时" : "网络不可达" };
  }
}

/** 高瑞比例→像素映射 */
const GAORUI_SIZE_MAP: Record<string, string> = {
  "16:9": "1280x720",
  "9:16": "720x1280",
  "1:1": "1024x1024",
  "4:3": "960x720",
  "3:4": "720x960",
  "3:2": "1792x1024",
  "2:3": "1024x1792",
};

const GAORUI_ALLOWED_PIXEL_SIZES = new Set([
  "720x1280",
  "1280x720",
  "1024x1024",
  "1792x1024",
  "1024x1792",
]);

function gaoruiPixelSize(resolution: unknown, aspectRatio: string): string {
  const requested = String(resolution || "").trim().toLowerCase();
  // The public UI passes tiers such as `720p` in both resolution fields. The
  // Gaorui Grok 1.0 API calls this field `size`, but accepts only exact pixel
  // dimensions (or an aspect ratio). Never forward a UI tier as `size`.
  if (GAORUI_ALLOWED_PIXEL_SIZES.has(requested)) return requested;
  if (Object.prototype.hasOwnProperty.call(GAORUI_SIZE_MAP, requested)) {
    return GAORUI_SIZE_MAP[requested];
  }
  return GAORUI_SIZE_MAP[aspectRatio] || "1280x720";
}

/**
 * 将目标时长映射到 Omni Flash 支持的档位
 * Omni Flash 官方支持：6秒、8秒、10秒
 *
 * 映射规则（向上取最近的档位）：
 *   ≤6秒 → 6（最小档）
 *   7-8秒 → 8
 *   9-10秒 → 10
 *   >10秒 → 10（最大档，超出部分会被截断）
 */
function mapToOmniFlashDuration(targetSeconds: number): number {
  if (targetSeconds <= 6) return 6;
  if (targetSeconds <= 8) return 8;
  return 10;
}

async function generateGaoruiVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/v1\/?$/, "");
  const submitUrl = `${baseUrl}/v1/videos`;

  // ① 构建请求参数
  const aspectRatio = params.aspectRatio || "16:9";
  const modelName = config.model_name || "grok-imagine-1.0-video";
  const isV15 = modelName.includes("1.5");
  const isV15Preview = isV15 && modelName.includes("preview");
  const isOmni = modelName.startsWith("omni_");
  const isOmniEdit = modelName.includes("abra_edit");
  const isGaoruiVeo = /^veo_3_1(?:-fl|-components)?$/.test(modelName);
  const isSeedance2 = /^seedance-2\.0(?:-|$)/i.test(modelName);

  // 提示词时长解析只作兼容兜底；正常链路始终显式传入模型提交时长。
  // 优先级：显式传入的duration > 提示词解析时长 > 模型默认时长
  const parsedDuration = extractPromptDurationSeconds(params.prompt);
  const isOmniFlash = isOmni && modelName.includes("flash");
  const finalDuration = params.duration || parsedDuration || config.duration_seconds || 10;
  // 映射到Omni Flash支持的档位（6/8/10秒），其他模型用原始值
  const mappedDuration = isOmniFlash ? mapToOmniFlashDuration(finalDuration) : finalDuration;

  if (parsedDuration && parsedDuration !== mappedDuration) {
    console.log(`${GR_LOG} 提示词解析时长=${parsedDuration}秒 → 映射到模型档位=${mappedDuration}秒`);
  }

  const configuredQuality = (config.api_protocol_config as Record<string, unknown>)?.quality;
  const body: Record<string, unknown> = {
    model: modelName,
    prompt: params.prompt,
    aspect_ratio: aspectRatio,
    seconds: mappedDuration,
    quality: typeof configuredQuality === "string" && configuredQuality.trim()
      ? configuredQuality.trim()
      : isOmni ? "high" : "standard",
  };
  if (isSeedance2) delete body.quality;
  if (isGaoruiVeo) { delete body.quality; delete body.seconds; }
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;

  // Omni系列使用resolution参数（720p/1080p/4k），Grok系列使用size参数（像素尺寸）
  // api_protocol_config.resolution 可作为模型级默认分辨率
  const configResolution = (config.api_protocol_config as Record<string, unknown>)?.resolution as string | undefined;
  if (isOmni) {
    body.resolution = params.resolutionTier || configResolution || "1080p";
  } else if (isSeedance2 || isGaoruiVeo) {
    body.resolution = params.resolutionTier || configResolution || "720p";
  } else if (isV15) {
    const requestedTier = String(params.resolutionTier || configResolution || "720p").toLowerCase();
    body.resolution = requestedTier === "480p" ? "480p" : "720p";
  } else {
    body.size = gaoruiPixelSize(params.resolution, aspectRatio);
  }

  // Omni Edit模型需要source_video_url（视频编辑）
  if (isOmniEdit && params.sourceVideoUrl) {
    body.source_video_url = params.sourceVideoUrl;
  }

  // 当只有referenceImageUrl没有imageUrl时，将referenceImageUrl提升为imageUrl
  // 仅对支持图片输入的模型生效：参考图作为视频生成的输入图
  // （上游API的 image_url/image_urls 是实际图片输入入口，reference_image_url 字段常被忽略）
  // Omni等纯文生视频模型(supports_image_input=false)不提升，避免发送不接受的数据导致API报错
  if (!params.imageUrl && params.referenceImageUrl && config.supports_image_input) {
    const refUrl = params.referenceImageUrl;
    params = { ...params, imageUrl: refUrl };
    console.log(`${GR_LOG} 参考图已提升为输入图`);
  }

  // 图片参数处理
  // Omni系列使用 input_reference（URL数组，支持参考图/首帧/尾帧）
  // Grok 1.0 / 1.5 都使用 image_urls；1.5 正式版最多 5 图，preview 保持单图能力。
  if (isSeedance2) {
    const protocolConfig = (config.api_protocol_config || {}) as Record<string, unknown>;
    const imageField = typeof protocolConfig.image_field === "string" ? protocolConfig.image_field : "reference_images";
    const sourceVideoField = typeof protocolConfig.source_video_field === "string" ? protocolConfig.source_video_field : "reference_videos";
    const audioField = typeof protocolConfig.audio_field === "string" ? protocolConfig.audio_field : "reference_audios";
    const referenceImages = [params.imageUrl, params.referenceImageUrl, params.lastFrameUrl, ...(params.imageUrls || [])]
      .filter((url, index, urls): url is string => typeof url === "string" && /^https:\/\//i.test(url) && urls.indexOf(url) === index);
    const sourceVideoUrl = params.sourceVideoUrl;
    const referenceAudios = [params.audioUrl, ...(params.audioUrls || [])]
      .filter((url, index, urls): url is string => typeof url === "string" && /^https:\/\//i.test(url) && urls.indexOf(url) === index);
    if (referenceImages.length > 0) body[imageField] = referenceImages;
    if (sourceVideoUrl && /^https:\/\//i.test(sourceVideoUrl)) body[sourceVideoField] = [sourceVideoUrl];
    if (referenceAudios.length > 0) body[audioField] = referenceAudios;
    body.generate_audio = params.generateAudio ?? protocolConfig.generate_audio !== false;
  } else if (isOmni) {
    const refs: string[] = [];
    if (params.imageUrl) refs.push(params.imageUrl);
    if (params.lastFrameUrl) refs.push(params.lastFrameUrl);
    for (const ref of params.imageUrls || []) if (!refs.includes(ref)) refs.push(ref);
    if (refs.length > 0) {
      body.input_reference = refs;
    }
    // 首尾帧模式：同时有首帧和尾帧时启用 first_last_frame
    if (params.imageUrl && params.lastFrameUrl) {
      body.first_last_frame = true;
    }
  } else if (isGaoruiVeo) {
    if (modelName !== "veo_3_1") {
      const refs = [params.imageUrl, params.lastFrameUrl, params.referenceImageUrl, ...(params.imageUrls || [])]
        .filter((value, index, items): value is string => Boolean(value) && items.indexOf(value) === index);
      if (!refs.length) return { taskId: "", status: "failed", error: "Veo 首尾帧或参考图模型必须提供图片" };
      body.images = modelName.endsWith("-fl") ? refs.slice(0, 2) : refs;
    }
  } else {
    const protocolConfig = (config.api_protocol_config || {}) as Record<string, unknown>;
    const configuredMaximum = Number(protocolConfig.max_reference_images);
    const maximumImages = Number.isFinite(configuredMaximum) && configuredMaximum > 0
      ? Math.min(9, Math.round(configuredMaximum))
      : isV15Preview ? 1 : isV15 ? 5 : 9;
    const refs = [params.imageUrl, params.referenceImageUrl, params.lastFrameUrl, ...(params.imageUrls || [])]
      .filter((value, index, items): value is string => typeof value === "string" && value.trim().length > 0 && items.indexOf(value) === index)
      .slice(0, maximumImages);
    if (refs.length > 0) body.image_urls = refs;
  }

  // Preview 保持必须参考图；正式 1.5 支持文生、单图和最多五图。
  if (isV15Preview && !Array.isArray(body.image_urls)) {
    return {
      taskId: "",
      status: "failed",
      error: "Grok Imagine 1.5 必须提供参考图片",
    };
  }

  // Omni Edit模型必须有源视频
  if (isOmniEdit && !params.sourceVideoUrl) {
    return {
      taskId: "",
      status: "failed",
      error: "视频编辑模型必须提供源视频",
    };
  }

  const headers = {
    "Authorization": `Bearer ${config.api_key}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  console.log(`${GR_LOG} 提交视频: model=${modelName}, resolution=${body.resolution || body.size}, seconds=${body.seconds}, 图生=${!!params.imageUrl}, 视频参考=${!!params.sourceVideoUrl}, 音频参考=${!!params.audioUrl}, 视频编辑=${isOmniEdit}`);

  // 丢失提交回执不能证明失败：保留原任务，任何情况下都不自动重发 POST。
  const acknowledgement = await videoSubmitOnce(submitUrl, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!acknowledgement) return videoSubmissionUnknown();
  const { resp, data } = acknowledgement;
  const locationId = resp.headers.get("Location")?.match(/\/videos\/([^/?#]+)/)?.[1];
  const taskId = videoSubmissionTaskId(data.id, data.task_id, locationId);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "高瑞提交");

  const status = safeStr(data.status, "processing").toLowerCase();
  const rawProgress = safeNum(data.progress, 0);
  const isQueued = (status === "queued" || status === "pending" || status === "submitted") && !rawProgress;
  return { taskId, status: isQueued ? "queued" : "processing", progress: rawProgress };
}

async function pollGaoruiVideo(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/v1\/?$/, "");
  const pollUrl = `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`;

  const resp = await fetch(pollUrl, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });

  // 404 = 任务不存在（可能已过期被清理）
  if (resp.status === 404) {
    return { taskId, status: "failed", error: "任务不存在或已过期" };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    let errMsg = `轮询失败 HTTP ${resp.status}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.message) errMsg = errJson.message;
    } catch { /* ignore */ }
    // 5xx 不判死，可能是临时故障，让前端继续轮询
    if (resp.status >= 500) {
      console.warn(`${GR_LOG} 轮询5xx(${resp.status})，保持processing: ${errMsg}`);
      return { taskId, status: "processing", progress: null };
    }
    throw new Error(errMsg);
  }

  const data = await safeParseJson(resp);
  const status = safeStr(data.status, "processing").toLowerCase();

  // ✅ 上游成功 → 我们成功
  if (status === "completed" || status === "succeeded" || status === "success") {
    // 提取视频URL（五级降级）：
    //   ① 顶层 video_url
    //   ② 顶层 url（gaorui实际返回格式：{url: "https://media.veo9.uk/.../0.mp4"}）
    //   ③ metadata.video_url / metadata.url
    //   ④ output.url（嵌套格式）
    //   ⑤ /v1/videos/{id}/content 下载接口（需认证，浏览器无法直接播放，最后降级）
    let videoUrl = safeStr(data.video_url);
    if (!videoUrl) {
      videoUrl = safeStr(data.url);
    }
    if (!videoUrl) {
      const metadata = data.metadata;
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        videoUrl = safeStr((metadata as Record<string, unknown>).video_url)
          || safeStr((metadata as Record<string, unknown>).url);
      }
    }
    if (!videoUrl) {
      const output = data.output;
      if (output && typeof output === "object" && !Array.isArray(output)) {
        videoUrl = safeStr((output as Record<string, unknown>).url);
      }
    }

    // 最终降级：走 /v1/videos/{task_id}/content 下载接口
    if (!videoUrl) {
      videoUrl = `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}/content`;
      console.log(`${GR_LOG} video_url为空，降级使用content接口: ${videoUrl}`);
    }

    // 标记是否需要代理播放：/content 端点需要 API key 认证，浏览器无法直接播放
    const needsProxy = videoUrl.includes("/v1/videos/") && videoUrl.endsWith("/content");

    console.log(`${GR_LOG} 任务完成: taskId=${taskId}, hasVideoUrl=${Boolean(videoUrl)}, needsProxy=${needsProxy}`);
    return {
      taskId,
      status: "success",
      videoUrl,
      needsProxy,
      progress: safeNum(data.progress, 100),
    };
  }

  // ❌ 上游失败 → 我们失败（立即反馈，不卡进度条）
  if (status === "failed" || status === "error" || status === "failure" || status === "terminated" || status === "cancelled") {
    const errorData = data.error;
    let errMsg = "视频生成失败";
    if (typeof errorData === "string") errMsg = errorData;
    else if (errorData && typeof errorData === "object") errMsg = safeStr((errorData as Record<string, unknown>).message, errMsg);
    else if (data.message) errMsg = safeStr(data.message, errMsg);

    console.warn(`${GR_LOG} 上游失败: taskId=${taskId}, status=${status}, error=${errMsg}`);
    return {
      taskId,
      status: "failed",
      error: errMsg,
      progress: safeNum(data.progress, 0),
    };
  }

  // ⏳ 上游在跑 → 我们继续等（严格同步，不超时判死）
  // 注意：高瑞API在渲染阶段仍返回 status="queued"，需用 progress 判断实际阶段
  // progress > 0 说明已分配资源正在渲染，应映射为 processing
  const progressVal = safeNum(data.progress, null);
  const isQueued = (status === "queued" || status === "pending" || status === "submitted") && !progressVal;
  console.log(`${GR_LOG} 轮询中: taskId=${taskId}, status=${status}, progress=${progressVal}`);
  return {
    taskId,
    status: isQueued ? "queued" : "processing",
    progress: progressVal,
  };
}

// ─── 云雾视频专属通道（隔离于通用 openapi_video） ──────────────────
/**
 * 云雾视频专属通道（yunwu_video）
 * 独立于通用 openapi_video，确保云雾平台变更不影响其他平台
 *
 * 提交：POST {base}/v1/video/create  {model, prompt, aspect_ratio, size, duration, images}
 * 轮询：GET  {base}/v1/video/query?id={task_id}
 *
 * 响应格式（双格式兼容）：
 *   格式A（嵌套）：{data: {task_id: "task_xxx", status: "processing"}, code: 200}
 *   格式B（根级）：{id: "grok:xxx", status: "processing", status_update_time}
 *
 * 提交返回状态：pending, processing, submitted
 * 轮询返回状态：pending → image_downloading → video_generating → video_generation_completed →
 *   video_upsampling → video_upsampling_completed → completed
 * 失败态：failed, error, terminated, cancelled, video_generation_failed, video_upsampling_failed
 *
 * 设计原则：
 * 1. 连接预检——5秒快速检测上游可达性，不可达立即反馈，不浪费用户180秒等待
 * 2. 超时优化——提交30秒/轮询15秒，符合视频API实际响应节奏
 * 3. 上游终止→平台终止——检测terminated/cancelled状态，立即反馈用户
 * 4. 错误码识别——code=task_failed/error 时提取中文错误信息
 * 5. 隔离性——云雾专属代码，不与其他平台交叉
 *
 * 支持模型：grok-video-3, grok-video-3-10s, veo3.1-fast 等
 * 支持比例：16:9, 9:16, 1:1, 3:2, 2:3
 */

// ──── New API (openclaw) 专属适配器 ────────────────────────────────────
// 协议文档：demo_veo.py
// 特点：
// 1. 请求格式——image(单张)/images(多张)/input_reference(参考图)，不是image_url
// 2. task_id三级提取——id → task_id → data.id
// 3. 状态词丰富——completed/succeeded/success/failed/error/failure/cancelled/canceled
// 4. 专用字段——retry_times(1-5), metadata(aspect_ratio/orientation/enhance_prompt等)
// 5. 错误格式——{code,message,data} 和 {status:"failed",error:{code,message}}
// 6. 隔离性——New API专属代码，不与其他平台交叉

/** New API (openclaw) 连接预检 */
async function checkNewApiHealth(baseUrl: string, apiKey: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const url = baseUrl.replace(/\/+$/, '') + '/v1/videos';
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: resp.status < 500, latencyMs: Date.now() - start };
  } catch (e: unknown) {
    return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message };
  }
}

/** New API (openclaw) 提交视频任务 */
async function generateNewApiVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/+$/, '').replace(/\/v1\/?$/, '');
  const apiKey = config.api_key || '';
  const submitUrl = baseUrl + '/v1/videos';
  const proto = config.api_protocol_config || {};
  const requestFormat = proto.request_format || "json";
  const durationSec = params.duration || config.duration_seconds;
  const idempotencyKey = String(params.idempotencyKey || "").trim();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (/^[A-Za-z0-9._:-]{8,240}$/u.test(idempotencyKey)) headers["Idempotency-Key"] = idempotencyKey;

  let requestBody: BodyInit;
  if (requestFormat === "multipart") {
    const form = new FormData();
    form.set("model", String(config.model_name || ""));
    form.set("prompt", params.prompt);
    const sizeField = String(proto.size_field || "size").trim();
    const sizeSource = proto.size_value_source || "pixel_size";
    const aspectRatio = params.aspectRatio || "16:9";
    const pixelSizeByRatio: Record<string, string> = {
      "16:9": "1280x720",
      "9:16": "720x1280",
      "1:1": "720x720",
      "4:3": "960x720",
      "3:4": "720x960",
    };
    const sizeValue = sizeSource === "aspect_ratio"
      ? aspectRatio
      : sizeSource === "resolution"
        ? String(params.resolutionTier || proto.default_resolution || params.resolution || "720p")
        : String(params.resolution || pixelSizeByRatio[aspectRatio] || "1280x720");
    if (sizeField) form.set(sizeField, sizeValue);
    const durationField = String(proto.duration_field || "seconds").trim();
    if (durationField && durationSec) form.set(durationField, String(durationSec));

    const referenceUrl = params.imageUrl || params.referenceImageUrl || "";
    if (referenceUrl && config.supports_image_input) {
      try {
        const material = await readSuanlichengMaterial(referenceUrl, "image", params.inputOwnerId);
        const contentType = material.contentType || "image/png";
        const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
        form.set(String(proto.image_field || "input_reference"), new Blob([material.buffer], { type: contentType }), `reference.${extension}`);
      } catch (error) {
        return { taskId: "", status: "failed", error: error instanceof Error ? error.message : "参考图片读取失败，请重新上传" };
      }
    }
    requestBody = form;
  } else {
    headers["Content-Type"] = "application/json";

    // LConAI 的字段白名单会随模型别名变化。既有 NewAPI 模型默认继续发送 ratio；
    // 已实测拒绝宽高比字段的模型必须通过配置显式省略，不能在失败后用第二次付费 POST 猜字段。
    const body: Record<string, unknown> = {
      model: config.model_name,
      prompt: params.prompt,
    };
    if (proto.omit_aspect_ratio !== true) {
      const aspectRatioField = String(proto.aspect_ratio_field || "ratio").trim();
      if (aspectRatioField) body[aspectRatioField] = params.aspectRatio || "16:9";
    }

    const durationField = String(proto.duration_field || "duration").trim();
    if (durationField && durationSec) body[durationField] = durationSec;
    const resolutionValue = String(params.resolutionTier || proto.default_resolution || params.resolution || "").trim();
    if (resolutionValue) body[String(proto.resolution_field || "resolution")] = resolutionValue;

    // 图片：URL 字符串数组（LConAI Seedance JSON 契约）；按首帧、尾帧、参考图顺序提交。
    const imageUrls: string[] = [];
    if (params.imageUrl) imageUrls.push(params.imageUrl);
    if (params.lastFrameUrl) imageUrls.push(params.lastFrameUrl);
    if (params.referenceImageUrl && !imageUrls.includes(params.referenceImageUrl)) imageUrls.push(params.referenceImageUrl);
    if (Array.isArray(params.imageUrls)) {
      for (const extra of params.imageUrls) {
        if (typeof extra === "string" && extra && !imageUrls.includes(extra)) imageUrls.push(extra);
      }
    }
    if (imageUrls.length > 0) body[String(proto.image_field || "images")] = imageUrls;
    const audioUrls=[params.audioUrl,...(params.audioUrls||[])].filter((value,index,values):value is string=>typeof value==='string'&&!!value&&!values.slice(0,index).includes(value));
    if(audioUrls.length>0)body[String(proto.audio_field || "audios")]=audioUrls;
    if(params.sourceVideoUrl)body[String(proto.source_video_field || "videos")]=[params.sourceVideoUrl];
    const generateAudio = params.generateAudio ?? proto.generate_audio;
    if(generateAudio!==undefined)body.generate_audio=generateAudio;
    requestBody = JSON.stringify(body);
  }

  // One provider POST only: a lost acknowledgement is not a confirmed failure.
  try {
    const response = await fetch(submitUrl, {
      method: "POST", headers,
      body: requestBody, signal: AbortSignal.timeout(30_000),
    });
    let data: Record<string, unknown>;
    try { data = await response.json(); } catch {
      return response.ok || response.status >= 500
        ? videoSubmissionUnknown()
        : { taskId: "", status: "failed", error: `上游拒绝提交（HTTP ${response.status}）` };
    }
    // A schema rejection is returned to the caller. It is never "repaired" by
    // issuing a second paid POST because that would break exactly-once safety.
    if (response.status >= 500) { await response.body?.cancel().catch(() => undefined); return videoSubmissionUnknown(); }
    if (!response.ok) {
      const detail = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : {};
      return { taskId: "", status: "failed", error: String(data.message || detail.message || `上游拒绝提交（HTTP ${response.status}）`) };
    }
    const nested = data.data && typeof data.data === "object" ? data.data as Record<string, unknown> : {};
    const taskId = safeStr(data.id) || safeStr(data.task_id) || safeStr(nested.id);
    return taskId ? { taskId, status: "queued", progress: null } : videoSubmissionUnknown();
  } catch { return videoSubmissionUnknown(); }
}

/** New API (openclaw) 轮询视频任务 */
async function pollNewApiVideo(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/+$/, '').replace(/\/v1\/?$/, '');
  const apiKey = config.api_key || '';
  const pollUrl = `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch(pollUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      signal: controller.signal,
    });

    // 5xx 临时故障——不判死，保持 processing 让前端继续轮询
    if (resp.status >= 500) {
      return { taskId, status: 'processing', progress: null, videoUrl: '' };
    }

    if (resp.status === 429) {
      return { taskId, status: 'processing', progress: null, videoUrl: '', error: '状态查询限流（HTTP 429），正在自动重试' };
    }

    // 404 任务不存在或已过期
    if (resp.status === 404) {
      return { taskId, status: 'failed', progress: 0, videoUrl: '', error: '任务不存在或已过期' };
    }

    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;

    // 提取上游状态
    const rawStatus = safeStr((data as Record<string, unknown>).status).toLowerCase();

    // 错误信息提取（New API 双格式：顶层 error 对象 或 code/message）
    const errorObj = (data as Record<string, unknown>).error;
    let errorMessage = '';
    if (errorObj && typeof errorObj === 'object') {
      errorMessage = safeStr((errorObj as Record<string, unknown>).message)
        || safeStr((errorObj as Record<string, unknown>).code);
    } else {
      errorMessage = safeStr((data as Record<string, unknown>).message)
        || safeStr((data as Record<string, unknown>).code);
    }

    if ([400, 401, 403].includes(resp.status)) {
      return {
        taskId,
        status: 'failed',
        progress: 0,
        videoUrl: '',
        error: errorMessage || `上游拒绝状态查询（HTTP ${resp.status}）`,
      };
    }

    // 进度
    const progress = safeNum((data as Record<string, unknown>).progress, null);

    // 视频URL提取（优先顶层 video_url，兼容 url / output.video_url / metadata.video_url）
    let videoUrl = safeStr((data as Record<string, unknown>).video_url);
    if (!videoUrl) {
      videoUrl = safeStr((data as Record<string, unknown>).url);
    }
    if (!videoUrl) {
      const metadata = (data as Record<string, unknown>).metadata;
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        videoUrl = safeStr((metadata as Record<string, unknown>).video_url) || safeStr((metadata as Record<string, unknown>).url);
      }
    }
    if (!videoUrl) {
      const output = (data as Record<string, unknown>).output;
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        videoUrl = safeStr((output as Record<string, unknown>).video_url) || safeStr((output as Record<string, unknown>).url);
      }
    }

    // URL fragments are browser-only metadata and are never sent to the media
    // host. Some NewAPI relays append one to an otherwise valid signed result;
    // canonicalize it before the shared result-URL policy validates and stores
    // the address. Do not relax protocol/credential/port/hostname checks here.
    if (videoUrl) {
      try {
        const canonical = new URL(videoUrl);
        canonical.hash = '';
        videoUrl = canonical.toString();
      } catch {
        // The terminal result policy remains the authority for malformed URLs.
      }
    }

    // 状态映射——严格与上游同步
    if (['completed', 'succeeded', 'success'].includes(rawStatus)) {
      // 标记是否需要代理播放：/content 端点需要 API key 认证，浏览器无法直接播放
      const needsProxy = !!videoUrl && videoUrl.includes("/v1/videos/") && videoUrl.endsWith("/content");
      return {
        taskId,
        status: 'success',
        progress: progress ?? 100,
        videoUrl: videoUrl || '',
        needsProxy,
      };
    }

    if (['failed', 'error', 'failure', 'cancelled', 'canceled', 'terminated'].includes(rawStatus)) {
      return {
        taskId,
        status: 'failed',
        progress: progress ?? 0,
        videoUrl: '',
        error: errorMessage || `视频生成失败(${rawStatus})`,
      };
    }

    // queued / in_progress / processing 等 → 继续等待
    return {
      taskId,
      status: 'processing',
      progress,
      videoUrl: '',
    };

  } catch (err: unknown) {
    const message = (err as Error)?.name === 'AbortError'
      ? '状态查询超时，正在自动重试'
      : `状态查询暂时中断，正在自动重试: ${String((err as Error)?.message || 'network error').slice(0, 160)}`;
    return { taskId, status: 'processing', progress: null, videoUrl: '', error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/** 云雾平台连接预检（5秒快速检测上游可达性） */
async function checkYunwuHealth(apiEndpoint: string, apiKey: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const baseUrl = apiEndpoint.replace(/\/v1(?:\/.*)?$/, "");
  const start = Date.now();
  try {
    const resp = await fetch(`${baseUrl}/v1/video/query?id=health_check`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const ms = Date.now() - start;
    // 任何非5xx响应都算平台在线（4xx说明平台活着，只是参数问题）
    return { ok: resp.status < 500, ms };
  } catch {
    const ms = Date.now() - start;
    return { ok: false, ms, error: ms >= 4500 ? "连接超时" : "网络不可达" };
  }
}

// ═══════════════════════════════════════════════════════════════
// 云雾视频专属通道 — 加强保护版
// 原则：① 状态只跟上游 ② 数据防御性校验 ③ 异常不扩散 ④ 关键节点可追踪
// ═══════════════════════════════════════════════════════════════

/** 云雾通道专用日志前缀，便于grep定位 */
const YW_LOG = "[云雾通道]";

/** 重试退避间隔（毫秒），指数递增：2s → 4s → 8s（由 backoffMs 函数实现） */

/**
 * 将上游各种状态值归一化为系统标准状态
 * 覆盖主流平台（openclaw/gaorui/yunwu/siliconflow/zhipu 等）的所有已知状态值
 */
function normalizeVideoStatus(raw: string): "success" | "failed" | "queued" | "processing" {
  const s = raw.toLowerCase().trim();
  // 成功
  if (["completed", "success", "succeeded", "done", "finished"].includes(s)) return "success";
  // 失败
  if (["failed", "error", "failed_error", "terminated", "cancelled", "canceled", "expired", "timeout", "timed_out"].includes(s)) return "failed";
  // 排队中
  if (["queued", "pending", "waiting", "submitted", "created", "not_started"].includes(s)) return "queued";
  // 渲染中（默认）
  return "processing";
}

/** 安全提取字符串，null/undefined/object 一律降级为 fallback */
function safeStr(val: unknown, fallback = ""): string {
  if (val == null) return fallback;
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return fallback; // object/array 等非标量一律降级
}

/** 安全提取数字，null/undefined/NaN 一律降级为 fallback */
function safeNum(val: unknown, fallback: number | null): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** 安全解析 JSON 响应体，解析失败返回空对象而非抛异常 */
async function safeParseJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    const text = await resp.text();
    if (!text || text.trim().length === 0) return {};
    const parsed = JSON.parse(text);
    return (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : { _raw: parsed };
  } catch {
    return {};
  }
}

/** 从云雾API响应中提取字段（兼容双格式：嵌套data.xxx 和 根级xxx），带类型防御 */
function yunwuExtract(data: Record<string, unknown>, rootKey: string, nestedKey?: string): unknown {
  try {
    // 优先尝试嵌套格式 data.xxx（云雾API实际返回格式）
    if (nestedKey) {
      const nested = data.data;
      if (nested != null && typeof nested === "object" && !Array.isArray(nested)) {
        const val = (nested as Record<string, unknown>)[nestedKey];
        if (val != null) return val;
      }
    }
    // 回退到根级格式 xxx
    const rootVal = data[rootKey];
    if (rootVal != null) return rootVal;
    if (nestedKey) {
      const nestedVal = data[nestedKey];
      if (nestedVal != null) return nestedVal;
    }
  } catch {
    // 提取异常不外泄，返回undefined
  }
  return undefined;
}

async function generateYunwuVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/v1(?:\/.*)?$/, "");
  const submitUrl = `${baseUrl}/v1/video/create`;

  // ① 构建请求参数（防御性：每个字段都有兜底）
  const aspectRatio = params.aspectRatio || "16:9";
  const sizeFromResolution = params.resolution || "";
  const sizeFallback: Record<string, string> = {
    "16:9": "1280x720", "9:16": "720x1280", "1:1": "720x720",
    "4:3": "960x720", "3:4": "720x960",
    "3:2": "1080x720", "2:3": "720x1080",
  };
  const size = sizeFromResolution || sizeFallback[aspectRatio] || "1280x720";

  const body: Record<string, unknown> = {
    model: config.model_name || "grok-video-3",
    prompt: params.prompt || "",
    aspect_ratio: aspectRatio,
    size: size,
    duration: params.duration || config.duration_seconds || 10,
    images: [] as string[],
  };
  if (params.imageUrl) {
    body.images = [params.imageUrl];
    // 尾帧图：追加到 images 数组（云雾支持多图输入）
    if (params.lastFrameUrl) {
      body.images = [params.imageUrl, params.lastFrameUrl];
    }
  } else if (params.lastFrameUrl) {
    body.images = [params.lastFrameUrl];
  }
  // 参考图：单独字段（风格参考，与首帧/尾帧不同）
  if (params.referenceImageUrl) {
    body.reference_image = params.referenceImageUrl;
  }

  const headers = {
    "Authorization": `Bearer ${config.api_key}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  console.log(`${YW_LOG} 提交视频: model=${body.model}, prompt=${String(body.prompt).slice(0, 50)}, size=${size}, duration=${body.duration}`);

  const acknowledgement = await videoSubmitOnce(submitUrl, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!acknowledgement) return videoSubmissionUnknown();
  const { resp, data } = acknowledgement;
  const taskId = videoSubmissionTaskId(yunwuExtract(data, "id", "task_id"), data.id, data.task_id);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "云雾提交");
  const status = safeStr(yunwuExtract(data, "status"), "processing").toLowerCase();
  return { taskId, status: ["pending", "processing", "submitted"].includes(status) ? "queued" : "processing" };
}

/**
 * 查询补偿：当提交请求超时/网络异常时，尝试确认平台状态。
 * 场景：请求已到达上游并成功创建，但响应在返回途中丢失——此时如果直接判失败，
 * 就会出现"我失败，上游成功"的尴尬情况。
 */
async function yunwuQueryCompensate(
  pollUrl: string,
  apiKey: string,
  _body: Record<string, unknown>,
): Promise<VideoTaskResult | null> {
  try {
    const resp = await fetch(`${pollUrl}?id=health_check`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    // 平台在线但提交失败 → 真实失败
    // 502/503 → 平台确实不可用
    console.log(`${YW_LOG} 查询补偿: 平台${resp.status < 500 ? "在线" : "不可用"}(${resp.status})`);
    return null;
  } catch {
    console.warn(`${YW_LOG} 查询补偿: 网络不通`);
    return null;
  }
}

async function pollYunwuVideo(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/v1(?:\/.*)?$/, "");
  const pollUrl = `${baseUrl}/v1/video/query?id=${encodeURIComponent(taskId)}`;

  // 轮询请求（15秒超时）
  let resp: Response;
  try {
    resp = await fetch(pollUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${config.api_key}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // 网络不可达时返回"处理中"（而非失败），避免误判——下次轮询再检测
    const msg = err instanceof DOMException && err.name === "AbortError"
      ? "轮询超时"
      : "网络不可达";
    // 状态只跟上游：网络不通时不知道上游状态，必须继续等
    return { taskId, status: "processing", progress: null, error: msg };
  }

  // 502/503 不视为任务失败，可能是临时不可用——状态只跟上游
  if (resp.status === 502 || resp.status === 503) {
    return { taskId, status: "processing", progress: null };
  }

  // 429 限流：不判失败，等下次轮询
  if (resp.status === 429) {
    return { taskId, status: "processing", progress: null, error: "轮询限流" };
  }

  // 404：任务不存在——这是上游明确说的，可以判失败
  if (resp.status === 404) {
    return { taskId, status: "failed", error: "上游任务不存在（可能已过期或被清理）" };
  }

  // 其他非200
  if (!resp.ok) {
    const data = await safeParseJson(resp);
    const errMsg = safeStr(data.message || data.error, `云雾轮询 ${resp.status}`);
    throw new Error(errMsg);
  }

  // 安全解析响应
  const data = await safeParseJson(resp);
  const status = safeStr(yunwuExtract(data, "status"), "processing").toLowerCase();

  // 检查 task_failed 等编码错误（HTTP 200 但业务失败）
  const dataCode = safeStr(data.code, "");
  if (dataCode === "task_failed" || dataCode === "error") {
    const errMsg = safeStr(data.message, JSON.stringify(data).slice(0, 200));
    console.warn(`${YW_LOG} 轮询发现上游失败: taskId=${taskId}, ${errMsg}`);
    return { taskId, status: "failed", error: errMsg };
  }

  // 成功态：completed, video_generation_completed, video_upsampling_completed
  if (status === "completed" || status === "video_generation_completed" || status === "video_upsampling_completed") {
    let videoUrl = safeStr(yunwuExtract(data, "video_url"));
    // 部分平台返回顶层 url 字段（如 video_url 为空但 url 有值），补充提取
    if (!videoUrl) {
      videoUrl = safeStr(yunwuExtract(data, "url"));
    }
    if (!videoUrl) {
      // 上游说成功但没给URL——可能是延迟，不判失败，继续等
      console.warn(`${YW_LOG} 上游标记完成但无videoUrl, taskId=${taskId}`);
      return { taskId, status: "processing", progress: null };
    }
    console.log(`${YW_LOG} 视频生成成功: taskId=${taskId}`);
    return { taskId, status: "success", videoUrl };
  }

  // 失败态：failed, error, terminated, cancelled, video_generation_failed, video_upsampling_failed
  // 上游终止/取消也视为失败，需及时反馈用户
  if (status === "failed" || status === "error" || status === "terminated" || status === "cancelled" ||
      status === "video_generation_failed" || status === "video_upsampling_failed") {
    // 优先从 data.error 提取，兼容 JSON 对象格式的 error
    let errMsg = "视频生成失败";
    const errorField = data.error;
    if (typeof errorField === "string" && errorField) {
      errMsg = errorField;
    } else if (typeof errorField === "object" && errorField) {
      const errObj = errorField as Record<string, unknown>;
      errMsg = safeStr(errObj.message || errObj.code, JSON.stringify(errorField).slice(0, 200));
    } else if (data.message) {
      errMsg = safeStr(data.message, errMsg);
    }
    // 上游终止/取消时给出明确提示
    if (status === "terminated" || status === "cancelled") {
      errMsg = errMsg || "上游已终止任务";
      if (!errMsg.includes("终止")) errMsg = `上游已终止任务: ${errMsg}`;
    }
    console.warn(`${YW_LOG} 上游失败: taskId=${taskId}, status=${status}, ${errMsg}`);
    return { taskId, status: "failed", error: errMsg };
  }

  // 处理中：区分排队和渲染，读取上游进度
  const isQueued = ["pending", "image_downloading"].includes(status);


  // 读取上游返回的 progress（防御性校验）
  let progress: number | null = null;
  const rawProgress = yunwuExtract(data, "progress");
  progress = safeNum(rawProgress, -1) ?? -1;
  if (progress >= 0) {
    progress = Math.min(progress / 100, 1); // 归一化到 0~1，防超界
  } else {
    progress = null;
  }

  return {
    taskId,
    status: isQueued ? "queued" : "processing",
    progress,
  };
}

/** 自动检测协议类型（根据API地址和模型名） */
// Secure Skill relay: Grok video uses split endpoints.
// Submit: POST {root}/openai/v1/videos
// Poll:   GET  {base}/v1/videos/{id}
function secureSkillVideoSize(aspectRatio?: string, resolution?: string): string {
  if (resolution && /^\d+x\d+$/i.test(resolution)) return resolution;
  const ratio = aspectRatio || "16:9";
  const sizeMap: Record<string, string> = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "1024x1024",
    "4:3": "960x720",
    "3:4": "720x960",
  };
  return sizeMap[ratio] || "1280x720";
}

function secureSkillSeconds(config: VideoModelConfig, params: VideoGenerateParams): number {
  const raw = Number(params.duration || config.duration_seconds || 5);
  if (!Number.isFinite(raw) || raw <= 0) return 5;
  const configuredMinimum = Number(config.api_protocol_config?.min_submit_duration
    ?? config.api_protocol_config?.min_duration);
  const minimum = Number.isFinite(configuredMinimum) && configuredMinimum > 0
    ? Math.round(configuredMinimum)
    : 1;
  const configuredMaximum = Number(config.api_protocol_config?.max_duration);
  const optionMaximum = Array.isArray(config.api_protocol_config?.duration_options)
    ? Math.max(
        0,
        ...config.api_protocol_config.duration_options
          .map(Number)
          .filter(value => Number.isFinite(value) && value > 0),
      )
    : 0;
  const maximum = Number.isFinite(configuredMaximum) && configuredMaximum > 0
    ? Math.round(configuredMaximum)
    : optionMaximum > 0
      ? Math.round(optionMaximum)
      : 15;
  return Math.min(Math.max(Math.round(raw), minimum), Math.max(minimum, maximum));
}

function secureSkillStatus(status: string): VideoTaskResult["status"] {
  const normalized = status.trim().toLowerCase();
  if (["done", "completed", "succeed", "succeeded", "success"].includes(normalized)) return "success";
  if ([
    "failed", "error", "cancelled", "canceled", "terminated",
    "expired", "timeout", "timed_out", "rejected",
  ].includes(normalized)) return "failed";
  if (["queued", "pending"].includes(normalized)) return "queued";
  return "processing";
}

function secureSkillGet(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function extractVideoTaskProgress(data: Record<string, unknown>): number | null {
  const paths = [
    "progress", "progress_pct", "progress_percent",
    "data.progress", "data.progress_pct", "data.progress_percent",
    "data.task.progress", "task.progress", "output.progress",
    "result.progress", "content.progress", "metadata.progress",
  ];
  for (const path of paths) {
    const raw = secureSkillGet(data, path);
    const normalized = typeof raw === "string" ? raw.trim().replace(/%$/u, "") : raw;
    if (normalized === "" || normalized === null || normalized === undefined) continue;
    const value = Number(normalized);
    if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
  }
  return null;
}

function secureSkillVideoUrl(data: Record<string, unknown>): string {
  const candidates = [
    "content.video_url",
    "video.url",
    "video_url",
    "url",
    "data.video.url",
    "data.video_url",
    "data.url",
    "output.url",
    "output.0.url",
  ];
  for (const path of candidates) {
    const value = secureSkillGet(data, path);
    if (typeof value === "string" && value) return value;
  }
  return "";
}

async function generateSecureSkillGrokVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const modelName = config.model_name || config.id || config.name;
  const referenceImage = params.imageUrl || params.referenceImageUrl || "";
  const h3Images = uniquePublicUrls([
    params.imageUrl,
    params.referenceImageUrl,
    params.lastFrameUrl,
    ...(params.imageUrls || []),
  ], Math.max(1, Math.min(9, Number(config.api_protocol_config?.max_reference_images) || 9)));
  const h3Audios = uniquePublicUrls([
    params.audioUrl,
    ...(params.audioUrls || []),
  ], Math.max(0, Math.min(3, Number(config.api_protocol_config?.max_reference_audios) || 3)));
  const isPreview = /preview/i.test(modelName);
  if (isPreview && !referenceImage) {
    return {
      taskId: "",
      status: "failed",
      error: "grok-imagine-video-1.5-preview requires a reference image.",
    };
  }

  const requestedResolution = params.resolutionTier || "720p";
  const isMiniMaxH3 = /^minimax-h3$/i.test(modelName);
  const configuredH3MinimumImages = Number(config.api_protocol_config?.required_reference_images);
  const requiredH3Images = Number.isFinite(configuredH3MinimumImages)
    ? Math.max(0, Math.round(configuredH3MinimumImages))
    : 1;
  if (isMiniMaxH3 && h3Images.length < requiredH3Images) {
    return {
      taskId: "",
      status: "failed",
      error: `MiniMax H3 至少需要 ${requiredH3Images} 张可公开访问的 HTTPS 参考图。`,
    };
  }
  if (isMiniMaxH3 && params.sourceVideoUrl) {
    return {
      taskId: "",
      status: "failed",
      error: "MiniMax H3 不接收参考视频；请使用文生、参考图或参考音频模式。",
    };
  }
  if (isMiniMaxH3 && Array.from(params.prompt.trim()).length > 2000) {
    return {
      taskId: "",
      status: "failed",
      error: "MiniMax H3 的视频提示词不能超过 2000 个字符，请精简动作、运镜和声音指令后重试。",
    };
  }

  // Grok 1.5 / 1.5-preview 的文生和单图生均支持 1080p；只有多参考模式最高 720p。
  // 当前画布使用 image 单图字段，因此不能把合法的 1080p 错误降成 720p。
  const supports1080p = /^grok-imagine-video-1\.5(?:-preview)?$/i.test(modelName);
  const grokResolution = requestedResolution === "1080p" && !supports1080p
    ? "720p"
    : requestedResolution;
  // MiniMax H3 的实时契约只接受 720p / 2k / 4k；它没有 1080p 档。
  // UI 使用更易读的 2K，提交时必须转为上游要求的小写 2k。
  // 旧页面或历史卡片若仍携带 1080p，安全收敛到默认 2k，避免继续产生 400 提交失败。
  const normalizedH3Resolution = ["720p", "2k", "4k"].includes(requestedResolution.toLowerCase())
    ? requestedResolution.toLowerCase()
    : "2k";
  const body: Record<string, unknown> = isMiniMaxH3
    ? (() => {
        const configuredMinimum = Number(config.api_protocol_config?.min_submit_duration);
        const minimumDuration = Number.isFinite(configuredMinimum) && configuredMinimum > 0
          ? Math.max(1, Math.round(configuredMinimum))
          : 5;
        const h3Body: Record<string, unknown> = {
          model: "minimax-h3",
          prompt: params.prompt,
          duration: Math.max(minimumDuration, secureSkillSeconds(config, params)),
          resolution: normalizedH3Resolution,
          ratio: params.aspectRatio || "16:9",
        };
        if (config.api_protocol_config?.prompt_optimize === true) h3Body.prompt_optimize = true;
        if (h3Images.length > 0) h3Body.image_urls = h3Images;
        if (h3Audios.length > 0) h3Body.audio_urls = h3Audios;
        return h3Body;
      })()
    : {
        model: modelName,
        prompt: params.prompt,
        seconds: secureSkillSeconds(config, params),
        size: secureSkillVideoSize(params.aspectRatio, params.resolution),
        resolution: grokResolution,
      };

  if (referenceImage && !isMiniMaxH3) {
    // Secure Skill's current single-image Grok contract uses input_reference.
    // reference_images is the separate multi-reference mode and is capped at
    // 720p, while input_reference preserves the single-image 1080p path.
    body.input_reference = { image_url: referenceImage };
  }

  const idempotencyKey = secureSkillProviderRequestKey(params);
  const primarySubmitUrl = isMiniMaxH3
    ? buildOpenAIEndpoint(config.api_endpoint, "videos")
    : buildApiRootEndpoint(config.api_endpoint, "/openai/v1/videos");
  const acknowledgement = await videoSubmitOnce(primarySubmitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...secureSkillIdempotencyHeaders(idempotencyKey),
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  });
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(primarySubmitUrl, idempotencyKey));
  }
  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(primarySubmitUrl, idempotencyKey, acknowledgement);
  const taskId = secureSkillTaskIdFromBody(data)
    || secureSkillTaskIdFromLocation(resp.headers.get("Location"), primarySubmitUrl);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "Secure Skill video API", submissionReceipt);

  const status = secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "queued"));
  return {
    taskId,
    status,
    videoUrl: secureSkillVideoUrl(data) || undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function generateSecureSkillEnterpriseVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const modelName = config.model_name || config.id || config.name;
  const minimumDuration = Math.max(1, Math.round(Number(config.api_protocol_config?.min_submit_duration) || 5));
  const maximumDuration = Math.max(minimumDuration, Math.round(Number(config.api_protocol_config?.max_duration) || 15));
  const requestedDuration = Number(params.duration || config.duration_seconds || minimumDuration);
  const duration = Math.min(maximumDuration, Math.max(minimumDuration, Math.round(requestedDuration)));
  const images = uniquePublicUrls([
    params.imageUrl,
    params.referenceImageUrl,
    params.lastFrameUrl,
    ...(params.imageUrls || []),
  ], Math.max(0, Math.min(9, Number(config.api_protocol_config?.max_reference_images) || 9)));
  const audios = uniquePublicUrls([
    params.audioUrl,
    ...(params.audioUrls || []),
  ], Math.max(0, Math.min(3, Number(config.api_protocol_config?.max_reference_audios) || 3)));

  if (params.sourceVideoUrl) {
    return {
      taskId: "",
      status: "failed",
      error: "Secure Skill 企业视频分组不支持参考视频，请使用文生、参考图片或参考音频模式。",
    };
  }

  const isSeedance25 = modelName.toLowerCase() === "seedance-2.5";
  const body: Record<string, unknown> = isSeedance25
    ? {
        model: modelName,
        prompt: params.prompt,
        seconds: duration,
        resolution: "720p",
        aspect_ratio: params.aspectRatio || "16:9",
      }
    : {
        model: modelName,
        prompt: params.prompt,
        duration,
        aspect_ratio: params.aspectRatio || "16:9",
      };
  if (isSeedance25) {
    if (images.length > 0) body.images = images;
    if (audios.length > 0) body.audios = audios;
  } else {
    if (images.length > 0) {
      body.image_url = images[0];
      if (images.length > 1) body.extra_images = images.slice(1);
    }
    if (audios.length > 0) body.extra_audios = audios;
  }

  const providerRequestKey = secureSkillProviderRequestKey(params);
  const submitUrl = buildOpenAIEndpoint(config.api_endpoint, "videos");
  const acknowledgement = await videoSubmitOnce(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...secureSkillIdempotencyHeaders(providerRequestKey),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(submitUrl, providerRequestKey));
  }
  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(submitUrl, providerRequestKey, acknowledgement);
  const taskId = secureSkillTaskIdFromBody(data)
    || secureSkillTaskIdFromLocation(resp.headers.get("Location"), submitUrl, ["videos"]);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "Secure Skill enterprise video API", submissionReceipt);
  return {
    taskId,
    status: secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "queued")),
    videoUrl: secureSkillVideoUrl(data) || undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function generateSecureSkillSeedance(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const body = seedanceRelayBody(config, params);
  const providerRequestKey = secureSkillProviderRequestKey(params);
  const submitUrl = buildOpenAIEndpoint(config.api_endpoint, "videos");
  const acknowledgement = await videoSubmitOnce(submitUrl, {
    method: "POST", headers: {
      Authorization: "Bearer " + config.api_key,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...secureSkillIdempotencyHeaders(providerRequestKey),
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(submitUrl, providerRequestKey));
  }
  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(submitUrl, providerRequestKey, acknowledgement);
  const taskId = secureSkillTaskIdFromBody(data)
    || secureSkillTaskIdFromLocation(resp.headers.get("Location"), submitUrl, ["videos"]);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "Seedance relay", submissionReceipt);
  return { taskId, status: secureSkillStatus(String(data.status || "queued")), videoUrl: secureSkillVideoUrl(data) || undefined, progress: extractVideoTaskProgress(data) };
}

async function generateSecureSkillDoubaoSeedance(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): Promise<VideoTaskResult> {
  const body = doubaoSeedanceTaskBody(config, params);
  const providerRequestKey = secureSkillProviderRequestKey(params);
  const submitUrl = buildApiRootEndpoint(config.api_endpoint, "/api/v3/contents/generations/tasks");
  const acknowledgement = await videoSubmitOnce(
    submitUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.api_key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...secureSkillIdempotencyHeaders(providerRequestKey),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(submitUrl, providerRequestKey));
  }
  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(submitUrl, providerRequestKey, acknowledgement);
  const taskId = secureSkillTaskIdFromBody(data)
    || secureSkillTaskIdFromLocation(resp.headers.get("Location"), submitUrl, ["tasks"]);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "Seedance 渠道任务协议", submissionReceipt);
  return {
    taskId,
    status: secureSkillStatus(String(data.status || "queued")),
    videoUrl: secureSkillVideoUrl(data) || undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function pollSecureSkillDoubaoSeedance(
  config: VideoModelConfig,
  taskId: string,
): Promise<VideoTaskResult> {
  const resp = await fetch(
    buildApiRootEndpoint(
      config.api_endpoint,
      `/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`,
    ),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${config.api_key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const data = await resp.json().catch(async () => ({
    error: await resp.text().catch(() => ""),
  })) as Record<string, unknown>;
  if (!resp.ok) {
    if (resp.status >= 500 || resp.status === 429) {
      return {
        taskId,
        status: "processing",
        progress: null,
        error: `上游状态接口暂时异常（HTTP ${resp.status}），正在重试`,
      };
    }
    const message = typeof data.error === "string"
      ? data.error
      : (data.error as Record<string, unknown> | undefined)?.message
        || data.message
        || JSON.stringify(data).slice(0, 300);
    return { taskId, status: "failed", error: String(message).slice(0, 300) };
  }
  const status = secureSkillStatus(String(data.status || "processing"));
  const videoUrl = secureSkillVideoUrl(data);
  if (status === "success" && !videoUrl) return { taskId, status: "processing", progress: null };
  const error = typeof data.error === "string"
    ? data.error
    : (data.error as Record<string, unknown> | undefined)?.message;
  return {
    taskId,
    status,
    videoUrl: videoUrl || undefined,
    error: status === "failed" ? String(error || data.message || "Seedance 视频生成失败") : undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function pollSecureSkillGrokVideo(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const pollUrl = buildOpenAIEndpoint(config.api_endpoint, `videos/${encodeURIComponent(taskId)}`);
  const resp = await fetch(pollUrl, {
    method: "GET",
    headers: { "Authorization": `Bearer ${config.api_key}` },
    signal: AbortSignal.timeout(30_000),
  });

  const data = await resp.json().catch(async () => ({ error: await resp.text().catch(() => "") })) as Record<string, unknown>;
  if (!resp.ok) {
    if (resp.status >= 500 || resp.status === 429) {
      return {
        taskId,
        status: "processing",
        progress: null,
        error: `上游状态接口暂时异常（HTTP ${resp.status}），正在重试`,
      };
    }
    const message = typeof data.error === "string"
      ? data.error
      : (data.error as Record<string, unknown> | undefined)?.message || data.message || JSON.stringify(data).slice(0, 300);
    return { taskId, status: "failed", error: String(message).slice(0, 300) };
  }

  const status = secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "processing"));
  const videoUrl = secureSkillVideoUrl(data);
  const error = typeof data.error === "string"
    ? data.error
    : (data.error as Record<string, unknown> | undefined)?.message;

  if (status === "success" && !videoUrl) {
    return { taskId, status: "processing", progress: null };
  }

  return {
    taskId,
    status,
    videoUrl: videoUrl || undefined,
    error: status === "failed" ? String(error || data.message || "Video generation failed") : undefined,
    progress: extractVideoTaskProgress(data),
  };
}

function secureSkillFlowJobUrl(data: Record<string, unknown>): string {
  const candidates = [
    "video.url",
    "video_url",
    "url",
    "data.video.url",
    "data.video_url",
    "data.url",
    "output.0.url",
    "output.0.video_url",
    "output.url",
    "output.video_url",
    "result.url",
    "result.video_url",
  ];
  for (const path of candidates) {
    const value = secureSkillGet(data, path);
    if (typeof value === "string" && value) return value;
  }
  return "";
}

async function generateSecureSkillFlowJob(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const modelName = config.model_name || config.id || config.name;
  const isOmniEdit = /omni_video_edit/i.test(modelName);
  const isOmni = /^omni$/i.test(modelName);
  const isVeo = /^veo_3_1_/i.test(modelName);
  const isVeoText = /^veo_3_1_t2v_/i.test(modelName);
  const isVeoInterpolation = /^veo_3_1_interpolation_/i.test(modelName);
  const isVeoImage = /^veo_3_1_i2v_/i.test(modelName);
  const isVeoReference = /^veo_3_1_r2v_/i.test(modelName);
  if (isOmniEdit && !/^https:\/\//i.test(params.sourceVideoUrl || "")) {
    return {
      taskId: "",
      status: "failed",
      error: "omni_video_edit 必须提供一条可公开访问的 HTTPS 源视频 URL，输出时长由源视频决定。",
    };
  }
  if (!isOmniEdit && params.sourceVideoUrl) {
    return {
      taskId: "",
      status: "failed",
      error: "当前 Flow 模型不接收源视频；如需编辑视频，请选择 Omni Video Edit。",
    };
  }

  let referenceImages = uniquePublicUrls([
    params.imageUrl,
    params.referenceImageUrl,
    params.lastFrameUrl,
    ...(params.imageUrls || []),
  ], Math.max(1, Math.min(5, Number(config.api_protocol_config?.max_reference_images) || 5)));
  if (isVeoInterpolation) {
    // First and last frames are positional inputs. The same image in both slots
    // is valid (for a loop), and unrelated references cannot fill a missing slot.
    referenceImages = [
      ...uniquePublicUrls([params.imageUrl], 1),
      ...uniquePublicUrls([params.lastFrameUrl], 1),
    ];
  }
  if (isVeoText) referenceImages = [];
  const minimumImages = isVeoInterpolation ? 2 : (isVeoImage || isVeoReference ? 1 : 0);
  if (referenceImages.length < minimumImages) {
    return {
      taskId: "",
      status: "failed",
      error: isVeoInterpolation
        ? "当前 VEO 首尾帧模型需要首帧和尾帧两张图片。"
        : "当前 VEO 图生/参考图模型至少需要一张参考图。",
    };
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text: params.prompt }];
  referenceImages.forEach((url) => {
    content.push({ type: "image_url", image_url: { url } });
  });

  const body: Record<string, unknown> = {
    model: modelName,
    messages: [{ role: "user", content: referenceImages.length > 0 ? content : params.prompt }],
    stream: false,
  };

  if (params.sourceVideoUrl) {
    body.video_url = params.sourceVideoUrl;
  } else if (isOmni || isVeo) {
    body.generationConfig = {
      videoConfig: {
        aspectRatio: params.aspectRatio || "16:9",
        // VEO has a fixed duration; the channel still requires its selected ratio.
        ...(isOmni ? { duration: params.duration || config.duration_seconds || 8 } : {}),
      },
    };
  }
  if (isVeo) body.resolution = "720p";

  const providerRequestKey = secureSkillProviderRequestKey(params);
  const submitUrl = buildOpenAIEndpoint(config.api_endpoint, "jobs");
  const acknowledgement = await videoSubmitOnce(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...secureSkillIdempotencyHeaders(providerRequestKey),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(submitUrl, providerRequestKey));
  }
  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(submitUrl, providerRequestKey, acknowledgement);
  const taskId = secureSkillTaskIdFromBody(data)
    || secureSkillTaskIdFromLocation(resp.headers.get("Location"), submitUrl, ["jobs"]);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "Secure Skill Flow Jobs API", submissionReceipt);
  const status = secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "queued"));
  return {
    taskId,
    status,
    videoUrl: secureSkillFlowJobUrl(data) || undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function pollSecureSkillFlowJob(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const resp = await fetch(buildOpenAIEndpoint(config.api_endpoint, `jobs/${encodeURIComponent(taskId)}`), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await resp.json().catch(async () => ({ error: await resp.text().catch(() => "") })) as Record<string, unknown>;
  if (!resp.ok) {
    if (resp.status >= 500 || resp.status === 429) {
      return {
        taskId,
        status: "processing",
        progress: null,
        error: `Secure Skill Flow Jobs 状态接口暂时异常（HTTP ${resp.status}），正在重试`,
      };
    }
    const message = typeof data.error === "string"
      ? data.error
      : (data.error as Record<string, unknown> | undefined)?.message || data.message || JSON.stringify(data).slice(0, 300);
    return { taskId, status: "failed", error: String(message).slice(0, 300) };
  }

  const status = secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "processing"));
  const videoUrl = secureSkillFlowJobUrl(data);
  const error = typeof data.error === "string"
    ? data.error
    : (data.error as Record<string, unknown> | undefined)?.message || data.message;
  if (status === "success" && !videoUrl) {
    return { taskId, status: "processing", progress: extractVideoTaskProgress(data) };
  }
  return {
    taskId,
    status,
    videoUrl: videoUrl || undefined,
    error: status === "failed" ? String(error || "Video job failed") : undefined,
    progress: extractVideoTaskProgress(data),
  };
}

function secureSkillWan3Resolution(value?: string): "480P" | "720P" | "1080P" {
  const normalized = String(value || "720P").trim().toUpperCase();
  if (normalized.includes("1080")) return "1080P";
  if (normalized.includes("480")) return "480P";
  return "720P";
}

async function generateSecureSkillWan3Video(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const modelName = config.model_name || config.id || config.name;
  const imageUrls = uniquePublicUrls([
    params.imageUrl,
    params.referenceImageUrl,
    params.lastFrameUrl,
    ...(params.imageUrls || []),
  ], Math.max(1, Math.min(10, Number(config.api_protocol_config?.max_reference_images) || 10)));
  const audioUrls = uniquePublicUrls([
    params.audioUrl,
    ...(params.audioUrls || []),
  ], Math.max(0, Math.min(5, Number(config.api_protocol_config?.max_reference_audios) || 5)));
  const media: Array<Record<string, string>> = [];
  imageUrls.forEach((url, index) => media.push({ type: index === 0 ? "first_frame" : "reference_image", url }));
  if (params.sourceVideoUrl && /^https:\/\//iu.test(params.sourceVideoUrl)) {
    media.push({ type: "reference_video", url: params.sourceVideoUrl });
  }
  audioUrls.forEach((url) => media.push({ type: "audio", url }));

  const body: Record<string, unknown> = {
    model: modelName,
    prompt: params.prompt,
    resolution: secureSkillWan3Resolution(params.resolutionTier || params.resolution),
    ratio: params.aspectRatio || "16:9",
    duration: Math.max(2, Math.min(30, Math.round(Number(params.duration) || config.duration_seconds || 5))),
    prompt_extend: false,
  };
  if (media.length > 0) body.media = media;

  const providerRequestKey = secureSkillProviderRequestKey(params);
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.api_key}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...secureSkillIdempotencyHeaders(providerRequestKey, true),
  };
  const submitUrl = buildOpenAIEndpoint(config.api_endpoint, "videos/generations");
  const acknowledgement = await videoSubmitOnce(submitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(submitUrl, providerRequestKey));
  }
  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(submitUrl, providerRequestKey, acknowledgement);
  const taskId = secureSkillTaskIdFromBody(data)
    || secureSkillTaskIdFromLocation(resp.headers.get("Location"), submitUrl, ["tasks", "videos"]);
  if (!taskId) return videoSubmissionWithoutTask(resp, data, "Secure Skill Wan3 API", submissionReceipt);
  return {
    taskId,
    status: secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "queued")),
    videoUrl: secureSkillVideoUrl(data) || undefined,
    progress: extractVideoTaskProgress(data),
  };
}

async function pollSecureSkillWan3Video(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const resp = await fetch(buildOpenAIEndpoint(config.api_endpoint, `videos/tasks/${encodeURIComponent(taskId)}`), {
    method: "GET",
    headers: { "Authorization": `Bearer ${config.api_key}`, "Accept": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await resp.json().catch(async () => ({ error: await resp.text().catch(() => "") })) as Record<string, unknown>;
  if (!resp.ok) {
    if (resp.status >= 500 || resp.status === 429) {
      return { taskId, status: "processing", progress: null, error: `Wan3 状态接口暂时异常（HTTP ${resp.status}），正在重试` };
    }
    const message = typeof data.error === "string"
      ? data.error
      : (data.error as Record<string, unknown> | undefined)?.message || data.message || JSON.stringify(data).slice(0, 300);
    return { taskId, status: "failed", error: String(message).slice(0, 300) };
  }
  const status = secureSkillStatus(String(data.status || secureSkillGet(data, "data.status") || "processing"));
  const videoUrl = secureSkillVideoUrl(data)
    || String(data.download_url || secureSkillGet(data, "data.download_url") || "");
  const error = typeof data.error === "string"
    ? data.error
    : (data.error as Record<string, unknown> | undefined)?.message || data.message;
  if (status === "success" && !videoUrl) return { taskId, status: "processing", progress: null };
  return {
    taskId,
    status,
    videoUrl: videoUrl || undefined,
    error: status === "failed" ? String(error || "Wan3 video generation failed") : undefined,
    progress: extractVideoTaskProgress(data),
  };
}

export function autoDetectProtocol(apiEndpoint: string, modelName?: string): string {
  const url = apiEndpoint.toLowerCase();
  const model = (modelName || "").toLowerCase();

  if (url.includes("autodl.art") && (url.includes("comfyui") || model.includes("minimax_h3") || model.includes("minimax-h3"))) {
    return AUTODL_COMFYUI_WORKFLOW_PROTOCOL;
  }
  if (url.includes("pro.nat6.net")) return "suanlicheng_video";
  try { if (new URL(apiEndpoint).hostname === "token.secure-skill.com" && isDoubaoSeedanceModel(model)) return "secure_skill_doubao_seedance"; } catch {}
  try { if (new URL(apiEndpoint).hostname === "token.secure-skill.com" && model === "seedance-2.5") return "secure_skill_seedance_video"; } catch {}

  if ((url.includes("token.secure-skill.com") || url.includes("secure-skill")) && /^(omni|omni_video_edit|veo_3_1)/i.test(model)) {
    return "secure_skill_flow_jobs";
  }
  if ((url.includes("token.secure-skill.com") || url.includes("secure-skill")) && model.includes("grok-imagine-video")) {
    return "secure_skill_grok_video";
  }
  if ((url.includes("token.secure-skill.com") || url.includes("secure-skill")) && /^wan3(?:\.0)?(?:-video)?/i.test(model)) {
    return "secure_skill_wan3_video";
  }
  if (url.includes("token.secure-skill.com") || url.includes("secure-skill")) {
    return "secure_skill_video";
  }

  // 可灵官方协议（/kling/v1/videos/text2video）
  if (url.includes("/kling/")) return "kling_official";

  // 蓝猫平台专属通道（aijisu.cn / jinjieus.com / 蓝猫IP直连）
  if (url.includes("aijisu") || url.includes("jinjieus") || url.includes("113.31.180.249")) return "lanmao_video";

  // 代理平台特征（云雾AI、向量引擎等）
  if (url.includes("yunwu") || url.includes("vectorengine")) {
    // 根据模型名判断具体协议
    if (model.includes("kling")) return "kling_official";
    if (model.includes("grok-video") || model.includes("grok_video")) return "yunwu_video";
    if (model.includes("grok")) return "grok_video";
    if (model.includes("veo")) return "unified_video";
    return "unified_video";
  }

  // OpenClaw / NewAPI 中转站（POST /v1/videos 格式）
  if (url.includes("openclaw") || url.includes("newapi")) return "newapi_video";

  // 高瑞视频专属通道（gaorui.cc）
  if (url.includes("gaorui")) return "gaorui_video";

  // 硅基流动
  if (url.includes("siliconflow") && url.includes("kling")) return "siliconflow_kling";
  if (url.includes("siliconflow") && url.includes("vidu")) return "siliconflow_vidu";

  // Runway
  if (url.includes("runway") || url.includes("runwayml")) return "runway";

  // Replicate
  if (url.includes("replicate")) return "replicate";

  // 默认 OpenAI 兼容
  return "openai_compatible";
}

// ─── 通用 OpenAPI 视频协议适配器（数据驱动，配置即生效） ───────────

/** 从嵌套对象中按点分隔路径提取值，如 "metadata.video_url" */
function extractByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path || !obj) return undefined;
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 根据 api_protocol_config 构建提交请求 */
async function generateOpenApiVideo(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const proto = config.api_protocol_config || {};
  const durationField = proto.duration_field || "duration";
  const imageField = proto.image_field || "image";
  const sizeField = proto.size_field || "size";

  // 构建提交URL
  // submit_path 是完整路径（如 /v1/videos），需要智能拼接：
  // - 如果 api_endpoint 已包含 submit_path → 直接用
  // - 如果 api_endpoint 的路径是 submit_path 的前缀（如 /v1 是 /v1/videos 的前缀）→ 追加剩余部分
  // - 否则 → 完整拼接
  const submitPath = proto.submit_path || "/v1/videos";
  let submitUrl: string;
  {
    const base = config.api_endpoint.replace(/\/+$/, "");
    if (base.endsWith(submitPath)) {
      submitUrl = base;
    } else if (submitPath.startsWith("/") && base.length > 0) {
      // 检查 base 的路径是否是 submitPath 的前缀
      try {
        const baseUrl = new URL(base);
        const basePath = baseUrl.pathname.replace(/\/+$/, "");
        const subPath = submitPath.replace(/\/+$/, "");
        if (subPath.startsWith(basePath) && basePath.length > 0 && subPath.length > basePath.length) {
          // base 是前缀，追加剩余部分
          const remaining = subPath.slice(basePath.length);
          submitUrl = `${baseUrl.origin}${basePath}${remaining}`;
        } else {
          // 完整拼接
          submitUrl = base + (submitPath.startsWith("/") ? submitPath : "/" + submitPath);
        }
      } catch {
        submitUrl = base + (submitPath.startsWith("/") ? submitPath : "/" + submitPath);
      }
    } else {
      submitUrl = base + (submitPath.startsWith("/") ? submitPath : "/" + submitPath);
    }
  }

  // 解析分辨率
  const sizeMap: Record<string, string> = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "720x720",
    "4:3": "960x720",
    "3:4": "720x960",
  };
  const aspectRatio = params.aspectRatio || "16:9";
  const size = params.resolution || sizeMap[aspectRatio] || "1280x720";

  // 构建请求体
  const body: Record<string, unknown> = {
    model: config.model_name,
    prompt: params.prompt,
    [sizeField]: size,
    [durationField]: params.duration || config.duration_seconds || 10,
  };

  // 参考图（仅当模型支持且有图时添加）
  if (params.imageUrl && config.supports_image_input) {
    if (proto.image_field_type === "array") {
      body[imageField] = [params.imageUrl];
    } else {
      body[imageField] = params.imageUrl;
    }
  } else if (proto.image_field_type === "array") {
    // 数组类型且无图片时，发送空数组（部分平台要求）
    body[imageField] = [];
  }
  // 尾帧图
  if (params.lastFrameUrl && config.supports_image_input) {
    if (proto.image_field_type === "array" && body[imageField]) {
      // 数组模式：追加到已有数组
      (body[imageField] as string[]).push(params.lastFrameUrl);
    } else {
      body["last_frame_image"] = params.lastFrameUrl;
    }
  }
  // 参考风格图
  if (params.referenceImageUrl) {
    body["reference_image"] = params.referenceImageUrl;
  }

  // 宽高比字段（部分平台需要单独传 aspect_ratio）
  if (proto.aspect_ratio_field) {
    body[proto.aspect_ratio_field] = params.aspectRatio || "16:9";
  }

  const resp = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000), // 3分钟超时
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json() as Record<string, unknown>;

  // 检查上游错误（HTTP 200也可能包含错误）
  const errMsg = (data.error as Record<string, unknown>)?.message
    || (data.error as Record<string, unknown>)?.msg
    || (typeof data.error === "string" ? data.error : "");
  if (errMsg) {
    return { taskId: "", status: "failed", error: `上游错误: ${String(errMsg).slice(0, 200)}` };
  }

  // 提取任务ID
  const taskIdPath = proto.task_id_path || "id";
  const taskId = String(extractByPath(data, taskIdPath) || "");

  // 提取状态并映射：先查 status_mapping 配置，再归一化
  const statusPath = proto.status_path || "status";
  const rawStatus = String(extractByPath(data, statusPath) || "processing");
  const statusMapping = proto.status_mapping || {};
  const mappedStatus = statusMapping[rawStatus] || rawStatus;
  const normalizedStatus = normalizeVideoStatus(mappedStatus);

  // 提取进度：优先用配置路径，未配置时尝试顶层 progress 字段
  let genProgress: number | null = null;
  if (proto.progress_path) {
    genProgress = Number(extractByPath(data, proto.progress_path)) || null;
  } else if (typeof data.progress === "number" && data.progress > 0) {
    genProgress = data.progress;
  }

  return {
    taskId,
    status: normalizedStatus,
    videoUrl: normalizedStatus === "success" ? String(extractByPath(data, proto.video_url_path || "video_url") || "") : undefined,
    progress: genProgress,
  };
}

/** 根据 api_protocol_config 轮询任务状态 */
async function pollOpenApiVideo(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const proto = config.api_protocol_config || {};
  const pollStyle = proto.poll_style || "path";

  // 构建轮询URL
  let pollUrl: string;
  if (pollStyle === "query") {
    // 查询参数风格：GET {origin}{poll_path}?{param}={taskId}
    const paramName = proto.poll_param_name || "id";
    const pollPath = proto.poll_path || "/v1/video/query";
    const base = config.api_endpoint.replace(/\/+$/, "");
    let origin: string;
    try {
      origin = new URL(base).origin;
    } catch {
      origin = base;
    }
    pollUrl = `${origin}${pollPath.startsWith("/") ? pollPath : "/" + pollPath}?${paramName}=${encodeURIComponent(taskId)}`;
  } else {
    // 路径参数风格：GET {origin}{poll_path}/{taskId}（原有逻辑）
    const pollPath = proto.poll_path || "/v1/videos/{id}";
    const pollPathWithId = pollPath.replace("{id}", taskId);
    const base = config.api_endpoint.replace(/\/+$/, "");
    try {
      const baseUrl = new URL(base);
      const basePath = baseUrl.pathname.replace(/\/+$/, "");
      const fullPath = pollPathWithId.replace(/\/+$/, "");
      let effectivePath: string;
      if (fullPath.startsWith(basePath) && basePath.length > 0) {
        effectivePath = fullPath; // fullPath 已包含 basePath 前缀
      } else {
        effectivePath = basePath + (fullPath.startsWith("/") ? fullPath : "/" + fullPath);
      }
      pollUrl = `${baseUrl.origin}${effectivePath}`;
    } catch {
      pollUrl = base + (pollPathWithId.startsWith("/") ? pollPathWithId : "/" + pollPathWithId);
    }
  }

  const resp = await fetch(pollUrl, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    // 5xx 服务端临时故障 → 返回 processing 让前端继续轮询，不判死
    if (resp.status >= 500) {
      return { taskId, status: "processing", progress: null };
    }
    throw new Error(`轮询 API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json() as Record<string, unknown>;

  // 提取状态
  const statusPath = proto.status_path || "status";
  const rawStatus = String(extractByPath(data, statusPath) || "processing");
  const statusMapping = proto.status_mapping || {};
  const mappedStatus = statusMapping[rawStatus] || rawStatus;
  const normalizedStatus = normalizeVideoStatus(mappedStatus);

  // 提取视频URL
  const videoUrlPath = proto.video_url_path || "video_url";
  const videoUrl = normalizedStatus === "success" ? String(extractByPath(data, videoUrlPath) || "") : undefined;

  // 提取进度：优先用配置路径，未配置时尝试顶层 progress 字段
  const progressPath = proto.progress_path;
  let progress: number | null = null;
  if (progressPath) {
    progress = Number(extractByPath(data, progressPath)) || null;
  } else if (typeof data.progress === "number" && data.progress > 0) {
    progress = data.progress;
  }

  return {
    taskId,
    status: normalizedStatus,
    videoUrl,
    progress,
    terminalState: isProviderCancellationStatus(rawStatus) || isProviderCancellationStatus(mappedStatus)
      ? "cancelled"
      : undefined,
  };
}

// ─── AutoDL 托管 ComfyUI · MiniMax H3 ─────────────────────────────

const AUTODL_H3_WORKFLOW_ID = "minimax_h3_image_audio_to_video_v2";

function autoDLApiBase(endpoint: string): string {
  const fallback = "https://www.autodl.art/api/v1";
  const input = String(endpoint || fallback).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(input);
    const marker = "/api/v1";
    const markerIndex = parsed.pathname.indexOf(marker);
    const path = markerIndex >= 0 ? parsed.pathname.slice(0, markerIndex + marker.length) : marker;
    return `${parsed.origin}${path}`.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function autoDLWorkflowId(config: VideoModelConfig): string {
  return String(config.api_protocol_config?.workflow_id || config.model_name || AUTODL_H3_WORKFLOW_ID).trim();
}

function autoDLResolution(params: VideoGenerateParams): string {
  const rawTier = String(params.resolutionTier || params.resolution || "768p").toLowerCase();
  const tier = rawTier.includes("1080") ? "1080p" : rawTier.includes("480") ? "480p" : "768p";
  const orientation = params.aspectRatio === "9:16" || params.aspectRatio === "3:4" ? "竖" : "横";
  return `${tier}${orientation}`;
}

function uniquePublicUrls(values: Array<string | undefined>, limit: number): string[] {
  return [...new Set(values
    .map((value) => String(value || "").trim())
    .filter((value) => /^https?:\/\//iu.test(value)))]
    .slice(0, limit);
}

function autoDLError(data: Record<string, unknown>, fallback: string): string {
  const error = data.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  const message = data.message ?? data.msg;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/**
 * AutoDL H3 的 Authorization 头必须直接放 ComfyUI 分组 Token，不能添加 Bearer。
 * 提交仅发生在用户明确点击生成时；后台“测试”使用独立的只读探针。
 */
async function generateAutoDLComfyH3(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  if (params.sourceVideoUrl) {
    return {
      taskId: "",
      status: "failed",
      error: "AutoDL H3 多图多音频工作流不接收源视频；请改用参考图/参考音频，或选择真正的视频编辑模型。",
    };
  }

  const workflowId = autoDLWorkflowId(config);
  const submitUrl = `${autoDLApiBase(config.api_endpoint)}/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`;
  const maxImages = Math.max(1, Math.min(9, Number(config.api_protocol_config?.max_reference_images) || 9));
  const maxAudios = Math.max(0, Math.min(3, Number(config.api_protocol_config?.max_reference_audios) || 3));
  const imageUrls = uniquePublicUrls([
    params.imageUrl,
    params.lastFrameUrl,
    params.referenceImageUrl,
    ...(params.imageUrls || []),
  ], maxImages);
  const audioUrls = uniquePublicUrls([
    ...(params.audioUrls || []),
    params.audioUrl,
  ], maxAudios);

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    duration: Math.max(1, Math.min(10, Math.round(Number(params.duration) || config.duration_seconds || 5))),
    resolution: autoDLResolution(params),
  };
  imageUrls.forEach((url, index) => { body[`ref_image_${index}`] = url; });
  audioUrls.forEach((url, index) => { body[`ref_audio_${index}`] = url; });

  const providerRequestKey = secureSkillProviderRequestKey(params);
  const acknowledgement = await videoSubmitOnce(submitUrl, {
    method: "POST",
    headers: {
      Authorization: config.api_key,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...secureSkillIdempotencyHeaders(providerRequestKey),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!acknowledgement) {
    return videoSubmissionUnknown(secureSkillSubmissionReceipt(submitUrl, providerRequestKey));
  }
  const { resp, data } = acknowledgement;
  const submissionReceipt = secureSkillSubmissionReceipt(submitUrl, providerRequestKey, acknowledgement);
  if (resp.status >= 500) return videoSubmissionUnknown(submissionReceipt);
  if (!resp.ok || (data.code && String(data.code).toLowerCase() !== "success")) {
    return videoSubmissionWithoutTask(resp, data, "AutoDL H3 提交", submissionReceipt);
  }

  const taskData = data.data && typeof data.data === "object"
    ? data.data as Record<string, unknown>
    : data;
  const taskId = videoSubmissionTaskId(taskData.task_id, taskData.id);
  if (!taskId) {
    return videoSubmissionUnknown(submissionReceipt);
  }
  return {
    taskId,
    status: normalizeVideoStatus(String(taskData.status || "QUEUED")),
    submissionReceipt,
  };
}

async function pollAutoDLComfyH3(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const pollUrl = `${autoDLApiBase(config.api_endpoint)}/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`;
  const resp = await fetch(pollUrl, {
    method: "GET",
    headers: { Authorization: config.api_key, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await safeParseJson(resp);
  if (resp.status >= 500) return { taskId, status: "processing", progress: null };
  if (!resp.ok || (data.code && String(data.code).toLowerCase() !== "success")) {
    return {
      taskId,
      status: "failed",
      error: `AutoDL H3 查询失败 (${resp.status}): ${autoDLError(data, "接口未返回可识别错误")}`,
    };
  }

  const taskData = data.data && typeof data.data === "object"
    ? data.data as Record<string, unknown>
    : data;
  const status = normalizeVideoStatus(String(taskData.status || "RUNNING"));
  const results = Array.isArray(taskData.results) ? taskData.results : [];
  const videoResult = results.find((item) => item && typeof item === "object" && (
    String((item as Record<string, unknown>).type || "").toLowerCase() === "video"
    || typeof (item as Record<string, unknown>).url === "string"
  )) as Record<string, unknown> | undefined;
  const videoUrl = typeof videoResult?.url === "string" ? videoResult.url : "";
  const errorMessage = autoDLError(taskData, status === "failed" ? "AutoDL H3 任务生成失败" : "");

  return {
    taskId,
    status,
    videoUrl: status === "success" ? videoUrl || undefined : undefined,
    error: status === "failed" ? errorMessage : undefined,
    progress: typeof taskData.progress === "number" ? taskData.progress : null,
  };
}

// ─── 统一入口 ──────────────────────────────────────

// DashScope Wan digital-human video (wan2.2-s2v).
function dashscopeTaskUrl(apiEndpoint: string, taskId: string) {
  const endpoint = new URL(apiEndpoint);
  return `${endpoint.origin}/api/v1/tasks/${encodeURIComponent(taskId)}`;
}

function dashscopeError(data: Record<string, unknown>, fallback: string) {
  const output = data.output && typeof data.output === "object" && !Array.isArray(data.output)
    ? data.output as Record<string, unknown>
    : {};
  const message = safeStr(data.message)
    || safeStr(output.message)
    || '';
  const code = safeStr(data.code) || safeStr(output.code);
  return code && message ? `${code}: ${message}` : code || message || fallback;
}

async function generateDashscopeWanS2v(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): Promise<VideoTaskResult> {
  const imageUrl = params.imageUrl || params.referenceImageUrl || params.imageUrls?.find(Boolean);
  if (!imageUrl) {
    return { taskId: "", status: "failed", error: "数字人视频必须提供人物图片" };
  }
  // The current API accepts both the single audio_url field and the historical
  // reference_audio_urls array. Always preserve the first usable audio input.
  const audioUrl = params.audioUrl || params.audioUrls?.find(Boolean);
  if (!audioUrl) {
    return { taskId: "", status: "failed", error: "数字人视频必须提供 4-15 秒人声音频" };
  }

  const detectorResponse = await fetch(new URL('/api/v1/services/aigc/image2video/face-detect', config.api_endpoint), {
    method: 'POST', headers: { Authorization: 'Bearer ' + config.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'wan2.2-s2v-detect', input: { image_url: imageUrl } }), signal: AbortSignal.timeout(30_000),
  });
  const detector = await safeParseJson(detectorResponse);
  const detectedOutput = detector.output as Record<string, unknown> | undefined;
  if (!detectorResponse.ok || detectedOutput?.check_pass !== true) {
    return { taskId: '', status: 'failed', error: '人物照片检测未通过：' + dashscopeError(detector, '请上传清晰的正面人物照片') };
  }

  const resolution = String(params.resolutionTier || params.resolution || "480p").toLowerCase() === "720p"
    ? "720P"
    : "480P";
  let resp: Response;
  try {
    resp = await fetch(config.api_endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.api_key}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: config.model_name || "wan2.2-s2v",
        input: {
          image_url: imageUrl,
          audio_url: audioUrl,
        },
        parameters: {
          style: "speech",
          resolution,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // A transport error after POST dispatch cannot prove that no paid task exists.
    return videoSubmissionUnknown();
  }
  const data = await safeParseJson(resp);
  if (resp.status >= 500) return videoSubmissionUnknown();
  if (!resp.ok) {
    return {
      taskId: "",
      status: "failed",
      error: `DashScope 提交失败 (${resp.status}): ${dashscopeError(data, "上游未返回错误信息").slice(0, 200)}`,
    };
  }
  const output = data.output && typeof data.output === "object" && !Array.isArray(data.output)
    ? data.output as Record<string, unknown>
    : {};
  const taskId = safeStr(output.task_id) || safeStr(data.task_id);
  if (!taskId) return videoSubmissionUnknown();
  return { taskId, status: "queued", progress: 0 };
}

async function pollDashscopeWanS2v(
  config: VideoModelConfig,
  taskId: string,
): Promise<VideoTaskResult> {
  const resp = await fetch(dashscopeTaskUrl(config.api_endpoint, taskId), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.api_key}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await safeParseJson(resp);
  if (resp.status >= 500) {
    return { taskId, status: "processing", progress: null };
  }
  if (!resp.ok) {
    return {
      taskId,
      status: "processing",
      error: `DashScope 查询暂时中断 (${resp.status}): ${dashscopeError(data, "上游未返回错误信息").slice(0, 200)}`,
    };
  }

  const output = data.output && typeof data.output === "object" && !Array.isArray(data.output)
    ? data.output as Record<string, unknown>
    : {};
  const status = safeStr(output.task_status, safeStr(data.task_status)).toUpperCase();
  if (status === "SUCCEEDED") {
    const results = output.results && typeof output.results === "object" && !Array.isArray(output.results)
      ? output.results as Record<string, unknown>
      : {};
    const videoUrl = safeStr(results.video_url) || safeStr(output.video_url);
    if (!videoUrl) {
      return { taskId, status: "failed", error: "DashScope 任务成功但未返回视频 URL" };
    }
    return { taskId, status: "success", videoUrl, progress: 100 };
  }
  if (status === "CANCELED" || status === "CANCELLED") {
    return {
      taskId,
      status: "failed",
      terminalState: "cancelled",
      error: dashscopeError(data, "DashScope 已终止视频生成任务"),
    };
  }
  if (status === "FAILED") {
    return { taskId, status: "failed", error: dashscopeError(data, "DashScope 数字人视频生成失败") };
  }
  return {
    taskId,
    status: status === "PENDING" ? "queued" : "processing",
    progress: null,
  };
}

/** 提交视频生成任务 */
export async function submitVideoTask(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  return withVideoProviderRequestAudit(params.onProviderRequest, () => submitVideoTaskWithProtocol(config, params));
}

async function submitVideoTaskWithProtocol(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  assertVideoParameterContract(config, params);
  let normalizedParams = params;

  // 全协议统一兜底：
  // 当用户只上传“参考图”而没有上传“首帧”时，如果该模型支持图片输入，
  // 则把参考图提升为真正的图片输入，避免部分协议忽略 referenceImageUrl 导致上游实际拿不到图。
  if (!normalizedParams.imageUrl && normalizedParams.referenceImageUrl && config.supports_image_input) {
    normalizedParams = {
      ...normalizedParams,
      imageUrl: normalizedParams.referenceImageUrl,
    };
  }

  switch (config.protocol_type) {
    case "siliconflow_kling":
      return generateSiliconFlowKling(config, normalizedParams);
    case "siliconflow_vidu":
      return generateSiliconFlowVidu(config, normalizedParams);
    case "runway":
      return generateRunway(config, normalizedParams);
    case "replicate":
      return generateReplicate(config, normalizedParams);
    case "unified_video":
      return generateUnifiedVideo(config, normalizedParams);
    case "grok_video":
      return generateGrokVideo(config, normalizedParams);
    case "kling":
      return generateKling(config, normalizedParams);
    case "kling_official":
      return generateKlingOfficial(config, normalizedParams);
    case "yunwu_video":
      return generateYunwuVideo(config, normalizedParams);
    case "secure_skill_seedance_video":
      return generateSecureSkillSeedance(config, params);
    case "secure_skill_doubao_seedance":
      return generateSecureSkillDoubaoSeedance(config, normalizedParams);
    case "secure_skill_grok_video":
    case "secure_skill_video":
      return generateSecureSkillGrokVideo(config, normalizedParams);
    case "secure_skill_enterprise_video":
      return generateSecureSkillEnterpriseVideo(config, normalizedParams);
    case "secure_skill_flow_jobs":
      return generateSecureSkillFlowJob(config, normalizedParams);
    case "secure_skill_wan3_video":
      return generateSecureSkillWan3Video(config, normalizedParams);
    case "suanlicheng_video":
      return generateSuanlichengVideo(config, normalizedParams);
    case "gaorui_video":
      return generateGaoruiVideo(config, normalizedParams);
    case "newapi_video":
      return generateNewApiVideo(config, normalizedParams);
    case "lanmao_video":
      return generateLanmaoVideo(config, normalizedParams);
    case "autodl_comfyui_h3":
      return generateAutoDLComfyH3(config, normalizedParams);
    case AUTODL_COMFYUI_WORKFLOW_PROTOCOL:
      return generateAutodlComfyuiWorkflow(config, normalizedParams);
    case "autodl_h3_selfhost":
      return generateAutodlH3SelfhostVideo(config, normalizedParams);
    case "volcengine_digital_human":
      return submitVolcDigitalHuman(config, normalizedParams);
    case "dashscope_video_retalk":
      return submitVideoRetalk(config, normalizedParams);
    case "dashscope_wan_s2v":
      return generateDashscopeWanS2v(config, normalizedParams);
    // ── 以下协议走通用适配器（数据驱动，配置即生效） ──
    case "openapi_video":
      return generateOpenApiVideo(config, normalizedParams);
    case "openai_compatible":
      return generateOpenAICompatible(config, normalizedParams);
    default:
      throw new Error(`VIDEO_PROTOCOL_UNSUPPORTED:${String(config.protocol_type || "missing")}`);
  }
}

/** 轮询视频生成结果 */
export async function pollVideoTask(config: VideoModelConfig, taskId: string, contentUrl?: string): Promise<VideoTaskResult> {
  switch (config.protocol_type) {
    case "siliconflow_kling":
      return pollSiliconFlowKling(config, taskId);
    case "siliconflow_vidu":
      return pollSiliconFlowVidu(config, taskId);
    case "runway":
      return pollRunway(config, taskId);
    case "replicate":
      return pollReplicate(config, taskId);
    case "unified_video":
      return pollUnifiedVideo(config, taskId, contentUrl);
    case "grok_video":
      return pollGrokVideo(config, taskId, contentUrl);
    case "kling":
      return pollKling(config, taskId);
    case "kling_official":
      return pollKlingOfficial(config, taskId);
    case "yunwu_video":
      return pollYunwuVideo(config, taskId);
    case "secure_skill_seedance_video":
    case "secure_skill_grok_video":
    case "secure_skill_video":
      return pollSecureSkillGrokVideo(config, taskId);
    case "secure_skill_enterprise_video":
      return pollSecureSkillGrokVideo(config, taskId);
    case "secure_skill_doubao_seedance":
      return pollSecureSkillDoubaoSeedance(config, taskId);
    case "secure_skill_flow_jobs":
      return pollSecureSkillFlowJob(config, taskId);
    case "secure_skill_wan3_video":
      return pollSecureSkillWan3Video(config, taskId);
    case "suanlicheng_video":
      return pollSuanlichengVideo(config, taskId);
    case "gaorui_video":
      return pollGaoruiVideo(config, taskId);
    case "newapi_video":
      return pollNewApiVideo(config, taskId);
    case "lanmao_video":
      return pollLanmaoVideo(config, taskId);
    case "autodl_comfyui_h3":
      return pollAutoDLComfyH3(config, taskId);
    case AUTODL_COMFYUI_WORKFLOW_PROTOCOL:
      return pollAutodlComfyuiWorkflow(config, taskId);
    case "autodl_h3_selfhost":
      return pollAutodlH3SelfhostVideo(config, taskId);
    case "volcengine_digital_human":
      return pollVolcDigitalHuman(config, taskId);
    case "dashscope_video_retalk":
    case "dashscope_wan_s2v":
      return pollDashscopeWanS2v(config, taskId);
    // ── 以下协议走通用适配器（数据驱动，配置即生效） ──
    case "openapi_video":
      return pollOpenApiVideo(config, taskId);
    case "openai_compatible":
      return pollOpenAICompatible(config, taskId);
    default:
      throw new Error(`VIDEO_PROTOCOL_UNSUPPORTED:${String(config.protocol_type || "missing")}`);
  }
}
