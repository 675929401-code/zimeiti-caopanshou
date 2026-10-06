import { isAutodlComfyuiHostedProtocol } from "@/lib/video-autodl-comfyui-workflow";
import { assertAutodlHostedResultUrl } from "@/lib/video-persistence";

type JsonObject = Record<string, unknown>;

type VideoProviderResultModel = {
  protocolType?: unknown;
  apiProtocolConfig?: unknown;
  apiEndpoint?: unknown;
};

const GAORUI_RESULT_HOSTNAMES = new Set([
  "ark-acg-cn-beijing.tos-cn-beijing.volces.com",
  "file-proxy.gaorui.cc",
  "file-proxy.quillbox.win",
  "file-proxy2.quillbox.win",
  "media-9000.gaorui.cc",
  "media-r2-pg-us.quillbox.win",
  "oss-us.file-download.life",
]);

const SECURE_SKILL_RESULT_HOSTNAMES = new Set([
  "flow.secure-skill.com",
  "source.openclaw-token.shop",
]);

const SECURE_SKILL_FLOW_RESULT_HOSTNAMES = new Set([
  "flow-content.google",
]);

const LCONAI_ENDPOINT_HOSTNAMES = new Set([
  "n.lconai.com",
  "s.lconai.com",
]);

const LCONAI_RESULT_HOSTNAMES = new Set([
  "cdn.openaicn.com",
]);

const RESULT_HOSTNAME_CONFIG_KEYS = [
  "result_hostnames",
  "resultHostnames",
  "trusted_result_hostnames",
  "trustedResultHostnames",
] as const;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function isSafeConfiguredHostname(value: string) {
  const hostname = value.trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  if (!hostname || hostname.length > 253) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname.includes(":")) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname);
}

function configuredResultHostnames(value: unknown) {
  const config = asObject(value);
  const hostnames = new Set<string>();
  for (const key of RESULT_HOSTNAME_CONFIG_KEYS) {
    const raw = config[key];
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    for (const item of values) {
      const hostname = String(item || "").trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
      if (isSafeConfiguredHostname(hostname)) hostnames.add(hostname);
    }
  }
  return hostnames;
}

function assertDirectProviderVideoUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("VIDEO_PROVIDER_RESULT_URL_INVALID");
  }
  if (parsed.protocol !== "https:") throw new Error("VIDEO_PROVIDER_RESULT_HTTPS_REQUIRED");
  if (parsed.username || parsed.password) throw new Error("VIDEO_PROVIDER_RESULT_CREDENTIALS_FORBIDDEN");
  if (parsed.port) throw new Error("VIDEO_PROVIDER_RESULT_PORT_FORBIDDEN");
  if (parsed.hash) throw new Error("VIDEO_PROVIDER_RESULT_FRAGMENT_FORBIDDEN");
  if (!parsed.pathname || parsed.pathname === "/") throw new Error("VIDEO_PROVIDER_RESULT_MEDIA_PATH_REQUIRED");
  return parsed;
}

/**
 * Return the exact provider-result hostname that may bypass a false private-IP
 * DNS answer (for example Clash/TUN fake-IP mode). Unknown protocols still use
 * the normal DNS/public-IP SSRF checks and therefore return an empty string.
 *
 * The exception is deliberately model/protocol scoped: HTTPS only, no
 * credentials/port/fragment, a video-file path, and an exact configured or
 * protocol-owned hostname. A hostname is never trusted merely because it was
 * stored in video_tasks.
 */
export function trustedVideoProviderResultHostname(
  value: string,
  model: VideoProviderResultModel,
) {
  const protocolType = String(model.protocolType || "").trim().toLowerCase();
  if (isAutodlComfyuiHostedProtocol(protocolType)) {
    return assertAutodlHostedResultUrl(value).hostname.toLowerCase();
  }

  const parsed = assertDirectProviderVideoUrl(value);
  const allowed = configuredResultHostnames(model.apiProtocolConfig);
  if (protocolType === "gaorui_video") {
    for (const hostname of GAORUI_RESULT_HOSTNAMES) allowed.add(hostname);
  }
  if (protocolType.startsWith("secure_skill_")) {
    for (const hostname of SECURE_SKILL_RESULT_HOSTNAMES) allowed.add(hostname);
  }
  if (protocolType === "secure_skill_flow_jobs") {
    for (const hostname of SECURE_SKILL_FLOW_RESULT_HOSTNAMES) allowed.add(hostname);
  }
  let endpointHostname = "";
  try {
    endpointHostname = new URL(String(model.apiEndpoint || "")).hostname.toLowerCase();
  } catch {
    endpointHostname = "";
  }
  if (protocolType === "newapi_video" && LCONAI_ENDPOINT_HOSTNAMES.has(endpointHostname)) {
    for (const hostname of LCONAI_RESULT_HOSTNAMES) allowed.add(hostname);
  }

  // Unknown providers receive no DNS bypass. validateSafeUrl/safeMediaFetch
  // will still accept them when they resolve to a real public address.
  if (allowed.size === 0) return "";

  const hostname = parsed.hostname.toLowerCase();
  if (!allowed.has(hostname)) throw new Error("VIDEO_PROVIDER_RESULT_HOST_FORBIDDEN");
  return hostname;
}
