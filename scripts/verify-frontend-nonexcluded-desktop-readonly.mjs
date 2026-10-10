#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ROOT = path.join(ROOT, "src", "app");
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const MIN_READABLE_FONT_PX = 11;
const DEFAULT_ORIGIN = "http://127.0.0.1:5000";
const origin = String(process.env.LOCAL_NAV_ORIGIN || process.env.BASE_URL || DEFAULT_ORIGIN).replace(/\/+$/u, "");
const sourceOnly = process.argv.includes("--source-only");
const outputArgument = process.argv.find((value) => value.startsWith("--output-dir="));
const outputDir = path.resolve(
  ROOT,
  outputArgument?.slice("--output-dir=".length)
    || process.env.FRONTEND_READONLY_OUTPUT_DIR
    || ".codex-evidence/frontend-nonexcluded-desktop-readonly-20261003",
);
const screenshotsDir = path.join(outputDir, "screenshots");

const EXPECTED_COUNTS = Object.freeze({
  routePatterns: 56,
  browserUrls: 110,
  excludedRedirectBoundaries: 6,
  toolAliases: 37,
  helpSlugs: 19,
  expectedUnpublishedHelpSlugs: 7,
});

const EXCLUDED_ROUTE_PREFIXES = [
  "/commerce",
  "/commerce-agent",
  "/youcai",
  "/youcai-tv",
  "/short-drama",
  "/tools/film-studio",
];

const EXCLUDED_STATIC_FEATURE_PATHS = new Set([
  "/tools/text/drama-script",
]);

const EXCLUDED_REDIRECT_BOUNDARIES = Object.freeze([
  { path: "/articles", target: "/youcai/articles" },
  { path: "/assets", target: "/youcai/assets" },
  { path: "/creative-horizon", target: "/youcai" },
  { path: "/inspiration", target: "/youcai/inspiration" },
  { path: "/navigation", target: "/youcai" },
  { path: "/skills", target: "/youcai/skills" },
]);

const ANONYMOUS_PATTERNS = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/payment/result",
  "/announcements",
  "/help",
  "/help/[slug]",
  "/about",
  "/business",
  "/articles/[slug]",
  "/share/canvas/[shareId]",
]);

const DENIED_FOR_ORDINARY_MEMBER = new Map([
  ["/design-preview", /仅管理员可访问/u],
  ["/voice-studio/admin", /仅管理员可访问智音工坊后台/u],
]);

const CANONICAL_FINAL_PATHS = new Map([
  ["/tools", "/tools?tab=text"],
  ["/tools/utility", "/tools/utility?tab=text"],
]);

const CONFIG_REDIRECT_FINAL_PATHS = new Map([
  ["/extract", "/tools?tab=text"],
  ["/formatter", "/tools?tab=format"],
  ["/segmenter", "/tools?tab=segment"],
]);

const TOOLBOX_PERSISTED_TAB_KEY = "toolbox_active_tab";
const USER_NOTIFICATIONS_PATH = "/api/notifications/user";

const TELEMETRY_PATHS = new Set([
  "/api/product-usage/events",
  "/api/operation-events",
  "/api/announcements/events",
  "/api/diagnostic-logs",
  "/api/client-error-report",
]);

const MODEL_OR_PAID_WRITE_PATTERNS = [
  /^\/api\/llm(?:\/|$)/u,
  /^\/api\/chat(?:\/|$)/u,
  /^\/api\/image\/generate(?:\/|$)/u,
  /^\/api\/video\/(?:generate|cancel|export|reference-upload|local-media\/process)(?:\/|$)/u,
  /^\/api\/voice\/(?:tts|clone|design|upload|billing\/deduct)(?:\/|$)/u,
  /^\/api\/digital-human\/(?:generate|long-generate|cancel|long-cancel|upload)(?:\/|$)/u,
  /^\/api\/payment\/(?:create|notify|refund)(?:\/|$)/u,
  /^\/api\/storyboard\/(?:agent|compile|image)(?:\/|$)/u,
  /^\/api\/canvas\/compile-script(?:\/|$)/u,
  /^\/api\/tools\/creative-plan(?:\/|$)/u,
  /^\/api\/extract(?:\/|$)/u,
];

const EXPLICIT_READONLY_GET_PATHS = new Set([
  "/api/extract/history",
]);

const STATE_ADVANCING_OR_UPSTREAM_GET_PATTERNS = [
  /^\/api\/video\/(?:active-tasks|status|poll|stream|request-status|channel-health|detect-protocol|h3-lifecycle)(?:\/|$)/u,
  /^\/api\/image\/status(?:\/|$)/u,
  /^\/api\/voice\/(?:preview|generation-status|status)(?:\/|$)/u,
  /^\/api\/digital-human\/.+\/(?:status|poll)(?:\/|$)/u,
  /^\/api\/health(?:\/|$)/u,
  /^\/api\/payment\/status(?:\/|$)/u,
];

const SERVER_SIDE_EXTERNAL_BRIDGE_PATTERNS = [
  /^\/api\/fetch-url(?:\/|$)/u,
  /^\/api\/video\/(?:proxy|proxy-download)(?:\/|$)/u,
];

const REPRESENTATIVE_PATHS = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/",
  "/creation-center",
  "/profile",
  "/referral",
  "/recharge",
  "/payment/result",
  "/announcements",
  "/help",
  "/help/storyboard-prompt-image-video",
  "/media-history",
  "/design-preview",
  "/tools",
  "/tools/text",
  "/tools/image",
  "/tools/audio",
  "/tools/video",
  "/tools/audio/mimo-tts",
  "/tools/image/image-edit",
  "/tools/text/script-brief",
  "/tools/video/seedance-video",
  "/tools/video/jimeng-dreamactor-m20",
  "/voice-studio",
  "/voice-studio/workspace",
  "/voice-studio/voices",
  "/voice-studio/clone",
  "/voice-studio/imitate",
  "/voice-studio/design",
  "/voice-studio/nest",
  "/voice-studio/admin",
]);

function isExcludedRoute(pathname) {
  return EXCLUDED_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || (
    ["/commerce", "/youcai"].includes(prefix) && pathname.startsWith(prefix)
  ));
}

function walkPageFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkPageFiles(absolute, files);
    else if (entry.isFile() && entry.name === "page.tsx") files.push(absolute);
  }
  return files;
}

function pagePatternFromFile(absolute) {
  const relative = path.relative(APP_ROOT, absolute).replace(/\\/gu, "/");
  return relative === "page.tsx" ? "/" : `/${relative.replace(/\/page\.tsx$/u, "")}`;
}

