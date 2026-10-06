/**
 * 视频生成竞速引擎 —— "抢票加速"
 *
 * 核心思想：用户选一个模型，系统在后台自动找到同模型的所有可用通道，
 * 并行竞速或顺序故障转移，谁先成功用谁。
 *
 * 策略：
 * - RACE（并行竞速）：同时向多个通道提交，谁先返回成功结果用谁的
 *   适用于异步模型（veo），提交很快但需轮询
 * - FAILOVER（故障转移）：优先用最健康的通道，失败自动切下一个
 *   适用于同步模型（grok-video-3），每次请求耗时长
 *
 * 健康度追踪：
 * - 每个通道记录最近请求的成功率和平均响应时间
 * - 连续失败 N 次自动降级（冷却期内不使用）
 * - 恢复机制：冷却期后自动尝试恢复
 */

import {
  submitVideoTask,
  type VideoModelConfig,
  type VideoGenerateParams,
  type VideoTaskResult,
} from "./video-adapter";

// ─── 类型定义 ────────────────────────────────────────

interface ChannelHealthRecord {
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failCount: number;
  /** 总请求数 */
  totalRequests: number;
  /** 累计响应时间(ms) */
  totalResponseMs: number;
  /** 最后成功时间戳 */
  lastSuccessAt: number;
  /** 最后失败时间戳 */
  lastFailAt: number;
  /** 连续失败次数 */
  consecutiveFails: number;
}

export interface RacingConfig {
  /** 最大并行通道数（默认2） */
  maxParallelChannels: number;
  /** 同步模型单通道超时(ms)，默认180s */
  syncChannelTimeoutMs: number;
  /** 异步模型单通道超时(ms)，默认30s */
  asyncChannelTimeoutMs: number;
  /** 最大故障转移尝试次数（默认3） */
  maxFailoverAttempts: number;
  /** 通道降级冷却时间(ms)，默认60s */
  cooldownMs: number;
  /** 连续失败多少次后降级（默认5） */
  maxConsecutiveFails: number;
}

export interface RaceResult {
  /** 最终结果 */
  result: VideoTaskResult;
  /** 获胜通道 */
  winningChannel: VideoModelConfig;
  /** 响应时间(ms) */
  responseMs: number;
  /** 尝试过的所有通道ID */
  attemptedChannels: string[];
  /** 使用的策略 */
  strategy: "race" | "failover";
  /** 是否发生过失败转移 */
  failedOver: boolean;
  /** 各通道的详细结果 */
  channelResults: Array<{
    channelId: string;
    success: boolean;
    responseMs: number;
    error?: string;
  }>;
}

// ─── 默认配置 ────────────────────────────────────────

const DEFAULT_CONFIG: RacingConfig = {
  maxParallelChannels: 2,
  syncChannelTimeoutMs: 180_000, // 3分钟（grok-video-3等同步模型）
  asyncChannelTimeoutMs: 30_000, // 30秒（veo等异步模型提交超时）
  maxFailoverAttempts: 3,
  cooldownMs: 30_000, // 降级冷却30秒（快速恢复，提高可用性）
  maxConsecutiveFails: 5,
};

// ─── 竞速引擎 ────────────────────────────────────────

class VideoRacingEngine {
  private healthMap = new Map<string, ChannelHealthRecord>();
  private config: RacingConfig;

