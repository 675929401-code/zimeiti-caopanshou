/**
 * 共享 API 鉴权中间件
 * 消除所有 route 中重复的 JWT 验证 + Supabase 客户端初始化代码
 *
 * 用法：
 *   import { withAuth, withAdminAuth, getSupabase } from "@/lib/api-middleware";
 *
 *   // 需要登录的接口
 *   export async function GET(req: Request) {
 *     return withAuth(req, async (user, supabase) => {
 *       // user: { id, email, role, ... }
 *       // supabase: 已初始化的 Supabase 客户端
 *     });
 *   }
 *
 *   // 仅管理员可访问
 *   export async function POST(req: Request) {
 *     return withAdminAuth(req, async (user, supabase) => {
 *       // 非管理员自动返回 403
 *     });
 *   }
 */

import { isUserAccountDisabled } from "@/lib/user-account-status";
import { createClient } from "@supabase/supabase-js";
import { authorizeToken } from "@/lib/auth";
import { getTokenFromHeaders } from "@/lib/auth";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { NextResponse } from "next/server";
import { publicAllowedAgentCategoryIds } from "@/lib/agent-category-access";

// ============================================================
// 类型定义
// ============================================================

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  displayName?: string;
  memberStatus?: string;
  credits?: number;
  cashBalance?: number;
  allowedCategories?: string[] | null;
}

interface DbUser {
  id: string;
  email: string;
  role: string;
  display_name: string | null;
  member_status: string | null;
  credits: number;
  cash_balance: number;
  allowed_categories: string[] | null;
  status: string;
  is_active: boolean;
}

export type ApiHandler = (
  user: AuthUser,
  supabase: ReturnType<typeof createClient>,
  req: Request
) => Promise<Response>;

// ============================================================
// Supabase 客户端（懒初始化 + 缓存）
// ============================================================

let _supabaseClient: ReturnType<typeof createClient> | null = null;

export function getSupabase(): ReturnType<typeof createClient> {
  if (_supabaseClient) return _supabaseClient;

  const url = process.env.COZE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!url || !key) {
    throw new Error("[api-middleware] Supabase 配置缺失: COZE_SUPABASE_URL / COZE_SUPABASE_SERVICE_ROLE_KEY");
  }

  _supabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _supabaseClient;
}

// ============================================================
// JWT 解析
// ============================================================

type ParsedJwtResult =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 401 | 403 | 503; code: string; error: string };

async function parseJwtFromRequest(req: Request): Promise<ParsedJwtResult> {
  try {
    const authHeader = req.headers.get("authorization");
    let token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      const cookie = req.headers.get("cookie") || "";
      const match = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
      token = match ? decodeURIComponent(match[1]) : "";
    }
    if (!token) return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "请先登录" };

    const authorization = await authorizeToken(token);
    if (!authorization.ok) return authorization;
    const payload = authorization.actor;

    return { ok: true, user: {
        id: payload.userId,
        email: payload.username,
        role: payload.role || "user",
        displayName: payload.displayName,
      } };
  } catch {
    return { ok: false, status: 503, code: "AUTH_AUTHORITY_UNAVAILABLE", error: "登录状态校验暂不可用，请稍后重试" };
  }
}

// ============================================================
// 核心鉴权包装器
// ============================================================

/**
 * 需要登录的接口鉴权
 * 自动解析 JWT → 查数据库获取完整用户信息 → 传入 handler
 */
export async function withAuth(
  req: Request,
  handler: ApiHandler
): Promise<Response> {
  const parsed = await parseJwtFromRequest(req);

  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, code: parsed.code },
      { status: parsed.status }
    );
  }
  const jwtUser = parsed.user;

  const supabase = getSupabase();

  // 从数据库获取完整用户信息（角色、积分、权限等）
  const { data: dbUser, error: dbError } = await supabase
    .from("users")
    .select("id, email, role, display_name, member_status, credits, cash_balance, allowed_categories, status, is_active")
    .eq("id", jwtUser.id)
    .single<DbUser>();

  if (dbError || !dbUser) {
    console.error("[api-middleware] 用户查询失败:", dbError?.message);
    return NextResponse.json(
      { error: dbError ? "账户服务暂不可用，请稍后重试" : "用户不存在", code: dbError ? "AUTH_AUTHORITY_UNAVAILABLE" : "UNAUTHENTICATED" },
      { status: dbError ? 503 : 401 }
    );
  }

  // 检查用户状态
  if (isUserAccountDisabled(dbUser)) {
    return NextResponse.json(
      { error: "账户已停用，请联系管理员", code: "USER_DISABLED" },
      { status: 403 }
    );
  }

  const user: AuthUser = {
    id: dbUser.id,
    email: dbUser.email,
    role: dbUser.role || "user",
    displayName: dbUser.display_name || jwtUser.displayName,
    memberStatus: dbUser.member_status ?? undefined,
    credits: dbUser.credits,
    cashBalance: dbUser.cash_balance,
    allowedCategories: publicAllowedAgentCategoryIds(dbUser.role, dbUser.allowed_categories),
  };

  return handler(user, supabase, req);
}

/**
 * 仅管理员可访问的接口鉴权
 * 非管理员自动返回 403
 */
export async function withAdminAuth(
  req: Request,
  handler: ApiHandler
): Promise<Response> {
  const authorization = await authorizeAdminToken(getTokenFromHeaders(req.headers));
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error, code: authorization.code },
      { status: authorization.status }
    );
  }
  const { user: dbUser, actor } = authorization;
  let supabase: ReturnType<typeof createClient>;
  try {
    supabase = getSupabase();
  } catch {
    return NextResponse.json(
      { error: "管理员服务暂不可用，请稍后重试", code: "ADMIN_AUTH_UNAVAILABLE" },
      { status: 503 }
    );
  }
  // Use the same database row already checked above, not a second user lookup.
  return handler({
    id: dbUser.id,
    email: dbUser.email || actor.username,
    role: "admin",
    displayName: dbUser.display_name || actor.displayName,
    memberStatus: dbUser.member_status ?? undefined,
    credits: dbUser.credits,
    cashBalance: dbUser.cash_balance,
    allowedCategories: publicAllowedAgentCategoryIds("admin", dbUser.allowed_categories),
  }, supabase, req);
}

/**
 * 可选鉴权：有 Token 则解析用户，无 Token 则以匿名用户继续
 */
export async function withOptionalAuth(
  req: Request,
  handler: (user: AuthUser | null, supabase: ReturnType<typeof createClient>, req: Request) => Promise<Response>
): Promise<Response> {
  const parsed = await parseJwtFromRequest(req);
  const supabase = getSupabase();

  if (!parsed.ok) {
    return handler(null, supabase, req);
  }
  const jwtUser = parsed.user;

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, email, role, display_name, member_status, credits, cash_balance, allowed_categories, status, is_active")
    .eq("id", jwtUser.id)
    .single<DbUser>();

  if (!dbUser || isUserAccountDisabled(dbUser)) {
    return handler(null, supabase, req);
  }

  const user: AuthUser = {
    id: dbUser.id,
    email: dbUser.email,
    role: dbUser.role || "user",
    displayName: dbUser.display_name ?? undefined,
    memberStatus: dbUser.member_status ?? undefined,
    credits: dbUser.credits,
    cashBalance: dbUser.cash_balance,
    allowedCategories: publicAllowedAgentCategoryIds(dbUser.role, dbUser.allowed_categories),
  };

  return handler(user, supabase, req);
}
