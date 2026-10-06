import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  maskSecurityIp,
  maskSecurityPhone,
  maskSecurityUserId,
  normalizeSecurityEventDisplayText,
  redactSecurityListText,
} from "@/lib/security-event-display";

function utf8ReadAsLatin1(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join("");
}

function verifyNormalization(): void {
  assert.equal(normalizeSecurityEventDisplayText("朱俊果"), "朱俊果");
  assert.equal(normalizeSecurityEventDisplayText("English café déjà vu"), "English café déjà vu");
  assert.equal(normalizeSecurityEventDisplayText(utf8ReadAsLatin1("朱俊果")), "朱俊果");
  assert.equal(
    normalizeSecurityEventDisplayText(utf8ReadAsLatin1(utf8ReadAsLatin1("测试学生"))),
    "测试学生",
  );
  assert.equal(
    normalizeSecurityEventDisplayText("å\u0085 invalid", { fallback: "身份无法识别" }),
    "身份无法识别",
  );
  assert.equal(normalizeSecurityEventDisplayText("???", { fallback: "内容无法识别" }), "内容无法识别");
  assert.equal(normalizeSecurityEventDisplayText(null, { fallback: "" }), "");
  assert.equal(normalizeSecurityEventDisplayText("安全日志内容", { maxLength: 5 }), "安全日志…");
}

function verifyMaskingAndRedaction(): void {
  assert.equal(maskSecurityPhone("13812345678"), "138****5678");
  assert.equal(maskSecurityPhone("+8613812345678"), "+86 138****5678");
  assert.equal(maskSecurityIp("203.0.113.42"), "203.0.113.*");
  assert.equal(maskSecurityIp("2001:db8:85a3::8a2e:370:7334"), "2001:db8::****");
  assert.equal(maskSecurityUserId("b5cc9d68-6113-4f43-9f62-0dbdcd96b26d"), "b5cc9d…b26d");
  assert.equal(maskSecurityUserId("student-12345"), "studen…2345");

  // Assemble synthetic credentials at runtime so repository scanners do not
  // mistake redaction fixtures for usable secrets committed to source control.
  const syntheticJwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "signature",
  ].join(".");
  const passwordField = ["pass", "word"].join("");
  const syntheticPassword = ["s3", "cr3t"].join("");
  const apiKeyField = ["api", "key"].join("_");
  const syntheticApiKey = ["sk", "fixtureOnlySecret123"].join("-");
  const secretText = [
    `Authorization: Bearer ${syntheticJwt}`,
    `${passwordField}=${syntheticPassword}`,
    `${apiKeyField}=${syntheticApiKey}`,
    "电话 13812345678",
    "IP 203.0.113.42",
    "邮箱 admin@example.com",
    "用户 b5cc9d68-6113-4f43-9f62-0dbdcd96b26d",
    "智能体 7642507167812649023",
  ].join("; ");
  const redacted = redactSecurityListText(secretText, { maxLength: 500 });
  for (const forbidden of [
    "eyJhbGci",
    "s3cr3t",
    "fixtureOnlySecret",
    "13812345678",
    "203.0.113.42",
    "admin@example.com",
    "b5cc9d68-6113-4f43-9f62-0dbdcd96b26d",
    "7642507167812649023",
  ]) {
    assert.ok(!redacted.includes(forbidden), `redacted list text leaked ${forbidden}`);
  }
  assert.match(redacted, /138\*{4}5678/u);
  assert.match(redacted, /203\.0\.113\.\*/u);
  assert.match(redacted, /a\*{3}@example\.com/u);
  assert.match(redacted, /764250…9023/u);
  assert.equal(redactSecurityListText("1234567890", { maxLength: 6 }).length, 6);
}

