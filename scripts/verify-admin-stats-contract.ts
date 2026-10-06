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
const evidenceDir = path.resolve(".codex-evidence", `admin-stats-contract-${generatedAt}`);

interface AdminStatsResponse {
  overview?: {
    totalUsers?: number;
  };
  agentRanking?: Array<{
    name?: string;
    messages?: number;
    credits?: number;
  }>;
  error?: string;
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
  assert(!adminError && admin, adminError?.message || "ADMIN_STATS_ACTIVE_ADMIN_MISSING");

  const { count: expectedStudents, error: countError } = await db
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("role", "student");
  assert(!countError, countError?.message || "ADMIN_STATS_STUDENT_COUNT_FAILED");

  const token = await createToken({
    userId: String(admin.id),
    username: String(admin.username),
    role: "admin",
    displayName: String(admin.display_name || "交付验收管理员"),
    sessionId: `admin-stats-${randomUUID()}`,
  });

  const response = await fetch(`${baseUrl}/api/stats?admin=true`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await response.json() as AdminStatsResponse;
  assert(response.ok, `ADMIN_STATS_HTTP_${response.status}:${payload.error || "unknown"}`);
  assert.equal(
    payload.overview?.totalUsers,
    expectedStudents || 0,
    "ADMIN_STATS_TOTAL_USERS_MUST_MATCH_STUDENT_ROLE_COUNT",
  );

  const invalidRankingRows = (payload.agentRanking || []).filter((row) => (
    typeof row.name !== "string"
    || row.name.trim().length === 0
    || row.name.trim().toLowerCase() === "unknown"
    || typeof row.messages !== "number"
    || !Number.isFinite(row.messages)
    || typeof row.credits !== "number"
    || !Number.isFinite(row.credits)
  ));
  assert.equal(invalidRankingRows.length, 0, "ADMIN_STATS_AGENT_RANKING_CONTRACT_INVALID");

  const evidence = {
    verifier: "admin-stats-contract",
    generatedAt: new Date().toISOString(),
    baseUrl,
    httpStatus: response.status,
    expectedStudents: expectedStudents || 0,
    reportedStudents: payload.overview?.totalUsers ?? null,
    rankingRows: payload.agentRanking?.length || 0,
    invalidRankingRows: invalidRankingRows.length,
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
    ok: true,
  };
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, "admin-stats-contract.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
