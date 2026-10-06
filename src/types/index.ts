/**
 * 类型 barrel 导出层
 *
 * 用途：新代码 import from '@/types' 即可，无需知道具体文件。
 * 老代码 import from '@/types/coze' 继续生效，不受影响。
 *
 * 新增类型时：
 *   - 认证相关 → src/types/auth.ts
 *   - 视频相关 → src/types/video.ts
 *   - 计费相关 → src/types/billing.ts
 *   - 通用/杂项 → 仍可放 coze.ts
 *   然后在此文件追加 re-export
 */

// 老类型 — 原路径继续可用
export * from './coze';
