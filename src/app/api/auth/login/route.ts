import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { createToken, verifyPassword } from "@/lib/auth";
import { logSecurityEvent } from "@/lib/security";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { issueUserAuthSession } from "@/lib/auth-session-store";
import { publicAllowedAgentCategoryIds } from "@/lib/agent-category-access";
import { readUserAppearancePreference } from "@/lib/server/user-appearance-preference";
import { getAuthSessionClientIP } from "@/lib/auth-session-client-ip";

interface UserRow {
  id: string;
  username: string;
  password_hash: string | null;
  display_name: string;
  phone: string | null;
  email: string | null;
  role: string;
  credits: number;
  is_active: boolean;
  status: string | null;
  allowed_categories: string[] | null;
  member_status: string | null;
}

function hashIP(ip: string): string {
  return createHash("sha256")
    .update(ip + (process.env.SECURITY_INTERNAL_KEY?.trim() || process.env.JWT_SECRET?.trim() || ''))
    .digest("hex")
    .substring(0, 16);
}

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

function hashUserAgent(userAgent: string): string {
  return createHash("sha256").update(userAgent).digest("hex").substring(0, 32);
}

async function writeLoginLog(params: {
  userId: string;
  username: string;
  displayName: string;
  ip: string;
  userAgent: string;
  method: string;
  status: "success" | "failed";
  failReason?: string;
}) {
  try {
    const client = getSupabaseClient();
    await client.from("login_logs").insert({
      user_id: params.userId,
      username: params.username,
      display_name: params.displayName,
      ip_address: params.ip,
      user_agent: params.userAgent,
      login_method: params.method,
      status: params.status,
      fail_reason: params.failReason || null,
    });
  } catch (err) {
    console.error("[auth/login] Write login log error:", err);
  }
}

async function findSupabaseUserByInput(input: string): Promise<UserRow | null> {
  const client = getSupabaseClient();
  const selectFields =
    "id, username, password_hash, display_name, phone, email, role, credits, is_active, status, allowed_categories, member_status";

  const queryByField = async (field: "phone" | "username" | "email") => {
    const result = await client
      .from("users")
      .select(selectFields)
      .eq(field, input)
      .maybeSingle();

    if (result.error) throw result.error;
    return (result.data as UserRow | null) || null;
  };

  return (
    (await queryByField("phone")) ||
    (await queryByField("username")) ||
    (input.includes("@") ? await queryByField("email") : null)
  );
}

async function rejectLogin(params: {
  input: string;
  clientIP: string;
  userAgent: string;
  user?: UserRow;
  reason: string;
  status?: number;
  code?: string;
}) {
  await writeLoginLog({
    userId: params.user?.id || "unknown",
    username: params.user?.username || params.input,
    displayName: params.user?.display_name || "",
    ip: params.clientIP,
    userAgent: params.userAgent,
    method: "password",
    status: "failed",
    failReason: params.reason,
  });

  await logSecurityEvent({
    event_type: "suspicious_behavior",
    risk_level: "low",
    ip: params.clientIP,
    user_id: params.user?.id,
    username: params.user?.username,
    display_name: params.user?.display_name,
    user_agent: params.userAgent,
    path: "/api/auth/login",
    method: "POST",
    details: `Login failed: ${params.reason}; input=${params.input}`,
    blocked: false,
    source: "api_direct",
    phone: params.user?.phone || params.input,
  });

  return NextResponse.json(
    {
      error: params.reason,
      ...(params.code ? { code: params.code } : {}),
    },
    { status: params.status || 401 }
  );
}

