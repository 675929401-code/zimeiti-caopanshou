import "server-only";

import crypto from "node:crypto";
import { isIP } from "node:net";

import { maskSecurityPhone } from "@/lib/security-event-display";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const CORRELATION_SAMPLE_LIMIT = 500;

type AddressFamily = "ipv4" | "ipv6" | "unknown";
export type NetworkScope = "loopback" | "private" | "link_local" | "public" | "reserved" | "invalid" | "unknown";

type SecurityEventRow = {
  id: string;
  event_type: string;
  risk_level: string;
  ip_address?: string | null;
  ip_hash?: string | null;
  user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
  phone?: string | null;
  user_agent?: string | null;
  path?: string | null;
  method?: string | null;
  details?: string | null;
  blocked?: boolean | null;
  source?: string | null;
  created_at: string;
  reliable_ingest_id?: string | null;
  event_fingerprint?: string | null;
  occurrence_count?: number | null;
  first_observed_at?: string | null;
  last_observed_at?: string | null;
  privacy_version?: string | null;
};

type UserRow = {
  id: string;
  username?: string | null;
  display_name?: string | null;
  phone?: string | null;
  email?: string | null;
  role?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  member_status?: string | null;
};

type RelatedEventRow = {
  event_type?: string | null;
  risk_level?: string | null;
  blocked?: boolean | null;
  created_at?: string | null;
};

export type SessionEvidence = {
  status: "matched_at_event_time" | "not_matched" | "not_applicable" | "unavailable";
  matchingSessions: number;
};

export type InvestigationActorInput = {
  event: Pick<SecurityEventRow, "path" | "details" | "source" | "user_id">;
  account: UserRow | null;
  networkScope: NetworkScope;
  sessionEvidence: SessionEvidence;
};

export class SecurityEventInvestigationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SecurityEventInvestigationError";
  }
}

function boundedText(value: unknown, maximum = 240): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum)
    : "";
}

function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || !/^\d{1,3}$/u.test(parts[index]))) {
    return null;
  }
  return octets as [number, number, number, number];
}

function classifyIPv4(value: string): NetworkScope {
  const octets = parseIPv4(value);
  if (!octets) return "invalid";
  const [first, second, third] = octets;
  if (first === 127) return "loopback";
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return "private";
  if (first === 169 && second === 254) return "link_local";
  if (
    first === 0
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224
  ) return "reserved";
  return "public";
}

function classifyIPv6(value: string): NetworkScope {
  const normalized = value.toLowerCase();
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "reserved";
  const mapped = normalized.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (mapped) return classifyIPv4(mapped);
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return "link_local";
  if (normalized.startsWith("2001:db8:")) return "reserved";
  if (normalized.startsWith("ff")) return "reserved";
  return "public";
}

export function analyzeStoredIp(rawValue: unknown, ipHashValue?: unknown) {
  const raw = boundedText(rawValue, 100);
  const ipHash = boundedText(ipHashValue, 64) || null;
  const absentMarker = !raw || raw === "unknown" || raw === "api";
  if (absentMarker) {
    return {
      ipAddress: null,
      ipAvailability: "unavailable" as const,
      ipUnavailableReason: ipHash ? "privacy_preserving_hash_only" : "not_recorded",
      ipHash,
      addressFamily: "unknown" as AddressFamily,
      scope: "unknown" as NetworkScope,
      captureSource: ipHash ? "privacy_preserving_hash_only" as const : "missing" as const,
      trust: ipHash ? "hashed_only" as const : "unavailable" as const,
      proxyChain: null,
      proxyChainStatus: "not_recorded" as const,
    };
  }

  const family = isIP(raw);
  if (family === 0) {
    return {
      ipAddress: null,
      ipAvailability: "unavailable" as const,
      ipUnavailableReason: "invalid_or_non_ip_value",
      ipHash,
      addressFamily: "unknown" as AddressFamily,
      scope: "invalid" as NetworkScope,
      captureSource: "missing" as const,
      trust: "unavailable" as const,
      proxyChain: null,
      proxyChainStatus: "not_recorded" as const,
    };
  }

  return {
    ipAddress: raw,
    ipAvailability: "available" as const,
    ipUnavailableReason: null,
    ipHash,
    addressFamily: (family === 4 ? "ipv4" : "ipv6") as AddressFamily,
    scope: family === 4 ? classifyIPv4(raw) : classifyIPv6(raw),
    captureSource: "legacy_event_ip" as const,
    trust: "unverified_legacy" as const,
    proxyChain: null,
    proxyChainStatus: "not_recorded" as const,
  };
}

