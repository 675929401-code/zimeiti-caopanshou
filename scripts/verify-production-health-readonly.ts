import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

dotenv.config({ path: ".env.local", quiet: true });

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const generatedAt = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", `production-health-readonly-${generatedAt}`);

interface HealthCheck {
  name?: string;
  status?: "healthy" | "degraded" | "unhealthy";
  message?: string;
  latency?: number;
  details?: Record<string, unknown>;
}

interface HealthPayload {
  status?: "healthy" | "degraded" | "unhealthy";
  checks?: HealthCheck[];
  summary?: {
    total?: number;
    healthy?: number;
    degraded?: number;
    unhealthy?: number;
  };
  error?: string;
}

function redactText(value: unknown): string {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[REDACTED]@");
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => {
    if (/token|secret|password|credential|authorization|cookie/iu.test(key)) {
      return [key, "[REDACTED]"];
    }
    if (Array.isArray(value)) return [key, value.map(redactText)];
    if (typeof value === "string") return [key, redactText(value)];
    return [key, value];
  }));
}

async function main(): Promise<void> {
  const db = getSupabaseClient();
  const { data: admin, error: adminError } = await db
    .from("users")
    .select("id, username, display_name")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  assert(!adminError && admin, adminError?.message || "PRODUCTION_HEALTH_ACTIVE_ADMIN_MISSING");

  const token = await createToken({
    userId: String(admin.id),
    username: String(admin.username),
    role: "admin",
    displayName: String(admin.display_name || "交付验收管理员"),
    sessionId: `production-health-${randomUUID()}`,
  });

  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json() as HealthPayload;
  const checks = (payload.checks || []).map((check) => ({
    name: redactText(check.name),
    status: check.status || "unhealthy",
    message: redactText(check.message),
    latency: typeof check.latency === "number" ? check.latency : null,
    details: sanitizeDetails(check.details),
  }));
  const unhealthy = checks.filter((check) => check.status === "unhealthy");
  const degraded = checks.filter((check) => check.status === "degraded");
  const productionReady = response.ok && payload.status === "healthy" && unhealthy.length === 0;

  const evidence = {
    verifier: "production-health-readonly",
    generatedAt: new Date().toISOString(),
    baseUrl,
    httpStatus: response.status,
    reportedStatus: payload.status || null,
    summary: payload.summary || null,
    checks,
    unhealthyChecks: unhealthy.map((check) => check.name),
    degradedChecks: degraded.map((check) => check.name),
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
    productionReady,
  };
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, "production-health-readonly.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));

  assert(response.ok, `PRODUCTION_HEALTH_HTTP_${response.status}:${redactText(payload.error || "unknown")}`);
  assert.equal(unhealthy.length, 0, `PRODUCTION_HEALTH_UNHEALTHY:${unhealthy.map((check) => check.name).join(",")}`);
  assert.equal(payload.status, "healthy", `PRODUCTION_HEALTH_STATUS_${payload.status || "missing"}`);
}

main().catch((error) => {
  console.error(`production health gate failed: ${redactText((error as Error).message)}`);
  process.exitCode = 1;
});
