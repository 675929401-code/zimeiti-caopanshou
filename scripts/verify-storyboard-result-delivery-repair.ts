import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import { readPublicImageResult, validatePublicImageResultUrl } from "../src/lib/image-result-network";
import { SafeFetchError } from "../src/lib/safe-fetch";
import { renderCoverComposition } from "../src/lib/cover-composition-server";
import { parseImageDimensions } from "../src/lib/image-dimensions";
import { validateImageOutputContract } from "../src/lib/image-output-contract";
import { validateUploadBuffer } from "../src/lib/file-upload-security";
import { ImageRequestRejectedError } from "../src/lib/image-exactly-once";

const output = ".codex-evidence/storyboard-delivery-audit-20261023/repair/root";
mkdirSync(output, { recursive: true });
const checks: string[] = [];
const sourceFiles = ["src/app/api/image/generate/route.ts", "src/lib/image-result-network.ts", "src/lib/image-provider-delivery.ts", "src/lib/image-exactly-once.ts", "src/lib/cover-composition-server.ts"]
  .map(file => ({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }));
const publicAddress = { address: "1.1.1.1", family: 4 };
const pngResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
async function main() {
  let lookups = 0, transports = 0;
  const fetched = await readPublicImageResult("https://fixture.invalid/image.png", { allowedContentTypes: ["image/png"] }, {
    lookup: async () => ++lookups === 1 ? [{ address: "198.18.0.8", family: 4 }] : [publicAddress],
    pinnedFetch: async (_url, address) => { assert.deepEqual(address, publicAddress); transports++; return pngResponse(); },
    fetch: async () => { throw new Error("Unpinned transport forbidden"); },
  });
  assert.equal(lookups, 2); assert.equal(transports, 1); assert.equal(fetched.buffer.length, 3);
  checks.push("Fake-IP DNS recovers through public DNS and pins a single existing-result GET");
  for (const url of ["http://127.0.0.1/image.png", "https://169.254.169.254/image.png", "https://fixture.invalid/image.png"]) {
    await assert.rejects(() => readPublicImageResult(url, {}, {
      lookup: async () => [{ address: "10.0.0.1", family: 4 }], pinnedFetch: async () => { throw new Error("Must never connect"); },
    }), (error: unknown) => error instanceof SafeFetchError && error.code === "IP_FORBIDDEN");
  }
  checks.push("Literal and DNS private addresses remain forbidden in both resolvers");
  let validateLookups = 0;
  assert.equal((await validatePublicImageResultUrl("https://fixture.invalid/image.png", {
    lookup: async () => ++validateLookups === 1 ? [{ address: "198.18.0.8", family: 4 }] : [publicAddress],
  })).hostname, "fixture.invalid");
  checks.push("Owned-image forwarding validates public DNS without trusted-host bypass");
  let httpCalls = 0;
  await assert.rejects(() => readPublicImageResult("https://fixture.invalid/image.png", {}, {
    lookup: async () => [publicAddress], pinnedFetch: async () => { httpCalls++; return new Response(null, { status: 500 }); },
  }));
  assert.equal(httpCalls, 1); checks.push("Provider HTTP failure does not replay GET through another transport");

  const route = "src/app/api/image/generate/route.ts", source = readFileSync(route, "utf8");
  const tree = ts.createSourceFile(route, source, ts.ScriptTarget.Latest, true);
  const functions: string[] = []; let persist = ""; const textCalls: boolean[] = [];
  function walk(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && ["exactTextPlan", "prepareGeneratedImageBytes"].includes(node.name?.text || "")) functions.push(node.getText(tree));
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "persistProviderResult") persist = node.initializer.getText(tree);
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "prepareGeneratedImageBytes") textCalls.push(node.arguments[0].getText(tree).includes("coverText: exactCoverText"));
    ts.forEachChild(node, walk);
  }
  walk(tree); assert.equal(textCalls.length, 2); assert.ok(textCalls.every(Boolean));
  const compile = (code: string, context: object) => vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { Buffer, Error, createHash, ...context });
  const helpers = compile(`${functions.join("\n")}\n({prepareGeneratedImageBytes, exactTextPlan});`, {
    parseImageDimensions, validateImageOutputContract, ImageRequestRejectedError, renderCoverComposition,
  });
  const background = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: "#26545d" } }).png().toBuffer();
  const options = { buffer: background, aspectRatio: "16:9", resolution: "2K", expectedPixelSize: "2048x1152" };
  const longText = "准确内容".repeat(50);
  assert.equal(helpers.exactTextPlan(longText, "16:9").title, longText);
  const multiLine = helpers.exactTextPlan("标题\n第二行\n第三行", "16:9");
  assert.equal(multiLine.title, "标题"); assert.equal(multiLine.subtitle, "第二行\n第三行");
  checks.push("All 200 allowed exact-text characters and explicit subtitle line breaks are retained");
  assert.equal((await helpers.prepareGeneratedImageBytes(options)).buffer, background);
  const rendered = await helpers.prepareGeneratedImageBytes({ ...options, coverText: "准确文字\n保留指定内容" });
  assert.equal(rendered.contentType, "image/png"); assert.ok(!rendered.buffer.equals(background));
  assert.equal(rendered.dimensions.width, 2048); assert.equal(rendered.dimensions.height, 1152);
  writeFileSync(`${output}/exact-text-2k.png`, rendered.buffer);
  checks.push("Exact text is rendered into real 2K PNG pixels; no-text mode preserves original bytes");
  const source4k = await sharp({ create: { width: 4096, height: 2304, channels: 3, background: "#26545d" } }).png().toBuffer();
  const rendered4k = await helpers.prepareGeneratedImageBytes({ ...options, buffer: source4k, resolution: "4K", expectedPixelSize: "4096x2304", coverText: "四千像素文字" });
  assert.equal(rendered4k.dimensions.width, 4096); assert.equal(rendered4k.dimensions.height, 2304);
  checks.push("Exact composition retains validated 4K dimensions");
  const wrongShape = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#26545d" } }).png().toBuffer();
  await assert.rejects(() => helpers.prepareGeneratedImageBytes({ ...options, buffer: wrongShape }), (error: unknown) => error instanceof ImageRequestRejectedError);
  checks.push("Wrong provider aspect ratio/resolution is a definitive rejection");
  // The project's minimal SharpPipeline ambient type omits this supported API.
  const jpeg = sharp(background).jpeg() as ReturnType<typeof sharp> & { withMetadata(options: { orientation: number }): ReturnType<typeof sharp> };
  const rotatedJpeg = await jpeg.withMetadata({ orientation: 6 }).toBuffer();
  await assert.rejects(() => helpers.prepareGeneratedImageBytes({ ...options, buffer: rotatedJpeg, coverText: "方向校验" }), (error: unknown) => error instanceof ImageRequestRejectedError);
  checks.push("Post-composition orientation/dimensions are revalidated before delivery");
  const candidate = { id: "fixture-model", provider: "fixture", api_endpoint: "https://fixture.invalid/api" };
  let stored: Buffer | undefined;
  const context = { candidates: [candidate], effectiveMode: "local", resumeSnapshot: null, AUTODL_H3_SELFHOST_PROVIDER: "selfhost",
    providerMediaUrl: (url: string) => url, readPublicImageResult: async () => ({ buffer: background, contentType: "image/png", url: "https://fixture.invalid/image.png" }),
    AUTODL_H3_IMAGE_MAX_BYTES: 30_000_000, AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS: 30_000, AUTODL_H3_IMAGE_CONTENT_TYPES: ["image/png"],
    validateUploadBuffer, ratio: "16:9", effectiveResolution: "2K", expectedImagePixelSize: () => "2048x1152",
    ...helpers, ImageRequestRejectedError, GENERATED_IMAGE_STORAGE_PROVIDER: "tencent_cos",
    toGeneratedImageObjectUri: (key: string) => `object://tencent_cos/${encodeURIComponent(key)}`,
    storageManager: { upload: async (bytes: Buffer, fileName: string, mime: string, uploadOptions: Record<string, unknown>) => {
      assert.equal(mime, "image/png"); assert.equal(uploadOptions.userId, undefined); assert.equal(uploadOptions.strictProvider, true);
      stored = bytes; return { key: `images/${fileName}`, size: bytes.length, provider: "tencent_cos" };
    } },
  };
  const result = { mode: "local", selectedModelId: candidate.id, selectedCostPrice: 0, provider: candidate.provider, apiEndpoint: candidate.api_endpoint, rawUrl: "https://fixture.invalid/image.png", source: "fixture" };
  const composed = await compile(`(${persist});`, { ...context, exactCoverText: "准确文字" })(result, { recordId: "a".repeat(64) });
  assert.equal(composed.contentType, "image/png"); assert.ok(composed.imageStorageUri); assert.equal(composed.deliveryMode, undefined);
  assert.ok(stored && !stored.equals(background));
  checks.push("Actual provider callback stores composed bytes held for atomic ownership finalization");
  stored = undefined;
  const original = await compile(`(${persist});`, { ...context, exactCoverText: "" })(result, { recordId: "b".repeat(64) });
  assert.equal(original.deliveryMode, "provider_url"); assert.equal(stored, undefined);
  checks.push("Ordinary images retain provider-link delivery and never upload a copy");
  assert.ok(sourceFiles.every(item => item.sha256 === createHash("sha256").update(readFileSync(item.file)).digest("hex")), "Source files remain unchanged during execution");
  writeFileSync(`${output}/result-delivery-tests.json`, JSON.stringify({ passed: true, checks, realNetworkRequests: 0,
    realProviderCalls: 0, realDatabaseWrites: 0, sourceFiles }, null, 2));
  console.log(JSON.stringify({ passed: true, count: checks.length, checks }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
