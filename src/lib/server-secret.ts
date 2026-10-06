import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_SECRET_BYTES = 16 * 1024;

export interface ServerSecretFileStat {
  isFile(): boolean;
  mode: number;
  size: number;
  uid?: number;
}

export interface ServerSecretFilePolicy {
  platform: NodeJS.Platform;
  exists(filePath: string): boolean;
  stat(filePath: string): ServerSecretFileStat;
  readText(filePath: string): string;
  effectiveUserId(): number | undefined;
}

export function createDefaultServerSecretFilePolicy(
  platform: NodeJS.Platform = process.platform,
): ServerSecretFilePolicy {
  return {
    platform,
    exists: existsSync,
    stat: filePath => statSync(filePath),
    readText: filePath => readFileSync(filePath, "utf8"),
    effectiveUserId: () => typeof process.geteuid === "function" ? process.geteuid() : undefined,
  };
}

function normalizedErrorLabel(value: string): string {
  const normalized = String(value || "SERVER_SECRET").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(normalized) ? normalized : "SERVER_SECRET";
}

/**
 * Read a production secret from a root/service-user-only Linux file or a
 * container secret mount. Windows development keeps using DPAPI instead of a
 * plaintext file. No path or content is included in thrown errors.
 */
export function readServerOnlySecretFile(input: {
  filePath: string;
  errorLabel: string;
  policy?: ServerSecretFilePolicy;
  maxBytes?: number;
}): string {
  if (typeof window !== "undefined") throw new Error("SERVER_SECRET_RESOLVER_SERVER_ONLY");
  const policy = input.policy || createDefaultServerSecretFilePolicy();
  const label = normalizedErrorLabel(input.errorLabel);
  const filePath = String(input.filePath || "").trim();
  if (policy.platform === "win32") throw new Error(`${label}_FILE_WINDOWS_UNSUPPORTED`);
  if (!filePath || !path.isAbsolute(filePath)) throw new Error(`${label}_FILE_ABSOLUTE_PATH_REQUIRED`);
  if (!policy.exists(filePath)) throw new Error(`${label}_FILE_MISSING`);
  const stat = policy.stat(filePath);
  if (!stat.isFile()) throw new Error(`${label}_FILE_NOT_REGULAR`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label}_FILE_PERMISSIONS_UNSAFE`);
  const effectiveUserId = policy.effectiveUserId();
  if (typeof effectiveUserId === "number"
    && typeof stat.uid === "number"
    && stat.uid !== effectiveUserId) {
    throw new Error(`${label}_FILE_OWNER_UNSAFE`);
  }
  const maxBytes = Math.max(64, Math.min(1024 * 1024, input.maxBytes || DEFAULT_MAX_SECRET_BYTES));
  if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) {
    throw new Error(`${label}_FILE_SIZE_INVALID`);
  }
  const raw = policy.readText(filePath);
  if (Buffer.byteLength(raw, "utf8") > maxBytes || raw.includes("\u0000")) {
    throw new Error(`${label}_FILE_CONTENT_INVALID`);
  }
  const value = raw.trim();
  if (!value || /[\r\n]/u.test(value)) throw new Error(`${label}_FILE_CONTENT_INVALID`);
  return value;
}
