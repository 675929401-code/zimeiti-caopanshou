import assert from "node:assert/strict";
import test from "node:test";
import { readNativeMainMedia, readNativeMediaSource, nativeOwnedImageInput, resolveNativeAiImageInput } from "../src/lib/server/native-main-media";
import { nativeMainMediaPath } from "../src/lib/native-main-media-contract";

type Row = Record<string, unknown>;
type DB = Parameters<typeof readNativeMainMedia>[0];
const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = uuid(1), other = uuid(2), assetId = uuid(3);
const originalFetch = globalThis.fetch;
let networkCalls = 0;
test.before(() => { globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN_IN_MEDIA_TEST"); }; });
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0); });

function fixture() {
  const tables: Record<string, Row[]> = {
    image_generation_requests: [{ user_id: owner, record_id: "image-fixture:01", state: "completed", delivery_state: "delivered", response: { deliveryMode: "provider_url", providerUrl: "https://delivery.example.com/owner.png", contentType: "image/png", size: 2034, width: 960, height: 1280 } }],
    user_files: [{ id: assetId, user_id: owner, content_type: "image/jpeg", file_name: "owner-image.jpg", file_size: 900, metadata: { width: 800, height: 600 }, storage_provider: "local", storage_key: "owner/private.jpg" }],
    video_tasks: [{ id: "video-fixture:01", user_id: owner, status: "completed", duration_seconds: 8, file_size: 4400 }],
    pub3_assets: [{ id: uuid(4), owner_id: owner, state: "ready", file_name: "official.png", mime: "image/png", size: 300, connection_id: "fixture-namespace", local_media_id: uuid(5), sha256: "a".repeat(64), metadata: { width: 800, height: 600 } }],
  };
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  let dbError: unknown = null, ignoreFilters = false;
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const query = {
        select() { return query; },
        eq(key: string, value: unknown) { filters.push([key, value]); return query; },
        async maybeSingle() {
          reads.push({ table, filters: [...filters] });
          return { data: dbError ? null : structuredClone((tables[table] ?? []).find(row => ignoreFilters || filters.every(([key, value]) => row[key] === value)) ?? null), error: dbError };
        },
      };
      return query;
    },
  } as unknown as DB;
  return { db, tables, reads, fail: (error: unknown) => { dbError = error; }, ignoreFilters: () => { ignoreFilters = true; } };
}
const code = (expected: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;

test("main image facts use the owner ledger and return stable private paths without provider access", async () => {
  const f = fixture(), reference = { kind: "image_record", id: "image-fixture:01" } as const;
  const actual = await readNativeMediaSource(f.db, owner, { kind: "main_asset", reference });
  assert.deepEqual(actual, { source: { kind: "main_asset", reference }, contentPath: nativeMainMediaPath(reference), fileName: "image_record-image-fixture:01.png", mime: "image/png", size: 2034, width: 960, height: 1280, connectionCurrent: true });
  assert.deepEqual(f.reads, [{ table: "image_generation_requests", filters: [["user_id", owner], ["record_id", reference.id]] }]);
  assert.equal(JSON.stringify(actual).includes("providerUrl"), false);
  assert.equal(JSON.stringify(actual).includes("delivery.example"), false);
});

test("asset and completed video metadata are read without uploading, exporting or changing the original records", async () => {
  const f = fixture(), before = structuredClone(f.tables);
  const image = await readNativeMainMedia(f.db, owner, { kind: "image_asset", id: assetId });
  assert.equal(image.fileName, "owner-image.jpg"); assert.equal(image.mime, "image/jpeg"); assert.equal(image.width, 800);
  const video = await readNativeMainMedia(f.db, owner, { kind: "video_task", id: "video-fixture:01" });
  assert.equal(video.duration, 8); assert.equal(video.mime, "video/mp4"); assert.equal(video.contentPath, "/api/video/storage/video-fixture%3A01");
  assert.deepEqual(f.tables, before);
});

test("cross-owner and mismatched ledger receipts fail closed even if a faulty DB adapter ignores filters", async () => {
  const f = fixture();
  await assert.rejects(readNativeMainMedia(f.db, other, { kind: "image_asset", id: assetId }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
  f.ignoreFilters();
  await assert.rejects(readNativeMainMedia(f.db, other, { kind: "image_asset", id: assetId }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
  await assert.rejects(readNativeMainMedia(f.db, owner, { kind: "image_asset", id: uuid(90) }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
});

test("missing owner media differs from unavailable database evidence", async () => {
  const f = fixture();
  await assert.rejects(readNativeMainMedia(f.db, owner, { kind: "image_record", id: "not-found" }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
  f.fail({ code: "08006", message: "fixture connection lost" });
  await assert.rejects(readNativeMainMedia(f.db, owner, { kind: "image_record", id: "image-fixture:01" }), code("NATIVE_MAIN_MEDIA_LOOKUP_UNAVAILABLE"));
});

test("incomplete, expired and non-image source facts are not promoted to usable media", async () => {
  for (const change of [{ state: "processing" }, { delivery_state: "pending" }, { response: { deliveryMode: "base64" } }, { response: { deliveryMode: "provider_url", sourceExpiredAt: "2026-01-01" } }]) {
    const f = fixture(); Object.assign(f.tables.image_generation_requests[0], change);
    await assert.rejects(readNativeMainMedia(f.db, owner, { kind: "image_record", id: "image-fixture:01" }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
  }
  for (const change of [{ status: "processing" }, { source_expired_at: "2026-01-01" }]) {
    const f = fixture(); Object.assign(f.tables.video_tasks[0], change);
    await assert.rejects(readNativeMainMedia(f.db, owner, { kind: "video_task", id: "video-fixture:01" }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
  }
  const f = fixture(); f.tables.user_files[0].content_type = "text/html";
  await assert.rejects(readNativeMainMedia(f.db, owner, { kind: "image_asset", id: assetId }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
});

test("opaque image resolution accepts only owner delivered image refs and keeps the access URL out of the reference", async () => {
  const f = fixture(), reference = { kind: "image_record", id: "image-fixture:01" } as const;
  const opaque = nativeOwnedImageInput(reference);
  assert.equal(opaque, "native-owned-image://image_record/image-fixture:01");
  assert.equal(await resolveNativeAiImageInput(f.db, owner, opaque), "https://delivery.example.com/owner.png");
  assert.equal(opaque.includes("https"), false);
  for (const value of ["https://outside.invalid/p.png", "data:image/png;base64,AA", "native-owned-image://video_task/video-fixture:01", `${opaque}?signature=fixture`, `${opaque}#x`]) {
    await assert.rejects(resolveNativeAiImageInput(f.db, owner, value));
  }
  assert.throws(() => nativeOwnedImageInput({ kind: "video_task", id: "video-fixture:01" }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
});

test("unsafe receipt URLs and non-cloud assets fail before any HTTP or storage operation", async () => {
  const credentialUrl = new URL("https://outside.invalid/file");
  credentialUrl.username = "fixture-user"; credentialUrl.password = "fixture-password";
  for (const providerUrl of ["http://outside.invalid/file", "https://127.0.0.1/file", credentialUrl.href, "javascript:alert(1)"]) {
    const f = fixture(); (f.tables.image_generation_requests[0].response as Row).providerUrl = providerUrl;
    await assert.rejects(resolveNativeAiImageInput(f.db, owner, "native-owned-image://image_record/image-fixture:01"), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
  }
  const f = fixture();
  await assert.rejects(resolveNativeAiImageInput(f.db, owner, nativeOwnedImageInput({ kind: "image_asset", id: assetId })), code("NATIVE_REFERENCE_PROVIDER_UNAVAILABLE"));
});

test("provider media readiness keeps actual local ID/hash and compares a fixture namespace without reading configuration", async () => {
  const f = fixture(); let configurationReads = 0;
  const configuration = () => { configurationReads++; return { namespace: "fixture-namespace" }; };
  const source = { kind: "provider_asset", assetId: uuid(4) } as const;
  const actual = await readNativeMediaSource(f.db, owner, source, { configuration });
  assert.equal(actual.connectionCurrent, true); assert.equal(actual.localMediaId, uuid(5)); assert.equal(actual.hash, "a".repeat(64));
  assert.equal(configurationReads, 1);
  const oldConnection = await readNativeMediaSource(f.db, owner, source, { configuration: () => ({ namespace: "new-fixture-namespace" }) });
  assert.equal(oldConnection.connectionCurrent, false);
  f.tables.pub3_assets[0].state = "uploaded";
  await assert.rejects(readNativeMediaSource(f.db, owner, source, { configuration }), code("NATIVE_MAIN_MEDIA_UNAVAILABLE"));
  assert.equal(configurationReads, 1);
});

test("main references never consult the optional provider namespace callback", async () => {
  const f = fixture();
  const actual = await readNativeMediaSource(f.db, owner, { kind: "main_asset", reference: { kind: "image_record", id: "image-fixture:01" } }, { configuration: () => { throw new Error("PROVIDER_CONFIGURATION_FORBIDDEN_FOR_MAIN_MEDIA"); } });
  assert.equal(actual.connectionCurrent, true); assert.equal(actual.source.kind, "main_asset");
});
