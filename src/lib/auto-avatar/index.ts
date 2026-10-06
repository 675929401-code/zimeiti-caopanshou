/**
 * 自动头像 — 公共入口模块
 *
 * 这是唯一对外暴露的 API。其他模块只需：
 *
 *   import { triggerAutoAvatar } from "@/lib/auto-avatar";
 *   triggerAutoAvatar(agentId, name, description, avatar);
 *
 * 模块架构：
 *   index.ts        ← 公共入口（你在这里）
 *   prompts.ts      ← 提示词工程（纯函数，可独立测试）
 *   generator.ts    ← 生成引擎（生图 + 持久化 + 更新DB）
 *
 * 隔离保证：
 * - 提示词构建失败 → generator 用 fallback prompt 继续
 * - 生图 API 失败 → 只记日志，不影响智能体保存
 * - 存储失败 → persistAvatar 内部有降级策略
 * - DB 更新失败 → 只记日志，下次刷新仍用旧头像
 * - 整个流程任何异常都不会传播到调用方
 */

import { shouldGenerateAvatar, generateAndUpdateAvatar } from "./generator";

export { shouldGenerateAvatar } from "./generator";
export { buildAvatarPrompt } from "./prompts";

// ── 开关缓存 ──
let switchCached = true;       // 默认开启
let switchCacheTime = 0;
const SWITCH_CACHE_TTL = 1000;

/**
 * 从数据库读取功能开关（带缓存）
 * platform_settings 表中 auto_avatar_enabled = "true"/"false"
 */
async function isAutoAvatarEnabled(): Promise<boolean> {
  // 环境变量优先：显式关闭则不查库
  if (process.env.AUTO_AVATAR_ENABLED === "false") return false;

  // 缓存未过期，直接返回
  if (Date.now() - switchCacheTime < SWITCH_CACHE_TTL) return switchCached;

  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const db = getSupabaseClient();
    const { data } = await db
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", "auto_avatar_enabled")
      .single();

    switchCached = data?.setting_value !== "false";
    switchCacheTime = Date.now();
  } catch {
    // 查库失败，保持上次缓存值（默认 true）
    switchCacheTime = Date.now(); // 防止频繁查库
  }

  return switchCached;
}

/**
 * 触发自动头像生成（异步，fire-and-forget）
 *
 * 判断逻辑：
 * 1. 如果 avatar 已有有效值（URL/路径）→ 跳过，不覆盖用户自定义头像
 * 2. 如果 avatar 为空/emoji → 异步触发赛博朋克风格头像生成
 *
 * 此函数不阻塞调用方，不抛出异常。
 * 调用方无需 await（虽然可以 await，但不推荐）。
 *
 * @param agentId     智能体 ID
 * @param name        智能体名称
 * @param description 智能体描述
 * @param currentAvatar 当前头像值（用于判断是否需要生成）
 */
export function triggerAutoAvatar(
  agentId: string,
  name: string,
  description: string,
  currentAvatar: string | null | undefined
): void {
  // ── 条件判断：已有头像则跳过 ──
  if (!shouldGenerateAvatar(currentAvatar)) {
    console.log(
      `[AutoAvatar] Agent "${name}" has existing avatar (${JSON.stringify(currentAvatar)?.slice(0, 60)}), skipping`
    );
    return;
  }

  console.log(
    `[AutoAvatar] Agent "${name}" needs auto-avatar (current: ${JSON.stringify(currentAvatar)}), triggering...`
  );

  // ── 异步检查开关 + 触发生成（fire-and-forget） ──
  void (async () => {
    try {
      const enabled = await isAutoAvatarEnabled();
      if (!enabled) {
        console.log("[AutoAvatar] Auto-avatar generation is disabled");
        return;
      }

      await generateAndUpdateAvatar(agentId, name, description);
    } catch {
      // 终极兜底：任何异常只记日志，绝不外泄
    }
  })();
}
