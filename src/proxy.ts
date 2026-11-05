/**
 * 🔒 核心底层代码 — 锁定保护
 * 
 * 本文件是 Next.js 安全请求代理，负责全局请求安全防护。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "核心底层代码保护规则" 章节。
 * 
 * 锁定范围：整个文件
 * 锁定原因：安全防护核心 + SSE 防缓冲头注入 + 限流策略
 */

/**
 * Next.js 安全 Proxy — 全局请求安全防护
 *
 * 核心原则：检测到风险行为 → 立即拦截 + 记录完整身份信息
 *
 * 功能：
 * 1. 全局API限流（IP+路由滑动窗口）→ 触发即拦截
 * 2. 爬虫/自动化工具检测 → 非浏览器一律拦截
 * 3. 可疑请求模式检测（SQL注入/XSS/路径遍历）→ 检测即拦截
 * 4. 安全响应头注入
 * 5. 用户身份自动识别（JWT解码 + 来源入口标记）
 *
 * 注意：Proxy 运行在 Node.js Runtime，不能直接写数据库。
 * 安全事件通过异步 fetch 调用内部 API 记录。
 */

import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { getTokenFromHeaders, verifyTokenSignature } from "@/lib/auth";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { ADMIN_LOGIN_PATH, isAdminLoginPath } from "@/lib/admin-entry";
import { featurePermissionForApiPath, featurePermissionForPath } from "@/lib/member-permissions";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { adminRequirementForRequest } from "@/lib/admin-governance";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { resolveDisplayBrand } from "@/lib/server/white-label-runtime";
import {
  WhiteLabelHostError,
  isPlatformDisplayHost,
  normalizeDirectHostHeader,
} from "@/lib/white-label-host";
import {
  scheduleSecurityEventDelivery,
  type SecurityEventProducerPayload,
} from "@/lib/server/security-event-producer";
import {
  checkRateLimit,
  detectBot,
  detectSuspiciousRequest,
  detectSource,
  extractUserIdentity,
  getClientIP,
  getUserAgent,
  getSecurityHeadersForHost,
  trackIPSecurityEvent,
  validateBrowserWriteSource,
  type SecurityEventType,
  type RiskLevel,
} from "@/lib/security-edge";

/** 精确白名单路径 — 不执行安全检测 */
const EXACT_WHITELIST_PATHS = [
  "/favicon.ico",
  "/robots.txt",
  "/api/health",
  "/api/version",
  "/api/auth/me",               // 健康检查探活路径，避免每分钟产生 bot_detected 噪音
  "/api/auth/dev-session",      // 仅开发环境 + 本机工作台可用的临时会话
  "/api/admin/security-events/internal", // 避免递归
  "/api/payment/notify",        // 支付回调由支付平台服务器发起，无浏览器UA，需跳过爬虫/限流检测
  "/api/client-error-report",   // 客户端错误上报，需优先放行
];

const WHITELIST_PATH_PREFIXES = ["/_next/"];

