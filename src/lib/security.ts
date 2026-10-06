/**
 * 安全核心模块 — 限流 / 反爬虫 / 异常行为检测 / 安全事件记录
 *
 * 核心原则：检测到风险行为 → 立即拦截 + 记录完整身份信息
 *
 * 功能：
 * 1. 内存滑动窗口限流（IP+路由粒度）→ 触发即拦截
 * 2. 爬虫/自动化工具检测 → 非浏览器一律拦截
 * 3. 暴力破解检测（登录失败累计锁定）→ 锁定即拦截
 * 4. 可疑请求模式检测（SQL注入/XSS/路径遍历）→ 检测即拦截
 * 5. 安全事件统一记录到数据库（含来源入口+学员身份+IP地址+手机号）
 * 6. 请求身份识别（JWT解析+来源判断）
 */

// 注意：本模块被 middleware.ts 引用，不能使用 Node.js 的 crypto 模块，改用 Web Crypto API

// ────────────────────────────────────────────
// 一、滑动窗口限流器
// ────────────────────────────────────────────

interface RateBucket {
  timestamps: number[];
  windowMs: number;
}

const rateLimitStore = new Map<string, RateBucket>();
export const MAX_RATE_LIMIT_BUCKETS = 10_000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastRateLimitPruneAt = 0;

function pruneExpiredRateLimitBuckets(now: number): void {
  for (const [key, bucket] of rateLimitStore) {
    bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < bucket.windowMs);
    if (bucket.timestamps.length === 0) rateLimitStore.delete(key);
  }
  lastRateLimitPruneAt = now;
}

function reserveRateLimitBucketCapacity(now: number): void {
  if (rateLimitStore.size < MAX_RATE_LIMIT_BUCKETS) return;
  if (now - lastRateLimitPruneAt >= RATE_LIMIT_PRUNE_INTERVAL_MS) {
    pruneExpiredRateLimitBuckets(now);
  }
  if (rateLimitStore.size >= MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = rateLimitStore.keys().next().value as string | undefined;
    if (oldestKey) rateLimitStore.delete(oldestKey);
  }
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "POST:/api/auth/register": { windowMs: 60 * 60 * 1000, maxRequests: 5 },
  "POST:/api/auth/login": { windowMs: 5 * 60 * 1000, maxRequests: 20 },
  "POST:/api/auth/login-email": { windowMs: 5 * 60 * 1000, maxRequests: 20 },
  "POST:/api/auth/send-email-code": { windowMs: 60 * 1000, maxRequests: 5 },
  "POST:/api/auth/register/send-code": { windowMs: 60 * 1000, maxRequests: 3 },
  "POST:/api/chat": { windowMs: 60 * 1000, maxRequests: 120 },
  "POST:/api/llm": { windowMs: 60 * 1000, maxRequests: 120 },
  "POST:/api/chat/coding": { windowMs: 60 * 1000, maxRequests: 120 },
  "POST:/api/diagnostic-logs": { windowMs: 60 * 1000, maxRequests: 10 },
  // 未单独配置的生成/提取入口使用 default；余额预检不能替代限流。
  "POST:/api/image/generate": { windowMs: 60 * 1000, maxRequests: 5 },
  "POST:/api/video/generate": { windowMs: 60 * 1000, maxRequests: 10 },
  "POST:/api/payment/create": { windowMs: 60 * 1000, maxRequests: 10 },
  // 带货工作台涉及配置、报价、任务与资产写入；收紧 API 客户端扫描空间。
  "POST:/api/commerce/session": { windowMs: 60 * 1000, maxRequests: 20 },
  "POST:/api/commerce/quotes": { windowMs: 60 * 1000, maxRequests: 30 },
  "POST:/api/commerce/jobs": { windowMs: 60 * 1000, maxRequests: 20 },
  "POST:/api/commerce/assets": { windowMs: 60 * 1000, maxRequests: 40 },
  "POST:/api/commerce/assets/import": { windowMs: 60 * 1000, maxRequests: 10 },
  "POST:/api/commerce/v1/discover/items": { windowMs: 60 * 1000, maxRequests: 20 },
  default: { windowMs: 60 * 1000, maxRequests: 60 },
};

export function normalizeRateLimitPath(method: string, path: string): string {
  const normalizedMethod = method.toUpperCase();
  const canonicalPath = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  if (RATE_LIMITS[`${normalizedMethod}:${canonicalPath}`]) return canonicalPath;
  const segments = canonicalPath.split("/").filter(Boolean);
  if (segments[0] !== "api" || !segments[1]) return canonicalPath;
  return `/api/${segments[1]}`;
}

const READ_ONLY_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 240,
};

