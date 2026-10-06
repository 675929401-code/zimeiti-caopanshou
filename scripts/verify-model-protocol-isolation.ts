import assert from "node:assert/strict";
import { LLMProxy } from "../src/lib/llm-proxy/proxy";
import {
  LlmProviderBindingError,
  resolveLlmProviderBinding,
} from "../src/lib/llm-provider-contract";
import {
  ImageProviderBindingError,
  resolveImageProviderContract,
} from "../src/lib/image-provider-contract";
import { submitVideoTask } from "../src/lib/video-adapter";

type CapturedRequest = { url: string; headers: Headers; body: Record<string, unknown> };

async function verifyConcurrentLlmIsolation() {
  const originalFetch = globalThis.fetch;
  const captured: CapturedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    captured.push({ url, headers, body });
    if (url.includes("openai.example")) {
      await new Promise(resolve => setTimeout(resolve, 25));
      return Response.json({ model: "gpt-isolated", choices: [{ message: { content: "openai-ok" } }] });
    }
    return Response.json({ model: "claude-isolated", content: [{ type: "text", text: "anthropic-ok" }] });
  };

  try {
    const openai = new LLMProxy({
      apiBase: "https://openai.example/v1",
      apiKey: "openai-key",
      defaultModel: "gpt-isolated",
      provider: "channel-openai",
      protocol: "openai_chat",
      authScheme: "bearer",
      retryCount: 0,
    });
    const anthropic = new LLMProxy({
      apiBase: "https://anthropic.example/v1",
      apiKey: "anthropic-key",
      defaultModel: "claude-isolated",
      provider: "channel-anthropic",
      protocol: "anthropic_messages",
      authScheme: "x-api-key",
      protocolVersion: "2023-06-01",
      retryCount: 0,
    });

    const [openaiResult, anthropicResult] = await Promise.all([
      openai.chat({ model: "gpt-isolated", messages: [{ role: "user", content: "A" }] }),
      anthropic.chat({ model: "claude-isolated", messages: [{ role: "user", content: "B" }] }),
    ]);
    assert.equal(openaiResult.content, "openai-ok");
    assert.equal(anthropicResult.content, "anthropic-ok");

    const openaiRequest = captured.find(item => item.url.includes("openai.example"));
    const anthropicRequest = captured.find(item => item.url.includes("anthropic.example"));
    assert.ok(openaiRequest?.url.endsWith("/v1/chat/completions"));
    assert.equal(openaiRequest?.headers.get("authorization"), "Bearer openai-key");
    assert.equal(openaiRequest?.headers.get("x-api-key"), null);
    assert.ok(Array.isArray(openaiRequest?.body.messages));
    assert.ok(anthropicRequest?.url.endsWith("/v1/messages"));
    assert.equal(anthropicRequest?.headers.get("x-api-key"), "anthropic-key");
    assert.equal(anthropicRequest?.headers.get("authorization"), null);
    assert.equal(anthropicRequest?.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(anthropicRequest?.body.system, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function verifyExplicitBindings() {
  const openai = resolveLlmProviderBinding({ api_protocol_config: {
    provider: "lc_openai", protocol: "openai_chat_completions", auth_scheme: "bearer",
  } });
  assert.equal(openai.protocol, "openai_chat");
  assert.throws(() => resolveLlmProviderBinding({}), LlmProviderBindingError);

  for (const modelName of ["nano-banana-pro", "nano-banana-2"]) {
    const contract = resolveImageProviderContract({
      provider: "secure_skill_images",
      model_name: modelName,
      api_endpoint: "https://token.secure-skill.com/v1",
      supports_image_input: true,
      api_protocol_config: { protocol: "images_generations_async", reference_transport: "generations_url_array" },
    });
    assert.equal(contract.requestProtocol, "images_generations_async");
    assert.equal(contract.referenceTransport, "generations_url_array");
  }
  assert.throws(() => resolveImageProviderContract({
    provider: "secure_skill_chat",
    model_name: "gemini-3.1-flash-image",
    api_endpoint: "https://token.secure-skill.com/v1",
  }), ImageProviderBindingError);
}

async function verifyUnknownVideoProtocolFailsClosed() {
  await assert.rejects(
    submitVideoTask({
      id: "test",
      name: "test",
      model_name: "test",
      provider: "test-channel",
      protocol_type: "unknown_protocol",
      api_endpoint: "https://video.example/v1",
      api_key: "test-key",
      supports_image_input: false,
    } as never, { prompt: "test" } as never),
    /VIDEO_PROTOCOL_UNSUPPORTED:unknown_protocol/u,
  );
}

async function main() {
  verifyExplicitBindings();
  await verifyConcurrentLlmIsolation();
  await verifyUnknownVideoProtocolFailsClosed();
  console.log("PASS model protocol bindings are explicit and request-scoped");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
