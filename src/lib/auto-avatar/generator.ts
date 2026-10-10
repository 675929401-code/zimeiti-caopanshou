/**
 * 自动头像 — 生成引擎模块
 *
 * 职责：
 * 1. 调用 ImageGenerationClient 生成主站统一的 3D 卡通职业人物头像
 * 2. 通过 persistAvatar 持久化到 Supabase Storage
 * 3. 更新 agents 表的 avatar 字段
 *
 * 设计原则：
 * - 任何异常只记日志，不向调用方抛出（保证隔离性）
 * - 依赖的模块（生图/存储/DB）任一失败都不影响其他环节
 * - 支持超时保护，防止生成任务无限挂起
 */

import { ImageGenerationClient, Config } from "coze-coding-dev-sdk";
import { discardUnclaimedGeneratedAvatar, persistAvatar } from "@/lib/storage";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { buildAvatarPrompt } from "./prompts";
import { callImageGenerationAPI } from "@/app/api/llm/handle-image-gen";
import { filterAvailableCoverModels } from "@/lib/retired-cover-models";
import { invalidateBotsCache } from "@/lib/bots-cache";
import { invalidateAgentConfigCache } from "@/app/api/llm/llm-state";

// ── 生成超时（毫秒） ──
const GENERATION_TIMEOUT = 60_000; // 60秒

// ── 正在生成中的 agentId 集合（防重复触发） ──
const inProgress = new Set<string>();

type AutoAvatarModel = {
  id: string;
  name?: string | null;
  model_name: string;
  provider?: string | null;
  api_endpoint: string;
  api_key: string;
};

/**
 * 判断是否需要自动生成头像
 *
 * 识别逻辑（按优先级）：
 * 1. avatar 为 null/undefined/空字符串 → 需要生成（管理员没填）
 * 2. avatar 是 emoji → 需要生成（管理员只选了 emoji 占位）
 * 3. avatar 以 http/https 开头 → 不需要（已有完整图片 URL）
 * 4. avatar 包含 "." 且不含空格 → 不需要（已有存储 key，如 avatar_xxx.png）
 * 5. 其他短字符串 → 需要生成（可能是随意输入的文字）
 *
 * 设计考量：
 * - 数据库实际值只有 ""（空）和 "https://..."（URL）两种
 * - 前端上传按钮返回存储 key（如 "avatar_xxx.png"）
 * - emoji 长度不固定（组合 emoji 可能 4+ 字符），需用正则识别
 */
export function shouldGenerateAvatar(avatar: string | null | undefined): boolean {
  // 1. 空/未定义 → 肯定需要生成
  if (!avatar || avatar.trim() === "") return true;

  const trimmed = avatar.trim();

  // 2. 已经是完整 URL → 管理员已上传或之前已生成，不需要
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return false;

  // 3. 存储路径/key（包含扩展名，如 avatar_xxx.png、/avatars/xxx.jpg）
  //    这类值由 persistAvatar 或上传按钮写入，说明已有图片
  if (/\.\w{2,4}$/.test(trimmed) || trimmed.startsWith("/")) return false;

  // 4. emoji 检测 → 管理员选了 emoji 做占位，需要生成真实头像
  //    覆盖：纯 emoji、emoji+空格、以及多字符组合 emoji
  if (hasEmoji(trimmed)) return true;

  // 5. 其他情况：短文本（1-4 字符，如 "AI"、"GPT"）→ 可能是随手输入的文字占位
  if (trimmed.length <= 4) return true;

  // 6. 较长的非 URL 文本 → 保守判断，不生成
  //    （可能是手动填的 Base64 或其他格式，避免覆盖）
  return false;
}

/**
 * 检测字符串中是否包含 emoji
 *
 * 使用 Unicode 范围匹配，覆盖常见 emoji 区间：
 * - 基础 emoji: U+1F600-U+1F64F
 * - 杂项符号: U+2600-U+26FF
 * - 装饰符号: U+2700-U+27BF
 * - 交通/地图: U+1F680-U+1F6FF
 * - 补充符号: U+1F900-U+1F9FF
 * - 旗帜: U+1F1E0-U+1F1FF
 * - 扑克/棋: U+1F0A0-U+1F0FF
 */
function hasEmoji(str: string): boolean {
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}\u{1F0A0}-\u{1F0FF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{2934}-\u{2935}\u{25AA}-\u{25FE}\u{200D}\u{FE0F}]/u;
  return emojiRegex.test(str);
}