function extractQuotedValues(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function unique(values) {
  return [...new Set(values)];
}

function readRedirectTarget(sourceFile) {
  const source = fs.readFileSync(sourceFile, "utf8");
  return source.match(/(?:permanentRedirect|redirect)\(\s*["']([^"']+)["']\s*\)/u)?.[1] || "";
}

function expectedFinalPath(requestedPath, redirectTarget) {
  return redirectTarget
    || CONFIG_REDIRECT_FINAL_PATHS.get(requestedPath)
    || CANONICAL_FINAL_PATHS.get(requestedPath)
    || requestedPath;
}

function readConfiguredRedirects() {
  const source = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  const redirects = new Map();
  for (const match of source.matchAll(/\{\s*source:\s*["']([^"']+)["']\s*,\s*destination:\s*["']([^"']+)["']\s*,\s*permanent:\s*(?:true|false)\s*,?\s*\}/gsu)) {
    redirects.set(match[1], match[2]);
  }
  return redirects;
}

function readDomainHelpArticleContracts(sourceFile) {
  const source = fs.readFileSync(sourceFile, "utf8");
  const marker = "const ARTICLES: HelpArticle[] = [";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "HELP_ARTICLES_ARRAY_MISSING");
  const end = source.indexOf("\n];", start + marker.length);
  assert.notEqual(end, -1, "HELP_ARTICLES_ARRAY_END_MISSING");
  const arraySource = source.slice(start + marker.length, end);
  const blocks = arraySource.split(/\r?\n  \{\r?\n(?=    id:\s*")/u).slice(1);

  return blocks.map((block) => {
    const slug = block.match(/^    slug:\s*"([A-Za-z0-9-]+)"/mu)?.[1] || "";
    const status = block.match(/^    status:\s*"(draft|published)"/mu)?.[1] || "";
    const publishedAtNull = /^    publishedAt:\s*null,?\s*$/mu.test(block);
    assert.ok(slug, "HELP_ARTICLE_SLUG_MISSING");
    assert.ok(status, `HELP_ARTICLE_STATUS_MISSING:${slug}`);
    return { slug, status, publishedAtNull };
  });
}

function sourceRelative(absolute) {
  return path.relative(ROOT, absolute).replace(/\\/gu, "/");
}

function instantiateDynamicPattern(pattern) {
  if (pattern === "/articles/[slug]") return "/articles/legacy-boundary";
  if (pattern === "/share/canvas/[shareId]") return "/share/canvas/legacy-boundary";
  return pattern;
}

function compileSourceManifest() {
  const allPageFiles = walkPageFiles(APP_ROOT).sort((left, right) => left.localeCompare(right));
  const patternToFile = new Map(allPageFiles.map((file) => [pagePatternFromFile(file), file]));
  const boundaryPaths = new Set(EXCLUDED_REDIRECT_BOUNDARIES.map((item) => item.path));
  const routePatterns = [...patternToFile.keys()]
    .filter((pattern) => !isExcludedRoute(pattern)
      && !EXCLUDED_STATIC_FEATURE_PATHS.has(pattern)
      && !pattern.startsWith("/admin")
      && !boundaryPaths.has(pattern))
    .sort((left, right) => left.localeCompare(right));

  assert.equal(routePatterns.length, EXPECTED_COUNTS.routePatterns, "NONEXCLUDED_FRONTEND_ROUTE_PATTERN_COUNT_DRIFT");
  for (const required of [
    "/login", "/register", "/forgot-password", "/creation-center", "/profile", "/referral", "/recharge",
    "/payment/result", "/announcements", "/help", "/help/[slug]", "/media-history", "/design-preview",
    "/voice-studio", "/voice-studio/workspace", "/voice-studio/voices", "/voice-studio/clone",
    "/voice-studio/imitate", "/voice-studio/design", "/voice-studio/nest", "/tools/[category]/[tool]",
  ]) {
    assert.ok(routePatterns.includes(required), `REQUIRED_FRONTEND_PATTERN_MISSING:${required}`);
  }

  const helpSourceFiles = [
    path.join(ROOT, "src/lib/help-center-domain.ts"),
    path.join(ROOT, "src/lib/help-center-public-articles.ts"),
  ];
  const helpSlugs = unique(helpSourceFiles.flatMap((file) => extractQuotedValues(
    fs.readFileSync(file, "utf8"),
    /slug:\s*"([A-Za-z0-9-]+)"/gu,
  )));
  assert.equal(helpSlugs.length, EXPECTED_COUNTS.helpSlugs, "HELP_SLUG_COUNT_DRIFT");
  assert.ok(helpSlugs.includes("GPT-Image-2"), "CASE_SENSITIVE_HELP_SLUG_MISSING");
  const localHelpContracts = readDomainHelpArticleContracts(helpSourceFiles[0]);
  const expectedUnpublishedHelpSlugs = localHelpContracts
    .filter((article) => article.status === "draft" && article.publishedAtNull)
    .map((article) => article.slug);
  const expectedUnpublishedHelpSlugSet = new Set(expectedUnpublishedHelpSlugs);
  assert.equal(
    expectedUnpublishedHelpSlugs.length,
    EXPECTED_COUNTS.expectedUnpublishedHelpSlugs,
    "EXPECTED_UNPUBLISHED_HELP_SLUG_COUNT_DRIFT",
  );
  assert.ok(
    expectedUnpublishedHelpSlugs.every((slug) => helpSlugs.includes(slug)),
    "EXPECTED_UNPUBLISHED_HELP_SLUG_MISSING_FROM_MANIFEST",
  );

  const configuredRedirects = readConfiguredRedirects();
  for (const [sourcePath, expectedTarget] of CONFIG_REDIRECT_FINAL_PATHS) {
    assert.equal(configuredRedirects.get(sourcePath), expectedTarget, `CONFIG_REDIRECT_DRIFT:${sourcePath}`);
  }

  const aliasMapFile = path.join(ROOT, "src/features/official-tool-aliases/official-tool-alias-map.ts");
  const toolAliases = unique(extractQuotedValues(
    fs.readFileSync(aliasMapFile, "utf8"),
    /officialPath:\s*"(\/tools\/(?:text|image|audio|video)\/[^"]+)"/gu,
  ));
  assert.equal(toolAliases.length, EXPECTED_COUNTS.toolAliases, "OFFICIAL_TOOL_ALIAS_COUNT_DRIFT");
  assert.ok(toolAliases.every((alias) => !isExcludedRoute(alias)), "EXCLUDED_ROUTE_LEAKED_INTO_TOOL_ALIASES");

  const routes = [];
  for (const pattern of routePatterns) {
    const patternFile = patternToFile.get(pattern);
    assert.ok(patternFile, `PAGE_SOURCE_MISSING:${pattern}`);
    let requestedPaths;
    if (pattern === "/help/[slug]") requestedPaths = helpSlugs.map((slug) => `/help/${slug}`);
    else if (pattern === "/tools/[category]/[tool]") requestedPaths = toolAliases;
    else requestedPaths = [instantiateDynamicPattern(pattern)];

    for (const requestedPath of requestedPaths) {
      const concreteStaticFile = pattern === "/tools/[category]/[tool]"
        ? path.join(APP_ROOT, ...requestedPath.slice(1).split("/"), "page.tsx")
        : "";
      const sourceFile = concreteStaticFile && fs.existsSync(concreteStaticFile) ? concreteStaticFile : patternFile;
      const redirectTarget = readRedirectTarget(sourceFile);
      const deniedPattern = DENIED_FOR_ORDINARY_MEMBER.get(pattern);
      const helpSlug = pattern === "/help/[slug]" ? requestedPath.slice("/help/".length) : "";
      const expectedUnpublished = expectedUnpublishedHelpSlugSet.has(helpSlug);
      const expectedOutcome = expectedUnpublished
        ? "expected_unpublished"
        : deniedPattern
          ? "deny"
          : redirectTarget || CONFIG_REDIRECT_FINAL_PATHS.has(requestedPath)
            ? "redirect"
            : "pass";
      routes.push({
        pattern,
        requestedPath,
        expectedFinal: expectedFinalPath(requestedPath, redirectTarget),
        expectedOutcome,
        identity: ANONYMOUS_PATTERNS.has(pattern) ? "anonymous" : "ordinary-member",
        sourceFile: sourceRelative(sourceFile),
        dynamicKind: pattern === "/help/[slug]" ? "help-slug" : pattern === "/tools/[category]/[tool]" ? "tool-alias" : "static",
        expectedUnpublished,
        staticAliasOverride: Boolean(concreteStaticFile && fs.existsSync(concreteStaticFile)),
        featureBoundaryOnly: false,
      });
    }
  }

  assert.equal(routes.length, EXPECTED_COUNTS.browserUrls, "CONCRETE_FRONTEND_URL_COUNT_DRIFT");
  assert.equal(routes.filter((item) => item.dynamicKind === "tool-alias").length, EXPECTED_COUNTS.toolAliases, "TOOL_ALIAS_EXPANSION_DRIFT");
  assert.equal(routes.filter((item) => item.dynamicKind === "help-slug").length, EXPECTED_COUNTS.helpSlugs, "HELP_SLUG_EXPANSION_DRIFT");
  assert.equal(routes.filter((item) => item.expectedUnpublished).length, EXPECTED_COUNTS.expectedUnpublishedHelpSlugs, "EXPECTED_UNPUBLISHED_HELP_EXPANSION_DRIFT");
  assert.equal(EXCLUDED_REDIRECT_BOUNDARIES.length, EXPECTED_COUNTS.excludedRedirectBoundaries, "EXCLUDED_REDIRECT_BOUNDARY_COUNT_DRIFT");

  for (const boundary of EXCLUDED_REDIRECT_BOUNDARIES) {
    const sourceFile = patternToFile.get(boundary.path);
    assert.ok(sourceFile, `BOUNDARY_SOURCE_MISSING:${boundary.path}`);
    assert.equal(readRedirectTarget(sourceFile), boundary.target, `BOUNDARY_REDIRECT_DRIFT:${boundary.path}`);
    assert.equal(isExcludedRoute(boundary.target), true, `BOUNDARY_TARGET_MUST_BE_EXCLUDED:${boundary.target}`);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      routePatterns: routePatterns.length,
      browserUrls: routes.length,
      excludedRedirectBoundaries: EXCLUDED_REDIRECT_BOUNDARIES.length,
      toolAliases: toolAliases.length,
      helpSlugs: helpSlugs.length,
      expectedUnpublishedHelpSlugs: expectedUnpublishedHelpSlugs.length,
    },
    routePatterns: routePatterns.map((pattern) => ({
      pattern,
      sourceFile: sourceRelative(patternToFile.get(pattern)),
      redirectTarget: readRedirectTarget(patternToFile.get(pattern)) || null,
    })),
    helpSlugs,
    expectedUnpublishedHelpSlugs,
    toolAliases,
    routes,
    excludedRedirectBoundaries: EXCLUDED_REDIRECT_BOUNDARIES.map((item) => ({ ...item, mode: "redirect-manual-only" })),
  };
}