/** 检查是否触发限流 → 触发即拦截 */
export function checkRateLimit(
  ip: string,
  method: string,
  path: string,
  userId?: string | null,
): { allowed: boolean; remaining: number; resetAt: number; limit: number } {
  // 优先按 userId 限流（避免多用户共享同一 IP 时互相影响）
  // 无 userId 时回退到 IP 限流
  const identityKey = userId || ip;
  const normalizedMethod = method.toUpperCase();
  const canonicalPath = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  const bucketPath = normalizeRateLimitPath(normalizedMethod, canonicalPath);
  const key = `${identityKey}:${normalizedMethod}:${bucketPath}`;
  const config = RATE_LIMITS[`${normalizedMethod}:${canonicalPath}`]
    || (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod) ? READ_ONLY_RATE_LIMIT : RATE_LIMITS.default);
  const now = Date.now();

  let bucket = rateLimitStore.get(key);
  if (!bucket) {
    reserveRateLimitBucketCapacity(now);
    bucket = { timestamps: [], windowMs: config.windowMs };
    rateLimitStore.set(key, bucket);
  }

  bucket.timestamps = bucket.timestamps.filter((t) => now - t < config.windowMs);

  const allowed = bucket.timestamps.length < config.maxRequests;
  if (allowed) {
    bucket.timestamps.push(now);
  }

  const resetAt = bucket.timestamps.length > 0
    ? bucket.timestamps[0] + config.windowMs
    : now + config.windowMs;

  return {
    allowed,
    remaining: Math.max(0, config.maxRequests - bucket.timestamps.length),
    resetAt,
    limit: config.maxRequests,
  };
}

if (typeof setInterval !== "undefined") {
  setInterval(() => {
    pruneExpiredRateLimitBuckets(Date.now());
  }, RATE_LIMIT_PRUNE_INTERVAL_MS);
}

// ────────────────────────────────────────────
// 二、暴力破解检测
// ────────────────────────────────────────────

interface LoginAttemptTracker {
  failCount: number;
  lastFailAt: number;
  lockedUntil: number;
}

const loginAttemptStore = new Map<string, LoginAttemptTracker>();
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_DURATION = 30 * 60 * 1000;
const LOGIN_FAIL_WINDOW = 15 * 60 * 1000;

export function recordLoginFailure(ip: string): {
  locked: boolean;
  remainingAttempts: number;
  lockMinutes: number;
} {
  const now = Date.now();
  let tracker = loginAttemptStore.get(ip);
  if (!tracker) {
    tracker = { failCount: 0, lastFailAt: 0, lockedUntil: 0 };
    loginAttemptStore.set(ip, tracker);
  }
  if (now - tracker.lastFailAt > LOGIN_FAIL_WINDOW) tracker.failCount = 0;
  if (tracker.lockedUntil && now > tracker.lockedUntil) {
    tracker.failCount = 0;
    tracker.lockedUntil = 0;
  }
  tracker.failCount++;
  tracker.lastFailAt = now;
  if (tracker.failCount >= LOGIN_FAIL_THRESHOLD) {
    tracker.lockedUntil = now + LOGIN_LOCK_DURATION;
    return { locked: true, remainingAttempts: 0, lockMinutes: Math.ceil(LOGIN_LOCK_DURATION / 60000) };
  }
  return { locked: false, remainingAttempts: LOGIN_FAIL_THRESHOLD - tracker.failCount, lockMinutes: 0 };
}

export function isLoginLocked(ip: string): { locked: boolean; lockMinutes: number } {
  const tracker = loginAttemptStore.get(ip);
  if (!tracker || !tracker.lockedUntil) return { locked: false, lockMinutes: 0 };
  const now = Date.now();
  if (now > tracker.lockedUntil) {
    tracker.failCount = 0;
    tracker.lockedUntil = 0;
    return { locked: false, lockMinutes: 0 };
  }
  return { locked: true, lockMinutes: Math.ceil((tracker.lockedUntil - now) / 60000) };
}

export function recordLoginSuccess(ip: string): void {
  loginAttemptStore.delete(ip);
}

// ────────────────────────────────────────────
// 三、爬虫/自动化工具检测 → 非浏览器一律拦截
// ────────────────────────────────────────────

const MALICIOUS_BOT_PATTERNS: RegExp[] = [
  /masscan/i, /nmap/i, /nikto/i, /sqlmap/i,
  /dirbuster/i, /gobuster/i, /ffuf/i,
  /zaproxy/i, /burp/i, /charles/i,
  /scrapy/i, /selenium/i, /puppeteer/i,
  /headless/i, /phantomjs/i,
  /netcraft/i, /censys/i, /shodan/i,
];

const API_CLIENT_PATTERNS: RegExp[] = [
  /curl/i, /wget/i, /python-requests/i, /httpclient/i,
  /node-fetch/i, /axios/i, /postman/i, /insomnia/i,
  /httpie/i, /rest-client/i, /python/i,
  /go-http-client/i, /ruby/i, /php\//i, /java\//i,
];

