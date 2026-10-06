import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/image-workbench.tsx", "utf8");

assert.match(source, /void generateAll\(\{ recoverableOnly: true \}\)/u,
  "provider-complete results must continue delivery automatically");
assert.match(source, /void refreshUnknownImageJobs\(\)/u,
  "unknown image attempts must be checked in the background");
assert.match(source, /!recoverableOnly && \(/u,
  "automatic delivery must not submit idle or failed prompt cards");
assert.match(source, /生成图片（\{newGenerationJobCount\}）/u,
  "the paid submit button must count only new image requests");
assert.doesNotMatch(source, /生成\/恢复|立即恢复|可安全恢复|可以恢复保存|恢复入库/u,
  "the workbench must not expose a manual recovery action");

console.log(JSON.stringify({
  passed: true,
  providerRequests: 0,
  databaseWrites: 0,
  assertions: 5,
}));
