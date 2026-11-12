import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readServerOnlySecretFile, createDefaultServerSecretFilePolicy } from "@/lib/server-secret";
import { NATIVE_OFFICIAL_API_PLATFORMS } from "@/lib/publishing-native";

/** Directory fallback only. No remote availability, connection or execution is inferred. */
export function readStaticPublishingPlatformCatalog() {
  return NATIVE_OFFICIAL_API_PLATFORMS.map(item => ({
    platform: item.platform, displayName: { "zh-CN": item.name, "en-US": item.name },
    logoUrl: "", status: "unavailable", authType: item.platform === "xhs" || item.platform === "wxSph" ? "plugin" : item.platform === "douyin" ? "qrcode" : "oauth2",
    editor: "none", contentLimits: {}, mediaRules: {}, topic: { supported: false },
    capabilities: { auth: {}, publish: { supported: false }, analytics: {}, engagement: {}, work: {}, browse: {}, webhook: {} }, optionSchema: { type: "object", additionalProperties: false },
    authInstructions: { "zh-CN": "目录已保留；请管理员配置连接并核验平台能力后授权。", "en-US": "Directory only. Configure and verify the connection before authorizing." },
  }));
}

export const PUBLISHING_OFFICIAL_LINKS = {
  domesticKeys: "https://aitoearn.cn/zh-CN/developer/api-keys",
  internationalKeys: "https://aitoearn.ai/developer/api-keys",
  keyGuide: "https://docs.aitoearn.ai/zh/use/api-key",
  publishingGuide: "https://docs.aitoearn.ai/zh/use/publish-flow",
  pricing: "https://aitoearn.ai/pricing#pricing-table-social-publishing",
} as const;
let cached: { signature: string; key: string; until: number } | undefined;
function valid(value: string): string { if (value.length < 8 || value.length > 8192 || /[\r\n\u0000]/.test(value)) throw new Error("PUBLISHING_CREDENTIAL_INVALID"); return value; }

/** Registered DPAPI staging only. Never searches arbitrary files or exports a credential. */
function localCredential(environment: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  // The standalone server changes cwd to .next/standalone. The approved local
  // launcher already supplies the exact source root; it is never an HTTP input.
  const sourceRoot = process.env.LOCAL_ACCEPTANCE_SOURCE_ROOT?.trim() || process.cwd();
  if (!path.isAbsolute(sourceRoot)) return undefined;
  const root = path.resolve(sourceRoot, "../../..");
  if (!fs.existsSync(path.join(root, "99_系统协议", "凭据速查.txt"))) return undefined;
  const directory = path.join(root, "运行数据", "自媒体操盘手", "controlled-credentials", "infisical", "staging");
  if (!fs.existsSync(directory)) return undefined;
  const matches = fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}\.metadata\.json$/.test(name)).flatMap(name => {
    try { const metadata = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8").replace(/^\uFEFF/, "")); return metadata.sourceId === "windows-controlled-credentials" && metadata.environment === "development" && metadata.logicalName === `aitoearn-${environment}-api-key` && `${metadata.stageId}.metadata.json` === name ? [metadata.stageId as string] : []; } catch { return []; }
  });
  if (matches.length > 1) throw new Error("PUBLISHING_CREDENTIAL_AMBIGUOUS");
  if (matches.length !== 1) return undefined;
  const file = path.join(directory, `${matches[0]}.dpapi.txt`);
  if (!fs.existsSync(file)) return undefined;
  const signature = `${file}:${fs.statSync(file).mtimeMs}`;
  if (cached?.signature === signature && cached.until > Date.now()) return cached.key;
  const command = "$ErrorActionPreference='Stop'; Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s=ConvertTo-SecureString ([IO.File]::ReadAllText($env:PUBLISHING_DPAPI_PATH).Trim()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p);$s.Dispose()}";
  const key = valid(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", env: { ...process.env, PUBLISHING_DPAPI_PATH: file }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim());
  cached = { signature, key, until: Date.now() + 60000 }; return key;
}
export type PublishingProviderEnvironment = "domestic" | "international";

export const OVERSEAS_PUBLISHING_PLATFORMS = new Set([
  "youtube", "tiktok", "twitter", "facebook", "instagram", "threads", "pinterest", "linkedin",
]);

export function providerEnvironmentForPlatform(platform: string): PublishingProviderEnvironment {
  return OVERSEAS_PUBLISHING_PLATFORMS.has(String(platform)) ? "international" : "domestic";
}

export function readPublishingProviderConfiguration(requestedEnvironment?: PublishingProviderEnvironment) {
  const environment = requestedEnvironment ?? (process.env.PUBLISHING_AITO_ENVIRONMENT === "international" ? "international" as const : "domestic" as const);
  let apiKey: string | undefined;
  let credentialSource: "environment" | "secret_file" | "dpapi" | "missing" = "missing";
  let credentialIssue: "unavailable" | "ambiguous" | null = null;
  try {
    const file = environment === "international"
      ? (process.env.PUBLISHING_AITO_INTERNATIONAL_API_KEY_FILE?.trim() || process.env.PUBLISHING_AITO_API_KEY_FILE?.trim())
      : process.env.PUBLISHING_AITO_API_KEY_FILE?.trim();
    const environmentKey = environment === "international"
      ? (process.env.PUBLISHING_AITO_INTERNATIONAL_API_KEY?.trim() || process.env.PUBLISHING_AITO_API_KEY?.trim())
      : process.env.PUBLISHING_AITO_API_KEY?.trim();
    if (file) { credentialSource = "secret_file"; apiKey = valid(readServerOnlySecretFile({ filePath: file, errorLabel: "PUBLISHING_AITO_SECRET", policy: createDefaultServerSecretFilePolicy(process.platform) }).trim()); }
    else if (environmentKey) { credentialSource = "environment"; apiKey = valid(environmentKey); }
    else { apiKey = localCredential(environment); credentialSource = apiKey ? "dpapi" : "missing"; }
  } catch (error) { apiKey = undefined; credentialIssue = error instanceof Error && error.message === "PUBLISHING_CREDENTIAL_AMBIGUOUS" ? "ambiguous" : "unavailable"; }
  return { environment, apiKey, credentialSource, credentialIssue, configured: Boolean(apiKey), namespace: `${environment}:${apiKey ? createHash("sha256").update(`aitoearn:${apiKey}`).digest("hex").slice(0, 24) : "unconfigured"}` };
}

export function readPublishingProviderConfigurations() {
  return {
    domestic: readPublishingProviderConfiguration("domestic"),
    international: readPublishingProviderConfiguration("international"),
  } as const;
}

export function readPublishingProviderConfigurationForNamespace(namespace: string) {
  const all = readPublishingProviderConfigurations();
  return all.domestic.namespace === namespace ? all.domestic : all.international.namespace === namespace ? all.international : all.domestic;
}
