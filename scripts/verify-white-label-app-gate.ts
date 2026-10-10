import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PlatformBrandingProvider,
  platformBrandLogoUrl,
  publicBrandingHostCacheKey,
  usePlatformBranding,
} from "../src/hooks/use-platform-branding";
import type { PlatformBrandPayload, PublicPlatformBranding } from "../src/lib/branding/contracts";
import {
  BrandAssetIntegrityError,
  readVerifiedBrandAssetUpstream,
  verifyBrandAssetBytes,
} from "../src/lib/server/brand-asset-upstream";
import {
  displayBrandOwnsAsset,
  resolveDisplayBrandWithReaders,
  type DisplayBrandReaders,
} from "../src/lib/server/white-label-runtime";
import { WhiteLabelHostError } from "../src/lib/white-label-host";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFile(path.join(root, relative), "utf8");
const revisionA = "11111111-1111-4111-8111-111111111111";
const revisionB = "22222222-2222-4222-8222-222222222222";
const assetA = "33333333-3333-4333-8333-333333333333";
const assetB = "44444444-4444-4444-8444-444444444444";
const emptySha = crypto.createHash("sha256").update(Buffer.alloc(1)).digest("hex");

function brand(name: string, assetId?: string): PlatformBrandPayload {
  return {
    schema: "platform-brand/v1",
    name,
    shortName: name.slice(0, 2),
    slogan: `${name}标语`,
    welcomeMessage: `欢迎来到${name}`,
    description: `${name}公开品牌快照`,
    seo: { title: `${name}首页`, description: `${name}描述` },
    colors: { primary: "#112233", accent: "#445566" },
    contact: { name: `${name}客服`, wechat: "", phone: "", email: "" },
    assetIds: assetId ? { logo_square: assetId } : {},
  };
}

function publishedRow(hostname: string, name: string, revisionId: string, assetId: string) {
  return {
    hostname,
    source: "white_label",
    generation: 1,
    revisionId,
    revisionVersion: 1,
    publishedAt: "2026-10-09T00:00:00.000Z",
    snapshot: brand(name, assetId),
    assets: {
      logo_square: {
        id: assetId,
        mimeType: "image/png",
        bytes: 1,
        width: 1,
        height: 1,
        sha256: emptySha,
      },
    },
  };
}

const platformSnapshot: PublicPlatformBranding = {
  source: "published",
  generation: 1,
  revisionId: "55555555-5555-4555-8555-555555555555",
  revisionVersion: 1,
  publishedAt: "2026-10-09T00:00:00.000Z",
  brand: brand("平台品牌"),
  assets: {},
};

function readers(mode: "ready" | "unknown" | "unavailable" = "ready"): DisplayBrandReaders {
  return {
    readPlatform: async () => platformSnapshot,
    readWhiteLabel: async (hostname) => {
      if (mode === "unavailable") return { data: null, error: { code: "08006" } };
      if (mode === "unknown") return { data: null, error: null };
      if (hostname === "a.customer.test") return { data: publishedRow(hostname, "租户A", revisionA, assetA), error: null };
      if (hostname === "b.customer.test") return { data: publishedRow(hostname, "租户B", revisionB, assetB), error: null };
      return { data: null, error: null };
    },
  };
}

