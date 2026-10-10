import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export class WhiteLabelHostError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "WhiteLabelHostError";
  }
}

// Current platform-owned public names are an explicit safe-default allowlist.
// Deployments may add names through PLATFORM_CANONICAL_HOSTS without turning
// arbitrary Host values into a platform fallback.
export const PLATFORM_BASELINE_HOSTS = [
  "zycheni9.com",
  "www.zycheni9.com",
  "zyuani8.com",
  "www.zyuani8.com",
] as const;

function validPort(value: string): boolean {
  if (!/^\d{1,5}$/u.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

export function normalizeDirectHostHeader(rawValue: string | null): string {
  if (!rawValue) throw new WhiteLabelHostError("请求缺少 Host", "BRAND_HOST_REQUIRED", 400);
  if (rawValue !== rawValue.trim() || /[\u0000-\u0020\u007f,/@\\]/u.test(rawValue) || rawValue.includes("://")) {
    throw new WhiteLabelHostError("Host 格式无效", "BRAND_HOST_INVALID", 400);
  }

  let hostname = rawValue;
  if (rawValue.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(rawValue);
    if (!match || (match[2] && !validPort(match[2])) || isIP(match[1]) !== 6) {
      throw new WhiteLabelHostError("Host 格式无效", "BRAND_HOST_INVALID", 400);
    }
    hostname = match[1].toLowerCase();
  } else {
    const colonCount = [...rawValue].filter((value) => value === ":").length;
    if (colonCount > 1) throw new WhiteLabelHostError("Host 格式无效", "BRAND_HOST_INVALID", 400);
    if (colonCount === 1) {
      const separator = rawValue.lastIndexOf(":");
      const port = rawValue.slice(separator + 1);
      if (!validPort(port)) throw new WhiteLabelHostError("Host 端口无效", "BRAND_HOST_INVALID", 400);
      hostname = rawValue.slice(0, separator);
    }
    hostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    hostname = domainToASCII(hostname.toLowerCase());
  }

  if (!hostname || hostname.length > 253) {
    throw new WhiteLabelHostError("Host 格式无效", "BRAND_HOST_INVALID", 400);
  }
  if (isIP(hostname)) return hostname;
  const labels = hostname.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
    throw new WhiteLabelHostError("Host 格式无效", "BRAND_HOST_INVALID", 400);
  }
  return hostname;
}

function configuredHost(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    if (candidate.includes("://")) return normalizeDirectHostHeader(new URL(candidate).host);
    return normalizeDirectHostHeader(candidate);
  } catch {
    return null;
  }
}

export function platformDisplayHosts(environment: Readonly<Record<string, string | undefined>> = process.env): ReadonlySet<string> {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "::1", ...PLATFORM_BASELINE_HOSTS]);
  const candidates = [
    ...(environment.PLATFORM_CANONICAL_HOSTS || "").split(","),
    environment.APP_BASE_URL || "",
    environment.NEXT_PUBLIC_SITE_URL || "",
    environment.WHITE_LABEL_CNAME_TARGET || "",
  ];
  for (const candidate of candidates) {
    const host = configuredHost(candidate);
    if (host) hosts.add(host);
  }
  return hosts;
}

export function isPlatformDisplayHost(hostname: string, environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return platformDisplayHosts(environment).has(hostname);
}
