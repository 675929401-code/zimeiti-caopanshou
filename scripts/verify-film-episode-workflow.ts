import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  validateEpisodeWorkflowTransition,
  validateStoryboardEpisodeReadiness,
} from "../src/lib/short-drama/episode-workflow";
import type { JsonValue } from "../src/lib/short-drama/contracts";

type JsonRecord = Record<string, JsonValue>;

function payload(status: "draft" | "confirmed", content = "第一场：冲突发生"): JsonRecord {
  return {
    summary: { title: "离线验收项目" },
    episodes: [{ episodeNumber: 1, title: "第一集", content, status }],
  };
}

function issue(currentPayload: JsonRecord, nextPayload: JsonRecord, hasDownstreamData = false) {
  return validateEpisodeWorkflowTransition({ currentPayload, nextPayload, hasDownstreamData });
}

assert.equal(issue(payload("draft"), payload("confirmed")), null, "非空草稿应可定稿");
assert.equal(issue(payload("confirmed"), payload("draft")), null, "无下游数据时应可取消定稿");
assert.equal(issue(payload("confirmed"), payload("confirmed")), null, "未修改的已定稿分集应可随项目保存");

assert.equal(
  issue(payload("draft"), payload("confirmed", ""))?.code,
  "EPISODE_CONTENT_REQUIRED",
  "空白分集必须拒绝定稿",
);
assert.equal(
  issue(payload("confirmed"), payload("draft"), true)?.code,
  "EPISODE_DOWNSTREAM_LOCKED",
  "已有分镜后必须拒绝取消定稿",
);
assert.equal(
  issue(payload("confirmed"), payload("confirmed", "绕过锁定修改"))?.code,
  "EPISODE_CONFIRMED_LOCKED",
  "已定稿内容必须先取消定稿才能修改",
);
assert.equal(
  issue(payload("confirmed"), { summary: {}, episodes: [] })?.code,
  "EPISODE_CONFIRMED_DELETE",
  "已定稿分集必须先取消定稿才能删除",
);
assert.equal(
  issue(payload("draft"), { summary: {}, episodes: [] }),
  null,
  "无下游数据时应允许删除草稿分集",
);
assert.equal(
  issue(payload("draft"), { summary: {}, episodes: [] }, true)?.code,
  "EPISODE_DOWNSTREAM_LOCKED",
  "已有分镜后必须拒绝删除草稿分集",
);
assert.equal(
  issue(payload("draft"), {
    ...payload("draft"),
    episodes: [
      { episodeNumber: 1, title: "第一集", content: "第一场：冲突发生", status: "draft" },
      { episodeNumber: 2, title: "第二集", content: "", status: "draft" },
    ],
  }, true),
  null,
  "已有分镜后应允许在末尾连续续写新分集",
);
assert.equal(
  issue(payload("draft"), {
    ...payload("draft"),
    episodes: [
      { episodeNumber: 1, title: "第一集", content: "第一场：冲突发生", status: "draft" },
      { episodeNumber: 3, title: "第三集", content: "", status: "draft" },
    ],
  }, true)?.code,
  "EPISODE_APPEND_SEQUENCE_INVALID",
  "已有分镜后续写必须保持连续集号",
);
assert.equal(
  issue(payload("draft"), payload("draft", "绕过下游锁定修改"), true)?.code,
  "EPISODE_DOWNSTREAM_LOCKED",
  "已有分镜后不得改写任何既有分集内容",
);

assert.equal(
  validateStoryboardEpisodeReadiness({ summary: {}, episodes: [] })?.code,
  "EPISODE_REQUIRED_FOR_STORYBOARD",
  "没有分集时不能创建分镜",
);
assert.equal(
  validateStoryboardEpisodeReadiness(payload("draft"))?.code,
  "EPISODE_CONFIRM_REQUIRED_FOR_STORYBOARD",
  "草稿分集不能创建分镜",
);
assert.equal(
  validateStoryboardEpisodeReadiness(payload("draft", ""))?.code,
  "EPISODE_CONTENT_REQUIRED_FOR_STORYBOARD",
  "空白分集应先提示补全正文",
);
assert.equal(
  validateStoryboardEpisodeReadiness(payload("confirmed")),
  null,
  "全部非空且已定稿后才能创建分镜",
);

const workbench = fs.readFileSync(
  path.join(process.cwd(), "src/features/film-studio-project/film-studio-project-workbench.tsx"),
  "utf8",
);
for (const marker of [
  "film-add-episode",
  "film-remove-episode",
  "film-toggle-episode-status",
  "film-confirm-all-episodes",
  "film-project-script-ai-operations",
  'runScriptOperation("continue")',
  'runScriptOperation("rewrite")',
  "重试保存已生成结果",
  "已有分镜或成片，不能取消定稿",
]) {
  assert.ok(workbench.includes(marker), `工作台缺少分集流程标记：${marker}`);
}

const shotPanel = fs.readFileSync(
  path.join(process.cwd(), "src/features/film-studio-project/film-studio-shot-panel.tsx"),
  "utf8",
);
const productionPanel = fs.readFileSync(
  path.join(process.cwd(), "src/features/film-studio-project/film-studio-production-panel.tsx"),
  "utf8",
);
const shotRoute = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/short-drama/projects/[projectId]/shots/route.ts"),
  "utf8",
);
const productionService = fs.readFileSync(
  path.join(process.cwd(), "src/lib/short-drama/production-service.ts"),
  "utf8",
);
assert.ok(shotPanel.includes("creationBlockedMessage"), "手动分镜入口必须显示定稿门禁");
assert.ok(productionPanel.includes("creationBlockedMessage"), "镜头计划入口必须显示定稿门禁");
assert.ok(
  shotRoute.indexOf("validateStoryboardEpisodeReadiness") < shotRoute.indexOf("repository.createShot"),
  "服务端必须在写入手动分镜前检查分集定稿",
);
assert.ok(
  productionService.indexOf("validateStoryboardEpisodeReadiness(project.sourcePayload)")
    < productionService.indexOf("repository.createJob(input.auth.userId"),
  "生产计划必须在创建任务记录前检查分集定稿",
);

console.log(JSON.stringify({
  status: "PASS",
  checks: 28,
  paidModelCalls: 0,
  databaseWrites: 0,
  scope: "episode workflow transition, continuation/rewrite UI, storyboard gate, and write-back safety",
}, null, 2));
