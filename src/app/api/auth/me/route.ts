import { isUserAccountDisabled } from "@/lib/user-account-status";
import { NextRequest, NextResponse } from "next/server";
import { VALID_THEMES, normalizeThemeModePreference } from "@/lib/themes";
import { authorizeToken, getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { publicAllowedAgentCategoryIds } from "@/lib/agent-category-access";
import {
  clearUserAppearancePreference,
  readUserAppearancePreference,
  saveUserAppearancePreference,
} from "@/lib/server/user-appearance-preference";

type UserRecord = {
  id: string;
  username: string;
  display_name: string;
  phone: string | null;
  email: string | null;
  role: string;
  credits: number;
  credits_reserved: number;
  is_active: boolean;
  session_id?: string | null;
  allowed_categories: string[] | null;
  member_status: string | null;
  member_expires_at?: string | null;
  theme_preference: string | null;
  password_hash: string | null;
  status: string | null;
};

async function findCurrentUser(userId: string): Promise<UserRecord | null> {
  try {
    const client = getSupabaseClient();
    const result = await client
      .from("users")
      .select("id, username, display_name, phone, email, role, credits, credits_reserved, is_active, session_id, allowed_categories, member_status, member_expires_at, theme_preference, password_hash, status")
      .eq("id", userId)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }

    return (result.data as UserRecord | null) || null;
  } catch (error) {
    console.error("[auth/me] Supabase user lookup failed:", error);
    throw error;
  }
}

async function readUserAvatarUrl(userId: string): Promise<string> {
  const result = await getSupabaseClient()
    .from("user_profile_avatars")
    .select("avatar_url")
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error) {
    // Release order remains backward compatible while the additive migration is pending.
    if (!["42P01", "PGRST205"].includes(String(result.error.code || ""))) {
      console.warn("[auth/me] avatar lookup failed:", result.error.code || result.error.message);
    }
    return "";
  }
  return typeof result.data?.avatar_url === "string" ? result.data.avatar_url : "";
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const authorization = await authorizeToken(token);
    if (!authorization.ok) {
      return NextResponse.json(
        { error: authorization.error, code: authorization.code },
        { status: authorization.status },
      );
    }
    const payload = authorization.actor;

    const user = await findCurrentUser(payload.userId);
    if (!user) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    if (user.status === "blocked") {
      return NextResponse.json({ error: "您的账户已被管理员拉黑", code: "USER_BLOCKED" }, { status: 403 });
    }

    if (isUserAccountDisabled(user)) {
      return NextResponse.json({ error: "账户已停用，请联系管理员", code: "USER_DISABLED" }, { status: 403 });
    }

    let effectiveMemberStatus = user.member_status || "inactive";
    if (effectiveMemberStatus === "active" && user.member_expires_at && new Date(user.member_expires_at) < new Date()) {
      effectiveMemberStatus = "expired";
    }

    const [appearance, avatarUrl] = await Promise.all([
      readUserAppearancePreference(user.id, request as unknown as Request),
      readUserAvatarUrl(user.id),
    ]);

    return NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        phone: user.phone || "",
        email: user.email || "",
        avatarUrl,
        role: user.role,
        credits: Math.max(0, Number(user.credits) - Number(user.credits_reserved)),
        reservedCredits: Number(user.credits_reserved),
        is_active: user.is_active,
        allowedCategories: publicAllowedAgentCategoryIds(user.role, user.allowed_categories),
        memberStatus: effectiveMemberStatus,
        themePreference: appearance.preference?.theme || null,
        themeModePreference: appearance.preference?.modePreference || null,
        themePreferenceExpiresAt: appearance.preference?.expiresAt || null,
        themePreferenceStatus: appearance.status,
        hasPassword: !!user.password_hash,
        status: user.status || "active",
      },
    });
  } catch (err) {
    console.error("Get user error:", err);
    return NextResponse.json({ error: "获取用户信息失败" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const authorization = await authorizeToken(token);
    if (!authorization.ok) {
      return NextResponse.json(
        { error: authorization.error, code: authorization.code },
        { status: authorization.status },
      );
    }
    const payload = authorization.actor;

    const currentUser = await findCurrentUser(payload.userId);
    if (!currentUser) return NextResponse.json({ error: "用户不存在" }, { status: 401 });
    if (isUserAccountDisabled(currentUser)) return NextResponse.json({ error: "账户已停用，请联系管理员", code: "USER_DISABLED" }, { status: 403 });

    const body = await request.json();
    const { phone, display_name, theme_preference, theme_mode_preference } = body;

    const client = getSupabaseClient();
    const updates: Record<string, string | null> = {};

    if (phone !== undefined) {
      return NextResponse.json({
        error: "更换手机号必须先完成当前QQ安全邮箱验证",
        code: "PHONE_CHANGE_REQUIRES_EMAIL_VERIFICATION",
      }, { status: 409 });
    }

    if (display_name !== undefined) {
      updates.display_name = display_name;
    }

    const appearanceUpdateRequested = theme_preference !== undefined || theme_mode_preference !== undefined;
    const clearAppearance = appearanceUpdateRequested
      && (theme_preference === null || theme_preference === "")
      && (theme_mode_preference === null || theme_mode_preference === "" || theme_mode_preference === undefined);

    if (appearanceUpdateRequested && !clearAppearance) {
      if (typeof theme_preference !== "string" || !VALID_THEMES.includes(theme_preference)) {
        return NextResponse.json({ error: "主题选项无效" }, { status: 400 });
      }
      if (
        typeof theme_mode_preference !== "string"
        || normalizeThemeModePreference(theme_mode_preference) !== theme_mode_preference
      ) {
        return NextResponse.json({ error: "明暗模式选项无效" }, { status: 400 });
      }
    }

    if (Object.keys(updates).length === 0 && !appearanceUpdateRequested) {
      return NextResponse.json({ error: "没有需要更新的字段" }, { status: 400 });
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await client.from("users").update(updates).eq("id", payload.userId);
      if (error) {
        console.error("Update user error:", error);
        return NextResponse.json({ error: "更新失败" }, { status: 500 });
      }
    }

    let appearancePreference = null;
    if (appearanceUpdateRequested) {
      try {
        if (clearAppearance) {
          await clearUserAppearancePreference(payload.userId);
        } else {
          appearancePreference = await saveUserAppearancePreference(
            payload.userId,
            request as unknown as Request,
            theme_preference,
            theme_mode_preference,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message === "USER_APPEARANCE_PREFERENCE_STORAGE_NOT_READY") {
          return NextResponse.json(
            { error: "主题偏好存储尚未完成升级", code: "THEME_PREFERENCE_STORAGE_NOT_READY" },
            { status: 503 },
          );
        }
        throw error;
      }
    }

    return NextResponse.json({ success: true, appearancePreference });
  } catch (err) {
    console.error("Update user error:", err);
    return NextResponse.json({ error: "更新用户信息失败" }, { status: 500 });
  }
}
