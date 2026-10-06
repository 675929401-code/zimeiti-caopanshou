// TTS 引擎元信息配置
import type { EngineConfig, TTSEngine } from '@/lib/types';

export const ENGINE_CONFIGS: Record<TTSEngine, EngineConfig> = {
  volcano: {
    id: 'volcano',
    name: '火山引擎语音',
    description: '字节跳动旗下豆包语音合成，支持极速克隆、多情感、流式输出，中文效果行业领先。',
    website: 'https://www.volcengine.com/product/voice-tech',
    apiKeyName: 'VOLC_TOKEN',
    extraConfigKeys: [
      { key: 'appId', label: '应用ID (AppID)', required: true, placeholder: '在控制台创建应用获取' },
      { key: 'cluster', label: '集群', required: true, placeholder: 'volcano_tts' },
    ],
    supportedLanguages: ['zh', 'en'],
    cloneSupported: true,
    streamingSupported: true,
    pricingNote: '约 0.33 元/千字符（售价），克隆训练 138 元/槽位',
    enabled: true,
  },
  cosyvoice: {
    id: 'cosyvoice',
    name: '阿里云 CosyVoice',
    description: '阿里通义实验室出品，支持零样本/少样本克隆、跨语种合成、情感控制。',
    website: 'https://help.aliyun.com/zh/model-studio/developer-reference/cosyvoice',
    apiKeyName: 'DASHSCOPE_API_KEY',
    extraConfigKeys: [
      { key: 'model', label: '模型名', required: false, placeholder: 'cosyvoice-v1' },
    ],
    supportedLanguages: ['zh', 'en', 'ja', 'multilingual'],
    cloneSupported: true,
    streamingSupported: true,
    pricingNote: '约 0.3 元/千字符',
    enabled: true,
  },
  fish_audio: {
    id: 'fish_audio',
    name: 'Fish Audio',
    description: '海外热门开源TTS，声音自然度高，支持多语种克隆，社区活跃。',
    website: 'https://fish.audio',
    apiKeyName: 'FISH_AUDIO_API_KEY',
    extraConfigKeys: [
      { key: 'baseUrl', label: 'Base URL', required: false, placeholder: 'https://api.fish.audio' },
    ],
    supportedLanguages: ['zh', 'en', 'ja', 'ko', 'multilingual'],
    cloneSupported: true,
    streamingSupported: true,
    pricingNote: '免费额度 50k 字符/月，之后 $0.1/1k 字符',
    enabled: true,
  },
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: '海外顶级语音克隆服务，英语效果极佳，支持多语种、情感、即时克隆。',
    website: 'https://elevenlabs.io',
    apiKeyName: 'ELEVENLABS_API_KEY',
    extraConfigKeys: [
      { key: 'model', label: '模型', required: false, placeholder: 'eleven_multilingual_v2' },
    ],
    supportedLanguages: ['en', 'multilingual'],
    cloneSupported: true,
    streamingSupported: true,
    pricingNote: '免费额度 10k 字符/月，Pro $5/月起',
    enabled: true,
  },
  gpt_sovits: {
    id: 'gpt_sovits',
    name: 'GPT-SoVITS',
    description: '开源本地化部署方案，1分钟素材即可克隆，完全私有化，社区生态丰富。',
    website: 'https://github.com/RVC-Boss/GPT-SoVITS',
    apiKeyName: 'GPT_SOVITS_API_KEY',
    extraConfigKeys: [
      { key: 'baseUrl', label: '服务地址', required: true, placeholder: 'http://localhost:9880' },
    ],
    supportedLanguages: ['zh', 'en', 'ja', 'ko'],
    cloneSupported: true,
    streamingSupported: false,
    pricingNote: '开源免费（需自备GPU服务器）',
    enabled: true,
  },
  openai_tts: {
    id: 'openai_tts',
    name: 'OpenAI TTS',
    description: 'OpenAI 官方 TTS 接口，6种预设音色，自然度高，不支持克隆。',
    website: 'https://platform.openai.com/docs/guides/text-to-speech',
    apiKeyName: 'OPENAI_API_KEY',
    extraConfigKeys: [
      { key: 'model', label: '模型', required: false, placeholder: 'tts-1' },
    ],
    supportedLanguages: ['en', 'multilingual'],
    cloneSupported: false,
    streamingSupported: true,
    pricingNote: '$15/1M 字符',
    enabled: true,
  },
  aliyun_clone: {
    id: 'aliyun_clone',
    name: '阿里云 CosyClone',
    description: '阿里云 CosyVoice 声音克隆，支持多语言、多情感克隆。',
    website: 'https://help.aliyun.com/zh/model-studio/cosyclone',
    apiKeyName: 'ALIYUN_API_KEY',
    extraConfigKeys: [
      { key: 'endpoint', label: 'Endpoint', required: true, placeholder: 'https://nls-gateway.cn-shanghai.aliyuncs.com' },
      { key: 'workspace', label: 'Workspace', required: false, placeholder: 'cosyclone-workspace' },
    ],
    supportedLanguages: ['zh', 'en', 'ja', 'multilingual'],
    cloneSupported: true,
    streamingSupported: false,
    pricingNote: '按调用次数计费',
    enabled: true,
  },
  aliyun_tts: {
    id: 'aliyun_tts',
    name: '阿里云 CosyVoice',
    description: '阿里云 CosyVoice 语音合成，支持多情感、多音色。',
    website: 'https://help.aliyun.com/zh/model-studio/cosyvoice',
    apiKeyName: 'ALIYUN_API_KEY',
    extraConfigKeys: [
      { key: 'endpoint', label: 'Endpoint', required: true, placeholder: 'https://nls-gateway.cn-shanghai.aliyuncs.com' },
      { key: 'workspace', label: 'Workspace', required: false, placeholder: 'cosyvoice-workspace' },
    ],
    supportedLanguages: ['zh', 'en', 'ja', 'multilingual'],
    cloneSupported: false,
    streamingSupported: true,
    pricingNote: '按调用次数计费',
    enabled: true,
  },
};

/** 获取所有引擎列表 */
export function getAllEngines(): EngineConfig[] {
  return Object.values(ENGINE_CONFIGS);
}

/** 根据 ID 获取引擎配置 */
export function getEngineConfig(id: TTSEngine): EngineConfig | undefined {
  return ENGINE_CONFIGS[id];
}
