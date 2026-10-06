import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

// GET - 获取定价配置（全局唯一一条）
export async function GET(request: NextRequest) {
  try {
    const pricing = await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(
      `SELECT * FROM PricingConfig LIMIT 1`
    );

    if (pricing.length === 0) {
      // 返回默认值
      return successResponse({
        ttsCostPer1k: 0.5,
        profitMargin: 100,
        cloneCost: 5,
        designCost: 5,
      });
    }

    return successResponse(pricing[0]);
  } catch {
    // 表可能不存在，返回默认值
    return successResponse({
      ttsCostPer1k: 0.5,
      profitMargin: 100,
      cloneCost: 5,
      designCost: 5,
    });
  }
}

// POST - 更新定价配置
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ttsCostPer1k, profitMargin, cloneCost, designCost } = body;

    // 确保表存在
    await ensureTable();

    // 检查是否已有记录
    const existing = await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(
      `SELECT id FROM PricingConfig LIMIT 1`
    );

    if (existing.length > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE PricingConfig SET ttsCostPer1k=?, profitMargin=?, cloneCost=?, designCost=?, updatedAt=datetime('now')`,
        ttsCostPer1k ?? 0.5,
        profitMargin ?? 100,
        cloneCost ?? 5,
        designCost ?? 5
      );
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO PricingConfig (id, ttsCostPer1k, profitMargin, cloneCost, designCost, createdAt, updatedAt) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`,
        'default',
        ttsCostPer1k ?? 0.5,
        profitMargin ?? 100,
        cloneCost ?? 5,
        designCost ?? 5
      );
    }

    return successResponse({ message: '定价已更新' });
  } catch (err: any) {
    return errorResponse(err.message || '更新失败', 'UPDATE_ERROR', 500);
  }
}

async function ensureTable() {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS PricingConfig (
        id TEXT PRIMARY KEY,
        ttsCostPer1k REAL NOT NULL DEFAULT 0.5,
        profitMargin REAL NOT NULL DEFAULT 100,
        cloneCost REAL NOT NULL DEFAULT 5,
        designCost REAL NOT NULL DEFAULT 5,
        createdAt TEXT,
        updatedAt TEXT
      )
    `);
  } catch { /* ignore */ }
}
