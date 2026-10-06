import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMangaCreativeAgentApiContent,
  detectMangaCreativeAgentSkill,
  MANGA_CREATIVE_AGENT_PROMPT_VERSION,
} from "../src/lib/manga-creative-agent-prompt";
import { MANGA_CREATIVE_AGENT_SYSTEM_PROMPT } from "../src/lib/server/manga-creative-agent-system-prompt.data";
import {
  isAllowedVirtualAgentId,
  MANGA_WORKBENCH_AGENT_ID,
} from "../src/lib/virtual-agent-policy";

assert.equal(MANGA_CREATIVE_AGENT_PROMPT_VERSION, "manju-agent-skill-orchestrator-v3.0.0");

const routingCases = [
  ["帮我写一段宠物科普口播文案", "chat"],
  ["生成一张雨夜咖啡馆插画", "image"],
  ["#生图 橘猫在窗台打瞌睡", "image"],
  ["制作一段 5 秒城市夜景视频", "video"],
  ["#镜头 摄像机缓慢推近", "video"],
  ["写一首轻快治愈的歌曲", "music"],
  ["#音乐 木吉他与钢琴", "music"],
] as const;

for (const [input, expected] of routingCases) {
  assert.equal(detectMangaCreativeAgentSkill(input), expected, input);
}

assert.match(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT, /不伪造.*任务状态或已经生成的媒体/u);
assert.match(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT, /Skill 调度契约/u);
assert.match(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT, /\/platform-help/u);
assert.match(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT, /只用于迁移结构/u);
assert.match(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT, /尺寸比例/u);
assert.match(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT, /人物或宠物是否开口/u);
assert.match(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT, /质量门禁/u);
assert.equal(MANGA_WORKBENCH_AGENT_ID, "__manga_workbench__");
assert.equal(isAllowedVirtualAgentId(MANGA_WORKBENCH_AGENT_ID), true);
assert.equal(isAllowedVirtualAgentId("__unapproved_virtual_agent__"), false);
assert.equal(isAllowedVirtualAgentId(""), false);
assert.equal(isAllowedVirtualAgentId(null), false);

const request = "把这段宠物文案改成无对白动画分镜，9:16，后期配音。";
const apiContent = buildMangaCreativeAgentApiContent(request);
const escapedPromptVersion = String(MANGA_CREATIVE_AGENT_PROMPT_VERSION)
  .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
assert.match(apiContent, new RegExp(escapedPromptVersion, "u"));
assert.match(apiContent, /<skill_execution/u);
assert.match(apiContent, /authority="client_hint_only"/u);
assert.match(apiContent, /<selected_skill_hint/u);
assert.match(apiContent, /authoritative="false"/u);
assert.match(apiContent, /<user_request>/u);
assert.match(apiContent, new RegExp(request, "u"));
assert.match(apiContent, /服务端必须重新解析用户原始请求/u);

const attachmentApiContent = buildMangaCreativeAgentApiContent("根据引用素材整理创作方案", {
  attachments: [
    { id: "asset-image-visible", kind: "image", name: "角色参考图.png" },
    { id: "asset-video-metadata", kind: "video", name: "分镜参考.mp4" },
    { id: "asset-audio-metadata", kind: "audio", name: "配乐参考.mp3" },
  ],
  imagePayloadAssetIds: ["asset-image-visible"],
});
assert.match(attachmentApiContent, /<selected_assets image_payload_count="1">/u);
assert.match(
  attachmentApiContent,
  /<asset id="asset-image-visible" kind="image" name="角色参考图\.png" content_access="possible_multimodal_payload" \/>/u,
);
assert.match(
  attachmentApiContent,
  /<asset id="asset-video-metadata" kind="video" name="分镜参考\.mp4" content_access="metadata_only" \/>/u,
);
assert.match(
  attachmentApiContent,
  /<asset id="asset-audio-metadata" kind="audio" name="配乐参考\.mp3" content_access="metadata_only" \/>/u,
);
assert.doesNotMatch(attachmentApiContent, /kind="(?:video|audio)"[^>]+possible_multimodal_payload/u);

