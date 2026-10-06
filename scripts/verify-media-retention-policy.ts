import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BROWSER_MEDIA_CACHE_DAYS,
  CLOUD_MEDIA_RETENTION_RULES,
  CREATIVE_ASSET_CLOUD_RETENTION_DAYS,
  GENERATED_VIDEO_CLOUD_RETENTION_DAYS,
  MEDIA_RETENTION_POLICY_VERSION,
  cloudMediaRetentionTarget,
  generatedVideoCloudNotice,
  resolveCloudMediaRetentionRule,
} from "../src/lib/media-retention-policy";

const root = process.cwd();
const source = (path: string) => readFile(resolve(root, path), "utf8");

async function main() {
  assert.equal(MEDIA_RETENTION_POLICY_VERSION, "media-object-retention.v1");
  assert.equal(GENERATED_VIDEO_CLOUD_RETENTION_DAYS, 3);
  assert.equal(CREATIVE_ASSET_CLOUD_RETENTION_DAYS, 30);
  assert.equal(BROWSER_MEDIA_CACHE_DAYS, 3);
  assert.equal(CLOUD_MEDIA_RETENTION_RULES.length, 2, "保留策略必须保持视频与可复用素材两类边界");

  for (const key of [
    "videos/generated/2026/09/16/task.mp4",
    "videos/extracted/2026/09/16/source.mp4",
    "videos/digital-human-long/job/segments/2026/09/16/1.mp4",
    "short-drama/final/2026/09/16/episode.mp4",
  ]) {
    const rule = resolveCloudMediaRetentionRule(key);
    assert.equal(rule?.retentionClass, "generated_video", `${key} 应属于生成/派生视频`);
    assert.equal(rule?.days, 3, `${key} 应使用三天目标`);
  }

  for (const key of [
    "images/2026/09/16/role.png",
    "image-workbench/autodl-h3-selfhost/user/2026/09/16/frame.png",
    "video-inputs/2026/09/16/reference.png",
    "video-audio-inputs/2026/09/16/reference.wav",
    "digital-human-inputs/image/2026/09/16/person.png",
  ]) {
    const rule = resolveCloudMediaRetentionRule(key);
    assert.equal(rule?.retentionClass, "creative_asset", `${key} 应属于角色/创作参考素材`);
    assert.equal(rule?.days, 30, `${key} 应使用三十天目标`);
  }

  assert.equal(resolveCloudMediaRetentionRule("business-data/snapshots/backup.json"), null, "业务备份不得被媒体生命周期误删");
  assert.equal(resolveCloudMediaRetentionRule("assets/releases/logo.png"), null, "平台公共资产不得被用户媒体策略误删");
  assert.equal(resolveCloudMediaRetentionRule("audio/generated/voice.mp3"), null, "未单独批准的音频输出不得被本策略擅自清理");

  const target = cloudMediaRetentionTarget("videos/generated/2026/09/16/task.mp4", new Date("2026-09-16T00:00:00.000Z"));
  assert.equal(target?.targetExpiresAt, "2026-09-19T00:00:00.000Z");
  assert.equal(target?.enforcement, "cos_lifecycle_required", "元数据只能表达目标，不能伪装为已启用");
  assert.match(generatedVideoCloudNotice(false), /可能按存储策略到期/);
  assert.match(generatedVideoCloudNotice(true), /默认保留3天/);

  const [manager, videoPersistence, referenceUpload, digitalHumanUpload, videoPage, historyPage, cache, policyDoc, deploymentPolicy] = await Promise.all([
    source("src/storage/object/manager.ts"),
    source("src/lib/video-persistence.ts"),
    source("src/app/api/video/reference-upload/route.ts"),
    source("src/lib/digital-human-upload-proxy.ts"),
    source("src/app/video/page.tsx"),
    source("src/app/media-history/page.tsx"),
    source("src/lib/media-cache.ts"),
    source("docs/媒体存储与保留策略-2026-09-16.md"),
    source("deploy/policies/media-object-retention.v1.json"),
  ]);

  assert.match(manager, /hasTencentCOSConfig[\s\S]*?defaultProvider = "tencent_cos"/, "COS 配置存在时应推断腾讯云为默认供应商");
  assert.match(manager, /IS_PRODUCTION_RUNTIME[\s\S]*?ALLOW_LOCAL_STORAGE_IN_PRODUCTION[\s\S]*?生产环境禁止使用本机对象存储/, "生产环境必须禁止静默回退本机");
  assert.match(manager, /cloudRetentionEnforcement:\s*retentionTarget\.enforcement/, "新对象元数据应记录外部生命周期仍需配置");
  assert.match(videoPersistence, /const VIDEO_PROVIDER:[^=]*= "tencent_cos"/, "稳定视频必须固定使用腾讯 COS");
  assert.match(videoPersistence, /prefix:\s*"videos\/generated\/"/, "生成视频必须使用三天生命周期前缀");
  assert.match(referenceUpload, /prefix:\s*category === "audio" \? "video-audio-inputs\/" : "video-inputs\/"/, "视频参考素材必须使用三十天前缀");
  assert.match(referenceUpload, /providerType:\s*"tencent_cos"/, "视频参考素材必须写入 COS");
  assert.match(digitalHumanUpload, /prefix:\s*`digital-human-inputs\/\$\{category\}\/`/, "数字人素材必须使用三十天前缀");

  assert.doesNotMatch(videoPage, /永久保存|自动永久保存在这里/, "视频页不得承诺永久云端保存");
  assert.match(videoPage, /下载到电脑/, "视频页必须引导下载到电脑长期保存");
  assert.match(historyPage, /浏览器或系统仍可能回收/, "媒体历史必须说明浏览器缓存可被回收");
  assert.match(historyPage, /尽量保留（浏览器）/, "浏览器 pin 不得描述为永久保存");
  assert.match(cache, /indexedDB/);
  assert.match(cache, /caches\.open/);
  assert.doesNotMatch(cache, /localStorage/, "大媒体不得使用 localStorage 冒充永久文件");

  const policy = JSON.parse(deploymentPolicy) as { status?: string; activation?: { publicBuildFlag?: string } };
  assert.equal(policy.status, "deployment_configuration_required", "策略模板不得伪装为 COS 已配置");
  assert.equal(policy.activation?.publicBuildFlag, "NEXT_PUBLIC_MEDIA_RETENTION_ENFORCED=true");
  assert.match(policyDoc, /尚未证明生效/);
  assert.match(policyDoc, /历史、任务、账单元数据继续保留/);
  assert.match(policyDoc, /下载到电脑/);

  console.log("media retention policy verification: 49 assertions passed; no network, database, storage write or paid request");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
