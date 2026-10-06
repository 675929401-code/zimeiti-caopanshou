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

/** 获取所有引擎配置（与默认元信息合并） */
export function getAllEngineConfigs(): StoredEngineConfig[] {
  const stored = readJson<StoredEngineConfig[]>(resolveAppDataFile('engine-configs.json'), []);
  const result: StoredEngineConfig[] = [];
  (Object.keys(ENGINE_CONFIGS) as TTSEngine[]).forEach((engine) => {
    const exist = stored.find((s) => s.engine === engine);
    result.push(
      exist || {
        engine,
        apiKey: '',
        extraConfig: {},
        enabled: ENGINE_CONFIGS[engine].enabled,
      },
    );
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

/** 8 个默认预设声音 */
function defaultVoices(): VoiceModel[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'preset-zh-female-1',
      name: '温柔女声·晓颜',
      category: 'preset',
      engine: 'volcano',
      speakerId: 'zh_female_qingxin',
      styleTags: ['温柔', '清新', '治愈'],
      gender: 'female',
      language: 'zh',
      isPublic: true,
      description: '适合情感语录、夜读、ASMR 风格',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'preset-zh-male-1',
      name: '磁性男声·闻涛',
      category: 'preset',
      engine: 'volcano',
      speakerId: 'zh_male_M392_conversation_wvae',
      styleTags: ['磁性', '沉稳', '成熟'],
      gender: 'male',
      language: 'zh',
      isPublic: true,
      description: '适合纪录片旁白、商业广告',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'preset-zh-female-2',
      name: '活力女声·可欣',
      category: 'preset',
      engine: 'cosyvoice',
      speakerId: 'longxiaochun',
      styleTags: ['活力', '甜美', '年轻'],
      gender: 'female',
      language: 'zh',
      isPublic: true,
      description: '适合短视频口播、电商带货',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'preset-zh-male-2',
      name: '专业男声·子轩',
      category: 'preset',
      engine: 'cosyvoice',
      speakerId: 'longshu',
      styleTags: ['专业', '新闻', '播报'],
      gender: 'male',
      language: 'zh',
      isPublic: true,
      description: '适合新闻播报、知识科普',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'preset-en-male-1',
      name: 'Narrator Adam',
      category: 'preset',
      engine: 'elevenlabs',
      speakerId: 'onyx',
      styleTags: ['narration', 'deep', 'documentary'],
      gender: 'male',
      language: 'en',
      isPublic: true,
      description: 'Documentary & narration style, deep tone',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'preset-en-female-1',
      name: 'Crystal Nova',
      category: 'preset',
      engine: 'elevenlabs',
      speakerId: 'nova',
      styleTags: ['clear', 'friendly', 'podcast'],
      gender: 'female',
      language: 'en',
      isPublic: true,
      description: 'Podcast & explainer style, friendly tone',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'preset-zh-female-3',
      name: '知性女声·若曦',
      category: 'preset',
      engine: 'fish_audio',
      speakerId: 'fish-audio-female-1',
      styleTags: ['知性', '优雅', '中文'],
      gender: 'female',
      language: 'zh',
      isPublic: true,
      description: '适合有声书、知识付费课程',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'preset-en-male-2',
      name: 'Tech Voice Echo',
      category: 'preset',
      engine: 'openai_tts',
      speakerId: 'echo',
      styleTags: ['tech', 'modern', 'ai'],
      gender: 'male',
      language: 'en',
      isPublic: true,
      description: '适合 AI 产品演示、科技解说',
      createdAt: now,
      updatedAt: now,
    },
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
  userId?: string;
  modelId?: string;
}): { total: number; page: number; pageSize: number; items: VoiceGeneration[] } {
  const all = getAllGenerations()
    .filter(generation => (!opts.userId || generation.userId === opts.userId) && (!opts.modelId || generation.voiceModelId === opts.modelId))
    .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  const start = (opts.page - 1) * opts.pageSize;
  return {
    total: all.length,
    page: opts.page,
    pageSize: opts.pageSize,
    items: all.slice(start, start + opts.pageSize),
  };
}

/** 统计信息 */
export function getGenerationStats(userId?: string): {
  total: number;
  success: number;
  failed: number;
  totalChars: number;
  totalDuration: number;
} {
  const all = userId
    ? getAllGenerations().filter((generation) => generation.userId === userId)
    : getAllGenerations();
  return {
    total: all.length,
    success: all.filter((g) => g.status === 'success').length,
    failed: all.filter((g) => g.status === 'failed').length,
    totalChars: all.reduce((s, g) => s + g.textLength, 0),
    totalDuration: all.reduce((s, g) => s + (g.outputDuration || 0), 0),
  };
}
