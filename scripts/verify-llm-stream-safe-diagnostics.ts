import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type { StreamHandlerContext } from "../src/app/api/llm/handle-stream";

async function main() {
  const root = process.cwd();
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const effects = { mockFetchCalls: 0, forbiddenCalls: 0 };
  let nextResponse: Response | undefined;
  const forbidden = () => { effects.forbiddenCalls++; throw new Error("OFFLINE_SIDE_EFFECT_FORBIDDEN"); };
  const load = (relative: string): Record<string, unknown> => {
    const filename = path.resolve(root, relative);
    const cached = modules.get(filename);
    if (cached) return cached.exports;
    const fixture = { exports: {} as Record<string, unknown> };
    modules.set(filename, fixture);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const fixtureRequire = (specifier: string): unknown => {
      if (specifier === "node:crypto") return nodeCrypto;
      if (specifier === "@/lib/server-runtime-env") return { ensureServerRuntimeEnvLoaded() {} };
      if (specifier === "@/lib/llm-billing") return { settleLlmUsage: forbidden };
      if (specifier === "@/storage/database/supabase-client") return { getSupabaseClient: forbidden };
      if (specifier === "@/lib/llm-credit-reservation") return { releaseLlmStreamCredits: forbidden };
      if (specifier === "@/lib/llm-proxy/zhipu-proxy") return { zhipuChatStream: forbidden, zhipuChat: forbidden };
      if (specifier === "@/lib/business-ip/catalog") return { bipStep: () => false };
      if (specifier === "@/lib/business-ip/guard") return { containsPromptLeak: forbidden, messageText: forbidden };
      if (specifier === "@/lib/server/bip-guarded-stream") return { BipStreamPromptLeakError: class extends Error {}, createBipGuardedStream: forbidden };
      if (specifier === "@/lib/server/agent-chat-prompt-authority") return { requireAssistantPersistence: forbidden };
      if (specifier === "@/lib/llm-fallback") return { recordModelFailure() {}, recordModelSuccess: forbidden };
      const target = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return forbidden();
      return load(path.relative(root, `${target}.ts`));
    };
    vm.runInNewContext(code, {
      module: fixture, exports: fixture.exports, require: fixtureRequire, process: { env: {} },
      Response, Headers, URL, ReadableStream, WritableStream, TextEncoder, TextDecoder, AbortController,
      setTimeout, clearTimeout, setInterval, clearInterval,
      console: { log() {}, warn() {}, error() {} },
      fetch: async () => { effects.mockFetchCalls++; assert.ok(nextResponse); const response = nextResponse; nextResponse = undefined; return response; },
    }, { filename });
    return fixture.exports;
  };
  const errors = load("src/lib/llm-proxy/stream-error.ts") as unknown as typeof import("../src/lib/llm-proxy/stream-error");
  const { LLMProxy } = load("src/lib/llm-proxy/proxy.ts") as unknown as typeof import("../src/lib/llm-proxy/proxy");
  const { handleStreamResponse } = load("src/app/api/llm/handle-stream.ts") as unknown as typeof import("../src/app/api/llm/handle-stream");
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  let checks = 0;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(plain(actual), plain(expected), message); checks++; };
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const secret = "sk-private-fixture-DO-NOT-EMIT";
  const errorPayload = { error: { code: "unsupported_parameter", type: "invalid_request_error", param: "stream_options", message: secret }, diagnostics: { phase: "response_headers", transportStatus: 401, headers: { authorization: secret } } };
  const input = event({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }) + event(errorPayload);
  const proxy = () => new LLMProxy({ apiBase: "https://offline.invalid", apiKey: "fixture-only", protocol: "openai_chat", retryCount: 0, timeout: 1 });
  const request = { model: "offline-model", messages: [{ role: "user" as const, content: "fixture" }] };
  const frames = (text: string): Array<Record<string, unknown>> => text.split(/\r?\n/u).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  nextResponse = new Response(input, { status: 200 });
  const firstText = await new Response(await proxy().chatStream(request)).text();
  const first = frames(firstText).find(frame => frame.error)!;
  const firstDiagnostics = first.diagnostics as Record<string, unknown>;
  equal(first.code, "LLM_UPSTREAM_ERROR", "generic code unchanged");
  equal(firstDiagnostics.transportStatus, 200, "actual HTTP200 is distinct from SSE rejection");
  equal(firstDiagnostics.phase, "sse_event", "provider supplied nested phase cannot override measured phase");
  equal(firstDiagnostics.providerCode, "unsupported_parameter", "original code retained");
  equal(firstDiagnostics.providerType, "invalid_request_error", "original type retained");
  equal(firstDiagnostics.parameter, "stream_options", "parameter retained");
  equal(firstDiagnostics.receivedChars, input.length, "received wire characters measured");
  assert.ok(!firstText.includes(secret)); checks++;
  const ctx = { verifiedUserId: "offline", userRole: "admin", useModel: "offline-model", isZhipuAI: false, agentTimeout: 1,
    messages: [], clientRequestId: "offline-fixture", allowLiveStreamDelivery: true } as unknown as StreamHandlerContext;
  nextResponse = new Response(input, { status: 200 });
  const finalText = await handleStreamResponse(ctx, request, proxy()).text();
  const final = frames(finalText).find(frame => frame.error)!;
  const finalDiagnostics = final.diagnostics as Record<string, unknown>;
  equal({ ...finalDiagnostics, elapsedMs: 0 }, { ...firstDiagnostics, elapsedMs: 0 }, "actual proxy plus route double hop retains safe DTO");
  assert.ok(!finalText.includes(secret)); checks++;
  const malicious = errors.upstreamStreamError({ error: { code: secret, type: secret, param: secret, message: secret }, diagnostics: { phase: "sse_event", secret } }, { phase: "sse_event", transportStatus: 201 });
  equal(malicious.diagnostics, { phase: "sse_event", transportStatus: 201, providerCode: "unknown", providerType: "unknown", parameter: "unknown" }, "unknown values cannot escape allowlist");
  const revalidated = errors.upstreamStreamError({ error: "generic", diagnostics: { phase: "sse_event", transportStatus: 200, providerCode: secret, providerType: { secret }, parameter: secret, message: secret, nested: { secret }, elapsedMs: Infinity, receivedChars: -1 } });
  equal(revalidated.diagnostics, { phase: "sse_event", transportStatus: 200, providerCode: "unknown", parameter: "unknown" }, "second hop reconstructs hostile DTO");
  equal(errors.sanitizeLlmSafeDiagnostics({ phase: "sse_event", transportStatus: 200.5, elapsedMs: 86_400_001, receivedChars: 100_000_001, providerCode: "x".repeat(100_000), parameter: "x".repeat(100_000) }), { phase: "sse_event", providerCode: "unknown", parameter: "unknown" }, "length and numeric bounds");
  equal(errors.sanitizeLlmSafeDiagnostics({ phase: "sse_event", elapsedMs: 2.8, receivedChars: 3.9 }), { phase: "sse_event", elapsedMs: 2, receivedChars: 3 }, "finite counts normalized");
  assert.equal(errors.sanitizeLlmSafeDiagnostics({ phase: secret }), undefined); checks++;
  assert.equal(errors.upstreamStreamError({ error: "generic" }).diagnostics, undefined); checks++;
  equal(errors.buildLlmSafeDiagnostics({}, { phase: "sse_event" }), { phase: "sse_event" }, "missing transport status never defaults to 200");
  for (const parameter of ["stream_options.include_usage", "reasoning.effort", "thinking.type", "thinking.budget_tokens"]) {
    equal(errors.buildLlmSafeDiagnostics({ error: { code: "invalid_parameter", param: parameter } }, { phase: "sse_event" }),
      { phase: "sse_event", providerCode: "invalid_parameter", parameter }, "known nested parameter retained");
  }
  const httpBody = JSON.stringify({ error: { code: "invalid_model", type: "invalid_request_error", param: "model", message: secret } });
  nextResponse = new Response(httpBody, { status: 400 });
  const httpFinal = frames(await handleStreamResponse(ctx, request, proxy()).text()).find(frame => frame.error)!;
  const httpDiag = httpFinal.diagnostics as Record<string, unknown>;
  equal({ ...httpDiag, elapsedMs: 0 }, { phase: "response_headers", transportStatus: 400, elapsedMs: 0, receivedChars: httpBody.length, providerCode: "invalid_model", providerType: "invalid_request_error", parameter: "model" }, "actual HTTP error captured before message mapping");
  assert.ok(!JSON.stringify(httpFinal).includes(secret)); checks++;
  equal(effects, { mockFetchCalls: 3, forbiddenCalls: 0 }, "no real network, credentials, billing, database, or retries");
  console.log(JSON.stringify({ status: "passed", assertions: checks, effects }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
