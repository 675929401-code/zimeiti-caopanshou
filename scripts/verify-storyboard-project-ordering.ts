import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deriveStoryboardSubmittedAt,
  sortStoryboardProjectsBySubmission,
  type StoryboardProjectSummary,
} from "../src/lib/storyboard-project-contract";

const fixtureNow = Date.parse("2026-09-15T08:00:00.000Z");
assert.equal(deriveStoryboardSubmittedAt({
  lastSubmittedAt: fixtureNow - 1_000,
  cards: [{ imageSubmittedAt: fixtureNow - 3_000, videoStartedAt: fixtureNow - 2_000 }],
}, fixtureNow), "2026-09-15T07:59:59.000Z", "项目级可靠提交时间应优先采用最新值");
assert.equal(deriveStoryboardSubmittedAt({
  cards: [{ videoStartedAt: fixtureNow - 2_000 }],
}, fixtureNow), "2026-09-15T07:59:58.000Z", "旧视频快照应从 videoStartedAt 兼容派生");
assert.equal(deriveStoryboardSubmittedAt({
  cards: [{ imageSubmittedAt: fixtureNow - 3_000 }],
}, fixtureNow), "2026-09-15T07:59:57.000Z", "新生图快照应从 imageSubmittedAt 派生");
assert.equal(deriveStoryboardSubmittedAt({ cards: [{ imagePrompt: "只有输入" }] }, fixtureNow), null, "没有可靠提交字段时不得伪造时间");
assert.equal(deriveStoryboardSubmittedAt({ lastSubmittedAt: fixtureNow + 600_000 }, fixtureNow), null, "异常未来时间不得参与排序");

const project = (
  id: string,
  submittedAt: string | null,
  updatedAt: string,
  createdAt = updatedAt,
): StoryboardProjectSummary => ({
  id,
  title: id,
  revision: 1,
  createdAt,
  updatedAt,
  submittedAt,
  cardCount: 1,
});

const rows = [
  project("submitted-newer", "2026-09-15T03:00:00.000Z", "2026-09-15T03:10:00.000Z"),
  project("edited-later", "2026-09-15T02:00:00.000Z", "2026-09-15T05:00:00.000Z"),
  project("manual-only", null, "2026-09-15T04:00:00.000Z"),
  project("created-only", null, "invalid", "2026-09-15T01:00:00.000Z"),
];
const ordered = sortStoryboardProjectsBySubmission(rows);
assert.deepEqual(
  ordered.map((row) => row.id),
  ["manual-only", "submitted-newer", "edited-later", "created-only"],
  "有 submittedAt 时必须忽略后续编辑时间；无提交时才回退保存/创建时间",
);

const ties = sortStoryboardProjectsBySubmission([
  project("project-a", "2026-09-15T06:00:00.000Z", "2026-09-15T06:00:00.000Z"),
  project("project-b", "2026-09-15T06:00:00.000Z", "2026-09-15T06:00:00.000Z"),
]);
assert.deepEqual(ties.map((row) => row.id), ["project-b", "project-a"], "同一提交时间必须按工程 ID 稳定倒序");
assert.deepEqual(rows.map((row) => row.id), ["submitted-newer", "edited-later", "manual-only", "created-only"], "排序不得修改输入数组");

const api = readFileSync(new URL("../src/app/api/storyboard/projects/route.ts", import.meta.url), "utf8");
const workbench = readFileSync(new URL("../src/components/storyboard-workbench.tsx", import.meta.url), "utf8");
const contract = readFileSync(new URL("../src/lib/storyboard-project-contract.ts", import.meta.url), "utf8");

assert.match(api, /\.eq\("owner_id", ownerId\)/u, "项目快照必须先按当前账号隔离");
assert.match(api, /deriveStoryboardSubmittedAt\(row\.document\)/u, "服务端必须从账号自有快照派生提交时间");
assert.match(contract, /document\.lastSubmittedAt/u, "服务端必须读取向前兼容的项目提交时间");
assert.match(contract, /card\.imageSubmittedAt/u, "服务端必须兼容生图提交时间");
assert.match(contract, /card\.videoStartedAt/u, "服务端必须兼容旧视频提交时间");
assert.match(api, /sortStoryboardProjectsBySubmission\(rows\.map\(summary\)\)/u, "服务端必须先全局排序再分页");
assert.match(api, /projects\.slice\(offset, offset \+ 50\)/u, "提交时间排序必须发生在分页之前");
assert.match(api, /throw Error\("PROJECT_LIST_LIMIT"\)/u, "无法完整排序时必须失败关闭");
assert.match(contract, /rightTime - leftTime \|\| right\.id\.localeCompare\(left\.id\)/u, "排序必须有稳定第二键");
assert.match(workbench, /imageSubmittedAt: submittedAt/u, "生图提交必须记录可靠时间");
assert.match(workbench, /videoStartedAt: submittedAt/u, "视频提交必须记录可靠时间");
assert.match(workbench, /lastSubmittedAt: submittedAt/u, "项目快照必须记录最近一次提交时间");
assert.match(workbench, /最近提交[\s\S]*?最近保存/u, "账号工程列表必须分别展示提交时间和保存时间");
assert.match(workbench, /尚无可靠提交时间/u, "旧项目缺少提交时间时不得伪造");

console.log(JSON.stringify({
  ok: true,
  submission_order: "DESC",
  fallback_order: "updatedAt/createdAt",
  stable_tie_breaker: "id DESC",
  network_requests: 0,
  database_writes: 0,
  paid_requests: 0,
}, null, 2));
