import "server-only";

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const operationDomains = [
  "chat", "image", "video", "voice", "extract", "payment", "auth", "storage", "admin", "system", "other",
] as const;
export const operationOutcomes = ["in_progress", "success", "warning", "error", "cancelled", "unknown"] as const;

const TRACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/u;

const metadataSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  transport: z.enum(["fetch", "xhr", "beacon", "database", "worker", "server"]).optional(),
  response_kind: z.enum(["json", "stream", "media", "empty", "unknown"]).optional(),
  page_path: z.string().max(512).optional(),
  client_started_at: z.string().datetime().optional(),
  retry_count: z.number().int().min(0).max(20).optional(),
}).strict();

export const browserOperationFlightEventSchema = z.object({
  id: z.string().uuid(),
  trace_id: z.string().regex(TRACE_PATTERN),
  domain: z.enum(operationDomains),
  operation: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/u),
  phase: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/u),
  outcome: z.enum(operationOutcomes),
  duration_ms: z.number().int().min(0).max(86_400_000).nullish(),
  http_status: z.number().int().min(100).max(599).nullish(),
  route: z.string().trim().min(1).max(512),
  error_code: z.string().regex(SAFE_CODE_PATTERN).nullish(),
  summary: z.string().trim().max(500).nullish(),
  metadata: metadataSchema.optional().default({}),
  occurred_at: z.string().datetime().optional(),
}).strict();

export type BrowserOperationFlightEvent = z.infer<typeof browserOperationFlightEventSchema>;

const secretLikePatterns: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_KEY]"],
  [/([?&](?:token|access_token|api_key|apikey|key|secret|signature|sign|ticket)=)[^&#\s]+/giu, "$1[REDACTED]"],
  [/(?:password|passwd|密码|密钥|secret|api[_ -]?key)\s*[:=：]\s*[^,;\s]+/giu, "credential=[REDACTED]"],
];

export function redactOperationText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  let result = value.replace(/[\r\n\0]+/gu, " ").trim();
  for (const [pattern, replacement] of secretLikePatterns) result = result.replace(pattern, replacement);
  return result ? result.slice(0, maxLength) : null;
}

export function normalizeOperationPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, "http://operation.local");
    const pathname = url.pathname.replace(/\/{2,}/gu, "/");
    return pathname.startsWith("/") ? pathname.slice(0, 512) : null;
  } catch {
    const pathname = value.split(/[?#]/u, 1)[0]?.trim();
    return pathname?.startsWith("/") ? pathname.slice(0, 512) : null;
  }
}

function safeOccurredAt(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  const now = Date.now();
  if (!Number.isFinite(parsed) || parsed < now - 7 * 24 * 60 * 60 * 1_000 || parsed > now + 5 * 60 * 1_000) {
    return new Date(now).toISOString();
  }
  return new Date(parsed).toISOString();
}

interface RuntimeIdentity {
  sourceVersion: string | null;
  buildId: string | null;
}

let runtimeIdentityCache: { expiresAt: number; value: RuntimeIdentity } | null = null;

export function readFlightRuntimeIdentity(): RuntimeIdentity {
  if (runtimeIdentityCache && runtimeIdentityCache.expiresAt > Date.now()) return runtimeIdentityCache.value;
  let sourceVersion: string | null = null;
  let buildId: string | null = null;
  try {
    const versionPath = join(process.cwd(), "public", "version.json");
    if (existsSync(versionPath)) {
      const parsed = JSON.parse(readFileSync(versionPath, "utf8")) as { sourceVersion?: unknown; version?: unknown };
      const candidate = typeof parsed.sourceVersion === "string" ? parsed.sourceVersion : parsed.version;
      if (typeof candidate === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(candidate)) sourceVersion = candidate;
    }
  } catch {
    sourceVersion = null;
  }
  try {
    const configured = process.env.LOCAL_ACCEPTANCE_PREVIEW === "true"
      ? process.env.LOCAL_VALIDATION_DIST_DIR?.trim()
      : "";
    const distDirectory = configured && new Set([".next-local-acceptance", ".next-local-acceptance-next"]).has(configured)
      ? configured
      : ".next";
    const buildPath = join(process.cwd(), distDirectory, "BUILD_ID");
    if (existsSync(buildPath)) {
      const candidate = readFileSync(buildPath, "utf8").trim();
      if (/^[A-Za-z0-9_-]{1,128}$/u.test(candidate)) buildId = candidate;
    }
  } catch {
    buildId = null;
  }
  const value = { sourceVersion, buildId };
  runtimeIdentityCache = { value, expiresAt: Date.now() + 10_000 };
  return value;
}

function errorFingerprint(input: BrowserOperationFlightEvent, route: string, summary: string | null): string | null {
  if (input.outcome !== "error" && !input.error_code && !(input.http_status && input.http_status >= 400)) return null;
  return createHash("sha256")
    .update([input.domain, input.operation, input.phase, route, input.http_status || "", input.error_code || "", summary || ""].join("|"))
    .digest("hex");
}

export async function recordBrowserOperationFlightEvent(
  input: BrowserOperationFlightEvent,
  actor: { userId: string; username?: string | null; displayName?: string | null },
): Promise<{ id: string; duplicate: boolean }> {
  const route = normalizeOperationPath(input.route);
  if (!route || route === "/api/operation-events" || route.startsWith("/api/admin/operation-events")) {
    throw new Error("OPERATION_ROUTE_INVALID");
  }
  const pagePath = normalizeOperationPath(input.metadata.page_path);
  const summary = redactOperationText(input.summary);
  const runtime = readFlightRuntimeIdentity();
  const metadata = {
    ...input.metadata,
    ...(pagePath ? { page_path: pagePath } : {}),
  };
  const row = {
    id: input.id,
    trace_id: input.trace_id,
    user_id: actor.userId,
    username: redactOperationText(actor.displayName || actor.username, 120),
    source: "browser",
    domain: input.domain,
    operation: input.operation,
    phase: input.phase,
    outcome: input.outcome,
    duration_ms: input.duration_ms ?? null,
    http_status: input.http_status ?? null,
    route,
    error_code: input.error_code || null,
    error_fingerprint: errorFingerprint(input, route, summary),
    summary,
    metadata,
    source_version: runtime.sourceVersion,
    build_id: runtime.buildId,
    occurred_at: safeOccurredAt(input.occurred_at),
  };
  const { error } = await getSupabaseAdminClient().from("operation_flight_events").insert(row);
  if (error?.code === "23505") return { id: input.id, duplicate: true };
  if (error) throw new Error(`OPERATION_FLIGHT_INSERT_FAILED:${error.code || "UNKNOWN"}`);
  return { id: input.id, duplicate: false };
}

export function pseudonymousUserRef(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId) return null;
  return `usr_${createHash("sha256").update(userId).digest("hex").slice(0, 12)}`;
}
