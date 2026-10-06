import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const [migration, authority, adminRoute, uploadRoute, adminPreviewRoute, publicRoute, publicAssetRoute, contracts, governance, panel] = await Promise.all([
  read("supabase/migrations/20261002120000_platform_brand_control_plane.sql"),
  read("src/lib/server/brand-authority.ts"),
  read("src/app/api/admin/branding/route.ts"),
  read("src/app/api/admin/branding/assets/route.ts"),
  read("src/app/api/admin/branding/assets/[id]/route.ts"),
  read("src/app/api/branding/route.ts"),
  read("src/app/api/branding/assets/[id]/route.ts"),
  read("src/lib/branding/contracts.ts"),
  read("src/lib/admin-governance.ts"),
  read("src/components/admin/platform-brand-settings-panel.tsx"),
]);

for (const table of [
  "platform_brand_profiles",
  "platform_brand_revisions",
  "platform_brand_assets",
  "platform_brand_revision_assets",
  "platform_brand_events",
]) {
  assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  assert.match(migration, new RegExp(`REVOKE ALL ON public\\.${table} FROM PUBLIC, anon, authenticated`));
}
assert.match(migration, /PLATFORM_BRAND_PUBLISHED_IMMUTABLE/u);
assert.match(migration, /PLATFORM_BRAND_PUBLISHED_ASSETS_IMMUTABLE/u);
assert.match(migration, /PLATFORM_BRAND_EVENT_IMMUTABLE/u);
assert.match(migration, /pg_advisory_xact_lock/u);
assert.match(migration, /v_profile\.generation <> p_expected_generation/u);
assert.match(migration, /rollback_target_id/u);
assert.match(migration, /'default', v_next_version, 'draft', v_target\.snapshot/u);
assert.match(migration, /SET published_revision_id = v_revision\.id,\s+draft_revision_id = NULL/gu);
assert.match(migration, /storage_key !~ '\[\?#\]'/u);
assert.match(migration, /snapshot - ARRAY\['schema', 'name'/u);
assert.match(migration, /PLATFORM_BRAND_SIGNED_URL_FORBIDDEN/u);
assert.match(migration, /platform_settings_reject_signed_brand_url/u);
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.read_published_platform_brand_asset\(uuid\) TO service_role/u);
assert.doesNotMatch(migration, /GRANT EXECUTE[^;]+(?:anon|authenticated)/u);

assert.match(adminRoute, /authorizeAdminCapability\(request, "brand\.settings\.manage"/u);
assert.match(adminRoute, /if \(action === "publish" \|\| action === "rollback"\)[\s\S]*requireStepUp: true/u);
assert.doesNotMatch(adminRoute, /operation: "platform_brand_write",\s*requireStepUp: true/u);
assert.match(adminRoute, /appendAdminGovernanceAudit/u);
assert.match(adminRoute, /appendPlatformBrandFailureEvent/u);
assert.match(adminRoute, /parseExpectedBrandGeneration/u);
assert.match(authority, /save_platform_brand_draft_atomic/u);
assert.match(authority, /publish_platform_brand_revision_atomic/u);
assert.match(authority, /rollback_platform_brand_revision_atomic/u);
assert.match(authority, /readLegacyPlatformBranding/u);
assert.match(authority, /stableLegacyBrandImageUrl/u);

assert.match(uploadRoute, /validateUploadBuffer/u);
assert.match(uploadRoute, /ACCEPTED_MIME_TYPES/u);
assert.match(uploadRoute, /limitInputPixels/u);
assert.match(uploadRoute, /createHash\("sha256"\)/u);
assert.match(uploadRoute, /userId: authorization\.actor\.userId/u);
assert.match(uploadRoute, /requireOwnershipRecord: true/u);
assert.match(uploadRoute, /registerPlatformBrandAsset/u);
assert.match(uploadRoute, /storageManager\.delete/u);
assert.match(adminPreviewRoute, /authorizeAdminCapability\(request, "brand\.settings\.manage"/u);
assert.match(adminPreviewRoute, /readAdminPlatformBrandAsset/u);
assert.match(adminPreviewRoute, /"Cache-Control": "private, no-store"/u);
assert.match(authority, /export async function readAdminPlatformBrandAsset/u);
assert.match(governance, /pathname\.startsWith\("\/api\/admin\/branding\/assets"\)[\s\S]*requireStepUp: write/u);
assert.match(governance, /pathname === "\/api\/admin\/branding"[\s\S]*requireStepUp: false/u);
assert.match(panel, /\/api\/admin\/branding\/assets\/\$\{assetId\}/u);
assert.match(panel, /brand-advanced-assets/u);
assert.match(panel, /使用主 Logo 自动适配/u);
assert.equal((panel.match(/data-testid="brand-actions-sticky"/gu) || []).length, 1);
assert.doesNotMatch(panel, /brand-actions-bottom/u);

assert.match(publicRoute, /readPublishedPlatformBranding/u);
assert.match(publicAssetRoute, /readPublishedPlatformBrandAsset/u);
assert.match(publicAssetRoute, /new NextResponse\(upstream\.body/u);
assert.match(publicAssetRoute, /Cross-Origin-Resource-Policy/u);
assert.match(migration, /JOIN public\.platform_brand_revisions revision\s+ON revision\.id = profile\.published_revision_id AND revision\.status = 'published'/u);
assert.doesNotMatch(publicRoute, /storageKey|storage_provider|signedUrl/u);
assert.match(contracts, /BRAND_FIELD_UNKNOWN/u);
assert.match(contracts, /suspicious/u);

console.log("platform branding control-plane static verification passed");
