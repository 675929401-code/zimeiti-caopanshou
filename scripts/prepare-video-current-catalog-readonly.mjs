import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseEnv } from "dotenv";

const origin = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u);
const output = process.argv.find((value) => value.startsWith("--output="))?.slice(9)
  || ".codex-evidence/video-all-models-real-e2e-20260904/reviewed-current-catalog.json";
const requestedSurface = process.argv.find((value) => value.startsWith("--surface="))?.slice(10) || "union";
assert.ok(["union", "video-page", "storyboard-workbench"].includes(requestedSurface), "Unsupported video catalog surface");
const runtime = JSON.parse((await fs.readFile("F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true);
assert.equal(new URL(runtime.supabaseUrl).hostname, "127.0.0.1");
const baseEnv = parseEnv(await fs.readFile(".env.local", "utf8"));
// The isolated local preview is started from runtime.json. Its public model
// IDs must therefore be derived with that same runtime key. A stale checkout
// .env.local may belong to an earlier preview and must not take precedence.
process.env.PUBLIC_MODEL_ID_SECRET = runtime.publicModelIdSecret || runtime.jwtSecret || baseEnv.PUBLIC_MODEL_ID_SECRET || baseEnv.JWT_SECRET;
process.env.JWT_SECRET = runtime.jwtSecret || baseEnv.JWT_SECRET;
const { toPublicModelId } = await import("../src/lib/public-model-dto.ts");
const dbHeaders = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };

async function payload(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `Read-only catalog request failed: ${new URL(url).pathname} ${response.status}`);
  return body;
}
const [videoPage, storyboard] = await Promise.all([
  payload(`${origin}/api/video/models?surface=video-page`),
  payload(`${origin}/api/video/models?surface=storyboard-workbench`),
]);
const publicModels = new Map();
for (const [currentSurface, source] of [["video-page", videoPage], ["storyboard-workbench", storyboard]]) {
  if (requestedSurface !== "union" && requestedSurface !== currentSurface) continue;
  for (const model of source.models || []) {
    const existing = publicModels.get(model.id) || { ...model, surfaces: [] };
    existing.surfaces.push(currentSurface);
    publicModels.set(model.id, existing);
  }
}
const url = new URL(`${runtime.supabaseUrl.replace(/\/$/u, "")}/rest/v1/video_models`);
url.searchParams.set("select", "id,is_active,is_hidden,api_protocol_config");
url.searchParams.set("is_hidden", "eq.false");
const rows = await payload(url, { headers: dbHeaders });
const models = rows.map((row) => ({
  internalId: row.id,
  publicId: toPublicModelId("video", row.id),
  active: row.is_active === true,
  providerBillingUnit: String(row.api_protocol_config?.provider_billing_unit || "").trim().toLowerCase() || null,
  publicBillingPending: row.api_protocol_config?.public_billing_pending === true,
  tokenBillingAdapterReady: row.api_protocol_config?.token_billing_adapter_ready === true,
}))
  .filter((row) => publicModels.has(row.publicId))
  .sort((left, right) => {
    const leftIndex = [...publicModels.keys()].indexOf(left.publicId);
    const rightIndex = [...publicModels.keys()].indexOf(right.publicId);
    return leftIndex - rightIndex;
  });
assert.equal(models.length, publicModels.size, "Every public model must map to exactly one non-hidden internal row");
const report = {
  source: "current-local-runtime",
  checkedAt: new Date().toISOString(),
  scope: requestedSurface === "union" ? "union:video-page,storyboard-workbench" : requestedSurface,
  providerRequests: 0,
  databaseWrites: 0,
  models,
  public: [...publicModels.values()].map((model) => ({
    id: model.id,
    displayName: model.displayName,
    variantLabel: model.variantLabel,
    surfaces: model.surfaces,
    publicPrice: model.publicPrice,
    capabilities: model.capabilities,
  })),
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ publicModels: report.models.length, videoPage: videoPage.models?.length || 0, storyboard: storyboard.models?.length || 0, providerRequests: 0, databaseWrites: 0, output }));