const routeSource = readFileSync(
  resolve(process.cwd(), "src/features/official-core-routes/official-agent-route.tsx"),
  "utf8",
);
assert.doesNotMatch(routeSource, /<ChatView\b/u);
assert.match(routeSource, /message\.displayContent \|\| message\.content/u);
assert.match(routeSource, /data-testid="official-agent-real-chat"/u);
assert.match(routeSource, /<strong>创作 Agent<\/strong>/u);
assert.match(routeSource, /conversation\.agentId === MANGA_WORKBENCH_AGENT_ID/u);
assert.match(routeSource, /agentId: MANGA_WORKBENCH_AGENT_ID/u);
assert.match(routeSource, /buildMangaCreativeAgentApiContent\(/u);
assert.doesNotMatch(routeSource, /data-history-source="main-conversations"/u);

const mainSidebarSource = readFileSync(
  resolve(process.cwd(), "src/components/app-sidebar.tsx"),
  "utf8",
);
assert.match(mainSidebarSource, /conv\.agentId === MANGA_WORKBENCH_AGENT_ID/u);
assert.match(mainSidebarSource, /title: "漫剧工作台"/u);

const virtualAgentSource = readFileSync(
  resolve(process.cwd(), "src/lib/virtual-chat-agents.ts"),
  "utf8",
);
assert.match(virtualAgentSource, /MANGA_WORKBENCH_AGENT_ID/u);
assert.match(virtualAgentSource, /systemPrompt: ""/u);
assert.doesNotMatch(virtualAgentSource, /manga-creative-agent-system-prompt/u);

const llmRouteSource = readFileSync(
  resolve(process.cwd(), "src/app/api/llm/route.ts"),
  "utf8",
);
assert.match(llmRouteSource, /isAllowedVirtualAgentId\(agentId\)/u);
assert.match(llmRouteSource, /!isVirtualAgent && !agentRow/u);
assert.match(llmRouteSource, /loadPublishedMangaPrompt\(\)/u);
assert.match(llmRouteSource, /publishedPrompt\.content/u);
assert.match(llmRouteSource, /mangaSkillOrchestration\?\.systemPrompt/u);
assert.doesNotMatch(
  llmRouteSource,
  /agentId === MANGA_WORKBENCH_AGENT_ID[\s\S]{0,800}body\.system_prompt/u,
);

const appContextSource = readFileSync(
  resolve(process.cwd(), "src/contexts/app-context.tsx"),
  "utf8",
);
assert.match(appContextSource, /createVirtualChatAgent\(freeChatAgentId\)/u);
assert.match(appContextSource, /persistedVirtualIds/u);
assert.match(appContextSource, /targetAgent = virtualAgent/u);

const publicRuntimeSource = readFileSync(
  resolve(process.cwd(), "src/app/api/youcai/runtime-config/route.ts"),
  "utf8",
);
assert.match(publicRuntimeSource, /MANJU_PUBLIC_CONFIG_DOMAINS/u);
assert.doesNotMatch(publicRuntimeSource, /MANJU_CONFIG_DOMAINS/u);

process.stdout.write(`${JSON.stringify({
  ok: true,
  promptVersion: MANGA_CREATIVE_AGENT_PROMPT_VERSION,
  routingCases: routingCases.length,
  promptCharacters: MANGA_CREATIVE_AGENT_SYSTEM_PROMPT.length,
  apiCharacters: apiContent.length,
  attachmentContract: {
    imagePayloads: 1,
    videoAccess: "metadata_only",
    audioAccess: "metadata_only",
  },
  usesGenericChatView: false,
  isolatesMainAgentHistory: true,
  hidesBranchHistoryFromMainSidebar: true,
  systemPromptStoredOutsideMessages: true,
  serverVirtualAgentAllowed: true,
  unknownVirtualAgentRejected: true,
  paidGenerationTriggered: false,
}, null, 2)}\n`);
