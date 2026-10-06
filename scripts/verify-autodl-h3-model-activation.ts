import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildAutodlH3ActivationPlan } from "../src/lib/autodl-h3-activation-profile";

type JsonRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function main() {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("zero-network regression attempted fetch");
  };

  try {
    const root = process.cwd();
    const profilePath = path.join(root, "scripts", "config", "autodl-h3-selfhost-activation-profile.verified.json");
    const migrationPath = path.join(root, "scripts", "migrations", "20260821_autodl_h3_model_activation.sql");
    const configurePath = path.join(root, "scripts", "configure-autodl-h3-selfhost.ts");
    const fullChainPath = path.join(root, "scripts", "validate-autodl-h3-v26-chain.ts");
    const profile = JSON.parse(await readFile(profilePath, "utf8")) as JsonRecord;
    const plan = buildAutodlH3ActivationPlan(profile);
    const config = plan.videoProtocolConfig as JsonRecord;

    assert.deepEqual(config.duration_options, [5, 10, 15]);
    assert.deepEqual(config.resolution_options, ["480p", "1080p", "2K"]);
    assert.deepEqual(config.gateway_output_tier_by_resolution, { "480p": "base", "1080p": "1080p", "2K": "2K" });
    assert.equal(config.default_resolution, "480p");
    assert.equal(config.default_duration, 10);
    assert.match(plan.videoName, /MiniMax H3 Turbo · 自租实例/u);
    assert.doesNotMatch(plan.videoName, /PRO6000|5090/iu);
    assert.match(plan.videoName, /480p 原生.*1080p增强.*2K增强/u);
    assert.match(plan.videoAdminNotes, /历史能力验收硬件：RTX PRO 6000/u);
    assert.match(plan.videoAdminNotes, /当前实例已更换为 RTX 5090/u);
    assert.match(plan.videoAdminNotes, /单条 canary/u);
    assert.match(plan.videoAdminNotes, /增强档为网关后处理输出/u);
    assert.match(plan.imageName, /16:9=3640×2048 实测输出/u);
    assert.deepEqual(plan.imageRequestPixelSizes, { "16:9": "1280x720" });
    assert.deepEqual(plan.imageOutputPixelSizes, { "16:9": "3640x2048" });

    assert.deepEqual(config.resolution_status, { "480p": "verified", "1080p": "derived", "2K": "verified" });
    assert.deepEqual(config.resolution_verification_mode, {
      "480p": "direct",
      "1080p": "derived_from_higher_tier",
      "2K": "direct",
    });
    assert.equal((config.supported_combinations as string[]).length, 9);
    assert.deepEqual(config.direct_verified_combinations, ["480p|5|16:9", "480p|10|16:9", "2K|5|16:9", "2K|15|16:9"]);
    assert.equal((config.combination_verification_mode as JsonRecord)["2K|5|16:9"], "direct");
    assert.equal((config.combination_verification_mode as JsonRecord)["2K|10|16:9"], "derived");
    assert.match(String(config.verification_notice), /不宣称为逐组合直接实测/u);

    assert.equal((config.combination_verification_mode as JsonRecord)["1080p|5|16:9"], "derived");

    const unsupportedDerivedProfile = clone(profile);
    const unsupportedDerivedVideo = unsupportedDerivedProfile.video as JsonRecord;
    const unsupportedDerivedResolutions = unsupportedDerivedVideo.resolutions as JsonRecord;
    (unsupportedDerivedResolutions["1080p"] as JsonRecord).derived_from_tier = "480p";
    assert.throws(
      () => buildAutodlH3ActivationPlan(unsupportedDerivedProfile),
      /仅允许 1080p增强/u,
      "1080p 推导必须严格来自直接实测 2K 档",
    );

    const missingDirectParentProfile = clone(profile);
    const missingDirectParentVideo = missingDirectParentProfile.video as JsonRecord;
    const missingDirectParentResolutions = missingDirectParentVideo.resolutions as JsonRecord;
    (missingDirectParentResolutions["2K"] as JsonRecord).verification_mode = "derived_from_higher_tier";
    (missingDirectParentResolutions["2K"] as JsonRecord).verified = false;
    (missingDirectParentResolutions["2K"] as JsonRecord).derived_from_tier = "2K";
    assert.throws(
      () => buildAutodlH3ActivationPlan(missingDirectParentProfile),
      /仅允许 1080p增强/u,
      "2K 档不得伪装为推导启用",
    );

    const invalidGatewayProfile = clone(profile);
    const invalidVideo = invalidGatewayProfile.video as JsonRecord;
    const invalidResolutions = invalidVideo.resolutions as JsonRecord;
    (invalidResolutions["2K"] as JsonRecord).gateway_output_tier = "base";
    assert.throws(() => buildAutodlH3ActivationPlan(invalidGatewayProfile), /gateway_output_tier 必须为 2K/u);

    const [migration, configure, fullChain] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(configurePath, "utf8"),
      readFile(fullChainPath, "utf8"),
    ]);
    assert.match(migration, /create or replace function public\.activate_autodl_h3_selfhost_models_v1/u);
    assert.match(migration, /create or replace function public\.hide_autodl_h3_selfhost_models_v1/u);
    assert.match(migration, /AUTODL_H3_ATOMIC_ACTIVATION_ROWCOUNT_INVALID/u);
    assert.match(migration, /AUTODL_H3_ATOMIC_HIDE_ROWCOUNT_INVALID/u);
    assert.match(migration, /AUTODL_H3_TARGET_CARDINALITY_INVALID/u);
    assert.match(migration, /AUTODL_H3_PROFILE_RESOLUTION_UNVERIFIED/u);
    assert.match(migration, /supported_combinations/u);
    assert.match(migration, /combination_verification_mode/u);
    assert.match(configure, /db\.rpc\("activate_autodl_h3_selfhost_models_v1"/u);
    assert.match(configure, /db\.rpc\("hide_autodl_h3_selfhost_models_v1"/u);
    assert.match(fullChain, /ffprobe/iu);
    assert.equal(fetchCalls, 0, "activation regression must stay zero-network");

    console.log(JSON.stringify({
      status: "passed",
      network_calls: fetchCalls,
      paid_generation_calls: 0,
      enabled_video_tiers: config.resolution_options,
      enabled_video_durations: config.duration_options,
      image_verified_output: plan.imageOutputPixelSizes,
      atomic_activate_guard: true,
      atomic_hide_guard: true,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
