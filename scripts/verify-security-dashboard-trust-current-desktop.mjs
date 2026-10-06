#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeJwt, SignJWT } from "jose";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identityJson = String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
let identity = {};
const runtimeIdentityReceiptPath = String(process.env.LOCAL_RUNTIME_IDENTITY_RECEIPT || "").trim();
let diskVersion = {};
let expectedSourceVersion = "";
let expectedBuildId = "";
const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const evidenceRoot = path.resolve(".codex-evidence");
const evidenceDir = path.join(evidenceRoot, "security-dashboard-trust-current-desktop");
const viewport = { width: 1440, height: 900 };
const runtimeReceiptMaxAgeMs = 10 * 60_000;

const pages = [
  { id: "security", url: "/admin?tab=security", heading: "安全中心", selector: "[data-admin-security-center]", readinessPath: "/api/admin/security-events", securitySurface: true },
  { id: "guard-logs", url: "/admin?tab=guard-logs", heading: "安全预警", readinessPath: "/api/admin/guard-logs", securitySurface: true },
  { id: "login-logs", url: "/admin?tab=login-logs", heading: "登录日志", readinessPath: "/api/admin/login-logs", securitySurface: true },
  { id: "dashboard", url: "/admin?tab=dashboard", heading: "平台运营安全指挥中心", selector: '[data-testid="admin-command-center"]', readinessPath: "/api/admin/command-center" },
  { id: "health", url: "/admin?tab=health", heading: "系统健康", readinessPath: "/api/health" },
  { id: "general", url: "/admin?tab=general", heading: "品牌与基本设置", selector: '[data-testid="platform-brand-settings"]', readinessPath: "/api/settings" },
];

const apiDefinitions = [
  { id: "security", path: "/api/admin/security-events?page=1&pageSize=20" },
  { id: "guard", path: "/api/admin/guard-logs?page=1&pageSize=20" },
  { id: "login", path: "/api/admin/login-logs?page=1&pageSize=20" },
  { id: "command-center", path: "/api/admin/command-center?hours=24" },
  { id: "credential-health", path: "/api/admin/credential-health" },
  { id: "health", path: "/api/health" },
  { id: "version", path: "/api/version" },
];

const telemetryPaths = new Set(["/api/operation-events", "/api/client-error-report"]);
const providerPathPattern = /^\/api\/(?:llm(?:\/|$)|chat(?:\/|$)|image\/generate(?:\/|$)|video\/generate(?:\/|$)|voice\/(?:tts|nest)(?:\/|$)|digital-human\/generate(?:\/|$)|admin\/(?:llm-test|[^/]+\/validation\/publish)(?:\/|$))/u;
const mojibakePatterns = [
  /\uFFFD/u,
  /(?:锟斤拷|鐧诲綍|瀹夊叏|绠＄悊|鐢ㄦ埛|鏃堕棿|鎻愮ず|鍏抽棴|鏌ョ湅|鍔犺浇)/u,
  /(?:Ã[\u0080-\u00bf]|Â[\u0080-\u00bf]|â(?:€|€™|€œ|€�)|ï¿½|ðŸ)/u,
];
const barePhonePattern = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const bareLongIdentifierPattern = /(?<!\d)\d{12,24}(?!\d)/gu;
const ipv4Pattern = /(?<![\d./])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/gu;
const bareEmailPattern = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/giu;
const ipv6CandidatePattern = /(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])/giu;
const controlCharacterPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const secretAssignmentPattern = /\b(?:authorization|cookie|set-cookie|password|passwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session(?:_id)?)\s*[:=]\s*(?!\[(?:已隐藏|redacted)\])\S+/giu;
const sensitiveQueryPattern = /https?:\/\/[^\s"'<>?]+\?[^\s"'<>]*(?:token|secret|password|api[_-]?key|access[_-]?token)=[^\s&"'<>]+/giu;

const report = {
  status: "pending",
  passed: false,
  uiContractPassed: false,
  runtimeIdentityVerified: false,
  checkedAt: new Date().toISOString(),
  origin,
  viewport,
  expectedRuntime: { sourceVersion: expectedSourceVersion, buildId: expectedBuildId },
  runtimeIdentityReceipt: null,
  runtimeIdentityScope: {
    browserCrossCheck: "fresh official CheckOnly receipt + public/version.json + .next/BUILD_ID + /api/version",
    officialWorkspaceVerifyReceiptRequired: true,
  },
  runtime: null,
  pages: [],
  api: [],
  securityContract: null,
  commandCenterContract: null,
  credentialHealthContract: null,
  healthContract: null,
  governanceGates: null,
  contractViolations: [],
  blockedWrites: [],
  providerRequests: [],
  externalRequests: [],
  externalFontsFiltered: [],
  telemetry: {
    operationEvents: 0,
    clientErrorReport: 0,
    responses: [],
  },
  controlledReadFixtures: { announcementInbox: 0 },
  pageErrors: [],
  consoleErrors: [],
  ignoredExternalFontConsoleErrors: [],
  requestFailures: [],
  resourceErrors: [],
  serverErrors: [],
  apiErrors: [],
  authorizationNegativeChecks: [],
  cleanupErrors: [],
  failure: null,
  sideEffects: {
    browserBusinessWriteAttemptsObserved: 0,
    browserProviderRequestsObserved: 0,
    serverProviderInvocationsObserved: null,
    serverProviderObservationMethod: "not instrumented; browser egress is blocked and API read contracts declare no provider probes",
    serverBusinessWritesObserved: null,
    serverBusinessWriteObservationMethod: "not instrumented; report makes no database-zero-write claim",
    telemetryWriteAttemptsStubbed: 0,
    liveReadOnlyAuthGateRequests: 0,
    authorizationNegativeRequests: 0,
    expectedControlPlaneAuditAttempts: null,
    paidSupplierCallsInitiatedByBrowser: 0,
    productionWritesInitiatedByBrowser: 0,
  },
};

let activePageId = "bootstrap";

function absoluteEvidencePath(fileName) {
  return path.join(evidenceDir, fileName);
}

function relativeEvidencePath(fileName) {
  return path.relative(process.cwd(), absoluteEvidencePath(fileName)).replaceAll("\\", "/");
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedLocalPath(value) {
  return path.resolve(String(value || "")).replace(/[\\/]+$/u, "").toLowerCase();
}

function isFreshIsoTimestamp(value, maxAgeMs = 5 * 60_000) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && timestamp <= Date.now() + 60_000 && Date.now() - timestamp <= maxAgeMs;
}

function assertJsonContentType(label, value) {
  assert.match(String(value || ""), /^application\/json(?:;|$)/iu, `${label}:JSON_CONTENT_TYPE_REQUIRED`);
}

