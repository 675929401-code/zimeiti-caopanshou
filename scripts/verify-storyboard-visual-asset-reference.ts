import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GeneratedImageReferenceError, resolveGeneratedImageReference, type GeneratedImageReferenceDependencies } from "@/lib/server/generated-image-reference";
import { parseVisualAssetQuery, parseVisualAssetLabels, queryVisualAssetLibrary, resolveStoryboardVisualAssetReference, visualAssetNamePattern } from "@/lib/server/storyboard-visual-asset-reference";

async function main() {
  const recordId = "a".repeat(64);
  const previewUrl = "https://images.example.org/reference.png";
  const reads: string[][] = [];
  const safeUrlChecks: string[] = [];
  let expired = false;
  const deps: GeneratedImageReferenceDependencies = {
    findOwned: async (id, owner) => {
      reads.push([id, owner]);
      return id === recordId && owner === "owner-a" ? {
        state: "completed", delivery_state: "delivered", response: { deliveryMode: "provider_url", providerUrl: previewUrl, ...(expired ? { sourceExpiredAt: "2026-10-16T00:00:00Z" } : {}) },
      } : null;
    },
    validateUrl: async (url) => { safeUrlChecks.push(url); },
  };
  const resolve: typeof resolveGeneratedImageReference = (input) => resolveGeneratedImageReference(input, deps);
  assert.deepEqual(await resolveStoryboardVisualAssetReference("owner-a", recordId, resolve), { reference: { recordId, previewUrl } });
  assert.deepEqual(reads, [[recordId, "owner-a"]]);
  assert.deepEqual(safeUrlChecks, [previewUrl]);
  await assert.rejects(() => resolveStoryboardVisualAssetReference("owner-b", recordId, resolve), (e: unknown) => e instanceof GeneratedImageReferenceError && e.status === 403);
  expired = true;
  await assert.rejects(() => resolveStoryboardVisualAssetReference("owner-a", recordId, resolve), (e: unknown) => e instanceof GeneratedImageReferenceError && e.code === "GENERATED_IMAGE_NOT_AVAILABLE");
  const countBeforeInvalid = reads.length;
  await assert.rejects(() => resolveStoryboardVisualAssetReference("owner-a", "not-a-record", resolve), (e: unknown) => e instanceof GeneratedImageReferenceError && e.status === 400);
  assert.equal(reads.length, countBeforeInvalid);
  assert.equal(safeUrlChecks.length, 1, "cross-account and expired records must not access provider URLs");
  assert.deepEqual(parseVisualAssetQuery(new URLSearchParams(`recordId=${recordId}`)), { recordId });
  for (const key of ["role", "q", "offset", "limit", "includeUnclassified"]) {
    assert.throws(() => parseVisualAssetQuery(new URLSearchParams(`recordId=${recordId}&${key}=`)), GeneratedImageReferenceError);
  }
  for (const query of ["recordId=invalid", "role=admin", "offset=-1", "limit=0", "limit=101", "offset=1.2", `q=${"x".repeat(121)}`]) {
    assert.throws(() => parseVisualAssetQuery(new URLSearchParams(query)), GeneratedImageReferenceError);
  }
  const defaults = parseVisualAssetQuery(new URLSearchParams());
  assert.deepEqual(defaults, { role: "", q: "", offset: 0, limit: 60, includeUnclassified: false });
  assert.equal(visualAssetNamePattern("a%_\\b"), "%a\\%\\_\\\\b%");

  // Exercise the exact production query builder. The fixture has only read methods;
  // any upload, update, generation or billing dependency is absent and would fail.
  const calls: Array<[string, ...unknown[]]> = [];
  const builder = Object.fromEntries(["select", "eq", "in", "or", "ilike", "order", "range"].map((method) => [method, (...args: unknown[]) => { calls.push([method, ...args]); return builder; }]));
  const db = { from: (table: string) => { assert.equal(table, "user_files"); return builder; } } as unknown as SupabaseClient;
  const parsed = parseVisualAssetQuery(new URLSearchParams("role=pet&q=柯基&offset=360&limit=20"));
  assert.ok(!("recordId" in parsed));
  queryVisualAssetLibrary(db, "owner-a", parsed);
  assert.deepEqual(calls.filter(([method]) => method === "eq"), [["eq", "user_id", "owner-a"], ["eq", "file_category", "image"], ["eq", "meta->storyboardVisualAsset->>role", "pet"]]);
  assert.deepEqual(calls.at(-1), ["range", 360, 379]);
  assert.ok(calls.findIndex(([method]) => method === "ilike") < calls.findIndex(([method]) => method === "range"));
  assert.ok(calls.some(([method, field]) => method === "in" && field === "meta->storyboardVisualAsset->>role"));
  assert.deepEqual(calls[0]?.[2], { count: "exact" });
  calls.length = 0;
  queryVisualAssetLibrary(db, "owner-b", { role: "character", q: "", offset: 0, limit: 60, includeUnclassified: true });
  assert.ok(calls.some(([method, field, value]) => method === "eq" && field === "user_id" && value === "owner-b"));
  assert.ok(calls.some(([method, condition]) => method === "or" && String(condition).includes("enabled.neq.false")), "disabled entries cannot be returned as characters");
  assert.deepEqual(parseVisualAssetLabels({ tags: [" 小型犬 ", "小型犬"], customCategory: "  宠物科普  " }), { tags: ["小型犬"], customCategory: "宠物科普" });
  for (const body of [{ tags: [null] }, { tags: [""] }, { tags: Array(13).fill("a") }, { tags: ["x".repeat(33)] }, { customCategory: "x".repeat(41) }]) assert.throws(() => parseVisualAssetLabels(body), GeneratedImageReferenceError);
  const source = readFileSync("src/app/api/storyboard/visual-assets/route.ts", "utf8");
  const getSource = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));
  assert.match(getSource, /resolveStoryboardVisualAssetReference\(user\.id, parsed\.recordId\)/u);
  assert.match(getSource, /queryVisualAssetLibrary\(db, user\.id, parsed\)/u);
  assert.doesNotMatch(getSource, /\.update\(|\.insert\(|upload|charge|generateImage/u);
  assert.match(source, /eq\("id", assetId\)\.eq\("user_id", user\.id\)\.eq\("file_category", "image"\)/u);
  console.log(JSON.stringify({ ok: true, scope: "owned generated references, metadata, filtered pagination; zero network, zero mutation" }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
