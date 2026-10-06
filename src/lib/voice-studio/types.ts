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
export type Language = 'zh' | 'en' | 'ja' | 'ko' | 'yue' | 'id' | 'de' | 'fr' | 'es-mx' | 'pt-br' | 'ms' | 'th' | 'fil' | 'ru' | 'ar' | 'multilingual';

/** 性别 */
export type Gender = 'male' | 'female' | 'neutral';

/** 声音分类 */
export type VoiceCategory = 'preset' | 'cloned' | 'custom';

/** 克隆状态 */
export type CloneStatus = 'pending' | 'training' | 'ready' | 'failed';

/** 生成状态 */
export type GenerationStatus = 'pending' | 'processing' | 'success' | 'failed';

/** 输出格式 */
export type OutputFormat = 'mp3' | 'wav' | 'ogg' | 'ogg_opus' | 'pcm' | 'flac';

/** 情感类型 */
export type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful' | 'gentle' | 'serious';

/** 引擎元信息配置 */
export interface EngineConfig {
  id: TTSEngine;
  name: string;
  description: string;
  website: string;
  apiKeyName: string;
  extraConfigKeys: { key: string; label: string; required: boolean; placeholder?: string }[];
  supportedLanguages: Language[];
  cloneSupported: boolean;
  streamingSupported: boolean;
  pricingNote: string;
  enabled: boolean;
}

/** 声音模型 */
export interface VoiceModel {
  id: string;
  name: string;
  category: VoiceCategory;
  engine: TTSEngine;
  speakerId: string;
  styleTags: string[];
  gender: Gender;
  language: Language;
  demoAudioUrl?: string;
  isPublic: boolean;
  isCloned?: boolean;
  cloneId?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** TTS 请求 */
export interface TTSRequest {
  text: string;
  voiceModelId: string;
  speedRatio?: number;
  emotion?: Emotion;
  outputFormat?: OutputFormat;
  engine?: TTSEngine;
  /** 指令控制文本（如"语速较快，带有上扬语调"） */
  instructions?: string;
  /** 语言类型（Chinese/English/Japanese 等） */
  language?: string;
  /** 声音ID（火山引擎 speaker / 阿里云 voice 参数） */
  voiceId?: string;
  /** 音量 0.1~2.0 */
  volume?: number;
  /** 音调 0.1~2.0 */
  pitch?: number;
  /** 采样率 */
  sampleRate?: number;
  /** 用户ID（火山引擎 uid） */
  userId?: string;
  /** 输出格式快捷访问 */
  format?: OutputFormat;
  /** 语速 0.1~3.0（火山引擎 speed 字段） */
  speed?: number;
}

/** TTS 响应数据 */
export interface TTSResponseData {
  generationId: string;
  audioUrl?: string;
  audioData?: string;
  duration: number;
  format: OutputFormat;
  cost: number;
}

/** TTS 响应 */
export interface TTSResponse {
  success: boolean;
  data?: TTSResponseData;
  message: string;
  code?: string;
  /** 音频数据（部分引擎直接返回） */
  audio?: { url?: string; data?: string };
  /** 额外元数据（如音色设计返回的 voice_id） */
  metadata?: Record<string, unknown>;
  /** 计费信息 */
  billing?: {
    totalChar: number;
    realCost: number;
    chargeAmount: number;
    profit: number;
    balanceBefore: number;
    balanceAfter: number;
  };
}

/** 克隆请求 */
export interface CloneRequest {
  audioData: string;
  audioFormat: string;
  voiceName: string;
  language: Language;
  engine: TTSEngine;
  /** 克隆后用此声音合成的文本 */
  text?: string;
  /** 克隆声音ID（火山引擎） */
  cloneVoiceId?: string;
  /** 输出格式 */
  format?: OutputFormat;
  /** 用户ID（火山引擎 uid） */
  userId?: string;
  /** V3 API 额外参数 */
  extraParams?: Record<string, unknown>;
}

/** 克隆响应数据 */
export interface CloneResponseData {
  cloneId: string;
  speakerId: string;
  status: CloneStatus;
  estimatedTime: number;
  demoAudioUrl?: string;
  availableTrainingTimes?: number;
  speakerStatus?: Array<{ modelType: number; demoAudio?: string }>;
}

/** 克隆响应 */
export interface CloneResponse {
  success: boolean;
  data?: CloneResponseData;
  message: string;
  code?: string;
  /** 克隆ID */
  cloneId?: string;
  /** 克隆声音ID（用于后续合成） */
  voiceId?: string;
  /** 演示音频URL */
  demoUrl?: string;
  /** 状态（V3: 1=训练中, 2=成功, 3=失败, 4=可用） */
  status?: number;
  /** 剩余训练次数 */
  availableTrainingTimes?: number;
  /** 音色状态详情 */
  speakerStatus?: Array<{ modelType: number; demoAudio?: string }>;
}

/** 已存储的引擎配置 */
export interface StoredEngineConfig {
  engine: TTSEngine;
  apiKey: string;
  extraConfig: Record<string, string>;
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
  /** 显示名称 */
  name: string;
  /** 引擎类型 */
  engineType: TTSEngine;
  /** 服务类型 */
  serviceType: 'tts' | 'clone' | 'both';
  /** API Key */
  apiKey: string;
  /** 额外配置 */
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
  id: string;
  userId: string;
  voiceModelId: string;
  voiceModelName: string;
  inputText: string;
  textLength: number;
  outputAudioUrl?: string;
  outputDuration?: number;
  outputFormat: OutputFormat;
  speedRatio: number;
  emotion: Emotion;
  engine: TTSEngine;
  cost: number;
  status: GenerationStatus;
  errorMessage?: string;
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
