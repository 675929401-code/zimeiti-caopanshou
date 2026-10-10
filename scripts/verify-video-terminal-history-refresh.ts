import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(resolve(process.cwd(), "src/app/video/page.tsx"), "utf8");

const historyStart = page.indexOf("/* ── Load history ── */");
const historyEnd = page.indexOf("const prepareHistoryRetry", historyStart);
assert.ok(historyStart >= 0 && historyEnd > historyStart, "missing video history loader block");
const historyBlock = page.slice(historyStart, historyEnd);

for (const marker of [
  "options: { supersedeInFlight?: boolean } = {}",
  "if (!options.supersedeInFlight) return",
  "historyRequestRef.current.abort()",
  "historyRequestRef.current = null",
  "loadHistory(0, { supersedeInFlight: true })",
  "historyOffsetRef.current = offset",
  "setHistoryNextOffset(data.nextOffset ?? null)",
  "setHistory(previous => offset ?",
]) {
  assert.ok(historyBlock.includes(marker), `history page-0 rebase contract missing: ${marker}`);
}
assert.doesNotMatch(historyBlock, /\/api\/video\/(?:generate|cancel)/u, "history refresh must remain read-only");

const sseSwitchStart = page.indexOf("switch (event.event)");
const sseSwitchEnd = page.indexOf('case "error":', sseSwitchStart);
assert.ok(sseSwitchStart >= 0 && sseSwitchEnd > sseSwitchStart, "missing SSE terminal switch");
const sseTerminalBlock = page.slice(sseSwitchStart, sseSwitchEnd);
for (const status of ["completed", "failed", "cancelled"]) {
  const caseStart = sseTerminalBlock.indexOf(`case "${status}":`);
  const nextCase = sseTerminalBlock.indexOf("case ", caseStart + 6);
  const branch = sseTerminalBlock.slice(caseStart, nextCase >= 0 ? nextCase : undefined);
  assert.ok(caseStart >= 0, `missing SSE ${status} branch`);
  assert.match(branch, /refreshHistoryFirstPage\(\)/u, `SSE ${status} must refresh history page 0`);
}

const reconnectStart = page.indexOf("流结束未收到终态");
const reconnectEnd = page.indexOf("const activeTasksAll", reconnectStart);
assert.ok(reconnectStart >= 0 && reconnectEnd > reconnectStart, "missing SSE status fallback block");
const reconnectBlock = page.slice(reconnectStart, reconnectEnd);
for (const status of ["completed", "failed", "cancelled"]) {
  assert.match(reconnectBlock, new RegExp(`sd\\.status === ["']${status}["'][\\s\\S]{0,700}?refreshHistoryFirstPage\\(\\)`, "u"),
    `status fallback ${status} must refresh history page 0`);
}

const submitTerminalStart = page.indexOf("if (data.task_id || data.taskId");
const submitTerminalEnd = page.indexOf("} else {", page.indexOf('data.status === "cancelled"', submitTerminalStart));
assert.ok(submitTerminalStart >= 0 && submitTerminalEnd > submitTerminalStart, "missing submit terminal response block");
const submitTerminalBlock = page.slice(submitTerminalStart, submitTerminalEnd);
for (const status of ["failed", "completed", "cancelled"]) {
  assert.match(submitTerminalBlock, new RegExp(`data\\.status === ["']${status}["'][\\s\\S]{0,1800}?refreshHistoryFirstPage\\(\\)`, "u"),
    `submit response ${status} must refresh history page 0`);
}

assert.match(page, /case "failed":[\s\S]{0,700}?refreshHistoryFirstPage\(\)[\s\S]{0,350}?sseRefs\.current\.delete/u);
assert.match(page, /data\.status === "completed" \|\| data\.status === "failed" \|\| data\.status === "cancelled"\) refreshHistoryFirstPage\(\)/u,
  "cancel confirmation must refresh page 0 for every terminal response");
assert.match(page, /status: "cancelled" as const[\s\S]{0,700}?refreshHistoryFirstPage\(\)/u,
  "confirmed manual cancellation must refresh durable history");

console.log(JSON.stringify({
  passed: true,
  terminalStatuses: ["completed", "failed", "cancelled"],
  forcedOffset: 0,
  supersedesInFlightHistoryRead: true,
  generationPosts: 0,
  billingCalls: 0,
  networkCalls: 0,
}, null, 2));
