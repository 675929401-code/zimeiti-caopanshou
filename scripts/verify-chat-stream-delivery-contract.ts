import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const source = (relative: string) => readFileSync(`${root}/${relative}`, "utf8");
const routeSource = source("src/app/api/llm/route.ts");
const streamSource = source("src/app/api/llm/handle-stream.ts");
const skillSource = source("src/lib/skill-chat-handler.ts");
const deepSource = source("src/app/api/llm/handle-deep-thinking.ts");
const cozeSource = source("src/app/api/chat/route.ts");

assert.match(routeSource, /const allowLiveStreamDelivery = streamQuote\?\.amount === 0 \|\| Boolean\(streamReservation\)/u);
assert.match(routeSource, /reservation_authorized_live_delivery/u);
assert.match(streamSource, /if \(liveDelivery\) safeEnqueue\(chunk\)/u);
assert.match(streamSource, /type: "stream_delivery"/u);
assert.match(streamSource, /stream_delivery_reason: "non_stream_requested"/u);
assert.match(skillSource, /skill_multi_stage_atomic_budget_unavailable/u);
assert.match(deepSource, /deep_thinking_multi_stage_atomic_budget_unavailable/u);
assert.match(cozeSource, /createBufferedCozeDeliveryStream/u);

type CozeFixtureOptions = {
  openUpstream: () => Promise<Response>;
  fallbackUsage: { input_tokens: number; output_tokens: number };
  settle: (input: { usage: { input_tokens: number; output_tokens: number }; fullContent: string }) => Promise<{
    operationId?: string;
    billing?: { creditsCharged?: number };
    balanceAfter?: number;
  }>;
  persist: (input: { cozeConversationId: string; fullContent: string }) => Promise<void>;
  publicModelId: string;
  performanceTrace: { checkpoint: (...args: unknown[]) => unknown };
};

function loadCozeStreamFactory(): (options: CozeFixtureOptions) => ReadableStream<Uint8Array> {
  const start = cozeSource.indexOf("type CozeUsage =");
  const endMarker = "\nexport async function POST";
  const end = cozeSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "unable to isolate Coze delivery implementation");
  const isolated = `${cozeSource.slice(start, end)}\nexport { createBufferedCozeDeliveryStream };`;
  const compiled = ts.transpileModule(isolated, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const vmModule = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(compiled, {
    module: vmModule,
    exports: vmModule.exports,
    require,
    Response,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    console,
    setInterval,
    clearInterval,
  }, { filename: "isolated-coze-delivery.ts" });
  return vmModule.exports.createBufferedCozeDeliveryStream as (options: CozeFixtureOptions) => ReadableStream<Uint8Array>;
}

let providerPosts = 0;
let releaseProvider: (() => void) | undefined;
const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
const upstreamFrames = [
  'event: conversation.message.delta\ndata: {"type":"answer","content":"你"}\n\n',
  'event: conversation.message.delta\ndata: {"type":"answer","content":"好"}\n\n',
  'event: conversation.message.completed\ndata: {"type":"answer","content":"你好","conversation_id":"fixture-conversation"}\n\n',
  'event: conversation.chat.completed\ndata: {"usage":{"input_count":7,"output_count":2}}\n\n',
  "data: [DONE]\n\n",
].join("");

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v3/chat") {
    response.writeHead(404).end();
    return;
  }
  providerPosts += 1;
  await providerGate;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const bytes = Buffer.from(upstreamFrames, "utf8");
  const sizes = [1, 2, 5, 3, 8, 13];
  let offset = 0;
  let index = 0;
  const writeNext = () => {
    if (offset >= bytes.length) {
      response.end();
      return;
    }
    const size = sizes[index++ % sizes.length];
    response.write(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
    offset += size;
    setImmediate(writeNext);
  };
  writeNext();
});

async function main() {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
  const createBufferedCozeDeliveryStream = loadCozeStreamFactory();
  let settlements = 0;
  let persists = 0;
  const stream = createBufferedCozeDeliveryStream({
    openUpstream: () => fetch(`http://127.0.0.1:${address.port}/v3/chat`, { method: "POST", body: "{}" }),
    fallbackUsage: { input_tokens: 100, output_tokens: 100 },
    settle: async ({ usage, fullContent }) => {
      settlements += 1;
      assert.equal(usage.input_tokens, 7);
      assert.equal(usage.output_tokens, 2);
      assert.equal(fullContent, "你好");
      return {
        operationId: "fixture-operation",
        billing: { creditsCharged: 3 },
        balanceAfter: 97,
      };
    },
    persist: async ({ cozeConversationId, fullContent }) => {
      persists += 1;
      assert.equal(cozeConversationId, "fixture-conversation");
      assert.equal(fullContent, "你好");
    },
    publicModelId: "llm:fixture-model",
    performanceTrace: { checkpoint: () => undefined },
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(decoder.decode(first.value), ": heartbeat\n\n", "outer SSE must emit heartbeat before waiting for provider response");
  const second = await reader.read();
  let output = decoder.decode(second.value, { stream: true });
  assert.match(output, /"stream_delivery":"buffered"/u);
  assert.match(output, /coze_unbounded_usage_requires_atomic_settlement/u);
  assert.equal(settlements, 0, "provider output must not be settled before the fake provider completes");

  releaseProvider?.();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  output += decoder.decode();

  assert.equal(providerPosts, 1, "exactly one fake provider POST is allowed");
  assert.equal(settlements, 1);
  assert.equal(persists, 1);
  assert.match(output, /"content":"你"/u);
  assert.match(output, /"content":"好"/u);
  assert.match(output, /billing\.completed/u);
  assert.match(output, /"stream_delivery":"buffered"/u);
  assert.match(output, /data: \[DONE\]/u);

  console.log(JSON.stringify({
    passed: true,
    providerPosts,
    settlements,
    persists,
    splitChunkBytes: true,
    firstPacket: "heartbeat",
    streamDelivery: "buffered",
    realProviderPosts: 0,
    realDatabaseWrites: 0,
  }, null, 2));
  } finally {
    server.close();
    await once(server, "close");
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
