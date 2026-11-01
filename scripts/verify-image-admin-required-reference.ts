import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toImageAdminValidationDto, type ImageAdminValidationContext } from "../src/lib/image-admin-validation";
import { buildImageValidationRequest, canCorrectNotSubmittedImageValidation, imageValidationInputsForDto, readImageValidationAttempt, recoverImageValidation, saveImageValidationAttempt, submitImageValidation, updateImageValidationReceipt, type ImageValidationAttempt, type ImageValidationDto } from "../src/components/admin-image-validation-state";

async function main() {
  let checks = 0;
  const check = (name: string, fn: () => void) => { fn(); checks++; console.log(`PASS ${name}`); };
  const context = { model: { id: "fixture-model", provider: "openai", name: "Fixture", model_name: "fixture", is_active: true, selling_price: 0.28, cost_price: 0.1, supports_reference_input: true, max_reference_images: 3, reference_input_mode: "multi", api_protocol_config: { protocol: "images_edits" } }, userId: "owner", modelSnapshotHash: "a".repeat(64), configurationHash: "b".repeat(64), credentialReady: true, priceReady: true, epoch: 0, validationKey: `iav_${"c".repeat(64)}`, existing: null, busy: false } as unknown as ImageAdminValidationContext;
  const dto = toImageAdminValidationDto(context) as ImageValidationDto;
  const fields = { ...imageValidationInputsForDto(dto), prompt: "Original fixture prompt" };
  check("DTO uses explicit edits protocol", () => { assert.equal(dto.requiresReferenceInput, true); assert.equal(dto.minReferenceImages, 1); });
  const optional = toImageAdminValidationDto({ ...context, model: { ...context.model, api_protocol_config: { protocol: "images_generations" } } }) as ImageValidationDto;
  check("generations protocol stays optional", () => { assert.equal(optional.requiresReferenceInput, false); assert.equal(optional.minReferenceImages, 0); assert.deepEqual(buildImageValidationRequest(optional, { ...fields, referenceMode: false }).referenceImageUrls, []); });
  check("required inputs enable upload slot", () => { assert.equal(fields.referenceMode, true); assert.deepEqual(fields.referenceImageUrls, [""]); });
  check("missing required image rejected", () => assert.throws(() => buildImageValidationRequest(dto, fields), /必须提供参考图/u));
  check("late config requirement cannot be disabled", () => assert.throws(() => buildImageValidationRequest(dto, { ...fields, referenceMode: false }), /必须提供参考图/u));
  const valid = { ...fields, referenceImageUrls: ["https://fixture.example/reference.png?signature=fresh"] };
  check("required reference preserves signed URL and exact-once", () => { const body = buildImageValidationRequest(dto, { ...valid, referenceMode: false }); assert.deepEqual(body.referenceImageUrls, valid.referenceImageUrls); assert.equal(body.noRetry, true); assert.equal(body.strictSingleSubmit, true); });
  let posts = 0;
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const evidence = { code: "IMAGE_REFERENCE_REQUIRED", taskSubmitted: false, upstreamCalled: false, billed: false, error: "missing reference" };
  const fetcher = (async () => { posts++; return Response.json(evidence, { status: 422 }); }) as typeof fetch;
  await assert.rejects(() => submitImageValidation(dto, fields, "owner", { storage, token: "fixture", fetcher }), /必须提供参考图/u);
  check("preflight rejects before local attempt or POST", () => { assert.equal(posts, 0); assert.equal(values.size, 0); });
  const result = await submitImageValidation(optional, { ...fields, referenceMode: false }, "owner", { storage, token: "fixture", fetcher });
  check("exact negative receipt is not_submitted", () => { assert.equal(result.status, "not_submitted"); assert.deepEqual(result.notSubmittedEvidence, evidenceWithoutError()); assert.equal(result.body?.prompt, fields.prompt); });
  check("stored original body/evidence survive readback", () => { assert.deepEqual(readImageValidationAttempt(storage, "owner", dto.modelId), result); });
  for (const key of ["taskSubmitted", "upstreamCalled", "billed"] as const) {
    check(`missing ${key} remains unknown`, () => { const incomplete: Record<string, unknown> = { ...evidence }; delete incomplete[key]; assert.equal(updateImageValidationReceipt({ ...result, status: "submitting" }, incomplete, false).status, "unknown"); });
  }
  check("2xx cannot establish no-submit proof", () => assert.equal(updateImageValidationReceipt({ ...result, status: "submitting" }, evidence, true).status, "unknown"));
  check("returned completed evidence cannot be downgraded", () => assert.equal(updateImageValidationReceipt({ ...result, status: "submitting" }, { ...evidence, generationCompleted: true }, false).status, "unknown"));
  check("existing accepted record cannot be downgraded", () => assert.equal(updateImageValidationReceipt({ ...result, imageRecordId: "a".repeat(64) }, evidence, false).status, "unknown"));
  check("fresh same proof permits explicit correction only", () => { assert.equal(canCorrectNotSubmittedImageValidation(result, dto, "owner"), true); assert.equal(canCorrectNotSubmittedImageValidation(result, { ...dto, busy: true }, "owner"), false); assert.equal(canCorrectNotSubmittedImageValidation(result, dto, "other"), false); assert.equal(canCorrectNotSubmittedImageValidation(result, { ...dto, configurationHash: "d".repeat(64) }, "owner"), false); assert.equal(canCorrectNotSubmittedImageValidation(result, { ...dto, existingAttempt: { imageRecordId: "a".repeat(64) } as NonNullable<ImageValidationDto["existingAttempt"]> }, "owner"), false); });
  await submitImageValidation(dto, valid, "owner", { storage, token: "fixture", fetcher });
  check("ordinary submit never retries not_submitted", () => assert.equal(posts, 1));
  await assert.rejects(() => recoverImageValidation(result, { storage, token: "fixture", fetcher }), /不能恢复生成/u);
  check("no recovery POST for not_submitted", () => assert.equal(posts, 1));
  const correctedFetch = (async (_url: unknown, init?: RequestInit) => { posts++; const body = JSON.parse(String(init?.body)); assert.equal(body.prompt, result.body?.prompt); assert.deepEqual(body.referenceImageUrls, valid.referenceImageUrls); assert.equal(body.adminValidation.retestReason, undefined); return Response.json({ state: "processing" }); }) as typeof fetch;
  const corrected = await submitImageValidation(dto, valid, "owner", { storage, token: "fixture", fetcher: correctedFetch }, "", true);
  check("explicit correction makes one same-key POST and archives original", () => { assert.equal(posts, 2); assert.equal(corrected.status, "processing"); assert.equal(corrected.proof.validationKey, result.proof.validationKey); assert.ok([...values.keys()].some(key => key.includes(":previous:"))); });
  const unknown: ImageValidationAttempt = { ...corrected, status: "unknown" };
  saveImageValidationAttempt(storage, unknown);
  await submitImageValidation(dto, valid, "owner", { storage, token: "fixture", fetcher: correctedFetch }, "", true);
  check("unknown stays locked even explicit correction flag", () => assert.equal(posts, 2));
  const dialog = readFileSync("src/components/admin-image-validation-dialog.tsx", "utf8");
  const uploadHelper = readFileSync("src/lib/admin-image-validation-reference.ts", "utf8");
  check("dialog retains upload and mandatory checkbox contracts", () => { assert.ok(dialog.includes('id={`image-validation-upload-${index}`}')); assert.ok(dialog.includes('disabled={dto.requiresReferenceInput || uploading}')); assert.ok(uploadHelper.includes('fetcher("/api/storage/upload"')); assert.ok(uploadHelper.includes('body.set("category", "image")')); assert.ok(uploadHelper.includes('body.set("source", "admin-image-validation-reference")')); assert.ok(uploadHelper.includes('!data.file?.key')); });
  console.log(JSON.stringify({ status: "PASS", checks, realProviderCalls: 0, realDatabaseWrites: 0 }));
}
function evidenceWithoutError() { return { code: "IMAGE_REFERENCE_REQUIRED", taskSubmitted: false, upstreamCalled: false, billed: false }; }
void main().catch(error => { console.error(error); process.exitCode = 1; });
