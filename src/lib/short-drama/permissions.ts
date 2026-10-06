import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { normalizeAllowedAgentCategoryIds } from "@/lib/agent-category-access";

export const SHORT_DRAMA_CATEGORY_NAMES = ["影视工坊", "短剧工坊"] as const;

export type ShortDramaDatabase = ReturnType<typeof getSupabaseClient>;

export interface ShortDramaAuthorizationContext {
  userId: string;
  role: string;
  displayName: string;
  memberStatus: string;
  allowedCategoryIds: string[];
  db: ShortDramaDatabase;
}

export interface ShortDramaAuthorizationOptions {
  requireMembership?: boolean;
  requireCategory?: boolean;
  categoryNames?: readonly string[];
}

export class ShortDramaAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShortDramaAccessError";
  }
}

interface UserAccessRow {
  id: string;
  role?: string | null;
  display_name?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  member_status?: string | null;
  member_expires_at?: string | null;
  allowed_categories?: string[] | null;
}

function membershipIsActive(user: UserAccessRow, now: Date): boolean {
  if (user.member_status !== "active") return false;
  if (!user.member_expires_at) return true;
  const expiresAt = new Date(user.member_expires_at);
  return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}

export async function authorizeShortDramaRequest(
  request: Request,
  options: ShortDramaAuthorizationOptions = {},
): Promise<ShortDramaAuthorizationContext> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    throw new ShortDramaAccessError(401, "UNAUTHORIZED", "请先登录");
  }

  const jwt = await verifyToken(token);
  if (!jwt?.userId) {
    throw new ShortDramaAccessError(401, "TOKEN_EXPIRED", "登录已过期，请重新登录");
  }

  let db: ShortDramaDatabase;
  try {
    db = getSupabaseClient();
  } catch {
    throw new ShortDramaAccessError(503, "AUTH_DATABASE_UNAVAILABLE", "用户权限服务暂时不可用");
  }

  const { data, error } = await db
    .from("users")
    .select("id, role, display_name, status, is_active, member_status, member_expires_at, allowed_categories")
    .eq("id", jwt.userId)
    .maybeSingle();

  if (error) {
    throw new ShortDramaAccessError(503, "AUTH_DATABASE_UNAVAILABLE", "用户权限服务暂时不可用");
  }
  if (!data) {
    throw new ShortDramaAccessError(401, "USER_NOT_FOUND", "用户不存在或登录已失效");
  }

  const user = data as UserAccessRow;
  const role = String(user.role || jwt.role || "student");
  const status = String(user.status || "active");

  if (status === "blocked" || status === "suspended" || user.is_active === false) {
    throw new ShortDramaAccessError(403, "USER_BLOCKED", "账户当前不可使用影视工坊");
  }

  const isAdmin = role === "admin";
  const requireMembership = options.requireMembership !== false;
  if (!isAdmin && requireMembership && !membershipIsActive(user, new Date())) {
    throw new ShortDramaAccessError(403, "MEMBERSHIP_REQUIRED", "需要有效会员才能使用影视工坊");
  }

  const allowedCategoryIds = normalizeAllowedAgentCategoryIds(user.allowed_categories);
  // The Manju Film Studio is an independent member workspace. Marketplace
  // category grants control Agent/category visibility and must not silently
  // lock an active member out of their own projects. Category-scoped callers
  // can still opt in explicitly when they expose category-owned content.
  const requireCategory = options.requireCategory === true;
  const categoryNames = options.categoryNames || SHORT_DRAMA_CATEGORY_NAMES;

  if (!isAdmin && requireCategory) {
    const directNameMatch = categoryNames.some((name) => allowedCategoryIds.includes(name));
    if (!directNameMatch) {
      const { data: categories, error: categoryError } = await db
        .from("categories")
        .select("id, name, visibility")
        .in("name", [...categoryNames]);

      if (categoryError) {
        throw new ShortDramaAccessError(503, "CATEGORY_DATABASE_UNAVAILABLE", "分类权限服务暂时不可用");
      }

      const allowed = ((categories || []) as Array<{ id: string; name: string; visibility?: string | null }>).some(
        (category) => category.visibility !== "view_only" && allowedCategoryIds.includes(String(category.id)),
      );
      if (!allowed) {
        throw new ShortDramaAccessError(403, "CATEGORY_ACCESS_DENIED", "您暂无影视工坊的使用权限");
      }
    }
  }

  return {
    userId: String(user.id),
    role,
    displayName: String(user.display_name || jwt.displayName || ""),
    memberStatus: isAdmin ? "admin" : String(user.member_status || "inactive"),
    allowedCategoryIds,
    db,
  };
}
