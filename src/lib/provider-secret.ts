import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  createDefaultServerSecretFilePolicy,
  readServerOnlySecretFile,
  type ServerSecretFilePolicy,
} from "@/lib/server-secret";

const SECRET_PREFIX = "secret://";
const ENV_SECRET_PREFIX = "env://";
const CACHE_TTL_MS = 5 * 60_000;

const SECRET_FILES: Record<string, string> = {
  "autodl-comfyui": "autodl-comfyui.token",
  "autodl-h3-selfhost": "autodl-h3-selfhost.token",
  "gaorui-grok-imagine-1-0-video": "gaorui-grok-imagine-1-0-video.token",
  "gaorui-grok-imagine-video-1-5": "gaorui-grok-imagine-video-1-5.token",
  "lconai-gpt-6-1-sol": "lconai-gpt-6-1-sol.token",
  "lconai-claude-sonnet-5-5": "lconai-claude-sonnet-5-5.token",
  "lconai-claude-opus-5-5": "lconai-claude-opus-5-5.token",
  "lconai-seedance-2-5-480p-i2v": "lconai-seedance-2-5-480p-i2v.token",
  "lconai-seedance-2-0-fast-720p-i2v": "lconai-seedance-2-0-fast-720p-i2v.token",
  "lconai-grok-video-3-pro": "lconai-grok-video-3-pro.token",
  "secure-skill-flow-omni": "secure-skill-flow-omni.token",
  "secure-skill-flow-omni-video-edit": "secure-skill-flow-omni-video-edit.token",
  "secure-skill-flow-veo-i2v-lite": "secure-skill-flow-veo-i2v-lite.token",
  "secure-skill-flow-veo-i2v-fast": "secure-skill-flow-veo-i2v-fast.token",
  "secure-skill-flow-veo-interpolation-lite": "secure-skill-flow-veo-interpolation-lite.token",
  "secure-skill-flow-veo-r2v-fast": "secure-skill-flow-veo-r2v-fast.token",
  "secure-skill-flow-veo-t2v-fast": "secure-skill-flow-veo-t2v-fast.token",
  "secure-skill-flow-veo-t2v-lite": "secure-skill-flow-veo-t2v-lite.token",
  "secure-skill-grok-video": "secure-skill-grok-video.token",
  "secure-skill-grok-video-1-5-preview": "secure-skill-grok-video-1-5-preview.token",
  "secure-skill-grok-video-backup": "secure-skill-grok-video-backup.token",
  "secure-skill-seedance-official-token": "secure-skill-seedance-official-token.token",
  "secure-skill-seedance-video": "secure-skill-seedance-video.token",
  "secure-skill-video-enterprise": "secure-skill-video-enterprise.token",
  "secure-skill-minimax-h3-ecommerce": "secure-skill-minimax-h3-ecommerce.token",
  "secure-skill-wan3-video": "secure-skill-wan3-video.token",
  "secure-skill-wan3-video-prime": "secure-skill-wan3-video-prime.token",
};

const SECRET_ENV_KEYS: Record<string, string> = {
  "autodl-comfyui": "AUTODL_COMFYUI_API_KEY",
  "autodl-h3-selfhost": "AUTODL_H3_SELFHOST_API_KEY",
  "gaorui-grok-imagine-1-0-video": "GAORUI_GROK_IMAGINE_1_0_VIDEO_API_KEY",
  "gaorui-grok-imagine-video-1-5": "GAORUI_GROK_IMAGINE_VIDEO_1_5_API_KEY",
  "lconai-gpt-6-1-sol": "LCONAI_GPT_6_1_SOL_API_KEY",
  "lconai-claude-sonnet-5-5": "LCONAI_CLAUDE_SONNET_5_5_API_KEY",
  "lconai-claude-opus-5-5": "LCONAI_CLAUDE_OPUS_5_5_API_KEY",
  "lconai-seedance-2-5-480p-i2v": "LCONAI_SEEDANCE_2_5_480P_I2V_API_KEY",
  "lconai-seedance-2-0-fast-720p-i2v": "LCONAI_SEEDANCE_2_0_FAST_720P_I2V_API_KEY",
  "lconai-grok-video-3-pro": "LCONAI_GROK_VIDEO_3_PRO_API_KEY",
  "secure-skill-flow-omni": "SECURE_SKILL_FLOW_OMNI_API_KEY",
  "secure-skill-flow-omni-video-edit": "SECURE_SKILL_FLOW_OMNI_VIDEO_EDIT_API_KEY",
  "secure-skill-flow-veo-i2v-lite": "SECURE_SKILL_FLOW_VEO_I2V_LITE_API_KEY",
  "secure-skill-flow-veo-i2v-fast": "SECURE_SKILL_FLOW_VEO_I2V_FAST_API_KEY",
  "secure-skill-flow-veo-interpolation-lite": "SECURE_SKILL_FLOW_VEO_INTERPOLATION_LITE_API_KEY",
  "secure-skill-flow-veo-r2v-fast": "SECURE_SKILL_FLOW_VEO_R2V_FAST_API_KEY",
  "secure-skill-flow-veo-t2v-fast": "SECURE_SKILL_FLOW_VEO_T2V_FAST_API_KEY",
  "secure-skill-flow-veo-t2v-lite": "SECURE_SKILL_FLOW_VEO_T2V_LITE_API_KEY",
  "secure-skill-grok-video": "SECURE_SKILL_GROK_VIDEO_API_KEY",
  "secure-skill-grok-video-1-5-preview": "SECURE_SKILL_GROK_VIDEO_1_5_PREVIEW_API_KEY",
  "secure-skill-grok-video-backup": "SECURE_SKILL_GROK_VIDEO_BACKUP_API_KEY",
  "secure-skill-seedance-official-token": "SECURE_SKILL_SEEDANCE_OFFICIAL_TOKEN_API_KEY",
  "secure-skill-seedance-video": "SECURE_SKILL_SEEDANCE_VIDEO_API_KEY",
  "secure-skill-video-enterprise": "SECURE_SKILL_VIDEO_ENTERPRISE_API_KEY",
  "secure-skill-minimax-h3-ecommerce": "SECURE_SKILL_MINIMAX_H3_ECOMMERCE_API_KEY",
  "secure-skill-wan3-video": "SECURE_SKILL_WAN3_VIDEO_API_KEY",
  "secure-skill-wan3-video-prime": "SECURE_SKILL_WAN3_VIDEO_PRIME_API_KEY",
};

