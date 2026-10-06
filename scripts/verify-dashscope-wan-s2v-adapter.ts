import assert from "node:assert/strict";
import { resolveProviderSecret } from "../src/lib/provider-secret";
import { classifyVideoProviderError } from "../src/lib/video-error-policy";
import {
  pollVideoTask,
  submitVideoTask,
  type VideoModelConfig,
} from "../src/lib/video-adapter";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.DASHSCOPE_API_KEY;
const fixtureSecret = "fixture-dashscope-key-never-sent";

const config: VideoModelConfig = {
  id: "dashscope-wan2-2-s2v",
  name: "Wan 2.2 数字人口播",
  provider: "dashscope",
  api_endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis",
  api_key: fixtureSecret,
  protocol_type: "dashscope_wan_s2v",
  price_per_use: 0.5,
  duration_seconds: 8,
  supports_image_input: true,
  model_name: "wan2.2-s2v",
};

async function main() {
try {
  process.env.DASHSCOPE_API_KEY = fixtureSecret;
  assert.equal(resolveProviderSecret("env://DASHSCOPE_API_KEY"), fixtureSecret);
  assert.throws(
    () => resolveProviderSecret("env://UNAPPROVED_SECRET"),
    /未批准的环境变量密钥引用/,
  );

  let submitCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/face-detect')) {
      assert.equal(JSON.parse(String(init?.body)).model, 'wan2.2-s2v-detect');
      return Response.json({ output: { check_pass: true } });
    }
    submitCalls += 1;
    assert.equal(String(input), config.api_endpoint);
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["X-DashScope-Async"], "enable");
    assert.equal(headers.Authorization, `Bearer ${fixtureSecret}`);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      model: "wan2.2-s2v",
      input: {
        image_url: "https://assets.example.test/person.png",
        audio_url: "https://assets.example.test/speech.wav",
      },
      parameters: { style: "speech", resolution: "720P" },
    });
    return new Response(JSON.stringify({ output: { task_id: "fixture-task" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const missingAudio = await submitVideoTask(config, {
    prompt: "fixture",
    imageUrl: "https://assets.example.test/person.png",
  });
  assert.equal(missingAudio.status, "failed");
  assert.equal(submitCalls, 0);

  const submitted = await submitVideoTask(config, {
    prompt: "fixture prompt is intentionally not sent by the s2v contract",
    imageUrl: "https://assets.example.test/person.png",
    audioUrl: "https://assets.example.test/speech.wav",
    duration: 8,
    resolutionTier: "720p",
  });
  assert.deepEqual(submitted, { taskId: "fixture-task", status: "queued", progress: 0 });
  assert.equal(submitCalls, 1);

  const submittedFromReferenceAudio = await submitVideoTask(config, {
    prompt: "fixture",
    imageUrls: ["https://assets.example.test/person.png"],
    audioUrls: ["https://assets.example.test/speech.wav"],
    resolutionTier: "720p",
  });
  assert.equal(submittedFromReferenceAudio.status, "queued");
  assert.equal(submitCalls, 2);

  globalThis.fetch = async (input) => {
    assert.ok(String(input).endsWith('/face-detect'), 'failed portrait validation must not dispatch generation');
    return Response.json({ output: { check_pass: false } });
  };
  assert.equal((await submitVideoTask(config, { prompt: '', imageUrl: 'https://assets.example.test/person.png', audioUrl: 'https://assets.example.test/speech.wav' })).status, 'failed');

  // Real detector failure: Access denied alone was incorrectly classified as a bad key.
  for (const failure of [
    { status: 400, code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.', expected: 'CHANNEL_QUOTA_UNAVAILABLE' },
    { status: 401, code: 'InvalidApiKey', message: 'Invalid API-key provided.', expected: 'CHANNEL_AUTH_INVALID' },
  ]) {
    globalThis.fetch = async input => {
      assert.ok(String(input).endsWith('/face-detect'), 'detector rejection must not create a video');
      return Response.json({ code: failure.code, message: failure.message }, { status: failure.status });
    };
    const result = await submitVideoTask(config, { prompt: '', imageUrl: 'https://assets.example.test/person.png', audioUrl: 'https://assets.example.test/speech.wav' });
    assert.equal(result.status, 'failed');
    assert.ok(result.error?.includes(failure.code));
    assert.equal(classifyVideoProviderError(result.error, config.name).code, failure.expected);
  }

  const submit = () => submitVideoTask(config, {
    prompt: '',
    imageUrl: 'https://assets.example.test/person.png',
    audioUrl: 'https://assets.example.test/speech.wav',
  });
  globalThis.fetch = async input => String(input).endsWith('/face-detect')
    ? Response.json({ output: { check_pass: true } })
    : Response.json({ code: 'InvalidParameter', message: 'fixture rejected' }, { status: 400 });
  assert.equal((await submit()).status, 'failed', 'an explicit 4xx generation rejection is final');
  for (const status of [500, 502, 503]) {
    globalThis.fetch = async input => String(input).endsWith('/face-detect')
      ? Response.json({ output: { check_pass: true } })
      : Response.json({ code: 'GatewayError' }, { status });
    const uncertain = await submit();
    assert.equal(uncertain.status, 'processing');
    assert.equal(uncertain.submissionOutcome, 'unknown');
  }
  globalThis.fetch = async input => {
    if (String(input).endsWith('/face-detect')) return Response.json({ output: { check_pass: true } });
    throw new TypeError('fixture connection reset after dispatch');
  };
  assert.equal((await submit()).submissionOutcome, 'unknown');
  globalThis.fetch = async input => String(input).endsWith('/face-detect')
    ? Response.json({ output: { check_pass: true } })
    : Response.json({ output: {} });
  assert.equal((await submit()).submissionOutcome, 'unknown');

  const pollFixtures = [
    { output: { task_status: "PENDING" } },
    { output: { task_status: "RUNNING" } },
    { output: { task_status: "SUCCEEDED", results: { video_url: "https://results.example.test/video.mp4" } } },
    { output: { task_status: "FAILED", message: "fixture failure" } },
  ];
  let pollIndex = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://dashscope.aliyuncs.com/api/v1/tasks/fixture-task");
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify(pollFixtures[pollIndex++]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.equal((await pollVideoTask(config, "fixture-task")).status, "queued");
  assert.equal((await pollVideoTask(config, "fixture-task")).status, "processing");
  assert.deepEqual(await pollVideoTask(config, "fixture-task"), {
    taskId: "fixture-task",
    status: "success",
    videoUrl: "https://results.example.test/video.mp4",
    progress: 100,
  });
  const failed = await pollVideoTask(config, "fixture-task");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "fixture failure");

  console.log("DashScope wan2.2-s2v offline adapter fixture: PASS (real network=0, provider calls=0)");
} finally {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.DASHSCOPE_API_KEY;
  else process.env.DASHSCOPE_API_KEY = originalSecret;
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