function verifyRouteContract(): void {
  const login = readFileSync("src/app/api/admin/login-logs/route.ts", "utf8");
  const guard = readFileSync("src/app/api/admin/guard-logs/route.ts", "utf8");
  const security = readFileSync("src/app/api/admin/security-events/route.ts", "utf8");
  const adminPage = readFileSync("src/app/admin/page.tsx", "utf8");
  const securityCenter = readFileSync("src/components/admin/security-center-admin-tab.tsx", "utf8");

  for (const [name, source] of [["login", login], ["guard", guard]] as const) {
    assert.ok(!source.includes('.select("*")'), `${name} list must not select every column`);
    assert.ok(!source.includes(".select('*')"), `${name} list must not select every column`);
    assert.match(source, /application\/json; charset=utf-8/u, `${name} must declare UTF-8 JSON`);
    assert.match(source, /Cache-Control.*no-store/us, `${name} must disable response caching`);
    assert.match(source, /boundedInteger\(url\.searchParams\.get\("page"\)/u, `${name} must bound page`);
    assert.match(source, /boundedInteger\(url\.searchParams\.get\("pageSize"\)/u, `${name} must bound page size`);
    assert.ok(!source.includes("error.message"), `${name} must not expose database error text`);
    assert.match(source, /normalizeSecurityEventDisplayText/u, `${name} must normalize display text`);
    assert.match(source, /redactSecurityListText/u, `${name} must redact list text`);
  }

  const loginColumns = login.match(/const LOGIN_LOG_COLUMNS = "([^"]+)"/u)?.[1]?.split(",") ?? [];
  assert.deepEqual(loginColumns, [
    "id", "user_id", "username", "display_name", "ip_address", "user_agent",
    "login_method", "status", "fail_reason", "created_at",
  ]);
  assert.match(login, /ip_address: maskSecurityIp/u);
  assert.match(login, /user_id: maskSecurityUserId/u);
  assert.match(login, /display_name: redactSecurityListText/u, "login display name must redact embedded identifiers");

  const guardColumns = guard.match(/const GUARD_LOG_COLUMNS = "([^"]+)"/u)?.[1]?.split(",") ?? [];
  assert.deepEqual(guardColumns, [
    "id", "user_id", "user_display_name", "agent_name", "agent_source", "message_preview",
    "risk_level", "reason", "matched_patterns", "blocked_at",
  ]);
  assert.ok(!guardColumns.includes("full_message"), "guard list must never read full prompt message");
  assert.ok(!/\.\.\.log\b/u.test(guard), "guard response must not spread raw database rows");
  assert.match(guard, /message_preview: redactSecurityListText/u);
  assert.match(guard, /agent_name: redactSecurityListText/u, "guard agent name must mask embedded provider identifiers");
  assert.match(guard, /user_id: maskSecurityUserId/u);
  assert.match(guard, /user_display_name: redactSecurityListText/u, "guard display name must redact embedded identifiers");

  assert.ok(!security.includes('.select("*")'), "security event list must not select every column");
  assert.ok(!security.includes("raw_data"), "security event list must not read or return raw payloads");
  assert.match(security, /application\/json; charset=utf-8/u);
  assert.match(security, /Cache-Control": "no-store/u);
  assert.match(security, /\["high", "critical"\]\.includes\(row\.risk_level\)/u, "risk ranking must only count high/critical events");
  assert.match(security, /\.from\("users"\)[\s\S]*\.select\("id,username,display_name,phone,status"\)/u, "current account labels must be loaded in one bounded query");
  assert.match(security, /maskSecurityPhone/u);
  assert.match(security, /maskSecurityIp/u);
  assert.match(security, /maskSecurityUserId/u);
  assert.match(security, /display_name: redactSecurityListText/u, "security display names must redact embedded identifiers");
  assert.match(security, /source: redactSecurityListText/u, "security source labels must redact embedded identifiers");
  assert.match(security, /summaryCapped/u);
  assert.match(adminPage, /import\("@\/components\/admin\/security-center-admin-tab"\)/u, "admin page must load the extracted security center");
  assert.match(adminPage, /<SecurityCenterAdminTab/u, "admin page must mount the extracted security center");
  assert.ok(!securityCenter.includes("event.raw_data"), "security center must not render raw payloads");
  assert.match(securityCenter, /高\/严重风险关联账号 Top10/u);
  assert.doesNotMatch(securityCenter, /高\/严重风险用户 Top10/u);
  assert.match(securityCenter, /手机号与 IP 默认脱敏/u);
  assert.match(securityCenter, /data-admin-security-center/u);
}

verifyNormalization();
verifyMaskingAndRedaction();
verifyRouteContract();
console.log("PASS: admin security views normalize 2-pass mojibake, mask identifiers, redact secrets, and expose bounded allowlisted UTF-8 responses (3 groups)");