const SECRET_FILE_ENV_KEYS: Record<string, string> = {
  "autodl-comfyui": "AUTODL_COMFYUI_API_KEY_FILE",
  "autodl-h3-selfhost": "AUTODL_H3_SELFHOST_API_KEY_FILE",
  "gaorui-grok-imagine-1-0-video": "GAORUI_GROK_IMAGINE_1_0_VIDEO_API_KEY_FILE",
  "gaorui-grok-imagine-video-1-5": "GAORUI_GROK_IMAGINE_VIDEO_1_5_API_KEY_FILE",
  "lconai-gpt-6-1-sol": "LCONAI_GPT_6_1_SOL_API_KEY_FILE",
  "lconai-claude-sonnet-5-5": "LCONAI_CLAUDE_SONNET_5_5_API_KEY_FILE",
  "lconai-claude-opus-5-5": "LCONAI_CLAUDE_OPUS_5_5_API_KEY_FILE",
  "lconai-seedance-2-5-480p-i2v": "LCONAI_SEEDANCE_2_5_480P_I2V_API_KEY_FILE",
  "lconai-seedance-2-0-fast-720p-i2v": "LCONAI_SEEDANCE_2_0_FAST_720P_I2V_API_KEY_FILE",
  "lconai-grok-video-3-pro": "LCONAI_GROK_VIDEO_3_PRO_API_KEY_FILE",
  "secure-skill-flow-omni": "SECURE_SKILL_FLOW_OMNI_API_KEY_FILE",
  "secure-skill-flow-omni-video-edit": "SECURE_SKILL_FLOW_OMNI_VIDEO_EDIT_API_KEY_FILE",
  "secure-skill-flow-veo-i2v-lite": "SECURE_SKILL_FLOW_VEO_I2V_LITE_API_KEY_FILE",
  "secure-skill-flow-veo-i2v-fast": "SECURE_SKILL_FLOW_VEO_I2V_FAST_API_KEY_FILE",
  "secure-skill-flow-veo-interpolation-lite": "SECURE_SKILL_FLOW_VEO_INTERPOLATION_LITE_API_KEY_FILE",
  "secure-skill-flow-veo-r2v-fast": "SECURE_SKILL_FLOW_VEO_R2V_FAST_API_KEY_FILE",
  "secure-skill-flow-veo-t2v-fast": "SECURE_SKILL_FLOW_VEO_T2V_FAST_API_KEY_FILE",
  "secure-skill-flow-veo-t2v-lite": "SECURE_SKILL_FLOW_VEO_T2V_LITE_API_KEY_FILE",
  "secure-skill-grok-video": "SECURE_SKILL_GROK_VIDEO_API_KEY_FILE",
  "secure-skill-grok-video-1-5-preview": "SECURE_SKILL_GROK_VIDEO_1_5_PREVIEW_API_KEY_FILE",
  "secure-skill-grok-video-backup": "SECURE_SKILL_GROK_VIDEO_BACKUP_API_KEY_FILE",
  "secure-skill-seedance-official-token": "SECURE_SKILL_SEEDANCE_OFFICIAL_TOKEN_API_KEY_FILE",
  "secure-skill-seedance-video": "SECURE_SKILL_SEEDANCE_VIDEO_API_KEY_FILE",
  "secure-skill-video-enterprise": "SECURE_SKILL_VIDEO_ENTERPRISE_API_KEY_FILE",
  "secure-skill-minimax-h3-ecommerce": "SECURE_SKILL_MINIMAX_H3_ECOMMERCE_API_KEY_FILE",
  "secure-skill-wan3-video": "SECURE_SKILL_WAN3_VIDEO_API_KEY_FILE",
  "secure-skill-wan3-video-prime": "SECURE_SKILL_WAN3_VIDEO_PRIME_API_KEY_FILE",
};