function isWhitelistedPath(pathname: string): boolean {
  return EXACT_WHITELIST_PATHS.includes(pathname)
    || WHITELIST_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** 纯静态资源路径（只加安全头，不检测） */
const STATIC_EXTENSIONS = [".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".map"];

const READ_ONLY_ALLOWED_WRITE_PATHS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
];

const BROWSER_ONLY_WRITE_PATHS = [
  "/api/auth/register",
  "/api/auth/register/send-code",
  "/api/auth/send-email-code",
  "/api/payment/create",
  "/api/cami",
  "/api/image/generate",
  "/api/video/generate",
  "/api/llm",
  "/api/chat",
];

function isBrowserOnlyWritePath(pathname: string, method: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false;
  return BROWSER_ONLY_WRITE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * 通过 waitUntil 承载有界重试，避免响应返回时终止投递任务。
 * 生产者只接受 SECURITY_INTERNAL_KEY；缺失或内部接收端未给出耐久回执时失败关闭并写入安全日志。
 */
function recordSecurityEvent(
  lifecycle: NextFetchEvent | undefined,
  event: SecurityEventProducerPayload,
): void {
  scheduleSecurityEventDelivery(lifecycle, event);
}

export async function proxy(request: NextRequest, lifecycle?: NextFetchEvent) {
  const { pathname, search } = request.nextUrl;
  const method = request.method;

  // Host selects the public display brand only. It must never be copied into a
  // business tenant/session/permission claim. Platform-owned names are an
  // explicit allowlist; every other direct Host must resolve to an immutable
  // published white-label release before even a whitelist path is released.
  // X-Forwarded-Host is intentionally ignored because there is no trusted-hop
  // contract at this application boundary.
  try {
    const directHost = request.headers.get("host");
    const hostname = normalizeDirectHostHeader(directHost);
    if (!isPlatformDisplayHost(hostname)) await resolveDisplayBrand(directHost);
  } catch (error) {
    const hostError = error instanceof WhiteLabelHostError
      ? error
      : new WhiteLabelHostError("白标品牌运行态暂不可读取", "WHITE_LABEL_RUNTIME_UNAVAILABLE", 503);
    const response = NextResponse.json(
      {
        error: hostError.status === 421
          ? "该域名未登记或尚未发布"
          : hostError.status === 400
            ? "Host 格式无效"
            : "品牌服务暂不可用",
        code: hostError.code,
      },
      {
        status: hostError.status,
        headers: { "Cache-Control": "private, no-store", Vary: "Host" },
      },
    );
    applySecurityHeaders(response, request);
    return response;
  }

  // ── 1. 白名单路径直接放行（加安全头） ──
  if (isWhitelistedPath(pathname)) {
    const response = NextResponse.next();
    applySecurityHeaders(response, request);
    return response;
  }

  // ── 2. 静态资源只加安全头 ──
  if (STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext))) {
    const response = NextResponse.next();
    applySecurityHeaders(response, request);
    return response;
  }

  if (
    process.env.DEV_READ_ONLY_MODE === "1" &&
    pathname.startsWith("/api/") &&
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    !READ_ONLY_ALLOWED_WRITE_PATHS.some((p) => pathname.startsWith(p))
  ) {
    const response = NextResponse.json(
      { error: "本地只读调试模式已开启，禁止写入线上业务数据", code: "DEV_READ_ONLY_MODE" },
      { status: 403 },
    );
    applySecurityHeaders(response, request);
    return response;
  }

  const ip = getClientIP(request as unknown as Request);
  const userAgent = getUserAgent(request as unknown as Request);

  // ── 提取请求身份信息（来源入口 + 学员身份） ──
  const source = detectSource(request as unknown as Request);
  // Proxy only annotates security telemetry. Authoritative session and role
  // checks happen inside each protected route, where the database is available.
  const identity = await extractUserIdentity(request as unknown as Request, verifyTokenSignature);

  // ── 管理后台页面服务端门禁 ──
  // The URL itself is not a secret. What must remain secret is the rendered
  // console and its data. Anonymous, member, disabled and revoked sessions are
  // redirected before the admin React tree is rendered; every API still has
  // the independent capability gate below.
  const protectedAdminPage = (pathname === "/admin" || pathname.startsWith("/admin/"))
    && !isAdminLoginPath(pathname);
  if (protectedAdminPage) {
    const suppliedToken = getTokenFromHeaders(request.headers);
    const administrator = await authorizeAdminToken(suppliedToken);
    if (!administrator.ok) {
      if (suppliedToken) {
        recordSecurityEvent(lifecycle, {
          event_type: "unauthorized_access",
          risk_level: "medium",
          ip,
          user_agent: userAgent,
          path: pathname,
          method,
          details: `后台页面身份校验拒绝: ${administrator.code}`,
          blocked: true,
          source,
          user_id: identity.userId,
          username: identity.username,
          display_name: identity.displayName,
          phone: identity.phone,
        });
      }
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = ADMIN_LOGIN_PATH;
      loginUrl.search = "";
      loginUrl.searchParams.set("redirect", `${pathname}${search}`);
      const response = NextResponse.redirect(loginUrl);
      response.headers.set("Vary", "Cookie, Authorization");
      applySecurityHeaders(response, request);
      return response;
    }
  }

  // Resolve management-control-plane routes before the member feature gate.
  // Some control-plane endpoints intentionally live outside /api/admin (for
  // example video channel health). They must be governed by the administrator
  // capability contract and must never leak a member feature key first.
  const adminRequirement = adminRequirementForRequest(pathname, method, request.nextUrl.searchParams);

  // ── 会员业务功能权限 ──
  // Navigation hiding is presentation only.  Every protected business API is
  // checked again against the durable, checksummed database snapshot.  Missing,
  // corrupt or unavailable authority fails closed. Administrator role keeps
  // management-console authority, while product features use the same durable
  // per-account grant path as every other authenticated account.
  const requiredFeature = !adminRequirement && pathname.startsWith("/api/")
    ? featurePermissionForApiPath(pathname)
    : null;
  if (requiredFeature && identity.userId) {
    const permission = await readMemberPermissionSnapshot(identity.userId, { knownRole: identity.role });
    const authorityReady = permission.authorityStatus === "ready";
    if (!authorityReady || !permission.featureNavigationKeys.includes(requiredFeature)) {
      const authorityFailure = !authorityReady;
      const response = NextResponse.json(
        authorityFailure
          ? {
              error: "会员权限校验暂不可用，本次未放行受限功能",
              code: permission.authorityStatus === "invalid"
                ? "MEMBER_PERMISSION_INTEGRITY_INVALID"
                : "MEMBER_PERMISSION_AUTHORITY_UNAVAILABLE",
            }
          : {
              error: "当前会员未开通此功能",
              code: "MEMBER_FEATURE_ACCESS_DENIED",
              requiredFeature,
            },
        { status: authorityFailure ? 503 : 403 },
      );
      applySecurityHeaders(response, request);
      return response;
    }
  }

  // ── 会员业务功能：页面级服务端门禁 ──
  // Client navigation is presentation only. Direct URL entry must resolve the
  // same durable snapshot as the API gate; denied or unavailable authority is
  // redirected before the page shell renders business content.
  const requiredPageFeature = !pathname.startsWith("/api/")
    ? featurePermissionForPath(pathname)
    : null;
  if (requiredPageFeature && identity.userId) {
    const pagePermission = await readMemberPermissionSnapshot(identity.userId, { knownRole: identity.role });
    if (pagePermission.authorityStatus !== "ready"
      || !pagePermission.featureNavigationKeys.includes(requiredPageFeature)) {
      const deniedUrl = request.nextUrl.clone();
      deniedUrl.pathname = "/";
      deniedUrl.search = "";
      deniedUrl.searchParams.set("featureDenied", requiredPageFeature);
      const response = NextResponse.redirect(deniedUrl);
      response.headers.set("Vary", "Cookie, Authorization");
      applySecurityHeaders(response, request);
      return response;
    }
  }

  // ── 后台管理员权限与敏感操作二次解锁 ──
  // The management UI is presentation only. Every backend request is mapped
  // to a stable database permission key, and sensitive writes additionally
  // require a short-lived password-confirmed HttpOnly session. Unknown admin
  // endpoints fail closed for ordinary administrators.
  if (adminRequirement) {
    const capability = await authorizeAdminCapability(
      request,
      adminRequirement.permission,
      {
        requireStepUp: adminRequirement.requireStepUp,
        operation: adminRequirement.operation,
      },
    );
    if (!capability.ok) {
      applySecurityHeaders(capability.response, request);
      return capability.response;
    }
  }

  // ── 3. IP 自动封锁检查 — 已禁用 ──
  // 密码错误不应锁定用户，不限制 IP
  // 原逻辑：3次严重/5次高风险事件自动封1小时，影响正常用户登录
  // 如需重新启用，取消下方注释：
  // if (pathname.startsWith("/api/")) {
  //   const banStatus = isIPBanned(ip);
  //   if (banStatus.banned) {
  //     recordSecurityEvent(lifecycle, {
  //       event_type: "suspicious_behavior",
  //       risk_level: "critical",
  //       ip,
  //       user_agent: userAgent,
  //       path: pathname,
  //       method,
  //       details: `已封锁IP尝试访问: ${banStatus.reason}`,
  //       blocked: true,
  //       source,
  //       user_id: identity.userId,
  //       username: identity.username,
  //       display_name: identity.displayName,
  //       phone: identity.phone,
  //     });
  //
  //     const response = NextResponse.json(
  //       { error: `访问已被限制，请${banStatus.banMinutes}分钟后再试`, code: "IP_BANNED" },
  //       { status: 403 },
  //     );
  //     applySecurityHeaders(response, request);
  //     return response;
  //   }
  // }

  // ── 4. 爬虫检测（仅API路由）→ 高危扫描工具拦截，API客户端仅记录 ──
  if (pathname.startsWith("/api/")) {
    const botCheck = detectBot(userAgent);
    if (botCheck.isBot) {
      const blockApiClientOnSensitiveWrite = botCheck.category === "api_client" && isBrowserOnlyWritePath(pathname, method);
      const shouldBlockBot = botCheck.shouldBlock || blockApiClientOnSensitiveWrite;
      // 记录并累计IP安全事件
      const riskLevel = botCheck.category === "malicious" || blockApiClientOnSensitiveWrite ? "critical" as RiskLevel : "medium" as RiskLevel;
      trackIPSecurityEvent(ip, riskLevel);
      recordSecurityEvent(lifecycle, {
        event_type: "bot_detected",
        risk_level: riskLevel,
        ip,
        user_agent: userAgent,
        path: pathname,
        method,
        details: blockApiClientOnSensitiveWrite ? `${botCheck.reason}；敏感写入入口禁止 API 客户端直连` : botCheck.reason,
        blocked: shouldBlockBot,  // 恶意工具拦截；敏感写入入口对 API 客户端也拦截
        source,
        user_id: identity.userId,
        username: identity.username,
        display_name: identity.displayName,
        phone: identity.phone,
      });

      // 高危扫描工具直接拦截；注册/支付/生成等敏感写入入口也不允许 API 客户端直连。
      if (shouldBlockBot) {
        const response = NextResponse.json(
          { error: "请求被拒绝：检测到非可信自动化请求", code: "BOT_DETECTED" },
          { status: 403 },
        );
        applySecurityHeaders(response, request);
        return response;
      }
    }
  }

  // ── 5. Browser write source validation ──
  // Every browser-originated API write must be exact same-host. Server callers
  // without browser headers continue to their route-level signature/key check.
  if (pathname.startsWith("/api/")) {
    const sourceCheck = validateBrowserWriteSource(method, request.headers);
    if (!sourceCheck.allowed) {
      recordSecurityEvent(lifecycle, {
        event_type: "unauthorized_access",
        risk_level: "medium",
        ip, user_agent: userAgent, path: pathname, method,
        details: `浏览器写入来源验证失败: ${sourceCheck.reason}`,
        blocked: true, source,
        user_id: identity.userId, username: identity.username,
        display_name: identity.displayName, phone: identity.phone,
      });
      const response = NextResponse.json(
        { error: "来源验证失败", code: "BROWSER_SOURCE_REJECTED" },
        { status: 403 },
      );
      applySecurityHeaders(response, request);
      return response;
    }
  }

  // ── 6. 限流检查（仅API路由） → 触发即拦截 ──
  if (pathname.startsWith("/api/")) {
    const rateResult = checkRateLimit(ip, method, pathname, identity.userId);
    if (!rateResult.allowed) {
      recordSecurityEvent(lifecycle, {
        event_type: "rate_limit",
        risk_level: "medium",
        ip,
        user_agent: userAgent,
        path: pathname,
        method,
        details: `超出限流: ${rateResult.limit}次/${Math.round(rateResult.resetAt - Date.now())}ms内`,
        blocked: true,
        source,
        user_id: identity.userId,
        username: identity.username,
        display_name: identity.displayName,
        phone: identity.phone,
      });

      const response = NextResponse.json(
        { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED", retryAfter: Math.ceil((rateResult.resetAt - Date.now()) / 1000) },
        { status: 429 },
      );
      response.headers.set("Retry-After", String(Math.ceil((rateResult.resetAt - Date.now()) / 1000)));
      applySecurityHeaders(response, request);
      return response;
    }
  }

  // ── 6. 可疑请求模式检测（URL参数） → 检测即拦截 ──
  if (pathname.startsWith("/api/")) {
    let fullUrl = pathname;
    try {
      fullUrl = decodeURIComponent(pathname + search);
    } catch {
      fullUrl = pathname + search;
    }
    const suspicious = detectSuspiciousRequest(fullUrl);
    if (suspicious.suspicious) {
      const eventType: SecurityEventType = suspicious.threatType === "sql_injection" ? "sql_injection"
        : suspicious.threatType === "xss" ? "xss_attempt"
        : "path_traversal";
      // 记录并累计IP安全事件
      trackIPSecurityEvent(ip, "critical");
      recordSecurityEvent(lifecycle, {
        event_type: eventType,
        risk_level: "critical",
        ip,
        user_agent: userAgent,
        // Keep the query string available for in-memory threat detection, but
        // never persist it: media access tickets and OAuth state can travel in
        // query parameters.
        path: pathname,
        method,
        details: suspicious.details,
        blocked: true,
        source,
        user_id: identity.userId,
        username: identity.username,
        display_name: identity.displayName,
        phone: identity.phone,
      });

      const response = NextResponse.json(
        { error: "请求包含非法内容", code: "SUSPICIOUS_REQUEST" },
        { status: 400 },
      );
      applySecurityHeaders(response, request);
      return response;
    }
  }

  // ── 7. 正常请求 — 添加安全头后放行 ──
  const response = NextResponse.next();
  applySecurityHeaders(response, request);
  return response;
}

/** 注入安全响应头 + SSE 反缓冲头 */
function applySecurityHeaders(response: NextResponse, request: NextRequest): void {
  for (const [key, value] of Object.entries(getSecurityHeadersForHost(
    request.headers.get("host") || "",
    request.nextUrl.pathname,
  ))) {
    response.headers.set(key, value);
  }

  // 防御性清理：确保 X-Frame-Options 不被设置
  // 该头已被 CSP frame-ancestors 取代，保留会阻止沙箱 iframe 嵌入
  // 即使 SECURITY_HEADERS 中未定义，Next.js 或其他中间件可能默认注入
  response.headers.delete("X-Frame-Options");

  // ── SSE 流式输出反缓冲保护 ──
  // 对所有流式 API 路径预注入 X-Accel-Buffering: no
  // Nginx 原生支持此头，收到后会自动禁用该请求的代理缓冲
  // 这确保不管什么域名、什么 Nginx 配置，SSE 响应都不会被缓冲
  const url = request.nextUrl.pathname;
  const ssePaths = ["/api/llm", "/api/chat", "/api/chat/coding", "/api/video/", "/api/image/", "/api/admin/agents/batch-avatar"];
  const isSSE = ssePaths.some((p) => url === p || url.startsWith(p));
  if (isSSE) {
    response.headers.set("X-Accel-Buffering", "no");
    response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  }
}

/** Proxy 匹配规则 */
export const config = {
  matcher: [
    // Next.js 内部资源（含开发环境 HMR WebSocket）必须绕过 Proxy。
    // 否则 Upgrade 请求即使在函数内放行，也会因经过 Proxy 而握手失败，
    // 导致本地代码保存后无法稳定实时同步到沙箱。
    "/((?!_next(?:/|$)).*)",
  ],
};
