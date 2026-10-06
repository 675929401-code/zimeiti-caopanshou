import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const checks: Check[] = [];

function add(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function source(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  const exists = existsSync(absolutePath);
  add(`file:${relativePath}`, exists, exists ? "present" : "missing");
  return exists ? readFileSync(absolutePath, "utf8") : "";
}

function includesAll(name: string, text: string, tokens: readonly string[]) {
  const missing = tokens.filter((token) => !text.includes(token));
  add(
    name,
    missing.length === 0,
    missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`,
  );
}

function excludesAll(name: string, text: string, tokens: readonly string[]) {
  const present = tokens.filter((token) => text.includes(token));
  add(
    name,
    present.length === 0,
    present.length === 0 ? "forbidden tokens absent" : `present: ${present.join(", ")}`,
  );
}

const registryPath = "src/lib/server/manju-public-asset-registry.ts";
const adminRoutePath = "src/app/api/admin/manju-workbench/assets/route.ts";
const publicRoutePath = "src/app/api/youcai/public-assets/[assetId]/route.ts";
const publicCatalogPath = "src/lib/youcai-public-catalog.ts";
const adminUiPath = "src/components/admin/ManjuShowcaseCatalogManager.tsx";
// The live registry belongs to APP_DATA_DIR and is intentionally excluded from
// Git and release artifacts. Validate a versioned, data-free contract fixture
// here so the code gate cannot require mutable business data in the source
// repository.
const dataPath = "scripts/fixtures/manju-public-assets.v1.json";

const registry = source(registryPath);
const adminRoute = source(adminRoutePath);
const publicRoute = source(publicRoutePath);
const publicCatalog = source(publicCatalogPath);
const adminUi = source(adminUiPath);
const data = source(dataPath);

includesAll("registry:append-only-public-asset-contract", registry, [
  'import "server-only"',
  "ManjuPublicAssetRecord",
  "MANJU_PUBLIC_ASSET_REGISTRY_PATH",
  "registerManjuPublicAsset",
  "updateManjuPublicAsset",
  "softDeleteManjuPublicAsset",
  "deletedAt",
  "publicPathFor",
  "manju-admin-upload",
]);
includesAll("admin-route:auth-upload-register-soft-delete", adminRoute, [
  "getTokenFromHeaders",
  "verifyAdminToken",
  'actor.role !== "admin"',
  "validateUploadBuffer",
  "storageManager.upload",
  "registerManjuPublicAsset",
  "resetPublicCatalogCache",
  "softDeleteManjuPublicAsset",
  "文件本体未硬删除",
]);
includesAll("public-route:controlled-public-proxy", publicRoute, [
  "getManjuPublicAssetByIdSync",
  "storageManager.getSignedUrl",
  "storageManager.read",
  "Cache-Control",
  "Accept-Ranges",
  "素材不存在或已下线",
]);
includesAll("public-catalog:admin-uploaded-assets-feed", publicCatalog, [
  "listManjuPublicAssetsSync",
  'origin: "admin-upload"',
  'source: "manju-admin-upload"',
  'ownerId: "manju-admin-upload"',
  "resetPublicCatalogCache",
  "[...uploadedAssets, ...catalog]",
]);
includesAll("admin-ui:upload-edit-delete-entry", adminUi, [
  'type EditorTab = "assets"',
  "上传/登记素材",
  "uploadAdminAsset",
  "updateAdminAsset",
  "deleteAdminAsset",
  "/api/admin/manju-workbench/assets",
  "保存素材信息",
  "下线素材",
]);
let parsedRegistry: { schemaVersion?: unknown; kind?: unknown; assets?: unknown } | null = null;
try {
  parsedRegistry = JSON.parse(data) as { schemaVersion?: unknown; kind?: unknown; assets?: unknown };
} catch {
  parsedRegistry = null;
}
add(
  "data-registry:append-only-data-contract",
  parsedRegistry?.schemaVersion === 1
    && parsedRegistry?.kind === "manju-public-assets"
    && Array.isArray(parsedRegistry?.assets),
  parsedRegistry
    ? `valid registry with ${Array.isArray(parsedRegistry.assets) ? parsedRegistry.assets.length : 0} append-only records`
    : "registry is not valid JSON",
);
excludesAll("admin-route:no-hard-delete", adminRoute, [
  "storageManager.delete",
  "unlinkSync",
  "rmSync",
]);

const failed = checks.filter((check) => !check.passed);
console.log(JSON.stringify({
  verifier: "manju-public-assets",
  ok: failed.length === 0,
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  checks,
  failed,
}, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}
