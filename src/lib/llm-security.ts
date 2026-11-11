// LLM 安全防护模块 — 从 route.ts 拆分
// 三层防护：注入检测 + 行为检测 + 滥用检测
// 修改安全规则只改这个文件，不动 route.ts

import { verifyToken } from "@/lib/auth";
import {
  detectSuspiciousBody,
  trackAgentSwitch,
  detectApiAbuse,
  trackIPSecurityEvent,
  logSecurityEvent,
  getClientIP as getSecIP,
  getUserAgent as getSecUA,
} from "@/lib/security";

/** 安全检查结果：通过返回 null，拦截返回错误 Response */
export type SecurityCheckResult = Response | null;

/** 从请求中提取认证用户信息（用于安全事件记录） */
async function extractAuthUser(request: Request, fallbackUserId?: string) {
  let userId: string | undefined;
  let username: string | undefined;
  let displayName: string | undefined;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = await verifyToken(authHeader.slice(7));
      if (payload) {
        userId = payload.userId;
        username = payload.username;
        displayName = payload.displayName;
      }
    } catch { /* ignore */ }
  }
  return { userId: userId || fallbackUserId, username, displayName };
}

/** 认证用户信息（由调用方提前验证后传入，避免重复JWT解码） */
export interface PreVerifiedAuthUser {
  userId?: string;
  username?: string;
  displayName?: string;
}

/** 安全检查选项 */
export interface SecurityCheckOptions {
  agentId?: string;
  userId?: string;
  skipFields?: string[];
  /** 外部已验证的用户信息（避免重复JWT解码，省40-120ms） */
  preVerifiedUser?: PreVerifiedAuthUser;
}

function cloneSecurityScanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSecurityScanValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, cloneSecurityScanValue(nested)]),
    );
  }
  return value;
}

/** Remove explicit exemptions while keeping every other nested field scannable. */
export function omitSecurityScanFields(
  body: Record<string, unknown>,
  skipFields: string[] = [],
): Record<string, unknown> {
  const filtered = cloneSecurityScanValue(body) as Record<string, unknown>;

  for (const field of skipFields) {
    const path = field.split(".").map((part) => part.trim()).filter(Boolean);
    if (path.length === 0) continue;

    let cursor: unknown = filtered;
    for (let index = 0; index < path.length - 1; index += 1) {
      if (!cursor || typeof cursor !== "object") break;
      cursor = (cursor as Record<string, unknown>)[path[index]];
    }
    if (cursor && typeof cursor === "object") {
      delete (cursor as Record<string, unknown>)[path[path.length - 1]];
    }
  }

  return filtered;
}

/** Binary image bytes are not SQL, HTML or filesystem text. Keep this exemption
 * bound to the actual multimodal field, and leave every sibling field scanned.
 * The ceiling bounds validation work; larger values retain ordinary scanning.
 */
function isInlineRasterImage(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32 * 1024 * 1024) return false;
  const header = /^data:image\/(png|jpeg|webp);base64,/u.exec(value);
  if (!header) return false;
  const encoded = value.slice(header[0].length);
  if (!encoded.length || encoded.length % 4 !== 0) return false;
  const paddingAt = encoded.indexOf("=");
  const payloadEnd = paddingAt < 0 ? encoded.length : paddingAt;
  if (paddingAt >= 0 && (encoded.length - paddingAt > 2 || /[^=]/u.test(encoded.slice(paddingAt)))) return false;
  if (/[^A-Za-z0-9+/]/u.test(encoded.slice(0, payloadEnd))) return false;
  // Buffer's decoder accepts malformed padding, so check the canonical tail too.
  const tail = encoded.slice(-4);
  if (Buffer.from(tail, "base64").toString("base64") !== tail) return false;
  const prefix = Buffer.from(encoded.slice(0, 24), "base64");
  if (header[1] === "png") return prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (header[1] === "jpeg") return prefix.length >= 3 && prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  return prefix.length >= 12 && prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP";
}

/** A scan-only copy: never alter the messages forwarded to the model. */
export function prepareSecurityScanBody(body: Record<string, unknown>, skipFields: string[] = []): Record<string, unknown> {
  const filtered = omitSecurityScanFields(body, skipFields);
  if (!Object.hasOwn(filtered, "messages") || !Array.isArray(filtered.messages)) return filtered;
  let imageCount = 0;
  let imageCodeUnits = 0;
  for (const message of filtered.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message) || !Object.hasOwn(message, "content") || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || Array.isArray(part) || !Object.hasOwn(part, "type") || part.type !== "image_url" || !Object.hasOwn(part, "image_url")) continue;
      const image = part.image_url;
      if (!image || typeof image !== "object" || Array.isArray(image) || !Object.hasOwn(image, "url")) continue;
      if (imageCount >= 16 || typeof image.url !== "string" || imageCodeUnits + image.url.length > 32 * 1024 * 1024) continue;
      if (isInlineRasterImage(image.url)) {
        imageCount++;
        imageCodeUnits += image.url.length;
        image.url = "[inline raster image bytes]";
      }
    }
  }
  return filtered;
}

/**
 * 安全防护1：请求体注入检测
 * 检测 SQL 注入、XSS、路径遍历等恶意内容
 * v2 优化：安全事件记录改为 fire-and-forget，不阻塞响应返回
 * v3 优化：支持 preVerifiedUser 避免重复 JWT 解码
 */
