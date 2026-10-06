import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const mainUserId = "media-history-main-admin-fixture";
const ownerOne = "commerce-owner-one";
const ownerTwo = "commerce-owner-two";
type ClosableDatabase = DatabaseSync & { close: () => void };

function forwardBindingKey(userId: string): string {
  return `main-user-map-${createHash("sha256").update(userId).digest("hex")}`;
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(root, ".tmp-media-history-commerce-"));
  const databasePath = path.join(temporaryRoot, "commerce.sqlite");
  const assetsDirectory = path.join(temporaryRoot, "assets");
  try {
  await mkdir(assetsDirectory, { recursive: true });
  const videoAssetId = "uppercase-video-fixture.mp4";
  const videoBytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
  await writeFile(path.join(assetsDirectory, videoAssetId), videoBytes);

  const database = new DatabaseSync(databasePath) as ClosableDatabase;
  database.exec(`
    CREATE TABLE records (
      bucket TEXT NOT NULL,
      id TEXT NOT NULL,
      owner TEXT NOT NULL,
      value TEXT NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY (bucket, id, owner)
    )
  `);
  const put = database.prepare(
    "INSERT OR REPLACE INTO records(bucket,id,owner,value,updated) VALUES(?,?,?,?,?)",
  );
  const now = Date.now();
  put.run("settings", `main-bind-${ownerOne}`, "system", JSON.stringify({
    mainUserId,
    mainRole: "admin",
    exempt: false,
  }), now);
  put.run("settings", `main-bind-${ownerTwo}`, "system", JSON.stringify({
    mainUserId,
    mainRole: "admin",
    exempt: false,
  }), now + 1);
  put.run("assets", videoAssetId, ownerOne, JSON.stringify({
    id: videoAssetId,
    owner: ownerOne,
    name: "uppercase-video.mp4",
    type: "VIDEO/MP4",
    size: videoBytes.length,
    createdAt: now,
    source: "generated",
    jobId: "job-video",
  }), now + 2);
  put.run("jobs", "job-video", ownerOne, JSON.stringify({
    id: "job-video",
    owner: ownerOne,
    input: { kind: "video", prompt: "fixture", duration: 5 },
    model: { displayName: "Fixture Video" },
    route: { label: "视频任务" },
    status: "succeeded",
    createdAt: now,
    updatedAt: now + 3,
    assetIds: [videoAssetId],
    billing: { amount: 0.5, status: "charged" },
  }), now + 3);
  put.run("jobs", "job-failed", ownerOne, JSON.stringify({
    id: "job-failed",
    owner: ownerOne,
    input: { kind: "video", prompt: "fixture" },
    model: { displayName: "Fixture Video" },
    route: { label: "失败任务" },
    status: "failed",
    error: "provider secret: https://internal.example/?token=do-not-leak",
    createdAt: now - 1,
    updatedAt: now + 4,
  }), now + 4);
  database.close();

  process.env.COMMERCE_DATA_DIR = temporaryRoot;
  const commerce = await import("../src/lib/media-history-commerce");

  const ambiguous = commerce.loadCommerceMediaHistory(mainUserId, "admin");
  assert.equal(ambiguous.failed, true, "歧义 reverse binding 必须失败关闭");
  assert.equal(ambiguous.items.length, 0, "歧义 binding 不得扩大 owner 可见域");

  const repair = new DatabaseSync(databasePath) as ClosableDatabase;
  repair.prepare("DELETE FROM records WHERE bucket='settings' AND id=? AND owner='system'")
    .run(`main-bind-${ownerTwo}`);
  repair.prepare("INSERT OR REPLACE INTO records(bucket,id,owner,value,updated) VALUES(?,?,?,?,?)")
    .run("settings", forwardBindingKey(mainUserId), "system", JSON.stringify({
      mainUserId,
      commerceOwnerId: ownerOne,
    }), now + 5);
  repair.close();

  const beforeRead = (await stat(databasePath)).mtimeMs;
  const history = commerce.loadCommerceMediaHistory(mainUserId, "admin");
  const afterRead = (await stat(databasePath)).mtimeMs;
  assert.equal(history.failed, false);
  assert.equal(history.bound, true);
  assert.equal(history.items.length, 2);
  assert.equal(afterRead, beforeRead, "只读历史聚合不得修改 Commerce 数据库");

  const video = history.items.find((item) => item.status === "completed");
  assert.ok(video);
  assert.equal(video.kind, "video", "大小写不同的合法视频 MIME 必须规范化为 video");
  assert.equal(video.preview.delivery, "ticket", "视频必须坚持短票据交付");
  assert.equal(video.preview.thumbnailPath, "", "无静态首帧时应由原生 Range 预览回退");
  assert.equal(Object.hasOwn(video, "sourceRecordId"), false, "公共 DTO 不得泄露内部记录字段");
  assert.equal(Object.hasOwn(video, "assetId"), false, "公共 DTO 不得泄露内部资产字段");

  const storedAsset = commerce.findCommerceMediaHistoryAsset(mainUserId, "admin", videoAssetId);
  assert.ok(storedAsset);
  assert.equal(storedAsset.type, "video/mp4", "所有票据与内容策略必须使用规范化 MIME");

  const failed = history.items.find((item) => item.status === "failed");
  assert.ok(failed);
  assert.equal(failed.errorMessage, "带货 Agent 任务未完成，请返回来源页面查看并重试。");
  assert.doesNotMatch(failed.errorMessage, /internal|token|provider/i, "公共错误不得泄露上游内部信息");

  process.env.COMMERCE_DATA_DIR = path.join(temporaryRoot, "missing-database");
  const unavailable = commerce.loadCommerceMediaHistory(mainUserId, "admin");
  assert.equal(unavailable.failed, true, "Commerce 数据库缺失时不得冒充精确 0 条");

  console.log("media-history Commerce boundary verification passed; ambiguous binding fail-closed, canonical video MIME, public DTO/error redaction, readonly database, missing database honesty");
  } finally {
    delete process.env.COMMERCE_DATA_DIR;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
