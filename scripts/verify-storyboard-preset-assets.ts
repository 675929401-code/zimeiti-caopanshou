import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StoryboardPresetError, STORYBOARD_PRESET_SETTING_KEY, isStoryboardPresetUrl } from "@/lib/storyboard-preset-assets";
import { inspectStoryboardPresetImage, listPublishedStoryboardPresets, loadStoryboardPresetCatalog, mutateStoryboardPresetCatalog, resolvePublishedStoryboardPresetReference, type StoryboardPresetDependencies } from "@/lib/server/storyboard-preset-store";

async function main() {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const state = { raw: null as string | null, writes: 0, copies: 0, signs: [] as string[], forceConflict: false, sourceUnavailable: false, readUnavailable: false };
  const owned = { id: assetId, user_id: "admin-a", storage_key: "roles/owned.png", storage_provider: "tencent_cos", file_category: "image", file_size: 100, content_type: "image/png" };
  const db = { from(table: string) {
    const filters = new Map<string, unknown>();
    let mode = "read";
    let payload: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.set(key, value); return builder; },
      update: (value: Record<string, unknown>) => { mode = "update"; payload = value; return builder; },
      insert: (value: Record<string, unknown>) => { mode = "insert"; payload = value; return builder; },
      maybeSingle: async () => {
        if (table === "user_files") {
          assert.equal(mode, "read");
          const matches = !state.sourceUnavailable && filters.get("id") === assetId && filters.get("user_id") === owned.user_id && filters.get("file_category") === "image";
          return { data: matches ? owned : null, error: null };
        }
        assert.equal(table, "platform_settings");
        assert.equal(filters.get("setting_key") ?? payload.setting_key, STORYBOARD_PRESET_SETTING_KEY);
        if (mode === "read") return { data: state.raw === null ? null : { setting_value: state.raw }, error: state.readUnavailable ? { code: "UNKNOWN" } : null };
        if (mode === "insert" && state.raw !== null) return { data: null, error: { code: "23505" } };
        if (state.forceConflict || (mode === "update" && filters.get("setting_value") !== state.raw)) return { data: null, error: null };
        state.raw = String(payload.setting_value);
        state.writes++;
        return { data: { setting_value: state.raw }, error: null };
      },
    };
    return builder;
  } } as unknown as SupabaseClient;
  const deps: StoryboardPresetDependencies = { db,
    sign: async (key) => { state.signs.push(key); return `https://signed.example.org/${key}`; },
    copySource: async (row, presetId, actorId) => {
      assert.equal(row.user_id, actorId);
      assert.equal(row.id, assetId);
      state.copies++;
      return { storageKey: `storyboard-presets/${presetId}/${"a".repeat(64)}/2026/10/16/${"a".repeat(64)}.png`, sha256: "a".repeat(64), mime: "image/png", width: 1536, height: 1024 };
    },
  };
  async function rejects(run: () => Promise<unknown>, code: string, status: number) {
    await assert.rejects(run, (error: unknown) => error instanceof StoryboardPresetError && error.code === code && error.status === status);
  }
  assert.deepEqual(await listPublishedStoryboardPresets({}, deps), { presets: [], count: 0, nextOffset: null, revision: 0 });
  assert.equal(state.writes, 0);
  const draft = { assetId, role: "pet" as const, name: "柯基三视图", tags: ["犬种"], customCategory: "狗狗", prompt: "正面侧面背面，同一只柯基。" };
  await rejects(() => mutateStoryboardPresetCatalog("admin-b", { action: "draft", expectedRevision: 0, draft }, deps), "PRESET_SOURCE_NOT_OWNED", 403);
  assert.equal(state.writes, 0);
  const created = await mutateStoryboardPresetCatalog("admin-a", { action: "draft", expectedRevision: 0, draft }, deps);
  const presetId = created.presetId;
  assert.equal(created.catalog.revision, 1);
  assert.equal(state.copies, 0, "saving draft must not publish or copy");
  assert.equal((await listPublishedStoryboardPresets({}, deps)).presets.length, 0);
  await rejects(() => mutateStoryboardPresetCatalog("admin-b", { action: "publish", expectedRevision: 1, presetId }, deps), "PRESET_SOURCE_NOT_OWNED", 403);
  state.sourceUnavailable = true;
  await rejects(() => mutateStoryboardPresetCatalog("admin-a", { action: "publish", expectedRevision: 1, presetId }, deps), "PRESET_SOURCE_NOT_OWNED", 403);
  state.sourceUnavailable = false;
  const published = await mutateStoryboardPresetCatalog("admin-a", { action: "publish", expectedRevision: 1, presetId }, deps);
  assert.equal(published.catalog.revision, 2);
  assert.equal(state.copies, 1);
  const writesBeforePublicRead = state.writes;
  const publicRead = await resolvePublishedStoryboardPresetReference({ presetId, revision: 1 }, deps);
  assert.deepEqual(Object.keys(publicRead).sort(), ["presetId", "revision", "role", "name", "tags", "customCategory", "prompt", "previewUrl"].sort());
  assert.doesNotMatch(JSON.stringify(publicRead), /admin-a|ownerId|assetId|recordId|storageKey|publishedBy/u);
  assert.equal(state.writes, writesBeforePublicRead);
  assert.equal((await listPublishedStoryboardPresets({ q: "柯基", role: "pet", limit: 1 }, deps)).count, 1);
  assert.equal((await listPublishedStoryboardPresets({ role: "character" }, deps)).count, 0);
  assert.equal((await listPublishedStoryboardPresets({ q: "不存在" }, deps)).count, 0);
  assert.equal((await listPublishedStoryboardPresets({ offset: 1 }, deps)).presets.length, 0);
  await rejects(() => resolvePublishedStoryboardPresetReference({ presetId, revision: 2 }, deps), "PRESET_VERSION_CHANGED", 409);
  await mutateStoryboardPresetCatalog("admin-a", { action: "draft", expectedRevision: 2, presetId, draft: { ...draft, name: "待审新名" } }, deps);
  assert.equal((await resolvePublishedStoryboardPresetReference({ presetId, revision: 1 }, deps)).name, "柯基三视图");
  const copiesBeforeStale = state.copies;
  await rejects(() => mutateStoryboardPresetCatalog("admin-a", { action: "publish", expectedRevision: 2, presetId }, deps), "PRESET_REVISION_CONFLICT", 409);
  assert.equal(state.copies, copiesBeforeStale);
  state.forceConflict = true;
  await rejects(() => mutateStoryboardPresetCatalog("admin-a", { action: "publish", expectedRevision: 3, presetId }, deps), "PRESET_REVISION_CONFLICT", 409);
  assert.equal((await loadStoryboardPresetCatalog(db)).catalog.revision, 3);
  state.forceConflict = false;
  await mutateStoryboardPresetCatalog("admin-a", { action: "disable", expectedRevision: 3, presetId }, deps);
  await rejects(() => resolvePublishedStoryboardPresetReference({ presetId, revision: 1 }, deps), "PRESET_NOT_AVAILABLE", 404);
  assert.equal((await listPublishedStoryboardPresets({}, deps)).count, 0);
  assert.equal((await loadStoryboardPresetCatalog(db)).catalog.audit.at(-1)?.action, "disable");
  await mutateStoryboardPresetCatalog("admin-a", { action: "publish", expectedRevision: 4, presetId }, deps);
  assert.equal((await resolvePublishedStoryboardPresetReference({ presetId, revision: 2 }, deps)).name, "待审新名");
  state.readUnavailable = true;
  const writesBeforeFailure = state.writes;
  await rejects(() => mutateStoryboardPresetCatalog("admin-a", { action: "disable", expectedRevision: 5, presetId }, deps), "PRESET_READ_UNAVAILABLE", 503);
  assert.equal(state.writes, writesBeforeFailure);
  state.readUnavailable = false;
  const preserved = state.raw;
  state.raw = "broken-json";
  await rejects(() => loadStoryboardPresetCatalog(db), "PRESET_CATALOG_INVALID", 503);
  state.raw = preserved;
  await rejects(() => mutateStoryboardPresetCatalog("admin-a", { action: "draft", expectedRevision: 5, draft: { ...draft, url: "https://private.invalid" } as typeof draft }, deps), "PRESET_INPUT_INVALID", 400);
  const image = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#acf" } }).png().toBuffer();
  const inspected = await inspectStoryboardPresetImage(image, "image/png");
  assert.equal(inspected.width, 64);
  assert.equal(inspected.height, 32);
  await rejects(() => inspectStoryboardPresetImage(image, "image/jpeg"), "PRESET_IMAGE_INVALID", 422);
  await rejects(() => inspectStoryboardPresetImage(Buffer.from("broken"), "image/png"), "PRESET_IMAGE_INVALID", 422);
  const adminRoute = readFileSync("src/app/api/admin/storyboard-presets/route.ts", "utf8");
  const userRoute = readFileSync("src/app/api/storyboard/presets/route.ts", "utf8");
  assert.match(adminRoute, /authorizeAdminCapability\(request, "platform\.settings\.manage"/u);
  assert.equal((adminRoute.match(/requireStepUp: true/gu) || []).length, 2);
  assert.match(userRoute, /withAuth\(request/u);
  assert.doesNotMatch(userRoute, /export async function (?:POST|PUT|DELETE)/u);
  for (const url of ["https://bucket.cos.example/storyboard-presets/preset-corgi/img.png?sign=x", "https://bucket.example/storyboard-presets%2Fpreset-corgi%2Fimg.png", "https://bucket.example/storyboard-presets%252Fpreset-corgi%252Fimg.png", "/api/storyboard/presets?presetId=preset-corgi&revision=1"]) assert.equal(isStoryboardPresetUrl(url), true, url);
  for (const url of ["https://bucket.example/roles/corgi.png", "https://bucket.example/not-storyboard-presets/img.png", null]) assert.equal(isStoryboardPresetUrl(url), false);
  console.log(JSON.stringify({ passed: true, zeroNetwork: true, zeroRealDatabaseWrites: true, ownershipAndPublishedIsolation: true, casAndFailurePaths: true, imageDecode: true }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
