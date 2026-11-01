import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readOwnedImageReference, OWNED_REFERENCE_MAX_BYTES, OWNED_REFERENCE_TIMEOUT_MS } from "../src/lib/server/image-owned-reference";
import { validateUploadBuffer } from "../src/lib/file-upload-security";

async function main() {
  let checks = 0;
  const check = async (name: string, run: () => unknown | Promise<unknown>) => { await run(); checks++; console.log(`PASS ${name}`); };
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=", "base64");
  const key = "images/2026/10/16/fixture.png";
  const row = { id: "fixture-id", user_id: "owner", storage_key: key, storage_provider: "tencent_cos", file_category: "image", file_size: bytes.length, content_type: "image/png" };
  const syntheticSignedUrl = (signature: string, time: string) => {
    const value = new URL(key, "https://bucket.cos.example/");
    value.search = new URLSearchParams({ "q-signature": signature, "q-sign-time": time }).toString();
    return value.href;
  };
  const url = syntheticSignedUrl("fixture-old", "1");
  let rows = [row];
  let databaseError = false;
  let reads = 0;
  let signs = 0;
  let external = 0;
  let readError = "";
  let output = bytes;
  let signed = syntheticSignedUrl("fixture-new", "2");
  const filters: Array<[string, unknown]> = [];
  const db = { from(table: string) {
    assert.equal(table, "user_files"); filters.length = 0;
    const query = { select() { return query; }, eq(field: string, value: unknown) { filters.push([field, value]); return query; }, async limit(count: number) {
      assert.equal(count, 2);
      return { data: rows.filter((entry) => filters.every(([field, value]) => entry[field as keyof typeof row] === value)).slice(0, count), error: databaseError ? { code: "fixture" } : null };
    } }; return query;
  } } as unknown as SupabaseClient;
  const storage = {
    async getSignedUrl(actualKey: string, options: { expireTime: number }, provider: string) { signs++; assert.equal(actualKey, key); assert.equal(provider, "tencent_cos"); assert.equal(options.expireTime, 120); return signed; },
    async readBounded(actualKey: string, max: number, timeout: number, provider: string) { reads++; assert.equal(actualKey, key); assert.equal(provider, "tencent_cos"); assert.equal(max, OWNED_REFERENCE_MAX_BYTES); assert.equal(timeout, OWNED_REFERENCE_TIMEOUT_MS); if (readError) throw new Error(readError); return output; },
  };
  const read = (value = url, userId = "owner") => readOwnedImageReference({ db, userId, url: value, storage });
  await check("same owner, fresh signature and configured bucket read original exact bytes", async () => {
    const result = await read(); assert.ok(result); assert.equal(reads, 1); assert.equal(result.contentType, "image/png"); assert.equal(createHash("sha256").update(result.buffer).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
  });
  await check("query binds current actor, image category and precise key", () => assert.deepEqual(filters, [["user_id", "owner"], ["storage_key", key], ["file_category", "image"]]));
  await check("cross actor obtains no SDK read or signer authority", async () => { const prior = [reads, signs]; assert.equal(await read(url, "other-owner"), null); assert.deepEqual([reads, signs], prior); });
  await check("duplicate owner records fail closed", async () => { rows = [row, { ...row, id: "duplicate" }]; await assert.rejects(read, /AMBIGUOUS/u); rows = [row]; });
  await check("DB outage never falls through to an owned SDK read", async () => { databaseError = true; const prior = reads; await assert.rejects(read, /LOOKUP_UNAVAILABLE/u); assert.equal(reads, prior); databaseError = false; });
  await check("origin spoof and suffix spoof never gain SDK authority", async () => { const prior = reads; assert.equal(await read(url.replace("bucket.cos.example", "bucket.cos.example.evil.test")), null); assert.equal(reads, prior); });
  await check("server signer path mismatch never gains SDK authority", async () => { const prior = reads; signed = `https://bucket.cos.example/other.png`; assert.equal(await read(), null); assert.equal(reads, prior); signed = url; });
  await check("image transform parameters cannot silently read original bytes", async () => { const prior = reads; await assert.rejects(() => read(`${url}&imageMogr2=thumbnail/10x10`), /TRANSFORM/u); assert.equal(reads, prior); });
  await check("response overrides and duplicate signature parameters rejected", async () => { await assert.rejects(() => read(`${url}&response-content-type=image/jpeg`), /TRANSFORM/u); const duplicate = new URL(url); duplicate.searchParams.append("q-signature", "fixture-second"); await assert.rejects(() => read(duplicate.href), /TRANSFORM/u); });
  await check("ambiguous encoded path, dot segments, credentials, port and fragments never gain SDK authority", async () => {
    const prior = reads;
    const credentialUrl = new URL(url); credentialUrl.username = "fixture-user"; credentialUrl.password = "fixture-password";
    for (const bad of [url.replace("images/", "images%2f"), url.replace("fixture.png", "%252e%252e"), url.replace("/images/", "/a/../images/"), credentialUrl.href, url.replace(".example/", ".example:444/"), `${url}#fragment`]) assert.equal(await read(bad), null);
    assert.equal(reads, prior);
  });
  await check("unimplemented storage provider retains external safety path", async () => { rows = [{ ...row, storage_provider: "local" }]; const prior = reads; assert.equal(await read(), null); assert.equal(reads, prior); rows = [row]; });
  await check("known oversize metadata rejected before bytes", async () => { rows = [{ ...row, file_size: OWNED_REFERENCE_MAX_BYTES + 1 }]; const prior = reads; await assert.rejects(read, /TOO_LARGE/u); assert.equal(reads, prior); rows = [row]; });
  await check("bounded SDK timeout propagates without URL fallback", async () => { readError = "STORAGE_READ_TIMEOUT"; await assert.rejects(read, /STORAGE_READ_TIMEOUT/u); readError = ""; });
  await check("bounded contract checked again if a provider misbehaves", async () => { output = Buffer.alloc(OWNED_REFERENCE_MAX_BYTES + 1); await assert.rejects(read, /TOO_LARGE/u); output = bytes; });

  // Execute the actual route loader, not a mirrored implementation. The VM has
  // controlled IO only; no route import, auth, database or network side effects.
  const source = readFileSync("src/app/api/image/generate/route.ts", "utf8");
  const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const loader = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "loadReferenceImage");
  assert.ok(loader);
  const code = ts.transpileModule(`${loader.getText(ast)}\nglobalThis.actualLoader=loadReferenceImage;`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const sandbox = { Buffer, Blob, Uint8Array, readOwnedImageReference, getSupabaseClient: () => db, storageManager: storage, validateUploadBuffer, safeFetch: async (value: string, options: { maxBytes: number; maxRedirects: number; timeoutMs: number; allowedContentTypes: string[] }) => {
    external++; assert.equal(value, "https://external.example/reference.png"); assert.deepEqual(JSON.parse(JSON.stringify(options)), { timeoutMs: 20_000, maxBytes: 20 * 1024 * 1024, maxRedirects: 3, allowedContentTypes: ["image/*"] }); return { buffer: bytes, contentType: "image/png" };
  }, actualLoader: undefined as unknown as (value: string, actor: string) => Promise<{ blob: Blob; dataUrl: string; byteLength: number }> };
  vm.runInNewContext(code, sandbox);
  await check("actual route loader uses owned bytes without safeFetch and preserves SHA", async () => { const result = await sandbox.actualLoader(url, "owner"); assert.equal(external, 0); assert.equal(result.byteLength, bytes.length); assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes); });
  await check("actual external reference keeps all existing safeFetch restrictions", async () => { await sandbox.actualLoader("https://external.example/reference.png", "owner"); assert.equal(external, 1); });
  await check("actual loader validates MIME bytes before provider dispatch", async () => { output = Buffer.from("not an image"); await assert.rejects(() => sandbox.actualLoader(url, "owner")); assert.equal(external, 1); output = bytes; });
  await check("actual owned read failure cannot retry with external URL", async () => { readError = "STORAGE_READ_TIMEOUT"; await assert.rejects(() => sandbox.actualLoader(url, "owner"), /TIMEOUT/u); assert.equal(external, 1); readError = ""; });
  await check("data references retain existing byte validation and bypass owned lookup", async () => { const prior = reads; await sandbox.actualLoader(`data:image/png;base64,${bytes.toString("base64")}`, "owner"); assert.equal(reads, prior); });
  await check("all three actual byte protocols receive server actor and candidate actor is authenticated userId", () => {
    assert.equal((source.match(/await loadReferenceImage\(url, actorId\)/gu) || []).length, 3);
    assert.match(source, /generateLocalImageCandidate\(\{\s+actorId: userId,/u);
  });
  console.log(JSON.stringify({ status: "PASS", checks, networkRequests: 0, databaseWrites: 0, providerDispatches: 0 }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
