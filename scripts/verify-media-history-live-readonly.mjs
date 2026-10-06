#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const OUTPUT_DIR = path.resolve(".codex-evidence/media-history-live-readonly-20260929");
const THEMES = [
  { id: "lattice", mode: "dark", label: "深空晶" },
  { id: "soft-white", mode: "light", label: "柔光白" },
  { id: "crystal-aurora", mode: "dark", label: "黑曜霓彩" },
];
const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1920", width: 1920, height: 1080 },
];
const CATEGORY_KEYS = [
  "all",
  "image-workbench",
  "video-production",
  "storyboard-workbench",
  "cover-studio",
  "digital-human",
  "short-drama",
  "free-canvas",
  "agent-output",
  "commerce-agent",
  "other-tools",
];
const KIND_KEYS = ["all", "image", "video"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MEDIA_HISTORY_PATH = "/api/media-history";
const TICKET_PATHS = new Set([
  "/api/video/access-ticket",
  "/api/media-history/commerce/access-ticket",
]);
const VIDEO_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const VIDEO_RANGE_HEADER = "bytes=0-65535";
const MAX_VIDEO_REDIRECTS = 6;

function readReadOnlyIdentity() {
  const raw = String(process.env.LOCAL_NAV_READONLY_IDENTITY || "").trim();
  assert.ok(raw, "LOCAL_NAV_READONLY_IDENTITY_REQUIRED_USE_WITH_LOCAL_ADMIN_SESSION");
  let identity;
  try {
    identity = JSON.parse(raw);
  } catch {
    assert.fail("LOCAL_NAV_READONLY_IDENTITY_INVALID_JSON");
  }
  assert.ok(identity && typeof identity === "object", "LOCAL_NAV_READONLY_IDENTITY_OBJECT_REQUIRED");
  assert.ok(identity.user && typeof identity.user === "object", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  assert.equal(identity.user.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  assert.ok(String(identity.user.id || "").trim(), "LOCAL_ADMIN_ID_REQUIRED");
  return identity;
}

function finiteCount(value, label) {
  const count = Number(value);
  assert.ok(Number.isInteger(count) && count >= 0, `${label}:EXACT_NON_NEGATIVE_COUNT_REQUIRED`);
  return count;
}

function normalizedItems(payload, label) {
  assert.ok(payload && typeof payload === "object", `${label}:JSON_OBJECT_REQUIRED`);
  assert.ok(Array.isArray(payload.items), `${label}:ITEMS_ARRAY_REQUIRED`);
  return payload.items;
}

function compactNetworkRecord(request) {
  const url = new URL(request.url());
  return {
    method: request.method(),
    path: url.pathname,
    resourceType: request.resourceType(),
    hasMediaTicket: url.searchParams.has("media_ticket"),
    hasAccountTokenInUrl: /(?:auth_token|authorization|bearer|access_token)=/iu.test(url.search),
  };
}

function searchableText(item) {
  return [
    item.id,
    item.title,
    item.project,
    item.segment,
    item.source,
    item.publicModelName,
    item.status,
    item.categoryKey,
  ].join("\n").toLocaleLowerCase("zh-CN");
}

function expectedFilter(items, { category = "all", kind = "all", q = "" }) {
  const query = q.trim().toLocaleLowerCase("zh-CN");
  return items.filter((item) => (
    (category === "all" || item.categoryKey === category)
    && (kind === "all" || item.kind === kind)
    && (!query || searchableText(item).includes(query))
  ));
}

function stableIds(items) {
  return items.map((item) => String(item.id)).sort();
}

function assertNoDuplicateIds(items, label) {
  const ids = items.map((item) => String(item.id));
  assert.equal(new Set(ids).size, ids.length, `${label}:DUPLICATE_IDS`);
  assert.ok(ids.every(Boolean), `${label}:EMPTY_ID`);
}

function assertHistoryItemShape(item, label) {
  assert.ok(item && typeof item === "object", `${label}:OBJECT_REQUIRED`);
  assert.ok(typeof item.id === "string" && item.id.length > 0, `${label}:ID_REQUIRED`);
  assert.ok(["image", "video"].includes(item.kind), `${label}:KIND_INVALID`);
  assert.ok(CATEGORY_KEYS.includes(item.categoryKey), `${label}:CATEGORY_INVALID`);
  assert.ok(["queued", "processing", "completed", "failed", "cancelled"].includes(item.status), `${label}:STATUS_INVALID`);
  assert.equal(typeof item.previewPath, "string", `${label}:PREVIEW_PATH_STRING_REQUIRED`);
  assert.equal(typeof item.thumbnailPath, "string", `${label}:THUMBNAIL_PATH_STRING_REQUIRED`);
  if (item.status === "completed") {
    assert.ok(item.previewPath.startsWith("/api/"), `${label}:COMPLETED_PREVIEW_MUST_BE_PROTECTED_API`);
    if (item.kind === "video") {
      assert.ok(item.thumbnailPath.startsWith("/api/"), `${label}:COMPLETED_VIDEO_FIRST_FRAME_PATH_REQUIRED`);
    }
  }
}

function assertFacetShape(facets, expectedAll, label) {
  assert.ok(facets && typeof facets === "object", `${label}:FACETS_REQUIRED`);
  assert.ok(facets.categories && typeof facets.categories === "object", `${label}:CATEGORY_FACETS_REQUIRED`);
  assert.ok(facets.kinds && typeof facets.kinds === "object", `${label}:KIND_FACETS_REQUIRED`);
  const categories = Object.fromEntries(CATEGORY_KEYS.map((key) => [
    key,
    finiteCount(facets.categories[key], `${label}:CATEGORY:${key}`),
  ]));
  const kinds = Object.fromEntries(KIND_KEYS.map((key) => [
    key,
    finiteCount(facets.kinds[key], `${label}:KIND:${key}`),
  ]));
  assert.equal(categories.all, expectedAll, `${label}:CATEGORY_ALL_MISMATCH`);
  assert.equal(kinds.all, expectedAll, `${label}:KIND_ALL_MISMATCH`);
  assert.equal(
    CATEGORY_KEYS.filter((key) => key !== "all").reduce((total, key) => total + categories[key], 0),
    expectedAll,
    `${label}:CATEGORY_SUM_MISMATCH`,
  );
  assert.equal(kinds.image + kinds.video, expectedAll, `${label}:KIND_SUM_MISMATCH`);
  return { categories, kinds };
}

async function readSourceContracts() {
  const [page, route, preview, ticket] = await Promise.all([
    fs.readFile(path.resolve("src/app/media-history/page.tsx"), "utf8"),
    fs.readFile(path.resolve("src/app/api/media-history/route.ts"), "utf8"),
    fs.readFile(path.resolve("src/components/media-history-video-preview.tsx"), "utf8"),
    fs.readFile(path.resolve("src/lib/media-history-video-preview.ts"), "utf8"),
  ]);
  assert.match(page, /type CategoryKey = MediaHistoryCategoryKey/u);
  assert.match(page, /IntersectionObserver/u, "MEDIA_HISTORY_LAZY_PREVIEW_OBSERVER_MISSING");
  assert.match(page, /data-media-preview=\{item\.kind\}/u, "MEDIA_HISTORY_PREVIEW_DOM_CONTRACT_MISSING");
  assert.match(page, /MediaHistoryVideoPreview/u, "MEDIA_HISTORY_NATIVE_VIDEO_FALLBACK_MISSING");
  assert.match(page, /requestMediaHistoryVideoUrl/u, "MEDIA_HISTORY_SHORT_TICKET_CLIENT_MISSING");
  assert.match(route, /function exactFacets\(/u, "MEDIA_HISTORY_EXACT_FACETS_MISSING");
  assert.match(route, /stableDedupe\(/u, "MEDIA_HISTORY_STABLE_DEDUPE_MISSING");
  assert.match(route, /searchParams\.get\("category"\)/u);
  assert.match(route, /searchParams\.get\("kind"\)/u);
  assert.match(route, /searchParams\.get\("q"\)/u);
  assert.match(route, /thumbnailPath/u, "MEDIA_HISTORY_THUMBNAIL_PATH_MISSING");
  assert.match(preview, /preload="metadata"/u, "NATIVE_PREVIEW_MUST_USE_METADATA_PRELOAD");
  assert.match(preview, /currentTime\s*=\s*(?:Math\.min\()?0\.1/u, "NATIVE_PREVIEW_FIRST_FRAME_SEEK_MISSING");
  assert.doesNotMatch(ticket, /fetch\(previewPath/u, "VIDEO_PREVIEW_MUST_NOT_FETCH_WHOLE_VIDEO_TO_BLOB");
  assert.match(ticket, /media_ticket/u, "SHORT_MEDIA_TICKET_VALIDATION_MISSING");
  return {
    ok: true,
    checks: [
      "stable category keys",
      "server exact facets and stable dedupe",
      "category/kind/q API filtering",
      "intersection-observer lazy previews",
      "protected image and static video first-frame DOM",
      "native metadata/Range fallback",
      "short-lived video access tickets",
      "no whole-video fetch-to-blob playback helper",
    ],
  };
}

async function apiJson(origin, token, pathname, timeoutMs = 45_000) {
  const url = new URL(pathname, origin);
  assert.equal(url.origin, origin, "API_REQUEST_MUST_STAY_ON_LOCAL_ORIGIN");
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${url.pathname}:HTTP_${response.status}:${String(payload?.error || "")}`);
  return { response, payload };
}

async function enumerateHistory(origin, token, filter, expectedFacets, pageSize = 13) {
  const items = [];
  let offset = 0;
  let total = null;
  let pageCount = 0;
  while (true) {
    assert.ok(pageCount < 1_000, "MEDIA_HISTORY_PAGINATION_DID_NOT_TERMINATE");
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      category: filter.category || "all",
      kind: filter.kind || "all",
      q: filter.q || "",
      includeTotal: "true",
    });
    const { payload } = await apiJson(origin, token, `${MEDIA_HISTORY_PATH}?${params}`);
    const incoming = normalizedItems(payload, `page-${pageCount}`);
    assertNoDuplicateIds(incoming, `page-${pageCount}`);
    const pagination = payload.pagination;
    assert.ok(pagination && typeof pagination === "object", `page-${pageCount}:PAGINATION_REQUIRED`);
    const pageTotal = finiteCount(pagination.total ?? payload.totalCount ?? payload.total, `page-${pageCount}:TOTAL`);
    const returned = finiteCount(pagination.returned, `page-${pageCount}:RETURNED`);
    const currentCount = finiteCount(pagination.currentCount, `page-${pageCount}:CURRENT_COUNT`);
    assert.equal(payload.totalCountSource, "exact-aggregate", `page-${pageCount}:TOTAL_NOT_EXACT_AGGREGATE`);
    assert.equal(pagination.totalKnown, true, `page-${pageCount}:TOTAL_NOT_KNOWN`);
    assert.equal(returned, incoming.length, `page-${pageCount}:RETURNED_MISMATCH`);
    assert.equal(currentCount, incoming.length, `page-${pageCount}:CURRENT_COUNT_MISMATCH`);
    if (total === null) total = pageTotal;
    assert.equal(pageTotal, total, `page-${pageCount}:TOTAL_DRIFTED_DURING_PAGINATION`);
    if (expectedFacets) {
      assert.deepEqual(assertFacetShape(payload.facets, expectedFacets.categories.all, `page-${pageCount}`), expectedFacets);
    }
    items.push(...incoming);
    assertNoDuplicateIds(items, `aggregate-after-page-${pageCount}`);
    const expectedHasMore = offset + incoming.length < total;
    assert.equal(Boolean(pagination.hasMore), expectedHasMore, `page-${pageCount}:HAS_MORE_MISMATCH`);
    if (!expectedHasMore) {
      assert.equal(pagination.nextOffset, null, `page-${pageCount}:NEXT_OFFSET_MUST_BE_NULL`);
      break;
    }
    const nextOffset = finiteCount(pagination.nextOffset, `page-${pageCount}:NEXT_OFFSET`);
    assert.equal(nextOffset, offset + incoming.length, `page-${pageCount}:NEXT_OFFSET_MISMATCH`);
    assert.ok(nextOffset > offset, `page-${pageCount}:NEXT_OFFSET_DID_NOT_ADVANCE`);
    offset = nextOffset;
    pageCount += 1;
  }
  assert.equal(items.length, total, "FILTERED_ENUMERATION_TOTAL_MISMATCH");
  return { items, total, pages: pageCount + 1 };
}

async function verifyApiContract(origin, token) {
  const baselineParams = new URLSearchParams({ limit: "1", offset: "0", category: "all", kind: "all", q: "", includeTotal: "true" });
  const { payload: baselineHead } = await apiJson(origin, token, `${MEDIA_HISTORY_PATH}?${baselineParams}`);
  const baselineTotal = finiteCount(baselineHead.totalCount, "BASELINE_TOTAL");
  const facets = assertFacetShape(baselineHead.facets, baselineTotal, "BASELINE");
  const baseline = await enumerateHistory(origin, token, { category: "all", kind: "all", q: "" }, facets, 17);
  assert.equal(baseline.total, baselineTotal, "BASELINE_ENUMERATION_TOTAL_MISMATCH");
  assertNoDuplicateIds(baseline.items, "BASELINE");
  baseline.items.forEach((item, index) => assertHistoryItemShape(item, `BASELINE_ITEM_${index}`));

  const facetFromRows = {
    categories: Object.fromEntries(CATEGORY_KEYS.map((key) => [
      key,
      key === "all" ? baseline.items.length : baseline.items.filter((item) => item.categoryKey === key).length,
    ])),
    kinds: Object.fromEntries(KIND_KEYS.map((key) => [
      key,
      key === "all" ? baseline.items.length : baseline.items.filter((item) => item.kind === key).length,
    ])),
  };
  assert.deepEqual(facets, facetFromRows, "FACETS_DO_NOT_MATCH_ACCOUNT_LEVEL_ROWS");

  const filterRuns = [];
  for (const category of CATEGORY_KEYS.slice(1)) {
    const result = await enumerateHistory(origin, token, { category, kind: "all", q: "" }, facets, 11);
    const expected = expectedFilter(baseline.items, { category });
    assert.deepEqual(stableIds(result.items), stableIds(expected), `CATEGORY_FILTER_MISMATCH:${category}`);
    assert.equal(result.total, facets.categories[category], `CATEGORY_TOTAL_MISMATCH:${category}`);
    assert.ok(result.items.every((item) => item.categoryKey === category), `CATEGORY_LEAK:${category}`);
    filterRuns.push({ type: "category", key: category, total: result.total, pages: result.pages });
  }
  for (const kind of KIND_KEYS.slice(1)) {
    const result = await enumerateHistory(origin, token, { category: "all", kind, q: "" }, facets, 11);
    const expected = expectedFilter(baseline.items, { kind });
    assert.deepEqual(stableIds(result.items), stableIds(expected), `KIND_FILTER_MISMATCH:${kind}`);
    assert.equal(result.total, facets.kinds[kind], `KIND_TOTAL_MISMATCH:${kind}`);
    assert.ok(result.items.every((item) => item.kind === kind), `KIND_LEAK:${kind}`);
    filterRuns.push({ type: "kind", key: kind, total: result.total, pages: result.pages });
  }

  let queryEvidence = {
    skipped: true,
    reason: "no retained media rows after upstream/fallback expiry",
    total: 0,
    combinedTotal: 0,
  };
  if (baseline.items.length > 0) {
    const querySample = baseline.items.find((item) => item.status === "completed") || baseline.items[0];
    const query = String(querySample.id);
    const queryResult = await enumerateHistory(origin, token, { category: "all", kind: "all", q: query }, facets, 3);
    const queryExpected = expectedFilter(baseline.items, { q: query });
    assert.deepEqual(stableIds(queryResult.items), stableIds(queryExpected), "QUERY_FILTER_MISMATCH");
    assert.ok(queryResult.items.some((item) => item.id === querySample.id), "QUERY_SAMPLE_NOT_RETURNED");

    const combinedResult = await enumerateHistory(origin, token, {
      category: querySample.categoryKey,
      kind: querySample.kind,
      q: query,
    }, facets, 2);
    const combinedExpected = expectedFilter(baseline.items, {
      category: querySample.categoryKey,
      kind: querySample.kind,
      q: query,
    });
    assert.deepEqual(stableIds(combinedResult.items), stableIds(combinedExpected), "COMBINED_FILTER_MISMATCH");
    queryEvidence = { skipped: false, query, total: queryResult.total, combinedTotal: combinedResult.total };
  }

  const completedImage = baseline.items.find((item) => item.kind === "image" && item.status === "completed" && item.previewPath);
  const completedVideo = baseline.items.find((item) => item.kind === "video" && item.status === "completed" && item.previewPath);
  const failed = baseline.items.find((item) => ["failed", "cancelled"].includes(item.status));

  return {
    facets,
    total: baseline.total,
    pages: baseline.pages,
    filterRuns,
    query: queryEvidence,
    items: baseline.items,
    samples: { completedImage, completedVideo, failed },
    retainedState: baseline.items.length === 0 ? "empty-after-retention" : "retained-rows-present",
    dynamicCoverage: {
      completedImage: Boolean(completedImage),
      completedVideo: Boolean(completedVideo),
      failedOrCancelled: Boolean(failed),
    },
    sourceFailures: Array.isArray(baselineHead.sourceFailures) ? baselineHead.sourceFailures : [],
  };
}

function ticketRequestForItem(item, scope) {
  if (item.previewPath.startsWith("/api/video/storage/")) {
    const taskId = item.previewPath.slice("/api/video/storage/".length);
    const query = new URLSearchParams({ taskId, scope });
    if (scope === "download") query.set("name", "media-history-readonly.mp4");
    return `/api/video/access-ticket?${query}`;
  }
  const match = /^\/api\/media-history\/commerce\/content\/([^/?#]+)$/u.exec(item.previewPath);
  assert.ok(match, "VIDEO_PREVIEW_PATH_NOT_SUPPORTED_BY_TICKET_CONTRACT");
  return `/api/media-history/commerce/access-ticket?${new URLSearchParams({ assetId: match[1], scope })}`;
}

function assertNoAccountTokenInUrl(target, accountToken, label) {
  assert.equal(target.href.includes(accountToken), false, `${label}:ACCOUNT_TOKEN_LEAKED_TO_URL`);
  const forbiddenCredentialKey = [...target.searchParams.keys()].find((key) => (
    /^(?:auth_token|authorization|bearer|access_token)$/iu.test(key)
  ));
  assert.equal(forbiddenCredentialKey, undefined, `${label}:ACCOUNT_TOKEN_PARAMETER_LEAK`);
}

function inspectShortLivedPlaybackTicket(ticket, label) {
  assert.ok(ticket, `${label}:MEDIA_TICKET_MISSING`);
  const segments = ticket.split(".");
  assert.equal(segments.length, 3, `${label}:MEDIA_TICKET_NOT_SIGNED_JWT`);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    assert.fail(`${label}:MEDIA_TICKET_PAYLOAD_INVALID`);
  }
  assert.equal(claims?.purpose, "video-access", `${label}:MEDIA_TICKET_PURPOSE_INVALID`);
  assert.equal(claims?.scope, "playback", `${label}:MEDIA_TICKET_SCOPE_INVALID`);
  assert.ok(typeof claims?.taskId === "string" && claims.taskId.length > 0, `${label}:MEDIA_TICKET_TASK_MISSING`);
  assert.ok(Number.isSafeInteger(claims?.iat), `${label}:MEDIA_TICKET_IAT_INVALID`);
  assert.ok(Number.isSafeInteger(claims?.exp), `${label}:MEDIA_TICKET_EXP_INVALID`);
  const ttlSeconds = claims.exp - claims.iat;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  assert.ok(ttlSeconds >= 60 && ttlSeconds <= 30 * 60, `${label}:MEDIA_TICKET_NOT_SHORT_LIVED`);
  assert.ok(claims.exp > nowSeconds, `${label}:MEDIA_TICKET_ALREADY_EXPIRED`);
  assert.ok(claims.iat <= nowSeconds + 60, `${label}:MEDIA_TICKET_IAT_IN_FUTURE`);
  return { ttlSeconds, purpose: claims.purpose, scope: claims.scope };
}

function validateVideoRedirect(location, currentUrl, origin, accountToken, hop) {
  assert.ok(location, `VIDEO_REDIRECT_${hop}:LOCATION_MISSING`);
  const target = new URL(location, currentUrl);
  assertNoAccountTokenInUrl(target, accountToken, `VIDEO_REDIRECT_${hop}`);
  if (target.origin === origin) {
    assert.match(target.pathname, /^\/api\//u, `VIDEO_REDIRECT_${hop}:SAME_ORIGIN_NON_API_TARGET`);
    const ticket = inspectShortLivedPlaybackTicket(
      target.searchParams.get("media_ticket") || "",
      `VIDEO_REDIRECT_${hop}`,
    );
    return {
      target,
      evidence: {
        kind: "same-origin-api",
        pathname: target.pathname,
        hasMediaTicket: true,
        ticketTtlSeconds: ticket.ttlSeconds,
      },
    };
  }
  assert.equal(target.protocol, "https:", `VIDEO_REDIRECT_${hop}:EXTERNAL_TARGET_MUST_USE_HTTPS`);
  return {
    target,
    evidence: {
      kind: "external-https",
      hostname: target.hostname,
      protocol: target.protocol,
      hasAccountToken: false,
    },
  };
}

async function fetchControlledVideoRange(initialTarget, origin, accountToken) {
  let currentTarget = initialTarget;
  const redirects = [];
  const statuses = [];
  for (let hop = 0; hop <= MAX_VIDEO_REDIRECTS; hop += 1) {
    assertNoAccountTokenInUrl(currentTarget, accountToken, `VIDEO_RANGE_HOP_${hop}`);
    const response = await fetch(currentTarget, {
      method: "GET",
      headers: { Range: VIDEO_RANGE_HEADER },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    statuses.push(response.status);
    if (!VIDEO_REDIRECT_STATUSES.has(response.status)) {
      return {
        response,
        redirects,
        statuses,
        finalTarget: currentTarget,
      };
    }
    assert.ok(hop < MAX_VIDEO_REDIRECTS, "VIDEO_REDIRECT_LIMIT_EXCEEDED");
    const validated = validateVideoRedirect(
      response.headers.get("location"),
      currentTarget,
      origin,
      accountToken,
      hop + 1,
    );
    redirects.push({ status: response.status, ...validated.evidence });
    await response.body?.cancel();
    currentTarget = validated.target;
  }
  assert.fail("VIDEO_REDIRECT_LIMIT_EXCEEDED");
}

async function verifyProtectedMedia(origin, token, samples) {
  let imageEvidence = {
    available: false,
    reason: "no retained completed image in the local account",
    contentType: "",
    bytes: 0,
  };
  if (samples.completedImage) {
    const imageUrl = new URL(samples.completedImage.previewPath, origin);
    assert.equal(imageUrl.origin, origin, "IMAGE_PREVIEW_MUST_BE_SAME_ORIGIN");
    const imageResponse = await fetch(imageUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(imageResponse.ok, true, `IMAGE_PREVIEW_HTTP_${imageResponse.status}`);
    assert.match(String(imageResponse.headers.get("content-type") || ""), /^image\//u, "IMAGE_PREVIEW_CONTENT_TYPE_INVALID");
    const imageBytes = await imageResponse.arrayBuffer();
    assert.ok(imageBytes.byteLength > 100, "IMAGE_PREVIEW_EMPTY");
    imageEvidence = {
      available: true,
      reason: "retained completed image decoded from the protected endpoint",
      contentType: String(imageResponse.headers.get("content-type") || ""),
      bytes: imageBytes.byteLength,
    };
  }

  let staticFirstFrame = { available: false, status: null, contentType: "", bytes: 0 };
  if (!samples.completedVideo) {
    return {
      image: imageEvidence,
      video: { available: false, reason: "no retained completed video in the local account" },
      staticFirstFrame,
      tickets: {},
      rangeFallbackVerified: false,
      structuralPreviewCoverage: "source contract and isolated browser fixture",
    };
  }
  if (samples.completedVideo.thumbnailPath) {
    const thumbnailUrl = new URL(samples.completedVideo.thumbnailPath, origin);
    assert.equal(thumbnailUrl.origin, origin, "VIDEO_THUMBNAIL_MUST_BE_SAME_ORIGIN");
    const thumbnailResponse = await fetch(thumbnailUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    });
    staticFirstFrame = {
      available: thumbnailResponse.ok,
      status: thumbnailResponse.status,
      contentType: String(thumbnailResponse.headers.get("content-type") || ""),
      bytes: 0,
    };
    if (thumbnailResponse.ok) {
      assert.match(staticFirstFrame.contentType, /^image\//u, "VIDEO_THUMBNAIL_CONTENT_TYPE_INVALID");
      const bytes = await thumbnailResponse.arrayBuffer();
      staticFirstFrame.bytes = bytes.byteLength;
      assert.ok(bytes.byteLength > 100, "VIDEO_THUMBNAIL_EMPTY");
    } else {
      await thumbnailResponse.body?.cancel();
    }
  }

  const tickets = {};
  for (const scope of ["playback", "download"]) {
    const requestPath = ticketRequestForItem(samples.completedVideo, scope);
    const { payload } = await apiJson(origin, token, requestPath);
    const target = new URL(String(payload.url || ""), origin);
    assert.equal(target.origin, origin, `${scope}:TICKET_TARGET_NOT_LOCAL`);
    assert.ok(target.searchParams.get("media_ticket"), `${scope}:MEDIA_TICKET_MISSING`);
    assertNoAccountTokenInUrl(target, token, scope);
    assert.ok(
      Number.isInteger(payload.expiresInSeconds)
      && payload.expiresInSeconds >= 60
      && payload.expiresInSeconds <= 30 * 60,
      `${scope}:ACCESS_TICKET_NOT_SHORT_LIVED`,
    );
    assert.equal(scope === "download", target.pathname.includes("proxy-download") || target.searchParams.get("download") === "1", `${scope}:TICKET_SCOPE_MISMATCH`);
    tickets[scope] = {
      pathname: target.pathname,
      hasMediaTicket: true,
      expiresInSeconds: payload.expiresInSeconds,
      tokenInUrl: false,
    };
    if (scope === "playback") {
      const initialTicket = inspectShortLivedPlaybackTicket(
        target.searchParams.get("media_ticket") || "",
        "playback",
      );
      const rangeResult = await fetchControlledVideoRange(target, origin, token);
      const rangeResponse = rangeResult.response;
      assert.equal(rangeResponse.status, 206, `VIDEO_RANGE_HTTP_${rangeResponse.status}`);
      const contentType = String(rangeResponse.headers.get("content-type") || "");
      const contentRange = String(rangeResponse.headers.get("content-range") || "");
      assert.match(contentType, /^video\//u, "VIDEO_RANGE_CONTENT_TYPE_INVALID");
      assert.match(contentRange, /^bytes 0-/u, "VIDEO_CONTENT_RANGE_MISSING");
      tickets.playback.range = {
        requested: VIDEO_RANGE_HEADER,
        initialTicketTtlSeconds: initialTicket.ttlSeconds,
        statuses: rangeResult.statuses,
        redirects: rangeResult.redirects,
        finalStatus: rangeResponse.status,
        finalContentType: contentType,
        finalContentRange: contentRange,
        finalKind: rangeResult.finalTarget.origin === origin ? "same-origin-api" : "external-https",
      };
      await rangeResponse.body?.cancel();
    }
  }
  assert.ok(staticFirstFrame.available || tickets.playback.hasMediaTicket, "NO_STATIC_FIRST_FRAME_OR_RANGE_FALLBACK");
  return {
    image: imageEvidence,
    video: { available: true, reason: "retained completed video validated" },
    staticFirstFrame,
    tickets,
    rangeFallbackVerified: true,
  };
}

function installObservers(page, report, id) {
  page.on("pageerror", (error) => report.pageErrors.push({ id, message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) {
      report.consoleErrors.push({ id, message: message.text() });
    }
  });
  page.on("request", (request) => {
    const record = compactNetworkRecord(request);
    report.requests.push({ id, ...record });
    if (record.hasAccountTokenInUrl) report.tokenLeaks.push({ id, ...record });
    if (TICKET_PATHS.has(record.path)) {
      report.ticketRequests.push({ id, path: record.path, method: record.method, authorizationHeader: "present-but-redacted" });
    }
  });
  page.on("response", async (response) => {
    const request = response.request();
    const contentType = String(response.headers()["content-type"] || "");
    if (response.status() >= 500) {
      report.serverErrors.push({ id, status: response.status(), path: new URL(response.url()).pathname });
    }
    if (/^video\//u.test(contentType) && ["fetch", "xhr"].includes(request.resourceType())) {
      report.videoFetchBlobViolations.push({ id, ...compactNetworkRecord(request), contentType });
    }
    if (/^video\//u.test(contentType)) {
      const headers = await request.allHeaders();
      report.videoByteRequests.push({
        id,
        ...compactNetworkRecord(request),
        range: headers.range ? "present" : "absent",
        authorizationHeader: headers.authorization ? "present" : "absent",
        contentType,
      });
    }
  });
}

async function createReadOnlyContext(browser, origin, token, identity, theme, viewport, report) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme.mode,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ authToken, authUser, selectedTheme, selectedMode }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    localStorage.setItem("user_theme_preference", selectedTheme);
    localStorage.setItem("user_theme_mode_preference", selectedMode);
    localStorage.setItem("app_theme", selectedTheme);
    localStorage.setItem("app_mode", selectedMode);
    localStorage.setItem("active_view", "media-history");
    sessionStorage.setItem("entered_app", "1");
  }, {
    authToken: token,
    authUser: identity.user,
    selectedTheme: theme.id,
    selectedMode: theme.mode,
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) {
      report.externalRequestsBlocked.push({ method, origin: url.origin, path: url.pathname });
      return route.abort("blockedbyclient");
    }
    if (!SAFE_METHODS.has(method)) {
      report.writeRequestsBlocked.push({ method, path: url.pathname });
      return route.abort("blockedbyclient");
    }
    // This GET can reconcile stale tasks and write database state. The history
    // acceptance does not need it, so keep the run strictly business-read-only.
    if (url.pathname === "/api/video/active-tasks") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTasks: [] }) });
    }
    // Force the selected theme without mutating the account preference.
    if (url.pathname === "/api/auth/me" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            ...identity.user,
            themePreference: theme.id,
            theme_preference: theme.id,
            themeModePreference: theme.mode,
            theme_mode_preference: theme.mode,
          },
        }),
      });
    }
    return route.continue();
  });
  return context;
}

async function waitForHistoryResponse(page, action, predicate = () => true) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === MEDIA_HISTORY_PATH && response.request().method() === "GET" && predicate(url);
  }, { timeout: 60_000 });
  const [response] = await Promise.all([responsePromise, action()]);
  assert.equal(response.status(), 200, `BROWSER_MEDIA_HISTORY_HTTP_${response.status()}`);
  await page.locator('section[aria-label="作品历史列表"]').waitFor({ state: "visible", timeout: 60_000 });
  return response;
}

async function closeAnnouncementIfPresent(page) {
  const closeButton = page.getByRole("button", { name: "关闭系统公告", exact: true });
  const opened = await closeButton.waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return false;
  await closeButton.click();
  await closeButton.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

async function pageThemeState(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const cards = [...document.querySelectorAll("article[data-category]")];
    return {
      theme: root.dataset.theme || "",
      mode: root.dataset.mode || "",
      primary: style.getPropertyValue("--primary").trim(),
      background: style.getPropertyValue("--background").trim(),
      horizontalOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
      cardCount: cards.length,
      categories: [...new Set(cards.map((card) => card.getAttribute("data-category")))].filter(Boolean),
      previewCount: document.querySelectorAll("[data-media-preview]").length,
      categoryFilterCount: document.querySelectorAll('[aria-label="生产来源筛选"] button').length,
      kindFilterCount: document.querySelectorAll('[aria-label="媒体类型筛选"] button').length,
      emptyState: document.body.innerText.includes("没有匹配的作品"),
      retentionCopy: document.body.innerText.includes("图片保留两天、视频保留三天"),
      resultSummary: document.querySelector('[aria-label="作品历史筛选"]')?.textContent || "",
      overflowingCards: cards.filter((card) => {
        const rect = card.getBoundingClientRect();
        return rect.left < -1 || rect.right > window.innerWidth + 1;
      }).length,
    };
  });
}

async function loadMediaHistoryPage(context, origin, theme, viewport, report, expectedTotal) {
  const id = `${theme.id}-${viewport.name}`;
  const page = await context.newPage();
  installObservers(page, report, id);
  const response = await page.goto(`${origin}/media-history`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `${id}:PAGE_HTTP_${response?.status()}`);
  await page.getByRole("heading", { name: "作品历史", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await closeAnnouncementIfPresent(page);
  await page.locator('[aria-label="作品历史筛选"]').waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => (
    Boolean(document.querySelector('section[aria-label="作品历史列表"]'))
    || document.body.innerText.includes("没有匹配的作品")
  ), undefined, { timeout: 60_000 });
  await page.waitForFunction(({ expectedTheme, expectedMode }) => (
    document.documentElement.dataset.theme === expectedTheme
    && document.documentElement.dataset.mode === expectedMode
  ), { expectedTheme: theme.id, expectedMode: theme.mode }, { timeout: 30_000 });
  await page.waitForTimeout(350);
  const state = await pageThemeState(page);
  assert.deepEqual({ theme: state.theme, mode: state.mode }, { theme: theme.id, mode: theme.mode }, `${id}:THEME_MISMATCH`);
  assert.ok(state.primary && state.background, `${id}:THEME_SEMANTIC_COLORS_MISSING`);
  assert.equal(state.categoryFilterCount, CATEGORY_KEYS.length, `${id}:CATEGORY_FILTERS_INCOMPLETE`);
  assert.equal(state.kindFilterCount, KIND_KEYS.length, `${id}:KIND_FILTERS_INCOMPLETE`);
  assert.equal(state.retentionCopy, true, `${id}:RETENTION_COPY_MISSING`);
  assert.ok(state.resultSummary.includes(`${expectedTotal}`), `${id}:EXACT_TOTAL_NOT_RENDERED`);
  if (expectedTotal === 0) {
    assert.equal(state.cardCount, 0, `${id}:EMPTY_ACCOUNT_RENDERED_CARDS`);
    assert.equal(state.previewCount, 0, `${id}:EMPTY_ACCOUNT_RENDERED_PREVIEW_REGIONS`);
    assert.equal(state.emptyState, true, `${id}:EMPTY_STATE_MISSING`);
  } else {
    assert.ok(state.cardCount > 0, `${id}:MEDIA_HISTORY_CARDS_MISSING`);
    assert.equal(state.emptyState, false, `${id}:NON_EMPTY_ACCOUNT_RENDERED_EMPTY_STATE`);
  }
  assert.equal(state.previewCount, state.cardCount, `${id}:EVERY_CARD_REQUIRES_PREVIEW_REGION`);
  assert.ok(state.horizontalOverflow <= 1, `${id}:HORIZONTAL_OVERFLOW:${state.horizontalOverflow}`);
  assert.equal(state.overflowingCards, 0, `${id}:CARD_OUTSIDE_VIEWPORT`);
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${id}.png`), fullPage: false });
  return { page, id, state };
}

async function setHistorySearch(page, value) {
  const input = page.getByRole("textbox", { name: "搜索作品历史" });
  await waitForHistoryResponse(page, () => input.fill(value), (url) => url.searchParams.get("q") === value);
  await page.waitForTimeout(200);
}

async function verifyImageDom(page, sample) {
  await setHistorySearch(page, sample.id);
  const card = page.locator("article[data-category]").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  const image = card.locator('img[alt$="图片预览"]');
  await image.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('article[data-category] img[alt$="图片预览"]');
    return node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0;
  }, undefined, { timeout: 60_000 });
  const state = await image.evaluate((node) => ({
    src: node.getAttribute("src") || "",
    naturalWidth: node.naturalWidth,
    naturalHeight: node.naturalHeight,
  }));
  assert.match(state.src, /^blob:/u, "PROTECTED_IMAGE_PREVIEW_MUST_USE_OBJECT_URL");
  assert.ok(state.naturalWidth > 0 && state.naturalHeight > 0, "IMAGE_PREVIEW_DID_NOT_DECODE");
  return { decoded: true, width: state.naturalWidth, height: state.naturalHeight, protectedBlobUrl: true };
}

async function verifyVideoDom(page, sample, report, id) {
  await setHistorySearch(page, sample.id);
  const card = page.locator("article[data-category]").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const card = document.querySelector("article[data-category]");
    if (!card) return false;
    const image = card.querySelector('img[alt$="视频首帧"]');
    const video = card.querySelector("[data-native-video-preview] video");
    return Boolean((image && image.naturalWidth > 0) || (video && video.readyState >= 1));
  }, undefined, { timeout: 180_000 });
  const preview = await card.evaluate((node) => {
    const image = node.querySelector('img[alt$="视频首帧"]');
    const video = node.querySelector("[data-native-video-preview] video");
    return image && image.naturalWidth > 0
      ? { mode: "static-first-frame", decoded: true, preload: null, autoplay: false }
      : {
          mode: "native-range-fallback",
          decoded: Boolean(video && video.readyState >= 1),
          preload: video?.getAttribute("preload") || null,
          autoplay: Boolean(video?.autoplay),
        };
  });
  assert.equal(preview.decoded, true, "VIDEO_PREVIEW_NOT_DECODED");
  if (preview.mode === "native-range-fallback") {
    assert.equal(preview.preload, "metadata", "NATIVE_VIDEO_PRELOAD_MUST_BE_METADATA");
    assert.equal(preview.autoplay, false, "NATIVE_VIDEO_MUST_NOT_AUTOPLAY");
  }

  const ticketCountBefore = report.ticketRequests.length;
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  const playbackNavigationPromise = page.context().waitForEvent("request", {
    timeout: 60_000,
    predicate: (request) => {
      try {
        const url = new URL(request.url());
        return request.isNavigationRequest() && url.searchParams.has("media_ticket");
      } catch {
        return false;
      }
    },
  });
  await card.getByRole("button", { name: "打开预览", exact: true }).click();
  const [popup, playbackNavigation] = await Promise.all([popupPromise, playbackNavigationPromise]);
  installObservers(popup, report, `${id}-video-popup`);
  // A top-level navigation to raw video bytes can finish with Chromium's
  // ERR_ABORTED even though the media request was correctly dispatched. The
  // navigation request is therefore the durable UI evidence; decoding and
  // strict 206 Range delivery are verified independently above.
  const popupUrl = new URL(playbackNavigation.url());
  assert.ok(popupUrl.searchParams.get("media_ticket"), "PLAYBACK_POPUP_MEDIA_TICKET_MISSING");
  const popupTicket = inspectShortLivedPlaybackTicket(
    popupUrl.searchParams.get("media_ticket") || "",
    "PLAYBACK_POPUP",
  );
  assert.equal(popupUrl.href.includes(String(process.env.LOCAL_NAV_ADMIN_TOKEN || "")), false, "PLAYBACK_POPUP_ACCOUNT_TOKEN_LEAK");
  assert.equal(/(?:auth_token|authorization|bearer|access_token)=/iu.test(popupUrl.search), false, "PLAYBACK_POPUP_TOKEN_PARAMETER_LEAK");
  assert.ok(report.ticketRequests.length > ticketCountBefore, "PLAYBACK_UI_DID_NOT_REQUEST_SHORT_TICKET");
  await popup.close();
  return {
    ...preview,
    popupTicket: true,
    popupTicketPurpose: popupTicket.purpose,
    popupTicketScope: popupTicket.scope,
    popupTicketTtlSeconds: popupTicket.ttlSeconds,
    accountTokenInUrl: false,
  };
}

