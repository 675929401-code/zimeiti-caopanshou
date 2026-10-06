/**
 * Edge-safe security helpers for middleware.
 *
 * Keep this module free of database clients, dotenv, node:crypto and storage
 * imports. Middleware runs in the Edge Runtime; server-only logging remains in
 * src/lib/security.ts and the internal security-events API.
 */

export type RequestSource = "user_client" | "admin_panel" | "api_direct" | "anonymous";

export type SecurityEventType =
  | "rate_limit" | "brute_force" | "bot_detected"
  | "sql_injection" | "xss_attempt" | "path_traversal"
  | "prompt_injection" | "unauthorized_access"
  | "suspicious_behavior" | "api_abuse";

export type RiskLevel = "low" | "medium" | "high" | "critical";

interface RateBucket {
  timestamps: number[];
  windowMs: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
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
  // Do not rescan a full store for every attacker-controlled identity. The
  // periodic sweep handles expiry; at capacity, evicting one oldest bucket is
  // constant-time and keeps memory bounded even during a high-cardinality burst.
  if (now - lastRateLimitPruneAt >= RATE_LIMIT_PRUNE_INTERVAL_MS) {
    pruneExpiredRateLimitBuckets(now);
  }
  if (rateLimitStore.size >= MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = rateLimitStore.keys().next().value as string | undefined;
    if (oldestKey) rateLimitStore.delete(oldestKey);
  }
}

// Unknown/dynamic API paths share a route-family bucket. Besides making the
// policy easier to reason about, this prevents a crawler from rotating UUIDs or
// made-up path segments to create an unbounded number of buckets and reset its
// allowance on every request.
export function normalizeRateLimitPath(method: string, path: string): string {
  const normalizedMethod = method.toUpperCase();
  const canonicalPath = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  if (RATE_LIMITS[`${normalizedMethod}:${canonicalPath}`]) return canonicalPath;
  const segments = canonicalPath.split("/").filter(Boolean);
  if (segments[0] !== "api" || !segments[1]) return canonicalPath;
  return `/api/${segments[1]}`;
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
  // Cached fixed-text previews are reads; the route separately limits new paid synthesis.
  "POST:/api/voice/preview": { windowMs: 60 * 1000, maxRequests: 180 },
  "POST:/api/diagnostic-logs": { windowMs: 60 * 1000, maxRequests: 10 },
  "POST:/api/image/generate": { windowMs: 60 * 1000, maxRequests: 5 },
  "POST:/api/video/generate": { windowMs: 60 * 1000, maxRequests: 10 },
  "POST:/api/payment/create": { windowMs: 60 * 1000, maxRequests: 10 },
  default: { windowMs: 60 * 1000, maxRequests: 60 },
};

const READ_ONLY_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 240,
};

export function checkRateLimit(
  ip: string,
  method: string,
  path: string,
  userId?: string | null,
): { allowed: boolean; remaining: number; resetAt: number; limit: number } {
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
  if (allowed) bucket.timestamps.push(now);

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
  /MSIE\s+\d|Trident\/\d/i,
];

export interface BotCheckResult {
  isBot: boolean;
  shouldBlock: boolean;
  reason?: string;
  category?: "malicious" | "api_client" | "no_ua" | "unknown_bot";
}

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
  /(?:or|and)\s+'[^']*'\s*=\s*'/i,
  /'\s*--\s*$/i,
  /'\s*;\s*$/i,
];

const XSS_PATTERNS: RegExp[] = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(?:error|load|click|mouseover|focus|blur)\s*=\s*["']/i,
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

type VerifiedIdentityPayload = {
  userId?: unknown;
  sub?: unknown;
  username?: unknown;
  phone?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  role?: unknown;
};

export async function extractUserIdentity(
  request: Request,
  verifyToken: (token: string) => Promise<VerifiedIdentityPayload | null>,
): Promise<{
  userId: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  role: string | null;
}> {
  try {
    const authHeader = request.headers.get("authorization");
    let token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      const cookie = request.headers.get("cookie") || "";
      const match = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
      if (!match) return emptyIdentity();
      token = match[1];
    }
    // A decoded payload is attacker-controlled. Only the actual auth verifier
    // may supply the user key used by per-user rate limits and security logs.
    const payload = await verifyToken(token);
    if (!payload) return emptyIdentity();
    const userId = identityString(payload.userId) || identityString(payload.sub);
    if (!userId) return emptyIdentity();
    return {
      userId,
      username: identityString(payload.username) || identityString(payload.phone),
      displayName: identityString(payload.displayName) || identityString(payload.display_name),
      phone: identityString(payload.phone) || identityString(payload.username),
      role: identityString(payload.role),
    };
  } catch {
    return emptyIdentity();
  }
}

function emptyIdentity() {
  return { userId: null, username: null, displayName: null, phone: null, role: null };
}

