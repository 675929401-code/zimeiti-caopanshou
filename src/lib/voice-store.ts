// 本地 JSON 存储层
// 负责：引擎配置 CRUD、声音库 CRUD、生成记录 CRUD
// 数据持久化到 APP_DATA_DIR；开发环境回退到 data/。
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type {
  TTSEngine,
  StoredEngineConfig,
  VoiceModel,
  VoiceGeneration,
  Language,
} from '@/lib/types';
import { ENGINE_CONFIGS } from '@/lib/tts/engines';
import { atomicWriteJsonSync } from '@/lib/atomic-file';
import { isProductionRuntime, resolveAppDataFile } from '@/lib/runtime-paths';

/** 读取 JSON 文件（仅开发环境允许缺省回退） */
function readJson<T>(file: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(file)) {
      if (isProductionRuntime()) {
        throw new Error(`Required runtime data file is missing: ${file}`);
      }
      return defaultValue;
    }
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isProductionRuntime()) throw error;
    return defaultValue;
  }
}

/** 写入 JSON 文件 */
function writeJson<T>(file: string, data: T): void {
  atomicWriteJsonSync(file, data);
}

// ========== 引擎配置 ==========

// 环境变量回退映射：引擎 → env var name → env value
const ENV_KEY_MAP: Record<string, () => string> = {
  volcano: () => process.env.VOLC_TOKEN || '',
  cosyvoice: () => process.env.DASHSCOPE_API_KEY || '',
  fish_audio: () => process.env.FISH_AUDIO_API_KEY || '',
  elevenlabs: () => process.env.ELEVENLABS_API_KEY || '',
  openai_tts: () => process.env.OPENAI_API_KEY || '',
  gpt_sovits: () => process.env.GPT_SOVITS_API_KEY || '',
};

/** 获取所有引擎配置（与默认元信息合并，无 apiKey 时回退到环境变量） */
export function getAllEngineConfigs(): StoredEngineConfig[] {
  const stored = readJson<StoredEngineConfig[]>(resolveAppDataFile('engine-configs.json'), []);
  const result: StoredEngineConfig[] = [];
  (Object.keys(ENGINE_CONFIGS) as TTSEngine[]).forEach((engine) => {
    const exist = stored.find((s) => s.engine === engine);
    const cfg = exist || {
      engine,
      apiKey: '',
      extraConfig: {},
      enabled: ENGINE_CONFIGS[engine].enabled,
    };
    // 无 apiKey 时回退到环境变量
    if (!cfg.apiKey && ENV_KEY_MAP[engine]) {
      cfg.apiKey = ENV_KEY_MAP[engine]();
    }
    result.push(cfg);
  });
  return result;
}

/** 获取单个引擎配置 */
export function getEngineConfig(engine: TTSEngine): StoredEngineConfig | undefined {
  return getAllEngineConfigs().find((c) => c.engine === engine);
}

/** 保存引擎配置（新增或更新） */
export function saveEngineConfig(cfg: StoredEngineConfig): StoredEngineConfig {
  const configFile = resolveAppDataFile('engine-configs.json');
  const list = readJson<StoredEngineConfig[]>(configFile, []);
  const idx = list.findIndex((c) => c.engine === cfg.engine);
  if (idx >= 0) {
    list[idx] = cfg;
  } else {
    list.push(cfg);
  }
  writeJson(configFile, list);
  return cfg;
}

// ========== 声音库 ==========

