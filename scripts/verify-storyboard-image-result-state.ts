import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import { readStoryboardRecovery, writeStoryboardRecovery } from "../src/lib/storyboard-workspace-recovery";
import { generatedImagePreviewUrl } from "../src/lib/generated-image-reference";
import { IMAGE_OUTPUT_POLICY_V1, IMAGE_OUTPUT_POLICY_V2 } from "../src/lib/image-output-contract";
import { validateOwnedGeneratedImageReceipt, type GeneratedImageReferenceDependencies } from "../src/lib/server/generated-image-reference";
import { isCompletedProviderImageReceipt, isUnavailableCompletedStoryboardImage, storyboardImageUnavailablePatch, storyboardImageUnavailablePresentation } from "../src/lib/storyboard-image-result-state";

const checks: string[] = [];
const check = async (name: string, run: () => unknown) => { await run(); checks.push(name); };
const files = ["src/lib/storyboard-image-result-state.ts", "src/lib/storyboard-project-contract.ts", "src/app/api/storyboard/projects/route.ts", "src/app/api/media-history/content/route.ts"];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const before = hashes();
const reference = { schema: "generated_image_ref.v1" as const, recordId: "a".repeat(64) };
const base = () => ({ id: "project-media-state", title: "Media state regression", createdAt: 1, updatedAt: 2, ratio: "16:9" as const, imageResolution: "2K", videoResolution: "720p", videoDuration: 10, imageModelId: "image", videoModelId: "video",
  cards: [{ id: "card-a", order: 1, imagePrompt: "a", videoPrompt: "", referenceImageUrls: [] as string[], imageStatus: "done" as const, videoStatus: "idle" as const, imageRef: reference, imageRecordId: reference.recordId, imageDeliveryMode: "provider_url" as const, imageBillingState: "settled", imagePriceCharged: .3, imageDeliveryExpectedPixelSize: "2048x1152", imageOutputPolicyVersion: IMAGE_OUTPUT_POLICY_V2.version }] });
