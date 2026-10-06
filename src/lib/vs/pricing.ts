/**
 * 智音工坊定价模块
 * 
 * 读取 voice-platform 的 SQLite ModelConfig 表，计算 TTS 合成费用。
 * 定价公式（加价率模式）：
 *   售价 = costPrice × (1 + profitMargin / 100)
 *   实际费用 = 售价 × (字符数 / 1000)        [千字符单位]
 *   实际费用 = 售价 × 调用次数               [次/分钟单位]
 * 
 * costPrice 自动计算：
 *   costPrice = totalPrice ÷ totalChars × 1000   [千字符单位]
 */

import Database from 'better-sqlite3';
import { resolveVoiceSqlitePath } from '@/lib/voice-studio/database-path';

// ─── 类型 ───────────────────────────────────────────

export interface VoiceModelPricing {
  /** ModelConfig.id */
  id: string;
  /** 显示名称，如"语音合成 2.0" */
  name: string;
  /** API模型ID，如 seed-tts-2.0 */
  modelId: string;
  /** 套餐总价（元） */
  totalPrice: number;
  /** 套餐总字数 */
  totalChars: number;
  /** 单位成本（元/单位） */
  costPrice: number;
  /** 计费单位：千字符 / 次 / 分钟 */
  unit: string;
  /** 利润率（%） */
  profitMargin: number;
  /** 是否激活 */
  isActive: boolean;
}

export interface CostBreakdown {
  /** 原始字符数 */
  charCount: number;
  /** 模型定价 */
  pricing: VoiceModelPricing;
  /** 售价（元） */
  sellPriceRmb: number;
  /** 成本（元） */
  costPriceRmb: number;
  /** 利润（元） */
  profitRmb: number;
  /** 应扣积分（1元 = creditsPerYuan 积分） */
  creditsToCharge: number;
}

export class VoicePricingCatalogError extends Error {
  readonly code = 'VOICE_PRICING_CATALOG_UNAVAILABLE';

  constructor() {
    super('语音模型价格暂时无法读取');
    this.name = 'VoicePricingCatalogError';
  }
}

// ─── 数据库连接 ──────────────────────────────────

let _db: Database.Database | null = null;

function getVoicePlatformDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(resolveVoiceSqlitePath(), {
    readonly: true,
    fileMustExist: true,
  });
  _db.pragma('busy_timeout = 5000');
  return _db;
}

// ─── 读取模型定价 ─────────────────────────────────

/**
 * 根据 modelId 读取 ModelConfig 定价
 * @param modelId 如 "seed-tts-2.0", "seed-icl-2.0", "seed-audio-1.0"
 */
export function getModelPricing(modelId: string): VoiceModelPricing | null {
  try {
    const db = getVoicePlatformDb();
    const row = db.prepare(
      'SELECT id, name, modelId, totalPrice, totalChars, costPrice, unit, profitMargin, isActive FROM ModelConfig WHERE modelId = ? AND isActive = 1 ORDER BY sort ASC LIMIT 1'
    ).get(modelId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      name: row.name as string,
      modelId: row.modelId as string,
      totalPrice: Number(row.totalPrice),
      totalChars: Number(row.totalChars),
      costPrice: Number(row.costPrice),
      unit: row.unit as string,
      profitMargin: Number(row.profitMargin),
      isActive: Boolean(row.isActive),
    };
  } catch (e) {
    console.warn('[vs/pricing] 读取ModelConfig失败:', e);
    return null;
  }
}

/**
 * 读取所有激活的模型定价（供管理页面使用）
 */
export function getAllModelPricing(): VoiceModelPricing[] {
  try {
    const db = getVoicePlatformDb();
    const rows = db.prepare(
      'SELECT id, name, modelId, totalPrice, totalChars, costPrice, unit, profitMargin, isActive FROM ModelConfig WHERE isActive = 1 ORDER BY sort ASC'
    ).all() as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      name: row.name as string,
      modelId: row.modelId as string,
      totalPrice: Number(row.totalPrice),
      totalChars: Number(row.totalChars),
      costPrice: Number(row.costPrice),
      unit: row.unit as string,
      profitMargin: Number(row.profitMargin),
      isActive: Boolean(row.isActive),
    }));
  } catch (e) {
    console.warn('[vs/pricing] 读取所有ModelConfig失败:', e);
    throw new VoicePricingCatalogError();
  }
}

// ─── 费用计算 ─────────────────────────────────────

/** Supplier metering can be smaller than one fen; do not discard it per task. */
export function roundVoiceAccounting(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * 计算 TTS 合成的费用明细
 * 
 * @param charCount 文本字符数
 * @param modelId 模型ID（如 seed-tts-2.0）
 * @param creditsPerYuan 积分汇率（1元=多少积分，默认50）
 * @returns 费用明细，或 null（无匹配定价时）
 */
export function calculateVoiceCost(
  charCount: number,
  modelId: string,
  creditsPerYuan: number = 50,
  /** 按分钟计价时的音频时长（秒），默认60秒=1分钟 */
  durationSeconds?: number,
): CostBreakdown | null {
  if (charCount <= 0) return null;

  const pricing = getModelPricing(modelId);
  if (!pricing) return null;

  const unitPrice = pricing.costPrice * (1 + pricing.profitMargin / 100);

  let sellPriceRmb: number;
  let costPriceRmb: number;

  if (pricing.unit === '千字符') {
    const multiplier = charCount / 1000;
    sellPriceRmb = unitPrice * multiplier;
    costPriceRmb = pricing.costPrice * multiplier;
  } else if (pricing.unit === '分钟') {
    // 按分钟计价：根据实际音频时长计算
    // 预扣费时传 durationSeconds=undefined → 默认按1分钟计
    // 生成完成后可按实际时长重新计算
    const minutes = durationSeconds ? Math.max(durationSeconds / 60, 1/60) : 1;
    // 音色模仿按实际秒数折算；其他产品保留原计费单位。
    const billableMinutes = modelId === 'seed-audio-1.0' ? minutes : Math.ceil(minutes);
    sellPriceRmb = unitPrice * billableMinutes;
    costPriceRmb = pricing.costPrice * billableMinutes;
  } else {
    // 默认按次计价
    sellPriceRmb = unitPrice;
    costPriceRmb = pricing.costPrice;
  }

  // 最少收费 0.01 元
  sellPriceRmb = Math.max(0.01, Math.round(sellPriceRmb * 100) / 100);
  costPriceRmb = roundVoiceAccounting(costPriceRmb);

  const profitRmb = roundVoiceAccounting(sellPriceRmb - costPriceRmb);
  const creditsToCharge = Math.ceil(sellPriceRmb * creditsPerYuan);

  return {
    charCount,
    pricing,
    sellPriceRmb,
    costPriceRmb,
    profitRmb,
    creditsToCharge,
  };
}

/**
 * 根据 speaker/voice 信息推断 modelId
 * 2.0 音色 → seed-tts-2.0, ICL 音色 → seed-icl-2.0
 */
export function inferModelId(speakerId: string, engine?: string): string {
  // 如果引擎明确指定了克隆/复刻类型
  if (engine === 'volcano') {
    // 火山引擎：根据 speakerId 前缀判断
    if (speakerId?.startsWith('ICL_') || speakerId?.startsWith('S_')) {
      return 'seed-icl-2.0';
    }
    // 默认语音合成 2.0
    return 'seed-tts-2.0';
  }
  // 兜底
  return 'seed-tts-2.0';
}