/** 预设声音库 */
function defaultVoices(): VoiceModel[] {
  const now = new Date().toISOString();
  return [
    // ── 火山引擎·豆包语音（中文精品音色） ──
    { id: 'vol-female-1', name: '温柔女声·晓颜', category: 'preset', engine: 'volcano', speakerId: 'zh_female_qingxin', styleTags: ['温柔','清新','治愈'], gender: 'female', language: 'zh', isPublic: true, description: '适合情感语录、夜读、ASMR', createdAt: now, updatedAt: now },
    { id: 'vol-female-2', name: '活力女声·小薇', category: 'preset', engine: 'volcano', speakerId: 'zh_female_shaonv', styleTags: ['活泼','元气','年轻'], gender: 'female', language: 'zh', isPublic: true, description: '适合宠物、美食、短视频口播', createdAt: now, updatedAt: now },
    { id: 'vol-female-3', name: '知性女声·雅琴', category: 'preset', engine: 'volcano', speakerId: 'zh_female_wanwan', styleTags: ['知性','优雅','成熟'], gender: 'female', language: 'zh', isPublic: true, description: '适合知识科普、财经、教育', createdAt: now, updatedAt: now },
    { id: 'vol-female-4', name: '甜美女声·小甜', category: 'preset', engine: 'volcano', speakerId: 'zh_female_tianmei', styleTags: ['甜美','可爱','少女'], gender: 'female', language: 'zh', isPublic: true, description: '适合二次元、萌系、宠物', createdAt: now, updatedAt: now },
    { id: 'vol-male-1', name: '磁性男声·闻涛', category: 'preset', engine: 'volcano', speakerId: 'zh_male_M392_conversation_wvae', styleTags: ['磁性','沉稳','成熟'], gender: 'male', language: 'zh', isPublic: true, description: '适合纪录片旁白、商业广告', createdAt: now, updatedAt: now },
    { id: 'vol-male-2', name: '热血男声·铁军', category: 'preset', engine: 'volcano', speakerId: 'zh_male_rap', styleTags: ['激情','有力','热血'], gender: 'male', language: 'zh', isPublic: true, description: '适合励志、健身、运动', createdAt: now, updatedAt: now },
    { id: 'vol-male-3', name: '儒雅男声·书恒', category: 'preset', engine: 'volcano', speakerId: 'zh_female_kailang', styleTags: ['儒雅','温和','书香'], gender: 'male', language: 'zh', isPublic: true, description: '适合历史、文化、读书', createdAt: now, updatedAt: now },

    // ── 阿里云·CosyVoice（中文方言+多语言） ──
    { id: 'cos-female-1', name: '活力女声·可欣', category: 'preset', engine: 'cosyvoice', speakerId: 'longxiaochun', styleTags: ['活力','甜美','年轻'], gender: 'female', language: 'zh', isPublic: true, description: '适合短视频口播、电商带货', createdAt: now, updatedAt: now },
    { id: 'cos-male-1', name: '专业男声·子轩', category: 'preset', engine: 'cosyvoice', speakerId: 'longshu', styleTags: ['专业','新闻','播报'], gender: 'male', language: 'zh', isPublic: true, description: '适合新闻播报、知识科普', createdAt: now, updatedAt: now },
    { id: 'cos-female-2', name: '温柔女声·诗韵', category: 'preset', engine: 'cosyvoice', speakerId: 'longshu', styleTags: ['温柔','细腻','治愈'], gender: 'female', language: 'zh', isPublic: true, description: '适合情感语录、睡前故事', createdAt: now, updatedAt: now },
    { id: 'cos-dialect-1', name: '四川话·幺妹', category: 'preset', engine: 'cosyvoice', speakerId: 'longhua', styleTags: ['方言','四川','接地气'], gender: 'female', language: 'zh', isPublic: true, description: '适合方言口播、本地生活', createdAt: now, updatedAt: now },
    { id: 'cos-dialect-2', name: '东北话·大碴子', category: 'preset', engine: 'cosyvoice', speakerId: 'longcheng', styleTags: ['方言','东北','搞笑'], gender: 'male', language: 'zh', isPublic: true, description: '适合搞笑、东北本地', createdAt: now, updatedAt: now },

    // ── ElevenLabs（英文精品） ──
    { id: 'el-en-male-1', name: 'Narrator Adam', category: 'preset', engine: 'elevenlabs', speakerId: 'onyx', styleTags: ['narration','deep','documentary'], gender: 'male', language: 'en', isPublic: true, description: 'Documentary & narration, deep tone', createdAt: now, updatedAt: now },
    { id: 'el-en-female-1', name: 'Crystal Nova', category: 'preset', engine: 'elevenlabs', speakerId: 'nova', styleTags: ['clear','friendly','podcast'], gender: 'female', language: 'en', isPublic: true, description: 'Podcast & explainer, friendly', createdAt: now, updatedAt: now },
    { id: 'el-en-male-2', name: 'Calm Echo', category: 'preset', engine: 'elevenlabs', speakerId: 'echo', styleTags: ['calm','professional','corporate'], gender: 'male', language: 'en', isPublic: true, description: 'Corporate & calm presentation', createdAt: now, updatedAt: now },
    { id: 'el-en-female-2', name: 'Soft Shimmer', category: 'preset', engine: 'elevenlabs', speakerId: 'shimmer', styleTags: ['soft','warm','storytelling'], gender: 'female', language: 'en', isPublic: true, description: 'Storytelling & audiobook', createdAt: now, updatedAt: now },

    // ── OpenAI TTS（英文标准） ──
    { id: 'oai-en-1', name: 'Alloy·标准英文', category: 'preset', engine: 'openai_tts', speakerId: 'alloy', styleTags: ['neutral','standard','ai'], gender: 'neutral', language: 'en', isPublic: true, description: '适合AI解说、产品演示', createdAt: now, updatedAt: now },
    { id: 'oai-en-2', name: 'Fable·故事声', category: 'preset', engine: 'openai_tts', speakerId: 'fable', styleTags: ['story','narrative','warm'], gender: 'male', language: 'en', isPublic: true, description: '适合英文有声书', createdAt: now, updatedAt: now },

    // ── Fish Audio（多语言） ──
    { id: 'fish-zh-1', name: '知性女声·若曦', category: 'preset', engine: 'fish_audio', speakerId: 'fish-audio-female-1', styleTags: ['知性','优雅','中文'], gender: 'female', language: 'zh', isPublic: true, description: '适合有声书、知识付费', createdAt: now, updatedAt: now },
    { id: 'fish-zh-2', name: '阳光男声·阿泽', category: 'preset', engine: 'fish_audio', speakerId: 'fish-audio-male-1', styleTags: ['阳光','开朗','年轻'], gender: 'male', language: 'zh', isPublic: true, description: '适合体育、户外、旅行', createdAt: now, updatedAt: now },
  ];
}

