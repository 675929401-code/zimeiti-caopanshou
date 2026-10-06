import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import {
  parseStoryboardImageReadQuery,
  resolveOwnedStoryboardImageUrl,
  StoryboardImageReadError,
} from "@/lib/storyboard-image-read";

type Row = {
  id: string;
  user_id: string;
  storage_key: string;
  storage_provider: string;
  file_category: string;
};

const owned = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "owner-a",
  storage_key: "images/2026/09/16/storyboard.png",
  storage_provider: "tencent_cos",
  file_category: "image",
} satisfies Row;

function dbFixture(rows: Row[], error: unknown = null) {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    limit: async (count: number) => ({ data: rows.slice(0, count), error }),
  };
  return {
    db: { from: (table: string) => {
      assert.equal(table, "user_files");
      return builder;
    } } as unknown as SupabaseClient,
    filters,
  };
}

async function expectCode(run: () => Promise<unknown>, code: string, status: number) {
  await assert.rejects(run, (error: unknown) => (
    error instanceof StoryboardImageReadError
    && error.code === code
    && error.status === status
  ));
}

async function main() {
let assertions = 0;
{
  const parsed = parseStoryboardImageReadQuery(new NextRequest(
    `http://local.invalid/api/storyboard/image?storageKey=${encodeURIComponent(owned.storage_key)}&assetId=${owned.id}`,
  ));
  assert.deepEqual(parsed, { storageKey: owned.storage_key, assetId: owned.id });
  const assetOnly = parseStoryboardImageReadQuery(new NextRequest(
    `http://local.invalid/api/storyboard/image?assetId=${owned.id}`,
  ));
  assert.deepEqual(assetOnly, { storageKey: undefined, assetId: owned.id });
  for (const invalidUrl of [
    "http://local.invalid/api/storyboard/image",
    "http://local.invalid/api/storyboard/image?storageKey=images%2F..%2Fsecret.png",
    "http://local.invalid/api/storyboard/image?storageKey=https%3A%2F%2Fexample.invalid%2Fx.png",
    `http://local.invalid/api/storyboard/image?storageKey=${encodeURIComponent(owned.storage_key)}&assetId=invalid`,
  ]) {
    assert.throws(() => parseStoryboardImageReadQuery(new NextRequest(invalidUrl)), StoryboardImageReadError);
  }
  assertions += 6;
}
{
  const fixture = dbFixture([owned]);
  const signed: unknown[][] = [];
  const image = await resolveOwnedStoryboardImageUrl({
    db: fixture.db,
    userId: owned.user_id,
    storageKey: owned.storage_key,
    signer: { getSignedUrl: async (...args: unknown[]) => {
      signed.push(args);
      return "https://signed.invalid/storyboard.png";
    } } as never,
  });
  assert.deepEqual(image, {
    url: "https://signed.invalid/storyboard.png",
    assetId: owned.id,
    storageKey: owned.storage_key,
  });
  assert.deepEqual(fixture.filters, [
    ["user_id", owned.user_id],
    ["file_category", "image"],
    ["storage_key", owned.storage_key],
  ]);
  assert.deepEqual(signed, [[owned.storage_key, { expireTime: 900 }, owned.storage_provider]]);
  assertions += 3;
}

{
  const fixture = dbFixture([owned]);
  const image = await resolveOwnedStoryboardImageUrl({
    db: fixture.db,
    userId: owned.user_id,
    assetId: owned.id,
    signer: { getSignedUrl: async () => "https://signed.invalid/by-asset.png" } as never,
  });
  assert.equal(image.assetId, owned.id);
  assert.equal(image.storageKey, owned.storage_key);
  assert.deepEqual(fixture.filters, [
    ["user_id", owned.user_id],
    ["file_category", "image"],
    ["id", owned.id],
  ]);
  assertions += 3;
}

{
  const fixture = dbFixture([owned]);
  await resolveOwnedStoryboardImageUrl({
    db: fixture.db,
    userId: owned.user_id,
    storageKey: owned.storage_key,
    assetId: owned.id,
    signer: { getSignedUrl: async () => "https://signed.invalid/exact.png" } as never,
  });
  assert.deepEqual(fixture.filters.at(-1), ["id", owned.id]);
  assertions += 1;
}

for (const [name, row, code, status] of [
  ["cross-user", { ...owned, user_id: "owner-b" }, "IMAGE_NOT_FOUND", 404],
  ["wrong-category", { ...owned, file_category: "video" }, "IMAGE_NOT_FOUND", 404],
  ["unknown-provider", { ...owned, storage_provider: "unregistered" }, "INVALID_STORAGE_PROVIDER", 503],
] as const) {
  const fixture = dbFixture([row]);
  await expectCode(() => resolveOwnedStoryboardImageUrl({
    db: fixture.db,
    userId: owned.user_id,
    storageKey: owned.storage_key,
    signer: { getSignedUrl: async () => { throw new Error(`${name} must not sign`); } } as never,
  }), code, status);
  assertions += 1;
}

{
  const fixture = dbFixture([owned, { ...owned, id: "22222222-2222-4222-8222-222222222222" }]);
  await expectCode(() => resolveOwnedStoryboardImageUrl({
    db: fixture.db,
    userId: owned.user_id,
    storageKey: owned.storage_key,
    signer: { getSignedUrl: async () => "unused" } as never,
  }), "ASSET_ID_REQUIRED", 409);
  assertions += 1;
}

{
  const fixture = dbFixture([]);
  await expectCode(() => resolveOwnedStoryboardImageUrl({
    db: fixture.db,
    userId: owned.user_id,
    storageKey: owned.storage_key,
    signer: { getSignedUrl: async () => "unused" } as never,
  }), "IMAGE_NOT_FOUND", 404);
  assertions += 1;
}

const source = readFileSync("src/app/api/storyboard/image/route.ts", "utf8");
for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "/api/image/generate"]) {
  assert.equal(source.includes(forbidden), false, `read route must not contain ${forbidden}`);
  assertions += 1;
}
assert.match(source, /export async function GET/u);
assert.doesNotMatch(source, /export async function (?:POST|PUT|PATCH|DELETE)/u);
assert.match(source, /return response\(image\)/u);
assertions += 3;

console.log(JSON.stringify({
  passed: true,
  assertions,
  providerRequests: 0,
  databaseWrites: 0,
  route: "/api/storyboard/image",
}));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