const BROWSER_PATTERNS: RegExp[] = [
  /Mozilla\/5\.0.*(?:Chrome|Safari|Firefox|Edge|Edg|OPR|Opera)\/\d+/i,
  /Mozilla\/5\.0.*Mobile.*Safari/i,
  // 国产浏览器：360安全/极速(QIHU 360SE/360EE)、QQ浏览器(QQBrowser)、
  // 搜狗(Sogou)、百度(BIDUBrowser)、猎豹(LBBrowser)、UC(UCBrowser/U3)、
  // 2345(2345Explorer)、遨游(Maxthon)、星愿(Twinkstar)、华为(HuaweiBrowser)、
  // 小米(MiuiBrowser)、vivo(VivoBrowser)、OPPO(OppoBrowser)、夸克(Quark)
  /QIHU\s+(360SE|360EE)/i,
  /QQBrowser/i,
  /Sogou/i,
  /BIDUBrowser/i,
  /LBBrowser/i,
  /UCBrowser|UCWEB|U3\//i,
  /2345Explorer/i,
  /Maxthon/i,
  /Twinkstar/i,
  /HuaweiBrowser/i,
  /MiuiBrowser/i,
  /VivoBrowser/i,
  /OppoBrowser/i,
  /Quark/i,
  // IE/Trident 内核（360安全浏览器兼容模式等）
  /MSIE\s+\d|Trident\/\d/i,
];

export interface BotCheckResult {
  isBot: boolean;
  shouldBlock: boolean;
  reason?: string;
  category?: "malicious" | "api_client" | "no_ua" | "unknown_bot";
}

/**
 * 检测请求是否来自爬虫/自动化工具
 * 策略：所有非浏览器请求一律拦截
 */
export function detectBot(userAgent: string): BotCheckResult {
  if (!userAgent || userAgent.trim().length === 0) {
    return { isBot: true, shouldBlock: true, reason: "缺少User-Agent", category: "no_ua" };
  }
  if (BROWSER_PATTERNS.some((p) => p.test(userAgent))) {
    return { isBot: false, shouldBlock: false };
  }
  for (const pattern of MALICIOUS_BOT_PATTERNS) {
    if (pattern.test(userAgent)) {
      return { isBot: true, shouldBlock: true, reason: `高危扫描工具: ${pattern.source}`, category: "malicious" };
    }
  }
  for (const pattern of API_CLIENT_PATTERNS) {
    if (pattern.test(userAgent)) {
      return { isBot: true, shouldBlock: false, reason: `非浏览器客户端: ${pattern.source}`, category: "api_client" };
    }
  }
  return { isBot: false, shouldBlock: false };
}

// ────────────────────────────────────────────
// 四、可疑请求模式检测 → 检测到一律拦截
// ────────────────────────────────────────────

const SQL_INJECTION_PATTERNS: RegExp[] = [
  /(?:'|\")\s*(?:or|and)\s+(?:'|\")?\d+(?:'|\")?\s*=\s*(?:'|\")?\d+/i,
  /union\s+(?:all\s+)?select/i,
  /;\s*(?:drop|alter|truncate|delete|insert|update)\s+/i,
  /(?:exec|execute)\s*\(/i,
  /information_schema/i,
  /(?:char|concat|group_concat)\s*\(/i,
  /(?:0x[0-9a-f]{6,})/i,
  /(?:benchmark|sleep|waitfor)\s*\(/i,
  /(?:load_file|into\s+outfile|into\s+dumpfile)/i,
  // 移除不带引号的 or/and N=N 模式 — 匹配正常英文文本（"1 or 2 = 2"），
  // 第一个带引号的模式已覆盖真正的 SQL 注入场景
  /(?:or|and)\s+'[^']*'\s*=\s*'/i,
  /'\s*--\s*$/i,
  /'\s*;\s*$/i,
];

const XSS_PATTERNS: RegExp[] = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  // 事件处理器：要求后面跟引号才匹配（"onclick='..."而非"onclick=按钮"）
  /on(?:error|load|click|mouseover|focus|blur)\s*=\s*["']/i,
  // 移除 prompt（AI场景极常见），eval/alert/confirm 要求 document./window. 前缀减少误报
  /(?:document\.(?:cookie|location|write)|window\.(?:eval|alert|confirm))\s*\(/i,
  /<iframe[\s>]/i,
  /<embed[\s>]/i,
  /<object[\s>]/i,
  /data\s*:\s*text\/html/i,
];

const PATH_TRAVERSAL_PATTERNS: RegExp[] = [
  /\.\.\//,
  /\.\.\\/,
  /%2e%2e%2f/i,
  /%2e%2e\//i,
  /\.\.%2f/i,
  /%252e/i,
  /\/etc\/passwd/i,
  /\/proc\/self/i,
  /\/var\/log/i,
];

export type ThreatType = "sql_injection" | "xss" | "path_traversal" | "unknown";

export function detectSuspiciousRequest(
  url: string,
  body?: string,
): { suspicious: boolean; threatType?: ThreatType; details?: string } {
  const normalizedUrl = url.replace(/\+/g, " ");
  const checkTarget = `${normalizedUrl} ${body || ""}`;

  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(checkTarget)) {
      return { suspicious: true, threatType: "sql_injection", details: `SQL注入特征: ${pattern.source}` };
    }
  }
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(checkTarget)) {
      return { suspicious: true, threatType: "xss", details: `XSS攻击特征: ${pattern.source}` };
    }
  }
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(checkTarget)) {
      return { suspicious: true, threatType: "path_traversal", details: `路径遍历特征: ${pattern.source}` };
    }
  }
  return { suspicious: false };
}

