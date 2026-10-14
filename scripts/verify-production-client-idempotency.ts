import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");
const checks: Check[] = [];

function requireTokens(name: string, source: string, tokens: string[]) {
  const missing = tokens.filter((token) => !source.includes(token));
  checks.push({
    name,
    passed: missing.length === 0,
    detail: missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`,
  });
}

function requireCount(name: string, source: string, token: string, expected: number) {
  const actual = source.split(token).length - 1;
  checks.push({ name, passed: actual === expected, detail: `expected=${expected}; actual=${actual}` });
}

const helper = read("src/lib/browser-client-attempt.ts");
const videoPage = read("src/app/video/page.tsx");
const videoTypes = read("src/types/coze.ts");
const storyboard = read("src/components/storyboard-workbench.tsx");
const voiceWorkspace = read("src/app/voice-studio/workspace/page.tsx");
const voiceImitate = read("src/app/voice-studio/imitate/page.tsx");

requireTokens("helper:persistent-stable-attempt", helper, [
  "buildClientRequestFingerprint",
  "resolveBrowserClientAttempt",
  "clearBrowserClientAttempt",
  "window.localStorage",
  "SHA-256",
  "MAX_ATTEMPT_AGE_MS",
]);
requireTokens("video-page:all-model-idempotency", videoPage, [
  "await buildClientRequestFingerprint({",
  "resolveBrowserClientAttempt({",
  '"Idempotency-Key": clientRequestId',
  "client_request_id: clientRequestId",
  'prefix: "video"',
]);
checks.push({
  name: "video-page:no-h3-only-client-key-gate",
  passed: !videoPage.includes('enabled: currentModel?.protocolType === "autodl_h3_selfhost"'),
  detail: "client request IDs are no longer restricted to one provider protocol",
});
requireTokens("video-page:finalizing-is-active", videoPage, [
  '"generating", "finalizing"',
  'case "finalizing":',
]);
requireTokens("video-type:finalizing", videoTypes, ['"processing" | "finalizing" | "completed"']);

requireTokens("storyboard:whole-reference-owned-key", storyboard, [
  "function normalizeStoryboardVideoImageReference",
  "const submissionImageRef = normalizeStoryboardVideoImageReference(card.imageRef)",
  "const submissionImageStorageKey = card.imageStorageKey",
  "image_storage_key: submissionImageStorageKey",
  "image_url: submissionImageUrl",
]);
checks.push({
  name: "storyboard:no-implicit-panel-crop",
  passed: !storyboard.includes("first_storyboard_panel") && !storyboard.includes('transform: { kind: "crop"'),
  detail: "the complete 4/5-panel reference remains the input unless an explicit split workflow is added",
});
requireTokens("storyboard:all-model-idempotency", storyboard, [
  "await buildClientRequestFingerprint({",
  "resolveBrowserClientAttempt({",
  'prefix: "sbw-video"',
  '"Idempotency-Key": stableVideoClientRequestId',
  "client_request_id: stableVideoClientRequestId",
]);

requireTokens("voice-workspace:shared-idempotent-submit", voiceWorkspace, [
  "const submitVoiceRequest = async",
  "buildClientRequestFingerprint(payload)",
  "resolveBrowserClientAttempt({",
  "'Idempotency-Key': attempt.clientRequestId",
  "client_request_id: attempt.clientRequestId",
]);
requireCount("voice-workspace:five-generation-modes", voiceWorkspace, "await submitVoiceRequest(", 5);
requireTokens("voice-imitate:idempotent-submit", voiceImitate, [
  "buildClientRequestFingerprint(body)",
  "resolveBrowserClientAttempt({",
  "'Idempotency-Key': attempt.clientRequestId",
  "client_request_id: attempt.clientRequestId",
  "clearBrowserClientAttempt(attemptStorageKey, attempt.clientRequestId)",
]);

const failed = checks.filter((check) => !check.passed);
console.log(JSON.stringify({
  verifier: "production-client-idempotency",
  mode: "offline-static-only-no-network-no-paid-call",
  passed: failed.length === 0,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks,
}, null, 2));

if (failed.length > 0) process.exitCode = 1;
