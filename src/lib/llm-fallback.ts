/**
 * LLM 模型健康记录 — 纯记录，不干预
 *
 * 设计原则：
 * - 仅记录模型的成功/失败状态，用于管理后台诊断
 * - 不做黑名单、冷却、自动降级、自动切换
 * - 模型出问题直接报错，由用户自行优化模型配置
 * - 管理后台可查看每个模型的最近错误信息，方便排查
 */

// ─── 类型定义 ────────────────────────────────────────

interface ModelHealthRecord {
  /** 最后N次请求结果（true=成功, false=失败） */
  recentResults: boolean[];
  /** 连续失败次数 */
  consecutiveFails: number;
  /** 最后失败时间戳 */
  lastFailAt: number;
  /** 最后成功时间戳 */
  lastSuccessAt: number;
  /** 最后失败原因 */
  lastFailReason: string;
}

// ─── 常量 ────────────────────────────────────────────

/** 健康结果窗口大小（只看最近N次） */
const HEALTH_WINDOW_SIZE = 5;

// ─── 全局健康记录 ──────────────────────────────────────

const healthMap = new Map<string, ModelHealthRecord>();

function getHealth(modelName: string): ModelHealthRecord {
  if (!healthMap.has(modelName)) {
    healthMap.set(modelName, {
      recentResults: [],
      consecutiveFails: 0,
      lastFailAt: 0,
      lastSuccessAt: 0,
      lastFailReason: "",
    });
  }
  return healthMap.get(modelName)!;
}

// ─── 健康状态记录 ──────────────────────────────────────

/**
 * 记录模型请求成功
 */
export function recordModelSuccess(modelName: string): void {
  const h = getHealth(modelName);
  h.recentResults.push(true);
  if (h.recentResults.length > HEALTH_WINDOW_SIZE) {
    h.recentResults = h.recentResults.slice(-HEALTH_WINDOW_SIZE);
  }
  h.consecutiveFails = 0;
  h.lastSuccessAt = Date.now();
  h.lastFailReason = "";
}

/**
 * 记录模型请求失败 — 仅记录，不做任何自动处理
 */
export function recordModelFailure(modelName: string, reason: string): void {
  const h = getHealth(modelName);
  h.recentResults.push(false);
  if (h.recentResults.length > HEALTH_WINDOW_SIZE) {
    h.recentResults = h.recentResults.slice(-HEALTH_WINDOW_SIZE);
  }
  h.consecutiveFails++;
  h.lastFailAt = Date.now();
  h.lastFailReason = reason;
  console.warn(`[LLM-Health] 模型 ${modelName} 请求失败 (连续${h.consecutiveFails}次): ${reason}`);
}

// ─── 以下函数保留签名但已禁用功能 ──────────────────────
// 保留导出以兼容现有引用，但均改为无操作

/** 已禁用：不再有冷却机制，永远返回 false */
export function isInCooldown(_modelName: string): boolean {
  return false;
}

/** 已禁用：不再有黑名单，永远返回 false */
export function isBlacklisted(_modelName: string): boolean {
  return false;
}

/** 已禁用：不再有黑名单 */
export function addToBlacklist(_modelName: string, _reason: string): void {
  // no-op
}

/** 已禁用：不再有黑名单 */
export function removeFromBlacklist(_modelName: string): void {
  // no-op
}

/** 已禁用：不再有黑名单 */
export function getBlacklist(): string[] {
  return [];
}

/** 已禁用：不再自动降级 */
export function selectFallbackModel(): null {
  return null;
}

/** 已禁用：不再自动降级 */
export function selectHardcodedFallback(): null {
  return null;
}

/** 已禁用：不再自动降级 */
export function shouldFallback(_modelName: string): boolean {
  return false;
}

/** 已禁用：不再自动降级 */
export function isFallbackableError(_error: string): boolean {
  return false;
}

/** 已禁用：不再种子初始化 */
export function seedKnownBadModels(_badModels: Array<{ modelName: string; reason: string; permanent?: boolean }>): void {
  // no-op
}

// ─── 健康状态查询（管理后台诊断用） ──────────────────────

export function getHealthStatus(): Record<string, {
  consecutiveFails: number;
  lastFailReason: string;
  lastFailAt: number;
  lastSuccessAt: number;
  successRate: number;
}> {
  const result: Record<string, {
    consecutiveFails: number;
    lastFailReason: string;
    lastFailAt: number;
    lastSuccessAt: number;
    successRate: number;
  }> = {};
  for (const [name, h] of healthMap) {
    const successRate = h.recentResults.length > 0
      ? h.recentResults.filter(Boolean).length / h.recentResults.length
      : 1;
    result[name] = {
      consecutiveFails: h.consecutiveFails,
      lastFailReason: h.lastFailReason,
      lastFailAt: h.lastFailAt,
      lastSuccessAt: h.lastSuccessAt,
      successRate: Math.round(successRate * 100) / 100,
    };
  }
  return result;
}

/**
 * 清除所有健康记录（重置）
 */
export function resetAllHealth(): void {
  healthMap.clear();
}

/**
 * 清除指定模型的健康记录
 */
export function clearCooldown(modelName: string): void {
  const h = healthMap.get(modelName);
  if (h) {
    h.consecutiveFails = 0;
    h.lastFailReason = "";
  }
}
