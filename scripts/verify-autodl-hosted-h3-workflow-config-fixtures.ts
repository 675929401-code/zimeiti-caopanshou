import assert from "node:assert/strict";

import { buildAutoDLHostedH3CatalogRecords } from "../src/lib/autodl-hosted-h3-workflow-catalog";
import {
  submitVideoTask,
  type VideoGenerateParams,
  type VideoModelConfig,
} from "../src/lib/video-adapter";

type CapturedRequest = {
  url: string;
  method: string;
  authorization: string;
  body: Record<string, unknown>;
};

const BASE_PARAMS: VideoGenerateParams = {
  prompt: "A production-safe protocol fixture.",
  duration: 5,
  aspectRatio: "16:9",
  resolutionTier: "768p",
};

const FIXTURES: Readonly<Record<string, {
  params: VideoGenerateParams;
  assertBody: (body: Record<string, unknown>) => void;
}>> = {
  minimax_h3_lightx2v_v5: {
    params: {
      ...BASE_PARAMS,
      imageUrl: "https://assets.example/primary.png",
      imageUrls: Array.from({ length: 8 }, (_, index) => `https://assets.example/ref-${index + 1}.png`),
      duration: 10,
      aspectRatio: "1:1",
      resolutionTier: "1080p",
    },
    assertBody: (body) => {
      assert.equal(body.duration, 10);
      assert.equal(body.resolution, "1080p(1:1)");
      assert.equal(body.ref_image_0, "https://assets.example/primary.png");
      assert.equal(body.ref_image_8, "https://assets.example/ref-8.png");
      assert.equal(body.ref_image_9, undefined);
    },
  },
  minimax_h3_lightx2v_no_pic: {
    params: { ...BASE_PARAMS, duration: 15, aspectRatio: "9:16", resolutionTier: "768p" },
    assertBody: (body) => {
      assert.equal(body.prompt, BASE_PARAMS.prompt);
      assert.equal(body.duration, 15);
      assert.equal(body.resolution, "768p竖");
      assert.equal(body.ref_image_0, undefined);
      assert.equal(body.ref_audio_0, undefined);
    },
  },
  minimax_h3_lightx2v: {
    params: {
      ...BASE_PARAMS,
      imageUrl: "https://assets.example/first.png",
      lastFrameUrl: "https://assets.example/last.png",
      duration: 15,
      aspectRatio: "16:9",
      resolutionTier: "768p",
    },
    assertBody: (body) => {
      assert.equal(body.first_frame, "https://assets.example/first.png");
      assert.equal(body.last_frame, "https://assets.example/last.png");
      assert.equal(body.duration, 15);
      assert.equal(body.ref_image_0, undefined);
    },
  },
  minimax_h3_lightx2v_v5_15s: {
    params: {
      ...BASE_PARAMS,
      imageUrl: "https://assets.example/primary.png",
      duration: 15,
      aspectRatio: "1:1",
      resolutionTier: "768p",
    },
    assertBody: (body) => {
      assert.equal(body.duration, 15);
      assert.equal(body.resolution, "768p(1:1)");
      assert.equal(body.ref_image_0, "https://assets.example/primary.png");
    },
  },
  minimax_h3_image_audio_to_video: {
    params: {
      ...BASE_PARAMS,
      imageUrl: "https://assets.example/speaker.png",
      audioUrl: "https://assets.example/voice.wav",
      duration: 15,
      aspectRatio: "9:16",
      resolutionTier: "1080p",
    },
    assertBody: (body) => {
      assert.equal(body.prompt, undefined);
      assert.equal(body.duration, undefined);
      assert.equal(body.audio_duration, 15);
      assert.equal(body.resolution, "1080p竖");
      assert.equal(body.ref_image_0, "https://assets.example/speaker.png");
      assert.equal(body.ref_audio_0, "https://assets.example/voice.wav");
    },
  },
  minimax_h3_image_audio_to_video_v2: {
    params: {
      ...BASE_PARAMS,
      imageUrl: "https://assets.example/primary.png",
      imageUrls: Array.from({ length: 8 }, (_, index) => `https://assets.example/ref-${index + 1}.png`),
      audioUrls: [
        "https://assets.example/audio-0.wav",
        "https://assets.example/audio-1.mp3",
        "https://assets.example/audio-2.flac",
      ],
      duration: 10,
      aspectRatio: "16:9",
      resolutionTier: "1080p",
    },
    assertBody: (body) => {
      assert.equal(body.duration, 10);
      assert.equal(body.resolution, "1080p横");
      assert.equal(body.ref_image_8, "https://assets.example/ref-8.png");
      assert.equal(body.ref_audio_2, "https://assets.example/audio-2.flac");
    },
  },
  minimax_h3_image_audio_to_video_v2_15s: {
    params: {
      ...BASE_PARAMS,
      duration: 15,
      aspectRatio: "9:16",
      resolutionTier: "768p",
    },
    assertBody: (body) => {
      assert.equal(body.duration, 15);
      assert.equal(body.resolution, "768p竖");
      assert.equal(body.ref_image_0, undefined);
      assert.equal(body.ref_audio_0, undefined);
    },
  },
};

async function main() {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: String(init?.method || "GET"),
      authorization: headers.get("authorization") || "",
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
    });
    return new Response(JSON.stringify({
      code: "Success",
      data: { task_id: `fixture-${requests.length}`, status: "QUEUED" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const records = buildAutoDLHostedH3CatalogRecords();
    const failures: string[] = [];
    for (const record of records) {
      const fixture = FIXTURES[record.model_name];
      assert.ok(fixture, `missing fixture for ${record.model_name}`);
      const result = await submitVideoTask({
        ...record,
        api_key: "fixture-comfyui-token",
      } as VideoModelConfig, fixture.params);
      if (result.status !== "queued") {
        failures.push(`${record.model_name}: ${result.error || `unexpected ${result.status}`}`);
        continue;
      }
      assert.match(result.taskId, /^fixture-\d+$/u);
      const request = requests.at(-1);
      assert.ok(request);
      assert.equal(request.method, "POST");
      assert.equal(request.authorization, "fixture-comfyui-token");
      assert.equal(request.url, `https://www.autodl.art/api/v1/comfyui/comfyui_workflow/${record.model_name}`);
      fixture.assertBody(request.body);
    }

    assert.deepEqual(failures, [], `workflow fixture failures:\n${failures.join("\n")}`);
    assert.equal(requests.length, records.length);
    console.log(JSON.stringify({
      passed: true,
      workflow_count: records.length,
      mocked_requests: requests.length,
      real_network_calls: 0,
      paid_generation_calls: 0,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