// ────────────────────────────────────────────
// 五、请求来源与身份识别
// ────────────────────────────────────────────

export type RequestSource = "user_client" | "admin_panel" | "api_direct" | "anonymous";

/** 来源入口中文标签 */
export const SOURCE_LABELS: Record<RequestSource, string> = {
  user_client: "用户端",
  admin_panel: "管理后台",
  api_direct: "API直连",
  anonymous: "匿名请求",
};

/**
 * 判断请求来源入口
 */
export function detectSource(request: Request): RequestSource {
  const ua = request.headers.get("user-agent") || "";
  const url = new URL(request.url);
  const path = url.pathname;
  const authHeader = request.headers.get("authorization");
  const hasToken = !!authHeader || !!request.headers.get("cookie")?.includes("auth_token");

  if (path.startsWith("/admin") || path.startsWith("/api/admin")) {
    return "admin_panel";
  }

  const isBrowser = BROWSER_PATTERNS.some((p) => p.test(ua));
  if (!isBrowser) return "api_direct";
  if (!hasToken) return "anonymous";
  return "user_client";
}

/** 从请求中提取用户身份信息（从JWT token解码） */
export function extractUserIdentity(request: Request): {
  userId: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  role: string | null;
} {
  try {
    const authHeader = request.headers.get("authorization");
    let token = authHeader?.replace("Bearer ", "");
    if (!token) {
      const cookie = request.headers.get("cookie") || "";
      const match = cookie.match(/auth_token=([^;]+)/);
      if (!match) return { userId: null, username: null, displayName: null, phone: null, role: null };
      token = match[1];
    }
    return decodeJWTPayload(token);
  } catch {
    return { userId: null, username: null, displayName: null, phone: null, role: null };
  }
}

function decodeJWTPayload(token: string): {
  userId: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  role: string | null;
} {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { userId: null, username: null, displayName: null, phone: null, role: null };
    const payload = JSON.parse(atob(parts[1]));
    return {
      userId: payload.userId || payload.sub || null,
      username: payload.username || payload.phone || null,
      displayName: payload.displayName || payload.display_name || null,
      phone: payload.phone || payload.username || null,
      role: payload.role || null,
    };
  } catch {
    return { userId: null, username: null, displayName: null, phone: null, role: null };
  }
}

// ────────────────────────────────────────────
// 六、安全事件统一记录
// ────────────────────────────────────────────

export type SecurityEventType =
  | "rate_limit" | "brute_force" | "bot_detected"
  | "sql_injection" | "xss_attempt" | "path_traversal"
  | "prompt_injection" | "unauthorized_access"
  | "suspicious_behavior" | "api_abuse";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface SecurityEvent {
  event_type: SecurityEventType;
  risk_level: RiskLevel;
  ip: string;
  user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
  phone?: string | null;
  user_agent?: string;
  path?: string;
  method?: string;
  details?: string;
  raw_data?: string;
  blocked: boolean;
  source?: RequestSource | null;
}

const EVENT_DEFAULT_RISK: Record<SecurityEventType, RiskLevel> = {
  rate_limit: "medium",
  brute_force: "critical",
  bot_detected: "medium",
  sql_injection: "critical",
  xss_attempt: "high",
  path_traversal: "high",
  prompt_injection: "high",
  unauthorized_access: "medium",
  suspicious_behavior: "medium",
  api_abuse: "high",
};

/** 所有事件类型默认都拦截 */
const EVENT_DEFAULT_BLOCKED: Record<SecurityEventType, boolean> = {
  rate_limit: true,
  brute_force: true,
  bot_detected: true,
  sql_injection: true,
  xss_attempt: true,
  path_traversal: true,
  prompt_injection: true,
  unauthorized_access: true,
  suspicious_behavior: true,
  api_abuse: true,
};

