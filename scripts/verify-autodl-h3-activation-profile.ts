import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAutodlH3ActivationPlan } from "../src/lib/autodl-h3-activation-profile";
import { submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

function readJson(relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mockJson(payload: Record<string, unknown>, status = 202) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function verifyProfileAndGatewayContract() {
  const baseline = readJson("scripts/config/autodl-h3-selfhost-activation-profile.example.json");
  const baselinePlan = buildAutodlH3ActivationPlan(baseline);
  assert.deepEqual(baselinePlan.videoProtocolConfig.resolution_options, ["480p", "2K"]);
  assert.deepEqual(baselinePlan.videoProtocolConfig.direct_verified_combinations, [
    "480p|5|16:9",
    "480p|10|16:9",
    "2K|15|16:9",
  ]);

  const verified = readJson("scripts/config/autodl-h3-selfhost-activation-profile.verified.json");
  const plan = buildAutodlH3ActivationPlan(verified);
  assert.deepEqual(plan.videoProtocolConfig.resolution_options, ["480p", "1080p", "2K"]);
  assert.deepEqual(plan.videoProtocolConfig.resolution_labels, {
    "480p": "480p 原生",
    "1080p": "1080p增强",
    "2K": "2K增强",
  });
  assert.deepEqual(plan.videoProtocolConfig.resolution_status, {
    "480p": "verified",
    "1080p": "derived",
    "2K": "verified",
  });
  assert.deepEqual(plan.videoProtocolConfig.gateway_output_tier_by_resolution, {
    "480p": "base",
    "1080p": "1080p",
    "2K": "2K",
  });
  assert.deepEqual(plan.videoProtocolConfig.output_pixel_size_by_resolution, {
    "480p": { "16:9": "864x480" },
    "1080p": { "16:9": "1920x1080" },
    "2K": { "16:9": "2560x1440" },
  });
  assert.equal((plan.videoProtocolConfig.supported_combinations as string[]).length, 9);
  assert.deepEqual(plan.videoProtocolConfig.direct_verified_combinations, [
    "480p|5|16:9",
    "480p|10|16:9",
    "2K|5|16:9",
    "2K|15|16:9",
  ]);
  assert.equal(
    (plan.videoProtocolConfig.combination_verification_mode as Record<string, string>)["2K|5|16:9"],
    "direct",
  );
  assert.equal(
    (plan.videoProtocolConfig.combination_verification_mode as Record<string, string>)["1080p|5|16:9"],
    "derived",
  );
  assert.match(String(plan.videoProtocolConfig.verification_notice), /不宣称为逐组合直接实测/u);

  const falseDirectClaim = clone(verified);
  const falseDirectVideo = falseDirectClaim.video as Record<string, unknown>;
  falseDirectVideo.direct_verified_combinations = ["1080p|5|16:9"];
  assert.throws(() => buildAutodlH3ActivationPlan(falseDirectClaim), /直接实测组合超出/u);

  const unverified2K = clone(verified);
  const unverifiedVideo = unverified2K.video as Record<string, unknown>;
  const unverifiedResolutions = unverifiedVideo.resolutions as Record<string, Record<string, unknown>>;
  unverifiedResolutions["2K"].verified = false;
  assert.throws(() => buildAutodlH3ActivationPlan(unverified2K), /2K增强.*verified=true/u);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  const responses = [
    mockJson({ id: "h3_aaaaaaaa", status: "queued", output_tier: "base" }),
    mockJson({ id: "h3_bbbbbbbb", status: "queued", output_tier: "1080p" }),
    mockJson({ id: "h3_cccccccc", status: "queued", output_tier: "2K" }),
  ];
  globalThis.fetch = async (_input, init) => {
    const response = responses.shift();
    assert.ok(response, "unexpected fetch");
    calls.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
    return response;
  };

  const config: VideoModelConfig = {
    id: "minimax-h3-turbo",
    name: "fixture",
    model_name: "minimax-h3-turbo",
    provider: "autodl_h3_selfhost",
    protocol_type: "autodl_h3_selfhost",
    api_endpoint: "http://127.0.0.1:16011/v1/video/generations",
    api_key: "fixture-token-not-a-secret",
    price_per_use: 0,
    duration_seconds: 10,
    supports_image_input: true,
    api_protocol_config: plan.videoProtocolConfig as VideoModelConfig["api_protocol_config"],
  };
  try {
    for (const tier of ["480p", "1080p", "2K"] as const) {
      await submitVideoTask(config, {
        prompt: "local fixture only",
        duration: 10,
        aspectRatio: "16:9",
        resolution: tier,
        resolutionTier: tier,
      });
    }
    const blockedConfig: VideoModelConfig = {
      ...config,
      api_protocol_config: {
        ...config.api_protocol_config,
        supported_combinations: ["480p|10|16:9"],
      },
    };
    await assert.rejects(
      () => submitVideoTask(blockedConfig, {
        prompt: "blocked local fixture only",
        duration: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        resolutionTier: "1080p",
      }),
      /尚未开放 1080p\|10\|16:9/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.size), ["864x480", "864x480", "864x480"]);
  assert.deepEqual(calls.map((call) => call.output_tier), ["base", "1080p", "2K"]);
  assert.equal(responses.length, 0);
}

function verifyAtomicMigrationIsNarrow() {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/migrations/20260821_autodl_h3_model_activation.sql"),
    "utf8",
  );
  assert.match(source, /activate_autodl_h3_selfhost_models_v1/u);
  assert.match(source, /direct_verified_combinations/u);
  assert.match(source, /supported_combinations/u);
  assert.match(source, /combination_verification_mode/u);
  assert.match(source, /resolution_verification_mode/u);
  assert.ok((source.match(/where id = 'minimax-h3-turbo-selfhost-pro6000'/gu) || []).length >= 2);
  assert.ok((source.match(/where id = 'qwen-image-2512-hq-selfhost-pro6000'/gu) || []).length >= 2);
  assert.equal((source.match(/update public\.video_models/gu) || []).length, 2, "only activate/deactivate may update video_models");
  assert.equal((source.match(/update public\.cover_models/gu) || []).length, 2, "only activate/deactivate may update cover_models");
  assert.doesNotMatch(source, /\bupsert\b/iu);
  assert.match(source, /v_video_updated <> 1 or v_image_updated <> 1/u);
}

function verifyUiAndRealChainSurfaces() {
  const publicDto = fs.readFileSync(path.join(process.cwd(), "src/lib/public-model-dto.ts"), "utf8");
  const modelsRoute = fs.readFileSync(path.join(process.cwd(), "src/app/api/video/models/route.ts"), "utf8");
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/video/page.tsx"), "utf8");
  const realChain = fs.readFileSync(path.join(process.cwd(), "scripts/validate-autodl-h3-v26-chain.ts"), "utf8");
  assert.match(publicDto, /"resolutionLabels"/u);
  assert.match(publicDto, /"directVerifiedCombinations", "verificationNotice"/u);
  assert.match(modelsRoute, /direct_verified_combinations/u);
  assert.match(page, /resolutionCapabilities\.labels\[value\]/u);
  assert.match(page, /selectedModel\?\.verificationNotice/u);
  assert.match(realChain, /H3_VALIDATION_RESOLUTION/u);
  assert.match(realChain, /"2K": \{ label: "2K增强", width: 2560, height: 1440 \}/u);
  assert.match(realChain, /probedVideo\.codec_name, "h264"/u);
  assert.match(realChain, /fpsNumerator \/ fpsDenominator - 24/u);
  assert.ok(realChain.includes(String.raw`assert.match(mediaLog, /Audio:\s*aac/iu`));
  assert.match(realChain, /Math\.abs\(durationSeconds - 5\.167\)/u);
  assert.match(realChain, /decodedFrames, 124/u);
  assert.match(realChain, /resolution:\s*"2K"/u);
}

async function main() {
  await verifyProfileAndGatewayContract();
  verifyAtomicMigrationIsNarrow();
  verifyUiAndRealChainSurfaces();
  console.log("AutoDL H3 activation/profile verification passed (mock/static only; zero network and zero paid requests).\n");
}

void main();
