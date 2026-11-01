import {
  BIP_CATEGORY,
  BIP_CATEGORY_LABEL,
  TASK_CATEGORIES,
  authorizationCategory,
  displayCategory,
} from "@/lib/business-ip/catalog";

const CATEGORY_DISPLAY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  自用: "内部工具",
});

export const AGENT_NAVIGATION_OPTIONS = Object.freeze([
  { key: BIP_CATEGORY, label: BIP_CATEGORY_LABEL },
  ...TASK_CATEGORIES.map(({ key, label }) => ({ key, label })),
  { key: "自用", label: "内部工具" },
] as const);

const AGENT_NAVIGATION_KEYS = new Set<string>(
  AGENT_NAVIGATION_OPTIONS.map((item) => item.key),
);

type NavigationAgent = {
  id: string;
  name: string;
  category?: string | null;
};

/**
 * Category ids are an explicit allow-list for ordinary users.
 * Legacy null/undefined values are deliberately normalized to an empty list:
 * no selection means no Agent navigation or Agent execution permission.
 */
export function normalizeAllowedAgentCategoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      .map((item) => String(item).trim())
      .filter(Boolean),
  )];
}

export function normalizeAllowedAgentNavigationKeys(value: unknown): string[] {
  return normalizeAllowedAgentCategoryIds(value).filter((key) => AGENT_NAVIGATION_KEYS.has(key));
}

export function isAgentNavigationKey(value: unknown): value is string {
  return typeof value === "string" && AGENT_NAVIGATION_KEYS.has(value);
}

export function getAgentNavigationKey(agent: NavigationAgent): string | null {
  const key = authorizationCategory({
    id: String(agent.id || ""),
    name: String(agent.name || ""),
    category: agent.category ? String(agent.category) : undefined,
  });
  return AGENT_NAVIGATION_KEYS.has(key) ? key : null;
}

/** Both the server's current agent ID and the existing authorization grant are required. */
export function isAgentAuthorizedInSnapshot(
  agent: NavigationAgent,
  agentIds: ReadonlySet<string>,
  navigationKeys: ReadonlySet<string>,
): boolean {
  const key = getAgentNavigationKey(agent);
  return Boolean(key && agentIds.has(agent.id) && navigationKeys.has(key));
}

/** A display tab can be added only for an already authorized agent. */
export function getAuthorizedAgentDisplayKeys(
  agents: ReadonlyArray<NavigationAgent>,
  agentIds: ReadonlySet<string>,
  navigationKeys: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const agent of agents) {
    if (!isAgentAuthorizedInSnapshot(agent, agentIds, navigationKeys)) continue;
    const key = displayCategory({ ...agent, category: agent.category || undefined });
    if (AGENT_NAVIGATION_KEYS.has(key)) keys.add(key);
  }
  return keys;
}

/**
 * Resolve persisted permissions to the current five navigation keys.
 * Stable navigation keys are authoritative once present. Older UUID grants are
 * read only as a compatibility bridge and are converted when the admin saves.
 */
export function resolveAllowedAgentNavigationKeys(
  value: unknown,
  legacyCategories: ReadonlyArray<{ id: unknown; name: unknown }> = [],
  agents: ReadonlyArray<NavigationAgent> = [],
): string[] {
  const stored = normalizeAllowedAgentCategoryIds(value);
  const stable = stored.filter((key) => AGENT_NAVIGATION_KEYS.has(key));
  if (stable.length > 0) return stable;
  if (stored.length === 0) return [];

  const allowedLegacyNames = new Set(
    legacyCategories
      .filter((category) => stored.includes(String(category.id || "")))
      .map((category) => String(category.name || ""))
      .filter(Boolean),
  );
  const resolved = new Set<string>();
  for (const agent of agents) {
    if (!agent.category || !allowedLegacyNames.has(String(agent.category))) continue;
    const key = getAgentNavigationKey(agent);
    if (key) resolved.add(key);
  }
  return AGENT_NAVIGATION_OPTIONS.map((item) => item.key).filter((key) => resolved.has(key));
}

export function publicAllowedAgentCategoryIds(role: unknown, value: unknown): string[] | null {
  return String(role || "student") === "admin"
    ? null
    : normalizeAllowedAgentCategoryIds(value);
}

export function canRoleAccessAgentCategory(
  role: unknown,
  allowedCategoryIds: unknown,
  categoryId: unknown,
): boolean {
  if (String(role || "student") === "admin") return true;
  const normalizedCategoryId = String(categoryId || "").trim();
  if (!normalizedCategoryId) return false;
  return normalizeAllowedAgentCategoryIds(allowedCategoryIds).includes(normalizedCategoryId);
}

export function getAgentCategoryDisplayName(name: unknown): string {
  const normalizedName = String(name || "").trim();
  return CATEGORY_DISPLAY_ALIASES[normalizedName] || normalizedName;
}