async function main() {
const platform = await resolveDisplayBrandWithReaders("127.0.0.1:5000", readers());
const tenantA = await resolveDisplayBrandWithReaders("a.customer.test", readers());
const tenantB = await resolveDisplayBrandWithReaders("b.customer.test", readers());
assert.equal(platform.scope, "platform");
assert.equal(platform.branding.brand.name, "平台品牌");
assert.equal(tenantA.scope, "white_label");
assert.equal(tenantA.branding.displayScope, "white_label");
assert.equal(tenantA.branding.hostname, "a.customer.test");
assert.equal(tenantA.branding.brand.name, "租户A");
assert.equal(tenantB.branding.brand.name, "租户B");
assert.notEqual(publicBrandingHostCacheKey(tenantA.branding), publicBrandingHostCacheKey(tenantB.branding));

// Draft-only profiles and completely unknown hosts are deliberately identical
// at the public boundary: neither RPC result contains a published release.
for (const host of ["draft.customer.test", "unknown.customer.test"]) {
  await assert.rejects(
    resolveDisplayBrandWithReaders(host, readers("unknown")),
    (error: unknown) => error instanceof WhiteLabelHostError && error.status === 421,
  );
}
await assert.rejects(
  resolveDisplayBrandWithReaders("broken.customer.test", readers("unavailable")),
  (error: unknown) => error instanceof WhiteLabelHostError && error.status === 503,
);
await assert.rejects(
  resolveDisplayBrandWithReaders("good.test,evil.test", readers()),
  (error: unknown) => error instanceof WhiteLabelHostError && error.status === 400,
);

assert.equal(displayBrandOwnsAsset(tenantA, assetA), true);
assert.equal(displayBrandOwnsAsset(tenantA, assetB), false);
assert.equal(displayBrandOwnsAsset(tenantB, assetA), false);
assert.match(platformBrandLogoUrl(tenantA.branding, "square") || "", new RegExp(`${revisionA}.*&w=256$`, "u"));
const tenantWithoutLogo = { ...tenantA.branding, brand: brand("租户A"), assets: {} };
assert.equal(platformBrandLogoUrl(tenantWithoutLogo, "square"), undefined);

function FirstFrameName() {
  return createElement("strong", null, usePlatformBranding().brand.name);
}
assert.equal(
  renderToStaticMarkup(createElement(PlatformBrandingProvider, { initialBranding: tenantA.branding }, createElement(FirstFrameName))),
  "<strong>租户A</strong>",
);
assert.equal(
  renderToStaticMarkup(createElement(PlatformBrandingProvider, { initialBranding: tenantB.branding }, createElement(FirstFrameName))),
  "<strong>租户B</strong>",
);

const validBytes = Buffer.from("white-label-asset");
const validSha = crypto.createHash("sha256").update(validBytes).digest("hex");
assert.deepEqual(verifyBrandAssetBytes(validBytes, validBytes.byteLength, validSha), validBytes);
assert.throws(() => verifyBrandAssetBytes(validBytes, validBytes.byteLength + 1, validSha), BrandAssetIntegrityError);
assert.throws(() => verifyBrandAssetBytes(validBytes, validBytes.byteLength, "0".repeat(64)), BrandAssetIntegrityError);
assert.deepEqual(
  await readVerifiedBrandAssetUpstream(new Response(validBytes), validBytes.byteLength, validSha, 5 * 1024 * 1024),
  validBytes,
);
await assert.rejects(
  readVerifiedBrandAssetUpstream(new Response(validBytes), validBytes.byteLength - 1, validSha, 5 * 1024 * 1024),
  BrandAssetIntegrityError,
);

const [proxySource, layoutSource, brandingRouteSource, assetRouteSource, runtimeSource, hookSource, loginSource] = await Promise.all([
  source("src/proxy.ts"),
  source("src/app/layout.tsx"),
  source("src/app/api/branding/route.ts"),
  source("src/app/api/branding/assets/[id]/route.ts"),
  source("src/lib/server/white-label-runtime.ts"),
  source("src/hooks/use-platform-branding.ts"),
  source("src/components/login-form.tsx"),
]);

assert.ok(proxySource.indexOf("const directHost = request.headers.get(\"host\")") < proxySource.indexOf("if (isWhitelistedPath(pathname))"));
assert.doesNotMatch(proxySource, /headers\.get\(["']x-forwarded-host["']\)/iu);
assert.match(proxySource, /status: hostError\.status/u);
assert.match(proxySource, /"Cache-Control": "private, no-store"/u);
assert.match(proxySource, /Vary: "Host"/u);
assert.match(proxySource, /\(\?!_next\(\?:\/\|\$\)\)/u, "_next stays outside proxy matcher for HMR/static runtime compatibility");

assert.match(layoutSource, /await headers\(\)/u);
assert.match(layoutSource, /resolveDisplayBrand\(requestHeaders\.get\("host"\)\)/u);
assert.match(layoutSource, /PlatformBrandingProvider initialBranding=\{displayBrand\.branding\}/u);
assert.match(layoutSource, /data-display-brand-scope=\{displayBrand\.scope\}/u);
assert.match(brandingRouteSource, /Vary: "Host, Accept-Encoding"/u);
assert.doesNotMatch(brandingRouteSource, /headers\.get\(["']x-forwarded-host["']\)/iu);
assert.match(runtimeSource, /displayScope: "white_label"/u);
assert.match(runtimeSource, /displayScope: "platform"/u);
assert.match(runtimeSource, /Host is a display-brand selector only/u);

assert.match(assetRouteSource, /readVerifiedBrandAssetUpstream/u);
assert.match(assetRouteSource, /verifyBrandAssetBytes/u);
assert.match(assetRouteSource, /ETag: `"brand-\$\{cacheIdentity\}-sha256-\$\{asset\.sha256\}"`/u);
assert.match(assetRouteSource, /Vary: "Host, Accept-Encoding"/u);
assert.match(assetRouteSource, /max-age=31536000, immutable/u);
assert.match(assetRouteSource, /"Cache-Control": "private, no-store", Vary: "Host"/u);
assert.match(hookSource, /cacheByHost = new Map/u);
assert.match(hookSource, /branding\.displayScope === "white_label"/u);
assert.match(hookSource, /image\.hidden = true/u);
assert.doesNotMatch(loginSource, /Yuange1991xx/u);

console.log(JSON.stringify({
  status: "PASS",
  writes: 0,
  hosts: ["platform", "tenant-a", "tenant-b", "draft", "unknown", "malformed", "runtime-unavailable"],
  firstFrame: "server snapshot preserved",
  cache: "scope+hostname isolated",
  assets: "cross-host membership + bytes + sha256 + ETag/Vary",
  matcherBoundary: "_next excluded; document/API/static-extension requests gated",
}, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
