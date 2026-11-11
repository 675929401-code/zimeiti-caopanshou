export const VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY = "video_model_surface_orders_v1";

export type VideoModelOrderSurface = "ai-video" | "storyboard" | "free-canvas" | "film-studio" | "commerce-agent" | "publish-center-video";

export interface VideoModelSurfaceOrders {
  "ai-video": Record<string, number>;
  storyboard: Record<string, number>;
  "free-canvas": Record<string, number>;
  "film-studio": Record<string, number>;
  "commerce-agent": Record<string, number>;
  "publish-center-video": Record<string, number>;
}

const EMPTY_ORDERS: VideoModelSurfaceOrders = {
  "ai-video": {},
  storyboard: {},
  "free-canvas": {},
  "film-studio": {},
  "commerce-agent": {},
  "publish-center-video": {},
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeOrderMap(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(asRecord(value))
      .map(([modelId, raw]) => [modelId.trim(), Number(raw)] as const)
      .filter(([modelId, order]) => modelId.length > 0 && Number.isFinite(order) && order >= 0)
      .map(([modelId, order]) => [modelId, Math.round(order)] as const),
  );
}

export function normalizeVideoModelOrderSurface(value: string | null | undefined): VideoModelOrderSurface | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "publish-center-video") return "publish-center-video";
  if (normalized === "ai-video" || normalized === "video-page") return "ai-video";
  if (normalized === "storyboard" || normalized === "storyboard-workbench") return "storyboard";
  if (normalized === "free-canvas" || normalized === "canvas") return "free-canvas";
  if (["film-studio", "short-drama-film-studio", "film_video", "film-video"].includes(normalized)) return "film-studio";
  if (["commerce-agent", "commerce", "commerce-video"].includes(normalized)) return "commerce-agent";
  return null;
}

export function parseVideoModelSurfaceOrders(value: unknown): VideoModelSurfaceOrders {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ...EMPTY_ORDERS, "ai-video": {}, storyboard: {}, "free-canvas": {}, "film-studio": {}, "commerce-agent": {}, "publish-center-video": {} };
    }
  }
  const root = asRecord(parsed);
  const surfaces = asRecord(root.surfaces || root);
  return {
    "ai-video": normalizeOrderMap(surfaces["ai-video"] || surfaces["video-page"]),
    storyboard: normalizeOrderMap(surfaces.storyboard || surfaces["storyboard-workbench"]),
    "free-canvas": normalizeOrderMap(surfaces["free-canvas"] || surfaces.canvas),
    "film-studio": normalizeOrderMap(surfaces["film-studio"] || surfaces["short-drama-film-studio"]),
    "commerce-agent": normalizeOrderMap(surfaces["commerce-agent"] || surfaces.commerce),
    "publish-center-video": normalizeOrderMap(surfaces["publish-center-video"]),
  };
}

export function serializeVideoModelSurfaceOrders(orders: VideoModelSurfaceOrders): string {
  return JSON.stringify({
    version: 1,
    surfaces: {
      "ai-video": normalizeOrderMap(orders["ai-video"]),
      storyboard: normalizeOrderMap(orders.storyboard),
      "free-canvas": normalizeOrderMap(orders["free-canvas"]),
      "film-studio": normalizeOrderMap(orders["film-studio"]),
      "commerce-agent": normalizeOrderMap(orders["commerce-agent"]),
      "publish-center-video": normalizeOrderMap(orders["publish-center-video"]),
    },
  });
}

export function videoModelSurfaceSortOrder(
  orders: VideoModelSurfaceOrders,
  surface: VideoModelOrderSurface | null,
  modelId: unknown,
): number | null {
  if (!surface) return null;
  const configured = orders[surface][String(modelId || "")];
  return Number.isFinite(configured) ? configured : null;
}