async function verifyFailurePlaceholder(page, sample) {
  await setHistorySearch(page, sample.id);
  const card = page.locator("article[data-category]").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  const previewText = await card.locator('[data-media-preview]').innerText();
  assert.match(previewText, /任务未交付，暂无可用预览|任务已取消，暂无可用预览/u, "FAILED_MEDIA_PLACEHOLDER_MISSING");
  assert.equal(await card.locator('[data-media-preview] img, [data-media-preview] video').count(), 0, "FAILED_MEDIA_MUST_NOT_RENDER_BYTES");
  return { status: sample.status, placeholder: previewText.trim() };
}

async function verifyLazyVideoLoading(page) {
  await setHistorySearch(page, "");
  const videoButton = page.getByRole("button", { name: /^视频(?:\s|\d|—)/u }).first();
  await waitForHistoryResponse(page, () => videoButton.click(), (url) => url.searchParams.get("kind") === "video");
  const previews = page.locator('[data-media-preview="video"]');
  const previewCount = await previews.count();
  assert.ok(previewCount >= 4, "LAZY_VIDEO_PREVIEW_FIXTURES_REQUIRED");
  const lazyIndex = await page.evaluate(() => {
    const previews = [...document.querySelectorAll('[data-media-preview="video"]')];
    return previews.findIndex((preview) => {
      const card = preview.closest("article[data-category]");
      return Boolean(
        card
        && card.textContent?.includes("已完成")
        && preview.getBoundingClientRect().top > window.innerHeight + 260
        && preview.textContent?.includes("接近视区后读取视频首帧")
      );
    });
  });
  assert.ok(lazyIndex >= 0, "OFFSCREEN_VIDEO_WAS_NOT_LAZY");
  const target = previews.nth(lazyIndex);
  assert.equal(await target.locator("img, video").count(), 0, "OFFSCREEN_VIDEO_LOADED_BYTES_EARLY");
  await target.scrollIntoViewIfNeeded();
  await page.waitForFunction((index) => {
    const preview = document.querySelectorAll('[data-media-preview="video"]')[index];
    const image = preview?.querySelector('img[alt$="视频首帧"]');
    const video = preview?.querySelector("[data-native-video-preview] video");
    return Boolean((image && image.naturalWidth > 0) || (video && video.readyState >= 1));
  }, lazyIndex, { timeout: 180_000 });
  return { previewCount, offscreenIndex: lazyIndex, loadedAfterScroll: true };
}

