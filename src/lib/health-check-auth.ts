import { timingSafeEqual } from "node:crypto";

const MINIMUM_HEALTH_SECRET_LENGTH = 32;

export function getHealthCheckSecret(): string {
  const secret = process.env.HEALTH_CHECK_SECRET?.trim() || "";
  return secret.length >= MINIMUM_HEALTH_SECRET_LENGTH ? secret : "";
}

export function isHealthCheckConfigured(): boolean {
  return Boolean(getHealthCheckSecret());
}

export function matchesHealthCheckSecret(value: string | null | undefined): boolean {
  const configured = getHealthCheckSecret();
  const supplied = value?.trim() || "";
  if (!configured || !supplied) return false;

  const configuredBytes = Buffer.from(configured);
  const suppliedBytes = Buffer.from(supplied);
  return configuredBytes.length === suppliedBytes.length
    && timingSafeEqual(configuredBytes, suppliedBytes);
}

export function isAuthorizedInternalHealthRequest(headers: Headers): boolean {
  return matchesHealthCheckSecret(headers.get("x-internal-health-check"));
}
