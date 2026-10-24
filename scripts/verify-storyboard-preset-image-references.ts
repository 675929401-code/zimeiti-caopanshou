import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ImageGenerationInputError, normalizeImageGenerationInput } from "@/lib/image-generation-request";
import { resolveStoryboardPresetImageReferences } from "@/lib/server/storyboard-preset-image-references";
import { resolvePublishedStoryboardPresetReference, type StoryboardPresetDependencies } from "@/lib/server/storyboard-preset-store";
import { STORYBOARD_PRESET_SETTING_KEY, StoryboardPresetError, type StoryboardPresetCatalog } from "@/lib/storyboard-preset-assets";
import { resolveCloudMediaRetentionRule } from "@/lib/media-retention-policy";

async function main() {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("ZERO_NETWORK_CONTRACT"); }) as typeof fetch;
  try {
    const presetId = "preset-corgi";
    const sha = "a".repeat(64);
    const key = `storyboard-presets/${presetId}/${sha}/2026/10/16/${sha}.png`;
    const cached = `https://bucket.cos.example/${key}?signature=expired`;
    const fresh = `https://bucket.cos.example/${key}?signature=fresh`;
    const manual = "https://manual.example.org/reference.png?manual=true";
    const privateOwned = "https://bucket.cos.example/roles/owned.png?signature=private";
    const descriptor = { presetId, revision: 1, referenceIndex: 1 };
    const base = { prompt: "同一只柯基的完整四宫格分镜", referenceImageUrls: [manual, cached, privateOwned], presetReferences: [descriptor] };
    const catalog: StoryboardPresetCatalog = {
      schema: "storyboard_preset_asset_catalog.v1", revision: 2, audit: [], entries: [{ presetId, disabled: false,
        published: { role: "pet", name: "柯基三视图", tags: ["犬种"], customCategory: "宠物", prompt: "三视图", revision: 1,
          storageKey: key, sha256: sha, mime: "image/png", width: 1536, height: 1024,
          publishedAt: "2026-10-16T00:00:00.000Z", publishedBy: "admin-private-owner" },
      }],
    };
    let signs = 0, upstream = 0, lookups = 0;
    const db = { from(table: string) {
      assert.equal(table, "platform_settings");
      const builder = { select: () => builder, eq: (field: string, value: string) => {
        assert.equal(field, "setting_key"); assert.equal(value, STORYBOARD_PRESET_SETTING_KEY); return builder;
      }, maybeSingle: async () => { lookups++; return { data: { setting_value: JSON.stringify(catalog) }, error: null }; } };
      return builder;
    } } as unknown as SupabaseClient;
    const deps: StoryboardPresetDependencies = { db, sign: async (storageKey) => { signs++; assert.equal(storageKey, key); return fresh; }, copySource: async () => { throw new Error("READ_MUST_NOT_COPY"); } };
    const resolver = (ref: { presetId: string; revision: number }) => resolvePublishedStoryboardPresetReference(ref, deps);
    async function submitFixture(raw: unknown) {
      const normalized = normalizeImageGenerationInput(raw);
      const references = await resolveStoryboardPresetImageReferences(normalized, resolver);
      upstream++;
      return { normalized, references };
    }
    const accepted = await submitFixture(base);
    assert.deepEqual(accepted.normalized.presetReferences, [descriptor]);
    assert.deepEqual(accepted.references, [manual, fresh, privateOwned]);
    assert.equal(accepted.references.length, base.referenceImageUrls.length, "fresh preset replaces its existing slot rather than adding a reference");
    assert.deepEqual(base.referenceImageUrls, [manual, cached, privateOwned], "caller references must remain immutable");
    assert.equal(signs, 1);
    assert.equal(upstream, 1);

    const invalidDescriptors: unknown[] = [null, "preset", {}, { ...descriptor, presetId: "private-asset-uuid" }, { ...descriptor, presetId: "preset-../private" },
      { ...descriptor, revision: 0 }, { ...descriptor, revision: -1 }, { ...descriptor, revision: "1" }, { ...descriptor, revision: 1.5 }, { ...descriptor, revision: Infinity },
      { ...descriptor, referenceIndex: -1 }, { ...descriptor, referenceIndex: 3 }, { ...descriptor, referenceIndex: "1" }, { ...descriptor, referenceIndex: 0.5 },
      { ...descriptor, url: cached }, { ...descriptor, ownerId: "other" },
    ];
    for (const ref of invalidDescriptors) {
      const prior: { upstream: number; lookups: number; signs: number } = { upstream, lookups, signs };
      await assert.rejects(() => submitFixture({ ...base, presetReferences: [ref] }), (error: unknown) => error instanceof ImageGenerationInputError && error.code === "IMAGE_PRESET_REFERENCE_INVALID");
      assert.deepEqual({ upstream, lookups, signs }, prior, "invalid descriptor must fail before resolver or upstream");
    }
    await assert.rejects(() => submitFixture({ ...base, presetReferences: [descriptor, descriptor] }), (error: unknown) => error instanceof ImageGenerationInputError && error.code === "IMAGE_PRESET_REFERENCE_INVALID");
    for (const url of [cached, `https://bucket.cos.example/storyboard-presets%2F${presetId}%2Fimage.png`]) {
      const before: number = upstream;
      await assert.rejects(() => submitFixture({ prompt: "fixture", referenceImageUrls: [url] }), (error: unknown) => error instanceof ImageGenerationInputError && error.code === "IMAGE_PRESET_REFERENCE_REQUIRED");
      assert.equal(upstream, before);
    }
    // A descriptor for one position cannot authorize another cached preset URL.
    await assert.rejects(() => submitFixture({ ...base, presetReferences: [{ ...descriptor, referenceIndex: 0 }] }), (error: unknown) => error instanceof ImageGenerationInputError && error.code === "IMAGE_PRESET_REFERENCE_REQUIRED");
    const beforeDisabled = { upstream, signs };
    catalog.entries[0].disabled = true;
    await assert.rejects(() => submitFixture(base), (error: unknown) => error instanceof StoryboardPresetError && error.code === "PRESET_NOT_AVAILABLE" && error.status === 404);
    assert.deepEqual({ upstream, signs }, beforeDisabled);
    catalog.entries[0].disabled = false;
    catalog.entries[0].published!.revision = 2;
    await assert.rejects(() => submitFixture(base), (error: unknown) => error instanceof StoryboardPresetError && error.code === "PRESET_VERSION_CHANGED" && error.status === 409);
    assert.deepEqual({ upstream, signs }, beforeDisabled);
    catalog.entries[0].published!.revision = 1;
    const beforeManualRead = { lookups, signs };
    const normal = await submitFixture({ prompt: "fixture", referenceImageUrls: [manual, privateOwned] });
    assert.deepEqual(normal.references, [manual, privateOwned]);
    assert.deepEqual({ lookups, signs }, beforeManualRead, "ordinary private/manual references must not invoke preset lookup");
    await assert.rejects(() => submitFixture({ ...base, referenceImageUrls: [manual, manual, cached], presetReferences: [{ ...descriptor, referenceIndex: 2 }] }), (error: unknown) => error instanceof ImageGenerationInputError && error.code === "IMAGE_PRESET_REFERENCE_INVALID", "URL deduplication must never leave an out-of-range preset index");

    // Provider adds the date path directly to prefix. Our prefix must therefore
    // end in slash, and the resulting permanent path must avoid finite rules.
    const storeSource = readFileSync("src/lib/server/storyboard-preset-store.ts", "utf8");
    const cosSource = readFileSync("src/storage/object/providers/tencent-cos.ts", "utf8");
    assert.ok(storeSource.includes("prefix: `storyboard-presets/${presetId}/${sha256}/`"));
    assert.ok(cosSource.includes("return `${prefix}${datePath}/${name}`"));
    assert.equal(resolveCloudMediaRetentionRule(key), null);
    assert.equal(resolveCloudMediaRetentionRule("image-workbench/2026/10/16/source.png")?.days, 30);
    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({ passed: true, invalidDescriptorCases: invalidDescriptors.length, zeroNetwork: true, disabledAndStaleBeforeUpstream: true, manualReferencesPreserved: true, presetReplacementKeepsReferenceCount: true, permanentPrefixExcludedFromFiniteSourceRules: true }));
  } finally { globalThis.fetch = originalFetch; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