function cacheDirectives(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function assertNoStore(label, value) {
  assert.ok(cacheDirectives(value).has("no-store"), `${label}:CACHE_CONTROL_NO_STORE_REQUIRED`);
}

function assertPrivateNoStore(label, value) {
  const directives = cacheDirectives(value);
  assert.ok(directives.has("private"), `${label}:CACHE_CONTROL_PRIVATE_REQUIRED`);
  assert.ok(directives.has("no-store"), `${label}:CACHE_CONTROL_NO_STORE_REQUIRED`);
  assert.ok(directives.has("max-age=0"), `${label}:CACHE_CONTROL_MAX_AGE_ZERO_REQUIRED`);
}

function assertVaryAuthorizationCookie(label, value) {
  const names = new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
  assert.ok(names.has("authorization"), `${label}:VARY_AUTHORIZATION_REQUIRED`);
  assert.ok(names.has("cookie"), `${label}:VARY_COOKIE_REQUIRED`);
}

function assertSafeNonNegativeInteger(label, value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label}:NON_NEGATIVE_SAFE_INTEGER_REQUIRED`);
}

function assertNullableIsoTimestamp(label, value) {
  assert.ok(value === null || (typeof value === "string" && Number.isFinite(Date.parse(value))), `${label}:NULLABLE_ISO_TIMESTAMP_REQUIRED`);
}

async function writeReport() {
  await fs.mkdir(evidenceDir, { recursive: true });
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(absoluteEvidencePath("report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function resetEvidenceDirectory() {
  assert.equal(path.dirname(path.resolve(evidenceDir)), evidenceRoot, "EVIDENCE_DIRECTORY_SCOPE_INVALID");
  await fs.rm(evidenceDir, { recursive: true, force: true });
  await fs.mkdir(evidenceDir, { recursive: true });
  report.status = "running";
  await writeReport();
}

async function loadAndVerifyRuntimeIdentity() {
  assert.ok(runtimeIdentityReceiptPath, "LOCAL_RUNTIME_IDENTITY_RECEIPT_REQUIRED");
  identity = JSON.parse(identityJson);
  const receiptFile = path.resolve(runtimeIdentityReceiptPath);
  const [versionText, buildText, receiptText, receiptStat] = await Promise.all([
    fs.readFile(path.resolve("public", "version.json"), "utf8"),
    fs.readFile(path.resolve(".next", "BUILD_ID"), "utf8"),
    fs.readFile(receiptFile, "utf8"),
    fs.stat(receiptFile),
  ]);
  diskVersion = JSON.parse(versionText);
  const receiptDocument = JSON.parse(receiptText);
  const receipt = isPlainRecord(receiptDocument?.runtimeIdentity)
    ? receiptDocument.runtimeIdentity
    : receiptDocument;

  expectedSourceVersion = String(diskVersion?.sourceVersion || "").trim();
  expectedBuildId = buildText.trim();
  report.expectedRuntime = { sourceVersion: expectedSourceVersion, buildId: expectedBuildId };

  assert.match(expectedSourceVersion, /^R\d{6,}-\d{8}-[a-f0-9]{8}$/u, "DISK_SOURCE_VERSION_INVALID");
  assert.ok(expectedBuildId.length >= 12, "DISK_BUILD_ID_INVALID");
  assert.ok(Date.now() - receiptStat.mtimeMs <= runtimeReceiptMaxAgeMs, "RUNTIME_IDENTITY_RECEIPT_FILE_STALE");
  assert.ok(isFreshIsoTimestamp(receipt?.checkedAt, runtimeReceiptMaxAgeMs), "RUNTIME_IDENTITY_RECEIPT_CHECK_STALE");
  assert.equal(receipt?.runningLatest, true, "RUNTIME_IDENTITY_RUNNING_LATEST_REQUIRED");
  assert.equal(receipt?.processMatchesSource, true, "RUNTIME_IDENTITY_PROCESS_SOURCE_MISMATCH");
  assert.equal(receipt?.sourceFingerprintCurrent, true, "RUNTIME_IDENTITY_SOURCE_FINGERPRINT_STALE");
  assert.equal(receipt?.localDatabaseConfigured, true, "RUNTIME_IDENTITY_DATABASE_CONFIGURATION_REQUIRED");
  assert.equal(receipt?.localDatabaseProcessMatchesSource, true, "RUNTIME_IDENTITY_DATABASE_PROCESS_MISMATCH");
  assert.equal(receipt?.portOccupied, true, "RUNTIME_IDENTITY_PORT_NOT_LISTENING");
  assert.ok(Number.isSafeInteger(receipt?.processId) && receipt.processId > 0, "RUNTIME_IDENTITY_PROCESS_ID_INVALID");
  assert.ok(Number.isSafeInteger(receipt?.databaseProcessId) && receipt.databaseProcessId > 0, "RUNTIME_IDENTITY_DATABASE_PROCESS_ID_INVALID");
  assert.equal(String(receipt?.processName || "").toLowerCase(), "node.exe", "RUNTIME_IDENTITY_PROCESS_NAME_INVALID");
  assert.equal(normalizedLocalPath(receipt?.source), normalizedLocalPath(process.cwd()), "RUNTIME_IDENTITY_SOURCE_PATH_MISMATCH");
  const expectedServerEntry = normalizedLocalPath(path.join(process.cwd(), ".next", "standalone", "server.js"));
  assert.ok(
    String(receipt?.processCommandLine || "").replaceAll("/", "\\").toLowerCase().includes(expectedServerEntry),
    "RUNTIME_IDENTITY_PROCESS_COMMAND_MISMATCH",
  );
  assert.equal(String(receipt?.url || "").replace(/\/+$/u, ""), origin, "RUNTIME_IDENTITY_ORIGIN_MISMATCH");
  assert.equal(receipt?.diskBuildId, expectedBuildId, "RUNTIME_IDENTITY_DISK_BUILD_MISMATCH");
  assert.equal(receipt?.servedBuildId, expectedBuildId, "RUNTIME_IDENTITY_SERVED_BUILD_MISMATCH");
  assert.equal(receipt?.sourceVersion, expectedSourceVersion, "RUNTIME_IDENTITY_DISK_VERSION_MISMATCH");
  assert.equal(receipt?.servedSourceVersion, expectedSourceVersion, "RUNTIME_IDENTITY_SERVED_VERSION_MISMATCH");
  assert.equal(receipt?.sourceDigest, diskVersion?.sourceDigest, "RUNTIME_IDENTITY_SOURCE_DIGEST_MISMATCH");
  assert.match(String(receipt?.sourceDigest || ""), /^[a-f0-9]{64}$/u, "RUNTIME_IDENTITY_SOURCE_DIGEST_INVALID");
  if (Object.prototype.hasOwnProperty.call(receiptDocument || {}, "buildMatchesSource")) {
    assert.equal(receiptDocument.buildMatchesSource, true, "WORKBENCH_BUILD_SOURCE_MISMATCH");
  }
  if (isPlainRecord(receiptDocument?.verification)) {
    assert.equal(receiptDocument.verification.localEnvironmentReady, true, "WORKBENCH_LOCAL_ENVIRONMENT_NOT_READY");
  }

  report.runtimeIdentityReceipt = {
    file: path.basename(receiptFile),
    checkedAt: receipt.checkedAt,
    processId: receipt.processId,
    databaseProcessId: receipt.databaseProcessId,
    processCommandLineMatchesSource: true,
    processMatchesSource: true,
    sourceFingerprintCurrent: true,
    localDatabaseProcessMatchesSource: true,
    runningLatest: true,
    diskBuildId: receipt.diskBuildId,
    servedBuildId: receipt.servedBuildId,
    sourceVersion: receipt.sourceVersion,
    servedSourceVersion: receipt.servedSourceVersion,
    sourceDigest: receipt.sourceDigest,
  };
  report.runtimeIdentityVerified = true;
}

function collectKeys(value, target = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, target);
    return target;
  }
  if (!value || typeof value !== "object") return target;
  for (const [key, child] of Object.entries(value)) {
    target.add(key);
    collectKeys(child, target);
  }
  return target;
}

function isVersionLikeIpv4(text, index) {
  const prefix = text.slice(Math.max(0, index - 48), index);
  return /(?:Chrome|CriOS|Firefox|EdgA?|OPR|Version|Safari|AppleWebKit|Windows NT)[/ ][^\s;()]{0,28}$/iu.test(prefix);
}

function unsafeTextFindings(text) {
  const value = String(text || "");
  const mojibake = mojibakePatterns.flatMap((pattern) => {
    const match = value.match(pattern);
    return match ? [match[0]] : [];
  });
  const phones = [...value.matchAll(barePhonePattern)].map((match) => match[0]);
  const longIdentifiers = [...value.matchAll(bareLongIdentifierPattern)].map((match) => match[0]);
  const emails = [...value.matchAll(bareEmailPattern)].map((match) => match[0]);
  const ipv4 = [...value.matchAll(ipv4Pattern)]
    .filter((match) => !isVersionLikeIpv4(value, match.index || 0))
    .map((match) => match[0]);
  const ipv6 = [...value.matchAll(ipv6CandidatePattern)]
    .map((match) => match[0])
    .filter((candidate) => isIP(candidate) === 6 && !candidate.includes("****"));
  const controlCharacters = [...value.matchAll(controlCharacterPattern)].map((match) => match[0].codePointAt(0)?.toString(16) || "unknown");
  const secretAssignments = value.match(secretAssignmentPattern) || [];
  const sensitiveQueries = value.match(sensitiveQueryPattern) || [];
  return {
    mojibake: [...new Set(mojibake)],
    barePhones: [...new Set(phones)],
    bareLongIdentifiers: [...new Set(longIdentifiers)],
    bareEmails: [...new Set(emails)],
    bareIpv4: [...new Set(ipv4)],
    bareIpv6: [...new Set(ipv6)],
    controlCharacters: [...new Set(controlCharacters)],
    secretAssignments: [...new Set(secretAssignments)],
    sensitiveQueries: [...new Set(sensitiveQueries)],
  };
}

function unsafeValuePaths(value, currentPath = "$", findings = {
  mojibake: [], barePhones: [], bareLongIdentifiers: [], bareEmails: [], bareIpv4: [], bareIpv6: [],
  controlCharacters: [], secretAssignments: [], sensitiveQueries: [],
}, options = { scanLongIdentifiers: true }) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => unsafeValuePaths(item, `${currentPath}[${index}]`, findings, options));
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [index, [key, child]] of Object.entries(value).entries()) {
      const keyFindings = unsafeTextFindings(key);
      for (const findingKey of Object.keys(findings)) {
        if (keyFindings[findingKey]?.length > 0) findings[findingKey].push(`${currentPath}.#unsafe-key-${index}`);
      }
      const safeKeySegment = /^[A-Za-z_][A-Za-z0-9_-]{0,64}$/u.test(key)
        && Object.values(keyFindings).every((items) => items.length === 0)
        ? key
        : `#key-${index}`;
      unsafeValuePaths(child, `${currentPath}.${safeKeySegment}`, findings, options);
    }
    return findings;
  }
  if (typeof value !== "string" && typeof value !== "number") return findings;
  const valueFindings = unsafeTextFindings(String(value));
  // Long numeric values are privacy findings on security surfaces, where they
  // commonly represent user, agent, tenant or provider resource identifiers.
  // Numeric ratios may have 12+ decimal digits after String() conversion. They
  // are not identifiers. Documented string fields such as contract versions and
  // admin model IDs are handled by the exact JSON-path allowlist below.
  if (typeof value === "number" || !options.scanLongIdentifiers) valueFindings.bareLongIdentifiers = [];
  for (const findingKey of Object.keys(findings)) {
    if (valueFindings[findingKey]?.length > 0) findings[findingKey].push(currentPath);
  }
  return findings;
}

function isDocumentedLongIdentifierField(apiId, jsonPath) {
  if (apiId === "health" && /^\$\.checks\[\d+\]\.details\.contractVersion$/u.test(jsonPath)) return true;
  if (apiId === "credential-health" && /^\$\.credentials\[\d+\]\.modelId$/u.test(jsonPath)) return true;
  return false;
}

function sensitiveKeyPaths(value, currentPath = "$", findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => sensitiveKeyPaths(item, `${currentPath}[${index}]`, findings));
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  const denied = new Set([
    "apikey", "secret", "secretvalue", "rawcredential", "resolvedcredential", "credentialsuffix",
    "configurationhash", "token", "accesstoken", "refreshtoken", "authorization", "password",
    "passwd", "cookie", "setcookie", "clientsecret",
  ]);
  Object.entries(value).forEach(([key, child], index) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (denied.has(normalized)) findings.push(`${currentPath}.#sensitive-key-${index}:${normalized}`);
    sensitiveKeyPaths(child, `${currentPath}.${key}`, findings);
  });
  return findings;
}

function redactEvidenceText(value) {
  return String(value || "")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/gu, "[jwt-redacted]")
    .replace(/\b1[3-9]\d{9}\b/gu, "[phone-redacted]")
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/giu, "[email-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[ipv4-redacted]")
    .replace(ipv6CandidatePattern, (candidate) => isIP(candidate) === 6 ? "[ipv6-redacted]" : candidate)
    .replace(/\b(?:authorization|cookie|set-cookie|password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/giu, "$1=[redacted]")
    .replace(/([?&](?:token|secret|password|api[_-]?key|access[_-]?token)=)[^&\s]+/giu, "$1[redacted]")
    .slice(0, 1_000);
}

function safeUrlEvidence(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function assertTrustedText(label, text) {
  const findings = unsafeTextFindings(text);
  assert.equal(findings.mojibake.length, 0, `${label}:MOJIBAKE_COUNT:${findings.mojibake.length}`);
  assert.equal(findings.barePhones.length, 0, `${label}:BARE_PHONE_COUNT:${findings.barePhones.length}`);
  assert.equal(findings.bareLongIdentifiers.length, 0, `${label}:BARE_LONG_IDENTIFIER_COUNT:${findings.bareLongIdentifiers.length}`);
  assert.equal(findings.bareEmails.length, 0, `${label}:BARE_EMAIL_COUNT:${findings.bareEmails.length}`);
  assert.equal(findings.bareIpv4.length, 0, `${label}:BARE_IPV4_COUNT:${findings.bareIpv4.length}`);
  assert.equal(findings.bareIpv6.length, 0, `${label}:BARE_IPV6_COUNT:${findings.bareIpv6.length}`);
  assert.equal(findings.controlCharacters.length, 0, `${label}:CONTROL_CHARACTER_COUNT:${findings.controlCharacters.length}`);
  assert.equal(findings.secretAssignments.length, 0, `${label}:SECRET_ASSIGNMENT_COUNT:${findings.secretAssignments.length}`);
  assert.equal(findings.sensitiveQueries.length, 0, `${label}:SENSITIVE_QUERY_COUNT:${findings.sensitiveQueries.length}`);
  return Object.fromEntries(Object.keys(findings).map((key) => [key, 0]));
}

async function resetScrollPositions(page) {
  let state = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    state = await page.evaluate(async () => {
      let resetStyle = document.getElementById("codex-evidence-scroll-reset");
      if (!resetStyle) {
        resetStyle = document.createElement("style");
        resetStyle.id = "codex-evidence-scroll-reset";
        resetStyle.textContent = "html,body,*{scroll-behavior:auto!important}";
        document.head.append(resetStyle);
      }
      const reset = () => {
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
        document.scrollingElement?.scrollTo({ left: 0, top: 0, behavior: "instant" });
        for (const element of document.querySelectorAll("*")) {
          if (element.scrollTop !== 0) element.scrollTop = 0;
          if (element.scrollLeft !== 0) element.scrollLeft = 0;
        }
      };
      reset();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      reset();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const main = document.querySelector("main");
      return {
        windowX: Math.round(window.scrollX),
        windowY: Math.round(window.scrollY),
        documentTop: Math.round(document.scrollingElement?.scrollTop || 0),
        documentLeft: Math.round(document.scrollingElement?.scrollLeft || 0),
        bodyTop: Math.round(document.body.scrollTop || 0),
        mainTop: Math.round(main?.scrollTop || 0),
      };
    });
    if (Object.values(state).every((value) => value === 0)) break;
    await page.waitForTimeout(100);
  }
  assert.ok(state, "SCREENSHOT_SCROLL_STATE_MISSING");
  assert.deepEqual(state, {
    windowX: 0,
    windowY: 0,
    documentTop: 0,
    documentLeft: 0,
    bodyTop: 0,
    mainTop: 0,
  }, `SCREENSHOT_SCROLL_RESET_FAILED:${JSON.stringify(state)}`);
  await page.waitForTimeout(100);
  return state;
}

async function readPngDimensions(filePath) {
  const buffer = await fs.readFile(filePath);
  assert.ok(buffer.length >= 24, `PNG_TOO_SHORT:${path.basename(filePath)}`);
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG", `PNG_SIGNATURE_INVALID:${path.basename(filePath)}`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function inspectDarkPixelRatio(filePath) {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let darkPixels = 0;
  const pixelCount = data.length / info.channels;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const luminance = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
    if (luminance < 180) darkPixels += 1;
  }
  return Number((darkPixels / pixelCount).toFixed(4));
}

