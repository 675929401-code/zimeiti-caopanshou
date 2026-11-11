#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

// Execute both actual route handlers. Authentication, DB, object storage and
// cover artwork are in-memory fixtures; image parsing/validation and the
// persist admission gate remain the real implementations. No service is read.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let networkCalls = 0;
const unexpectedIO = () => { networkCalls += 1; throw new Error("Unexpected external I/O"); };
function load(relative, imports = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    fileName: relative, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, Buffer, URL, Request, Response, console,
    fetch: unexpectedIO,
    require(id) { assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`); return imports[id]; },
  }, { filename: relative });
  return module.exports;
}

const fixtureUserId = "00000000-0000-4000-8000-000000000001";
const backgroundId = "00000000-0000-4000-8000-000000000002";
const resultId = "00000000-0000-4000-8000-000000000003";
const bytes = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#eeeeee" } }).png().toBuffer();
const files = [{ id: backgroundId, user_id: fixtureUserId, storage_key: "fixture/background.png",
  storage_provider: "tencent_cos", file_category: "image", content_type: "image/png", file_size: bytes.length }];
let uploadCalls = 0;
let compositionRecords = 0;
const db = {
  from(table) {
    const filters = [];
    const query = {
      select() { return query; },
      eq(field, value) { filters.push([field, value]); return query; },
      order() { return query; },
      limit() { return query; },
      async maybeSingle() {
        assert.equal(table, "user_files");
        const data = files.find(row => filters.every(([field, value]) => {
          const actual = field.startsWith("meta->>") ? row.meta?.[field.slice(7)] : row[field];
          return actual === value;
        })) || null;
        return { data, error: null };
      },
      async upsert() {
        assert.ok(["conversations", "conversation_messages"].includes(table));
        return { error: null };
      },
    };
    return query;
  },
  async rpc(name, input) {
    assert.equal(name, "record_cover_composition");
    assert.equal(input.p_user_id, fixtureUserId);
    assert.equal(input.p_background_asset_id, backgroundId);
    assert.equal(input.p_asset_id, resultId);
    compositionRecords += 1;
    return { data: { asset_id: resultId, task_no: 1, created_at: "2026-11-06T00:00:00.000Z" }, error: null };
  },
};
const storage = {
  async read(key, provider) {
    assert.equal(key, "fixture/background.png"); assert.equal(provider, "tencent_cos"); return bytes;
  },
  async exists(key, provider) {
    return provider === "tencent_cos" && files.some(file => file.storage_key === key);
  },
  async upload(buffer, key, contentType, options) {
    assert.deepEqual(buffer, bytes);
    assert.equal(options.providerType, "tencent_cos");
    assert.equal(options.strictProvider, true);
    assert.equal(options.requireOwnershipRecord, true);
    uploadCalls += 1;
    files.push({ id: resultId, user_id: fixtureUserId, storage_key: key, storage_provider: "tencent_cos",
      file_category: "image", content_type: contentType, file_size: buffer.length,
      source: options.source, meta: options.meta, created_at: "2026-11-06T00:00:00.000Z" });
    return { key, provider: "tencent_cos", contentType, size: buffer.length };
  },
  async getSignedUrl(key, _options, provider) {
    assert.equal(provider, "tencent_cos");
    return `https://fixture.invalid/${key}`;
  },
};
const commonImports = {
  "next/server": { NextRequest: Request, NextResponse: { json: (body, init) => Response.json(body, init) } },
  "node:crypto": { createHash },
  "@/lib/current-api-user": { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: fixtureUserId } }) },
  "@/storage/database/supabase-client": { getSupabaseClient: () => db },
  "@/storage/object": { storageManager: storage },
};
const persist = load("src/app/api/image-workbench/persist/route.ts", {
  ...commonImports,
  sharp: { default: sharp },
  "@/lib/image-data-url": load("src/lib/image-data-url.ts"),
  "@/lib/image-file-validation": load("src/lib/image-file-validation.ts", { "node:zlib": { inflateSync } }),
  "@/lib/server/storyboard-chain-reference": { StoryboardChainReferenceError: class extends Error {}, verifyStoryboardChainOriginalExport: unexpectedIO },
  "@/lib/safe-fetch": { SafeFetchError: class extends Error {} },
  "@/lib/image-result-network": { readPublicImageResult: unexpectedIO },
  "@/lib/autodl-h3-selfhost": { AUTODL_H3_SELFHOST_PROVIDER: "fixture", autodlH3SelfhostGatewayOrigin: unexpectedIO, readAutodlH3SelfhostResult: unexpectedIO },
  "@/lib/autodl-h3-assets": { parseAutodlH3AssetRef: unexpectedIO, stabilizeAutodlH3InputAssets: unexpectedIO },
  "@/lib/image-output-contract": { cropDimensionsForAspectRatio: unexpectedIO, imageDimensionsMatchAspectRatio: unexpectedIO },
});
const captured = [];
const render = load("src/app/api/cover/render/route.ts", {
  ...commonImports,
  zod: { z },
  "@/lib/cover-composition": load("src/lib/cover-composition.ts"),
  "@/lib/auth": { getTokenFromHeaders: () => "fixture-only" },
  "@/lib/cover-composition-server": {
    COVER_COMPOSITION_VERSION: "cover-composition-v2",
    coverCompositionFont: () => ({ path: "fixture", family: "fixture" }),
    renderCoverComposition: async (_source, plan) => ({ bytes, width: 300, height: 400,
      sourceWidth: 300, sourceHeight: 400, renderedText: { title: plan.title, subtitle: plan.subtitle }, compositionProfile: "story-cartoon" }),
  },
  "@/app/api/image-workbench/persist/route": { POST: async request => {
    captured.push(await request.clone().json());
    return persist.POST(request);
  } },
});
const requestFor = (route, body) => {
  const serialized = JSON.stringify(body);
  return new Request(`https://fixture.invalid${route}`, { method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(serialized)) }, body: serialized });
};
const plan = { title: "先做十分钟", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-fixture", animationStyleId: "pet-3d" };
const checks = [];
const first = await render.POST(requestFor("/api/cover/render", { sourceAssetId: backgroundId, plan }));
const firstBody = await first.json();
assert.equal(first.status, 200, `First composition save: ${JSON.stringify(firstBody)}`);
assert.equal(firstBody.persisted, true);
assert.equal(firstBody.assetId, resultId);
assert.equal(captured[0].intent, "user_asset_export");
assert.equal(captured[0].url, `data:image/png;base64,${bytes.toString("base64")}`);
assert.equal(captured[0].storageKey, undefined);
assert.equal(uploadCalls, 1);
checks.push("actual render POST sends explicit export intent and first data URL passes actual persist POST");

const reused = await render.POST(requestFor("/api/cover/render", { sourceAssetId: backgroundId, plan }));
const reusedBody = await reused.json();
assert.equal(reused.status, 200);
assert.equal(reusedBody.reused, true);
assert.equal(reusedBody.assetId, resultId);
assert.equal(captured[1].assetId, resultId);
assert.equal(captured[1].storageKey, files[1].storage_key);
assert.equal(captured[1].url, undefined);
assert.equal(captured[0].clientTraceId, captured[1].clientTraceId);
assert.equal(uploadCalls, 1);
assert.equal(compositionRecords, 2);
checks.push("actual render replay reuses the existing owned asset and trace without a second upload");

const missingIntent = { ...captured[0] };
delete missingIntent.intent;
const rejected = await persist.POST(requestFor("/api/image-workbench/persist", missingIntent));
assert.equal(rejected.status, 422);
assert.equal((await rejected.json()).code, "IMAGE_EXPLICIT_EXPORT_REQUIRED");
assert.equal(uploadCalls, 1);
checks.push("actual shared persist gate still rejects implicit data URL export before storage");

const oldReuse = { ...captured[1] };
delete oldReuse.intent;
const accepted = await persist.POST(requestFor("/api/image-workbench/persist", oldReuse));
assert.equal(accepted.status, 200);
assert.equal((await accepted.json()).reused, true);
assert.equal(uploadCalls, 1);
assert.equal(networkCalls, 0);
checks.push("existing owned-asset reuse remains admitted without adding a new intent requirement");
console.log(JSON.stringify({ passed: true, assertions: checks.length, networkCalls, providerCalls: 0, databaseCalls: 0,
  evidenceLevel: "Actual render/persist handlers with in-memory authentication, DB, storage and compositor fixtures; real image parsing/validation", checks }, null, 2));