export async function checkBodyInjection(
  body: Record<string, unknown>,
  request: Request,
  skipFields: string[] = [],
  fallbackUserId?: string,
  preVerifiedUser?: PreVerifiedAuthUser
): Promise<SecurityCheckResult> {
  const suspicious = detectSuspiciousBody(prepareSecurityScanBody(body, skipFields));
  if (!suspicious.suspicious) return null;

  const secIP = getSecIP(request);
  const riskLevel = suspicious.threatType === "sql_injection" ? "critical" as const : "high" as const;
  trackIPSecurityEvent(secIP, riskLevel);

  // fire-and-forget：不 await，立即返回拦截响应
  // 优先使用外部已验证用户信息，避免重复 JWT 解码
  const userPromise = preVerifiedUser
    ? Promise.resolve({ userId: preVerifiedUser.userId || fallbackUserId, username: preVerifiedUser.username, displayName: preVerifiedUser.displayName })
    : extractAuthUser(request, fallbackUserId);
  userPromise.then(user => {
    const eventType = suspicious.threatType === "sql_injection" ? "sql_injection"
      : suspicious.threatType === "xss" ? "xss_attempt"
      : "path_traversal";
    return logSecurityEvent({
      event_type: eventType,
      risk_level: riskLevel,
      ip: secIP,
      user_agent: getSecUA(request),
      path: "/api/llm",
      method: "POST",
      details: suspicious.details,
      blocked: true,
      user_id: user.userId,
      username: user.username,
      display_name: user.displayName,
    });
  }).catch(() => {});

  return new Response(
    JSON.stringify({ error: "请求包含非法内容", code: "SUSPICIOUS_BODY" }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * 安全防护2：可疑行为检测（频繁切换智能体）
 * v2 优化：安全事件记录改为 fire-and-forget，不阻塞响应返回
 * v3 优化：支持 preVerifiedUser 避免重复 JWT 解码
 */
export async function checkAgentSwitchAbuse(
  request: Request,
  agentId: string | undefined,
  userId?: string,
  preVerifiedUser?: PreVerifiedAuthUser
): Promise<SecurityCheckResult> {
  if (!agentId) return null;

  const secIP = getSecIP(request);
  const result = trackAgentSwitch(secIP, userId, agentId);
  if (!result.suspicious) return null;

  // fire-and-forget：不 await，立即返回拦截响应
  const userPromise = preVerifiedUser
    ? Promise.resolve({ userId: preVerifiedUser.userId || userId, username: preVerifiedUser.username, displayName: preVerifiedUser.displayName })
    : extractAuthUser(request, userId);
  userPromise.then(user => {
    return logSecurityEvent({
      event_type: "suspicious_behavior",
      risk_level: "medium",
      ip: secIP,
      user_agent: getSecUA(request),
      path: "/api/llm",
      method: "POST",
      details: result.reason || `频繁切换智能体: ${result.switchCount}次/${result.uniqueAgents}个`,
      blocked: true,
      user_id: user.userId,
      username: user.username,
      display_name: user.displayName,
    });
  }).catch(() => {});

  return new Response(
    JSON.stringify({ error: "操作过于频繁，请稍后再试", code: "SUSPICIOUS_BEHAVIOR" }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * 安全防护3：API滥用检测（短时间大量请求）
 * v2 优化：安全事件记录改为 fire-and-forget，不阻塞响应返回
 * v3 优化：支持 preVerifiedUser 避免重复 JWT 解码
 */
export async function checkApiAbuse(
  request: Request,
  userId?: string,
  preVerifiedUser?: PreVerifiedAuthUser
): Promise<SecurityCheckResult> {
  const secIP = getSecIP(request);
  const result = detectApiAbuse(secIP, "POST", "/api/llm", userId);
  if (!result.abuse) return null;

  // fire-and-forget：不 await，立即返回拦截响应
  const userPromise = preVerifiedUser
    ? Promise.resolve({ userId: preVerifiedUser.userId || userId, username: preVerifiedUser.username, displayName: preVerifiedUser.displayName })
    : extractAuthUser(request, userId);
  userPromise.then(user => {
    trackIPSecurityEvent(secIP, result.riskLevel);
    return logSecurityEvent({
      event_type: "api_abuse",
      risk_level: result.riskLevel,
      ip: secIP,
      user_agent: getSecUA(request),
      path: "/api/llm",
      method: "POST",
      details: `5分钟内${result.count}次聊天请求（阈值${result.limit}次）`,
      blocked: true,
      user_id: user.userId,
      username: user.username,
      display_name: user.displayName,
    });
  }).catch(() => {});

  return new Response(
    JSON.stringify({ error: "请求次数过多，请稍后再试", code: "API_ABUSE" }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * 一站式安全检查：三层防护并行执行，任一拦截即返回错误 Response
 * v2 优化：并行执行注入检测+行为检测+滥用检测，减少串行等待时间
 * v3 优化：支持 preVerifiedUser 避免重复 JWT 解码（从5次降到0次）
 * 全部通过返回 null
 */
export async function runSecurityChecks(
  body: Record<string, unknown>,
  request: Request,
  options: SecurityCheckOptions
): Promise<SecurityCheckResult> {
  // 并行执行三项安全检查，减少串行等待
  const [injectionResult, switchResult, abuseResult] = await Promise.all([
    checkBodyInjection(body, request, options.skipFields, options.userId, options.preVerifiedUser),
    checkAgentSwitchAbuse(request, options.agentId, options.userId, options.preVerifiedUser),
    checkApiAbuse(request, options.userId, options.preVerifiedUser),
  ]);

  // 按优先级返回拦截结果：注入 > 行为 > 滥用
  if (injectionResult) return injectionResult;
  if (switchResult) return switchResult;
  if (abuseResult) return abuseResult;

  return null;
}
