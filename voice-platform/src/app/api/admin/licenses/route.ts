import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

// GET - 列出所有授权密钥
export async function GET(request: NextRequest) {
  try {
    const licenses = await prisma.cloneLicense.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return successResponse({ licenses, total: licenses.length });
  } catch (err: any) {
    return successResponse({ licenses: [], total: 0 });
  }
}

// POST - 生成新密钥（138元/个，15次训练）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { count = 1 } = body;

    const keys = [];
    for (let i = 0; i < count; i++) {
      const licenseKey = `ZY-${Math.random().toString(36).slice(2, 10).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      await prisma.cloneLicense.create({
        data: {
          licenseKey,
          status: 'active',
          maxTrainings: 15,
          usedTrainings: 0,
        },
      });
      keys.push(licenseKey);
    }

    return successResponse({ keys, message: `已生成 ${count} 个授权密钥（138元/个，15次训练）` });
  } catch (err: any) {
    return errorResponse(err.message || '生成失败', 'GENERATE_ERROR', 500);
  }
}