async function captureDashboardScrollEvidence(page) {
  const layout = await page.evaluate(() => {
    const main = document.querySelector("main");
    const surface = document.querySelector('[data-testid="admin-command-center"]');
    if (!main || !surface) return null;
    const mainRect = main.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    return {
      mainClientHeight: Math.round(main.clientHeight),
      mainScrollHeight: Math.round(main.scrollHeight),
      maxScrollTop: Math.round(Math.max(0, main.scrollHeight - main.clientHeight)),
      mainTop: Math.round(mainRect.top),
      surfaceLeft: Math.round(surfaceRect.left),
      surfaceWidth: Math.round(surfaceRect.width),
    };
  });
  assert.ok(layout, "COMMAND_CENTER_SCROLL_LAYOUT_MISSING");
  assert.ok(layout.mainClientHeight >= 600, `COMMAND_CENTER_SCROLL_VIEWPORT_TOO_SHORT:${layout.mainClientHeight}`);
  assert.ok(layout.maxScrollTop > 0, "COMMAND_CENTER_SCROLL_RANGE_MISSING");
  assert.ok(layout.surfaceWidth >= 900, `COMMAND_CENTER_SCROLL_SURFACE_TOO_NARROW:${layout.surfaceWidth}`);

  const overlap = 120;
  const stride = layout.mainClientHeight - overlap;
  const plannedPositions = [];
  for (let top = 0; top < layout.maxScrollTop; top += stride) plannedPositions.push(top);
  if (plannedPositions.at(-1) !== layout.maxScrollTop) plannedPositions.push(layout.maxScrollTop);

  const slices = [];
  const coveredSections = new Set();
  let headlinesObserved = false;
  let anomalyTimelineObserved = false;
  const compositeInputs = [];
  let previousDocumentEnd = 0;

  for (const [index, plannedTop] of plannedPositions.entries()) {
    const state = await page.evaluate(async (targetTop) => {
      const main = document.querySelector("main");
      const surface = document.querySelector('[data-testid="admin-command-center"]');
      if (!main || !surface) return null;
      main.style.scrollBehavior = "auto";
      main.scrollTo({ left: 0, top: targetTop, behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const mainRect = main.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const intersectsMain = (element) => {
        const rect = element.getBoundingClientRect();
        return Math.min(rect.bottom, mainRect.bottom) - Math.max(rect.top, mainRect.top) >= 24;
      };
      return {
        actualScrollTop: Math.round(main.scrollTop),
        mainTop: Math.round(mainRect.top),
        mainHeight: Math.round(mainRect.height),
        surfaceLeft: Math.round(surfaceRect.left),
        surfaceWidth: Math.round(surfaceRect.width),
        visibleSections: [...surface.querySelectorAll('[data-testid="command-center-sections"] > section[data-section]')]
          .filter(intersectsMain)
          .map((element) => element.getAttribute("data-section")),
        headlineVisible: [...surface.querySelectorAll('[data-testid^="command-center-headline-"]')].some(intersectsMain),
        anomalyTimelineVisible: (() => {
          const anomalyTimeline = surface.querySelector('[data-testid="command-center-source-anomalies"]');
          return anomalyTimeline ? intersectsMain(anomalyTimeline) : false;
        })(),
        surfaceVisibleHeight: Math.round(Math.max(0, Math.min(surfaceRect.bottom, mainRect.bottom) - Math.max(surfaceRect.top, mainRect.top))),
      };
    }, plannedTop);
    assert.ok(state, `COMMAND_CENTER_SCROLL_STATE_MISSING:${index}`);
    assert.ok(Math.abs(state.actualScrollTop - plannedTop) <= 1, `COMMAND_CENTER_SCROLL_POSITION_MISMATCH:${plannedTop}/${state.actualScrollTop}`);
    assert.ok(state.surfaceVisibleHeight >= 24, `COMMAND_CENTER_SCROLL_SURFACE_NOT_VISIBLE:${index}`);
    assert.ok(state.headlineVisible || state.visibleSections.length > 0 || state.anomalyTimelineVisible, `COMMAND_CENTER_SCROLL_SEMANTIC_CONTENT_MISSING:${index}`);
    state.visibleSections.forEach((id) => coveredSections.add(id));
    headlinesObserved ||= state.headlineVisible;
    anomalyTimelineObserved ||= state.anomalyTimelineVisible;

    const suffix = String(index + 1).padStart(2, "0");
    const viewportName = `dashboard-scroll-${suffix}-1440x900.png`;
    const contentName = `dashboard-scroll-${suffix}-content.png`;
    const viewportPath = absoluteEvidencePath(viewportName);
    const contentPath = absoluteEvidencePath(contentName);
    await page.screenshot({ path: viewportPath, fullPage: false, animations: "disabled" });
    const viewportDimensions = await readPngDimensions(viewportPath);
    assert.deepEqual(viewportDimensions, viewport, `COMMAND_CENTER_SCROLL_SCREENSHOT_DIMENSIONS:${suffix}`);
    const crop = {
      left: state.surfaceLeft,
      top: state.mainTop,
      width: state.surfaceWidth,
      height: state.mainHeight,
    };
    assert.ok(crop.left >= 0 && crop.top >= 0 && crop.left + crop.width <= viewport.width && crop.top + crop.height <= viewport.height, `COMMAND_CENTER_SCROLL_CROP_INVALID:${suffix}`);
    await sharp(viewportPath).extract(crop).png().toFile(contentPath);
    const darkPixelRatio = await inspectDarkPixelRatio(contentPath);
    assert.ok(darkPixelRatio >= 0.25, `COMMAND_CENTER_SCROLL_VISUAL_CONTENT_MISSING:${suffix}:${darkPixelRatio}`);
    const contentDimensions = await readPngDimensions(contentPath);
    assert.equal(contentDimensions.width, layout.surfaceWidth, `COMMAND_CENTER_SCROLL_CONTENT_WIDTH:${suffix}`);
    assert.equal(contentDimensions.height, layout.mainClientHeight, `COMMAND_CENTER_SCROLL_CONTENT_HEIGHT:${suffix}`);
    const documentStart = state.actualScrollTop;
    const documentEnd = documentStart + contentDimensions.height;
    assert.ok(documentEnd <= layout.mainScrollHeight, `COMMAND_CENTER_SCROLL_SLICE_OUTSIDE_DOCUMENT:${suffix}:${documentEnd}/${layout.mainScrollHeight}`);
    const overlapWithPrevious = Math.max(0, previousDocumentEnd - documentStart);
    const uniquePixels = Math.max(0, documentEnd - Math.max(documentStart, previousDocumentEnd));
    assert.ok(index === 0 || uniquePixels > 0, `COMMAND_CENTER_SCROLL_SLICE_ADDS_NO_CONTENT:${suffix}`);
    compositeInputs.push({ input: contentPath, left: 0, top: documentStart });
    previousDocumentEnd = Math.max(previousDocumentEnd, documentEnd);
    slices.push({
      plannedScrollTop: plannedTop,
      actualScrollTop: state.actualScrollTop,
      documentStart,
      documentEnd,
      overlapWithPrevious,
      uniquePixels,
      visibleSections: state.visibleSections,
      headlineVisible: state.headlineVisible,
      anomalyTimelineVisible: state.anomalyTimelineVisible,
      darkPixelRatio,
      viewportScreenshot: relativeEvidencePath(viewportName),
      contentScreenshot: relativeEvidencePath(contentName),
      contentDimensions,
    });
  }

  const expectedSections = ["business", "finance", "tasks", "models", "security", "operations", "governance"];
  assert.equal(headlinesObserved, true, "COMMAND_CENTER_SCROLL_HEADLINES_NOT_OBSERVED");
  assert.equal(anomalyTimelineObserved, true, "COMMAND_CENTER_SCROLL_ANOMALY_TIMELINE_NOT_OBSERVED");
  assert.deepEqual([...coveredSections], expectedSections, `COMMAND_CENTER_SCROLL_SECTION_COVERAGE:${[...coveredSections].join(",")}`);
  assert.equal(slices[0]?.actualScrollTop, 0, "COMMAND_CENTER_SCROLL_DID_NOT_START_AT_TOP");
  assert.equal(slices.at(-1)?.actualScrollTop, layout.maxScrollTop, "COMMAND_CENTER_SCROLL_DID_NOT_REACH_BOTTOM");
  assert.equal(previousDocumentEnd, layout.mainScrollHeight, `COMMAND_CENTER_SCROLL_DOCUMENT_COVERAGE:${previousDocumentEnd}/${layout.mainScrollHeight}`);

  const compositeName = "dashboard-scroll-composite.png";
  const compositePath = absoluteEvidencePath(compositeName);
  await sharp({
    create: {
      width: layout.surfaceWidth,
      height: layout.mainScrollHeight,
      channels: 3,
      background: { r: 242, g: 244, b: 239 },
    },
  }).composite(compositeInputs).png().toFile(compositePath);
  const compositeDimensions = await readPngDimensions(compositePath);
  assert.deepEqual(
    compositeDimensions,
    { width: layout.surfaceWidth, height: layout.mainScrollHeight },
    `COMMAND_CENTER_SCROLL_COMPOSITE_DIMENSIONS:${JSON.stringify(compositeDimensions)}`,
  );
  const compositeDarkPixelRatio = await inspectDarkPixelRatio(compositePath);
  assert.ok(compositeDarkPixelRatio >= 0.25, `COMMAND_CENTER_SCROLL_COMPOSITE_CONTENT_MISSING:${compositeDarkPixelRatio}`);
  await resetScrollPositions(page);
  return {
    strategy: "real viewport slices aligned to their unique admin main scroll coordinates",
    mainClientHeight: layout.mainClientHeight,
    mainScrollHeight: layout.mainScrollHeight,
    maxScrollTop: layout.maxScrollTop,
    overlap,
    sliceCount: slices.length,
    headlinesObserved,
    anomalyTimelineObserved,
    coveredSections: [...coveredSections],
    slices,
    compositeScreenshot: relativeEvidencePath(compositeName),
    compositeDimensions,
    compositeDarkPixelRatio,
  };
}

function assertOnlyKeys(label, rows, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const [index, row] of rows.entries()) {
    assert.ok(row && typeof row === "object" && !Array.isArray(row), `${label}[${index}]:ROW_INVALID`);
    const unexpected = Object.keys(row).filter((key) => !allowed.has(key));
    assert.deepEqual(unexpected, [], `${label}[${index}]:UNEXPECTED_KEYS:${unexpected.join(",")}`);
  }
}

function assertRequiredKeys(label, rows, requiredKeys) {
  for (const [index, row] of rows.entries()) {
    const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(row, key));
    assert.deepEqual(missing, [], `${label}[${index}]:MISSING_REQUIRED_FIELDS:${missing.join(",")}`);
  }
}

function assertMaskedSecurityIdentifier(label, value, kind = "user") {
  const textValue = String(value || "");
  if (!textValue) return;
  const phoneMasked = /^(?:(?:\+?86\s?)?1\d{2}\*{4}\d{4}|\d{3}\*{3}\d{2}|.\*{3}.?|\*{3})$/u.test(textValue);
  const ipMasked = /^(?:\d{1,3}\.){3}\*$|^[0-9a-f:]+::\*{4}$|^已隐藏$/iu.test(textValue);
  const userMasked = /^(?:.{1,6}….{1,4}|.\*{3}|.{1,3}\*{3,4}.{0,4}|已隐藏)$/u.test(textValue);
  const valid = kind === "phone" ? phoneMasked : kind === "ip" ? ipMasked : userMasked || phoneMasked;
  assert.ok(valid, `${label}:IDENTIFIER_NOT_MASKED:length=${textValue.length}`);
}

function installDiagnostics(page) {
  page.on("pageerror", (error) => {
    report.pageErrors.push({ page: activePageId, url: safeUrlEvidence(page.url()), message: redactEvidenceText(error?.message || error) });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const locationUrl = String(message.location()?.url || "");
    if (/fonts\.(?:googleapis|gstatic)\.com/iu.test(`${locationUrl} ${text}`)) {
      report.ignoredExternalFontConsoleErrors.push({ page: activePageId, url: safeUrlEvidence(locationUrl), message: redactEvidenceText(text) });
      return;
    }
    report.consoleErrors.push({ page: activePageId, url: safeUrlEvidence(locationUrl || page.url()), message: redactEvidenceText(text) });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    report.requestFailures.push({
      page: activePageId,
      method: request.method(),
      pathname: url.pathname,
      resourceType: request.resourceType(),
      errorText: redactEvidenceText(request.failure()?.errorText || "request failed"),
    });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const status = response.status();
    if (url.origin === origin && status >= 500) {
      report.serverErrors.push({ page: activePageId, status, method: response.request().method(), pathname: url.pathname });
    }
    if (url.origin === origin && url.pathname.startsWith("/api/") && status >= 400) {
      report.apiErrors.push({ page: activePageId, status, method: response.request().method(), pathname: url.pathname });
    }
    if (
      url.origin === origin
      && status >= 400
      && !url.pathname.startsWith("/api/")
      && ["document", "stylesheet", "script", "image", "font", "media", "manifest"].includes(response.request().resourceType())
    ) {
      report.resourceErrors.push({ page: activePageId, status, pathname: url.pathname, resourceType: response.request().resourceType() });
    }
    if (url.origin === origin && telemetryPaths.has(url.pathname)) {
      report.telemetry.responses.push({ page: activePageId, status, pathname: url.pathname });
    }
  });
}

