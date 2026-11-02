/**
 * 对话模型热切换：从公开对话模型目录中收敛 GPT / Claude / DeepSeek 模型族。
 *
 * 这里只做“显示层归一化”：真正调用仍使用目录返回的 pm_ 公开模型标识，
 * 不复制内部模型名、渠道、密钥或价格配置。目录本身是唯一数据源，
 * 目录里没有的模型不会在本模块中凭空出现。
 */

export type ChatModelBrand = "gpt" | "claude" | "deepseek";

export interface ChatModelOption {
  /** 公开目录使用的 pm_ 标识，服务端据此解析真实模型行。 */
  id: string;
  /** 下拉框展示名，只用于界面，不承担路由或持久化主键职责。 */
  label: string;
  brand: ChatModelBrand;
}

export interface ChatModelGroup {
  brand: ChatModelBrand;
  title: string;
  models: ChatModelOption[];
}

export interface ChatModelCatalogRow {
  id: string;
  displayName: string;
}

const BRAND_ORDER = ["gpt", "claude", "deepseek"] as const;

const BRAND_TITLES: Record<ChatModelBrand, string> = {
  gpt: "GPT 系列",
  claude: "Claude 系列",
  deepseek: "DeepSeek 系列",
};

/**
 * 渠道 A/B、密钥轮换、专用长输出等内部标注只影响展示名。
 * 命中越少的分组条目越“干净”，同名条目去重时优先保留。
 */
const INTERNAL_ANNOTATIONS: readonly RegExp[] = [
  /(?:秘钥|密钥)\s*\d*/gu,
  /(?:故事板|分镜|漫剧)?长输出/gu,
  /渠道\s*[A-Za-z0-9一二三四五六七八九十]+/gu,
  /(?:配置)?待(?:验收|开放)/gu,
  /\b(?:default|g2|max)\b/giu,
];

const EDGE_SEPARATORS = /^[\s·|｜/／—–-]+|[\s·|｜/／—–-]+$/gu;

function trimSeparators(value: string): string {
  return value
    .replace(/\s{2,}/gu, " ")
    .replace(EDGE_SEPARATORS, "")
    .trim();
}

function stripInternalAnnotations(displayName: string): { label: string; removed: number } {
  let removed = 0;
  let label = displayName;
  for (const pattern of INTERNAL_ANNOTATIONS) {
    label = label.replace(pattern, () => {
      removed += 1;
      return " ";
    });
  }
  return { label: trimSeparators(label), removed };
}

function prettifyBrandLabel(label: string, brand: ChatModelBrand): string {
  if (brand === "claude") {
    const dashed = /^claude[\s_-]+(opus|sonnet|haiku)[\s_-]+(\d+)[._-](\d+)(?:[._-](\d+))?$/iu.exec(label);
    if (dashed) {
      const tier = dashed[1].charAt(0).toUpperCase() + dashed[1].slice(1).toLowerCase();
      const version = [dashed[2], dashed[3], dashed[4]].filter(Boolean).join(".");
      return `Claude ${tier} ${version}`;
    }
    return label.replace(/^claude/iu, "Claude");
  }
  if (brand === "deepseek") return label.replace(/^deepseek/iu, "DeepSeek");
  const versioned = /^gpt[\s_-]+(.+)$/iu.exec(label);
  if (versioned) return `GPT-${versioned[1].trim()}`;
  return label.replace(/^gpt/iu, "GPT");
}

/** 只认 GPT / Claude / DeepSeek 模型族；其他品牌返回 null。 */
export function chatModelBrand(displayName: string): ChatModelBrand | null {
  const value = String(displayName || "").trim();
  if (!value) return null;
  if (/^gpt(?:[\s_-]|$)/iu.test(value)) return "gpt";
  if (/^(?:anthropic[\s_-]+)?claude(?:[\s_-]|$)/iu.test(value)) return "claude";
  if (/^deepseek(?:[\s_-]|$)/iu.test(value)) return "deepseek";
  return null;
}

/**
 * 把公开目录归一成分组选项：过滤非 GPT/Claude/DeepSeek、清理内部标注、同名去重。
 * 顺序保持目录原有顺序，按 GPT、Claude、DeepSeek 排列品牌组。
 */
