/**
 * 扣费系统 - 核心逻辑
 * 
 * 费用计算公式:
 *   实际费用 = (字符数 / 1000) × 成本价 × (1 + 利润率 / 100)
 *   
 * 扣费流程:
 *   1. 用户调用TTS API前检查余额
 *   2. 合成完成后按实际字符数扣费
 *   3. 记录交易日志
 */

import { prisma } from './prisma';

// 单位价（costPrice 已经是每单位的成本，如 ¥0.30/千字符）
// 售价 = costPrice × (1 + profitMargin/100)
// 对于"千字符"单位：千字符价 × (charCount/1000)
// 对于"次"/"分钟"等单位：直接按单位价
export function estimateCost(charCount: number, costPrice: number, profitMargin: number, unit?: string): number {
  if (charCount <= 0) return 0;
  const unitPrice = costPrice * (1 + profitMargin / 100);
  // 按千字符计价时，按实际字符数比例计算
  const multiplier = (unit === '千字符') ? (charCount / 1000) : 1;
  const total = unitPrice * multiplier;
  return Math.max(0.01, Math.round(total * 100) / 100);
}

// 获取指定模型的定价配置（读取 ModelConfig 表）
export async function getModelPricing(modelId: string) {
  const config = await prisma.modelConfig.findFirst({
    where: { modelId, isActive: true },
  });

  if (!config) {
    // 兜底：读旧版 API Config
    const fallback = await prisma.apiConfig.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      costPrice: fallback?.costPricePer1k ?? 0.5,
      profitMargin: fallback?.profitMargin ?? 100,
      unit: '千字符',
      modelConfigId: null,
    };
  }

  // 计算单位成本
  const perUnitPrice = config.totalPrice / config.totalChars;
  const multiplier = config.unit === '千字符' ? 1000 : 1;
  const unitCost = perUnitPrice * multiplier;

  return {
    costPrice: unitCost,
    profitMargin: config.profitMargin,
    unit: config.unit,
    modelConfigId: config.id,
    totalPrice: config.totalPrice,
    totalChars: config.totalChars,
  };
}

// 旧的定价配置读取（兼容旧代码）
export async function getPricingConfig() {
  const config = await prisma.apiConfig.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  return {
    costPricePer1k: config?.costPricePer1k ?? 0.5,
    profitMargin: config?.profitMargin ?? 100,
    configId: config?.id ?? null,
  };
}

// 检查用户余额是否足够
export async function checkBalance(userId: string, estimatedCost: number): Promise<{ sufficient: boolean; balance: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { balance: true },
  });
  
  const balance = user?.balance ?? 0;
  return {
    sufficient: balance >= estimatedCost,
    balance,
  };
}

// 扣费（在TTS合成成功后调用）
// modelId: 模型标识，如 seed-tts-2.0 / seed-icl-2.0 / seed-audio-1.0
export async function deductBalance(
  userId: string,
  charCount: number,
  jobId: string,
  description?: string,
  modelId?: string,
): Promise<{ success: boolean; cost: number; balance: number; error?: string }> {
  // 按模型读取定价
  let costPrice: number;
  let profitMargin: number;
  let unit: string;
  if (modelId) {
    const pricing = await getModelPricing(modelId);
    costPrice = pricing.costPrice;
    profitMargin = pricing.profitMargin;
    unit = pricing.unit;
  } else {
    const pricing = await getPricingConfig();
    costPrice = pricing.costPricePer1k;
    profitMargin = pricing.profitMargin;
    unit = '千字符';
  }
  const cost = estimateCost(charCount, costPrice, profitMargin, unit);

  try {
    // 使用事务确保原子性
    const result = await prisma.$transaction(async (tx: any) => {
      // 1. 锁定用户行并检查余额
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });

      if (!user) {
        throw new Error('用户不存在');
      }

      if (user.balance < cost) {
        throw new Error(`余额不足: 当前余额 ${user.balance} 元，需要 ${cost} 元`);
      }

      // 2. 扣减余额
      const newBalance = Math.round((user.balance - cost) * 100) / 100;
      await tx.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      });

      // 3. 记录交易
      await tx.transaction.create({
        data: {
          userId,
          type: 'deduct',
          amount: cost,
          balance: newBalance,
          description: description || `TTS合成扣费 (${charCount}字符)`,
          jobId,
        },
      });

      // 4. 更新TTS任务记录
      await tx.tTSJob.update({
        where: { id: jobId },
        data: {
          charCount,
          cost,
        },
      });

      return { cost, balance: newBalance };
    });

    return { success: true, ...result };
  } catch (error: any) {
    return { success: false, cost, balance: 0, error: error.message };
  }
}

// 充值（主站调用）
export async function chargeBalance(
  userId: string,
  amount: number,
  description?: string,
): Promise<{ success: boolean; balance: number; error?: string }> {
  if (amount <= 0) {
    return { success: false, balance: 0, error: '充值金额必须大于0' };
  }

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });

      if (!user) {
        throw new Error('用户不存在');
      }

      const newBalance = Math.round((user.balance + amount) * 100) / 100;
      await tx.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: 'charge',
          amount,
          balance: newBalance,
          description: description || '充值',
        },
      });

      return newBalance;
    });

    return { success: true, balance: result };
  } catch (error: any) {
    return { success: false, balance: 0, error: error.message };
  }
}

// 获取用户交易记录
export async function getTransactions(userId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where: { userId } }),
  ]);

  return { transactions, total, page, limit };
}
