export const IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY = "image_model_surface_orders_v1";

export type ImageModelOrderSurface = "image-workbench" | "cover-studio" | "storyboard-workbench" | "free-canvas" | "film-studio" | "publish-center-image";

export interface ImageModelSurfaceOrders {
  "image-workbench": Record<string, number>;
  "cover-studio": Record<string, number>;
  "storyboard-workbench": Record<string, number>;
  "free-canvas": Record<string, number>;
  "film-studio": Record<string, number>;
  "publish-center-image": Record<string, number>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeOrderMap(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(object(value))
    .map(([modelId, raw]) => [modelId.trim(), Number(raw)] as const)
    .filter(([modelId, order]) => modelId.length > 0 && Number.isFinite(order) && order >= 0)
    .map(([modelId, order]) => [modelId, Math.round(order)] as const));
}

export function parseImageModelSurfaceOrders(value: unknown): ImageModelSurfaceOrders {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { parsed = {}; }
  }
  const root = object(parsed);
  const surfaces = object(root.surfaces || root);
  return {
    "image-workbench": normalizeOrderMap(surfaces["image-workbench"]),
    "cover-studio": normalizeOrderMap(surfaces["cover-studio"] || surfaces.cover),
    "storyboard-workbench": normalizeOrderMap(
      surfaces["storyboard-workbench"] || surfaces.storyboard,
    ),
    "free-canvas": normalizeOrderMap(surfaces["free-canvas"] || surfaces.canvas),
    "film-studio": normalizeOrderMap(surfaces["film-studio"] || surfaces["short-drama-film-studio"]),
    "publish-center-image": normalizeOrderMap(surfaces["publish-center-image"]),
  };
}

export function serializeImageModelSurfaceOrders(orders: ImageModelSurfaceOrders) {
  return JSON.stringify({
    version: 1,
    surfaces: {
      "image-workbench": normalizeOrderMap(orders["image-workbench"]),
      "cover-studio": normalizeOrderMap(orders["cover-studio"]),
      "storyboard-workbench": normalizeOrderMap(orders["storyboard-workbench"]),
      "free-canvas": normalizeOrderMap(orders["free-canvas"]),
      "film-studio": normalizeOrderMap(orders["film-studio"]),
      "publish-center-image": normalizeOrderMap(orders["publish-center-image"]),
    },
  });
}

export function normalizeImageModelOrderSurface(value: string | null | undefined): ImageModelOrderSurface | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "publish-center-image") return "publish-center-image";
  if (normalized === "image-workbench") return "image-workbench";
  if (normalized === "cover-studio" || normalized === "cover") return "cover-studio";
  if (normalized === "storyboard-workbench" || normalized === "storyboard") return "storyboard-workbench";
  if (normalized === "free-canvas" || normalized === "canvas") return "free-canvas";
  if (["film-studio", "short-drama-film-studio", "film_entity", "film-entity"].includes(normalized)) return "film-studio";
  return null;
}

export function imageModelSurfaceSortOrder(
  orders: ImageModelSurfaceOrders,
  surface: ImageModelOrderSurface | null,
  modelId: unknown,
) {
  if (!surface) return null;
  const value = orders[surface][String(modelId || "")];
  return Number.isFinite(value) ? value : null;
}