export function buildChatModelGroups(rows: readonly ChatModelCatalogRow[]): ChatModelGroup[] {
  const bestByLabel = new Map<string, { option: ChatModelOption; penalty: number; order: number }>();

  rows.forEach((row, order) => {
    const id = String(row.id || "").trim();
    const raw = String(row.displayName || "").trim();
    if (!id || !raw) return;
    const brand = chatModelBrand(raw);
    if (!brand) return;
    const stripped = stripInternalAnnotations(raw);
    if (!stripped.label) return;
    const label = prettifyBrandLabel(stripped.label, brand);
    if (!label) return;
    const key = `${brand}:${label.toLowerCase()}`;
    const current = bestByLabel.get(key);
    if (!current || stripped.removed < current.penalty) {
      bestByLabel.set(key, { option: { id, label, brand }, penalty: stripped.removed, order });
    }
  });

  const groups: ChatModelGroup[] = BRAND_ORDER.map((brand) => ({
    brand,
    title: BRAND_TITLES[brand],
    models: [],
  }));

  [...bestByLabel.values()]
    .sort((left, right) => left.order - right.order)
    .forEach((entry) => {
      groups.find((group) => group.brand === entry.option.brand)?.models.push(entry.option);
    });

  return groups.filter((group) => group.models.length > 0);
}

export function allChatModelOptions(groups: readonly ChatModelGroup[]): ChatModelOption[] {
  return groups.flatMap((group) => group.models);
}

export function findChatModelOption(
  groups: readonly ChatModelGroup[],
  modelId: string | null | undefined,
): ChatModelOption | null {
  const value = typeof modelId === "string" ? modelId.trim() : "";
  if (!value) return null;
  return allChatModelOptions(groups).find((option) => option.id === value) ?? null;
}

/** 已保存的选择仍存在于当前目录时才算有效，避免把下架模型继续发给服务端。 */
export function resolveChatModelId(
  storedModelId: string | null | undefined,
  groups: readonly ChatModelGroup[],
): string | null {
  return findChatModelOption(groups, storedModelId)?.id ?? null;
}

/** 无显式选择时展示的默认项：优先 GPT-5.6 Terra，其次任意 GPT，最后第一个可用项。 */
export function defaultChatModelOption(groups: readonly ChatModelGroup[]): ChatModelOption | null {
  const options = allChatModelOptions(groups);
  if (options.length === 0) return null;
  return options.find((option) => option.brand === "gpt" && /5\.6/iu.test(option.label) && /terra/iu.test(option.label))
    ?? options.find((option) => option.brand === "gpt")
    ?? options[0];
}

/**
 * 头部徽标要显示“真正会使用的模型”：
 * 有显式选择显示选择项，否则显示服务端默认对应的目录项。
 */
export function selectedChatModelLabel(
  groups: readonly ChatModelGroup[],
  selectedModelId: string | null | undefined,
): string {
  return findChatModelOption(groups, selectedModelId)?.label
    ?? defaultChatModelOption(groups)?.label
    ?? "";
}

/** 账户、会话和目标智能体共同限定选择；不读取旧的全局选择。 */
export function chatModelSelectionScope(accountId: string | null | undefined, conversationId: string | null | undefined, targetAgentId: string | null | undefined): string | null {
  return accountId && targetAgentId ? JSON.stringify([accountId, conversationId ?? null, targetAgentId]) : null;
}

export function chatModelSelectionStorageKey(scope: string): string {
  return `chat_model_selection_v2:${scope}`;
}

/** Transfer only the submitted draft's choice to the exact conversation it created. */
export function newConversationChatModelSelection(input: {
  mode: string;
  ownerId?: string;
  currentOwnerId: string;
  createdConversationId?: string;
  currentConversationId: string;
  targetAgentId: string;
  currentTargetAgentId: string;
  modelId?: string;
}): { scope: string; id: string } | null {
  if (input.mode !== "new-conversation" || !input.ownerId || input.ownerId !== input.currentOwnerId
    || !input.createdConversationId || input.createdConversationId !== input.currentConversationId
    || input.targetAgentId !== input.currentTargetAgentId || !input.modelId) return null;
  const scope = chatModelSelectionScope(input.ownerId, input.createdConversationId, input.targetAgentId);
  return scope ? { scope, id: input.modelId } : null;
}
