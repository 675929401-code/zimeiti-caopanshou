import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import { createGuardAuditPayload } from "@/lib/prompt-guard";
import { maskSecurityUserId, redactSecurityListText } from "@/lib/security-event-display";

const sources = {
  security: readFileSync("src/app/api/admin/security-events/route.ts", "utf8"),
  popup: readFileSync("src/app/api/popup-pushes/route.ts", "utf8"),
  promptGuard: readFileSync("src/lib/prompt-guard.ts", "utf8"),
  login: readFileSync("src/app/api/admin/login-logs/route.ts", "utf8"),
  guard: readFileSync("src/app/api/admin/guard-logs/route.ts", "utf8"),
  adminPage: readFileSync("src/app/admin/page.tsx", "utf8"),
  chat: readFileSync("src/app/api/chat/route.ts", "utf8"),
  llm: readFileSync("src/app/api/llm/route.ts", "utf8"),
};

function verifyUsernameRedaction(): void {
  assert.equal(redactSecurityListText("13812345678", { fallback: "" }), "138****5678");
  assert.equal(redactSecurityListText("owner@example.com", { fallback: "" }), "o***@example.com");
  assert.equal(maskSecurityUserId("13812345678"), "138****5678");
  assert.notEqual(maskSecurityUserId("owner@example.com"), "owner@example.com");
  assert.notEqual(maskSecurityUserId("student-12345"), "student-12345");

  const usernameMasks = sources.security.match(/username:\s*maskSecurityUserId\(/gu) || [];
  assert.equal(usernameMasks.length, 2, "events and topRiskyUsers must both mask username");
  assert.ok(!/username:\s*normalizeSecurityEventDisplayText\(/u.test(sources.security));
}

async function verifyPopupAuthorization(): Promise<void> {
  assert.ok(!sources.popup.includes("extractUserIdentity"), "popup route must not trust decoded JWT payloads");
  assert.match(sources.popup, /getTokenFromHeaders\(request\.headers\)/u);
  assert.match(sources.popup, /await authorizeToken\(token\)/u);
  assert.match(sources.popup, /authorization\.actor/u);
  assert.match(sources.popup, /status: authorization\.status/u);
  assert.match(sources.popup, /code: authorization\.code/u);

  const popupRoute = await import("../src/app/api/popup-pushes/route");
  const anonymous = await popupRoute.GET(new NextRequest("http://localhost/api/popup-pushes"));
  assert.equal(anonymous.status, 200);
  assert.deepEqual(await anonymous.json(), { success: true, popups: [] });

  const forged = await popupRoute.GET(new NextRequest("http://localhost/api/popup-pushes", {
    headers: { Authorization: "Bearer forged.payload.signature" },
  }));
  const forgedBody = await forged.json() as { code?: string; popups?: unknown[] };
  assert.equal(forged.status, 401);
  assert.equal(forgedBody.code, "UNAUTHENTICATED");
  assert.deepEqual(forgedBody.popups, []);
}

function verifyMinimalGuardAudit(): void {
  const payload = createGuardAuditPayload({
    user_id: "fixture-user-id",
    user_display_name: "owner@example.com",
    user_phone: "13812345678",
    user_ip: "203.0.113.42",
    agent_name: "安全助手 13912345678",
    agent_source: "llm",
    message_preview: "电话 13812345678 邮箱 owner@example.com token=fixture-secret-value",
    risk_level: "high",
    reason: "账号 owner@example.com 命中规则",
    matched_patterns: ["ignore previous instructions", "13812345678"],
    blocked_at: "2026-10-02T00:00:00.000Z",
  });
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "13812345678",
    "13912345678",
    "owner@example.com",
    "fixture-secret-value",
    "full_message",
    "raw_data",
  ]) {
    assert.ok(!serialized.includes(forbidden), `guard audit leaked ${forbidden}`);
  }
  assert.ok(payload.promptGuardLog.matched_patterns.includes("ignore previous instructions"));
  assert.match(payload.promptGuardLog.message_preview, /138\*{4}5678/u);
  assert.equal(payload.securityEvent.phone, "138****5678");

  for (const source of [sources.promptGuard, sources.adminPage, sources.chat, sources.llm]) {
    assert.ok(!source.includes("full_message"), "full_message must be removed from new writes and UI types");
  }
  assert.ok(!/message_preview:\s*(?:message|lastGuardText)\.slice\(/u.test(`${sources.chat}\n${sources.llm}`));
  assert.ok(!sources.promptGuard.includes("raw_data"), "prompt guard must not persist raw security payloads");
}

async function verifyRetentionManagedDeletes(): Promise<void> {
  const routes = [
    ["security-events", await import("../src/app/api/admin/security-events/route"), sources.security],
    ["login-logs", await import("../src/app/api/admin/login-logs/route"), sources.login],
    ["guard-logs", await import("../src/app/api/admin/guard-logs/route"), sources.guard],
  ] as const;

  for (const [name, route, source] of routes) {
    assert.ok(!source.includes(".delete()"), `${name} route must not execute direct evidence deletion`);
    const response = await route.DELETE();
    const body = await response.json() as { code?: string; managedRetention?: boolean; error?: string };
    assert.equal(response.status, 405, `${name} DELETE must be disabled`);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(body.code, "AUDIT_EVIDENCE_RETENTION_MANAGED");
    assert.equal(body.managedRetention, true);
    assert.match(body.error || "", /受控保留策略/u);
  }
}

async function main(): Promise<void> {
  verifyUsernameRedaction();
  verifyMinimalGuardAudit();
  await verifyPopupAuthorization();
  await verifyRetentionManagedDeletes();

  console.log("PASS: security P0 audit hardening covers username redaction, authoritative popup auth, minimal guard writes, and retention-managed DELETE (4 groups)");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