const CONTAINER_SECRET_FILES: Record<string, string> = {
  "autodl-comfyui": "/run/secrets/autodl-comfyui-api-key",
  "autodl-h3-selfhost": "/run/secrets/autodl-h3-selfhost-api-key",
  "gaorui-grok-imagine-1-0-video": "/run/secrets/gaorui-grok-imagine-1-0-video-api-key",
  "gaorui-grok-imagine-video-1-5": "/run/secrets/gaorui-grok-imagine-video-1-5-api-key",
  "lconai-gpt-6-1-sol": "/run/secrets/lconai-gpt-6-1-sol-api-key",
  "lconai-claude-sonnet-5-5": "/run/secrets/lconai-claude-sonnet-5-5-api-key",
  "lconai-claude-opus-5-5": "/run/secrets/lconai-claude-opus-5-5-api-key",
  "lconai-seedance-2-5-480p-i2v": "/run/secrets/lconai-seedance-2-5-480p-i2v-api-key",
  "lconai-seedance-2-0-fast-720p-i2v": "/run/secrets/lconai-seedance-2-0-fast-720p-i2v-api-key",
  "lconai-grok-video-3-pro": "/run/secrets/lconai-grok-video-3-pro-api-key",
  "secure-skill-flow-omni": "/run/secrets/secure-skill-flow-omni-api-key",
  "secure-skill-flow-omni-video-edit": "/run/secrets/secure-skill-flow-omni-video-edit-api-key",
  "secure-skill-flow-veo-i2v-lite": "/run/secrets/secure-skill-flow-veo-i2v-lite-api-key",
  "secure-skill-flow-veo-i2v-fast": "/run/secrets/secure-skill-flow-veo-i2v-fast-api-key",
  "secure-skill-flow-veo-interpolation-lite": "/run/secrets/secure-skill-flow-veo-interpolation-lite-api-key",
  "secure-skill-flow-veo-r2v-fast": "/run/secrets/secure-skill-flow-veo-r2v-fast-api-key",
  "secure-skill-flow-veo-t2v-fast": "/run/secrets/secure-skill-flow-veo-t2v-fast-api-key",
  "secure-skill-flow-veo-t2v-lite": "/run/secrets/secure-skill-flow-veo-t2v-lite-api-key",
  "secure-skill-grok-video": "/run/secrets/secure-skill-grok-video-api-key",
  "secure-skill-grok-video-1-5-preview": "/run/secrets/secure-skill-grok-video-1-5-preview-api-key",
  "secure-skill-grok-video-backup": "/run/secrets/secure-skill-grok-video-backup-api-key",
  "secure-skill-seedance-official-token": "/run/secrets/secure-skill-seedance-official-token-api-key",
  "secure-skill-seedance-video": "/run/secrets/secure-skill-seedance-video-api-key",
  "secure-skill-video-enterprise": "/run/secrets/secure-skill-video-enterprise-api-key",
  "secure-skill-minimax-h3-ecommerce": "/run/secrets/secure-skill-minimax-h3-ecommerce-api-key",
  "secure-skill-wan3-video": "/run/secrets/secure-skill-wan3-video-api-key",
  "secure-skill-wan3-video-prime": "/run/secrets/secure-skill-wan3-video-prime-api-key",
};

// Only explicitly approved server-side environment keys may be referenced from
// database records. This avoids turning env:// into an arbitrary environment
// variable reader while keeping provider credentials out of source and DB.
const ALLOWED_ENV_SECRET_KEYS = new Set([
  "DASHSCOPE_API_KEY",
  "VOLCENGINE_VISUAL_CREDENTIALS",
  "VOLCENGINE_API_KEY_1",
  "VOLC_TOKEN",
]);

export const AUTODL_COMFYUI_SECRET_REF = "secret://autodl-comfyui";
export const AUTODL_H3_SELFHOST_SECRET_REF = "secret://autodl-h3-selfhost";

function codexSecretPath(
  fileName: string,
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
) {
  const configuredRoot = environment.CODEX_HOME?.trim();
  const codexRoot = configuredRoot || path.join(homeDirectory, ".codex");
  return path.join(codexRoot, "secrets", fileName);
}