function identityString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function getClientIP(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIP = request.headers.get("x-real-ip");
  const cfIP = request.headers.get("cf-connecting-ip");
  // The production Nginx boundary overwrites X-Real-IP. CF-Connecting-IP is a
  // normal client header unless an explicitly configured Cloudflare edge owns
  // the connection, so trusting it by default would let callers rotate fake IPs
  // and bypass every IP-scoped limiter.
  if (process.env.TRUST_CF_CONNECTING_IP === "1") {
    const normalizedCfIP = normalizeForwardedIP(cfIP);
    if (normalizedCfIP) return normalizedCfIP;
  }
  const normalizedRealIP = normalizeForwardedIP(realIP);
  if (normalizedRealIP) return normalizedRealIP;
  if (forwarded) {
    // The trusted proxy appends/sets its directly observed peer at the right
    // edge. Never walk left to a public value: those earlier values can be
    // supplied by the client when a proxy chain is not canonicalized.
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

export type BrowserWriteSourceResult =
  | { allowed: true; browserRequest: boolean }
  | { allowed: false; browserRequest: true; reason: "cross_site" | "missing_source" | "invalid_source" | "host_mismatch" };

/**
 * Cheap CSRF boundary for browser writes.
 *
 * Server-to-server callers without browser headers continue to the route's own
 * signature/service-key check. Browser writes must prove an exact same-host
 * Origin or Referer; broad wildcard subdomains are deliberately not trusted.
 */
export function validateBrowserWriteSource(
  method: string,
  headers: Pick<Headers, "get">,
): BrowserWriteSourceResult {
  const normalizedMethod = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
    return { allowed: true, browserRequest: false };
  }

  const origin = String(headers.get("origin") || "").trim();
  const referer = String(headers.get("referer") || "").trim();
  const fetchSite = String(headers.get("sec-fetch-site") || "").trim().toLowerCase();
  const cookie = String(headers.get("cookie") || "");
  const browserRequest = Boolean(origin || referer || fetchSite || /(?:^|;\s*)auth_token=/u.test(cookie));
  if (!browserRequest) return { allowed: true, browserRequest: false };
  if (fetchSite === "cross-site") {
    return { allowed: false, browserRequest: true, reason: "cross_site" };
  }

  // Production Nginx overwrites Host but does not currently establish a
  // trusted X-Forwarded-Host boundary, so never let a client-supplied forwarded
  // host authorize a browser write.
  const hostHeader = String(headers.get("host") || "").trim().toLowerCase();
  const source = origin || referer;
  if (!source) return { allowed: false, browserRequest: true, reason: "missing_source" };
  if (!hostHeader) return { allowed: false, browserRequest: true, reason: "invalid_source" };

  try {
    const sourceHost = new URL(source).host.toLowerCase();
    if (sourceHost !== hostHeader) {
      return { allowed: false, browserRequest: true, reason: "host_mismatch" };
    }
  } catch {
    return { allowed: false, browserRequest: true, reason: "invalid_source" };
  }

  return { allowed: true, browserRequest: true };
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-Download-Options": "noopen",
  "X-DNS-Prefetch-Control": "on",
  "X-Powered-By": "",
  "Server": "CloudServer",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://lf-cdn.coze.cn",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.googleapis.cn",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com https://fonts.gstatic.cn",
    "connect-src 'self' https: wss:",
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
  const pathname = _pathname || "";
  const headers = { ...SECURITY_HEADERS };

  // API、后台和登录后的工作台不属于公开 SEO 面。This is an
  // indexing/cache hint only; authentication and authorization remain the
  // actual protection boundary.
  const privateSurfacePrefixes = [
    "/api/", "/admin", "/profile", "/media-history", "/tools/", "/video",
    "/image-workbench", "/cover", "/storyboard-workbench", "/segmenter",
    "/formatter", "/extract", "/voice-studio", "/digital-human", "/short-drama",
    "/commerce", "/youcai",
  ];
  if (privateSurfacePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
    headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
  }
  const adminPrivateSurface = pathname === "/admin"
    || pathname.startsWith("/admin/")
    || pathname === "/api/admin"
    || pathname.startsWith("/api/admin/")
    || pathname === "/api/settings/admin"
    || pathname === "/api/settings/operation-password";
  if (adminPrivateSurface) {
    headers['Cache-Control'] = 'private, no-store, max-age=0';
    headers['Pragma'] = 'no-cache';
  }

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

interface IPBanRecord {
  bannedUntil: number;
  reason: string;
  criticalCount: number;
  highCount: number;
  lastEventAt: number;
}

const ipBanStore = new Map<string, IPBanRecord>();
export const MAX_IP_SECURITY_RECORDS = 10_000;
let lastIPSecurityPruneAt = 0;

function reserveIPSecurityRecordCapacity(now: number): void {
  if (ipBanStore.size < MAX_IP_SECURITY_RECORDS) return;
  // Prune expired/inactive records only when capacity is reached. This keeps
  // normal requests O(1), then uses constant-time oldest-entry eviction if the
  // store is still full.
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

const IP_BAN_CONFIG = {
  criticalThreshold: 3,
  highThreshold: 5,
  banDurationMs: 60 * 60 * 1000,
  eventWindowMs: 24 * 60 * 60 * 1000,
};

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

  if (record.bannedUntil && now > record.bannedUntil) {
    record.criticalCount = 0;
    record.highCount = 0;
    record.bannedUntil = 0;
  }

  if (now - record.lastEventAt > config.eventWindowMs) {
    record.criticalCount = 0;
    record.highCount = 0;
  }

  record.lastEventAt = now;

  if (riskLevel === "critical") record.criticalCount++;
  if (riskLevel === "high") record.highCount++;

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

export function isIPBanned(ip: string): { banned: boolean; banMinutes: number; reason: string } {
  if (isPrivateIP(ip)) {
    return { banned: false, banMinutes: 0, reason: "" };
  }

  const record = ipBanStore.get(ip);
  if (!record || !record.bannedUntil) return { banned: false, banMinutes: 0, reason: "" };

  const now = Date.now();
  if (now > record.bannedUntil) {
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

function isPrivateIP(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  if (ip === "::1") return true;

  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);

  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 127) return true;

  return false;
}

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
