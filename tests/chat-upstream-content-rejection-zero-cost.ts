import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LLMProxy } from "@/lib/llm-proxy/proxy";
import {
  upstreamContentRejection,
  upstreamStreamError,
} from "@/lib/llm-proxy/stream-error";

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

function verifyTerminalClassification() {
  for (const finishReason of ["content_filter", "content-filtered", "safety", "blocked", "moderation", "refusal"]) {
    const error = upstreamContentRejection({ choices: [{ finish_reason: finishReason }] });
    assert.equal(error?.code, "LLM_UPSTREAM_CONTENT_REJECTED", finishReason);
  }
  assert.equal(
    upstreamContentRejection({ type: "message_delta", delta: { stop_reason: "refusal" } })?.code,
    "LLM_UPSTREAM_CONTENT_REJECTED",
  );
  assert.equal(
    upstreamContentRejection({ choices: [{ message: { refusal: "policy" }, finish_reason: "stop" }] })?.code,
    "LLM_UPSTREAM_CONTENT_REJECTED",
  );
  for (const normalReason of ["stop", "end_turn", "length", "tool_calls", null, undefined]) {
    assert.equal(upstreamContentRejection({ choices: [{ finish_reason: normalReason }] }), null, String(normalReason));
  }
  assert.equal(
    upstreamStreamError({ error: { type: "content_policy_violation", message: "blocked" } }).code,
    "LLM_UPSTREAM_CONTENT_REJECTED",
  );
  assert.equal(
    upstreamStreamError({ error: { code: "403", message: "content_filter" } }).code,
    "LLM_UPSTREAM_CONTENT_REJECTED",
    "an HTTP authorization-shaped status must not hide an explicit moderation rejection",
  );
}

function verifyCustomerCopy() {
  const client = source("src/contexts/app-context.tsx");
  const rejectedIndex = client.indexOf("LLM_UPSTREAM_CONTENT_REJECTED");
  const networkIndex = client.indexOf("Failed to fetch", rejectedIndex);
  assert.ok(rejectedIndex >= 0, "frontend must map the typed moderation rejection");
  assert.ok(networkIndex > rejectedIndex, "typed moderation rejection must be resolved before network fallback");
  assert.match(client.slice(rejectedIndex, networkIndex), /未通过上游内容审核/u);
  assert.doesNotMatch(client.slice(rejectedIndex, networkIndex), /网络连接异常/u);
}

function verifyBothProxyPaths() {
  const generic = source("src/lib/llm-proxy/proxy.ts");
  const zhipu = source("src/lib/llm-proxy/zhipu-proxy.ts");
  const client = source("src/contexts/app-context.tsx");
  assert.match(generic, /upstreamContentRejection\(parsed\)/u);
  assert.match(generic, /upstreamContentRejection\(data\)/u);
  assert.match(zhipu, /upstreamContentRejection\(parsed\)/u);
  assert.match(zhipu, /upstreamContentRejection\(data\)/u);
  assert.match(client, /LLM_UPSTREAM_CONTENT_REJECTED/u);
}

async function verifyGenericProxyRuntime() {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const responseFrom = (body: string, contentType: string) => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": contentType } },
  );
  const proxy = new LLMProxy({
    apiBase: "https://fixture.invalid/v1",
    apiKey: "fixture",
    defaultModel: "fixture-model",
    retryCount: 0,
  });
  try {
    globalThis.fetch = (async () => responseFrom(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}\n\n`,
      "text/event-stream",
    )) as typeof fetch;
    const rejectedStream = await proxy.chatStream({ model: "fixture-model", messages: [] });
    const rejectedText = await new Response(rejectedStream).text();
    assert.match(rejectedText, /LLM_UPSTREAM_CONTENT_REJECTED/u);
    assert.doesNotMatch(rejectedText, /data: \[DONE\]/u);

    globalThis.fetch = (async () => responseFrom(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正常回复" }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "text/event-stream",
    )) as typeof fetch;
    const normalStream = await proxy.chatStream({ model: "fixture-model", messages: [] });
    const normalText = await new Response(normalStream).text();
    assert.match(normalText, /正常回复/u);
    assert.match(normalText, /data: \[DONE\]/u);

    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "safety" }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    await assert.rejects(
      proxy.chat({ model: "fixture-model", messages: [] }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "LLM_UPSTREAM_CONTENT_REJECTED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  verifyTerminalClassification();
  verifyCustomerCopy();
  verifyBothProxyPaths();
  await verifyGenericProxyRuntime();
  console.log(JSON.stringify({
    verifier: "chat-upstream-content-rejection-zero-cost",
    passed: true,
    realNetworkCalls: 0,
    providerCalls: 0,
    databaseWrites: 0,
    covered: [
      "generic-stream-runtime",
      "generic-non-stream-runtime",
      "zhipu-stream-classification-hook",
      "zhipu-non-stream-classification-hook",
      "frontend-error-copy",
      "normal-terminal-reasons",
    ],
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