function extract(file: string, name: string) {
  const source = readFileSync(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name); assert.ok(node);
  return ts.transpileModule(node.getText(ast) + `\nexports.${name}=${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
async function main() {
  await check("completed provider media state requires bound valid receipt; inline and unknown remain separate", () => {
    const card = base().cards[0]; assert.equal(isCompletedProviderImageReceipt(card), true);
    assert.equal(isUnavailableCompletedStoryboardImage(card), false);
    for (const imageMediaState of ["expired", "unavailable"] as const) {
      assert.equal(isUnavailableCompletedStoryboardImage({ ...card, imageMediaState }), true);
      assert.equal(storyboardImageUnavailablePresentation({ ...card, imageMediaState })?.label.startsWith("已完成"), true);
    }
    for (const changed of [{ ...card, imageStatus: "failed" }, { ...card, imageDeliveryMode: "inline_ephemeral" }, { ...card, imageRecordId: "bad" }, { ...card, imageRef: { recordId: "b".repeat(64) } }]) {
      assert.equal(isUnavailableCompletedStoryboardImage({ ...changed, imageMediaState: "expired" }), false);
    }
  });
  await check("unavailable patch clears usable media but leaves identity, billing and original target metadata", () => {
    const card = { ...base().cards[0], imageUrl: "https://fixture.invalid/old.png", videoSourceImageUrl: "https://fixture.invalid/old.png", imageValidatedAt: 1 };
    const patched = { ...card, ...storyboardImageUnavailablePatch("expired") };
    assert.equal(patched.imageStatus, "done"); assert.equal(patched.imageMediaState, "expired");
    assert.equal(patched.imageUrl, undefined); assert.equal(patched.videoSourceImageUrl, undefined); assert.equal(patched.imageValidatedAt, undefined);
    for (const key of ["imageRecordId", "imageBillingState", "imagePriceCharged", "imageDeliveryExpectedPixelSize", "imageOutputPolicyVersion"] as const) assert.equal(patched[key], card[key]);
  });
  await check("schema, persistence projection, JSON clone and recovery all retain media state and target metadata", () => {
    const document = base(); Object.assign(document.cards[0], storyboardImageUnavailablePatch("expired"));
    const parsed = StoryboardProjectDocument.parse(document); const snapshot = createStoryboardPersistenceSnapshot(parsed);
    const cloned = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(snapshot)));
    assert.equal(cloned.cards[0].imageMediaState, "expired"); assert.equal(cloned.cards[0].imageOutputPolicyVersion, "image_output_policy.v2"); assert.equal(cloned.cards[0].imageDeliveryExpectedPixelSize, "2048x1152");
    const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeStoryboardRecovery(storage, "scope", cloned, "baseline"); const restored = readStoryboardRecovery(storage, "scope"); assert.ok(restored);
    assert.equal((restored.run.cards[0] as typeof cloned.cards[0]).imageMediaState, "expired");
    for (const field of [{ imageMediaState: "guessed" }, { imageOutputPolicyVersion: "v3" }, { imageDeliveryExpectedPixelSize: "auto" }]) {
      assert.equal(StoryboardProjectDocument.safeParse({ ...document, cards: [{ ...document.cards[0], ...field }] }).success, false);
    }
    for (const policy of [IMAGE_OUTPUT_POLICY_V1, IMAGE_OUTPUT_POLICY_V2]) {
      assert.equal(StoryboardProjectDocument.safeParse({ ...document, cards: [{ ...document.cards[0], imageOutputPolicyVersion: policy.version }] }).success, true);
    }
  });
  const hydrateCode = extract("src/app/api/storyboard/projects/route.ts", "hydrate");
  async function hydrateWith(row: unknown, lookupError = false, requestId = false, legacyWithoutRef = false) {
    const exported: { hydrate?: (db: unknown, owner: string, doc: unknown) => Promise<{ document: ReturnType<typeof base> }> } = {};
    const deps: GeneratedImageReferenceDependencies = { findOwned: async () => { if (lookupError) throw Error("DB_UNAVAILABLE"); return row as Awaited<ReturnType<GeneratedImageReferenceDependencies["findOwned"]>>; }, validateUrl: async () => { throw Error("NETWORK_FORBIDDEN"); } };
    runInNewContext(hydrateCode, { exports: exported, structuredClone, createStoryboardPersistenceSnapshot, generatedImagePreviewUrl, storyboardImageUnavailablePatch,
      validateOwnedGeneratedImageReceipt: (input: Parameters<typeof validateOwnedGeneratedImageReceipt>[0]) => validateOwnedGeneratedImageReceipt(input, deps),
      mediaFields: ["imageUrl", "videoSourceImageUrl", "videoUrl", "videoContentUrl"], mapCurrentReferenceMarkers: () => {}, collectStoryboardVideoTaskIds: () => [] });
    const cardDocument = base() as ReturnType<typeof base> & { cards: Array<ReturnType<typeof base>["cards"][number] & { imageClientRequestId?: string; imageMediaState?: string; imageUrl?: string; imageValidatedAt?: number }> };
    if (requestId) cardDocument.cards[0].imageClientRequestId = "request-a";
    if (legacyWithoutRef) delete (cardDocument.cards[0] as { imageRef?: unknown }).imageRef;
    cardDocument.cards[0].imageUrl = "https://fixture.invalid/old.png"; cardDocument.cards[0].imageValidatedAt = 1;
    Object.assign(cardDocument.cards[0], { videoSourceImageUrl: "https://fixture.invalid/stale-reference.png" });
    const builder = { select: () => builder, eq: () => builder, in: async () => ({ data: requestId && row ? [{ record_id: reference.recordId, client_idempotency_key: "request-a", response: (row as { response: unknown }).response }] : [], error: null }) };
    return (await exported.hydrate!({ from: () => builder }, "owner", cardDocument)).document;
  }
  const expired = { state: "completed", delivery_state: "delivered", response: { deliveryMode: "provider_url", sourceExpiredAt: "2026-10-23T00:00:00Z" } };
  await check("actual hydrate preserves owned expired success without requestId and with requestId", async () => {
    for (const hasRequest of [false, true]) {
      const result = await hydrateWith(expired, false, hasRequest); const card = result.cards[0] as Record<string, unknown>;
      assert.equal(card.imageStatus, "done"); assert.equal(card.imageMediaState, "expired"); assert.equal(card.imageUrl, undefined); assert.equal(card.imageValidatedAt, undefined);
      assert.equal(card.imagePriceCharged, .3); assert.equal(card.imageRecordId, reference.recordId);
    }
  });
  await check("actual hydrate does not classify ownership errors, pending or DB errors as expired", async () => {
    for (const [row, dbError] of [[null, false], [expired, true], [{ ...expired, delivery_state: "pending" }, false]] as const) {
      const card = (await hydrateWith(row, dbError)).cards[0] as Record<string, unknown>;
      assert.equal(card.imageMediaState, undefined); assert.equal(card.imageUrl, undefined); assert.equal(card.imageRetryBlocked, true);
      assert.match(String(card.imageError), /归属或可用性暂时无法确认/);
    }
  });
  await check("actual hydrate verifies available original through fresh preview URL and clears stale validation", async () => {
    const result = await hydrateWith({ ...expired, response: { deliveryMode: "provider_url" } }); const card = result.cards[0] as Record<string, unknown>;
    assert.equal(card.imageStatus, "done"); assert.equal(card.imageMediaState, undefined); assert.equal(card.imageValidatedAt, undefined); assert.equal(card.imageRetryBlocked, false);
    assert.equal(card.imageUrl, generatedImagePreviewUrl(reference));
  });
  await check("request-key recovery of legacy card without imageRef clears old media validation and video source", async () => {
    const result = await hydrateWith({ ...expired, response: { deliveryMode: "provider_url" } }, false, true, true);
    const card = result.cards[0] as Record<string, unknown>;
    assert.equal(card.imageRecordId, reference.recordId); assert.equal(card.imageValidatedAt, undefined); assert.equal(card.videoSourceImageUrl, undefined);
    assert.equal(card.imageStatus, "done"); assert.equal(card.imageMediaState, undefined); assert.equal(card.imageUrl, generatedImagePreviewUrl(reference));
  });
  const contentSource = readFileSync("src/app/api/media-history/content/route.ts", "utf8");
  const compiled = ts.transpileModule(contentSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  async function content(delivery: unknown, failure?: string, lookupError = false) {
    const exported: { GET?: (request: NextRequest) => Promise<Response> } = {}; let expiryMarks = 0;
    const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: delivery ? { response: delivery } : null, error: lookupError ? Error("DB_ERROR") : null }) };
    runInNewContext(compiled, { exports: exported, Buffer, require: (name: string) => {
      if (name === "next/server") return { NextResponse };
      if (name === "@/lib/current-api-user") return { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: "owner" } }) };
      if (name === "@/storage/database/supabase-client") return { getSupabaseClient: () => ({ from: () => builder }) };
      if (name === "@/storage/object") return { storageManager: {} };
      if (name === "@/lib/image-provider-delivery") return { readProviderImage: async () => { throw Error(failure || "TEMPORARY_NETWORK"); }, confirmedImageSourceExpiry: (error: Error) => error.message === "CONFIRMED_EXPIRED", markImageProviderSourceExpired: async () => { expiryMarks++; } };
      throw Error("UNEXPECTED_IMPORT:" + name);
    } });
    const response = await exported.GET!(new NextRequest("http://fixture.invalid/api/media-history/content?recordId=" + reference.recordId));
    return { response, body: await response.json(), expiryMarks };
  }
  await check("actual content transient provider failure is non-decodable 503 JSON/no-store, never expiry", async () => {
    const result = await content({ deliveryMode: "provider_url", providerUrl: "https://fixture.invalid/original.png" });
    assert.equal(result.response.status, 503); assert.match(result.response.headers.get("content-type") || "", /application\/json/);
    assert.equal(result.response.headers.get("cache-control"), "private, no-store"); assert.equal(result.response.headers.get("x-media-fallback"), "source-unavailable");
    assert.equal(result.body.code, "IMAGE_SOURCE_UNAVAILABLE"); assert.equal(result.expiryMarks, 0); assert.doesNotMatch(result.body.error, /已失效|重新生成/);
  });
  await check("actual content confirmed expiry remains 410/no-store and lookup errors remain unknown", async () => {
    for (const [delivery, failure] of [[expired.response, undefined], [{ deliveryMode: "provider_url", providerUrl: "https://fixture.invalid/original.png" }, "CONFIRMED_EXPIRED"]] as const) {
      const result = await content(delivery, failure); assert.equal(result.response.status, 410); assert.equal(result.response.headers.get("cache-control"), "private, no-store");
    }
    assert.equal((await content({ deliveryMode: "provider_url" }, undefined, true)).response.status, 503);
    assert.equal((await content(null)).response.status, 404);
  });
  assert.deepEqual(hashes(), before);
  console.log(JSON.stringify({ passed: true, checks, sourceHashes: before, realNetworkRequests: 0, realDatabaseWrites: 0, providerSubmissions: 0 }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
