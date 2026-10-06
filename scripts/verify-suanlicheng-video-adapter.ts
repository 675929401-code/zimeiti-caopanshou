import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

const baseConfig: VideoModelConfig = {
  id: "minimax-h3-768p-lc",
  name: "MiniMax H3 · 768P · 渠道LC",
  provider: "suanlicheng_video",
  protocol_type: "suanlicheng_video",
  api_endpoint: "https://pro.nat6.net/v1",
  api_key: "test-only-key",
  price_per_use: 1.2,
  duration_seconds: 5,
  supports_image_input: true,
  model_name: "MiniMax-H3 768P",
};

const originalFetch = globalThis.fetch;
const originalTrustedHosts = process.env.DIGITAL_HUMAN_TRUSTED_RELAY_HOSTNAMES;
const calls: Array<{ url: string; method: string; body?: unknown; idempotencyKey?: string | null }> = [];
let materialIndex = 0;

async function main() {
  process.env.DIGITAL_HUMAN_TRUSTED_RELAY_HOSTNAMES = "cdn.jsdelivr.net";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ url, method, body, idempotencyKey: new Headers(init?.headers).get('X-Idempotency-Key') });

    if (url === "https://cdn.jsdelivr.net/reference.png") {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "4" },
      });
    }
    if (url.endsWith("/v1/h3/materials")) {
      materialIndex += 1;
      return Response.json({
        object: "h3.material",
        material: {
          material_id: `h3-image-test-${materialIndex}`,
          sha256: `sha-${materialIndex}`,
          object_revision: 1,
        },
      });
    }
    if (url.endsWith("/v1/h3/videos/generations") && method === "POST") {
      return Response.json({ id: "lc-task-001", status: "queued" }, { status: 202 });
    }
    if (url.endsWith("/v1/h3/videos/generations/lc-task-001")) {
      return Response.json({ id: "lc-task-001", status: "completed" });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const submitted = await submitVideoTask(baseConfig, {
      prompt: "角色转身看向镜头，镜头缓慢推进。",
      imageUrl: "https://cdn.jsdelivr.net/reference.png",
      duration: 10,
      aspectRatio: "9:16",
      resolutionTier: "768p",
    });
    assert.equal(submitted.taskId, "lc-task-001", submitted.error);
    assert.equal(submitted.status, "queued");

    const generationCall = calls.find((call) => call.url.endsWith("/v1/h3/videos/generations") && call.method === "POST");
    assert.ok(generationCall);
    const generationBody = generationCall.body as Record<string, unknown>;
    assert.equal(generationBody.task, "multi_reference_to_video");
    assert.equal(generationBody.model, "MiniMax-H3 768P");
    assert.equal(generationBody.frames, 243);
    assert.equal(generationBody.width, 768);
    assert.equal(generationBody.height, 1344);
    assert.equal(typeof generationBody.seed, "number");
    assert.equal(typeof generationBody.idempotency_key, "string");
    assert.match(String(generationBody.prompt), /<Picture 1>/u);
    assert.deepEqual(generationBody.materials, [{
      material_id: "h3-image-test-1",
      sha256: "sha-1",
      object_revision: 1,
    }]);

    const completed = await pollVideoTask(baseConfig, submitted.taskId);
    assert.deepEqual(completed, {
      taskId: "lc-task-001",
      status: "success",
      videoUrl: "https://pro.nat6.net/v1/h3/videos/generations/lc-task-001/content",
      progress: 1,
      needsProxy: true,
    });

    const config2K = { ...baseConfig, id: "minimax-h3-2k-lc", model_name: "MiniMax-H3 2K" };
    const normalFetch = globalThis.fetch;
    for (const config of [baseConfig, config2K]) {
      const stableKey = `original-business-task:${config.id}`;
      const before = materialIndex;
      const fromArray = await submitVideoTask(config, {
        prompt: '数组参考图', imageUrls: ['https://cdn.jsdelivr.net/reference.png', 'https://cdn.jsdelivr.net/reference.png'],
        duration: 5, aspectRatio: '16:9', idempotencyKey: stableKey,
      });
      assert.equal(fromArray.status, 'queued');
      assert.equal(materialIndex, before + 1, 'Repeated reference must upload only once');
      const last = calls.filter(call => call.url.endsWith('/v1/h3/videos/generations')).at(-1)!;
      assert.equal((last.body as Record<string, unknown>).idempotency_key, stableKey);
      assert.equal(last.idempotencyKey, stableKey);
    }
    const arrayAudioRejected = await submitVideoTask(config2K, {
      prompt: '测试', imageUrls: ['https://cdn.jsdelivr.net/reference.png'], audioUrls: ['https://cdn.jsdelivr.net/reference.mp3'], duration: 5,
    });
    assert.equal(arrayAudioRejected.status, 'failed');
    assert.match(arrayAudioRejected.error || '', /2K 不支持音频/u);

    for (const kind of ['timeout', 'invalid-json', 'missing-id', 'server-error', 'request-timeout', 'rejected', 'terminal-failed'] as const) {
      let dispatched = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/v1/h3/videos/generations')) {
          dispatched++;
          if (kind === 'timeout') throw new DOMException('fixture timeout', 'TimeoutError');
          if (kind === 'invalid-json') return new Response('not json');
          if (kind === 'server-error') return Response.json({ message: 'temporarily unavailable' }, { status: 503 });
          if (kind === 'request-timeout') return Response.json({ message: 'timeout' }, { status: 408 });
          if (kind === 'rejected') return Response.json({ message: 'invalid input' }, { status: 400 });
          if (kind === 'terminal-failed') return Response.json({ status: 'failed', message: 'rejected' });
          return Response.json({ status: 'queued' });
        }
        return normalFetch(input, init);
      };
      const result = await submitVideoTask(baseConfig, { prompt: '回归', imageUrls: ['https://cdn.jsdelivr.net/reference.png'], duration: 5, idempotencyKey: 'immutable-original-task' });
      assert.equal(dispatched, 1, 'Adapter must never replay generation');
      const unknown = !['rejected', 'terminal-failed'].includes(kind);
      assert.equal(result.status, unknown ? 'processing' : 'failed');
      assert.equal(result.submissionOutcome, unknown ? 'unknown' : undefined);
    }
    let generationCalls = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/v1/h3/videos/generations')) generationCalls++;
      if (String(input).endsWith('/v1/h3/materials')) throw new Error('material upload interrupted');
      return normalFetch(input, init);
    };
    const beforeDispatchFailure = await submitVideoTask(baseConfig, { prompt: '回归', imageUrls: ['https://cdn.jsdelivr.net/reference.png'], duration: 5 });
    assert.equal(beforeDispatchFailure.status, 'failed');
    assert.equal(beforeDispatchFailure.submissionOutcome, undefined);
    assert.equal(generationCalls, 0);
    globalThis.fetch = normalFetch;
    for (const status of [401, 403, 404, 408, 429, 503]) {
      globalThis.fetch = async () => Response.json({ message: 'query unavailable' }, { status });
      const retained = await pollVideoTask(baseConfig, 'same-paid-task');
      assert.equal(retained.status, 'processing');
      assert.equal(retained.taskId, 'same-paid-task');
      assert.equal(retained.progress, null);
    }
    globalThis.fetch = normalFetch;
    const audioRejected = await submitVideoTask(config2K, {
      prompt: "测试",
      imageUrl: "https://cdn.jsdelivr.net/reference.png",
      audioUrl: "https://cdn.jsdelivr.net/reference.mp3",
      duration: 5,
      aspectRatio: "16:9",
    });
    assert.equal(audioRejected.status, "failed");
    assert.match(audioRejected.error || "", /2K 不支持音频/u);

    globalThis.fetch = (async () => Response.json({
      id: "lc-task-2k",
      status: "completed",
      resolution: "768P",
      video_url: "https://cdn.example.com/degraded.mp4",
    })) as typeof fetch;
    const degraded = await pollVideoTask(config2K, "lc-task-2k");
    assert.equal(degraded.status, "failed");
    assert.match(degraded.error || "", /无降级策略/u);

    console.log("Suanlicheng LC MiniMax H3 adapter verification: PASS (no paid request)");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTrustedHosts === undefined) delete process.env.DIGITAL_HUMAN_TRUSTED_RELAY_HOSTNAMES;
    else process.env.DIGITAL_HUMAN_TRUSTED_RELAY_HOSTNAMES = originalTrustedHosts;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
