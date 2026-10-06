/**
 * Prisma 占位 — 主站使用 Supabase，voice-platform 的 Prisma 已废弃。
 * 保留此文件以避免 import 报错；实际 DB 操作走 Supabase。
 */
export const prisma = {
  apiConfig: {
    findFirst: async () => null,
  },
  voice: {
    findMany: async () => [],
    count: async () => 0,
    upsert: async () => null,
  },
  $disconnect: async () => {},
} as any;