function safePathAndSearch(value) {
  try {
    const url = new URL(value, origin);
    return `${url.pathname}${url.search}`;
  } catch {
    return "/invalid-url";
  }
}

function safeRequestUrl(value) {
  try {
    const url = new URL(value);
    if (["data:", "blob:", "about:"].includes(url.protocol)) {
      return { origin: url.protocol.replace(/:$/u, ""), pathname: `<${url.protocol.replace(/:$/u, "")}>`, queryKeys: [] };
    }
    return {
      origin: url.origin === origin ? "same-origin" : url.origin,
      pathname: url.pathname,
      queryKeys: [...url.searchParams.keys()].sort(),
    };
  } catch {
    return { origin: "invalid", pathname: "/invalid-url", queryKeys: [] };
  }
}

function sanitizeText(value, limit = 500) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, "<jwt-redacted>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "<email-redacted>")
    .replace(/(?<!\d)1\d{10}(?!\d)/gu, "<phone-redacted>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, "<uuid-redacted>")
    .replace(/(?<!\d)\d{9,}(?!\d)/gu, "<id-redacted>")
    .replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?/giu, "<url-redacted>")
    .slice(0, limit);
}

function inspectTelemetryBody(body, pathname = "") {
  const byteLength = Buffer.byteLength(body || "", "utf8");
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
  const sensitiveKeyPattern = /(?:password|passcode|secret|token|authorization|cookie|credential|api[_-]?key|session[_-]?id|user[_-]?id|member[_-]?id|prompt|message|content|email|phone|username)/iu;
  const findings = new Set();
  const keyPaths = [];

  function isPseudonymousProductUsageSessionId(key, value, keyPath) {
    return pathname === "/api/product-usage/events"
      && key === "session_id"
      && /^\$\.events\[\d+\]\.session_id$/u.test(keyPath)
      && typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
  }

  function walk(value, currentPath = "$") {
    if (Array.isArray(value)) {
      value.slice(0, 50).forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const nextPath = `${currentPath}.${key}`;
      keyPaths.push(nextPath);
      if (sensitiveKeyPattern.test(key) && !isPseudonymousProductUsageSessionId(key, child, nextPath)) {
        findings.add(`sensitive-key:${key}`);
      }
      walk(child, nextPath);
    }
  }
  walk(parsed);

  const raw = String(body || "");
  if (/Bearer\s+[A-Za-z0-9._~+/=-]+/iu.test(raw)) findings.add("bearer-value");
  if (/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u.test(raw)) findings.add("jwt-like-value");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(raw)) findings.add("email-value");
  if (/(?<!\d)1\d{10}(?!\d)/u.test(raw)) findings.add("phone-value");

  return {
    byteLength,
    json: parsed !== null,
    keyCount: keyPaths.length,
    findings: [...findings].sort(),
  };
}

