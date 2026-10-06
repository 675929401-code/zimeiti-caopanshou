export const ADMIN_ACCOUNT_SECURITY_SCHEMA_VERSION = 1 as const;
export const ADMIN_ACCOUNT_SECURITY_CACHE_TTL_MS = 30_000;
export const ADMIN_ACCOUNT_SECURITY_POLL_INTERVAL_MS = 60_000;
export const ADMIN_ACCOUNT_SECURITY_MAX_SESSIONS = 20;
export const ADMIN_ACCOUNT_SECURITY_WRITE_WINDOW_MS = 5 * 60_000;
export const ADMIN_ACCOUNT_SECURITY_WRITE_LIMIT = 8;

export type AdminSessionStatus = "active" | "revoked" | "expired";
export type CapabilityAvailability = "ready" | "partial" | "unavailable";

export interface AdminSessionEvidence {
  status: "hashed_only" | "unavailable";
  label: string;
  detail: string;
}

export interface AdminSessionItem {
  handle: string;
  current: boolean;
  status: AdminSessionStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokeReason: "logout" | "concurrency_limit" | "expired" | "account_credentials_changed" | "administrator_revoked" | "other" | null;
  deviceEvidence: AdminSessionEvidence;
  networkEvidence: AdminSessionEvidence;
}

export interface AdminLoginRiskSnapshot {
  status: CapabilityAvailability;
  level: "normal" | "attention" | "high" | "unknown";
  failedLoginCount24h: number | null;
  signals: Array<{
    code: string;
    label: string;
    severity: "info" | "attention" | "high";
    evidence: string;
  }>;
  limitations: string[];
}

export interface AdminSecurityCapability {
  status: CapabilityAvailability;
  code: string;
  label: string;
  detail: string;
  nextStep: string;
}

export interface AdminAccountSecurityResponse {
  schemaVersion: typeof ADMIN_ACCOUNT_SECURITY_SCHEMA_VERSION;
  asOf: string;
  nextRefreshAt: string;
  freshnessSeconds: number;
  cacheStatus: "miss" | "hit" | "shared";
  scope: "current_admin_account";
  sessions: {
    status: CapabilityAvailability;
    activeCount: number | null;
    currentSessionFound: boolean;
    items: AdminSessionItem[];
    limit: number;
    truncated: boolean;
    detail: string;
  };
  risk: AdminLoginRiskSnapshot;
  mfa: AdminSecurityCapability & {
    factor: "email_otp" | null;
    destination: string | null;
    transportStatus: "configured_unverified" | "not_configured" | "unknown";
  };
  trustedDevices: AdminSecurityCapability;
  anomalyChallenge: AdminSecurityCapability;
  stepUp: {
    status: "ready" | "missing" | "invalid" | "unavailable";
    expiresAt: string | null;
    authMethod: "login_password" | "management_password" | null;
  };
  permissions: {
    read: "security.view";
    write: "security.view";
    writeRequiresStepUp: true;
  };
  privacy: {
    rawSessionIdsExposed: false;
    rawIpExposed: false;
    rawUserAgentExposed: false;
    notes: string[];
  };
  rateLimit: {
    readCacheSeconds: number;
    writeLimit: number;
    writeWindowSeconds: number;
  };
}

export interface AdminAccountSecurityMutationResponse {
  success: true;
  action: "revoke_session";
  revoked: boolean;
  alreadyInactive: boolean;
  signedOut: boolean;
  auditRecorded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAdminAccountSecurityResponse(value: unknown): value is AdminAccountSecurityResponse {
  if (!isRecord(value) || value.schemaVersion !== ADMIN_ACCOUNT_SECURITY_SCHEMA_VERSION) return false;
  if (value.scope !== "current_admin_account" || typeof value.asOf !== "string" || typeof value.nextRefreshAt !== "string") return false;
  if (!isRecord(value.sessions) || !Array.isArray(value.sessions.items)) return false;
  if (!isRecord(value.risk) || !Array.isArray(value.risk.signals) || !Array.isArray(value.risk.limitations)) return false;
  if (!isRecord(value.mfa) || !isRecord(value.trustedDevices) || !isRecord(value.anomalyChallenge)) return false;
  if (!isRecord(value.stepUp) || !isRecord(value.permissions) || !isRecord(value.privacy) || !isRecord(value.rateLimit)) return false;
  return value.sessions.items.every((item) => {
    if (!isRecord(item)) return false;
    return typeof item.handle === "string"
      && typeof item.current === "boolean"
      && ["active", "revoked", "expired"].includes(String(item.status));
  });
}

export function normalizeSessionRevokeReason(value: unknown): AdminSessionItem["revokeReason"] {
  const reason = String(value || "").trim().toLowerCase();
  if (!reason) return null;
  if (["logout", "concurrency_limit", "expired", "account_credentials_changed", "administrator_revoked"].includes(reason)) {
    return reason as Exclude<AdminSessionItem["revokeReason"], "other" | null>;
  }
  return "other";
}
