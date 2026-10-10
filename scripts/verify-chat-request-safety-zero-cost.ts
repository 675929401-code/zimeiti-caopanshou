import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchWithRetry } from "@/contexts/chat-utils";

const appContext = readFileSync(resolve("src/contexts/app-context.tsx"), "utf8");

function functionSlice(startMarker: string, endMarker: string): string {
  const start = appContext.indexOf(startMarker);
  const end = appContext.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source boundary: ${startMarker}`);
  return appContext.slice(start, end);
}

function verifyChatRequestIdentityContract() {
  const sendCozeMessage = functionSlice(
    "const sendCozeMessage = useCallback",
    "// ---- Coze Coding (stream_run) message sending ----",
  );

  const chatCalls = sendCozeMessage.match(/fetchWithRetry\("\/api\/chat",/gu) || [];
  assert.equal(chatCalls.length, 1, "every exact /api/chat send must use the audited request path");
  assert.match(sendCozeMessage, /const clientRequestId = `chat_\$\{crypto\.randomUUID\(\)\}`/u);
  assert.match(sendCozeMessage, /"Idempotency-Key": clientRequestId/u);
  assert.match(sendCozeMessage, /client_request_id: clientRequestId/u);
}

async function verifyLlmPostHasNoAutomaticRetry() {
  const sendLlmMessage = functionSlice(
    "const sendLLMMessage = useCallback",
    "// ---- Coze Bot message sending ----",
  );
  const llmCalls = sendLlmMessage.match(/fetchWithRetry\("\/api\/llm",/gu) || [];
  assert.equal(llmCalls.length, 1, "every /api/llm generation POST must use the audited request path");
  assert.match(
    sendLlmMessage,
    /fetchWithRetry\("\/api\/llm",\s*\{[\s\S]*?method:\s*"POST"[\s\S]*?\},\s*0\);/u,
    "/api/llm generation POST must explicitly disable automatic retries",
  );

  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new TypeError("fixture transport failure");
  }) as typeof fetch;
  try {
    await assert.rejects(fetchWithRetry("/api/llm", { method: "POST" }, 0, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(attempts, 1, "zero retries must make exactly one transport attempt");
}

async function main() {
  verifyChatRequestIdentityContract();
  await verifyLlmPostHasNoAutomaticRetry();
  console.log(JSON.stringify({
    verifier: "chat-request-safety-zero-cost",
    passed: true,
    realNetworkCalls: 0,
    databaseWrites: 0,
    providerCalls: 0,
    checks: {
      chatHeaderBodyIdentityMatch: "passed",
      llmAutomaticRetriesDisabled: "passed",
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
