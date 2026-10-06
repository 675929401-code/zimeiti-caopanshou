import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();
const routePath = path.join(
  workspaceRoot,
  "src/features/official-core-routes/official-agent-route.tsx",
);
const stylePath = path.join(
  workspaceRoot,
  "src/features/official-core-routes/official-agent-route.module.css",
);

async function main() {
  const [routeSource, styleSource] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(stylePath, "utf8"),
  ]);

  const checks: Array<[string, boolean]> = [
  [
    "official public welcome copy",
    routeSource.includes(
      "描述你的需求，Agent 会调用专业 Skill 完成文案和多模态提示词，真实媒体任务在对应工作台使用已发布模型提交与计费。",
    ),
  ],
  [
    "official three-line composer placeholder",
    routeSource.includes(
      "描述你的创作需求，Agent 可以调用 Skill 输出文案、生图提示词、视频提示词或声音方案。\\n图片可随消息引用；真实媒体生成由对应工作台的已发布模型提交与计费。\\nEnter 发送 · / 命令与技能 · # 快捷提示词",
    ),
  ],
  ["slash command entry stays in Agent", routeSource.includes('data-testid="agent-command-trigger"')],
  ["prompt library entry stays in Agent", routeSource.includes('data-testid="agent-shortcut-trigger"')],
  ["personal image entry", routeSource.includes('title="引用个人图片"')],
  ["personal video entry", routeSource.includes('title="引用个人视频"')],
  ["personal audio entry", routeSource.includes('title="引用个人音频"')],
  [
    "official public image categories",
    routeSource.includes('image: ["全部", "角色", "场景", "道具", "风格", "图片", "收藏"]'),
  ],
  [
    "official public video categories",
    routeSource.includes('video: ["全部", "分镜", "成片", "视频", "收藏"]'),
  ],
  [
    "official public audio categories",
    routeSource.includes('audio: ["全部", "音乐", "语音", "音频", "音效", "收藏"]'),
  ],
  ["personal assets use same-site storage inventory", routeSource.includes("/api/storage/files?category=${assetPickerKind}")],
  ["asset content stays same-site", routeSource.includes("/api/storage/files/${encodeURIComponent(candidate.id)}/content")],
  ["official empty title", routeSource.includes("暂无{ASSET_LABELS[assetPickerKind]}素材")],
  ["official empty description", routeSource.includes("上传或生成后将显示在这里")],
  ["inspiration cards are not mixed into account assets", !routeSource.includes("OFFICIAL_INSPIRATION_ITEMS")],
  ["removed local source toggle", !routeSource.includes("assetSource") && !styleSource.includes("assetSourceTabs")],
  ["no main-site media handoff action", !routeSource.includes("handoffMessageToWorkbench")],
  ["same-site media workbench routes are explicit", routeSource.includes("YOUCAI_AGENT_WORKBENCH_ROUTES")],
  ["code blocks use readable dark surface", styleSource.includes("background: #26344d !important")],
  ["code block text uses readable contrast", styleSource.includes("color: #f8fafc !important")],
  ["shared media push buttons hidden in Agent output", styleSource.includes('.messageBubble :global(.send-video-task-button)')],
  ["copy control remains visible", styleSource.includes('.messageBubble :global(.copy-code-button)')],
  ["copy control is labelled", styleSource.includes('content: "复制"')],
  ];

  for (const [label, passed] of checks) {
    assert.equal(passed, true, `FAIL: ${label}`);
    process.stdout.write(`PASS ${label}\n`);
  }

  process.stdout.write(`PASS ${checks.length}/${checks.length} public Agent UI source contracts\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