/** 获取所有声音 */
export function getAllVoices(): VoiceModel[] {
  const voicesFile = resolveAppDataFile('voices.json');
  const stored = readJson<VoiceModel[]>(voicesFile, []);
  if (stored.length === 0) {
    if (isProductionRuntime()) return stored;
    const defaults = defaultVoices();
    writeJson(voicesFile, defaults);
    return defaults;
  }
  return stored;
}

/** 根据 ID 获取声音 */
export function getVoiceById(id: string): VoiceModel | undefined {
  return getAllVoices().find((v) => v.id === id);
}

/** 添加声音 */
export function addVoice(voice: Omit<VoiceModel, 'id' | 'createdAt' | 'updatedAt'>): VoiceModel {
  const list = getAllVoices();
  const now = new Date().toISOString();
  const newVoice: VoiceModel = {
    ...voice,
    id: uuidv4(),
    createdAt: now,
    updatedAt: now,
  };
  list.push(newVoice);
  writeJson(resolveAppDataFile('voices.json'), list);
  return newVoice;
}

/** 更新声音 */
export function updateVoice(id: string, patch: Partial<VoiceModel>): VoiceModel | undefined {
  const list = getAllVoices();
  const idx = list.findIndex((v) => v.id === id);
  if (idx < 0) return undefined;
  list[idx] = { ...list[idx], ...patch, id, updatedAt: new Date().toISOString() };
  writeJson(resolveAppDataFile('voices.json'), list);
  return list[idx];
}

/** 删除声音 */
export function deleteVoice(id: string): boolean {
  const list = getAllVoices();
  const next = list.filter((v) => v.id !== id);
  if (next.length === list.length) return false;
  writeJson(resolveAppDataFile('voices.json'), next);
  return true;
}

/** 搜索声音 */
export function searchVoices(opts: {
  keyword?: string;
  engine?: TTSEngine;
  language?: Language;
  category?: string;
}): VoiceModel[] {
  let list = getAllVoices();
  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase();
    list = list.filter(
      (v) =>
        v.name.toLowerCase().includes(kw) ||
        v.description?.toLowerCase().includes(kw) ||
        v.styleTags.some((t) => t.toLowerCase().includes(kw)),
    );
  }
  if (opts.engine) list = list.filter((v) => v.engine === opts.engine);
  if (opts.language) list = list.filter((v) => v.language === opts.language);
  if (opts.category) list = list.filter((v) => v.category === opts.category);
  return list;
}

// ========== 生成记录 ==========

/** 获取所有生成记录 */
export function getAllGenerations(): VoiceGeneration[] {
  return readJson<VoiceGeneration[]>(resolveAppDataFile('generations.json'), []);
}

/** 添加生成记录 */
export function addGeneration(
  gen: Omit<VoiceGeneration, 'id' | 'createdAt'>,
): VoiceGeneration {
  const list = getAllGenerations();
  const newGen: VoiceGeneration = {
    ...gen,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
  };
  list.unshift(newGen);
  writeJson(resolveAppDataFile('generations.json'), list);
  return newGen;
}

/** 更新生成记录 */
export function updateGeneration(
  id: string,
  patch: Partial<VoiceGeneration>,
): VoiceGeneration | undefined {
  const list = getAllGenerations();
  const idx = list.findIndex((g) => g.id === id);
  if (idx < 0) return undefined;
  list[idx] = { ...list[idx], ...patch, id };
  writeJson(resolveAppDataFile('generations.json'), list);
  return list[idx];
}

/** 分页查询生成记录 */
export function getGenerationsPaginated(opts: {
  page: number;
  pageSize: number;
}): { total: number; page: number; pageSize: number; items: VoiceGeneration[] } {
  const all = getAllGenerations();
  const start = (opts.page - 1) * opts.pageSize;
  return {
    total: all.length,
    page: opts.page,
    pageSize: opts.pageSize,
    items: all.slice(start, start + opts.pageSize),
  };
}

/** 统计信息 */
export function getGenerationStats(): {
  total: number;
  success: number;
  failed: number;
  totalChars: number;
  totalDuration: number;
} {
  const all = getAllGenerations();
  return {
    total: all.length,
    success: all.filter((g) => g.status === 'success').length,
    failed: all.filter((g) => g.status === 'failed').length,
    totalChars: all.reduce((s, g) => s + g.textLength, 0),
    totalDuration: all.reduce((s, g) => s + (g.outputDuration || 0), 0),
  };
}
