import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BROWSER_MEDIA_CACHE_DAYS,
  CLOUD_MEDIA_RETENTION_RULES,
  CONVERSATION_CONTENT_RETENTION_DAYS,
  CREATIVE_ASSET_CLOUD_RETENTION_DAYS,
  EXTRACTION_HISTORY_RETENTION_DAYS,
  MANAGED_PROJECT_VIDEO_CLOUD_RETENTION_DAYS,
  MEDIA_RETENTION_POLICY_VERSION,
  cloudMediaRetentionTarget,
  generatedVideoCloudNotice,
  resolveCloudMediaRetentionRule,
} from "../src/lib/media-retention-policy";

const root = process.cwd();
const source = (path: string) => readFile(resolve(root, path), "utf8");

async function main() {
  assert.equal(MEDIA_RETENTION_POLICY_VERSION, "media-object-retention.v2");
  assert.equal(MANAGED_PROJECT_VIDEO_CLOUD_RETENTION_DAYS, 3);
  assert.equal(CREATIVE_ASSET_CLOUD_RETENTION_DAYS, 30);
  assert.equal(EXTRACTION_HISTORY_RETENTION_DAYS, 10);
  assert.equal(CONVERSATION_CONTENT_RETENTION_DAYS, 30);
  assert.equal(BROWSER_MEDIA_CACHE_DAYS, 3);
  assert.equal(CLOUD_MEDIA_RETENTION_RULES.length, 2);

  for (const key of [
    "videos/scoped/autodl-h3/task.mp4",
    "videos/scoped/short-drama/episode.mp4",
    "videos/scoped/model-acceptance/sample.mp4",
    "videos/digital-human-long/job/final.mp4",
    "short-drama/final/episode.mp4",
  ]) {
    const rule = resolveCloudMediaRetentionRule(key);
    assert.equal(rule?.retentionClass, "managed_project_video", `${key} 应属于明确管理项目`);
    assert.equal(rule?.days, 3, `${key} 应使用三天有限保留`);
  }

  for (const key of [
    "image-workbench/user/frame.png",
    "video-inputs/reference.png",
    "video-audio-inputs/reference.wav",
    "digital-human-inputs/image/person.png",
  ]) {
    const rule = resolveCloudMediaRetentionRule(key);
    assert.equal(rule?.retentionClass, "creative_asset", `${key} 应属于临时创作输入`);
    assert.equal(rule?.days, 30, `${key} 应使用三十天目标`);
  }

  for (const key of [
    "videos/generated/task.mp4",
    "videos/extracted/source.mp4",
    "images/role-library/role.png",
    "business-data/snapshots/backup.json",
    "assets/releases/logo.png",
    "audio/generated/voice.mp3",
  ]) assert.equal(resolveCloudMediaRetentionRule(key), null, `${key} 不得被有限项目规则误删`);

  const target = cloudMediaRetentionTarget("videos/scoped/autodl-h3/task.mp4", new Date("2026-10-09T00:00:00.000Z"));
  assert.equal(target?.targetExpiresAt, "2026-10-12T00:00:00.000Z");
  assert.equal(target?.enforcement, "cos_lifecycle_required");
  assert.match(generatedVideoCloudNotice(false), /跟随上游/);
  assert.match(generatedVideoCloudNotice(true), /不复制到平台存储/);

  const [manager, videoPersistence, finalizer, referenceUpload, migration, policyDoc, deploymentPolicy] = await Promise.all([
    source("src/storage/object/manager.ts"),
    source("src/lib/video-persistence.ts"),
    source("src/lib/video-terminal-finalizer.ts"),
    source("src/app/api/video/reference-upload/route.ts"),
    source("supabase/migrations/20261009043000_user_content_retention_and_video_direct_delivery.sql"),
    source("docs/媒体存储与保留策略-2026-09-16.md"),
    source("deploy/policies/media-object-retention.v2.json"),
  ]);

  assert.match(manager, /生产环境禁止使用本机对象存储/);
  assert.match(manager, /cloudRetentionEnforcement:\s*retentionTarget\.enforcement/);
  assert.match(videoPersistence, /storageScope: ManagedVideoStorageScope/);
  assert.match(videoPersistence, /videos\/scoped/);
  assert.doesNotMatch(videoPersistence, /videos\/generated\//);
  assert.doesNotMatch(finalizer, /persistStableVideoFromUrl/);
  assert.match(referenceUpload, /prefix:\s*category === "audio" \? "video-audio-inputs\/" : "video-inputs\/"/);
  assert.match(migration, /scrub_transient_video_extraction_content/);
  assert.match(migration, /p_conversation_days integer DEFAULT 30/);
  assert.match(migration, /p_extraction_days integer DEFAULT 10/);

  const policy = JSON.parse(deploymentPolicy) as {
    status?: string;
    ordinaryVideoDelivery?: { copyToPlatformStorage?: boolean; fixedRetentionDays?: number | null };
    activation?: { publicBuildFlag?: string };
  };
  assert.equal(policy.status, "deployment_configuration_required");
  assert.equal(policy.ordinaryVideoDelivery?.copyToPlatformStorage, false);
  assert.equal(policy.ordinaryVideoDelivery?.fixedRetentionDays, null);
  assert.equal(policy.activation?.publicBuildFlag, "NEXT_PUBLIC_MEDIA_RETENTION_ENFORCED=true");
  assert.match(policyDoc, /普通视频/);
  assert.match(policyDoc, /跟随上游/);
  assert.match(policyDoc, /下载到电脑/);

  console.log("media retention policy verification passed; ordinaryVideoCopies=0; extractionDays=10; conversationDays=30; paidRequests=0");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
