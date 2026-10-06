import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createToken, getJwtSecretKey } from "../src/lib/auth";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

// Explicit local, read-only acceptance. Never mutates roles or exports credentials/response bodies.
async function main() {
  const base = new URL(process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "this probe is restricted to a local runtime");
  const db = getSupabaseAdminClient();
  const { data: users, error } = await db.from("users")
    .select("id, role, status, is_active").in("role", ["admin", "student"]).limit(100);
  assert.ok(!error && Array.isArray(users), "cannot read account authorization state");
  const admin = users.find((user: { role: string; status: string | null; is_active: boolean }) =>
    user.role === "admin" && user.is_active === true && (user.status === "active" || user.status === null));
  const student = users.find((user: { role: string }) => user.role === "student");
  assert.ok(admin && student, "active administrator and ordinary account are required for read-only acceptance");
  const identity = { username: "local-auth-probe", displayName: "local-auth-probe", role: "admin" as const, sessionId: randomUUID() };
  const adminToken = await createToken({ ...identity, userId: admin.id });
  const staleAdminClaim = await createToken({ ...identity, userId: student.id });
  const expired = await new SignJWT({ ...identity, userId: admin.id }).setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(getJwtSecretKey());
  const results: Array<{ route: string; scenario: string; status: number }> = [];
  for (const route of ["/api/admin/nav-items", "/api/admin/voice-list"]) {
    for (const [scenario, token, permitted] of [
      ["active-database-admin", adminToken, true],
      ["student-with-stale-admin-claim", staleAdminClaim, false],
      ["expired-token", expired, false],
      ["illegal-token", "invalid.token.value", false],
      ["anonymous", "", false],
    ] as const) {
      const response = await fetch(new URL(route, base), {
        method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(60_000),
      });
      await response.arrayBuffer();
      results.push({ route, scenario, status: response.status });
      if (permitted) assert.equal(response.status, 200, `${route}: active administrator must remain usable`);
      else assert.ok([401, 403].includes(response.status), `${route}: ${scenario} must be rejected`);
    }
  }
  console.log(JSON.stringify({ passed: true, results, paidRequests: 0, databaseWrites: 0, evidenceLevel: "live local HTTP and existing database accounts; no role mutations" }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "local admin authorization probe failed"); process.exitCode = 1; });
