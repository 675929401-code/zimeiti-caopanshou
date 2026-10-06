// AI语音克隆工坊 - 核心类型定义

/** TTS 引擎类型 */
export type TTSEngine =
  | 'volcano'
  | 'cosyvoice'
  | 'fish_audio'
  | 'elevenlabs'
  | 'gpt_sovits'
  | 'openai_tts'
  | 'aliyun_clone'
  | 'aliyun_tts';

/** 支持的语言 */
export type Language = 'zh' | 'en' | 'ja' | 'ko' | 'multilingual';

/** 性别 */
export type Gender = 'male' | 'female' | 'neutral';

/** 声音分类 */
export type VoiceCategory = 'preset' | 'cloned' | 'custom';

/** 克隆状态 */
export type CloneStatus = 'pending' | 'training' | 'ready' | 'failed';

/** 生成状态 */
export type GenerationStatus = 'pending' | 'processing' | 'success' | 'failed';

/** 输出格式 */
export type OutputFormat = 'mp3' | 'wav' | 'ogg' | 'flac';

/** 情感类型 */
export type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful' | 'gentle' | 'serious';

/** 引擎元信息配置 */
export interface EngineConfig {
  /** 引擎标识 */
  id: TTSEngine;
  /** 引擎名称 */
  name: string;
  /** 引擎描述 */
  description: string;
  /** 官网地址 */
  website: string;
  /** API Key 配置项名称 */
  apiKeyName: string;
  /** 额外配置项（字段名 -> 描述） */
  extraConfigKeys: { key: string; label: string; required: boolean; placeholder?: string }[];
  /** 支持的语言 */
  supportedLanguages: Language[];
  /** 是否支持声音克隆 */
  cloneSupported: boolean;
  /** 是否支持流式输出 */
  streamingSupported: boolean;
  /** 价格说明 */
  pricingNote: string;
  /** 是否启用 */
  enabled: boolean;
}

