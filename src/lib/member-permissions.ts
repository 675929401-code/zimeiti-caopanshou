import {
  PRIMARY_NAVIGATION,
  PRIMARY_NAVIGATION_ORDER,
  type PrimaryNavigationKey,
} from "@/lib/marketplace-navigation";
import {
  AGENT_NAVIGATION_OPTIONS,
  normalizeAllowedAgentNavigationKeys,
} from "@/lib/agent-category-access";

export type MemberPermissionSnapshot = {
  userId: string;
  role: string;
  featureNavigationKeys: PrimaryNavigationKey[];
  agentNavigationKeys: string[];
  revision: number;
  checksum: string;
  sourceProfileKey: string | null;
  sourceProfileVersion: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string;
  integrityValid: boolean;
  authorityStatus: "ready" | "admin" | "missing" | "invalid" | "unavailable";
};

export const MEMBER_FEATURE_PERMISSION_OPTIONS = Object.freeze(
  PRIMARY_NAVIGATION.map((item) => ({
    key: item.key,
    label: item.label,
    route: item.route,
    description: item.description,
  })),
);

const FEATURE_KEY_SET = new Set<string>(PRIMARY_NAVIGATION_ORDER);

export function normalizeFeatureNavigationKeys(value: unknown): PrimaryNavigationKey[] {
  if (!Array.isArray(value)) return [];
  const requested = new Set(
    value
      .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      .map((item) => String(item).trim())
      .filter((item) => FEATURE_KEY_SET.has(item)),
  );
  return PRIMARY_NAVIGATION_ORDER.filter((key) => requested.has(key));
}

export function normalizeMemberAgentNavigationKeys(value: unknown): string[] {
  const requested = new Set(normalizeAllowedAgentNavigationKeys(value));
  return AGENT_NAVIGATION_OPTIONS.map((item) => item.key).filter((key) => requested.has(key));
}

export function hasFeaturePermission(
  _role: unknown,
  grantedKeys: unknown,
  requiredKey: PrimaryNavigationKey,
): boolean {
  return normalizeFeatureNavigationKeys(grantedKeys).includes(requiredKey);
}

const PUBLIC_OR_ACCOUNT_PATHS = [
  "/admin",
  "/help",
  "/login",
  "/register",
  "/profile",
  "/recharge",
  "/payment",
] as const;

/**
 * Resolve a browser page to its stable business-feature permission key.
 * The public homepage remains outside this mapping because it is also the
 * login/landing surface.  Once the app is entered, AgentMarketplace applies
 * the `marketplace` grant to its private navigation and Agent catalog.
 */
export function featurePermissionForPath(pathname: string): PrimaryNavigationKey | null {
  const path = pathname.split("?")[0].replace(/\/+$/u, "") || "/";
  if (path === "/" || PUBLIC_OR_ACCOUNT_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return null;
  }
  if (["/tools", "/extract", "/formatter", "/segmenter"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return "toolbox";
  if (["/storyboard-workbench", "/short-drama"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return "storyboard_workbench";
  if (path === "/image-workbench" || path.startsWith("/image-workbench/")) return "image_workbench";
  if (path === "/video" || path.startsWith("/video/")) return "create";
  if (path === "/voice-studio" || path.startsWith("/voice-studio/")) return "voice";
  if (path === "/cover" || path.startsWith("/cover/")) return "cover";
  if (path === "/youcai" || path.startsWith("/youcai/")) return "youcai";
  if (path === "/commerce" || path.startsWith("/commerce/")) return "commerce_agent";
  if (["/navigation", "/media-history", "/creative-horizon"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return "marketplace";
  return null;
}

const API_FEATURE_PREFIXES: ReadonlyArray<readonly [string, PrimaryNavigationKey]> = [
  ["/api/commerce-model-gateway", "commerce_agent"],
  ["/api/commerce-billing-gateway", "commerce_agent"],
  ["/api/commerce", "commerce_agent"],
  ["/api/storyboard", "storyboard_workbench"],
  ["/api/short-drama", "storyboard_workbench"],
  ["/api/drama", "storyboard_workbench"],
  ["/api/image-workbench", "image_workbench"],
  ["/api/image", "image_workbench"],
  ["/api/video", "create"],
  ["/api/voice", "voice"],
  ["/api/cover-models", "cover"],
  ["/api/cover", "cover"],
  ["/api/youcai", "youcai"],
  ["/api/extract", "toolbox"],
  ["/api/formatter", "toolbox"],
  ["/api/segmenter", "toolbox"],
  ["/api/tools", "toolbox"],
  ["/api/agent-favorites", "marketplace"],
  ["/api/categories", "marketplace"],
  ["/api/bots", "marketplace"],
  ["/api/chat", "marketplace"],
  ["/api/llm", "marketplace"],
] as const;

export function featurePermissionForApiPath(pathname: string): PrimaryNavigationKey | null {
  const path = pathname.split("?")[0].replace(/\/+$/u, "") || "/";
  return API_FEATURE_PREFIXES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] || null;
}
