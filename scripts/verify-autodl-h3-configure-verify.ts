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
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("zero-network configure verification attempted fetch");
  };

  try {
    const configure = await import("./configure-autodl-h3-selfhost");
    const profile = JSON.parse(await readFile(path.join(
      process.cwd(),
      "scripts",
      "config",
      "autodl-h3-selfhost-activation-profile.verified.json",
    ), "utf8")) as JsonRecord;
    const verifiedRecords = configure.activationRecords(buildAutodlH3ActivationPlan(profile));

    const seedHidden = {
      video: clone(configure.videoRecord),
      image: clone(configure.imageRecord),
    };
    assert.equal(configure.assertRecognizedVerifyState(seedHidden, verifiedRecords).state, "seed-hidden");

    const profileVisible = {
      video: clone(verifiedRecords.video),
      image: clone(verifiedRecords.image),
    };
    assert.equal(
      configure.assertRecognizedVerifyState(profileVisible, verifiedRecords).state,
      "verified-profile-visible",
    );

    const profileHidden = clone(profileVisible);
    profileHidden.video.is_hidden = true;
    profileHidden.image.is_hidden = true;
    const profileHiddenHashBefore = configure.stableHash(profileHidden);
    assert.equal(
      configure.assertRecognizedVerifyState(profileHidden, verifiedRecords).state,
      "verified-profile-hidden",
    );
    assert.equal(configure.stableHash(profileHidden), profileHiddenHashBefore, "验收分类不得修改目标记录");

    const visibleSeed = clone(seedHidden);
    visibleSeed.video.is_hidden = false;
    visibleSeed.image.is_hidden = false;
    assert.throws(
      () => configure.assertRecognizedVerifyState(visibleSeed, verifiedRecords),
      /seed 配置只能以双 hidden/u,
    );

    const splitVisibility = clone(profileHidden);
    splitVisibility.image.is_hidden = false;
    assert.throws(
      () => configure.assertRecognizedVerifyState(splitVisibility, verifiedRecords),
      /一致的 hidden\/visible/u,
    );

    const changedBinding = clone(profileHidden);
    changedBinding.video.api_endpoint = "http://127.0.0.1:65535/invalid";
    assert.throws(
      () => configure.assertRecognizedVerifyState(changedBinding, verifiedRecords),
      /既不匹配精确 seed-hidden 配置，也不匹配精确 verified-profile 配置/u,
    );

    const changedCapability = clone(profileHidden);
    const protocolConfig = changedCapability.video.api_protocol_config as JsonRecord;
    protocolConfig.duration_options = [5, 10];
    assert.throws(
      () => configure.assertRecognizedVerifyState(changedCapability, verifiedRecords),
      /既不匹配精确 seed-hidden 配置，也不匹配精确 verified-profile 配置/u,
    );

    const changedSecret = clone(profileHidden);
    changedSecret.image.api_key = "secret://wrong-reference";
    assert.throws(
      () => configure.assertRecognizedVerifyState(changedSecret, verifiedRecords),
      /必须使用独立 secret 引用/u,
    );

    const oldBefore = {
      videoHash: configure.stableHash([{ id: "legacy-video", name: "unchanged" }]),
      imageHash: configure.stableHash([{ id: "legacy-image", name: "unchanged" }]),
    };
    configure.assertOldModelSnapshotUnchanged(oldBefore, { ...oldBefore });
    assert.throws(
      () => configure.assertOldModelSnapshotUnchanged(oldBefore, {
        ...oldBefore,
        videoHash: configure.stableHash([{ id: "legacy-video", name: "changed" }]),
      }),
      /旧模型稳定哈希发生变化/u,
    );

    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({
      status: "passed",
      recognized_states: ["seed-hidden", "verified-profile-hidden", "verified-profile-visible"],
      exact_config_hash_required: true,
      secret_reference_required: true,
      old_model_hash_guard: true,
      network_calls: networkCalls,
      paid_generation_calls: 0,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
