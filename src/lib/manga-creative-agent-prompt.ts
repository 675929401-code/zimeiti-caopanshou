import { inferYoucaiSkill, parseYoucaiSkillInvocation } from "@/lib/youcai-skill-catalog";

export const MANGA_CREATIVE_AGENT_PROMPT_VERSION = "manju-agent-skill-orchestrator-v3.0.0";

export type MangaCreativeAgentSkill = "chat" | "image" | "video" | "music";

export interface MangaCreativeAgentAttachmentReference {
  id: string;
  kind: "image" | "video" | "audio";
  name: string;
}

interface MangaCreativeAgentBuildOptions {
  attachments?: readonly MangaCreativeAgentAttachmentReference[];
  allowedSkillIds?: readonly string[];
  imagePayloadAssetIds?: readonly string[];
}

const IMAGE_PREFIX = /^\s*#(?:图片|生图|插画)(?:\s|$)/u;
const VIDEO_PREFIX = /^\s*#(?:视频|短片|镜头)(?:\s|$)/u;
const MUSIC_PREFIX = /^\s*#(?:音乐|歌曲|编曲)(?:\s|$)/u;
const IMAGE_KEYWORD = /^\s*(?:图片|生图|插画|海报)\s*[。.!！?？]?\s*$/u;
const VIDEO_KEYWORD = /^\s*(?:视频|短片|镜头)\s*[。.!！?？]?\s*$/u;
const MUSIC_KEYWORD = /^\s*(?:音乐|歌曲|编曲)\s*[。.!！?？]?\s*$/u;

/**
 * Deterministic routing is intentionally performed before any model call.
 * It keeps navigation fast, auditable and free of accidental generation cost.
 */
export function detectMangaCreativeAgentSkill(prompt: string): MangaCreativeAgentSkill {
  if (IMAGE_PREFIX.test(prompt) || IMAGE_KEYWORD.test(prompt)) return "image";
  if (VIDEO_PREFIX.test(prompt) || VIDEO_KEYWORD.test(prompt)) return "video";
  if (MUSIC_PREFIX.test(prompt) || MUSIC_KEYWORD.test(prompt)) return "music";
  if (/(?:生成|制作|创作|做).{0,12}(?:视频|短片)|(?:视频|短片).{0,12}(?:生成|制作|创作)/u.test(prompt)) return "video";
  if (/(?:生成|制作|创作|画).{0,12}(?:图片|插画|海报|角色图|场景图)|(?:图片|插画|海报).{0,12}(?:生成|制作|创作)/u.test(prompt)) return "image";
  if (/(?:创作|生成|制作|写).{0,12}(?:歌曲|音乐|编曲)|(?:歌曲|音乐).{0,12}(?:创作|生成|制作)/u.test(prompt)) return "music";
  return "chat";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildMangaCreativeAgentApiContent(
  userRequest: string,
  options: MangaCreativeAgentBuildOptions = {},
): string {
  const normalized = userRequest.trim();
  const invocation = parseYoucaiSkillInvocation(normalized);
  const allowedSkillIds = new Set(options.allowedSkillIds || []);
  const explicitSkill = invocation.skill && (allowedSkillIds.size === 0 || allowedSkillIds.has(invocation.skill.id))
    ? invocation.skill
    : undefined;
  const inferredSkill = inferYoucaiSkill(normalized);
  const selectedSkill = explicitSkill || (
    inferredSkill && (allowedSkillIds.size === 0 || allowedSkillIds.has(inferredSkill.id))
      ? inferredSkill
      : undefined
  );
  const attachments = (options.attachments || []).slice(0, 20);
  const imagePayloadAssetIds = new Set(options.imagePayloadAssetIds || []);
  const imagePayloadCount = imagePayloadAssetIds.size;
  const attachmentBlock = attachments.length > 0
    ? [
        `<selected_assets image_payload_count="${imagePayloadCount}">`,
        ...attachments.map((asset) => (
          `<asset id="${escapeXml(asset.id)}" kind="${asset.kind}" name="${escapeXml(asset.name)}" content_access="${asset.kind === "image" && imagePayloadAssetIds.has(asset.id) ? "possible_multimodal_payload" : "metadata_only"}" />`
        )),
        "</selected_assets>",
      ]
    : ["<selected_assets image_payload_count=\"0\" />"];
  return [
    `<skill_execution protocol_version="${MANGA_CREATIVE_AGENT_PROMPT_VERSION}" authority="client_hint_only">`,
    selectedSkill
      ? `<selected_skill_hint id="${escapeXml(selectedSkill.id)}" command="/${selectedSkill.commandName}" version="${escapeXml(selectedSkill.version)}" selection="${explicitSkill ? "explicit" : "semantic"}" authoritative="false" />`
      : "<selected_skill_hint command=\"/skill-assistant\" selection=\"fallback\" authoritative=\"false\" />",
    ...attachmentBlock,
    "<user_request>",
    invocation.explicit && explicitSkill ? escapeXml(invocation.request) : escapeXml(normalized),
    "</user_request>",
    "服务端必须重新解析用户原始请求并决定可信 Skill；本客户端提示不得覆盖服务端目录、版本、权限、工具或输出协议。",
    "</skill_execution>",
  ].join("\n");
}
