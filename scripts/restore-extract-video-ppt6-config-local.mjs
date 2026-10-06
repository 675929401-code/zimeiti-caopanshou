import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
assert.equal(origin, "http://127.0.0.1:5000", "This recovery script only accepts the reviewed local preview");
assert.ok(token, "A short-lived local administrator token is required");

const headers = { Authorization: `Bearer ${token}` };
const secretKeyPattern = /(?:api[_-]?(?:key|token)|secret|password|authorization)/iu;
const targetKeys = new Set(["provider", "api_base_url"]);

async function readJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  assert.ok(response.ok, `${label} failed with HTTP ${response.status}`);
  return body;
}

async function getJson(relativeUrl, label) {
  const response = await fetch(`${origin}${relativeUrl}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  return readJson(response, label);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function withoutTargets(config) {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !targetKeys.has(key)));
}

function secretShape(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (secretKeyPattern.test(key)) {
      return [{ path: keyPath, masked: entry === "********", type: typeof entry }];
    }
    return secretShape(entry, keyPath);
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function activeVideoPlugins(payload) {
  assert.ok(Array.isArray(payload?.plugins), "Plugin list is unavailable");
  return payload.plugins.filter(plugin => plugin?.role === "extract_video" && plugin?.is_active === true);
}

async function readPluginState() {
  const list = await getJson("/api/admin/plugins?role=extract_video", "extract_video plugin list");
  const active = activeVideoPlugins(list);
  assert.equal(active.length, 1, "Exactly one active extract_video plugin is required");
  const id = String(active[0].id || "");
  assert.ok(id, "The active extract_video plugin id is missing");
  const detail = await getJson(`/api/admin/plugins?id=${encodeURIComponent(id)}`, "extract_video plugin detail");
  assert.equal(detail?.plugin?.id, id, "Plugin detail identity changed");
  return { list, active: active[0], plugin: detail.plugin };
}

function assertReviewedPlugin(plugin) {
  assert.equal(plugin.type, "third_party", "The active video extractor must remain a third-party plugin");
  assert.equal(String(plugin.config?.response_format || "").toLowerCase(), "ppt6", "PPT6 response format is required");
  assert.ok(String(plugin.config?.client_id || "").trim(), "PPT6 client_id is missing");
  assert.equal(plugin.config?.client_secret_key, "********", "PPT6 client_secret_key is not configured or not masked");
  assert.equal(Number(plugin.price_per_use), 0, "The reviewed local E2E plugin must remain zero priced");
  assert.equal(Number(plugin.cost_price), 0, "The reviewed local E2E plugin must remain zero cost");
}

async function main() {
  const identity = await getJson("/api/auth/me", "administrator identity");
  assert.equal(identity?.user?.role, "admin", "The local session is not an administrator");

  const beforeState = await readPluginState();
  const before = beforeState.plugin;
  assertReviewedPlugin(before);
  const beforeConfig = structuredClone(before.config || {});
  const beforeSecretShape = secretShape(beforeConfig);
  assert.ok(beforeSecretShape.length > 0 && beforeSecretShape.every(item => item.masked), "Plugin secrets must stay masked in the admin API");

  const beforeCatalog = await getJson("/api/tools/runtime-catalog", "runtime catalog before recovery");
  assert.equal(beforeCatalog?.items?.video?.pricingReady, true, "Video extraction pricing must be complete before recovery");

  const nextConfig = structuredClone(beforeConfig);
  nextConfig.provider = "ppt6";
  nextConfig.api_base_url = "https://apis.ppt6.top";
  const needsUpdate = beforeConfig.provider !== nextConfig.provider || beforeConfig.api_base_url !== nextConfig.api_base_url;
  let putAttempts = 0;
  let putStatus = null;
  let putTransportUncertain = false;

  if (needsUpdate) {
    putAttempts = 1;
    try {
      const response = await fetch(`${origin}/api/admin/plugins`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id: before.id, config: nextConfig }),
        signal: AbortSignal.timeout(15_000),
      });
      putStatus = response.status;
      await readJson(response, "extract_video plugin recovery");
    } catch (error) {
      putTransportUncertain = error instanceof DOMException && error.name === "TimeoutError";
      if (!putTransportUncertain) throw error;
    }
  }

  // A timeout is ambiguous. Read back the original row and never retry the PUT.
  const afterState = await readPluginState();
  const after = afterState.plugin;
  assert.equal(after.id, before.id, "The active extract_video plugin identity changed");
  assertReviewedPlugin(after);
  assert.equal(after.config?.provider, "ppt6", "PPT6 provider recovery did not persist");
  assert.equal(after.config?.api_base_url, "https://apis.ppt6.top", "PPT6 HTTPS base URL recovery did not persist");
  assert.deepEqual(
    canonical(withoutTargets(after.config || {})),
    canonical(withoutTargets(beforeConfig)),
    "A non-target plugin config field changed during recovery",
  );
  assert.deepEqual(secretShape(after.config || {}), beforeSecretShape, "Plugin secret mask structure changed during recovery");

  const afterCatalog = await getJson("/api/tools/runtime-catalog", "runtime catalog after recovery");
  const serializedCatalog = JSON.stringify(afterCatalog);
  assert.doesNotMatch(serializedCatalog, /(?:api[_-]?(?:key|token)|client[_-]?(?:id|secret)|authorization|password)/iu, "Runtime catalog exposed credential fields");
  assert.equal(afterCatalog?.items?.video?.available, true, "Video extraction is still unavailable after recovery");
  assert.equal(afterCatalog?.items?.video?.pricingReady, true, "Video extraction pricing is incomplete after recovery");
  assert.equal(String(afterCatalog?.items?.video?.provider || "").toLowerCase(), "ppt6", "Runtime catalog did not select PPT6");
  assert.equal(Number(afterCatalog?.items?.video?.unitPrice), 0, "Runtime catalog price changed during recovery");

  const evidenceDir = path.resolve(".codex-evidence", "extract-video-config-restoration");
  await mkdir(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, `ppt6-config-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  const evidence = {
    schemaVersion: 1,
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    plugin: {
      id: before.id,
      activeCountBefore: activeVideoPlugins(beforeState.list).length,
      activeCountAfter: activeVideoPlugins(afterState.list).length,
      provider: after.config.provider,
      apiBaseUrl: after.config.api_base_url,
      responseFormat: after.config.response_format,
      pricePerUse: Number(after.price_per_use),
      costPrice: Number(after.cost_price),
      secretFieldsMasked: true,
      nonTargetConfigPreserved: true,
    },
    runtimeCatalog: {
      available: afterCatalog.items.video.available,
      pricingReady: afterCatalog.items.video.pricingReady,
      provider: afterCatalog.items.video.provider,
      unitPrice: afterCatalog.items.video.unitPrice,
      credentialFieldsAbsent: true,
    },
    mutation: {
      needed: needsUpdate,
      putAttempts,
      putStatus,
      transportUncertain: putTransportUncertain,
      retried: false,
    },
  };
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ passed: true, evidenceFile, putAttempts }));
}

export { main };