export function describeLocation(network: ReturnType<typeof analyzeStoredIp>) {
  if (network.ipAvailability === "unavailable") {
    return {
      status: network.scope === "invalid" ? "unavailable_invalid_ip" as const : "unavailable_no_ip" as const,
      country: null,
      province: null,
      city: null,
      county: null,
      source: "none" as const,
      precision: "none" as const,
      statement: network.ipUnavailableReason === "privacy_preserving_hash_only"
        ? "该事件只保存了不可逆 IP 哈希，无法还原原始地址或省市县。"
        : "事件没有可用的原始 IP，无法定位省市县。",
      lookedUpAt: null,
    };
  }
  if (network.scope !== "public") {
    const scopeLabel: Record<Exclude<NetworkScope, "public" | "invalid" | "unknown">, string> = {
      loopback: "本机回环",
      private: "内网",
      link_local: "链路本地",
      reserved: "保留或测试网段",
    };
    return {
      status: "not_applicable_local" as const,
      country: null,
      province: null,
      city: null,
      county: null,
      source: "network_scope_classifier" as const,
      precision: "network_scope_only" as const,
      statement: `${scopeLabel[network.scope as keyof typeof scopeLabel] || "非公网"}地址不能据此定位到省、市或县；若部署了反向代理，应检查代理是否正确传递客户端地址。`,
      lookedUpAt: null,
    };
  }
  return {
    status: "provider_not_configured" as const,
    country: null,
    province: null,
    city: null,
    county: null,
    source: "none" as const,
    precision: "none" as const,
    statement: "已取得公网 IP，但当前没有配置可信的离线地理库；本接口不会把第三方猜测伪装成省市县结论。",
    lookedUpAt: null,
  };
}

function versionFromMatch(value: string, expression: RegExp): string | null {
  return value.match(expression)?.[1]?.replace(/_/gu, ".") || null;
}