/** 记录安全事件到数据库（含来源入口+完整学员身份） */
export async function logSecurityEvent(event: SecurityEvent): Promise<void> {
  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const client = getSupabaseClient();

    const riskLevel = event.risk_level || EVENT_DEFAULT_RISK[event.event_type] || "medium";
    const ipHash = await hashIP(event.ip);
    const blocked = event.blocked !== undefined ? event.blocked : (EVENT_DEFAULT_BLOCKED[event.event_type] ?? true);

    await client.from("security_events").insert({
      event_type: event.event_type,
      risk_level: riskLevel,
      ip_address: event.ip,
      ip_hash: ipHash,
      user_id: event.user_id || null,
      username: event.username || null,
      display_name: event.display_name || null,
      phone: event.phone || null,
      user_agent: event.user_agent || null,
      path: event.path || null,
      method: event.method || null,
      details: event.details || null,
      raw_data: event.raw_data ? JSON.stringify(event.raw_data).slice(0, 2000) : null,
      blocked: blocked,
      source: event.source || "anonymous",
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[Security] Failed to write security event:", e);
  }
}

// ────────────────────────────────────────────
// 七、工具函数
// ────────────────────────────────────────────

async function hashIP(ip: string): Promise<string> {
  const salt = process.env.SECURITY_INTERNAL_KEY?.trim() || process.env.JWT_SECRET?.trim() || '';
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
}

export function getClientIP(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIP = request.headers.get("x-real-ip");
  const cfIP = request.headers.get("cf-connecting-ip");
  if (process.env.TRUST_CF_CONNECTING_IP === "1") {
    const normalizedCfIP = normalizeForwardedIP(cfIP);
    if (normalizedCfIP) return normalizedCfIP;
  }
  const normalizedRealIP = normalizeForwardedIP(realIP);
  if (normalizedRealIP) return normalizedRealIP;
  if (forwarded) {
    const ips = forwarded.split(",");
    for (let index = ips.length - 1; index >= 0; index -= 1) {
      const normalized = normalizeForwardedIP(ips[index]);
      if (normalized) return normalized;
    }
  }
  return "unknown";
}

function normalizeForwardedIP(value: string | null | undefined): string | null {
  let candidate = String(value || "").trim().toLowerCase();
  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }
  if (!candidate || candidate.length > 64 || !/^[0-9a-f:.]+$/u.test(candidate)) return null;

  const ipv4Suffix = candidate.includes(":")
    ? candidate.slice(candidate.lastIndexOf(":") + 1)
    : candidate;
  if (candidate.includes(".")) {
    const octets = ipv4Suffix.split(".");
    if (
      octets.length !== 4
      || octets.some((octet) => !/^\d{1,3}$/u.test(octet) || Number(octet) > 255)
    ) {
      return null;
    }
    if (!candidate.includes(":")) return octets.map((octet) => String(Number(octet))).join(".");
  }
  if (!candidate.includes(":")) return null;
  try {
    return new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export function getUserAgent(request: Request): string {
  return request.headers.get("user-agent") || "unknown";
}

// ────────────────────────────────────────────
// 八、安全响应头
// ────────────────────────────────────────────

export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  // X-Frame-Options 已移除：该头已被 CSP frame-ancestors 取代（RFC 7034 已废弃）。
  // 保留会导致沙箱 iframe 嵌入被阻止（SAMEORIGIN 不匹配跨域沙箱父页面）。
  // 现代浏览器优先使用 CSP frame-ancestors，故完全移除此头。
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1",  // 仅过滤不阻断，避免IE/360兼容模式误杀整页
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-Download-Options": "noopen",
  "X-DNS-Prefetch-Control": "on",
  "X-Powered-By": "",  // 隐藏技术栈标识
  "Server": "CloudServer",  // 模糊化服务器标识
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://lf-cdn.coze.cn",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.googleapis.cn",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com https://fonts.gstatic.cn",
    "connect-src 'self' https: wss:",
    // 沙箱 iframe 嵌入白名单：
    // - 'self'：同源页面
    // - *.coze.site / *.dev.coze.site / *.coze.cn：沙箱IDE及预览平台
    // - *.dev.coze.site 必须单独列出，CSP * 仅匹配一层子域名
    "frame-ancestors 'self' https://*.coze.site https://*.dev.coze.site https://*.coze.cn",
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; "),
};

function isLocalPreviewHost(host: string): boolean {
  const hostname = host.split(":")[0]?.toLowerCase();
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "0.0.0.0"
    || hostname === "[::1]"
    || hostname === "::1";
}

export function getSecurityHeadersForHost(host: string, _pathname = ""): Record<string, string> {
  void _pathname;
  const headers = { ...SECURITY_HEADERS };

  if (isLocalPreviewHost(host)) {
    headers["Content-Security-Policy"] = headers["Content-Security-Policy"]
      .replace("connect-src 'self' https: wss:", "connect-src 'self' http: https: ws: wss:")
      .replace(
        "; frame-ancestors 'self' https://*.coze.site https://*.dev.coze.site https://*.coze.cn",
        "",
      );
  }

  headers["Content-Security-Policy"] = `${headers["Content-Security-Policy"]}; frame-src 'self'`;

  return headers;
}

// ────────────────────────────────────────────
// 九、POST 请求体安全扫描
// ────────────────────────────────────────────

/**
 * 扫描 POST 请求体中的注入攻击
 * 
 * 在中间件中只能扫描 URL，POST body 需要在 API 路由中扫描。
 * 此函数从 API 路由调用，对请求体中的字符串值进行 SQL注入/XSS/路径遍历检测。
 * 
 * @param body - 解析后的请求体对象（如 JSON body）
 * @param scanFields - 需要扫描的字段名列表（默认扫描所有字符串字段）
 * @returns 检测结果
 */
export function detectSuspiciousBody(
  body: Record<string, unknown>,
  scanFields?: string[],
): { suspicious: boolean; threatType?: ThreatType; details?: string; field?: string } {
  // 收集需要扫描的字符串值
  const stringsToScan: { value: string; field: string }[] = [];
  
  function collectStrings(obj: unknown, prefix: string): void {
    if (typeof obj === "string") {
      stringsToScan.push({ value: obj, field: prefix });
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => collectStrings(item, `${prefix}[${i}]`));
    } else if (obj && typeof obj === "object") {
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        collectStrings(val, prefix ? `${prefix}.${key}` : key);
      }
    }
  }

  if (scanFields && scanFields.length > 0) {
    // 只扫描指定字段
    for (const field of scanFields) {
      const val = field.split(".").reduce<unknown>((acc, key) => {
        if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
        return undefined;
      }, body);
      if (val !== undefined) collectStrings(val, field);
    }
  } else {
    // 扫描所有字段
    collectStrings(body, "");
  }

  // 对收集到的字符串逐个检测
  for (const { value, field } of stringsToScan) {
    // SQL 注入检测
    for (const pattern of SQL_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        return {
          suspicious: true,
          threatType: "sql_injection",
          details: `请求体SQL注入特征 [${field}]: ${pattern.source}`,
          field,
        };
      }
    }
    // XSS 检测
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(value)) {
        return {
          suspicious: true,
          threatType: "xss",
          details: `请求体XSS攻击特征 [${field}]: ${pattern.source}`,
          field,
        };
      }
    }
    // 路径遍历检测
    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(value)) {
        return {
          suspicious: true,
          threatType: "path_traversal",
          details: `请求体路径遍历特征 [${field}]: ${pattern.source}`,
          field,
        };
      }
    }
  }

  return { suspicious: false };
}