function matchesAny(pathname, patterns) {
  return patterns.some((pattern) => pattern.test(pathname));
}

function isModelOrPaidRequest(method, pathname) {
  if (method === "GET" && EXPLICIT_READONLY_GET_PATHS.has(pathname)) return false;
  return matchesAny(pathname, MODEL_OR_PAID_WRITE_PATTERNS);
}

function emptyUserNotificationsFixture() {
  return {
    success: true,
    notifications: [],
    total: 0,
    unreadCount: 0,
  };
}

function verifyValidatorContracts() {
  const usageSessionId = "0f44db8a-c9ea-4cca-8b4d-c00bd5425c47";
  const allowedUsage = inspectTelemetryBody(
    JSON.stringify({ events: [{ session_id: usageSessionId }] }),
    "/api/product-usage/events",
  );
  const rootSession = inspectTelemetryBody(JSON.stringify({ session_id: usageSessionId }));
  const nonUuidUsageSession = inspectTelemetryBody(JSON.stringify({ events: [{ session_id: "login-session" }] }));
  const otherTelemetrySession = inspectTelemetryBody(
    JSON.stringify({ events: [{ session_id: usageSessionId }] }),
    "/api/operation-events",
  );
  const credentialFields = inspectTelemetryBody(JSON.stringify({ token: "redacted-test-value", cookie: "redacted-test-value" }));

  assert.deepEqual(allowedUsage.findings, [], "PRODUCT_USAGE_UUID_MUST_NOT_BE_TREATED_AS_AUTH_SESSION");
  assert.ok(rootSession.findings.includes("sensitive-key:session_id"), "ROOT_SESSION_ID_MUST_REMAIN_FORBIDDEN");
  assert.ok(nonUuidUsageSession.findings.includes("sensitive-key:session_id"), "NON_UUID_USAGE_SESSION_MUST_REMAIN_FORBIDDEN");
  assert.ok(otherTelemetrySession.findings.includes("sensitive-key:session_id"), "OTHER_TELEMETRY_SESSION_ID_MUST_REMAIN_FORBIDDEN");
  assert.ok(credentialFields.findings.includes("sensitive-key:token"), "TOKEN_KEY_MUST_REMAIN_FORBIDDEN");
  assert.ok(credentialFields.findings.includes("sensitive-key:cookie"), "COOKIE_KEY_MUST_REMAIN_FORBIDDEN");
  assert.equal(isModelOrPaidRequest("GET", "/api/extract/history"), false, "EXTRACT_HISTORY_GET_MUST_BE_READONLY");
  assert.equal(isModelOrPaidRequest("POST", "/api/extract/history"), true, "EXTRACT_HISTORY_POST_MUST_REMAIN_BLOCKED");
  assert.equal(isModelOrPaidRequest("GET", "/api/extract"), true, "OTHER_EXTRACT_GETS_MUST_REMAIN_BLOCKED");
  assert.equal(expectedFinalPath("/tools", ""), "/tools?tab=text", "TOOLS_CANONICAL_FINAL_DRIFT");
  assert.equal(expectedFinalPath("/tools/utility", ""), "/tools/utility?tab=text", "TOOLS_UTILITY_CANONICAL_FINAL_DRIFT");
  assert.equal(expectedFinalPath("/extract", ""), "/tools?tab=text", "EXTRACT_CONFIG_REDIRECT_FINAL_DRIFT");
  assert.equal(expectedFinalPath("/formatter", ""), "/tools?tab=format", "FORMATTER_CONFIG_REDIRECT_FINAL_DRIFT");
  assert.equal(expectedFinalPath("/segmenter", ""), "/tools?tab=segment", "SEGMENTER_CONFIG_REDIRECT_FINAL_DRIFT");
  assert.deepEqual(emptyUserNotificationsFixture(), {
    success: true,
    notifications: [],
    total: 0,
    unreadCount: 0,
  }, "EMPTY_USER_NOTIFICATIONS_FIXTURE_DRIFT");

  return {
    extractHistoryGetIsReadonly: true,
    extractHistoryWritesRemainBlocked: true,
    productUsageUuidIsPseudonymous: true,
    authSessionCookieTokenRemainForbidden: true,
    canonicalFinalPaths: Object.fromEntries(CANONICAL_FINAL_PATHS),
    configRedirectFinalPaths: Object.fromEntries(CONFIG_REDIRECT_FINAL_PATHS),
    emptyUserNotificationsFixture: USER_NOTIFICATIONS_PATH,
    toolboxPersistedTabReset: TOOLBOX_PERSISTED_TAB_KEY,
    syntheticEscapeNavigation: false,
  };
}

function excludedFeatureRequest(url, resourceType) {
  const pathname = url.pathname;
  if (/^\/api\/(?:commerce|youcai|short-drama)(?:\/|$)/u.test(pathname)) return true;
  if (!isExcludedRoute(pathname)) return false;
  return resourceType === "document" || url.searchParams.has("_rsc");
}

function protectedReadPayload(pathname) {
  if (pathname === "/api/video/active-tasks") return { activeTasks: [] };
  if (pathname === "/api/payment/status") return { success: false, order: null, readonlyBlocked: true };
  if (pathname === "/api/health") return { status: "unknown", readonlyBlocked: true };
  return { success: false, status: "readonly-blocked", readonlyBlocked: true };
}

