import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { parseMediaHistoryGallery } from "../src/lib/media-history-gallery";

const source = readFileSync("src/app/api/media-history/content/route.ts", "utf8");
const start = source.indexOf("function imageAssetFromGallery(");
const end = source.indexOf("function safeFileName(", start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(`${source.slice(start, end)}\nexports.read=imageAssetFromGallery;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox: { exports: { read?: (content: unknown, index: number) => unknown }; parseMediaHistoryGallery: typeof parseMediaHistoryGallery } = { exports: {}, parseMediaHistoryGallery };
vm.runInNewContext(code, sandbox);
const read = sandbox.exports.read!;
const gallery = JSON.stringify({ type: "image_gallery", images: [null, { url: "a", assetId: "asset-a", storageKey: "key-a" }, {}, { url: "b", assetId: "asset-b", storageKey: "key-b" }] });
assert.deepEqual(parseMediaHistoryGallery(gallery)?.images.map(image => image.assetId), ["asset-a", "asset-b"]);
assert.deepEqual(JSON.parse(JSON.stringify(read(gallery, 0))), { assetId: "asset-a", storageKey: "key-a" });
assert.deepEqual(JSON.parse(JSON.stringify(read(gallery, 1))), { assetId: "asset-b", storageKey: "key-b" });
assert.equal(read(gallery, 2), null);
assert.equal(read(JSON.stringify({type:"image_gallery",images:[null,{url:"x"}]}), 0), null);
assert.equal(parseMediaHistoryGallery("bad"), null);
console.log("PASS: shared gallery parser and extracted content lookup agree on filtered ordering; no network");
