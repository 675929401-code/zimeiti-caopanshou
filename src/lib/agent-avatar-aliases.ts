/**
 * 深空晶主题的语义头像映射。
 * 只替换已登记的旧头像来源，不改数据库中的头像字段，便于随时回滚。
 * 应用广场对未登记的远程来源另有稳定本地兜底，避免旧写实图回流。
 */
const SEMANTIC_AGENT_AVATAR_ALIASES: Record<string, string> = {
  "/avatars/agent-cyber-01.png": "/avatars/cute-semantic/agent-cute-01.webp",
  "/avatars/agent-cyber-02.png": "/avatars/cute-semantic/agent-cute-02.webp",
  "https://br-sunny-crab-4eaf4f50.supabase2.aidap-global.cn-beijing.volces.com/storage/v1/object/public/avatars/avatar_1786843370984_gfp3d6.40177780-d6e8-4a05-9ecf-853f98209453": "/avatars/cute-semantic/agent-cute-03.webp",
  "https://br-sunny-crab-4eaf4f50.supabase2.aidap-global.cn-beijing.volces.com/storage/v1/object/public/avatars/avatar_1786983841392_5lf8x6.40177780-d6e8-4a05-9ecf-853f98209453": "/avatars/cute-semantic/agent-cute-03.webp",
  "/avatars/agent-cyber-03.png": "/avatars/cute-semantic/agent-cute-04.webp",
  "/avatars/agent-cyber-04.png": "/avatars/cute-semantic/agent-cute-05.webp",
  "/avatars/agent-cyber-06.png": "/avatars/cute-semantic/agent-cute-06.webp",
  "/avatars/agent-cyber-09.png": "/avatars/cute-semantic/agent-cute-07.webp",
  "/avatars/cyber-3d-script-architect-pro.png": "/avatars/cute-semantic/agent-cute-08.webp",
  "/avatars/agent-cyber-10.png": "/avatars/cute-semantic/agent-cute-09.webp",
  "https://br-sunny-crab-4eaf4f50.supabase2.aidap-global.cn-beijing.volces.com/storage/v1/object/public/avatars/avatar_1786716358353_2nrzke.675bddff-3812-4d77-b48d-ed05a0b4597c": "/avatars/cute-semantic/agent-cute-10.webp",
  "https://br-sunny-crab-4eaf4f50.supabase2.aidap-global.cn-beijing.volces.com/storage/v1/object/public/avatars/avatar_1781684557253_4x1hll.jpeg": "/avatars/cute-semantic/agent-cute-29.webp",
  "/avatars/agent-cyber-07.png": "/avatars/cute-semantic/agent-cute-11.webp",
  "/avatars/agent-cyber-11.png": "/avatars/cute-semantic/agent-cute-12.webp",
  "/avatars/agent-cyber-12.png": "/avatars/cute-semantic/agent-cute-13.webp",
  "/avatars/agent-cyber-13.png": "/avatars/cute-semantic/agent-cute-14.webp",
  "/avatars/agent-cyber-14.png": "/avatars/cute-semantic/agent-cute-15.webp",
  "/avatars/agent-cyber-15.png": "/avatars/cute-semantic/agent-cute-16.webp",
  "/avatars/agent-cyber-18.png": "/avatars/cute-semantic/agent-cute-17.webp",
  "/avatars/agent-cyber-20.png": "/avatars/cute-semantic/agent-cute-18.webp",
  "/avatars/agent-cyber-22.png": "/avatars/cute-semantic/agent-cute-19.webp",
  "/avatars/agent-cyber-23.png": "/avatars/cute-semantic/agent-cute-20.webp",
  "/avatars/agent-cyber-26.png": "/avatars/cute-semantic/agent-cute-21.webp",
  "/avatars/agent-cyber-28.png": "/avatars/cute-semantic/agent-cute-29.webp",
  "/avatars/agent-cyber-24.png": "/avatars/cute-semantic/agent-cute-22.webp",
  "/avatars/agent-cyber-25.png": "/avatars/cute-semantic/agent-cute-23.webp",
  "/avatars/agent-cyber-29.png": "/avatars/cute-semantic/agent-cute-24.webp",
  "/avatars/agent-cyber-30.png": "/avatars/cute-semantic/agent-cute-25.webp",
  "/avatars/agent-cyber-31.png": "/avatars/cute-semantic/agent-cute-26.webp",
  "/avatars/agent-cyber-32.png": "/avatars/cute-semantic/agent-cute-27.webp",
  "/avatars/agent-cyber-33.png": "/avatars/cute-semantic/agent-cute-28.webp",
  "/avatars/agent-cyber-34.png": "/avatars/cute-semantic/agent-cute-29.webp",
  "/avatars/agent-cyber-35.png": "/avatars/cute-semantic/agent-cute-30.webp",
  "/avatars/agent-cyber-36.png": "/avatars/cute-semantic/agent-cute-26.webp",
  "https://coze-coding-project.tos.coze.site/coze_storage_7642988944484892708/image/generate_image_37f5bf6d-debd-4787-80a9-42fef40b8aa4.jpeg?sign=1813227256-e13b01073b-0-9b25ab8885481cb724bd9441d384549f15c1405535af5b4e14a6e07025cb9116": "/avatars/cute-semantic/agent-cute-26.webp",
  "/avatars/agent-cyber-37.png": "/avatars/cute-semantic/agent-cute-31.webp",
  "/avatars/agent-cyber-38.png": "/avatars/cute-semantic/agent-cute-32.webp",
  "/avatars/agent-cyber-39.png": "/avatars/cute-semantic/agent-cute-33.webp",
};

const SEMANTIC_AVATAR_FALLBACK_COUNT = 33;

/**
 * 给没有头像字段或头像来源未登记的新增/覆盖智能体提供稳定的本地语义头像，避免退化成首字母圆块。
 * 已登记的头像仍优先走上面的精确映射；应用广场会在远程来源未登记时调用此兜底。
 */
export function getSemanticAgentAvatarFallback(agentId: string, agentName = ""): string {
  // The stable id owns the fallback. Renaming a card must not change its face
  // across marketplace, sidebar and chat surfaces.
  const key = agentId.trim() || agentName.trim() || "agent";
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  const avatarNumber = (hash % SEMANTIC_AVATAR_FALLBACK_COUNT) + 1;
  return `/avatars/cute-semantic/agent-cute-${String(avatarNumber).padStart(2, "0")}.webp`;
}

export function getSemanticAgentAvatarUrl(avatar: string): string | undefined {
  return SEMANTIC_AGENT_AVATAR_ALIASES[avatar];
}
