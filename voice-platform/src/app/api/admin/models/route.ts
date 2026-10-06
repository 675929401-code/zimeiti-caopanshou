import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

const API_KEY_MASK = '********';

const MODEL_CONFIG_PUBLIC_SELECT = {
  id: true,
  name: true,
  modelId: true,
  resourceId: true,
  totalPrice: true,
  totalChars: true,
  costPrice: true,
  unit: true,
  profitMargin: true,
  isActive: true,
  sort: true,
  createdAt: true,
  updatedAt: true,
} as const;

type SafeModelRecord = {
  id: string;
  name: string;
  modelId: string;
  resourceId: string;
  totalPrice: number;
  totalChars: number;
  costPrice: number;
  unit: string;
  profitMargin: number;
  isActive: boolean;
  sort: number;
  createdAt: Date;
  updatedAt: Date;
};

type ModelConfigPayload = {
  id?: string;
  name?: string;
  modelId?: string;
  resourceId?: string;
  apiKey?: unknown;
  totalPrice?: number;
  totalChars?: number;
  costPrice?: number;
  unit?: string;
  profitMargin?: number;
  isActive?: boolean;
  sort?: number;
};

type ModelConfigUpdateData = {
  apiKey: null;
  name?: string;
  modelId?: string;
  resourceId?: string;
  totalPrice?: number;
  totalChars?: number;
  costPrice?: number;
  unit?: string;
  profitMargin?: number;
  isActive?: boolean;
  sort?: number;
};

function hasServerApiKey(): boolean {
  const value = process.env.VOLCENGINE_API_KEY_1;
  return typeof value === 'string' && value.trim().length > 0;
}

function isApiKeyPlaceholder(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;

  const normalized = value.trim();
  return normalized === '' || normalized === API_KEY_MASK || normalized === '••••••••';
}

// 根据计费单位获取基数（千字符=1000，次=1）
function getUnitMultiplier(unit: string): number {
  if (unit === '千字符' || unit === '千字') return 1000;
  return 1;
}

function computeCostPrice(totalPrice: number, totalChars: number, unit: string): number {
  const multiplier = getUnitMultiplier(unit);
  if (!totalChars || totalChars <= 0 || !totalPrice) return 0.28;
  return Math.round((totalPrice / totalChars) * multiplier * 10000) / 10000;
}

function toSafeModel(model: SafeModelRecord, credentialConfigured: boolean) {
  return {
    ...model,
    // 保留 apiKey 字段以兼容现有管理端，但只返回固定掩码，绝不返回真实凭据。
    apiKey: credentialConfigured ? API_KEY_MASK : '',
    hasApiKey: credentialConfigured,
    configuredIsActive: model.isActive,
    // 服务端环境变量缺失时强制对外呈现为停用，防止误判为可调用。
    isActive: Boolean(model.isActive && credentialConfigured),
    costPrice: model.totalPrice && model.totalChars
      ? computeCostPrice(model.totalPrice, model.totalChars, model.unit)
      : model.costPrice,
  };
}

function missingCredentialResponse() {
  return errorResponse(
    '服务端供应商凭据未配置，模型必须保持停用',
    'MODEL_SECRET_NOT_CONFIGURED',
    503,
  );
}

// GET - 获取所有模型配置
export async function GET() {
  try {
    const credentialConfigured = hasServerApiKey();
    const models = await prisma.modelConfig.findMany({
      orderBy: { sort: 'asc' },
      select: MODEL_CONFIG_PUBLIC_SELECT,
    });

    // 如果没有数据，创建默认预设。凭据缺失时默认保持停用。
    if (models.length === 0) {
      const defaults = [
        { name: '豆包语音合成2.0', modelId: 'seed-tts-2.0', resourceId: 'seed-tts-2.0', totalPrice: 3, totalChars: 10000, costPrice: 0.30, unit: '千字符', profitMargin: 10, sort: 1 },
        { name: '豆包语音合成1.0', modelId: 'seed-tts-1.0', resourceId: 'seed-tts-1.0', totalPrice: 2, totalChars: 10000, costPrice: 0.20, unit: '千字符', profitMargin: 10, sort: 2 },
        { name: '豆包声音复刻2.0', modelId: 'seed-icl-2.0', resourceId: 'seed-icl-2.0', totalPrice: 3, totalChars: 10000, costPrice: 0.30, unit: '千字符', profitMargin: 10, sort: 3 },
        { name: '豆包声音设计', modelId: 'seed-icl-2.0-design', resourceId: 'seed-icl-2.0', totalPrice: 3, totalChars: 10000, costPrice: 0.30, unit: '千字符', profitMargin: 10, sort: 4 },
        { name: '豆包音频生成1.0', modelId: 'seed-audio-1.0', resourceId: 'seed-tts-2.0', totalPrice: 0.54, totalChars: 1, costPrice: 0.54, unit: '分钟', profitMargin: 0, sort: 5 },
      ];

      for (const model of defaults) {
        await prisma.modelConfig.create({
          data: {
            ...model,
            apiKey: null,
            isActive: credentialConfigured,
          },
          select: MODEL_CONFIG_PUBLIC_SELECT,
        });
      }

      const inserted = await prisma.modelConfig.findMany({
        orderBy: { sort: 'asc' },
        select: MODEL_CONFIG_PUBLIC_SELECT,
      });
      return successResponse(
        inserted.map((model: SafeModelRecord) => toSafeModel(model, credentialConfigured)),
        '已自动创建默认模型配置',
      );
    }

    return successResponse(
      models.map((model: SafeModelRecord) => toSafeModel(model, credentialConfigured)),
      '查询成功',
    );
  } catch {
    return errorResponse('查询模型配置失败', 'MODEL_CONFIGS_ERROR', 500);
  }
}