async function verifyAdjacentPage(context, origin, pathname, report, id) {
  const page = await context.newPage();
  installObservers(page, report, id);
  const response = await page.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `${id}:HTTP_${response?.status()}`);
  await closeAnnouncementIfPresent(page);
  await page.waitForTimeout(1_000);
  const state = await page.evaluate(() => ({
    textLength: document.body.innerText.trim().length,
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    title: document.title,
  }));
  assert.ok(state.textLength > 20, `${id}:PAGE_DID_NOT_RENDER`);
  assert.ok(state.horizontalOverflow <= 1, `${id}:HORIZONTAL_OVERFLOW:${state.horizontalOverflow}`);
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${id}.png`), fullPage: false });
  await page.close();
  return { pathname, http: response?.status() || null, ...state };
}

async function verifyBrowser(origin, token, identity, api) {
  const browser = await chromium.launch({ headless: true });
  const report = {
    themes: [],
    mediaDom: {},
    adjacentPages: [],
    requests: [],
    ticketRequests: [],
    videoByteRequests: [],
    videoFetchBlobViolations: [],
    tokenLeaks: [],
    writeRequestsBlocked: [],
    externalRequestsBlocked: [],
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
  };
  try {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        const context = await createReadOnlyContext(browser, origin, token, identity, theme, viewport, report);
        const { page, id, state } = await loadMediaHistoryPage(context, origin, theme, viewport, report, api.total);
        if (theme.id === "lattice" && viewport.name === "desktop-1440") {
          report.mediaDom.image = api.samples.completedImage
            ? await verifyImageDom(page, api.samples.completedImage)
            : { skipped: true, reason: "no retained completed image" };
          const retainedCompletedVideos = api.items.filter((item) => (
            item.kind === "video" && item.status === "completed" && item.previewPath
          ));
          report.mediaDom.lazyVideo = retainedCompletedVideos.length >= 4
            ? await verifyLazyVideoLoading(page)
            : { skipped: true, reason: `only ${retainedCompletedVideos.length} retained completed videos` };
          report.mediaDom.video = api.samples.completedVideo
            ? await verifyVideoDom(page, api.samples.completedVideo, report, id)
            : { skipped: true, reason: "no retained completed video" };
          report.mediaDom.failure = api.samples.failed
            ? await verifyFailurePlaceholder(page, api.samples.failed)
            : { skipped: true, reason: "no retained failed or cancelled row" };
          if (api.total > 0) await setHistorySearch(page, "");
          report.adjacentPages.push(await verifyAdjacentPage(context, origin, "/video", report, "regression-video"));
          report.adjacentPages.push(await verifyAdjacentPage(context, origin, "/cover", report, "regression-cover"));
        }
        report.themes.push({ id, label: theme.label, viewport, ...state });
        await page.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(report.videoFetchBlobViolations, [], "VIDEO_BYTES_WERE_FETCHED_TO_XHR_OR_FETCH");
  assert.deepEqual(report.tokenLeaks, [], "ACCOUNT_TOKEN_LEAKED_IN_REQUEST_URL");
  assert.deepEqual(report.writeRequestsBlocked, [], "PAGE_ATTEMPTED_MUTATING_REQUEST");
  assert.deepEqual(report.externalRequestsBlocked, [], "PAGE_ATTEMPTED_EXTERNAL_REQUEST");
  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS");
  assert.deepEqual(report.consoleErrors, [], "BROWSER_CONSOLE_ERRORS");
  assert.deepEqual(report.serverErrors, [], "BROWSER_SERVER_ERRORS");
  if (api.samples.completedVideo) {
    assert.ok(report.ticketRequests.length > 0, "BROWSER_SHORT_TICKET_REQUEST_MISSING");
  } else {
    assert.equal(report.ticketRequests.length, 0, "EMPTY_VIDEO_SAMPLE_MUST_NOT_REQUEST_TICKETS");
  }
  assert.ok(report.themes.every((entry) => entry.horizontalOverflow <= 1 && entry.overflowingCards === 0), "THEME_VIEWPORT_OVERFLOW");
  return report;
}

export async function main(args = process.argv.slice(2)) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const source = await readSourceContracts();
  await fs.writeFile(path.join(OUTPUT_DIR, "source-contracts.json"), `${JSON.stringify(source, null, 2)}\n`);
  if (args.includes("--source-only")) {
    console.log(JSON.stringify({ ok: true, mode: "source-only", outputDir: OUTPUT_DIR, source }, null, 2));
    return;
  }

  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_LOOPBACK_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED_USE_WITH_LOCAL_ADMIN_SESSION");
  const identity = readReadOnlyIdentity();

  const api = await verifyApiContract(origin, token);
  const protectedMedia = await verifyProtectedMedia(origin, token, api.samples);
  const browser = await verifyBrowser(origin, token, identity, api);
  const dynamicFixtureReady = api.dynamicCoverage.completedImage && api.dynamicCoverage.completedVideo;
  const report = {
    ok: dynamicFixtureReady,
    technicalRunPassed: true,
    checkedAt: new Date().toISOString(),
    origin,
    mode: "live-local-readonly",
    acceptance: dynamicFixtureReady
      ? { status: "passed", reason: "retained completed image and video fixtures were exercised" }
      : {
        status: "blocked",
        reason: "no retained completed image and video fixture is available for dynamic preview, first-frame, download, and Range verification",
      },
    safety: {
      allowedMethods: [...SAFE_METHODS],
      externalNetworkBlocked: true,
      activeTaskReconciliationStubbed: true,
      authMeBackendBypassed: true,
      identityProbe: "protected media-history GET",
      paidSubmissions: 0,
      businessWrites: 0,
      accountTokenPersisted: false,
    },
    source,
    api: {
      total: api.total,
      facets: api.facets,
      pages: api.pages,
      filterRuns: api.filterRuns,
      query: api.query,
      uniqueIds: true,
      retainedState: api.retainedState,
      dynamicCoverage: api.dynamicCoverage,
      sourceFailures: api.sourceFailures,
    },
    protectedMedia,
    browser,
  };
  await fs.writeFile(path.join(OUTPUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!dynamicFixtureReady) process.exitCode = 2;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
