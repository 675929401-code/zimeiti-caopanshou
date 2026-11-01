import assert from "node:assert/strict";
import fs from "node:fs";
import { currentTextModelGenerationAdmission, TextModelGenerationAdmissionError } from "../src/lib/server/text-model-generation-admission";

async function main() {
  let reads = 0;
  const cached = { id: "selected", is_active: true, is_hidden: false, user_access: "available", model_name: "fixture" };
  const read = async (userAccess: string) => { reads++; return { data: { id: "selected", is_active: true, is_hidden: false, user_access: userAccess } }; };
  for (const role of ["admin", "student"]) {
    await assert.rejects(() => currentTextModelGenerationAdmission({ ...cached, role }, () => read("pending_model_activation")),
      (error: unknown) => error instanceof TextModelGenerationAdmissionError && error.code === "MODEL_PENDING_ACTIVATION");
  }
  const activated = await currentTextModelGenerationAdmission({ ...cached, user_access: "pending_model_activation" }, () => read("available"));
  assert.equal(activated?.user_access, "available");
  await assert.rejects(() => currentTextModelGenerationAdmission(cached, async () => ({ data: null, error: "fixture failure" })),
    (error: unknown) => error instanceof TextModelGenerationAdmissionError && error.code === "MODEL_ADMISSION_READ_FAILED");
  let legacyRead = false;
  const legacy = { model_name: "administrator-custom-binding" };
  assert.equal(await currentTextModelGenerationAdmission(legacy, async () => { legacyRead = true; return { data: null }; }), legacy);
  assert.equal(legacyRead, false);
  assert.equal(reads, 3);
  const route = fs.readFileSync("src/app/api/llm/route.ts", "utf8");
  assert.ok(route.includes('select("id,is_active,is_hidden,user_access")'));
  assert.ok(route.indexOf("billingModelRow = await currentTextModelGenerationAdmission") < route.indexOf("const selectedModelBillingSnapshot = await"));
  const admissionOffset = route.indexOf("billingModelRow = await currentTextModelGenerationAdmission");
  assert.ok(admissionOffset >= 0 && admissionOffset < route.indexOf("const proxy = isZhipuAI"));
  console.log(JSON.stringify({ passed: true, cases: 8, latestAdmissionReads: reads, databaseWrites: 0, providerCalls: 0, scope: "actual helper and route wiring only; no real request" }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
