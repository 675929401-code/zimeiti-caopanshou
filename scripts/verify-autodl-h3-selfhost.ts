import assert from "node:assert/strict";
import {
  pollVideoTask,
  submitVideoTask,
  type VideoModelConfig,
} from "../src/lib/video-adapter";
import { readAutodlH3SelfhostResult } from "../src/lib/autodl-h3-selfhost";

type FetchCall = {
  url: string;
  method: string;
  authorization: string;
  idempotencyKey: string;
  body: Record<string, unknown> | null;
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function main() {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const expires = String(Math.floor(Date.now() / 1000) + 600);
  const signature = "a".repeat(64);
  const signedPath = `/v1/files/h3_deadbeef?expires=${expires}&sig=${signature}`;
  const responses = [
    () => jsonResponse({ id: "h3_deadbeef", status: "queued" }, 202),
    () => jsonResponse({ id: "h3_facefeed", status: "queued", output_tier: "1080p" }, 202),
    () => jsonResponse({ id: "h3_cafebabe", status: "queued", output_tier: "2K" }, 202),
    () => jsonResponse({
      id: "h3_deadbeef",
      status: "completed",
      data: {
        url: signedPath,
        width: 2560,
        height: 1440,
        output_tier: "2K",
        enhancement_kind: "lanczos_postprocess",
      },
    }),
    () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
      status: 200,
      headers: { "Content-Type": "video/mp4", "Content-Length": "8" },
    }),
    () => jsonResponse({
      id: "h3_deadbeef",
      status: "completed",
      data: [{
        url: `https://cross-origin.invalid/v1/files/h3_deadbeef?expires=${expires}&sig=${signature}`,
      }],
    }),
    () => jsonResponse({ id: "legacy-task-1", status: "queued" }),
  ];

  globalThis.fetch = async (input, init) => {
    const responder = responses.shift();
    assert.ok(responder, `unexpected fetch attempted: ${String(input)}`);
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: String(init?.method || "GET"),
      authorization: headers.get("authorization") || "",
      idempotencyKey: headers.get("idempotency-key") || "",
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    });
    return responder();
  };

  const selfhostConfig: VideoModelConfig = {
    id: "minimax-h3-selfhost-fixture",
    name: "MiniMax H3 Self-host Fixture",
    provider: "autodl_h3_selfhost",
    api_endpoint: "http://127.0.0.1:16011/v1/video/generations",
    api_key: "fixture-token-not-a-secret",
    protocol_type: "autodl_h3_selfhost",
    price_per_use: 0,
    duration_seconds: 10,
    supports_image_input: false,
    model_name: "minimax-h3-turbo",
    api_protocol_config: {
      resolution_options: ["480p", "1080p", "2K"],
      input_pixel_size_by_resolution: {
        "480p": { "16:9": "864x480", "9:16": "480x864", "1:1": "768x768" },
        "1080p": { "16:9": "864x480" },
        "2K": { "16:9": "864x480" },
      },
      output_pixel_size_by_resolution: {
        "480p": { "16:9": "864x480", "9:16": "480x864", "1:1": "768x768" },
        "1080p": { "16:9": "1920x1080" },
        "2K": { "16:9": "2560x1440" },
      },
      gateway_output_tier_by_resolution: { "480p": "base", "1080p": "1080p", "2K": "2K" },
    },
  };

  try {
    const submitted = await submitVideoTask(selfhostConfig, {
      prompt: "A fixture prompt that must never leave this process.",
      duration: 10,
      aspectRatio: "16:9",
      idempotencyKey: "fixture-idempotency-0001",
    });

    assert.deepEqual(submitted, {
      taskId: "h3_deadbeef",
      status: "queued",
    });
    assert.deepEqual(calls[0], {
      url: "http://127.0.0.1:16011/v1/video/generations",
      method: "POST",
      authorization: "Bearer fixture-token-not-a-secret",
      idempotencyKey: "fixture-idempotency-0001",
      body: {
        model: "minimax-h3-turbo",
        prompt: "A fixture prompt that must never leave this process.",
        size: "864x480",
        duration: 10,
        aspect_ratio: "16:9",
        output_tier: "base",
      },
    });

    const submitted1080p = await submitVideoTask(selfhostConfig, {
      prompt: "1080p enhancement fixture",
      duration: 10,
      aspectRatio: "16:9",
      resolution: "1080p",
      resolutionTier: "1080p",
    });
    assert.deepEqual(submitted1080p, { taskId: "h3_facefeed", status: "queued" });
    assert.deepEqual(calls[1].body, {
      model: "minimax-h3-turbo",
      prompt: "1080p enhancement fixture",
      size: "864x480",
      duration: 10,
      aspect_ratio: "16:9",
      output_tier: "1080p",
    });

    const submitted2k = await submitVideoTask(selfhostConfig, {
      prompt: "2K enhancement fixture",
      duration: 15,
      aspectRatio: "16:9",
      resolution: "2K",
      resolutionTier: "2K",
    });
    assert.deepEqual(submitted2k, { taskId: "h3_cafebabe", status: "queued" });
    assert.deepEqual(calls[2].body, {
      model: "minimax-h3-turbo",
      prompt: "2K enhancement fixture",
      size: "864x480",
      duration: 15,
      aspect_ratio: "16:9",
      output_tier: "2K",
    });

    const completed = await pollVideoTask(selfhostConfig, submitted.taskId);
    assert.equal(completed.status, "success");
    assert.equal(completed.taskId, "h3_deadbeef");
    assert.equal(
      completed.videoUrl,
      `http://127.0.0.1:16011${signedPath}`,
    );
    assert.deepEqual(calls[3], {
      url: "http://127.0.0.1:16011/v1/video/generations/h3_deadbeef",
      method: "GET",
      authorization: "Bearer fixture-token-not-a-secret",
      idempotencyKey: "",
      body: null,
    });

    const imported = await readAutodlH3SelfhostResult(
      completed.videoUrl || "",
      selfhostConfig.api_endpoint,
      { maxBytes: 1024, allowedContentTypes: ["video/mp4"] },
    );
    assert.equal(imported.buffer.byteLength, 8);
    assert.deepEqual(calls[4], {
      url: `http://127.0.0.1:16011${signedPath}`,
      method: "GET",
      authorization: "",
      idempotencyKey: "",
      body: null,
    });

    const callsBeforeInvalidInputs = calls.length;
    await assert.rejects(
      submitVideoTask(selfhostConfig, {
        prompt: "invalid duration fixture",
        duration: 11,
        aspectRatio: "16:9",
      }),
      /仅支持 5、10、15 秒/u,
    );
    await assert.rejects(
      submitVideoTask(selfhostConfig, {
        prompt: "invalid aspect ratio fixture",
        duration: 10,
        aspectRatio: "4:3",
      }),
      /仅支持 16:9、9:16、1:1/u,
    );
    assert.equal(calls.length, callsBeforeInvalidInputs, "invalid inputs must fail before fetch");

    await assert.rejects(
      pollVideoTask(selfhostConfig, "h3_deadbeef"),
      /结果地址跨域/u,
    );
    assert.equal(calls[5].method, "GET");

    const legacyConfig: VideoModelConfig = {
      id: "legacy-openai-fixture",
      name: "Legacy OpenAI-compatible Fixture",
      provider: "fixture",
      api_endpoint: "https://openai-compatible.invalid/v1/video/generations",
      api_key: "legacy-fixture-token",
      protocol_type: "openai_compatible",
      price_per_use: 0,
      duration_seconds: 5,
      supports_image_input: false,
      model_name: "legacy-video-model",
    };
    const legacySubmitted = await submitVideoTask(legacyConfig, {
      prompt: "legacy dispatch fixture",
      duration: 5,
      aspectRatio: "16:9",
      resolution: "1280x720",
    });
    assert.equal(legacySubmitted.taskId, "legacy-task-1");
    assert.equal(legacySubmitted.status, "processing");
    assert.deepEqual(calls[6], {
      url: "https://openai-compatible.invalid/v1/video/generations",
      method: "POST",
      authorization: "Bearer legacy-fixture-token",
      idempotencyKey: "",
      body: {
        model: "legacy-video-model",
        prompt: "legacy dispatch fixture",
        size: "1280x720",
        duration: 5,
        aspect_ratio: "16:9",
      },
    });

    assert.equal(responses.length, 0, "all mock responses must be consumed exactly once");
    assert.equal(calls.length, 7, "the contract suite must perform exactly seven mocked fetches");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("AutoDL H3 self-host contract verification passed (mock only; zero network and zero paid requests).\n");
}

void main();