/** 声音模型 */
export interface VoiceModel {
  /** 声音ID */
  id: string;
  /** 声音名称 */
  name: string;
  /** 分类：预设/克隆/自定义 */
  category: VoiceCategory;
  /** 所属引擎 */
  engine: TTSEngine;
  /** 说话人ID（引擎内的标识） */
  speakerId: string;
  /** 风格标签 */
  styleTags: string[];
  /** 性别 */
  gender: Gender;
  /** 语言 */
  language: Language;
  /** 示例音频URL */
  demoAudioUrl?: string;
  /** 是否公开 */
  isPublic: boolean;
  /** 描述 */
  description?: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/** TTS 请求 */
export interface TTSRequest {
  /** 合成文本 */
  text: string;
  /** 声音模型ID */
  voiceModelId: string;
  /** 语速（0.5 - 2.0） */
  speedRatio?: number;
  /** 情感 */
  emotion?: Emotion;
  /** 输出格式 */
  outputFormat?: OutputFormat;
  /** 指定引擎（可选，默认用声音模型对应的引擎） */
  engine?: TTSEngine;
}

/** TTS 响应数据 */
export interface TTSResponseData {
  /** 生成ID */
  generationId: string;
  /** 音频URL（如果已落盘） */
  audioUrl?: string;
  /** 音频Base64数据 */
  audioData?: string;
  /** 音频时长（秒） */
  duration: number;
  /** 音频格式 */
  format: OutputFormat;
  /** 本次消耗（字符数或积分） */
  cost: number;
}

/** TTS 响应 */
export interface TTSResponse {
  success: boolean;
  data?: TTSResponseData;
  message: string;
  code?: string;
}

/** 克隆请求 */
export interface CloneRequest {
  /** 音频数据（Base64） */
  audioData: string;
  /** 音频格式 */
  audioFormat: string;
  /** 声音名称 */
  voiceName: string;
  /** 语言 */
  language: Language;
  /** 引擎 */
  engine: TTSEngine;
}

/** 克隆响应数据 */
export interface CloneResponseData {
  /** 克隆任务ID */
  cloneId: string;
  /** 说话人ID（引擎返回） */
  speakerId: string;
  /** 克隆状态 */
  status: CloneStatus;
  /** 预计完成时间（秒） */
  estimatedTime: number;
  /** 示例音频URL */
  demoAudioUrl?: string;
  /** 供应商原始训练状态，仅用于诊断；业务层使用 status */
  providerStatus?: number | string;
  /** 供应商返回的剩余训练次数 */
  availableTrainingTimes?: number;
  /** 已归一化字段名的供应商模型状态 */
  speakerStatus?: Array<{ modelType: number; demoAudio?: string }>;
}

/** 克隆响应 */
export interface CloneResponse {
  success: boolean;
  data?: CloneResponseData;
  message: string;
  code?: string;
}

/** 已存储的引擎配置 */
export interface StoredEngineConfig {
  /** 引擎标识 */
  engine: TTSEngine;
  /** API Key */
  apiKey: string;
  /** 额外配置 */
  extraConfig: Record<string, string>;
  /** 是否启用 */
  enabled: boolean;
  /** 成本价（每次生成花费多少积分） */
  costPrice?: number;
  /** 零售价（用户每次生成扣多少积分） */
  retailPrice?: number;
}

/** 服务卡片 — 一个可独立配置的 TTS/克隆服务实例 */
export interface ServiceCard {
  /** 卡片唯一ID */
  id: string;
  /** 显示名称（如 "火山引擎-语音合成"、"火山引擎-声音克隆"） */
  name: string;
  /** 引擎类型（决定使用哪个适配器） */
  engineType: TTSEngine;
  /** 服务类型 */
  serviceType: 'tts' | 'clone' | 'both';
  /** API Key */
  apiKey: string;
  /** 额外配置（AppID、Cluster 等） */
  extraConfig: Record<string, string>;
  /** 成本价（积分/次） */
  costPrice: number;
  /** 零售价（积分/次） */
  retailPrice: number;
  /** 是否设为默认 */
  isDefault: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 排序 */
  sortOrder: number;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/** 语音生成记录 */
export interface VoiceGeneration {
  /** 记录ID */
  id: string;
  /** 用户ID */
  userId: string;
  /** 声音模型ID */
  voiceModelId: string;
  /** 声音模型名称（冗余字段，便于展示） */
  voiceModelName: string;
  /** 输入文本 */
  inputText: string;
  /** 文本长度 */
  textLength: number;
  /** 输出音频URL */
  outputAudioUrl?: string;
  /** 输出音频时长 */
  outputDuration?: number;
  /** 稳定对象存储键（历史恢复时换取短期签名 URL） */
  outputStorageKey?: string;
  /** 当前用户拥有的音频资产编号 */
  outputAssetId?: string;
  /** 对象存储供应商 */
  outputStorageProvider?: 'coze_s3' | 'tencent_cos' | 'local';
  /** 输出 MIME 类型 */
  outputContentType?: string;
  /** 输出文件大小（字节） */
  outputFileSize?: number;
  /** 输出格式 */
  outputFormat: OutputFormat;
  /** 语速 */
  speedRatio: number;
  /** 情感 */
  emotion: Emotion;
  /** 引擎 */
  engine: TTSEngine;
  /** 消耗 */
  cost: number;
  /** 状态 */
  status: GenerationStatus;
  /** 持久任务终态；旧版浏览器历史没有该字段 */
  terminalState?: 'completed' | 'submitting' | 'refunded' | 'failed_unknown' | 'recovery_required' | 'legacy_unknown';
  /** 本次任务可核验的计费状态 */
  billingState?: 'not_charged' | 'exempt' | 'fully_refunded' | 'charged' | 'unknown';
  /** 原始扣费积分 */
  chargedCredits?: number;
  /** 已退款积分 */
  refundedCredits?: number;
  /** 服务器已确认该终态可以安全载入后重试 */
  retryEligible?: boolean;
  /** 不允许重试时的可展示原因 */
  retryUnavailableReason?: string;
  /** 错误信息 */
  errorMessage?: string;
  /** 创建时间 */
  createdAt: string;
}

/** 统一API响应 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message: string;
  code?: string;
}

/** 引擎连接测试结果 */
export interface EngineTestResult {
  success: boolean;
  message: string;
  latency?: number;
}
