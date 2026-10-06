import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { chromium } from "playwright";
import { manjuConfigSemanticHash } from "./lib/manju-config-semantic-hash.mjs";

dotenv.config({ path: ".env.local", quiet: true });

const origin = "http://127.0.0.1:5000";
const output = process.argv[2] || ".codex-evidence/manju-current/published-front-readback.json";
const marker = `e2e-manju-published-${Date.now()}-${randomUUID().slice(0, 8)}`;
for (const name of ["JWT_SECRET", "COZE_SUPABASE_URL", "COZE_SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) throw new Error(`MISSING_${name}`);
}

const db = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const report = {
  observedAt: new Date().toISOString(),
  origin,
  marker,
  mode: "authorized-local-config-publish-and-reviewed-rollback",
  providerCalls: 0,
  paidGenerationRequests: 0,
  databaseMutations: 0,
  steps: [],
};
let adminToken = "";
let ordinaryToken = "";

function revision(record) {
  return record?.revision || record || {};
}

function releaseId(record) {
  return record?.release_id || record?.active_release_id || record?.pointer?.active_release_id || record?.release?.id || record?.id || "";
}

function revisionId(record) {
  return record?.revision_id || record?.pointer?.revision_id || record?.release?.revision_id || revision(record).revision_id || revision(record).id || "";
}

async function tokenFor(user) {
  return new SignJWT({
    userId: user.id,
    username: user.username || user.email || "local-acceptance",
    role: user.role,
    displayName: user.display_name || "本地验收",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function api(route, { token = adminToken, method = "GET", body } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${method} ${route}: HTTP ${response.status} ${data.code || ""}`);
  assert.notEqual(data.ok, false, `${method} ${route}: ${data.code || data.error || "failed"}`);
  if (method !== "GET" && body?.action !== "validate") report.databaseMutations += 1;
  return data;
}

async function frontReadback({ route, expectedText, showcaseId }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  const blocked = [];
  await context.addInitScript(({ tokenValue, expectedOrigin }) => {
    if (location.origin === expectedOrigin) localStorage.setItem("auth_token", tokenValue);
  }, { tokenValue: ordinaryToken, expectedOrigin: origin });
  await context.route("**/*", async (routeHandle) => {
    const request = routeHandle.request();
    const url = new URL(request.url());
    if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
      blocked.push({ method: request.method(), path: url.origin === origin ? url.pathname : "external" });
      return routeHandle.abort("blockedbyclient");
    }
    if (url.pathname === "/api/health" && !url.searchParams.has("liveness") && !url.searchParams.has("logs")) {
      blocked.push({ method: request.method(), path: url.pathname });
      return routeHandle.abort("blockedbyclient");
    }
    return routeHandle.continue();
  });
  const page = await context.newPage();
  const pageErrors = [];
  const httpErrors = [];
  page.on("pageerror", (error) => pageErrors.push({ name: error.name, message: error.message.slice(0, 160) }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) httpErrors.push({ path: url.pathname, status: response.status() });
  });
  try {
    const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200);
    const target = showcaseId
      ? page.locator(`[data-showcase-id="${showcaseId}"] h3`).filter({ hasText: expectedText })
      : page.getByText(expectedText, { exact: true });
    await target.first().waitFor({ state: "visible", timeout: 20_000 });
    const state = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      fatalText: /Application error|Unhandled Runtime Error|This page could not be found/iu.test(document.body.innerText),
      sidebarCount: document.querySelectorAll('[data-testid="film-studio-sidebar"]').length,
      mainCount: document.querySelectorAll('[data-testid="manju-content"]').length,
    }));
    assert.equal(state.horizontalOverflow, false);
    assert.equal(state.fatalText, false);
    assert.equal(state.sidebarCount, 1);
    assert.equal(state.mainCount, 1);
    return { route, expectedTextVisible: true, showcaseId, state, pageErrors, httpErrors, blocked };
  } finally {
    await browser.close();
  }
}

async function lifecycle({ domain, createPayload, verifyPublic, verifyFront }) {
  const route = `/api/admin/manju-config?environment=production&domain=${domain}`;
  const before = await api(route);
  assert.ok(before.active && Number.isInteger(before.storage_generation));
  const baselinePayload = structuredClone(revision(before.active).payload);
  const baselineHash = manjuConfigSemanticHash(baselinePayload);
  const baselineReleaseId = releaseId(before.active);
  const baselineRevisionId = revisionId(before.active);
  assert.ok(baselineReleaseId && baselineRevisionId, `${domain}: baseline release required`);
  const baselinePublic = await api(`/api/youcai/runtime-config?environment=production&t=${Date.now()}`, { token: "" });
  assert.equal(manjuConfigSemanticHash(baselinePublic.domains[domain]), baselineHash);
  const payload = createPayload(structuredClone(baselinePayload));
  let ownRevisionId = "";
  try {
    await api("/api/admin/manju-config", {
      method: "POST",
      body: { action: "validate", environment: "production", domain, schema_version: "1.1.0", payload },
    });
    const saved = await api("/api/admin/manju-config", {
      method: "POST",
      body: {
        action: "save-draft",
        environment: "production",
        domain,
        schema_version: "1.1.0",
        expected_storage_generation: before.storage_generation,
        payload,
      },
    });
    ownRevisionId = revisionId(saved.revision) || saved.revision?.id || "";
    assert.ok(ownRevisionId, `${domain}: saved revision id required`);
    const beforePublishPublic = await api(`/api/youcai/runtime-config?environment=production&t=${Date.now()}`, { token: "" });
    assert.equal(manjuConfigSemanticHash(beforePublishPublic.domains[domain]), baselineHash, `${domain}: draft leaked publicly`);
    const published = await api("/api/admin/manju-config", {
      method: "POST",
      body: {
        action: "publish",
        environment: "production",
        domain,
        expected_storage_generation: before.storage_generation,
        revision_id: ownRevisionId,
        expected_active_release_id: baselineReleaseId,
      },
    });
    assert.ok(releaseId(published.release) || published.release?.id, `${domain}: publish receipt required`);
    const publicReadback = await api(`/api/youcai/runtime-config?environment=production&t=${Date.now()}`, { token: "" });
    verifyPublic(publicReadback.domains[domain]);
    const front = await verifyFront();
    report.steps.push({ domain, draftStayedPrivate: true, publishPublicReadback: true, ordinaryFrontendReadback: front });
  } finally {
    const current = await api(route);
    const currentRevisionId = revisionId(current.active);
    if (ownRevisionId && currentRevisionId === ownRevisionId) {
      await api("/api/admin/manju-config", {
        method: "POST",
        body: {
          action: "rollback",
          environment: "production",
          domain,
          expected_storage_generation: current.storage_generation,
          target_release_id: baselineReleaseId,
          expected_active_release_id: releaseId(current.active),
        },
      });
      const restored = await api(`/api/youcai/runtime-config?environment=production&t=${Date.now()}`, { token: "" });
      assert.equal(manjuConfigSemanticHash(restored.domains[domain]), baselineHash, `${domain}: rollback mismatch`);
      report.steps.push({ domain, reviewedRollback: true, baselinePayloadRestored: true });
    } else if (currentRevisionId !== baselineRevisionId) {
      throw new Error(`${domain.toUpperCase()}_CONCURRENT_CHANGE_NO_AUTOMATIC_ROLLBACK`);
    }
  }
}

try {
  const users = await db.from("users")
    .select("id,username,email,display_name,role,status,is_active")
    .in("role", ["admin", "student"])
    .eq("is_active", true)
    .limit(100);
  if (users.error) throw users.error;
  const admin = users.data.find((item) => item.role === "admin" && (item.status === "active" || item.status === null));
  const ordinary = users.data.find((item) => item.role === "student" && (item.status === "active" || item.status === null));
  assert.ok(admin, "ACTIVE_ADMIN_REQUIRED");
  assert.ok(ordinary, "ACTIVE_ORDINARY_USER_REQUIRED");
  adminToken = await tokenFor(admin);
  ordinaryToken = await tokenFor(ordinary);
  const me = await api("/api/auth/me");
  assert.equal(me.user?.role, "admin");

  await lifecycle({
    domain: "content",
    createPayload: (baseline) => ({ ...baseline, brand: marker }),
    verifyPublic: (content) => assert.equal(content.brand, marker),
    verifyFront: () => frontReadback({ route: "/youcai", expectedText: marker }),
  });

  const siteConfig = await api("/api/site-config", { token: "" });
  const example = siteConfig.data?.canvasExamples?.[0];
  assert.ok(example?.canvasId && example?.title, "CANVAS_EXAMPLE_REQUIRED");
  await lifecycle({
    domain: "media",
    createPayload: (baseline) => {
      const currentCatalog = baseline.showcase_catalog || {};
      const currentV1 = currentCatalog.v1 || {};
      const currentCanvas = currentV1.canvas_examples || {};
      return {
        ...baseline,
        showcase_catalog: {
          ...currentCatalog,
          v1: {
            ...currentV1,
            canvas_examples: {
              ...currentCanvas,
              overrides: {
                ...(currentCanvas.overrides || {}),
                [example.canvasId]: {
                  ...(currentCanvas.overrides?.[example.canvasId] || {}),
                  enabled: true,
                  title: marker,
                },
              },
            },
          },
        },
      };
    },
    verifyPublic: (media) => assert.equal(media.showcase_catalog?.v1?.canvas_examples?.overrides?.[example.canvasId]?.title, marker),
    verifyFront: () => frontReadback({ route: "/youcai/tools/canvas", expectedText: marker, showcaseId: example.canvasId }),
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error?.name || "Error", message: error?.message || "UNKNOWN" };
  process.exitCode = 1;
} finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}