// ────────────────────────────────────────────
// 十、API 滥用检测（短时间大量请求特定接口）
// ────────────────────────────────────────────

/** API 滥用追踪器 */
interface AbuseTracker {
  timestamps: number[];     // 请求时间戳
  endpoint: string;         // 端点路径
  userId?: string;          // 用户ID（如果有）
}

const abuseTrackerStore = new Map<string, AbuseTracker>();

/** API 滥用检测配置 — 超过阈值触发报警 */
export interface AbuseDetectionConfig {
  windowMs: number;         // 检测时间窗口（毫秒）
  maxRequests: number;      // 窗口内最大请求数
  riskLevel: RiskLevel;     // 触发后的风险等级
}

export const ABUSE_DETECT_CONFIGS: Record<string, AbuseDetectionConfig> = {
  // 视频生成不设滥用检测 — 用户自费消费，有现金预检天然防滥用
  "POST:/api/image/generate": { windowMs: 5 * 60 * 1000, maxRequests: 15, riskLevel: "high" },
  "POST:/api/chat": { windowMs: 5 * 60 * 1000, maxRequests: 200, riskLevel: "medium" },
  "POST:/api/llm": { windowMs: 5 * 60 * 1000, maxRequests: 200, riskLevel: "medium" },
};

/**
 * 检测 API 滥用
 * 在限流阈值之上、但属于业务层面的频繁调用检测
 * 与限流不同：限流是"请求太快"，滥用是"短时间内请求量异常大"
 * 
 * @returns 是否触发滥用检测 + 详情
 */
export function detectApiAbuse(
  ip: string,
  method: string,
  path: string,
  userId?: string,
): { abuse: boolean; count: number; limit: number; windowMs: number; riskLevel: RiskLevel } {
  const config = ABUSE_DETECT_CONFIGS[`${method}:${path}`];
  if (!config) return { abuse: false, count: 0, limit: 0, windowMs: 0, riskLevel: "low" };

  const key = `${ip}:${userId || "anon"}:${method}:${path}`;
  const now = Date.now();

  let tracker = abuseTrackerStore.get(key);
  if (!tracker) {
    tracker = { timestamps: [], endpoint: path, userId };
    abuseTrackerStore.set(key, tracker);
  }

  // 清理过期记录
  tracker.timestamps = tracker.timestamps.filter((t) => now - t < config.windowMs);
  tracker.timestamps.push(now);

  const abuse = tracker.timestamps.length > config.maxRequests;
  return {
    abuse,
    count: tracker.timestamps.length,
    limit: config.maxRequests,
    windowMs: config.windowMs,
    riskLevel: config.riskLevel,
  };
}