function decryptWindowsDpapiFile(filePath: string): string {
  if (process.platform !== "win32") {
    throw new Error("本地 DPAPI 密钥仅能由创建它的 Windows 用户读取");
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    "$encrypted=[System.IO.File]::ReadAllText($env:AUTODL_SECRET_FILE_PATH,[System.Text.Encoding]::UTF8)",
    "$secure=ConvertTo-SecureString $encrypted",
    "$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}",
  ].join("; ");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, AUTODL_SECRET_FILE_PATH: filePath },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

export interface ProviderSecretResolverOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  now?: () => number;
  filePolicy?: ServerSecretFilePolicy;
  decryptFile?: (filePath: string) => string;
}

function requireProviderSecret(value: unknown, errorMessage: string): string {
  const normalized = String(value || "").trim();
  if (normalized.length < 8 || /[\r\n\u0000]/u.test(normalized)) throw new Error(errorMessage);
  return normalized;
}

/**
 * Build a server-only credential resolver. Production prefers a chmod 0400/0600
 * file (including /run/secrets mounts), then an environment fallback. Windows
 * development retains the existing current-user DPAPI fallback.
 */
export function createProviderSecretResolver(
  options: ProviderSecretResolverOptions = {},
): (value: unknown) => string {
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const homeDirectory = options.homeDirectory || os.homedir();
  const now = options.now || Date.now;
  const filePolicy = options.filePolicy || createDefaultServerSecretFilePolicy(platform);
  const decryptFile = options.decryptFile || decryptWindowsDpapiFile;
  const cache = new Map<string, { value: string; expiresAt: number }>();

  const cachedValue = (source: string): string | undefined => {
    const cached = cache.get(source);
    return cached && cached.expiresAt > now() ? cached.value : undefined;
  };
  const remember = (source: string, value: string): string => {
    cache.set(source, { value, expiresAt: now() + CACHE_TTL_MS });
    return value;
  };

  return (value: unknown): string => {
    if (typeof window !== "undefined") throw new Error("PROVIDER_SECRET_RESOLVER_SERVER_ONLY");
    const configured = String(value || "").trim();
    if (configured.startsWith(ENV_SECRET_PREFIX)) {
      const envKey = configured.slice(ENV_SECRET_PREFIX.length).trim();
      if (!ALLOWED_ENV_SECRET_KEYS.has(envKey)) {
        throw new Error(`未批准的环境变量密钥引用: ${envKey || "(empty)"}`);
      }
      return requireProviderSecret(
        environment[envKey],
        `服务器环境变量 ${envKey} 未配置或内容无效`,
      );
    }
    if (!configured.startsWith(SECRET_PREFIX)) return configured;

    const alias = configured.slice(SECRET_PREFIX.length);
    const dpapiFileName = SECRET_FILES[alias];
    if (!dpapiFileName) throw new Error(`未知的本地密钥引用: ${alias}`);
    const envKey = SECRET_ENV_KEYS[alias];
    const fileEnvKey = SECRET_FILE_ENV_KEYS[alias];
    const configuredFile = String(environment[fileEnvKey] || "").trim();
    const containerFile = CONTAINER_SECRET_FILES[alias];
    const serverFile = configuredFile
      || (platform !== "win32" && containerFile && filePolicy.exists(containerFile) ? containerFile : "");
    if (serverFile) {
      const source = `file:${serverFile}`;
      const cached = cachedValue(source);
      if (cached) return cached;
      const secret = requireProviderSecret(
        readServerOnlySecretFile({
          filePath: serverFile,
          errorLabel: `${alias.replace(/[^a-z0-9]+/giu, "_")}_SECRET`,
          policy: filePolicy,
        }),
        "服务器密钥文件内容无效",
      );
      return remember(source, secret);
    }

    const environmentSecret = envKey ? String(environment[envKey] || "").trim() : "";
    if (environmentSecret) {
      return requireProviderSecret(environmentSecret, `服务器环境变量 ${envKey} 内容无效`);
    }

    if (platform !== "win32") {
      throw new Error(`服务器未配置 ${fileEnvKey} 或 ${envKey}`);
    }
    const source = `dpapi:${alias}`;
    const cached = cachedValue(source);
    if (cached) return cached;
    const dpapiFilePath = codexSecretPath(dpapiFileName, environment, homeDirectory);
    if (!filePolicy.exists(dpapiFilePath)) {
      throw new Error(`服务器未配置 ${envKey}，且当前机器没有开发密钥文件 ${dpapiFileName}`);
    }
    const decrypted = requireProviderSecret(decryptFile(dpapiFilePath), `本地密钥内容无效: ${dpapiFileName}`);
    return remember(source, decrypted);
  };
}

/** Resolve a server-only provider credential reference. */
export const resolveProviderSecret = createProviderSecretResolver();