async function installReadOnlyBoundary(context) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();

    if (url.origin === origin && telemetryPaths.has(url.pathname) && method === "POST") {
      if (url.pathname === "/api/operation-events") report.telemetry.operationEvents += 1;
      if (url.pathname === "/api/client-error-report") report.telemetry.clientErrorReport += 1;
      report.sideEffects.telemetryWriteAttemptsStubbed += 1;
      // Visual acceptance is deliberately zero-write. Record passive telemetry
      // attempts but do not let the browser mutate the flight/error ledger.
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (url.origin === origin && url.pathname === "/api/announcements/inbox" && method === "GET") {
      report.controlledReadFixtures.announcementInbox += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization, Cookie" },
        body: JSON.stringify({ announcements: [], cursor: "acceptance-empty", serverTime: new Date().toISOString(), unchanged: false }),
      });
      return;
    }

    if (url.origin === origin && providerPathPattern.test(url.pathname)) {
      report.providerRequests.push({ page: activePageId, method, pathname: url.pathname });
      report.sideEffects.browserProviderRequestsObserved += 1;
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (url.origin !== origin) {
      const external = { page: activePageId, method, url: `${url.origin}${url.pathname}` };
      if (/^(?:fonts\.googleapis\.com|fonts\.gstatic\.com)$/iu.test(url.hostname)) {
        report.externalFontsFiltered.push(external);
        await route.fulfill({ status: 204, body: "" });
      } else {
        report.externalRequests.push(external);
        await route.abort("blockedbyclient");
      }
      return;
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      report.blockedWrites.push({ page: activePageId, method, pathname: url.pathname });
      report.sideEffects.browserBusinessWriteAttemptsObserved += 1;
      await route.fulfill({ status: 204, contentType: "application/json", body: "{}" });
      return;
    }

    await route.continue();
  });
}

