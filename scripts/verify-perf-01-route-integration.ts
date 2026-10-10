import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const llm = read("src/app/api/llm/route.ts");
const chat = read("src/app/api/chat/route.ts");
const extract = read("src/app/api/extract/status/route.ts");
const admin = read("src/app/api/admin/product-usage/route.ts");

for (const [name, source] of Object.entries({ llm, chat, extract, admin })) {
  assert.match(source, /createOperationPerformanceTrace/u, `${name}: shared trace helper missing`);
  assert.match(source, /recordServerOperationPerformanceEventBestEffort/u, `${name}: durable best-effort sink missing`);
  assert.match(source, /checkpoint\(["']request\.received["']/u, `${name}: request phase missing`);
  assert.match(source, /checkpoint\(["']auth\.permission["']/u, `${name}: auth phase missing`);
  assert.match(source, /checkpoint\(["']database\.read["']/u, `${name}: database phase missing`);
  assert.match(source, /checkpoint\(["']response\.terminal["']/u, `${name}: terminal phase missing`);
  assert.doesNotMatch(source, /checkpoint\([^\n]+(?:message|prompt|apiKey|token|content)\s*:/iu, `${name}: content or credential entered performance event`);
}

assert.match(llm, /function observeLlmPerformanceResponse/u);
assert.match(llm, /checkpoint\("upstream\.wait"/u);
assert.match(llm, /checkpoint\("response\.first_byte"/u);
assert.match(llm, /checkpoint\("result\.persistence"/u);
assert.match(llm, /observeLlmPerformanceResponse\(completedStreamResponse, performanceTrace\)/u);
assert.match(llm, /observeLlmPerformanceResponse\(completedNonStreamResponse, performanceTrace\)/u);
assert.match(llm, /controller\.enqueue\(value\)/u, "LLM observer must pass original chunks through unchanged");

assert.match(chat, /performanceTrace:\s*OperationPerformanceTrace/u);
assert.match(chat, /checkpoint\("upstream\.wait"/u);
assert.match(chat, /checkpoint\("response\.first_byte"/u);
assert.match(chat, /checkpoint\("result\.persistence"/u);
assert.match(chat, /performanceTerminalRecorded/u);
assert.match(chat, /publicModelId:[\s\S]{0,240}performanceTrace/u);

assert.match(extract, /operation:\s*'extract\.status_load'/u);
assert.match(extract, /taskId:\s*row\.record_id/u);
assert.match(extract, /checkpoint\('response\.first_byte'/u);

assert.match(admin, /operation:\s*"admin\.product_usage_load"/u);
assert.match(admin, /readProductUsageAnalyticsForAdmin/u);
assert.match(admin, /checkpoint\("response\.first_byte"/u);

console.log("PASS PERF-01 route integration: llm, coze chat, extraction status and admin read-only load use shared best-effort phases");