// 定期清理滥用追踪器
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, tracker] of abuseTrackerStore) {
      tracker.timestamps = tracker.timestamps.filter((t) => now - t < 600000);
      if (tracker.timestamps.length === 0) abuseTrackerStore.delete(key);
    }
  }, 10 * 60 * 1000);
}

// ────────────────────────────────────────────
// 十一、可疑行为检测（频繁切换智能体等）
// ────────────────────────────────────────────

/** 智能体切换追踪器 */
interface AgentSwitchTracker {
  switches: number;         // 切换次数
  agentIds: Set<string>;    // 已访问的智能体ID
  firstSwitchAt: number;    // 首次切换时间
  lastSwitchAt: number;     // 最近切换时间
}

const agentSwitchStore = new Map<string, AgentSwitchTracker>();

/** 可疑行为检测配置 */
const SUSPICIOUS_BEHAVIOR_CONFIG = {
  windowMs: 5 * 60 * 1000,     // 5分钟时间窗口
  maxAgentSwitches: 15,          // 窗口内最大切换次数
  maxUniqueAgents: 10,           // 窗口内最大不同智能体数
};

/**
 * 记录智能体切换并检测可疑行为
 * 频繁切换智能体可能是在扫描/试探不同智能体的配置
 * 
 * @returns 是否触发可疑行为检测 + 详情
 */
export function trackAgentSwitch(
  ip: string,
  userId: string | undefined,
  agentId: string,
): { suspicious: boolean; switchCount: number; uniqueAgents: number; reason?: string } {
  const key = `${ip}:${userId || "anon"}`;
  const now = Date.now();
  const config = SUSPICIOUS_BEHAVIOR_CONFIG;

  let tracker = agentSwitchStore.get(key);
  if (!tracker) {
    tracker = { switches: 0, agentIds: new Set(), firstSwitchAt: now, lastSwitchAt: now };
    agentSwitchStore.set(key, tracker);
  }

  // 检查是否需要重置窗口
  if (now - tracker.firstSwitchAt > config.windowMs) {
    tracker.switches = 0;
    tracker.agentIds = new Set();
    tracker.firstSwitchAt = now;
  }

  tracker.switches++;
  tracker.agentIds.add(agentId);
  tracker.lastSwitchAt = now;

  // 检测：切换次数过多
  if (tracker.switches > config.maxAgentSwitches) {
    return {
      suspicious: true,
      switchCount: tracker.switches,
      uniqueAgents: tracker.agentIds.size,
      reason: `5分钟内切换智能体${tracker.switches}次（阈值${config.maxAgentSwitches}次）`,
    };
  }

  // 检测：访问不同智能体数量过多
  if (tracker.agentIds.size > config.maxUniqueAgents) {
    return {
      suspicious: true,
      switchCount: tracker.switches,
      uniqueAgents: tracker.agentIds.size,
      reason: `5分钟内访问${tracker.agentIds.size}个不同智能体（阈值${config.maxUniqueAgents}个）`,
    };
  }

  return { suspicious: false, switchCount: tracker.switches, uniqueAgents: tracker.agentIds.size };
}

// 定期清理智能体切换追踪器
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, tracker] of agentSwitchStore) {
      if (now - tracker.lastSwitchAt > 600000) {
        agentSwitchStore.delete(key);
      }
    }
  }, 10 * 60 * 1000);
}

// ────────────────────────────────────────────
// 十二、IP 自动封锁（累计高风险事件触发）
// ────────────────────────────────────────────

/** IP 封锁记录 */
interface IPBanRecord {
  bannedUntil: number;          // 封锁到期时间
  reason: string;               // 封锁原因
  criticalCount: number;        // 累计严重事件数
  highCount: number;            // 累计高风险事件数
  lastEventAt: number;          // 最近事件时间
}

const ipBanStore = new Map<string, IPBanRecord>();
export const MAX_IP_SECURITY_RECORDS = 10_000;
let lastIPSecurityPruneAt = 0;

function reserveIPSecurityRecordCapacity(now: number): void {
  if (ipBanStore.size < MAX_IP_SECURITY_RECORDS) return;
  if (now - lastIPSecurityPruneAt >= RATE_LIMIT_PRUNE_INTERVAL_MS) {
    for (const [key, record] of ipBanStore) {
      if (
        (record.bannedUntil > 0 && now > record.bannedUntil)
        || now - record.lastEventAt > IP_BAN_CONFIG.eventWindowMs
      ) {
        ipBanStore.delete(key);
      }
    }
    lastIPSecurityPruneAt = now;
  }
  if (ipBanStore.size >= MAX_IP_SECURITY_RECORDS) {
    const oldestKey = ipBanStore.keys().next().value as string | undefined;
    if (oldestKey) ipBanStore.delete(oldestKey);
  }
}