/**
 * 异步生成并更新头像（fire-and-forget）
 *
 * 调用方无需 await，也不应依赖此函数的返回值。
 * 所有错误内部消化，绝不外泄。
 *
 * @param agentId    智能体 ID
 * @param name       智能体名称（用于构建提示词）
 * @param description 智能体描述（用于构建提示词）
 */
export async function generateAndUpdateAvatar(
  agentId: string,
  name: string,
  description: string
): Promise<void> {
  // ── 防重复 ──
  if (inProgress.has(agentId)) {
    console.log(`[AutoAvatar] Agent ${agentId} already in progress, skipping`);
    return;
  }
  inProgress.add(agentId);

  try {
    await generateAndUpdateAvatarInner(agentId, name, description);
  } catch (err) {
    // 终极兜底：任何未预期的异常只记日志
    console.error(
      `[AutoAvatar] Unexpected error for agent ${agentId}:`,
      err instanceof Error ? err.message : err
    );
  } finally {
    inProgress.delete(agentId);
  }
}

/**
 * 内部实现，可能抛异常，由外层兜底
 */
async function generateAndUpdateAvatarInner(
  agentId: string,
  name: string,
  description: string
): Promise<void> {
  console.log(`[AutoAvatar] Starting generation for agent "${name}" (${agentId})`);

  const snapshot = await readAgentAvatarCommitSnapshot(agentId);
  if (!snapshot || !shouldGenerateAvatar(snapshot.avatar)) return;

  const persistedUrl = await generateAvatarUrlForAgent(name, description, `auto-avatar-${agentId}`);
  if (!persistedUrl) return;

  const result = await replaceGeneratedAvatarIfUnclaimed(agentId, persistedUrl, snapshot);
  if (result === "updated") {
    console.log(`[AutoAvatar] Successfully updated avatar for agent "${name}" (${agentId})`);
  } else if (result === "manual-preserved" || result === "revision-conflict") {
    console.log(`[AutoAvatar] Agent configuration won the race for agent "${name}" (${agentId}); generated result was discarded`);
  }
}

export type AgentAvatarCommitSnapshot = {
  avatar: string | null;
  configRevision: number;
};

export type GeneratedAvatarCommitResult = "updated" | "manual-preserved" | "revision-conflict" | "missing" | "failed";

export async function readAgentAvatarCommitSnapshot(agentId: string): Promise<AgentAvatarCommitSnapshot | null> {
  const { data, error } = await getSupabaseClient()
    .from("agents")
    .select("id,avatar,config_revision")
    .eq("id", agentId)
    .maybeSingle();
  if (error || !data || !Number.isSafeInteger(Number(data.config_revision)) || Number(data.config_revision) < 1) {
    if (error) console.error(`[AutoAvatar] DB read failed for ${agentId}:`, error.message);
    return null;
  }
  return {
    avatar: typeof data.avatar === "string" ? data.avatar : null,
    configRevision: Number(data.config_revision),
  };
}

/**
 * 生成完成后再次读取头像，并用 compare-and-set 提交。
 * 管理员在生成期间上传或替换头像时，条件更新影响 0 行，人工头像保持不变。
 */
export async function replaceGeneratedAvatarIfUnclaimed(
  agentId: string,
  generatedAvatar: string,
  snapshot: AgentAvatarCommitSnapshot,
): Promise<GeneratedAvatarCommitResult> {
  const client = getSupabaseClient();
  let update = client
    .from("agents")
    .update({ avatar: generatedAvatar, updated_at: new Date().toISOString() })
    .eq("id", agentId)
    .eq("config_revision", snapshot.configRevision);
  update = snapshot.avatar === null
    ? update.is("avatar", null)
    : update.eq("avatar", snapshot.avatar);
  const { data: claimed, error: updateError } = await update.select("id,config_revision").maybeSingle();
  if (updateError) {
    console.error(`[AutoAvatar] DB update failed for ${agentId}:`, updateError.message);
    await discardUnclaimedGeneratedAvatar(generatedAvatar);
    return "failed";
  }
  if (claimed) {
    invalidateAgentConfigCache(agentId);
    invalidateBotsCache();
    return "updated";
  }

  const latest = await readAgentAvatarCommitSnapshot(agentId);
  await discardUnclaimedGeneratedAvatar(generatedAvatar);
  if (!latest) return "missing";
  if (latest.avatar !== snapshot.avatar || !shouldGenerateAvatar(latest.avatar)) return "manual-preserved";
  return "revision-conflict";
}