// POST - 创建/更新模型配置。供应商凭据只允许由服务端环境变量提供。
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as ModelConfigPayload;
    const {
      id,
      name,
      modelId,
      resourceId,
      apiKey,
      totalPrice,
      totalChars,
      costPrice,
      unit,
      profitMargin,
      isActive,
      sort,
    } = body;

    if (!isApiKeyPlaceholder(apiKey)) {
      return errorResponse(
        'API 密钥只能通过服务端环境变量配置',
        'MODEL_SECRET_ENV_ONLY',
        400,
      );
    }

    if (name !== undefined && !name.trim()) {
      return errorResponse('名称不能为空', 'VALIDATION_ERROR', 400);
    }
    if (modelId !== undefined && !modelId.trim()) {
      return errorResponse('模型ID不能为空', 'VALIDATION_ERROR', 400);
    }

    const credentialConfigured = hasServerApiKey();
    if (isActive === true && !credentialConfigured) {
      return missingCredentialResponse();
    }

    const computedCost = totalPrice && totalChars
      ? computeCostPrice(totalPrice, totalChars, unit || '千字符')
      : costPrice;

    if (id) {
      const existing = await prisma.modelConfig.findUnique({
        where: { id },
        select: MODEL_CONFIG_PUBLIC_SELECT,
      });
      if (!existing) return errorResponse('模型配置不存在', 'NOT_FOUND', 404);

      const updateData: ModelConfigUpdateData = {
        // 清除该记录中可能遗留的旧密钥；运行时凭据只来自服务端环境变量。
        apiKey: null,
      };
      if (name !== undefined) updateData.name = name;
      if (modelId !== undefined) updateData.modelId = modelId;
      if (resourceId !== undefined) updateData.resourceId = resourceId;
      if (totalPrice !== undefined) updateData.totalPrice = totalPrice;
      if (totalChars !== undefined) updateData.totalChars = totalChars;
      if (costPrice !== undefined) updateData.costPrice = computedCost;
      if (unit !== undefined) updateData.unit = unit;
      if (profitMargin !== undefined) updateData.profitMargin = profitMargin;
      if (sort !== undefined) updateData.sort = sort;

      if (!credentialConfigured) {
        updateData.isActive = false;
      } else if (isActive !== undefined) {
        updateData.isActive = isActive;
      }

      const updated = await prisma.modelConfig.update({
        where: { id },
        data: updateData,
        select: MODEL_CONFIG_PUBLIC_SELECT,
      });
      return successResponse(toSafeModel(updated, credentialConfigured), '更新成功');
    }

    if (!name || !modelId) {
      return errorResponse('名称和模型ID不能为空', 'VALIDATION_ERROR', 400);
    }

    const created = await prisma.modelConfig.create({
      data: {
        name,
        modelId,
        resourceId: resourceId || 'seed-tts-2.0',
        apiKey: null,
        totalPrice: totalPrice ?? 28,
        totalChars: totalChars ?? 100000,
        costPrice: computedCost ?? 0.28,
        unit: unit || '千字符',
        profitMargin: profitMargin ?? 100,
        isActive: credentialConfigured ? (isActive ?? true) : false,
        sort: sort ?? 0,
      },
      select: MODEL_CONFIG_PUBLIC_SELECT,
    });
    return successResponse(toSafeModel(created, credentialConfigured), '创建成功');
  } catch {
    return errorResponse('操作模型配置失败', 'MODEL_CONFIG_ERROR', 500);
  }
}

// DELETE - 删除模型配置
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return errorResponse('缺少ID参数', 'VALIDATION_ERROR', 400);

    const existing = await prisma.modelConfig.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) return errorResponse('模型配置不存在', 'NOT_FOUND', 404);

    await prisma.modelConfig.delete({ where: { id } });
    return successResponse(null, '删除成功');
  } catch {
    return errorResponse('删除模型配置失败', 'MODEL_CONFIG_DELETE_ERROR', 500);
  }
}