/** IP 封锁配置 */
const IP_BAN_CONFIG = {
  criticalThreshold: 3,         // 3次严重事件自动封锁
  highThreshold: 5,             // 5次高风险事件自动封锁
  banDurationMs: 60 * 60 * 1000,  // 封锁1小时
  eventWindowMs: 24 * 60 * 60 * 1000, // 24小时事件窗口
};

/**
 * 记录 IP 安全事件并检查是否需要自动封锁
 * 当同一 IP 在事件窗口内累计达到阈值的高风险/严重事件时自动封锁
 */
export function trackIPSecurityEvent(
  ip: string,
  riskLevel: RiskLevel,
): { banned: boolean; banMinutes: number; reason: string } {
  if (isPrivateIP(ip)) {
    return { banned: false, banMinutes: 0, reason: "" };
  }

  const now = Date.now();
  const config = IP_BAN_CONFIG;
  let record = ipBanStore.get(ip);

  if (!record) {
    reserveIPSecurityRecordCapacity(now);
    record = { bannedUntil: 0, reason: "", criticalCount: 0, highCount: 0, lastEventAt: now };
    ipBanStore.set(ip, record);
  }

  // 如果已过封锁期，重置计数
  if (record.bannedUntil && now > record.bannedUntil) {
    record.criticalCount = 0;
    record.highCount = 0;
    record.bannedUntil = 0;
  }

  // 事件窗口外的事件不累计（但保持封锁状态检查）
  if (now - record.lastEventAt > config.eventWindowMs) {
    record.criticalCount = 0;
    record.highCount = 0;
  }

  record.lastEventAt = now;

  // 累计计数
  if (riskLevel === "critical") record.criticalCount++;
  if (riskLevel === "high") record.highCount++;

  // 检查是否需要封锁
  if (record.criticalCount >= config.criticalThreshold) {
    record.bannedUntil = now + config.banDurationMs;
    record.reason = `24小时内${record.criticalCount}次严重安全事件（阈值${config.criticalThreshold}次）`;
    return { banned: true, banMinutes: Math.ceil(config.banDurationMs / 60000), reason: record.reason };
  }

  if (record.highCount >= config.highThreshold) {
    record.bannedUntil = now + config.banDurationMs;
    record.reason = `24小时内${record.highCount}次高风险安全事件（阈值${config.highThreshold}次）`;
    return { banned: true, banMinutes: Math.ceil(config.banDurationMs / 60000), reason: record.reason };
  }

  return { banned: false, banMinutes: 0, reason: "" };
}

/**
 * 检查 IP 是否已被自动封锁
 */
export function isIPBanned(ip: string): { banned: boolean; banMinutes: number; reason: string } {
  if (isPrivateIP(ip)) {
    return { banned: false, banMinutes: 0, reason: "" };
  }

  const record = ipBanStore.get(ip);
  if (!record || !record.bannedUntil) return { banned: false, banMinutes: 0, reason: "" };

  const now = Date.now();
  if (now > record.bannedUntil) {
    // 封锁已过期，清理
    record.criticalCount = 0;
    record.highCount = 0;
    record.bannedUntil = 0;
    return { banned: false, banMinutes: 0, reason: "" };
  }

  return {
    banned: true,
    banMinutes: Math.ceil((record.bannedUntil - now) / 60000),
    reason: record.reason,
  };
}

/**
 * 判断是否为私有/内网 IP 地址
 * 私有 IP 段（RFC 1918）不会被自动封锁
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 * - 127.0.0.0/8 (loopback)
 * - ::1 (IPv6 loopback)
 * - unknown
 */
function isPrivateIP(ip: string): boolean {
  if (!ip || ip === "unknown") return true;

  // IPv6 loopback
  if (ip === "::1") return true;

  // IPv4 检查
  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);

  // 10.0.0.0/8
  if (first === 10) return true;
  // 172.16.0.0/12
  if (first === 172 && second >= 16 && second <= 31) return true;
  // 192.168.0.0/16
  if (first === 192 && second === 168) return true;
  // 127.0.0.0/8
  if (first === 127) return true;

  return false;
}

// 定期清理 IP 封锁记录
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of ipBanStore) {
      if (record.bannedUntil && now > record.bannedUntil + 3600000) {
        ipBanStore.delete(ip);
      } else if (!record.bannedUntil && now - record.lastEventAt > 86400000) {
        ipBanStore.delete(ip);
      }
    }
  }, 30 * 60 * 1000);
}
