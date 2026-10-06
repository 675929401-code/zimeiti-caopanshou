import { timingSafeEqual } from "crypto";
import { ensureServerRuntimeEnvLoaded } from "@/lib/server-runtime-env";

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.COZE_PROJECT_ENV === "PROD";
}

export function getServerSecret(name: string, devFallback?: string): string | null {
  ensureServerRuntimeEnvLoaded();

  const value = process.env[name];
  if (value && value.trim()) return value;
  if (isProductionRuntime()) return null;
  return devFallback || null;
}

export function requireServerSecret(name: string, devFallback?: string): string {
  const value = getServerSecret(name, devFallback);
  if (!value) {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

export function safeCompareSecret(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