export function analyzeUserAgent(rawValue: unknown) {
  const rawUserAgent = boundedText(rawValue, 500) || null;
  if (!rawUserAgent || rawUserAgent === "unknown" || rawUserAgent.startsWith("hash:")) {
    return {
      rawUserAgent,
      deviceType: "unknown",
      browser: { name: "未知", version: null },
      os: { name: "未知", version: null },
      automation: { suspected: false, signals: [] as string[] },
      parser: "server_heuristics_v1" as const,
    };
  }

  const signals: string[] = [];
  const automationPatterns: Array<[RegExp, string]> = [
    [/HeadlessChrome/iu, "HeadlessChrome"],
    [/Playwright/iu, "Playwright"],
    [/Puppeteer/iu, "Puppeteer"],
    [/Selenium|WebDriver/iu, "WebDriver"],
    [/PhantomJS/iu, "PhantomJS"],
    [/\b(?:bot|crawler|spider|slurp)\b/iu, "Bot/Crawler"],
    [/curl\//iu, "curl"],
    [/Wget\//iu, "Wget"],
    [/python-requests|aiohttp|httpclient/iu, "Scripted HTTP client"],
    [/PostmanRuntime/iu, "Postman"],
  ];
  for (const [pattern, label] of automationPatterns) if (pattern.test(rawUserAgent)) signals.push(label);

  let browser = { name: "未知", version: null as string | null };
  if (/Edg(?:A|iOS)?\//iu.test(rawUserAgent)) browser = { name: "Edge", version: versionFromMatch(rawUserAgent, /Edg(?:A|iOS)?\/([\d.]+)/iu) };
  else if (/(?:Chrome|CriOS)\//iu.test(rawUserAgent)) browser = { name: "Chrome", version: versionFromMatch(rawUserAgent, /(?:Chrome|CriOS)\/([\d.]+)/iu) };
  else if (/(?:Firefox|FxiOS)\//iu.test(rawUserAgent)) browser = { name: "Firefox", version: versionFromMatch(rawUserAgent, /(?:Firefox|FxiOS)\/([\d.]+)/iu) };
  else if (/Version\/[\d.]+.*Safari\//iu.test(rawUserAgent)) browser = { name: "Safari", version: versionFromMatch(rawUserAgent, /Version\/([\d.]+)/iu) };
  else if (/curl\//iu.test(rawUserAgent)) browser = { name: "curl", version: versionFromMatch(rawUserAgent, /curl\/([\d.]+)/iu) };
  else if (/PostmanRuntime\//iu.test(rawUserAgent)) browser = { name: "Postman", version: versionFromMatch(rawUserAgent, /PostmanRuntime\/([\d.]+)/iu) };

  let os = { name: "未知", version: null as string | null };
  if (/Windows NT/iu.test(rawUserAgent)) os = { name: "Windows", version: versionFromMatch(rawUserAgent, /Windows NT ([\d.]+)/iu) };
  else if (/Android/iu.test(rawUserAgent)) os = { name: "Android", version: versionFromMatch(rawUserAgent, /Android ([\d._]+)/iu) };
  else if (/(?:iPhone|iPad).*OS /iu.test(rawUserAgent)) os = { name: /iPad/iu.test(rawUserAgent) ? "iPadOS" : "iOS", version: versionFromMatch(rawUserAgent, /OS ([\d_]+)/iu) };
  else if (/Mac OS X/iu.test(rawUserAgent)) os = { name: "macOS", version: versionFromMatch(rawUserAgent, /Mac OS X ([\d_]+)/iu) };
  else if (/Linux/iu.test(rawUserAgent)) os = { name: "Linux", version: null };

  const deviceType = /iPad|Tablet/iu.test(rawUserAgent)
    ? "tablet"
    : /Mobile|Android|iPhone/iu.test(rawUserAgent)
      ? "mobile"
      : signals.length > 0 && browser.name !== "Chrome" && browser.name !== "Edge"
        ? "server_or_script"
        : os.name !== "未知"
          ? "desktop"
          : "unknown";

  return {
    rawUserAgent,
    deviceType,
    browser,
    os,
    automation: { suspected: signals.length > 0, signals },
    parser: "server_heuristics_v1" as const,
  };
}

function maskEmail(value: unknown): string | null {
  const email = boundedText(value, 254);
  const separator = email.indexOf("@");
  if (separator <= 0) return null;
  return `${email[0]}***${email.slice(separator)}`;
}

function accountSnapshot(account: UserRow | null) {
  if (!account) return null;
  return {
    id: account.id,
    username: boundedText(account.username, 100) || null,
    displayName: boundedText(account.display_name, 160) || null,
    role: account.role === "admin" ? "admin" : "student",
    status: boundedText(account.status, 40) || (account.is_active === false ? "disabled" : "active"),
    memberStatus: boundedText(account.member_status, 40) || null,
    phoneMasked: maskSecurityPhone(account.phone),
    emailMasked: maskEmail(account.email),
  };
}

function isLoginAttempt(event: Pick<SecurityEventRow, "path" | "details">): boolean {
  return boundedText(event.path, 500).replace(/\/+$/u, "") === "/api/auth/login"
    || /login failed/iu.test(boundedText(event.details, 500));
}

export function classifyInvestigationActor(input: InvestigationActorInput) {
  const account = accountSnapshot(input.account);
  if (account) {
    const administrator = account.role === "admin";
    if (isLoginAttempt(input.event)) {
      return {
        classification: administrator ? "targeting_administrator" as const : "targeting_registered_student" as const,
        label: administrator ? "未知来源正在尝试管理员账号" : "未知来源正在尝试已注册学员账号",
        confidence: "high" as const,
        relationship: "account_target_only" as const,
        account,
        evidence: [
          "事件命中了现有账号，但发生在失败登录链路。",
          "账号被命中只证明它是登录目标，不能证明账号本人发起了尝试。",
        ],
      };
    }
    if (input.sessionEvidence.status === "matched_at_event_time") {
      return {
        classification: administrator ? "administrator" as const : "registered_student" as const,
        label: administrator ? "管理员账号关联请求" : "已注册学员账号关联请求",
        confidence: "medium" as const,
        relationship: "session_telemetry_match" as const,
        account,
        evidence: [
          "事件账号、IP 哈希、UA 哈希与事件发生时有效的登录会话一致。",
          "历史事件没有保存会话 ID，因此仍属于强关联证据，不是对自然人的绝对身份证明。",
        ],
      };
    }
    return {
      classification: administrator ? "targeting_administrator" as const : "targeting_registered_student" as const,
      label: administrator ? "关联管理员账号，操作者未证实" : "关联学员账号，操作者未证实",
      confidence: "low" as const,
      relationship: "historical_event_reference" as const,
      account,
      evidence: [
        "历史事件包含账号引用，但没有可核验的同会话证据。",
        "不能据此把事件直接归因给账号本人。",
      ],
    };
  }

  if (boundedText(input.event.user_id, 100)) {
    return {
      classification: "historical_account" as const,
      label: "历史或已删除账号引用",
      confidence: "medium" as const,
      relationship: "historical_event_reference" as const,
      account: null,
      evidence: ["事件保留了账号引用，但当前用户表中已无法找到该账号。"],
    };
  }
  if (["loopback", "private", "link_local", "reserved"].includes(input.networkScope)) {
    return {
      classification: "internal_or_proxy" as const,
      label: "本机、内网或代理链来源",
      confidence: "high" as const,
      relationship: "no_account_reference" as const,
      account: null,
      evidence: ["网络地址属于不可公网归属的本机、内网、链路本地或保留范围。"],
    };
  }
  if (input.networkScope === "public") {
    return {
      classification: "external_visitor" as const,
      label: "外部或未登录来源，身份未证实",
      confidence: "medium" as const,
      relationship: "no_account_reference" as const,
      account: null,
      evidence: ["事件带有公网 IP，但没有已验证的平台账号关联；VPN、共享出口和代理仍可能改变归属。"],
    };
  }
  return {
    classification: "unknown" as const,
    label: "身份线索不足",
    confidence: "unavailable" as const,
    relationship: "no_account_reference" as const,
    account: null,
    evidence: ["事件没有足够的账号或网络证据用于归因。"],
  };
}

function emptyCorrelation() {
  return {
    matchedBy: "none",
    total: 0,
    highOrCritical: 0,
    blocked: 0,
    firstSeenAt: null as string | null,
    lastSeenAt: null as string | null,
    topEventTypes: [] as Array<{ type: string; count: number }>,
    sampleCapped: false,
  };
}

function summarizeCorrelation(rows: RelatedEventRow[], total: number, matchedBy: string) {
  const typeCounts = new Map<string, number>();
  let highOrCritical = 0;
  let blocked = 0;
  let firstSeenAt: string | null = null;
  let lastSeenAt: string | null = null;
  for (const row of rows) {
    const eventType = boundedText(row.event_type, 80) || "unknown";
    typeCounts.set(eventType, (typeCounts.get(eventType) || 0) + 1);
    if (row.risk_level === "high" || row.risk_level === "critical") highOrCritical += 1;
    if (row.blocked === true) blocked += 1;
    const occurredAt = boundedText(row.created_at, 80);
    if (occurredAt && (!firstSeenAt || occurredAt < firstSeenAt)) firstSeenAt = occurredAt;
    if (occurredAt && (!lastSeenAt || occurredAt > lastSeenAt)) lastSeenAt = occurredAt;
  }
  return {
    matchedBy,
    total,
    highOrCritical,
    blocked,
    firstSeenAt,
    lastSeenAt,
    topEventTypes: [...typeCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([type, count]) => ({ type, count })),
    sampleCapped: total > rows.length,
  };
}

async function readCorrelation(
  field: "ip_hash" | "ip_address" | "user_id",
  value: string | null,
): Promise<{ summary: ReturnType<typeof emptyCorrelation>; error: boolean }> {
  if (!value) return { summary: emptyCorrelation(), error: false };
  try {
    const { data, count, error } = await getSupabaseAdminClient()
      .from("security_events")
      .select("event_type,risk_level,blocked,created_at", { count: "exact" })
      .eq(field, value)
      .order("created_at", { ascending: false })
      .limit(CORRELATION_SAMPLE_LIMIT);
    if (error) throw error;
    const rows = (data || []) as RelatedEventRow[];
    return {
      summary: summarizeCorrelation(rows, typeof count === "number" ? count : rows.length, field),
      error: false,
    };
  } catch {
    return { summary: emptyCorrelation(), error: true };
  }
}

async function readSessionEvidence(event: SecurityEventRow): Promise<{ evidence: SessionEvidence; error: boolean }> {
  const userId = boundedText(event.user_id, 100);
  const ipHash = boundedText(event.ip_hash, 64);
  const userAgent = boundedText(event.user_agent, 500);
  if (!userId || isLoginAttempt(event)) {
    return { evidence: { status: "not_applicable", matchingSessions: 0 }, error: false };
  }
  if (!ipHash || !userAgent || userAgent.startsWith("hash:")) {
    return { evidence: { status: "unavailable", matchingSessions: 0 }, error: false };
  }
  const userAgentHash = crypto.createHash("sha256").update(userAgent).digest("hex").substring(0, 32);
  try {
    const { data, error } = await getSupabaseAdminClient()
      .from("user_auth_sessions")
      .select("created_at,expires_at,revoked_at")
      .eq("user_id", userId)
      .eq("ip_hash", ipHash)
      .eq("user_agent_hash", userAgentHash)
      .lte("created_at", event.created_at)
      .gt("expires_at", event.created_at)
      .limit(20);
    if (error) throw error;
    const eventTime = Date.parse(event.created_at);
    const matches = (data || []).filter((row: { revoked_at?: string | null }) => (
      !row.revoked_at || Date.parse(row.revoked_at) > eventTime
    )).length;
    return {
      evidence: { status: matches > 0 ? "matched_at_event_time" : "not_matched", matchingSessions: matches },
      error: false,
    };
  } catch {
    return { evidence: { status: "unavailable", matchingSessions: 0 }, error: true };
  }
}

async function readAccount(userId: string): Promise<{ account: UserRow | null; error: boolean }> {
  if (!userId || userId === "unknown") return { account: null, error: false };
  try {
    const { data, error } = await getSupabaseAdminClient()
      .from("users")
      .select("id,username,display_name,phone,email,role,status,is_active,member_status")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    return { account: (data as UserRow | null) || null, error: false };
  } catch {
    return { account: null, error: true };
  }
}

export async function readSecurityEventInvestigation(eventId: string) {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("security_events")
    .select("id,event_type,risk_level,ip_address,ip_hash,user_id,username,display_name,phone,user_agent,path,method,details,blocked,source,created_at,reliable_ingest_id,event_fingerprint,occurrence_count,first_observed_at,last_observed_at,privacy_version")
    .eq("id", eventId)
    .maybeSingle();
  if (error) {
    throw new SecurityEventInvestigationError("安全事件调查数据暂不可用", "SECURITY_INVESTIGATION_UNAVAILABLE", 503);
  }
  if (!data) {
    throw new SecurityEventInvestigationError("安全事件不存在", "SECURITY_EVENT_NOT_FOUND", 404);
  }

  const event = data as SecurityEventRow;
  const network = analyzeStoredIp(event.ip_address, event.ip_hash);
  const userId = boundedText(event.user_id, 100);
  const [accountResult, sessionResult, networkCorrelationResult, accountCorrelationResult] = await Promise.all([
    readAccount(userId),
    readSessionEvidence(event),
    readCorrelation(network.ipHash ? "ip_hash" : network.ipAddress ? "ip_address" : "ip_hash", network.ipHash || network.ipAddress),
    readCorrelation("user_id", userId || null),
  ]);

  const limitations = ["历史事件未保存可信代理链，不能判断每一跳代理或 CDN。"];
  if (!network.ipAddress) limitations.push("原始 IP 不可用，只能使用已保存的哈希或其他线索。 ".trim());
  if (accountResult.error) limitations.push("当前账号档案读取失败，账号归因可能不完整。");
  if (sessionResult.error || sessionResult.evidence.status === "unavailable") limitations.push("事件与登录会话的匹配证据不可用或不完整。");
  if (networkCorrelationResult.error) limitations.push("同网络线索的关联统计读取失败。");
  if (accountCorrelationResult.error) limitations.push("同账号线索的关联统计读取失败。");
  if (network.scope === "public") limitations.push("未配置可信离线 IP 地理库，省市县保持未知。");

  return {
    event: {
      id: event.id,
      type: boundedText(event.event_type, 80) || "unknown",
      riskLevel: boundedText(event.risk_level, 32) || "unknown",
      source: boundedText(event.source, 80) || "unknown",
      path: boundedText(event.path, 500) || null,
      method: boundedText(event.method, 16) || null,
      blocked: event.blocked === true,
      occurredAt: event.created_at,
      occurrenceCount: Number(event.occurrence_count || 1),
      firstObservedAt: boundedText(event.first_observed_at, 80) || event.created_at,
      lastObservedAt: boundedText(event.last_observed_at, 80) || event.created_at,
      fingerprint: boundedText(event.event_fingerprint, 64) || null,
      privacyVersion: boundedText(event.privacy_version, 32) || "legacy",
    },
    actor: classifyInvestigationActor({
      event,
      account: accountResult.account,
      networkScope: network.scope,
      sessionEvidence: sessionResult.evidence,
    }),
    network,
    location: describeLocation(network),
    client: analyzeUserAgent(event.user_agent),
    correlations: {
      byNetwork: networkCorrelationResult.summary,
      byAccount: accountCorrelationResult.summary,
      sessionEvidence: sessionResult.evidence,
    },
    evidenceQuality: {
      status: !network.ipAddress && !accountResult.account ? "limited" as const : limitations.length > 0 ? "partial" as const : "complete" as const,
      limitations,
      rawIpStored: Boolean(network.ipAddress),
      exactLocationAvailable: false,
      proxyChainRecorded: false,
    },
  };
}