export async function generateAvatarUrlForAgent(
  name: string,
  description: string,
  label = "auto-avatar",
  extraPrompt?: string,
  persistence: {
    ownerUserId?: string;
    source?: "agent-avatar-generated";
  } = {},
): Promise<string | null> {
  const basePrompt = buildAvatarPrompt(name, description);
  const prompt = extraPrompt?.trim()
    ? `${basePrompt} Additional visual direction: ${extraPrompt.trim()}.`
    : basePrompt;
  console.log(`[AutoAvatar] Prompt for ${label}: ${prompt.slice(0, 120)}...`);

  const imageUrl = await generateImageWithTimeout(prompt);
  if (!imageUrl) {
    console.warn(`[AutoAvatar] Image generation returned no URL for ${label}`);
    return null;
  }
  console.log(`[AutoAvatar] Image generated for ${label}; transferring to managed storage`);

  const persistedUrl = await persistAvatar(imageUrl, label, {
    allowOriginalUrlFallback: false,
    ownerUserId: persistence.ownerUserId,
    source: persistence.source,
  });
  if (!persistedUrl || persistedUrl === imageUrl) {
    throw new Error("自动头像未能保存到平台托管存储");
  }
  console.log(`[AutoAvatar] Avatar persisted for ${label}: ${persistedUrl.slice(0, 80)}...`);
  return persistedUrl;
}

/**
 * 调用 ImageGenerationClient 生成图片（带超时保护）
 *
 * @returns 生成成功的图片 URL，失败返回 null
 */
async function generateImageWithTimeout(prompt: string): Promise<string | null> {
  const configuredModel = await resolveAutoAvatarModel();
  if (configuredModel) {
    console.log(`[AutoAvatar] Using configured model: ${configuredModel.name || configuredModel.model_name}`);
    const result = await callImageGenerationAPI(
      configuredModel.api_endpoint,
      configuredModel.api_key,
      prompt,
      {
        n: 1,
        size: "1024x1024",
        quality: "high",
        modelName: configuredModel.model_name,
      },
    );
    if (!result.success || result.images.length === 0) {
      console.warn("[AutoAvatar] Configured image model failed:", result.error || "no image returned");
      return null;
    }
    return result.images[0]?.url || null;
  }

  const apiKey = process.env.COZE_WORKLOAD_IDENTITY_API_KEY;
  const baseUrl = process.env.COZE_INTEGRATION_BASE_URL;
  if (!apiKey || !baseUrl) {
    console.warn("[AutoAvatar] 跳过: 缺少COZE_WORKLOAD_IDENTITY_API_KEY或COZE_INTEGRATION_BASE_URL环境变量");
    return null;
  }
  const config = new Config({ apiKey, baseUrl });
  const client = new ImageGenerationClient(config);

  // 用 Promise.race 实现超时
  const generatePromise = (async () => {
    const response = await client.generate({
      prompt,
      size: "2K",
      watermark: false,
    });

    const helper = client.getResponseHelper(response);
    if (!helper.success) {
      console.warn("[AutoAvatar] Generation failed:", helper.errorMessages);
      return null;
    }

    return helper.imageUrls[0] || null;
  })();

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      console.warn(`[AutoAvatar] Generation timed out after ${GENERATION_TIMEOUT}ms`);
      resolve(null);
    }, GENERATION_TIMEOUT);
  });

  return Promise.race([generatePromise, timeoutPromise]);
}

async function resolveAutoAvatarModel(): Promise<AutoAvatarModel | null> {
  try {
    const client = getSupabaseClient();
    const [{ data: settings }, { data: models, error }] = await Promise.all([
      client
        .from("platform_settings")
        .select("setting_key, setting_value")
        .in("setting_key", ["auto_avatar_model_id"]),
      client
        .from("cover_models")
        .select("id,name,model_name,provider,api_endpoint,api_key,is_active,is_hidden,sort_order")
        .eq("is_active", true)
        .eq("is_hidden", false)
        .order("sort_order", { ascending: true }),
    ]);
    if (error) {
      console.warn("[AutoAvatar] Failed to query cover_models:", error.message);
      return null;
    }

    const selectedId = ((settings || []) as Array<{ setting_key: string; setting_value?: string | null }>)
      .find((item) => item.setting_key === "auto_avatar_model_id")?.setting_value || "";
    const available = filterAvailableCoverModels(models as AutoAvatarModel[] | null | undefined)
      .filter((model) => model.api_endpoint && model.api_key && model.model_name);

    if (selectedId) {
      const selected = available.find((model) => model.id === selectedId);
      if (selected) return selected;
      console.warn(`[AutoAvatar] Selected model ${selectedId} is unavailable, falling back to first enabled drawing model`);
    }

    return available[0] || null;
  } catch (error) {
    console.warn("[AutoAvatar] Failed to resolve configured model:", error instanceof Error ? error.message : error);
    return null;
  }
}