async function waitForPageReady(page, definition) {
  if (definition.selector) {
    await page.locator(definition.selector).waitFor({ state: "visible", timeout: 60_000 });
  }
  await page.getByText(definition.heading, { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await page.locator('[data-testid="admin-tab-locked"]').count(), 0, `ADMIN_TAB_LOCKED:${definition.id}`);

  if (definition.id === "security") {
    await page.getByText("隐私：手机号与 IP 默认脱敏", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  }
  if (definition.id === "guard-logs" || definition.id === "login-logs") {
    await page.getByRole("button", { name: "刷新数据", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  }
  if (definition.id === "dashboard") {
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid^="command-center-headline-"]').length === 3
      && document.querySelectorAll('[data-testid="command-center-sections"] > section[data-section]').length === 7
    ), undefined, { timeout: 90_000 });
  }
  if (definition.id === "health") {
    await page.getByRole("button", { name: "立即检查", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await page.getByText("数据库连接", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  }
  await page.waitForTimeout(350);
}

async function samplePage(page, definition) {
  activePageId = definition.id;
  const readinessResponse = definition.readinessPath
    ? page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return url.origin === origin && url.pathname === definition.readinessPath;
      }, { timeout: 90_000 })
    : null;
  const response = await page.goto(`${origin}${definition.url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `PAGE_UNAVAILABLE:${definition.url}:${response?.status()}`);
  if (readinessResponse) {
    const ready = await readinessResponse;
    assert.equal(ready.status(), 200, `PAGE_DATA_UNAVAILABLE:${definition.id}:${ready.status()}`);
  }
  await waitForPageReady(page, definition);
  await resetScrollPositions(page);

  const metrics = await page.evaluate(() => {
    const main = document.querySelector("main");
    const heading = main?.querySelector("h1,h2,h3");
    const mainStyle = main ? getComputedStyle(main) : null;
    const bodyStyle = getComputedStyle(document.body);
    const headingStyle = heading ? getComputedStyle(heading) : null;
    return {
      title: document.title,
      path: `${location.pathname}${location.search}`,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      bodyWidth: document.body.scrollWidth,
      mainScrollWidth: main?.scrollWidth ?? null,
      mainClientWidth: main?.clientWidth ?? null,
      mainText: (main?.innerText || "").replace(/\s+/gu, " ").trim(),
      securityAttributeText: main
        ? [...main.querySelectorAll("*")].flatMap((element) => {
            const values = [
              element.getAttribute("title"),
              element.getAttribute("aria-label"),
              element.getAttribute("href"),
              element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : null,
            ];
            return values.filter(Boolean);
          }).join(" ")
        : "",
      computedStyle: {
        bodyBackgroundColor: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        bodyFontSize: bodyStyle.fontSize,
        mainOverflowX: mainStyle?.overflowX || null,
        headingColor: headingStyle?.color || null,
        headingFontSize: headingStyle?.fontSize || null,
      },
    };
  });

  assert.deepEqual(metrics.viewport, viewport, `DESKTOP_VIEWPORT_DRIFT:${definition.id}`);
  assert.ok(metrics.mainText.length >= 20, `EMPTY_ADMIN_PAGE:${definition.id}`);
  const documentOverflow = Math.max(0, metrics.documentWidth - metrics.documentClientWidth);
  const bodyOverflow = Math.max(0, metrics.bodyWidth - metrics.documentClientWidth);
  const mainOverflow = metrics.mainScrollWidth == null || metrics.mainClientWidth == null
    ? 0
    : Math.max(0, metrics.mainScrollWidth - metrics.mainClientWidth);
  assert.ok(documentOverflow <= 1, `DOCUMENT_HORIZONTAL_OVERFLOW:${definition.id}:${documentOverflow}`);
  assert.ok(bodyOverflow <= 1, `BODY_HORIZONTAL_OVERFLOW:${definition.id}:${bodyOverflow}`);
  assert.ok(mainOverflow <= 1, `MAIN_HORIZONTAL_OVERFLOW:${definition.id}:${mainOverflow}`);

  let trustScan = null;
  if (definition.securitySurface) {
    trustScan = assertTrustedText(`DOM:${definition.id}`, metrics.mainText);
    assertTrustedText(`DOM_ATTRIBUTES:${definition.id}`, metrics.securityAttributeText);
  }

  let dashboard = null;
  if (definition.id === "dashboard") {
    for (const expectedCopy of [
      "平台运营安全指挥中心",
      "只读 · 近实时快照 · 零供应商调用",
      "失败、过期和覆盖不全均原样披露，不用 0 填补未知",
      "15 秒近实时只读轮询 · 非实时流",
      "来源证据与异常聚合",
      "来源异常时间线",
    ]) {
      assert.ok(metrics.mainText.includes(expectedCopy), `COMMAND_CENTER_COPY_MISSING:${expectedCopy}`);
    }
    const surface = page.locator('[data-testid="admin-command-center"]');
    dashboard = {
      headlineCount: await page.locator('[data-testid^="command-center-headline-"]').count(),
      sectionCount: await page.locator('[data-testid="command-center-sections"] > section[data-section]').count(),
      sectionIds: await page.locator('[data-testid="command-center-sections"] > section[data-section]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section"))),
      overallStatus: await surface.getAttribute("data-overall-status"),
      surface: await surface.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: style.color,
          overflowX: style.overflowX,
          visibility: style.visibility,
          opacity: Number(style.opacity),
          ariaBusy: element.getAttribute("aria-busy"),
          baseBackground: style.getPropertyValue("--cc-bg").trim(),
        };
      }),
      geometry: await surface.evaluate((element) => {
        const surfaceRect = element.getBoundingClientRect();
        const nodes = [
          ...element.querySelectorAll('[data-testid^="command-center-headline-"]'),
          ...element.querySelectorAll('[data-testid="command-center-sections"] > section[data-section]'),
        ];
        const boxes = nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            id: node.getAttribute("data-testid") || node.getAttribute("data-section") || "unknown",
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: rect.width, height: rect.height,
            display: style.display, visibility: style.visibility, opacity: Number(style.opacity), color: style.color,
          };
        });
        const overlaps = [];
        for (let left = 0; left < boxes.length; left += 1) {
          for (let right = left + 1; right < boxes.length; right += 1) {
            const a = boxes[left];
            const b = boxes[right];
            const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapWidth > 1 && overlapHeight > 1) overlaps.push(`${a.id}:${b.id}`);
          }
        }
        return {
          surface: { left: surfaceRect.left, right: surfaceRect.right, top: surfaceRect.top, bottom: surfaceRect.bottom },
          boxes,
          overlaps,
        };
      }),
    };
    assert.equal(dashboard.headlineCount, 3, "COMMAND_CENTER_HEADLINE_COUNT");
    assert.equal(dashboard.sectionCount, 7, "COMMAND_CENTER_SECTION_COUNT");
    assert.deepEqual(dashboard.sectionIds, ["business", "finance", "tasks", "models", "security", "operations", "governance"], "COMMAND_CENTER_SECTION_ORDER");
    assert.ok(dashboard.surface.width >= 900, `COMMAND_CENTER_SURFACE_TOO_NARROW:${dashboard.surface.width}`);
    assert.equal(dashboard.surface.ariaBusy, "false", "COMMAND_CENTER_MUST_FINISH_LOADING");
    assert.equal(await page.locator('[data-testid="command-center-load-error"]').count(), 0, "COMMAND_CENTER_LOAD_ERROR_VISIBLE");
    assert.notEqual(dashboard.surface.backgroundImage, "none", "COMMAND_CENTER_BACKGROUND_MISSING");
    assert.equal(dashboard.surface.visibility, "visible", "COMMAND_CENTER_NOT_VISIBLE");
    assert.ok(dashboard.surface.opacity > 0.99, "COMMAND_CENTER_SURFACE_TRANSPARENT");
    assert.match(dashboard.surface.baseBackground, /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu, "COMMAND_CENTER_BASE_BACKGROUND_INVALID");
    assert.deepEqual(dashboard.geometry.overlaps, [], `COMMAND_CENTER_CARD_OVERLAP:${dashboard.geometry.overlaps.join(",")}`);
    for (const box of dashboard.geometry.boxes) {
      assert.ok(box.width > 80 && box.height > 40, `COMMAND_CENTER_CARD_COLLAPSED:${box.id}`);
      assert.notEqual(box.display, "none", `COMMAND_CENTER_CARD_DISPLAY_NONE:${box.id}`);
      assert.equal(box.visibility, "visible", `COMMAND_CENTER_CARD_HIDDEN:${box.id}`);
      assert.ok(box.opacity > 0.99, `COMMAND_CENTER_CARD_TRANSPARENT:${box.id}`);
      assert.ok(box.left >= dashboard.geometry.surface.left - 1 && box.right <= dashboard.geometry.surface.right + 1, `COMMAND_CENTER_CARD_OUTSIDE_HORIZONTAL_SURFACE:${box.id}`);
      assert.ok(box.top >= dashboard.geometry.surface.top - 1 && box.bottom <= dashboard.geometry.surface.bottom + 1, `COMMAND_CENTER_CARD_OUTSIDE_VERTICAL_SURFACE:${box.id}`);
    }

    const windowSelect = page.getByLabel("平台指挥中心统计窗口");
    const pollToggle = page.getByTestId("command-center-poll-toggle");
    const waitForSnapshot = (hours, refresh = false, timeout = 25_000) => page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return url.origin === origin
        && url.pathname === "/api/admin/command-center"
        && url.searchParams.get("hours") === String(hours)
        && (refresh ? url.searchParams.get("refresh") === "1" : url.searchParams.get("refresh") !== "1");
    }, { timeout });
    const assertRenderedSnapshot = async (hours) => {
      await page.waitForFunction((expectedHours) => {
        const surfaceNode = document.querySelector('[data-testid="admin-command-center"]');
        return surfaceNode?.getAttribute("aria-busy") === "false"
          && surfaceNode.textContent?.includes(`${expectedHours} 小时窗口`);
      }, hours, { timeout: 25_000 });
      assert.equal(await windowSelect.inputValue(), String(hours), `COMMAND_CENTER_WINDOW_CONTROL_MISMATCH:${hours}`);
      assert.equal(await page.locator('[data-testid="command-center-load-error"]').count(), 0, `COMMAND_CENTER_LOAD_ERROR_AFTER_INTERACTION:${hours}`);
    };

    assert.equal(await pollToggle.getAttribute("aria-pressed"), "false", "COMMAND_CENTER_POLLING_INITIAL_STATE_INVALID");
    let pausedRequestCount = 0;
    const countPausedRequests = (candidate) => {
      const url = new URL(candidate.url());
      if (url.origin === origin && url.pathname === "/api/admin/command-center") pausedRequestCount += 1;
    };
    page.on("response", countPausedRequests);
    await pollToggle.click();
    assert.equal(await pollToggle.getAttribute("aria-pressed"), "true", "COMMAND_CENTER_PAUSE_CONTROL_FAILED");
    await page.waitForTimeout(16_250);
    assert.equal(pausedRequestCount, 0, "COMMAND_CENTER_POLLING_CONTINUED_WHILE_PAUSED");
    const resumedPoll = waitForSnapshot(24, false, 20_000);
    await pollToggle.click();
    assert.equal(await pollToggle.getAttribute("aria-pressed"), "false", "COMMAND_CENTER_RESUME_CONTROL_FAILED");
    const resumedResponse = await resumedPoll;
    assert.equal(resumedResponse.status(), 200, `COMMAND_CENTER_RESUMED_POLL_FAILED:${resumedResponse.status()}`);
    page.off("response", countPausedRequests);
    await assertRenderedSnapshot(24);
    await pollToggle.click();
    assert.equal(await pollToggle.getAttribute("aria-pressed"), "true", "COMMAND_CENTER_SECOND_PAUSE_FAILED");
    await windowSelect.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "command-center-poll-toggle", "COMMAND_CENTER_KEYBOARD_ORDER_FAILED");
    const response72Promise = waitForSnapshot(72);
    await windowSelect.selectOption("72");
    const response72 = await response72Promise;
    assert.equal(response72.status(), 200, `COMMAND_CENTER_72_HOUR_REQUEST_FAILED:${response72.status()}`);
    const body72 = await response72.json();
    assert.equal(body72?.window?.hours, 72, "COMMAND_CENTER_72_HOUR_RESPONSE_MISMATCH");
    assert.ok(Number.isFinite(Date.parse(body72?.generatedAt)), "COMMAND_CENTER_72_HOUR_TIMESTAMP_INVALID");
    await assertRenderedSnapshot(72);
    const response24Promise = waitForSnapshot(24);
    await windowSelect.selectOption("24");
    const response24 = await response24Promise;
    assert.equal(response24.status(), 200, `COMMAND_CENTER_24_HOUR_REQUEST_FAILED:${response24.status()}`);
    const body24 = await response24.json();
    assert.equal(body24?.window?.hours, 24, "COMMAND_CENTER_24_HOUR_RESPONSE_MISMATCH");
    await assertRenderedSnapshot(24);
    const manualRefreshPromise = waitForSnapshot(24, true);
    await page.getByTestId("command-center-refresh").click();
    const manualRefresh = await manualRefreshPromise;
    assert.equal(manualRefresh.status(), 200, `COMMAND_CENTER_MANUAL_REFRESH_FAILED:${manualRefresh.status()}`);
    const refreshedBody = await manualRefresh.json();
    assert.equal(refreshedBody?.window?.hours, 24, "COMMAND_CENTER_REFRESH_WINDOW_MISMATCH");
    assert.ok(Date.parse(refreshedBody?.generatedAt) >= Date.parse(body24?.generatedAt), "COMMAND_CENTER_REFRESH_TIMESTAMP_REGRESSED");
    await assertRenderedSnapshot(24);
    assert.ok((await surface.innerText()).includes("页面接收"), "COMMAND_CENTER_RECEIVED_AT_MISSING");
    await page.getByTestId("command-center-data-quality").waitFor({ state: "visible", timeout: 10_000 });
    const firstEvidence = page.locator('[data-testid^="command-center-evidence-"]').first();
    await firstEvidence.locator("summary").click();
    assert.ok(await firstEvidence.locator('a[data-source-state]').count() > 0, "COMMAND_CENTER_METRIC_EVIDENCE_CHAIN_EMPTY");
    await firstEvidence.locator("summary").click();
    await pollToggle.click();
    assert.equal(await pollToggle.getAttribute("aria-pressed"), "false", "COMMAND_CENTER_FINAL_RESUME_FAILED");
    dashboard.controls = {
      pauseObservedAcrossPollInterval: true,
      resumeTriggeredPolling: true,
      keyboardOrder: true,
      window72ResponseMatched: true,
      returnedTo24ResponseMatched: true,
      manualRefreshResponseMatched: true,
      metricEvidenceExpanded: true,
    };
  }

  const screenshotScrollState = await resetScrollPositions(page);
  const screenshotName = `${definition.id}-1440x900.png`;
  await page.screenshot({ path: absoluteEvidencePath(screenshotName), fullPage: false });
  const dashboardScrollEvidence = definition.id === "dashboard"
    ? await captureDashboardScrollEvidence(page)
    : null;

  report.pages.push({
    id: definition.id,
    url: `${origin}${definition.url}`,
    heading: definition.heading,
    visibleTextLength: metrics.mainText.length,
    viewport: metrics.viewport,
    horizontalOverflow: { document: documentOverflow, body: bodyOverflow, main: mainOverflow },
    computedStyle: metrics.computedStyle,
    trustScan,
    dashboard,
    screenshotScrollState,
    dashboardScrollEvidence,
    screenshot: relativeEvidencePath(screenshotName),
  });
}

async function fetchAuthenticatedApisInPage(page) {
  activePageId = "dashboard-api-fetch";
  const responses = await page.evaluate(async (definitions) => {
    const sessionToken = localStorage.getItem("auth_token") || "";
    return Promise.all(definitions.map(async (definition) => {
      const response = await fetch(definition.path, {
        method: "GET",
        headers: { Authorization: `Bearer ${sessionToken}` },
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });
      return {
        id: definition.id,
        path: definition.path,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        cacheControl: response.headers.get("cache-control") || "",
        vary: response.headers.get("vary") || "",
        body: await response.text(),
      };
    }));
  }, apiDefinitions);

  const bodies = new Map();
  for (const response of responses) {
    assert.equal(response.status, 200, `AUTHENTICATED_API_FAILED:${response.id}:${response.status}`);
    assertJsonContentType(`AUTHENTICATED_API:${response.id}`, response.contentType);
    assertNoStore(`AUTHENTICATED_API:${response.id}`, response.cacheControl);
    if (["command-center", "health"].includes(response.id)) {
      assertPrivateNoStore(`AUTHENTICATED_API:${response.id}`, response.cacheControl);
      assertVaryAuthorizationCookie(`AUTHENTICATED_API:${response.id}`, response.vary);
    }
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      assert.fail(`AUTHENTICATED_API_INVALID_JSON:${response.id}`);
    }
    bodies.set(response.id, body);
    assert.ok(isPlainRecord(body), `AUTHENTICATED_API_BODY_OBJECT_REQUIRED:${response.id}`);
    const unsafePaths = response.id === "version"
      ? null
      : unsafeValuePaths(body);
    if (unsafePaths) {
      unsafePaths.bareLongIdentifiers = unsafePaths.bareLongIdentifiers
        .filter((jsonPath) => !isDocumentedLongIdentifierField(response.id, jsonPath));
    }
    const sensitivePaths = response.id === "version" ? [] : sensitiveKeyPaths(body);
    report.api.push({
      id: response.id,
      path: response.path,
      status: response.status,
      contentType: response.contentType,
      cacheControl: response.cacheControl,
      vary: response.vary,
      topLevelKeys: body && typeof body === "object" ? Object.keys(body).sort() : [],
      rowCounts: {
        events: Array.isArray(body?.events) ? body.events.length : null,
        logs: Array.isArray(body?.logs) ? body.logs.length : null,
        sections: Array.isArray(body?.sections) ? body.sections.length : null,
        sources: Array.isArray(body?.sources) ? body.sources.length : null,
      },
      unsafePaths,
      sensitiveKeyPaths: sensitivePaths,
    });
    for (const [type, paths] of Object.entries(unsafePaths || {})) {
      if (Array.isArray(paths) && paths.length > 0) report.contractViolations.push({ api: response.id, type, paths });
    }
    if (sensitivePaths.length > 0) report.contractViolations.push({ api: response.id, type: "sensitive-key", paths: sensitivePaths });
  }

  const security = bodies.get("security");
  const guard = bodies.get("guard");
  const login = bodies.get("login");
  const commandCenter = bodies.get("command-center");
  const credentialHealth = bodies.get("credential-health");
  const health = bodies.get("health");
  const version = bodies.get("version");

  const securityKeys = collectKeys(security);
  const guardKeys = collectKeys(guard);
  const loginKeys = collectKeys(login);
  if (securityKeys.has("raw_data")) report.contractViolations.push({ api: "security", type: "forbidden-key", paths: ["raw_data"] });
  if (guardKeys.has("full_message")) report.contractViolations.push({ api: "guard", type: "forbidden-key", paths: ["full_message"] });
  if (loginKeys.has("raw_data")) report.contractViolations.push({ api: "login", type: "forbidden-key", paths: ["raw_data"] });
  if (security?.summary?.dataQuality?.sensitiveFields !== "masked") report.contractViolations.push({ api: "security", type: "masked-declaration-missing", paths: ["$.summary.dataQuality.sensitiveFields"] });
  if (security?.summary?.dataQuality?.historicalValuesPreserved !== true) report.contractViolations.push({ api: "security", type: "historical-preservation-missing", paths: ["$.summary.dataQuality.historicalValuesPreserved"] });
  assert.ok(Array.isArray(security?.events), "SECURITY_API_EVENTS_MISSING");
  assert.ok(Array.isArray(guard?.logs), "GUARD_API_LOGS_MISSING");
  assert.ok(Array.isArray(login?.logs), "LOGIN_API_LOGS_MISSING");
  for (const [label, body, rows] of [
    ["SECURITY", security, security.events],
    ["GUARD", guard, guard.logs],
    ["LOGIN", login, login.logs],
  ]) {
    assert.equal(body.page, 1, `${label}_PAGE_MISMATCH`);
    assert.equal(body.pageSize, 20, `${label}_PAGE_SIZE_MISMATCH`);
    assertSafeNonNegativeInteger(`${label}_TOTAL`, body.total);
    assert.ok(rows.length <= body.pageSize, `${label}_PAGE_OVERFLOW`);
    assert.ok(body.total >= rows.length, `${label}_TOTAL_SMALLER_THAN_PAGE`);
  }
  const securityEventFields = [
    "id", "event_type", "risk_level", "ip_address", "user_id", "username", "display_name",
    "phone", "source", "user_agent", "path", "method", "details", "blocked", "created_at",
    "identity_status", "label_source",
  ];
  const securityRiskUserFields = [
    "user_id", "count", "username", "display_name", "phone", "sources", "label_source",
  ];
  const guardLogFields = [
    "id", "user_id", "user_display_name", "user_academy", "agent_name", "agent_source",
    "message_preview", "risk_level", "reason", "matched_patterns", "blocked_at",
  ];
  const loginLogFields = [
    "id", "user_id", "username", "display_name", "ip_address", "user_agent", "login_method",
    "status", "fail_reason", "created_at",
  ];
  const riskUsers = security?.summary?.topRiskyUsers || [];
  for (const [label, rows, fields] of [
    ["SECURITY_EVENTS", security.events, securityEventFields],
    ["SECURITY_TOP_RISKY_USERS", riskUsers, securityRiskUserFields],
    ["GUARD_LOGS", guard.logs, guardLogFields],
    ["LOGIN_LOGS", login.logs, loginLogFields],
  ]) {
    assertOnlyKeys(label, rows, fields);
    assertRequiredKeys(label, rows, fields);
  }
  assert.ok(security.events.every((row) => typeof row.id === "string" && typeof row.event_type === "string" && typeof row.created_at === "string"), "SECURITY_EVENT_FIELD_TYPES_INVALID");
  assert.ok(guard.logs.every((row) => typeof row.id === "string" && Array.isArray(row.matched_patterns) && typeof row.blocked_at === "string"), "GUARD_LOG_FIELD_TYPES_INVALID");
  assert.ok(login.logs.every((row) => typeof row.id === "string" && typeof row.status === "string" && typeof row.created_at === "string"), "LOGIN_LOG_FIELD_TYPES_INVALID");
  for (const [label, rows] of [
    ["SECURITY_EVENTS", security.events],
    ["SECURITY_TOP_RISKY_USERS", riskUsers],
    ["GUARD_LOGS", guard.logs],
    ["LOGIN_LOGS", login.logs],
  ]) {
    rows.forEach((row, index) => {
      if ("user_id" in row) assertMaskedSecurityIdentifier(`${label}[${index}].user_id`, row.user_id, "user");
      if ("username" in row) assertMaskedSecurityIdentifier(`${label}[${index}].username`, row.username, "user");
      if ("phone" in row) assertMaskedSecurityIdentifier(`${label}[${index}].phone`, row.phone, "phone");
      if ("ip_address" in row) assertMaskedSecurityIdentifier(`${label}[${index}].ip_address`, row.ip_address, "ip");
    });
  }
  const securityUnsafePaths = report.api.find((entry) => entry.id === "security")?.unsafePaths
    || { mojibake: [], barePhones: [], bareLongIdentifiers: [], bareIpv4: [] };

  report.securityContract = {
    scope: "authenticated first page, up to 20 rows per security surface, plus deterministic focused masking contract",
    deterministicFocusedContract: "scripts/verify-security-auxiliary-log-display.ts",
    liveRowsObserved: {
      securityEvents: security.events.length,
      guardLogs: guard.logs.length,
      loginLogs: login.logs.length,
      topRiskyUsers: riskUsers.length,
    },
    securityRawDataAbsent: true,
    guardFullMessageAbsent: true,
    loginRawDataAbsent: true,
    sensitiveFields: security.summary.dataQuality.sensitiveFields,
    historicalValuesPreserved: security.summary.dataQuality.historicalValuesPreserved,
    securityEventCount: security.events.length,
    guardLogCount: guard.logs.length,
    loginLogCount: login.logs.length,
    mojibakeViolationCount: securityUnsafePaths.mojibake.length,
    barePhoneViolationCount: securityUnsafePaths.barePhones.length,
    bareLongIdentifierViolationCount: securityUnsafePaths.bareLongIdentifiers.length,
    bareIpv4ViolationCount: securityUnsafePaths.bareIpv4.length,
    bareIpv6ViolationCount: securityUnsafePaths.bareIpv6.length,
    bareEmailViolationCount: securityUnsafePaths.bareEmails.length,
  };

  assert.equal(commandCenter?.schemaVersion, 4, "COMMAND_CENTER_API_SCHEMA_VERSION");
  assert.match(commandCenter?.definitionVersion || "", /^\d{4}-\d{2}-\d{2}\.v\d+$/u, "COMMAND_CENTER_DEFINITION_VERSION_INVALID");
  assert.match(commandCenter?.snapshotId || "", /^cc-[a-f0-9]{16}$/u, "COMMAND_CENTER_SNAPSHOT_ID_INVALID");
  assert.equal(commandCenter?.sections?.length, 7, "COMMAND_CENTER_API_SECTION_COUNT");
  assert.deepEqual(commandCenter.sections.map((section) => section.id), ["business", "finance", "tasks", "models", "security", "operations", "governance"], "COMMAND_CENTER_API_SECTION_ORDER");
  assert.equal(new Set(commandCenter.sections.map((section) => section.id)).size, 7, "COMMAND_CENTER_API_SECTION_IDS_NOT_UNIQUE");
  assert.equal(commandCenter?.window?.hours, 24, "COMMAND_CENTER_API_WINDOW_HOURS");
  assert.equal(commandCenter?.window?.timeZone, "Asia/Shanghai", "COMMAND_CENTER_API_TIME_ZONE");
  assert.ok(["healthy", "warning", "critical", "unknown", "unavailable"].includes(commandCenter?.overallStatus), "COMMAND_CENTER_OVERALL_STATUS_INVALID");
  assert.ok(Number.isFinite(Date.parse(commandCenter?.window?.from)) && Number.isFinite(Date.parse(commandCenter?.window?.to)), "COMMAND_CENTER_WINDOW_TIMESTAMPS_INVALID");
  assert.ok(Number.isFinite(Date.parse(commandCenter.generatedAt)), "COMMAND_CENTER_GENERATED_AT_INVALID");
  assert.ok(Math.abs(Date.now() - Date.parse(commandCenter.generatedAt)) < 5 * 60_000, "COMMAND_CENTER_SNAPSHOT_NOT_FRESH");
  assert.equal(commandCenter?.refresh?.pollIntervalMs, 15_000, "COMMAND_CENTER_API_POLL_INTERVAL");
  assert.equal(commandCenter?.refresh?.readOnly, true, "COMMAND_CENTER_API_READ_ONLY_DECLARATION");
  assert.equal(commandCenter?.refresh?.providerCalls, 0, "COMMAND_CENTER_API_PROVIDER_CALLS");
  assert.equal(commandCenter?.refresh?.businessWrites, 0, "COMMAND_CENTER_API_BUSINESS_WRITES");
  assert.ok(Array.isArray(commandCenter?.sources) && commandCenter.sources.length >= 30, "COMMAND_CENTER_SOURCE_COVERAGE_TOO_SMALL");
  assert.equal(new Set(commandCenter.sources.map((source) => source.id)).size, commandCenter.sources.length, "COMMAND_CENTER_SOURCE_IDS_NOT_UNIQUE");
  assert.ok(commandCenter.sources.every((source) => ["available", "partial", "stale", "unavailable"].includes(source.state)), "COMMAND_CENTER_SOURCE_STATE_INVALID");
  assert.ok(commandCenter.sources.every((source) => typeof source.source === "string" && source.source.length > 0), "COMMAND_CENTER_SOURCE_FACT_MISSING");
  const commandCenterSourceIds = new Set(commandCenter.sources.map((source) => source.id));
  const commandCenterSourceFacts = new Set(commandCenter.sources.map((source) => source.source));
  for (const source of commandCenter.sources) {
    assert.ok(typeof source.label === "string" && source.label.length > 0, `COMMAND_CENTER_SOURCE_LABEL_MISSING:${source.id}`);
    assertSafeNonNegativeInteger(`COMMAND_CENTER_SOURCE_RETURNED_ROWS:${source.id}`, source.returnedRows);
    assert.ok(source.totalRows === null || (Number.isSafeInteger(source.totalRows) && source.totalRows >= source.returnedRows), `COMMAND_CENTER_SOURCE_TOTAL_ROWS_INVALID:${source.id}`);
    assert.equal(typeof source.partial, "boolean", `COMMAND_CENTER_SOURCE_PARTIAL_TYPE_INVALID:${source.id}`);
    assertNullableIsoTimestamp(`COMMAND_CENTER_SOURCE_AS_OF:${source.id}`, source.asOf);
    assertNullableIsoTimestamp(`COMMAND_CENTER_SOURCE_LATEST_RECORD_AT:${source.id}`, source.latestRecordAt);
    assert.ok(source.coverageRatio === null || (typeof source.coverageRatio === "number" && source.coverageRatio >= 0 && source.coverageRatio <= 1), `COMMAND_CENTER_SOURCE_COVERAGE_INVALID:${source.id}`);
    if (source.state === "unavailable") assert.ok(typeof source.errorCode === "string" && source.errorCode.length > 0, `COMMAND_CENTER_UNAVAILABLE_SOURCE_ERROR_CODE_MISSING:${source.id}`);
  }
  const commandCenterMetrics = commandCenter.sections.flatMap((section) => section.metrics || []);
  const commandCenterMetricIds = new Set(commandCenterMetrics.map((metric) => metric.id));
  for (const requiredMetricId of [
    "business.active-users",
    "finance.cash-received",
    "finance.completed-refunds",
    "finance.net-cash-received",
    "finance.refund-frozen-exposure",
    "tasks.success-rate",
    "models.verified",
    "security.high-risk",
    "operations.error-rate",
    "governance.open-security-cases",
    "governance.message-dead-letters",
  ]) {
    assert.ok(commandCenterMetricIds.has(requiredMetricId), `COMMAND_CENTER_REQUIRED_METRIC_MISSING:${requiredMetricId}`);
  }
  for (const metric of commandCenterMetrics) {
    assert.ok(["healthy", "warning", "critical", "unknown", "unavailable"].includes(metric.status), `COMMAND_CENTER_METRIC_STATUS_INVALID:${metric.id}`);
    assert.ok(Array.isArray(metric.source) && metric.source.length > 0, `COMMAND_CENTER_METRIC_SOURCE_MISSING:${metric.id}`);
    assert.ok(Array.isArray(metric.sourceIds) && metric.sourceIds.length > 0, `COMMAND_CENTER_METRIC_SOURCE_IDS_MISSING:${metric.id}`);
    assert.ok(metric.sourceIds.every((sourceId) => commandCenterSourceIds.has(sourceId)), `COMMAND_CENTER_METRIC_SOURCE_ID_UNKNOWN:${metric.id}`);
    assert.ok(metric.source.every((sourceFact) => commandCenterSourceFacts.has(sourceFact)), `COMMAND_CENTER_METRIC_SOURCE_UNKNOWN:${metric.id}`);
    assert.ok(["count", "currency_cny", "percent", "milliseconds", "seconds", "text"].includes(metric.unit), `COMMAND_CENTER_METRIC_UNIT_INVALID:${metric.id}`);
    assert.equal(typeof metric.partial, "boolean", `COMMAND_CENTER_METRIC_PARTIAL_TYPE_INVALID:${metric.id}`);
    if (metric.value === null) assert.ok(["unknown", "unavailable"].includes(metric.status), `COMMAND_CENTER_NULL_VALUE_STATUS_INVALID:${metric.id}`);
  }
  assert.equal(commandCenter?.dataQuality?.totalSources, commandCenter.sources.length, "COMMAND_CENTER_DATA_QUALITY_TOTAL_MISMATCH");
  assert.equal(commandCenter?.dataQuality?.availableSources, commandCenter.sources.filter((source) => source.state === "available").length, "COMMAND_CENTER_DATA_QUALITY_AVAILABLE_MISMATCH");
  assert.equal(commandCenter?.dataQuality?.partialSources, commandCenter.sources.filter((source) => source.state === "partial").length, "COMMAND_CENTER_DATA_QUALITY_PARTIAL_MISMATCH");
  assert.equal(commandCenter?.dataQuality?.unavailableSources, commandCenter.sources.filter((source) => source.state === "unavailable").length, "COMMAND_CENTER_DATA_QUALITY_UNAVAILABLE_MISMATCH");
  assert.equal(commandCenter?.dataQuality?.staleSources, commandCenter.sources.filter((source) => source.state === "stale").length, "COMMAND_CENTER_DATA_QUALITY_STALE_MISMATCH");
  assert.equal(commandCenter?.dataQuality?.sourceAnomalyCount, commandCenter.sourceAnomalies.length, "COMMAND_CENTER_DATA_QUALITY_ANOMALY_MISMATCH");
  assert.ok(Array.isArray(commandCenter.sourceAnomalies), "COMMAND_CENTER_SOURCE_ANOMALIES_MISSING");
  for (const anomaly of commandCenter.sourceAnomalies) {
    assert.ok(commandCenterSourceIds.has(anomaly.sourceId), `COMMAND_CENTER_ANOMALY_SOURCE_UNKNOWN:${anomaly.sourceId}`);
    assert.ok(["warning", "critical"].includes(anomaly.severity), `COMMAND_CENTER_ANOMALY_SEVERITY_INVALID:${anomaly.id}`);
    assert.ok(Number.isFinite(Date.parse(anomaly.detectedAt)), `COMMAND_CENTER_ANOMALY_TIMESTAMP_INVALID:${anomaly.id}`);
  }
  report.commandCenterContract = {
    schemaVersion: commandCenter.schemaVersion,
    definitionVersion: commandCenter.definitionVersion,
    snapshotId: commandCenter.snapshotId,
    dataQuality: commandCenter.dataQuality,
    generatedAt: commandCenter.generatedAt,
    overallStatus: commandCenter.overallStatus,
    sectionCount: commandCenter.sections.length,
    sectionIds: commandCenter.sections.map((section) => section.id),
    sourceCount: Array.isArray(commandCenter.sources) ? commandCenter.sources.length : null,
    metricCount: commandCenterMetrics.length,
    requiredMetricsVerified: true,
    refresh: commandCenter.refresh,
  };

  const credentialKeys = collectKeys(credentialHealth);
  const commandCenterKeys = collectKeys(commandCenter);
  const forbiddenCredentialKeys = [
    "configurationHash", "configuration_hash", "apiKey", "api_key", "rawCredential",
    "resolvedCredential", "credentialSuffix", "secret", "secret_value", "token", "authorization",
  ];
  for (const [api, keys] of [["credential-health", credentialKeys], ["command-center", commandCenterKeys]]) {
    for (const forbiddenKey of forbiddenCredentialKeys) {
      if (keys.has(forbiddenKey)) report.contractViolations.push({ api, type: "forbidden-key", paths: [forbiddenKey] });
    }
  }
  const secretLikeValuePattern = /(?:Bearer\s+(?!\[(?:已隐藏|redacted)\])|sk-[A-Za-z0-9_-]{12,}|(?:secret|env):\/\/|postgres(?:ql)?:\/\/[^\s"']+:[^@\s"']+@|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
  assert.doesNotMatch(JSON.stringify({ credentialHealth, commandCenter }), secretLikeValuePattern, "ADMIN_READ_MODEL_MUST_NOT_RETURN_SECRET_LIKE_VALUES");
  const credentialPolicy = credentialHealth?.policy || {};
  for (const key of [
    "plaintextCredentialReturned",
    "resolvedCredentialReturned",
    "credentialSuffixReturned",
    "configurationIdDerivedFromSecret",
    "configurationHashReturned",
  ]) {
    assert.equal(credentialPolicy[key], false, `CREDENTIAL_POLICY_MUST_BE_FALSE:${key}`);
  }
  assert.equal(credentialPolicy.editFieldsAreWriteOnly, true, "CREDENTIAL_EDIT_FIELDS_MUST_BE_WRITE_ONLY");
  assert.equal(credentialPolicy.validationAndConfigurationSeparated, true, "CREDENTIAL_VALIDATION_CONFIGURATION_MUST_BE_SEPARATED");
  assert.ok(Array.isArray(credentialHealth?.credentials), "CREDENTIAL_HEALTH_ROWS_MISSING");
  assert.ok(credentialHealth.credentials.length > 0, "CREDENTIAL_HEALTH_ROWS_EMPTY");
  assert.ok(isFreshIsoTimestamp(credentialHealth.generatedAt), "CREDENTIAL_HEALTH_SNAPSHOT_NOT_FRESH");
  const credentialFields = [
    "credentialId", "modelId", "modelName", "kind", "purpose", "provider", "configured",
    "storageMode", "storageLabel", "bindingUpdatedAt", "active", "validationStatus",
    "lastValidatedAt", "validationExplanation",
  ];
  assertOnlyKeys("CREDENTIAL_HEALTH_ROWS", credentialHealth.credentials, credentialFields);
  assertRequiredKeys("CREDENTIAL_HEALTH_ROWS", credentialHealth.credentials, credentialFields);
  const credentialIds = new Set();
  for (const [index, row] of credentialHealth.credentials.entries()) {
    assert.ok(["image", "text", "video"].includes(row.kind), `CREDENTIAL_KIND_INVALID:${index}`);
    assert.ok(["isolated_binding", "server_reference", "legacy_restricted", "missing"].includes(row.storageMode), `CREDENTIAL_STORAGE_MODE_INVALID:${index}`);
    assert.ok(["verified", "pending", "needs_attention", "unverified", "not_recorded"].includes(row.validationStatus), `CREDENTIAL_VALIDATION_STATUS_INVALID:${index}`);
    for (const key of ["credentialId", "modelId", "modelName", "purpose", "provider", "storageLabel", "validationExplanation"]) {
      assert.ok(typeof row[key] === "string" && row[key].length > 0, `CREDENTIAL_STRING_FIELD_INVALID:${index}:${key}`);
    }
    assert.equal(typeof row.configured, "boolean", `CREDENTIAL_CONFIGURED_TYPE_INVALID:${index}`);
    assert.equal(typeof row.active, "boolean", `CREDENTIAL_ACTIVE_TYPE_INVALID:${index}`);
    assertNullableIsoTimestamp(`CREDENTIAL_BINDING_UPDATED_AT:${index}`, row.bindingUpdatedAt);
    assertNullableIsoTimestamp(`CREDENTIAL_LAST_VALIDATED_AT:${index}`, row.lastValidatedAt);
    const table = row.kind === "image" ? "cover_models" : row.kind === "text" ? "llm_models" : "video_models";
    const expectedCredentialId = `cfg_${createHash("sha256").update(`credential-health:v1:${table}:${row.modelId}`).digest("hex").slice(0, 12)}`;
    assert.equal(row.credentialId, expectedCredentialId, `CREDENTIAL_IDENTITY_DERIVATION_MISMATCH:${index}`);
    assert.ok(!credentialIds.has(row.credentialId), `CREDENTIAL_ID_DUPLICATE:${row.credentialId}`);
    credentialIds.add(row.credentialId);
  }
  assert.equal(credentialHealth?.summary?.total, credentialHealth.credentials.length, "CREDENTIAL_HEALTH_SUMMARY_TOTAL_MISMATCH");
  assert.equal(credentialHealth.summary.configured + credentialHealth.summary.missing, credentialHealth.summary.total, "CREDENTIAL_HEALTH_CONFIGURED_MISSING_MISMATCH");
  assert.equal(credentialHealth.summary.configured, credentialHealth.credentials.filter((row) => row.configured).length, "CREDENTIAL_HEALTH_CONFIGURED_RECOMPUTE_MISMATCH");
  assert.equal(credentialHealth.summary.missing, credentialHealth.credentials.filter((row) => !row.configured).length, "CREDENTIAL_HEALTH_MISSING_RECOMPUTE_MISMATCH");
  assert.equal(credentialHealth.summary.isolated, credentialHealth.credentials.filter((row) => ["isolated_binding", "server_reference"].includes(row.storageMode)).length, "CREDENTIAL_HEALTH_ISOLATED_RECOMPUTE_MISMATCH");
  assert.equal(credentialHealth.summary.legacyReview, credentialHealth.credentials.filter((row) => row.storageMode === "legacy_restricted").length, "CREDENTIAL_HEALTH_LEGACY_RECOMPUTE_MISMATCH");
  assert.equal(credentialHealth.summary.verified, credentialHealth.credentials.filter((row) => row.validationStatus === "verified").length, "CREDENTIAL_HEALTH_VERIFIED_RECOMPUTE_MISMATCH");
  const llmRows = Array.isArray(credentialHealth?.credentials)
    ? credentialHealth.credentials.filter((row) => row?.kind === "text")
    : [];
  assert.ok(llmRows.length > 0, "CREDENTIAL_HEALTH_TEXT_ROWS_EMPTY");
  assert.ok(llmRows.every((row) => ["verified", "pending", "needs_attention", "unverified", "not_recorded"].includes(row?.validationStatus)), "CREDENTIAL_HEALTH_LLM_STATUS_INVALID");
  report.credentialHealthContract = {
    llmRows: llmRows.length,
    configurationHashReturned: credentialKeys.has("configurationHash") || credentialKeys.has("configuration_hash"),
    secretReturned: ["apiKey", "api_key", "secret", "secret_value"].some((key) => credentialKeys.has(key)),
    validationStatuses: [...new Set(llmRows.map((row) => row?.validationStatus).filter(Boolean))],
    policy: credentialPolicy,
    summary: credentialHealth.summary,
  };

  const errorTrend = Array.isArray(health?.checks)
    ? health.checks.find((check) => check?.name === "错误趋势")
    : null;
  assert.ok(errorTrend, "HEALTH_ERROR_TREND_MISSING");
  const healthExternalProbeClaims = health.checks
    .filter((check) => Object.prototype.hasOwnProperty.call(check?.details || {}, "externalProbeExecuted"))
    .map((check) => ({ name: check.name, externalProbeExecuted: check.details.externalProbeExecuted }));
  const storageHealth = health.checks.find((check) => check?.name === "对象存储");
  const cozeHealth = health.checks.find((check) => check?.name === "Coze 配置");
  const activityHealth = health.checks.find((check) => check?.name === "系统概览");
  assert.ok(storageHealth, "HEALTH_OBJECT_STORAGE_CHECK_MISSING");
  assert.ok(cozeHealth, "HEALTH_COZE_CONFIGURATION_CHECK_MISSING");
  assert.ok(activityHealth, "HEALTH_SYSTEM_OVERVIEW_CHECK_MISSING");
  assert.ok(isFreshIsoTimestamp(health.timestamp), "HEALTH_SNAPSHOT_NOT_FRESH");
  assertSafeNonNegativeInteger("HEALTH_SUMMARY_TOTAL", health?.summary?.total);
  for (const key of ["healthy", "degraded", "unhealthy"]) assertSafeNonNegativeInteger(`HEALTH_SUMMARY_${key.toUpperCase()}`, health?.summary?.[key]);
  assert.equal(health.summary.total, health.checks.length, "HEALTH_SUMMARY_TOTAL_MISMATCH");
  assert.equal(health.summary.healthy + health.summary.degraded + health.summary.unhealthy, health.summary.total, "HEALTH_SUMMARY_BUCKET_MISMATCH");
  assert.ok(["available", "unavailable"].includes(activityHealth?.details?.availability), "HEALTH_SYSTEM_OVERVIEW_AVAILABILITY_MISSING");
  if (activityHealth.details.availability === "available") {
    for (const key of ["users", "admins", "activeAgents"]) assertSafeNonNegativeInteger(`HEALTH_SYSTEM_OVERVIEW_${key}`, activityHealth.details[key]);
  } else {
    assert.equal(activityHealth.status, "unhealthy", "UNAVAILABLE_SYSTEM_OVERVIEW_MUST_FAIL_CLOSED");
    for (const key of ["users", "admins", "activeAgents"]) assert.equal(activityHealth.details[key], null, `UNAVAILABLE_SYSTEM_OVERVIEW_${key}_MUST_BE_NULL`);
    assert.equal(health.status, "unhealthy", "UNAVAILABLE_SYSTEM_OVERVIEW_MUST_DEGRADE_OVERALL_HEALTH");
  }
  assert.ok(isPlainRecord(health.evidenceAvailability), "HEALTH_EVIDENCE_AVAILABILITY_MISSING");
  for (const key of ["latestCheck", "recentLogs", "recentFixes"]) {
    assert.ok(["available", "absent", "unavailable"].includes(health.evidenceAvailability[key]), `HEALTH_EVIDENCE_AVAILABILITY_INVALID:${key}`);
  }
  assert.equal(storageHealth.details.externalProbeExecuted, false, "HEALTH_OBJECT_STORAGE_EXTERNAL_PROBE_MUST_BE_DISABLED");
  assert.equal(storageHealth.details.connectivityState, "unknown", "HEALTH_OBJECT_STORAGE_CONNECTIVITY_MUST_REMAIN_UNKNOWN");
  assert.notEqual(storageHealth.status, "healthy", "UNPROBED_OBJECT_STORAGE_MUST_NOT_BE_HEALTHY");
  assert.equal(cozeHealth.details.externalProbeExecuted, false, "HEALTH_COZE_EXTERNAL_PROBE_MUST_BE_DISABLED");
  assert.ok(healthExternalProbeClaims.every((claim) => claim.externalProbeExecuted === false), "HEALTH_DEFAULT_ROUTE_EXECUTED_EXTERNAL_PROBE");
  assert.ok(["healthy", "degraded", "unhealthy"].includes(errorTrend.status), "HEALTH_ERROR_TREND_STATUS_INVALID");
  assert.ok(["available", "unavailable"].includes(errorTrend?.details?.availability), "HEALTH_ERROR_TREND_AVAILABILITY_MISSING");
  if (errorTrend.details.availability === "unavailable") {
    assert.equal(errorTrend.status, "unhealthy", "UNAVAILABLE_ERROR_TREND_MUST_FAIL_CLOSED");
    assert.equal(errorTrend.details.errors, null, "UNAVAILABLE_ERROR_TREND_MUST_NOT_REPORT_ZERO");
    assert.equal(errorTrend.details.critical, null, "UNAVAILABLE_CRITICAL_TREND_MUST_NOT_REPORT_ZERO");
    assert.equal(health.status, "unhealthy", "UNAVAILABLE_ERROR_TREND_MUST_DEGRADE_OVERALL_HEALTH");
    assert.ok(Number(health?.summary?.unhealthy || 0) >= 1, "UNAVAILABLE_ERROR_TREND_MUST_COUNT_AS_UNHEALTHY");
  } else {
    assert.ok(Number.isSafeInteger(errorTrend.details.errors) && errorTrend.details.errors >= 0, "AVAILABLE_ERROR_COUNT_INVALID");
    assert.ok(Number.isSafeInteger(errorTrend.details.critical) && errorTrend.details.critical >= 0, "AVAILABLE_CRITICAL_COUNT_INVALID");
  }
  report.healthContract = {
    overallStatus: health.status,
    errorTrend: {
      status: errorTrend.status,
      availability: errorTrend.details.availability,
      errors: errorTrend.details.errors,
      critical: errorTrend.details.critical,
      errorCode: errorTrend.details.errorCode || null,
    },
    externalProbeClaims: healthExternalProbeClaims,
    objectStorage: {
      status: storageHealth.status,
      connectivityState: storageHealth.details.connectivityState,
      externalProbeExecuted: storageHealth.details.externalProbeExecuted,
    },
    systemOverview: {
      status: activityHealth.status,
      availability: activityHealth.details.availability,
      users: activityHealth.details.users,
      admins: activityHealth.details.admins,
      activeAgents: activityHealth.details.activeAgents,
    },
  };

  assert.equal(version?.sourceVersion, expectedSourceVersion, `SOURCE_VERSION_MISMATCH:${version?.sourceVersion}`);
  assert.equal(version?.buildId, expectedBuildId, `BUILD_ID_MISMATCH:${version?.buildId}`);
  report.runtime = {
    sourceVersion: version.sourceVersion,
    buildId: version.buildId,
    environment: version.env,
    versionEndpoint: `${origin}/api/version`,
  };
}

async function verifyGovernanceGates() {
  const liveClaims = decodeJwt(token);
  const forgedToken = await new SignJWT({
    userId: liveClaims.userId || identity?.user?.id || "forged",
    role: "admin",
    ...(typeof liveClaims.sessionId === "string" ? { sessionId: liveClaims.sessionId } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(`wrong-signing-key-for-${expectedSourceVersion}`));

  const authorizationCases = [
    { id: "security", path: "/api/admin/security-events?page=1&pageSize=1", noAuth: [401, "AUTH_REQUIRED"], forged: [401, "UNAUTHENTICATED"] },
    { id: "guard", path: "/api/admin/guard-logs?page=1&pageSize=1", noAuth: [401, "AUTH_REQUIRED"], forged: [401, "UNAUTHENTICATED"] },
    { id: "login", path: "/api/admin/login-logs?page=1&pageSize=1", noAuth: [401, "AUTH_REQUIRED"], forged: [401, "UNAUTHENTICATED"] },
    { id: "command-center", path: "/api/admin/command-center?hours=24", noAuth: [401, "AUTH_REQUIRED"], forged: [401, "UNAUTHENTICATED"] },
    { id: "credential-health", path: "/api/admin/credential-health", noAuth: [401, "AUTH_REQUIRED"], forged: [401, "UNAUTHENTICATED"] },
    { id: "health", path: "/api/health", noAuth: [401, null], forged: [401, "UNAUTHENTICATED"] },
  ];
  for (const definition of authorizationCases) {
    for (const [mode, authorization, expected] of [
      ["no-auth", null, definition.noAuth],
      ["forged-signature", `Bearer ${forgedToken}`, definition.forged],
    ]) {
      const response = await fetch(`${origin}${definition.path}`, {
        headers: authorization ? { Authorization: authorization } : {},
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json().catch(() => ({}));
      assert.equal(response.status, expected[0], `AUTH_NEGATIVE_STATUS_MISMATCH:${definition.id}:${mode}`);
      if (expected[1]) assert.equal(body.code, expected[1], `AUTH_NEGATIVE_CODE_MISMATCH:${definition.id}:${mode}`);
      assertJsonContentType(`AUTH_NEGATIVE:${definition.id}:${mode}`, response.headers.get("content-type") || "");
      assertNoStore(`AUTH_NEGATIVE:${definition.id}:${mode}`, response.headers.get("cache-control") || "");
      report.authorizationNegativeChecks.push({ id: definition.id, mode, status: response.status, code: body.code || null, cacheControlNoStore: true });
      report.sideEffects.authorizationNegativeRequests += 1;
    }
  }

  const anonymousPopup = await fetch(`${origin}/api/popup-pushes`, { signal: AbortSignal.timeout(30_000) });
  const anonymousPopupBody = await anonymousPopup.json().catch(() => ({}));
  assert.equal(anonymousPopup.status, 200, `ANONYMOUS_POPUP_STATUS_MISMATCH:${anonymousPopup.status}`);
  assert.equal(anonymousPopupBody.success, true, "ANONYMOUS_POPUP_RESPONSE_MUST_SUCCEED_EMPTY");
  assert.deepEqual(anonymousPopupBody.popups, [], "ANONYMOUS_POPUP_RESPONSE_MUST_BE_EMPTY");
  assertPrivateNoStore("ANONYMOUS_POPUP", anonymousPopup.headers.get("cache-control") || "");
  assertVaryAuthorizationCookie("ANONYMOUS_POPUP", anonymousPopup.headers.get("vary") || "");

  const forgedPopup = await fetch(`${origin}/api/popup-pushes`, {
    headers: { Authorization: `Bearer ${forgedToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const forgedPopupBody = await forgedPopup.json().catch(() => ({}));
  const forgedPopupCacheControl = forgedPopup.headers.get("cache-control") || "";
  const forgedPopupVary = forgedPopup.headers.get("vary") || "";
  assert.equal(forgedPopup.status, 401, `FORGED_POPUP_TOKEN_NOT_REJECTED:${forgedPopup.status}`);
  assert.equal(forgedPopupBody.code, "UNAUTHENTICATED", "FORGED_POPUP_AUTH_CODE_MISMATCH");
  assert.equal(forgedPopupBody.success, false, "FORGED_POPUP_RESPONSE_MUST_FAIL");
  assert.deepEqual(forgedPopupBody.popups, [], "FORGED_POPUP_RESPONSE_MUST_BE_EMPTY");
  assertPrivateNoStore("FORGED_POPUP", forgedPopupCacheControl);
  assertVaryAuthorizationCookie("FORGED_POPUP", forgedPopupVary);

  report.sideEffects.liveReadOnlyAuthGateRequests = report.sideEffects.authorizationNegativeRequests + 2;
  report.governanceGates = {
    authorizationNegativeChecks: report.authorizationNegativeChecks.length,
    anonymousPopup: { status: anonymousPopup.status, popups: anonymousPopupBody.popups.length },
    forgedPopup: {
      status: forgedPopup.status,
      code: forgedPopupBody.code || null,
      popups: forgedPopupBody.popups.length,
      cacheControl: forgedPopupCacheControl,
      vary: forgedPopupVary,
    },
    refundGateVerification: "separate offline/local-transaction suite: scripts/verify-payment-refund-exactly-once.mjs",
    paidSupplierCallsInitiatedByBrowser: report.sideEffects.paidSupplierCallsInitiatedByBrowser,
    expectedControlPlaneAuditAttempts: 0,
    browserBusinessWriteAttemptsObserved: report.sideEffects.browserBusinessWriteAttemptsObserved,
  };
}

async function launchBrowser() {
  try {
    await fs.access(bundledChromium);
    return await chromium.launch({ headless: true, executablePath: bundledChromium });
  } catch {
    return chromium.launch({ headless: true });
  }
}

export async function main() {
  let browser;
  let context;
  let caughtError = null;
  try {
    await resetEvidenceDirectory();
    assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_ORIGIN_REQUIRED");
    assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
    await loadAndVerifyRuntimeIdentity();
    assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");

    browser = await launchBrowser();
    context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await installReadOnlyBoundary(context);
    await context.addCookies([{
      name: "auth_token",
      value: token,
      url: origin,
      sameSite: "Lax",
    }]);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    installDiagnostics(page);
    for (const definition of pages) await samplePage(page, definition);
    await fetchAuthenticatedApisInPage(page);
    await verifyGovernanceGates();

    assert.deepEqual(report.providerRequests, [], "PROVIDER_OR_PAID_REQUEST_DETECTED");
    assert.deepEqual(report.blockedWrites, [], "UNEXPECTED_BUSINESS_WRITE_ATTEMPTED");
    assert.deepEqual(report.externalRequests, [], "UNEXPECTED_EXTERNAL_REQUEST_DETECTED");
    assert.deepEqual(report.pageErrors, [], "PAGE_ERRORS_DETECTED");
    assert.deepEqual(report.consoleErrors, [], "CONSOLE_ERRORS_DETECTED");
    assert.deepEqual(report.requestFailures, [], "SAME_ORIGIN_REQUEST_FAILURES_DETECTED");
    assert.deepEqual(report.resourceErrors, [], "SAME_ORIGIN_RESOURCE_ERRORS_DETECTED");
    assert.deepEqual(report.serverErrors, [], "HTTP_5XX_DETECTED");
    assert.deepEqual(report.apiErrors, [], "HTTP_API_ERROR_DETECTED");
    assert.deepEqual(report.contractViolations, [], `SECURITY_TRUST_CONTRACT_VIOLATIONS:${JSON.stringify(report.contractViolations)}`);
    report.uiContractPassed = true;
  } catch (error) {
    caughtError = error;
  } finally {
    for (const [label, resource] of [["context", context], ["browser", browser]]) {
      if (!resource) continue;
      try {
        await resource.close();
      } catch (error) {
        report.cleanupErrors.push({ resource: label, message: redactEvidenceText(error instanceof Error ? error.message : error) });
        if (!caughtError) caughtError = error;
      }
    }
    if (caughtError) {
      report.status = "failed";
      report.passed = false;
      report.failure = {
        name: caughtError instanceof Error ? caughtError.name : "Error",
        message: redactEvidenceText(caughtError instanceof Error ? caughtError.message : caughtError),
        stack: caughtError instanceof Error ? redactEvidenceText(caughtError.stack || "") : "",
        page: activePageId,
      };
    } else {
      report.status = "passed";
      report.passed = true;
    }
    await writeReport();
  }

  if (caughtError) throw caughtError;

  process.stdout.write(`${JSON.stringify({
    passed: report.passed,
    runtime: report.runtime,
    pages: report.pages.length,
    securityContract: report.securityContract,
    commandCenter: report.commandCenterContract,
    credentialHealth: report.credentialHealthContract,
    health: report.healthContract,
    governanceGates: report.governanceGates,
    sideEffects: report.sideEffects,
    telemetry: report.telemetry,
    blockedWrites: report.blockedWrites.length,
    providerRequests: report.providerRequests.length,
    pageErrors: report.pageErrors.length,
    consoleErrors: report.consoleErrors.length,
    serverErrors: report.serverErrors.length,
    evidence: absoluteEvidencePath("report.json"),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
