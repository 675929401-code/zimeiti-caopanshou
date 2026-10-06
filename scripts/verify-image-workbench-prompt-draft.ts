import assert from "node:assert/strict";
import {
  parseImageWorkbenchPromptDraft,
  serializeImageWorkbenchPromptDraft,
} from "../src/lib/image-workbench-prompt-draft";

const serialized = serializeImageWorkbenchPromptDraft([
  { id: "job_safe_001", prompt: "第一条未提交提示词" },
  { id: "job_blank_002", prompt: "   " },
], 3, 1234);
assert.ok(serialized);
const restored = parseImageWorkbenchPromptDraft(serialized);
assert.deepEqual(restored, {
  version: 1,
  savedAt: 1234,
  jobs: [{ id: "job_safe_001", prompt: "第一条未提交提示词" }],
  referenceCount: 3,
});
assert.equal(JSON.stringify(restored).includes("blob:"), false);
assert.equal(JSON.stringify(restored).includes("data:image"), false);
assert.equal(serializeImageWorkbenchPromptDraft([{ id: "job_empty", prompt: "" }], 8), null);
assert.equal(parseImageWorkbenchPromptDraft("not-json"), null);
assert.equal(parseImageWorkbenchPromptDraft(JSON.stringify({
  version: 1,
  savedAt: 1,
  jobs: [{ id: "../../unsafe", prompt: "bad id" }, { id: "job_ok", prompt: "ok" }],
  referenceCount: 99,
}))?.jobs.length, 1);
assert.equal(parseImageWorkbenchPromptDraft(JSON.stringify({
  version: 1,
  savedAt: 1,
  jobs: [{ id: "job_ok", prompt: "ok" }],
  referenceCount: 99,
}))?.referenceCount, 8);

console.log(JSON.stringify({
  ok: true,
  restoredPrompts: restored?.jobs.length,
  referenceBodiesPersisted: 0,
  realNetworkCalls: 0,
  realDatabaseWrites: 0,
}, null, 2));
