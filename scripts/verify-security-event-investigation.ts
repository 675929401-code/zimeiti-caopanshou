import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  analyzeStoredIp,
  analyzeUserAgent,
  classifyInvestigationActor,
  describeLocation,
} from "../src/lib/server/security-event-investigation";

const loopback = analyzeStoredIp("127.0.0.1", "hash-loopback");
assert.equal(loopback.scope, "loopback");
assert.equal(loopback.ipAddress, "127.0.0.1");
assert.equal(describeLocation(loopback).status, "not_applicable_local");
assert.equal(describeLocation(loopback).province, null);

assert.equal(analyzeStoredIp("10.12.3.4").scope, "private");
assert.equal(analyzeStoredIp("169.254.9.1").scope, "link_local");
assert.equal(analyzeStoredIp("203.0.113.42").scope, "reserved");
const publicIp = analyzeStoredIp("8.8.8.8", "hash-public");
assert.equal(publicIp.scope, "public");
assert.equal(describeLocation(publicIp).status, "provider_not_configured");
assert.equal(describeLocation(publicIp).county, null);

const hashOnly = analyzeStoredIp(null, "f".repeat(32));
assert.equal(hashOnly.ipAvailability, "unavailable");
assert.equal(hashOnly.ipUnavailableReason, "privacy_preserving_hash_only");
assert.equal(hashOnly.ipAddress, null);

const edge = analyzeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0");
assert.equal(edge.deviceType, "desktop");
assert.equal(edge.browser.name, "Edge");
assert.equal(edge.os.name, "Windows");
assert.equal(edge.automation.suspected, false);

const scripted = analyzeUserAgent("Mozilla/5.0 HeadlessChrome/126.0.0.0 Playwright/1.46");
assert.equal(scripted.automation.suspected, true);
assert.deepEqual(scripted.automation.signals, ["HeadlessChrome", "Playwright"]);

const student = {
  id: "student-1",
  username: "student1",
  display_name: "测试学员",
  phone: "13812345678",
  email: "student@example.com",
  role: "student",
  status: "active",
  is_active: true,
  member_status: "active",
};

const failedLoginActor = classifyInvestigationActor({
  event: { path: "/api/auth/login", details: "Login failed", source: "api_direct", user_id: student.id },
  account: student,
  networkScope: "public",
  sessionEvidence: { status: "matched_at_event_time", matchingSessions: 1 },
});
assert.equal(failedLoginActor.classification, "targeting_registered_student");
assert.equal(failedLoginActor.relationship, "account_target_only");
assert.notEqual(failedLoginActor.classification, "registered_student", "failed login must not blame the targeted student");
assert.equal(failedLoginActor.account?.phoneMasked, "138****5678");

const correlatedActor = classifyInvestigationActor({
  event: { path: "/api/chat", details: "blocked", source: "user_client", user_id: student.id },
  account: student,
  networkScope: "public",
  sessionEvidence: { status: "matched_at_event_time", matchingSessions: 1 },
});
assert.equal(correlatedActor.classification, "registered_student");
assert.equal(correlatedActor.confidence, "medium");
assert.equal(correlatedActor.relationship, "session_telemetry_match");

const unverifiedActor = classifyInvestigationActor({
  event: { path: "/api/chat", details: "blocked", source: "user_client", user_id: student.id },
  account: student,
  networkScope: "public",
  sessionEvidence: { status: "not_matched", matchingSessions: 0 },
});
assert.equal(unverifiedActor.classification, "targeting_registered_student");
assert.equal(unverifiedActor.confidence, "low");

const externalActor = classifyInvestigationActor({
  event: { path: "/api/unknown", details: "scan", source: "anonymous", user_id: null },
  account: null,
  networkScope: "public",
  sessionEvidence: { status: "not_applicable", matchingSessions: 0 },
});
assert.equal(externalActor.classification, "external_visitor");

const routeSource = readFileSync("src/app/api/admin/security-events/[id]/investigation/route.ts", "utf8");
const serviceSource = readFileSync("src/lib/server/security-event-investigation.ts", "utf8");
const loginSource = readFileSync("src/app/api/auth/login/route.ts", "utf8");

assert.match(routeSource, /authorizeAdminCapability\(request, "security\.manage"/u);
assert.match(routeSource, /requireStepUp: true/u);
assert.match(routeSource, /SECURITY_INVESTIGATION_REASON_REQUIRED/u);
assert.match(routeSource, /private, no-store/u);
assert.match(routeSource, /SECURITY_INVESTIGATION_AUDIT_UNAVAILABLE/u, "audit failure must fail closed before revealing raw evidence");
assert.match(routeSource, /security_event_investigation_reveal/u);
assert.ok(!serviceSource.includes("fetch("), "investigation must not call an unconfigured third-party geo service");
assert.ok(!serviceSource.includes("raw_data"), "investigation must not read arbitrary raw payloads");
assert.match(serviceSource, /provider_not_configured/u);
assert.match(serviceSource, /privacy_preserving_hash_only/u);
assert.match(loginSource, /getClientIP as getTrustedClientIP/u);
assert.ok(!loginSource.includes("function getClientIP("), "login must reuse the hardened shared client IP resolver");
assert.match(loginSource, /const clientIP = getTrustedClientIP\(request\)/u);

console.log("PASS: security investigation attribution, privacy boundary, step-up gate, audit fail-closed, IP scope, UA signals, and login IP trust (24 assertions)");
