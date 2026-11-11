#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerA = "00000000-0000-4000-8000-000000000001", ownerB = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const source = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#349862" } }).png().toBuffer();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let owner = ownerA, authorized = true, storageReads = 0, fileSize = source.length, mutations = 0, externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error("Unexpected external I/O"); };
const mutate = () => { mutations += 1; throw new Error("Preview must never mutate storage/history"); };
const db = { from(table) {
  assert.equal(table, "user_files", "Preview must not query generation/history tables");
  const filters = [];
  const query = { select: () => query, eq: (key, value) => { filters.push([key, value]); return query; },
    insert: mutate, upsert: mutate, update: mutate, delete: mutate,
    maybeSingle: async () => {
      const row = { id: assetId, user_id: ownerA, storage_key: "fixture/source.png", storage_provider: "tencent_cos",
        file_category: "image", file_size: fileSize, content_type: "image/png" };
      return { error: null, data: filters.every(([key, value]) => row[key] === value) ? row : null };
    } };
  return query;
}, rpc: mutate };
const cache = new Map();
const allowed = new Set(["src/lib/cover-composition.ts", "src/lib/cover-composition-server.ts", "src/lib/cover-durable-attempt.ts",
  "src/lib/storyboard-annotation-layout.ts", "src/lib/server/cover-request-body.ts", "src/app/api/cover/preview/route.ts"]);
function load(relative) {
  relative = relative.replaceAll("\\", "/");
  if (cache.has(relative)) return cache.get(relative);
  assert.ok(allowed.has(relative), `Unexpected executable source ${relative}`);
  const module = { exports: {} }; cache.set(relative, module.exports);
  const imports = {
    sharp: { default: sharp }, "node:fs": { existsSync }, zod: { z },
    "@/lib/current-api-user": { authorizeCurrentApiUser: async () => authorized ? { ok: true, user: { id: owner, userId: owner } }
      : { ok: false, response: Response.json({ error: "fixture unauthorized" }, { status: 401 }) } },
    "@/storage/database/supabase-client": { getSupabaseClient: () => db },
    "@/storage/object": { storageManager: { upload: mutate, delete: mutate, getSignedUrl: forbidden,
      readBounded: async (key, maximumBytes, timeout, provider) => {
        assert.equal(key, "fixture/source.png"); assert.equal(maximumBytes, 25 * 1024 * 1024);
        assert.equal(timeout, 20_000); assert.equal(provider, "tencent_cos"); storageReads += 1; return source;
      } } },
  };
  const compiled = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), {
    fileName: relative, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Request, Response, console,
    fetch: forbidden,
    require(id) {
      if (Object.hasOwn(imports, id)) return imports[id];
      const resolved = id.startsWith("@/") ? `src/${id.slice(2)}.ts` : id.startsWith(".")
        ? `${path.posix.normalize(path.posix.join(path.posix.dirname(relative), id))}.ts` : id;
      return load(resolved);
    } }, { filename: relative });
  return module.exports;
}
const pure = load("src/lib/cover-composition.ts"), renderer = load("src/lib/cover-composition-server.ts");
const preview = load("src/app/api/cover/preview/route.ts");
const legacy = { title: "先做十分钟", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-fixture", animationStyleId: "pet-3d" };
const plan = { ...legacy, planVersion: 2, outputSpec: { aspectRatio: "3:4", ...pure.COVER_OUTPUT_SPECS["3:4"], format: "png", fit: "contain" },
  titleStyle: { x: 0.08, y: 0.08, width: 0.84, scale: 0.8, color: "#583A27" } };
const request = (body, declaredLength) => new Request("https://fixture.invalid/api/cover/preview", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "Content-Type": "application/json", ...(declaredLength === undefined ? {} : { "Content-Length": String(declaredLength) }) },
});
const checks = [];
for (const selectedPlan of [plan, legacy]) {
  const expected = await renderer.renderCoverComposition(source, selectedPlan);
  const response = await preview.POST(request({ sourceAssetId: assetId, plan: selectedPlan }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), hash(expected.bytes), "Preview must use the exact same glyph renderer and plan projection");
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, expected.width); assert.equal(metadata.height, expected.height);
  assert.equal(response.headers.get("x-cover-width"), String(expected.width));
}
checks.push("actual preview returns real PNG bytes identical to the shared renderer for V2 and legacy plans");
const beforeOwnership = storageReads;
owner = ownerB;
assert.equal((await preview.POST(request({ sourceAssetId: assetId, plan }))).status, 404);
owner = ownerA; authorized = false;
assert.equal((await preview.POST(request({ sourceAssetId: assetId, plan }))).status, 401);
authorized = true;
assert.equal(storageReads, beforeOwnership);
checks.push("cross-owner and unauthenticated previews fail before reading the owned source");
const oversized = JSON.stringify({ sourceAssetId: assetId, plan, extra: "x".repeat(50_001) });
assert.equal((await preview.POST(request(oversized, 1))).status, 413);
assert.equal((await preview.POST(request(oversized))).status, 413);
assert.equal(storageReads, beforeOwnership);
checks.push("actual preview body reader rejects false or absent Content-Length oversized streams before storage");
assert.equal((await preview.POST(request({ sourceAssetId: assetId, plan: { ...plan, titleStyle: { x: 0.9 } } }))).status, 422);
fileSize += 1;
assert.equal((await preview.POST(request({ sourceAssetId: assetId, plan }))).status, 502);
fileSize = source.length;
assert.equal(mutations, 0); assert.equal(externalCalls, 0);
checks.push("invalid title bounds and incomplete source reads fail; preview performs no history/wallet/storage mutation");
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: externalCalls, providerCalls: 0, liveDatabaseCalls: 0,
  mutations, evidence: "Actual preview POST, bounded body reader, plan projection and Sharp glyph renderer; auth/DB/object reads are fixtures", cases: checks }, null, 2));