  constructor(config?: Partial<RacingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── 健康度管理 ──────────────────────────────────

  /** 获取通道健康记录（不存在则创建） */
  private getHealth(channelId: string): ChannelHealthRecord {
    if (!this.healthMap.has(channelId)) {
      this.healthMap.set(channelId, {
        successCount: 0,
        failCount: 0,
        totalRequests: 0,
        totalResponseMs: 0,
        lastSuccessAt: 0,
        lastFailAt: 0,
        consecutiveFails: 0,
      });
    }
    return this.healthMap.get(channelId)!;
  }

  /** 记录一次请求结果 */
  recordResult(channelId: string, success: boolean, responseMs: number): void {
    const h = this.getHealth(channelId);
    h.totalRequests++;
    h.totalResponseMs += responseMs;

    if (success) {
      h.successCount++;
      h.lastSuccessAt = Date.now();
      h.consecutiveFails = 0; // 成功则重置连续失败计数
    } else {
      h.failCount++;
      h.lastFailAt = Date.now();
      h.consecutiveFails++;
    }
  }

  /**
   * 计算通道健康分数 (0-100)
   * 公式: 成功率权重70% + 响应速度权重30% - 连续失败惩罚
   */
  getHealthScore(channelId: string): number {
    const h = this.getHealth(channelId);

    // 冷却期内：连续失败过多，分数归零
    if (
      h.consecutiveFails >= this.config.maxConsecutiveFails &&
      Date.now() - h.lastFailAt < this.config.cooldownMs
    ) {
      return 0;
    }

    // 冷却期已过：重置连续失败计数，给一次机会
    if (
      h.consecutiveFails >= this.config.maxConsecutiveFails &&
      Date.now() - h.lastFailAt >= this.config.cooldownMs
    ) {
      h.consecutiveFails = 0;
    }

    // 无历史数据 → 默认50分（中立）
    if (h.totalRequests === 0) return 50;

    // 成功率得分 (0-70)
    const successRate = h.successCount / h.totalRequests;
    const successScore = successRate * 70;

    // 响应速度得分 (0-30)，越快越高
    const avgMs = h.totalResponseMs / h.totalRequests;
    const speedScore = Math.max(0, 30 - (avgMs / 1000) * 0.5); // 每秒扣0.5分

    // 连续失败惩罚
    const failPenalty = Math.min(h.consecutiveFails * 10, 40);

    return Math.max(0, Math.min(100, successScore + speedScore - failPenalty));
  }

  /** 重置通道健康状态（用于过载重试前清除冷却期） */
  resetChannelHealth(channelId: string): void {
    const h = this.getHealth(channelId);
    h.consecutiveFails = 0;
  }

  /** 获取通道平均响应时间 */
  getAvgResponseMs(channelId: string): number {
    const h = this.getHealth(channelId);
    return h.totalRequests > 0 ? h.totalResponseMs / h.totalRequests : 0;
  }

  /** 获取通道成功率 */
  getSuccessRate(channelId: string): number {
    const h = this.getHealth(channelId);
    return h.totalRequests > 0 ? h.successCount / h.totalRequests : 0;
  }

  /** 按健康度排序通道（高分在前） */
  sortChannelsByHealth(channels: VideoModelConfig[]): VideoModelConfig[] {
    return [...channels].sort((a, b) => {
      return this.getHealthScore(b.id) - this.getHealthScore(a.id);
    });
  }

  // ─── 判断模型类型 ──────────────────────────────────

  /** 同步模型（请求等待1-3分钟直接返回视频URL） */
  private isSyncModel(protocolType: string): boolean {
    return protocolType === "grok_video";
  }

  // ─── 核心方法：智能竞速 ──────────────────────────

  /**
   * 智能竞速：自动选择最优策略
   * - 同步模型（grok-video）→ FAILOVER（避免同时占2个长连接）
   * - 异步模型（veo/yunwu）→ RACE（提交快，并行抢速度）
   * - 单通道 → 直接调用
   */
  async smartRace(
    channels: VideoModelConfig[],
    params: VideoGenerateParams
  ): Promise<RaceResult> {
    // 过滤掉不可用的通道
    const availableChannels = channels.filter((ch) => {
      const score = this.getHealthScore(ch.id);
      return score > 0; // 冷却期内的通道不参与
    });

    if (availableChannels.length === 0) {
      // 所有通道都在冷却期，强行用健康度最高的一个（给一次机会）
      const fallback = this.sortChannelsByHealth(channels)[0];
      if (fallback) {
        return this.singleChannel(fallback, params);
      }
      throw new Error("所有通道暂时不可用，请稍后重试");
    }

    // 单通道直接调用
    if (availableChannels.length === 1) {
      return this.singleChannel(availableChannels[0], params);
    }

    // 按健康度排序
    const sorted = this.sortChannelsByHealth(availableChannels);

    // 根据模型类型选择策略
    const isSync = this.isSyncModel(sorted[0].protocol_type);

    if (isSync) {
      // 同步模型：故障转移（避免同时占多个长连接）
      return this.failover(sorted, params);
    } else {
      // 异步模型：并行竞速
      return this.race(sorted, params);
    }
  }

  /**
   * 并行竞速：同时向多个通道提交，谁先成功用谁的
   * 适用于异步模型（veo），提交操作本身很快
   *
   * 优化：使用 Promise 竞速，第一个通道成功即返回，
   * 不再等待所有通道完成（之前用 Promise.allSettled 会等最慢通道超时）
   */
  async race(
    channels: VideoModelConfig[],
    params: VideoGenerateParams
  ): Promise<RaceResult> {
    const raceChannels = channels.slice(0, this.config.maxParallelChannels);
    const channelResults: RaceResult["channelResults"] = [];
    const attemptedChannels: string[] = raceChannels.map((ch) => ch.id);
    const startTime = Date.now();

    // 用于取消其他通道的 AbortController
    const abortControllers = raceChannels.map(() => new AbortController());
    let resolved = false;

    // 构建每个通道的 Promise
    const channelPromises = raceChannels.map(async (channel, idx) => {
      const chStart = Date.now();
      try {
        const timeoutMs = this.isSyncModel(channel.protocol_type)
          ? this.config.syncChannelTimeoutMs
          : this.config.asyncChannelTimeoutMs;

        const result = await this.withTimeout(
          submitVideoTask(channel, params),
          timeoutMs,
          `${channel.id} 超时`
        );

        // 如果已经被其他通道抢先完成，丢弃此结果
        if (resolved) return null;

        const responseMs = Date.now() - chStart;
        const success =
          result.status === "success" ||
          (result.status === "processing" && !!result.taskId);

        this.recordResult(channel.id, success, responseMs);
        channelResults.push({ channelId: channel.id, success, responseMs });

        return { result, channel, responseMs, idx };
      } catch (error) {
        // 已被其他通道抢先完成，丢弃错误
        if (resolved) return null;

        const responseMs = Date.now() - chStart;
        const errMsg =
          error instanceof Error ? error.message : "通道请求失败";

        this.recordResult(channel.id, false, responseMs);
        channelResults.push({
          channelId: channel.id,
          success: false,
          responseMs,
          error: errMsg,
        });

        return null;
      }
    });

    // 真正的竞速：谁先成功就返回谁，不等其他通道
    // 外层 Promise：第一个成功的通道立即 resolve
    const firstSuccess = new Promise<{
      result: VideoTaskResult;
      channel: VideoModelConfig;
      responseMs: number;
    } | null>((resolve) => {
      let settled = false;

      channelPromises.forEach((promise) => {
        promise.then((value) => {
          if (settled) return;
          // 找到非null且非failed的结果
          if (value && value.result.status !== "failed") {
            settled = true;
            resolved = true;
            // 取消其他还在运行的通道
            abortControllers.forEach((ac, i) => {
              if (i !== value.idx) ac.abort();
            });
            resolve(value);
          }
        });
      });

      // 所有通道都完成后，如果没有成功结果，resolve null
      Promise.allSettled(channelPromises).then(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    });

    const winner = await firstSuccess;

    if (winner) {
      return {
        result: winner.result,
        winningChannel: winner.channel,
        responseMs: Date.now() - startTime,
        attemptedChannels,
        strategy: "race",
        failedOver: channelResults.some((r) => !r.success),
        channelResults,
      };
    }

    // 全部失败 → 返回最后一个错误
    const lastFailed = channelResults.filter((r) => !r.success).pop();
    const lastChannel = raceChannels[raceChannels.length - 1];

    return {
      result: {
        taskId: "",
        status: "failed",
        error: lastFailed?.error || "所有通道均失败，请稍后重试",
      },
      winningChannel: lastChannel,
      responseMs: Date.now() - startTime,
      attemptedChannels,
      strategy: "race",
      failedOver: true,
      channelResults,
    };
  }

  /**
   * 故障转移：逐个尝试通道，失败切下一个
   * 适用于同步模型（grok-video-3），避免同时占多个长连接
   *
   * 优化：对"快速失败"（如"负载大"、认证错误）立即切换，
   *       对"慢速失败"（如超时）也要快速切换
   */
  async failover(
    channels: VideoModelConfig[],
    params: VideoGenerateParams
  ): Promise<RaceResult> {
    const channelResults: RaceResult["channelResults"] = [];
    const attemptedChannels: string[] = [];
    const startTime = Date.now();

    const maxAttempts = Math.min(
      this.config.maxFailoverAttempts,
      channels.length
    );

    for (let i = 0; i < maxAttempts; i++) {
      const channel = channels[i];
      attemptedChannels.push(channel.id);
      const chStart = Date.now();

      try {
        const timeoutMs = this.isSyncModel(channel.protocol_type)
          ? this.config.syncChannelTimeoutMs
          : this.config.asyncChannelTimeoutMs;

        const result = await this.withTimeout(
          submitVideoTask(channel, params),
          timeoutMs,
          `${channel.id} 超时`
        );

        const responseMs = Date.now() - chStart;
        const success =
          result.status === "success" ||
          (result.status === "processing" && !!result.taskId);

        this.recordResult(channel.id, success, responseMs);
        channelResults.push({ channelId: channel.id, success, responseMs });

        if (success) {
          return {
            result,
            winningChannel: channel,
            responseMs: Date.now() - startTime,
            attemptedChannels,
            strategy: "failover",
            failedOver: i > 0,
            channelResults,
          };
        }

        // 结果是failed但不是异常，记录错误继续下一个通道
        channelResults[channelResults.length - 1].error =
          result.error || "生成失败";
      } catch (error) {
        const responseMs = Date.now() - chStart;
        const errMsg =
          error instanceof Error ? error.message : "通道请求失败";

        this.recordResult(channel.id, false, responseMs);
        channelResults.push({
          channelId: channel.id,
          success: false,
          responseMs,
          error: errMsg,
        });
      }
    }

    // 所有通道都失败
    const lastFailed = channelResults.filter((r) => !r.success).pop();
    const lastChannel = channels[maxAttempts - 1];

    return {
      result: {
        taskId: "",
        status: "failed",
        error:
          lastFailed?.error ||
          `已尝试 ${maxAttempts} 个通道均失败，请稍后重试`,
      },
      winningChannel: lastChannel,
      responseMs: Date.now() - startTime,
      attemptedChannels,
      strategy: "failover",
      failedOver: true,
      channelResults,
    };
  }

  /** 单通道直接调用 */
  private async singleChannel(
    channel: VideoModelConfig,
    params: VideoGenerateParams
  ): Promise<RaceResult> {
    const startTime = Date.now();

    try {
      const timeoutMs = this.isSyncModel(channel.protocol_type)
        ? this.config.syncChannelTimeoutMs
        : this.config.asyncChannelTimeoutMs;

      const result = await this.withTimeout(
        submitVideoTask(channel, params),
        timeoutMs,
        "请求超时"
      );

      const responseMs = Date.now() - startTime;
      const success =
        result.status === "success" ||
        (result.status === "processing" && !!result.taskId);

      this.recordResult(channel.id, success, responseMs);

      return {
        result,
        winningChannel: channel,
        responseMs,
        attemptedChannels: [channel.id],
        strategy: "failover",
        failedOver: false,
        channelResults: [
          { channelId: channel.id, success, responseMs, error: result.error },
        ],
      };
    } catch (error) {
      const responseMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : "通道请求失败";

      this.recordResult(channel.id, false, responseMs);

      return {
        result: { taskId: "", status: "failed", error: errMsg },
        winningChannel: channel,
        responseMs,
        attemptedChannels: [channel.id],
        strategy: "failover",
        failedOver: false,
        channelResults: [
          { channelId: channel.id, success: false, responseMs, error: errMsg },
        ],
      };
    }
  }

  /** 带超时的Promise包装 */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  // ─── 诊断信息 ──────────────────────────────────────

  /** 获取所有通道的健康状态（供管理后台查看） */
  getHealthStatus(): Array<{
    channelId: string;
    healthScore: number;
    successRate: number;
    avgResponseMs: number;
    consecutiveFails: number;
    totalRequests: number;
    isCoolingDown: boolean;
  }> {
    const entries = Array.from(this.healthMap.entries());
    return entries.map(([channelId, h]) => ({
      channelId,
      healthScore: this.getHealthScore(channelId),
      successRate: this.getSuccessRate(channelId),
      avgResponseMs: this.getAvgResponseMs(channelId),
      consecutiveFails: h.consecutiveFails,
      totalRequests: h.totalRequests,
      isCoolingDown:
        h.consecutiveFails >= this.config.maxConsecutiveFails &&
        Date.now() - h.lastFailAt < this.config.cooldownMs,
    }));
  }

  /** 重置指定通道的健康状态 */
  resetChannel(channelId: string): void {
    this.healthMap.delete(channelId);
  }

  /** 重置所有通道健康状态 */
  resetAll(): void {
    this.healthMap.clear();
  }
}

// ─── 导出单例 ────────────────────────────────────────

export const videoRacing = new VideoRacingEngine();