export async function POST(request: NextRequest) {
  const clientIP = getAuthSessionClientIP(request);
  if (!clientIP) {
    return NextResponse.json(
      { error: "登录入口暂未获得可信网络地址，请稍后重试", code: "CLIENT_IP_UNAVAILABLE" },
      { status: 503 },
    );
  }
  const userAgent = request.headers.get("user-agent") || "unknown";

  try {
    const body = await request.json();
    const password = body.password as string | undefined;
    const loginInput = (body.phone || body.username) as string | undefined;
    // 勾选“记住登录”时签发 30 天会话：到期前打开站点无需再次输入密码。
    const remember = body.remember === true;
    const sessionTtlDays = remember ? 30 : 3;

    if (!loginInput || !password) {
      return NextResponse.json({ error: "请输入账号和密码" }, { status: 400 });
    }

    const input = loginInput.trim();
    const client = getSupabaseClient();
    let user: UserRow | null;

    try {
      user = await findSupabaseUserByInput(input);
    } catch (error) {
      console.error("[auth/login] Supabase lookup failed:", error);
      return NextResponse.json(
        { error: "账号数据暂时无法访问，请稍后重试", code: "AUTH_DATABASE_UNAVAILABLE" },
        { status: 503 }
      );
    }

    if (!user) {
      return rejectLogin({
        input,
        clientIP,
        userAgent,
        reason: "账号或密码不正确",
      });
    }

    const userStatus = user.status || (user.is_active ? "active" : "blocked");
    if (userStatus === "blocked") {
      return rejectLogin({
        input,
        clientIP,
        userAgent,
        user,
        reason: "账号已被拉黑，禁止登录，请联系管理员",
        status: 403,
      });
    }

    if (userStatus === "suspended") {
      return rejectLogin({
        input,
        clientIP,
        userAgent,
        user,
        reason: "账号已被暂停，请联系管理员",
        status: 403,
      });
    }

    if (!user.is_active || userStatus !== "active") {
      return rejectLogin({
        input,
        clientIP,
        userAgent,
        user,
        reason: "账号已被禁用，请联系管理员",
        status: 403,
      });
    }

    if (!user.password_hash) {
      return rejectLogin({
        input,
        clientIP,
        userAgent,
        user,
        reason: "该账号未设置密码，请使用其他登录方式或联系管理员",
        code: "NO_PASSWORD_SET",
      });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return rejectLogin({
        input,
        clientIP,
        userAgent,
        user,
        reason: "账号或密码不正确",
      });
    }

    const sessionId = generateSessionId();
    const sessionUpdate = await issueUserAuthSession(client, {
      userId: user.id,
      sessionId,
      ipHash: hashIP(clientIP),
      userAgentHash: hashUserAgent(userAgent),
      expiresAt: new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (!sessionUpdate.ok) {
      console.error("[auth/login] Current session could not be persisted");
      return NextResponse.json(
        { error: "登录会话创建失败，请稍后重试", code: "SESSION_PERSIST_FAILED" },
        { status: 503 },
      );
    }

    const token = await createToken({
      userId: user.id,
      username: user.username,
      role: user.role as "student" | "admin",
      displayName: user.display_name,
      ipHash: hashIP(clientIP),
      sessionId,
    }, { expiresIn: `${sessionTtlDays}d` });

    void writeLoginLog({
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      ip: clientIP,
      userAgent,
      method: "password",
      status: "success",
    });

    let appearance = { preference: null, status: "storage_unavailable" } as Awaited<ReturnType<typeof readUserAppearancePreference>>;
    try {
      appearance = await readUserAppearancePreference(user.id, request as unknown as Request);
    } catch {
      // 登录成功不应被非关键外观偏好读取阻断；客户端随后仍会通过
      // /api/auth/me 重新验证租约。
      console.warn("[auth/login] User appearance preference could not be read");
    }

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        phone: user.phone || "",
        email: user.email || "",
        role: user.role,
        credits: user.credits,
        allowedCategories: publicAllowedAgentCategoryIds(user.role, user.allowed_categories),
        memberStatus: user.member_status || "inactive",
        themePreference: appearance.preference?.theme || null,
        themeModePreference: appearance.preference?.modePreference || null,
        themePreferenceExpiresAt: appearance.preference?.expiresAt || null,
        themePreferenceStatus: appearance.status,
        hasPassword: !!user.password_hash,
      },
      token,
    });

    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" && request.nextUrl.protocol === "https:",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * sessionTtlDays,
      path: "/",
    });

    return response;
  } catch (err) {
    console.error("[auth/login] Login error:", err);
    return NextResponse.json({ error: "登录失败，请稍后重试" }, { status: 500 });
  }
}
