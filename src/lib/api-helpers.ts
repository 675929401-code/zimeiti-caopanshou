/**
 * API 统一响应与错误处理工具
 *
 * 🔒 增量加固模块 — 纯新增，不改任何现有代码
 *
 * 解决的问题：
 * 1. 79个路由各自手写 requireAdmin + verifyToken — 重复且容易遗漏用户状态检查
 * 2. 错误响应格式不统一 — 有的 {error} 有的 {success:false, message}
 * 3. try/catch 错误处理不统一 — 有的吞错误，有的暴露堆栈
 *
 * 用法（新路由使用，老路由不动）：
 *   import { withAuth, withAdminAuth, apiSuccess, apiError, getSupabase } from "@/lib/api-middleware";
 *
 *   export async function GET(req: Request) {
 *     return withAuth(req, async (user, supabase) => {
 *       const { data, error } = await supabase.from("table").select("*");
 *       if (error) return apiError("查询失败", 500);
 *       return apiSuccess(data);
 *     });
 *   }
 */

import { NextResponse } from "next/server";
import {
  withAuth as _withAuth,
  withAdminAuth as _withAdminAuth,
  withOptionalAuth as _withOptionalAuth,
  getSupabase as _getSupabase,
  type AuthUser,
  type ApiHandler,
} from "@/lib/api-middleware";

// ============================================================
// 重新导出 api-middleware 的所有内容（统一入口）
// ============================================================

export { _withAuth as withAuth, _withAdminAuth as withAdminAuth, _withOptionalAuth as withOptionalAuth, _getSupabase as getSupabase };
export type { AuthUser, ApiHandler };

// ============================================================
// 统一响应格式
// ============================================================

/** 成功响应 — 统一格式 { success: true, data } */
export function apiSuccess<T>(data: T, status = 200): Response {
  return NextResponse.json({ success: true, data }, { status });
}

/** 错误响应 — 统一格式 { success: false, error } */
export function apiError(message: string, status = 400): Response {
  return NextResponse.json({ success: false, error: message }, { status });
}

/** 分页响应 — 统一格式 { success: true, data, pagination } */
export function apiPaginated<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number
): Response {
  return NextResponse.json({
    success: true,
    data,
    pagination: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}

// ============================================================
// 安全增强的鉴权包装器
// ============================================================

/**
 * 带自动错误捕获的 withAuth
 * - 自动包裹 try/catch，未处理异常不会泄露堆栈
 * - 自动检查用户状态（suspended/blocked）
 *
 * 原有 withAuth 已包含状态检查，此版本额外加了全局错误兜底
 */
export async function withSafeAuth(
  req: Request,
  handler: ApiHandler
): Promise<Response> {
  try {
    return await _withAuth(req, handler);
  } catch (err) {
    console.error("[api-helpers] withSafeAuth 未捕获异常:", err);
    return apiError("服务器内部错误，请稍后重试", 500);
  }
}

/**
 * 带自动错误捕获的 withAdminAuth
 */
export async function withSafeAdminAuth(
  req: Request,
  handler: ApiHandler
): Promise<Response> {
  try {
    return await _withAdminAuth(req, handler);
  } catch (err) {
    console.error("[api-helpers] withSafeAdminAuth 未捕获异常:", err);
    return apiError("服务器内部错误，请稍后重试", 500);
  }
}

// ============================================================
// 常用响应快捷方式
// ============================================================

/** 401 未登录 */
export function apiUnauthorized(msg = "未登录或登录已过期"): Response {
  return apiError(msg, 401);
}

/** 403 无权限 */
export function apiForbidden(msg = "无访问权限"): Response {
  return apiError(msg, 403);
}

/** 404 未找到 */
export function apiNotFound(msg = "资源不存在"): Response {
  return apiError(msg, 404);
}

/** 429 限流 */
export function apiRateLimited(msg = "请求过于频繁，请稍后再试"): Response {
  return apiError(msg, 429);
}