function screenshotSlug(requestedPath, index) {
  const slug = requestedPath === "/" ? "home" : requestedPath
    .replace(/^\//u, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  return `${String(index + 1).padStart(3, "0")}-${slug || "page"}-1440x900.png`;
}

async function sha256File(file) {
  const content = await fsp.readFile(file);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function verifyRuntimeIdentity() {
  const [{ computeLocalBuildFingerprint }, fingerprintReceiptText, diskBuildIdText, versionResponse] = await Promise.all([
    import("./local-build-fingerprint.mjs"),
    fsp.readFile(path.join(ROOT, ".next/local-source-fingerprint.v1.json"), "utf8"),
    fsp.readFile(path.join(ROOT, ".next/BUILD_ID"), "utf8"),
    fetch(`${origin}/api/version`, { cache: "no-store", signal: AbortSignal.timeout(30_000) }),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const receipt = JSON.parse(fingerprintReceiptText.replace(/^\uFEFF/u, ""));
  const diskBuildId = diskBuildIdText.trim();
  const served = await versionResponse.json();
  const current = computeLocalBuildFingerprint(ROOT);
  const servedBuildId = String(served?.buildId || served?.version || "");
  const sourceFingerprintCurrent = receipt?.fingerprint === current.fingerprint
    && Number(receipt?.fileCount) === Number(current.fileCount);
  const runningLatest = sourceFingerprintCurrent
    && receipt?.buildId === diskBuildId
    && servedBuildId === diskBuildId;
  assert.equal(runningLatest, true, "RUNNING_LATEST_REQUIRED_BEFORE_FRONTEND_SWEEP");
  return {
    runningLatest,
    diskBuildId,
    servedBuildId,
    sourceVersion: String(served?.sourceVersion || ""),
    sourceFingerprintCurrent,
    fingerprint: current.fingerprint,
    fileCount: current.fileCount,
  };
}

async function loadOrdinaryMemberIdentity() {
  const token = String(
    process.env.FRONTEND_READONLY_MEMBER_TOKEN
      || process.env.R267_CUSTOMER_TOKEN
      || process.env.LOCAL_NAV_USER_TOKEN
      || process.env.LOCAL_NAV_SECOND_TOKEN
      || "",
  ).trim();
  assert.ok(token, "ORDINARY_MEMBER_TOKEN_REQUIRED_USE_FRONTEND_READONLY_MEMBER_TOKEN_OR_R267_CUSTOMER_TOKEN");
  const response = await fetch(`${origin}/api/auth/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, "ORDINARY_MEMBER_AUTH_ME_FAILED");
  assert.equal(payload?.user?.role, "student", `ORDINARY_MEMBER_ROLE_REQUIRED_RECEIVED_${String(payload?.user?.role || "missing")}`);
  return { token, user: payload.user };
}

async function verifyExcludedRedirectBoundaries() {
  const results = [];
  for (const boundary of EXCLUDED_REDIRECT_BOUNDARIES) {
    const response = await fetch(`${origin}${boundary.path}`, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const location = response.headers.get("location") || "";
    const target = location ? safePathAndSearch(new URL(location, origin).href) : "";
    const ok = [307, 308].includes(response.status) && target === boundary.target && isExcludedRoute(target);
    results.push({
      requestedPath: boundary.path,
      expectedOutcome: "redirect",
      outcome: ok ? "redirect" : "failed",
      status: response.status,
      expectedTarget: boundary.target,
      target,
      redirectFollowed: false,
      excludedTargetLoaded: false,
      ok,
    });
  }
  return results;
}

function createPageAudit(entry) {
  return {
    requestedPath: entry.requestedPath,
    blockedBusinessWrites: [],
    blockedModelOrPaidRequests: [],
    blockedProtectedReads: [],
    blockedExcludedTargets: [],
    blockedExternalRequests: [],
    fulfilledReadFixtures: [],
    telemetry: [],
    responses4xx: [],
    responses5xx: [],
    pageErrors: [],
    consoleErrors: [],
    intentionalBlockedConsoleErrors: [],
    requestFailures: [],
    benignAborts: [],
  };
}

async function createAuditedContext(browser, identity, auditByPage) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });

  if (identity.kind === "ordinary-member") {
    await context.addCookies([{
      name: "auth_token",
      value: identity.token,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { token: identity.token, user: identity.user });
  } else {
    await context.addInitScript(() => {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      sessionStorage.removeItem("entered_app");
    });
  }

  const auditFor = (request) => {
    try { return auditByPage.get(request.frame().page()); } catch { return null; }
  };

  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const resourceType = request.resourceType();
    const audit = auditFor(request);
    let url;
    try { url = new URL(request.url()); } catch {
      audit?.blockedExternalRequests.push({ method, pathname: "/invalid-url", resourceType, interceptedBeforeNetwork: true });
      await route.abort("blockedbyclient");
      return;
    }

    if (["data:", "blob:", "about:"].includes(url.protocol)) {
      await route.continue();
      return;
    }

    if (url.origin !== origin) {
      const safe = safeRequestUrl(url.href);
      audit?.blockedExternalRequests.push({ method, ...safe, resourceType, interceptedBeforeNetwork: true });
      await route.abort("blockedbyclient");
      return;
    }

    if (url.pathname === "/_next/image") {
      const source = url.searchParams.get("url") || "";
      if (/^https?:\/\//iu.test(source) && !source.startsWith(origin)) {
        audit?.blockedExternalRequests.push({ method, origin: "server-side-image-source", pathname: "/_next/image", resourceType, interceptedBeforeNetwork: true });
        await route.abort("blockedbyclient");
        return;
      }
    }

    if (excludedFeatureRequest(url, resourceType)) {
      audit?.blockedExcludedTargets.push({ method, pathname: url.pathname, resourceType, interceptedBeforeServer: true });
      await route.abort("blockedbyclient");
      return;
    }

    if (matchesAny(url.pathname, SERVER_SIDE_EXTERNAL_BRIDGE_PATTERNS)) {
      audit?.blockedExternalRequests.push({ method, origin: "same-origin-bridge", pathname: url.pathname, resourceType, interceptedBeforeServer: true });
      await route.abort("blockedbyclient");
      return;
    }

    if (method === "GET" && url.pathname === USER_NOTIFICATIONS_PATH) {
      audit?.fulfilledReadFixtures.push({
        method,
        pathname: url.pathname,
        resourceType,
        fixture: "empty-user-notifications",
        interceptedBeforeServer: true,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(emptyUserNotificationsFixture()),
      });
      return;
    }

    if (method === "POST" && TELEMETRY_PATHS.has(url.pathname)) {
      const inspection = inspectTelemetryBody(request.postData() || "", url.pathname);
      audit?.telemetry.push({
        method,
        pathname: url.pathname,
        ...inspection,
        interceptedBeforeServer: true,
      });
      await route.fulfill({
        status: 202,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ok: true, accepted: true, readonlyAudit: true }),
      });
      return;
    }

    if (isModelOrPaidRequest(method, url.pathname)) {
      audit?.blockedModelOrPaidRequests.push({ method, pathname: url.pathname, resourceType, interceptedBeforeServer: true });
      await route.abort("blockedbyclient");
      return;
    }

    if (method === "GET" && matchesAny(url.pathname, STATE_ADVANCING_OR_UPSTREAM_GET_PATTERNS)) {
      audit?.blockedProtectedReads.push({ method, pathname: url.pathname, resourceType, interceptedBeforeServer: true });
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(protectedReadPayload(url.pathname)),
      });
      return;
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      audit?.blockedBusinessWrites.push({ method, pathname: url.pathname, resourceType, interceptedBeforeServer: true });
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });

  return context;
}

function installPageObservers(page, audit) {
  page.on("pageerror", (error) => {
    audit.pageErrors.push({ name: error.name || "Error", message: sanitizeText(error.message) });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = sanitizeText(message.text());
    if (/ERR_BLOCKED_BY_CLIENT/iu.test(text)) audit.intentionalBlockedConsoleErrors.push(text);
    else audit.consoleErrors.push(text);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    const request = response.request();
    const item = {
      status,
      method: request.method(),
      ...safeRequestUrl(response.url()),
      resourceType: request.resourceType(),
    };
    if (status >= 500) audit.responses5xx.push(item);
    else audit.responses4xx.push(item);
  });
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText || "";
    const item = {
      method: request.method(),
      ...safeRequestUrl(request.url()),
      resourceType: request.resourceType(),
      error: sanitizeText(error, 160),
    };
    if (request.method() === "GET" && error === "net::ERR_ABORTED") audit.benignAborts.push(item);
    else if (/ERR_BLOCKED_BY_CLIENT/u.test(error)) audit.requestFailures.push({ ...item, intentional: true });
    else audit.requestFailures.push({ ...item, intentional: false });
  });
  page.on("dialog", (dialog) => dialog.dismiss());
}

async function waitForRouteLandmark(page, entry) {
  await page.waitForFunction(() => (document.body?.innerText?.trim().length || 0) >= 20, undefined, { timeout: 30_000 });
  if (entry.dynamicKind === "tool-alias" && !entry.staticAliasOverride) {
    await page.locator(`[data-official-tool-alias="${entry.requestedPath}"]`).waitFor({ state: "visible", timeout: 30_000 });
  } else if (entry.dynamicKind === "help-slug") {
    if (entry.expectedUnpublished) {
      await page.getByText("这篇文档尚未发布或不存在", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    } else {
      await page.locator("#help-main h1").first().waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(() => !document.body.innerText.includes("这篇文档尚未发布或不存在"), undefined, { timeout: 30_000 });
    }
  } else if (["/login", "/register", "/forgot-password"].includes(entry.pattern)) {
    await page.locator("form").first().waitFor({ state: "visible", timeout: 30_000 });
  } else if (entry.pattern === "/payment/result") {
    await page.getByText("缺少订单号", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  } else if (entry.pattern === "/announcements") {
    await page.locator('[data-testid="announcement-reading-center"]').waitFor({ state: "visible", timeout: 30_000 });
  } else if (entry.pattern === "/help") {
    await page.locator("#help-main").waitFor({ state: "visible", timeout: 30_000 });
  } else if (entry.pattern === "/media-history") {
    await page.getByRole("heading", { name: "作品历史", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  } else if (DENIED_FOR_ORDINARY_MEMBER.has(entry.pattern)) {
    await page.getByText(DENIED_FOR_ORDINARY_MEMBER.get(entry.pattern)).first().waitFor({ state: "visible", timeout: 30_000 });
  } else {
    await page.locator("h1, h2, main, [role=main]").first().waitFor({ state: "visible", timeout: 30_000 });
  }
  await page.waitForTimeout(450);
}

async function inspectRenderedPage(page, entry) {
  const raw = await page.evaluate(({ minimumFontPx, aliasPath }) => {
    const bodyText = document.body?.innerText || "";
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.closest('[aria-hidden="true"]')) return false;
      if (element.classList.contains("sr-only")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0.01) return false;
      if (rect.width <= 1 || rect.height <= 1) return false;
      if (style.clipPath !== "none" || (style.clip && style.clip !== "auto")) return false;
      return true;
    };
    const selectorFor = (element) => {
      if (element.id) return `${element.tagName.toLowerCase()}#${element.id}`;
      const classes = [...element.classList].filter(Boolean).slice(0, 3).join(".");
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
    };
    const textElements = [...document.body.querySelectorAll("*")].filter((element) => {
      if (!visible(element)) return false;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH"].includes(element.tagName)) return false;
      return [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()));
    });
    const fontRows = textElements.map((element) => ({
      selector: selectorFor(element),
      fontSizePx: Number.parseFloat(getComputedStyle(element).fontSize || "0"),
      text: (element.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 100),
    })).filter((row) => Number.isFinite(row.fontSizePx) && row.fontSizePx > 0);
    const fontViolations = fontRows.filter((row) => row.fontSizePx + 0.01 < minimumFontPx).slice(0, 30);
    const visibleBrokenImages = [...document.images].filter((image) => {
      if (!visible(image)) return false;
      return image.complete && image.naturalWidth === 0;
    }).slice(0, 20).map((image) => image.currentSrc || image.src || "");
    const escapedElements = [...document.querySelectorAll("main, header, nav, section, article")].filter((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -2 || rect.right > window.innerWidth + 2;
    }).slice(0, 20).map((element) => ({
      selector: selectorFor(element),
      left: Math.round(element.getBoundingClientRect().left),
      right: Math.round(element.getBoundingClientRect().right),
      width: Math.round(element.getBoundingClientRect().width),
    }));
    const headings = [...document.querySelectorAll("h1, h2")].filter(visible).slice(0, 12).map((heading) => ({
      tag: heading.tagName.toLowerCase(),
      text: (heading.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 160),
    }));
    const aliasRoot = aliasPath ? document.querySelector(`[data-official-tool-alias="${CSS.escape(aliasPath)}"]`) : null;
    return {
      title: document.title,
      bodyTextLength: bodyText.trim().length,
      headings,
      landmarks: {
        main: document.querySelectorAll("main, [role=main]").length,
        navigation: document.querySelectorAll("nav, [role=navigation]").length,
        forms: document.querySelectorAll("form").length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        alerts: document.querySelectorAll('[role="alert"]').length,
        status: document.querySelectorAll('[role="status"], [aria-live]').length,
        buttons: document.querySelectorAll("button").length,
        links: document.querySelectorAll("a[href]").length,
      },
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      bodyHorizontalOverflowPx: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
      escapedElements,
      minimumVisibleFontPx: fontRows.length ? Math.min(...fontRows.map((row) => row.fontSizePx)) : null,
      visibleTextElementCount: fontRows.length,
      fontViolations,
      visibleBrokenImages,
      applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|Unhandled Runtime Error|应用程序错误|404\s*This page|This page could not be found/iu.test(bodyText),
      helpNotFoundVisible: bodyText.includes("这篇文档尚未发布或不存在"),
      ordinaryMemberDeniedVisible: /仅管理员可访问/u.test(bodyText),
      loginWallVisible: /请登录后使用|请先登录|登录后/u.test(bodyText),
      loadingVisible: /正在加载|加载中\.\.\.|正在验证/u.test(bodyText),
      alias: aliasRoot ? {
        path: aliasRoot.getAttribute("data-official-tool-alias"),
        status: aliasRoot.getAttribute("data-alias-status"),
        workspaceCount: document.querySelectorAll('[data-testid="youcai-independent-tool-workspace"]').length,
      } : null,
    };
  }, { minimumFontPx: MIN_READABLE_FONT_PX, aliasPath: entry.dynamicKind === "tool-alias" && !entry.staticAliasOverride ? entry.requestedPath : "" });

  return {
    ...raw,
    title: sanitizeText(raw.title, 200),
    headings: raw.headings.map((item) => ({ ...item, text: sanitizeText(item.text, 160) })),
    fontViolations: raw.fontViolations.map((item) => ({ ...item, text: sanitizeText(item.text, 100) })),
    visibleBrokenImages: raw.visibleBrokenImages.map((item) => safeRequestUrl(item)),
  };
}

function redirectChain(response) {
  const chain = [];
  let request = response?.request?.() || null;
  while (request) {
    chain.unshift(safePathAndSearch(request.url()));
    request = request.redirectedFrom();
  }
  return chain;
}

function pageProblems(entry, result, audit) {
  const problems = [];
  if (!result.navigationResponseStatus || result.navigationResponseStatus >= 400) problems.push(`navigation-http-${result.navigationResponseStatus || "missing"}`);
  if (result.actualFinal !== entry.expectedFinal) problems.push(`final-url:${result.actualFinal}`);
  if (!result.dom || result.dom.bodyTextLength < 20) problems.push("main-dom-missing");
  if (result.dom?.applicationErrorVisible) problems.push("application-error-visible");
  if (result.dom?.horizontalOverflowPx > 2 || result.dom?.bodyHorizontalOverflowPx > 2) problems.push("horizontal-overflow");
  if (result.dom?.escapedElements?.length) problems.push("landmark-outside-viewport");
  if (result.dom?.fontViolations?.length) problems.push("sub-11px-visible-text");
  if (result.dom?.visibleBrokenImages?.length) problems.push("visible-broken-image");
  if (entry.dynamicKind === "help-slug") {
    if (entry.expectedUnpublished && !result.dom?.helpNotFoundVisible) problems.push("expected-unpublished-marker-missing");
    if (!entry.expectedUnpublished && result.dom?.helpNotFoundVisible) problems.push("help-slug-not-published");
  }
  if (entry.dynamicKind === "tool-alias" && !entry.staticAliasOverride && result.dom?.alias?.path !== entry.requestedPath) problems.push("tool-alias-dom-mismatch");
  if (entry.expectedOutcome === "deny" && !result.dom?.ordinaryMemberDeniedVisible) problems.push("expected-member-denial-missing");
  if (entry.expectedOutcome !== "deny" && result.actualFinal === entry.requestedPath && result.dom?.ordinaryMemberDeniedVisible) problems.push("unexpected-member-denial");
  if (audit.pageErrors.length) problems.push("page-errors");
  if (audit.consoleErrors.length) problems.push("console-errors");
  if (audit.responses5xx.length) problems.push("http-5xx");
  if (audit.requestFailures.some((item) => !item.intentional)) problems.push("unexpected-request-failure");
  if (audit.blockedBusinessWrites.length) problems.push("business-write-attempt");
  if (audit.blockedModelOrPaidRequests.length) problems.push("model-or-paid-request-attempt");
  if (audit.blockedExcludedTargets.length) problems.push("excluded-target-load-attempt");
  if (audit.telemetry.some((item) => item.findings.length)) problems.push("telemetry-sensitive-content");
  return unique(problems);
}

async function visitRoute({ context, entry, index, auditByPage, screenshotIndex }) {
  const page = await context.newPage();
  if (entry.requestedPath === "/tools") {
    await page.addInitScript((storageKey) => {
      try { localStorage.removeItem(storageKey); } catch {}
    }, TOOLBOX_PERSISTED_TAB_KEY);
  }
  const audit = createPageAudit(entry);
  auditByPage.set(page, audit);
  installPageObservers(page, audit);
  const startedAt = Date.now();
  const result = {
    pattern: entry.pattern,
    requestedPath: entry.requestedPath,
    expectedFinal: entry.expectedFinal,
    expectedOutcome: entry.expectedOutcome,
    expectedUnpublished: entry.expectedUnpublished,
    identity: entry.identity,
    dynamicKind: entry.dynamicKind,
    staticAliasOverride: entry.staticAliasOverride,
    featureBoundaryOnly: entry.featureBoundaryOnly,
    sourceFile: entry.sourceFile,
    storageResetBeforeNavigation: entry.requestedPath === "/tools" ? [TOOLBOX_PERSISTED_TAB_KEY] : [],
    viewport: VIEWPORT,
    actualFinal: "",
    redirectChain: [],
    navigationResponseStatus: null,
    dom: null,
    audit,
    problems: [],
    ok: false,
    durationMs: 0,
  };

  try {
    const response = await page.goto(`${origin}${entry.requestedPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    result.navigationResponseStatus = response?.status() || null;
    result.redirectChain = redirectChain(response);
    await waitForRouteLandmark(page, entry);
    result.actualFinal = safePathAndSearch(page.url());
    result.dom = await inspectRenderedPage(page, entry);
  } catch (error) {
    result.failure = {
      name: error?.name || "Error",
      message: sanitizeText(error?.message || error),
    };
    result.actualFinal = safePathAndSearch(page.url());
    result.dom = await inspectRenderedPage(page, entry).catch(() => null);
  }

  if (REPRESENTATIVE_PATHS.has(entry.requestedPath)) {
    const filename = screenshotSlug(entry.requestedPath, index);
    const absolute = path.join(screenshotsDir, filename);
    await page.screenshot({ path: absolute, fullPage: false }).catch(() => undefined);
    if (fs.existsSync(absolute)) {
      screenshotIndex.push({
        requestedPath: entry.requestedPath,
        actualFinal: result.actualFinal,
        expectedOutcome: entry.expectedOutcome,
        file: path.relative(outputDir, absolute).replace(/\\/gu, "/"),
        viewport: VIEWPORT,
        sha256: await sha256File(absolute),
      });
    }
  }

  result.problems = unique([
    ...(result.failure ? ["route-check-incomplete"] : []),
    ...pageProblems(entry, result, audit),
  ]);
  result.ok = result.problems.length === 0;
  result.outcome = result.ok ? entry.expectedOutcome : "failed";
  result.durationMs = Date.now() - startedAt;
  await page.close().catch(() => undefined);
  return result;
}

async function runBrowserSweep(manifest, memberIdentity) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const screenshotIndex = [];
  const results = [];
  const auditByPage = new WeakMap();
  let anonymousContext;
  let memberContext;
  try {
    anonymousContext = await createAuditedContext(browser, { kind: "anonymous" }, auditByPage);
    memberContext = await createAuditedContext(browser, { kind: "ordinary-member", ...memberIdentity }, auditByPage);
    for (let index = 0; index < manifest.routes.length; index += 1) {
      const entry = manifest.routes[index];
      const context = entry.identity === "anonymous" ? anonymousContext : memberContext;
      results.push(await visitRoute({ context, entry, index, auditByPage, screenshotIndex }));
    }
  } finally {
    await anonymousContext?.close().catch(() => undefined);
    await memberContext?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  return { results, screenshotIndex };
}

function summarize(results, boundaries, screenshots) {
  const browserOutcomeCounts = results.reduce((counts, item) => {
    counts[item.outcome] = (counts[item.outcome] || 0) + 1;
    return counts;
  }, {});
  const allAudits = results.map((item) => item.audit);
  const expectedUnpublishedHelp = results.filter((item) => item.expectedOutcome === "expected_unpublished");
  return {
    routePatterns: EXPECTED_COUNTS.routePatterns,
    browserUrls: results.length,
    excludedRedirectBoundaries: boundaries.length,
    toolAliases: results.filter((item) => item.dynamicKind === "tool-alias").length,
    helpSlugs: results.filter((item) => item.dynamicKind === "help-slug").length,
    expectedUnpublishedHelp: {
      count: expectedUnpublishedHelp.length,
      urls: expectedUnpublishedHelp.map((item) => item.requestedPath),
      verifiedUrls: expectedUnpublishedHelp.filter((item) => item.ok).map((item) => item.requestedPath),
      failedUrls: expectedUnpublishedHelp.filter((item) => !item.ok).map((item) => item.requestedPath),
    },
    browserOutcomeCounts,
    boundaryOutcomeCounts: boundaries.reduce((counts, item) => {
      counts[item.outcome] = (counts[item.outcome] || 0) + 1;
      return counts;
    }, {}),
    representativeScreenshots: screenshots.length,
    failedBrowserUrls: results.filter((item) => !item.ok).map((item) => item.requestedPath),
    failedBoundaries: boundaries.filter((item) => !item.ok).map((item) => item.requestedPath),
    pageErrors: allAudits.reduce((sum, audit) => sum + audit.pageErrors.length, 0),
    consoleErrors: allAudits.reduce((sum, audit) => sum + audit.consoleErrors.length, 0),
    http5xx: allAudits.reduce((sum, audit) => sum + audit.responses5xx.length, 0),
    unexpectedRequestFailures: allAudits.reduce((sum, audit) => sum + audit.requestFailures.filter((item) => !item.intentional).length, 0),
    businessWriteAttempts: allAudits.reduce((sum, audit) => sum + audit.blockedBusinessWrites.length, 0),
    modelOrPaidRequestAttempts: allAudits.reduce((sum, audit) => sum + audit.blockedModelOrPaidRequests.length, 0),
    excludedTargetLoadAttempts: allAudits.reduce((sum, audit) => sum + audit.blockedExcludedTargets.length, 0),
    externalRequestsBlocked: allAudits.reduce((sum, audit) => sum + audit.blockedExternalRequests.length, 0),
    readFixturesFulfilled: allAudits.reduce((sum, audit) => sum + audit.fulfilledReadFixtures.length, 0),
    protectedReadsIntercepted: allAudits.reduce((sum, audit) => sum + audit.blockedProtectedReads.length, 0),
    telemetryAcceptedAndIntercepted: allAudits.reduce((sum, audit) => sum + audit.telemetry.length, 0),
    telemetrySensitiveFindings: allAudits.reduce((sum, audit) => sum + audit.telemetry.filter((item) => item.findings.length).length, 0),
  };
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function main() {
  const evidenceRoot = `${path.resolve(ROOT, ".codex-evidence")}${path.sep}`;
  assert.ok(`${outputDir}${path.sep}`.startsWith(evidenceRoot), "OUTPUT_DIR_MUST_STAY_INSIDE_DOT_CODEX_EVIDENCE");
  assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u, "LOCAL_LOOPBACK_ORIGIN_REQUIRED");
  const validatorContracts = verifyValidatorContracts();
  const manifest = compileSourceManifest();
  await fsp.mkdir(outputDir, { recursive: true });
  await writeJson(path.join(outputDir, "source-contracts.json"), {
    ok: true,
    mode: "source-only",
    validatorContracts,
    ...manifest,
  });

  if (sourceOnly) {
    console.log(JSON.stringify({
      ok: true,
      mode: "source-only",
      outputDir,
      counts: manifest.counts,
    }, null, 2));
    return;
  }

  const runtimeIdentity = await verifyRuntimeIdentity();
  const memberIdentity = await loadOrdinaryMemberIdentity();
  const boundaries = await verifyExcludedRedirectBoundaries();
  const { results, screenshotIndex } = await runBrowserSweep(manifest, memberIdentity);
  const summary = summarize(results, boundaries, screenshotIndex);
  const ok = summary.failedBrowserUrls.length === 0
    && summary.failedBoundaries.length === 0
    && summary.pageErrors === 0
    && summary.consoleErrors === 0
    && summary.http5xx === 0
    && summary.unexpectedRequestFailures === 0
    && summary.businessWriteAttempts === 0
    && summary.modelOrPaidRequestAttempts === 0
    && summary.excludedTargetLoadAttempts === 0
    && summary.telemetrySensitiveFindings === 0;

  const report = {
    schemaVersion: 1,
    ok,
    checkedAt: new Date().toISOString(),
    mode: "live-local-desktop-readonly",
    origin,
    viewport: VIEWPORT,
    runtimeIdentity,
    identity: {
      anonymousPages: results.filter((item) => item.identity === "anonymous").length,
      ordinaryMemberPages: results.filter((item) => item.identity === "ordinary-member").length,
      ordinaryMemberRole: "student",
      tokenPersistedInEvidence: false,
    },
    safety: {
      businessWritesReachedServer: 0,
      paidOrModelRequestsReachedServer: 0,
      excludedFeatureTargetsReachedBrowser: 0,
      externalRequestsReachedNetwork: 0,
      telemetryReachedServer: 0,
      telemetryPolicy: "recognized telemetry POSTs are inspected for sensitive keys/values and fulfilled locally with 202",
      serviceWorkersBlocked: true,
    },
    manifest: {
      counts: manifest.counts,
      routePatterns: manifest.routePatterns,
      helpSlugs: manifest.helpSlugs,
      expectedUnpublishedHelpSlugs: manifest.expectedUnpublishedHelpSlugs,
      toolAliases: manifest.toolAliases,
    },
    summary,
    excludedRedirectBoundaries: boundaries,
    routes: results,
    screenshots: screenshotIndex,
  };
  await writeJson(path.join(screenshotsDir, "index.json"), {
    schemaVersion: 1,
    checkedAt: report.checkedAt,
    viewport: VIEWPORT,
    count: screenshotIndex.length,
    screenshots: screenshotIndex,
  });
  await writeJson(path.join(outputDir, "report.json"), report);
  console.log(JSON.stringify({ ok, outputDir, summary }, null, 2));
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      mode: sourceOnly ? "source-only" : "live-local-desktop-readonly",
      error: { name: error?.name || "Error", message: sanitizeText(error?.message || error) },
    }, null, 2));
    process.exitCode = 1;
  });
}
