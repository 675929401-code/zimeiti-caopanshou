export interface ManjuAssetReference {
  assetId?: string;
  path: string;
}

export interface ManjuInspirationOverride {
  enabled?: boolean;
  title?: string;
  summary?: string;
  prompt?: string;
  category?: string;
  sortOrder?: number;
}

export interface ManjuCanvasExampleOverride {
  enabled?: boolean;
  title?: string;
  tag?: string;
  cover?: ManjuAssetReference;
}

export interface ManjuBannerOverride {
  enabled?: boolean;
  asset?: ManjuAssetReference;
  poster?: ManjuAssetReference;
}

export interface ManjuShowcaseCatalogV1 {
  inspiration: { overrides: Record<string, ManjuInspirationOverride> };
  canvas_examples: {
    order?: string[];
    overrides: Record<string, ManjuCanvasExampleOverride>;
  };
  banners: { overrides: Record<string, ManjuBannerOverride> };
  hero: ManjuBannerOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeLocalPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.length > 512) {
    return undefined;
  }
  return path;
}

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function assetReference(value: unknown): ManjuAssetReference | undefined {
  if (!isRecord(value)) return undefined;
  const path = safeLocalPath(value.path);
  if (!path) return undefined;
  const assetId = shortText(value.assetId, 160);
  return { ...(assetId ? { assetId } : {}), path };
}

function inspirationOverrides(value: unknown): Record<string, ManjuInspirationOverride> {
  if (!isRecord(value)) return {};
  const output: Record<string, ManjuInspirationOverride> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!id || id.length > 160 || !isRecord(raw)) continue;
    const item: ManjuInspirationOverride = {};
    if (typeof raw.enabled === "boolean") item.enabled = raw.enabled;
    const title = shortText(raw.title, 160);
    const summary = shortText(raw.summary, 500);
    const prompt = shortText(raw.prompt, 12_000);
    const category = shortText(raw.category, 60);
    if (title) item.title = title;
    if (summary) item.summary = summary;
    if (prompt) item.prompt = prompt;
    if (category) item.category = category;
    if (typeof raw.sortOrder === "number" && Number.isInteger(raw.sortOrder)) {
      item.sortOrder = raw.sortOrder;
    }
    output[id] = item;
  }
  return output;
}

function canvasOverrides(value: unknown): Record<string, ManjuCanvasExampleOverride> {
  if (!isRecord(value)) return {};
  const output: Record<string, ManjuCanvasExampleOverride> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!id || id.length > 180 || !isRecord(raw)) continue;
    const item: ManjuCanvasExampleOverride = {};
    if (typeof raw.enabled === "boolean") item.enabled = raw.enabled;
    const title = shortText(raw.title, 160);
    const tag = shortText(raw.tag, 60);
    const cover = assetReference(raw.cover);
    if (title) item.title = title;
    if (tag) item.tag = tag;
    if (cover) item.cover = cover;
    output[id] = item;
  }
  return output;
}

function bannerOverride(value: unknown): ManjuBannerOverride {
  if (!isRecord(value)) return {};
  const output: ManjuBannerOverride = {};
  if (typeof value.enabled === "boolean") output.enabled = value.enabled;
  const asset = assetReference(value.asset);
  const poster = assetReference(value.poster);
  if (asset) output.asset = asset;
  if (poster) output.poster = poster;
  return output;
}

function bannerOverrides(value: unknown): Record<string, ManjuBannerOverride> {
  if (!isRecord(value)) return {};
  const output: Record<string, ManjuBannerOverride> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,79}:\d{1,4}$/u.test(key)) continue;
    output[key] = bannerOverride(raw);
  }
  return output;
}

/** Parse the published media domain without trusting arbitrary database JSON. */
export function readManjuShowcaseCatalog(mediaPayload: unknown): ManjuShowcaseCatalogV1 | null {
  if (!isRecord(mediaPayload) || !isRecord(mediaPayload.showcase_catalog)) return null;
  const v1 = mediaPayload.showcase_catalog.v1;
  if (!isRecord(v1)) return null;
  const inspiration = isRecord(v1.inspiration) ? v1.inspiration : {};
  const canvas = isRecord(v1.canvas_examples) ? v1.canvas_examples : {};
  const banners = isRecord(v1.banners) ? v1.banners : {};
  const order = Array.isArray(canvas.order)
    ? canvas.order.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 180)
    : undefined;
  return {
    inspiration: { overrides: inspirationOverrides(inspiration.overrides) },
    canvas_examples: {
      ...(order ? { order: Array.from(new Set(order)) } : {}),
      overrides: canvasOverrides(canvas.overrides),
    },
    banners: { overrides: bannerOverrides(banners.overrides) },
    hero: bannerOverride(v1.hero),
  };
}

export function applyManjuInspirationOverrides<T extends {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  category: string;
}>(items: readonly T[], catalog: ManjuShowcaseCatalogV1 | null): T[] {
  const overrides = catalog?.inspiration.overrides ?? {};
  return items
    .map((item, baselineIndex) => {
      const override = overrides[item.id];
      if (override?.enabled === false) return null;
      const merged = {
        ...item,
        ...(override?.title ? { title: override.title } : {}),
        ...(override?.summary ? { summary: override.summary } : {}),
        ...(override?.prompt ? { prompt: override.prompt } : {}),
        ...(override?.category ? { category: override.category } : {}),
      } as T;
      return {
        item: merged,
        baselineIndex,
        sortOrder: override?.sortOrder,
      };
    })
    .filter((entry): entry is { item: T; baselineIndex: number; sortOrder: number | undefined } => Boolean(entry))
    .sort((left, right) => {
      const leftConfigured = left.sortOrder !== undefined;
      const rightConfigured = right.sortOrder !== undefined;
      if (leftConfigured && rightConfigured && left.sortOrder !== right.sortOrder) {
        return (left.sortOrder as number) - (right.sortOrder as number);
      }
      if (leftConfigured !== rightConfigured) return leftConfigured ? -1 : 1;
      return left.baselineIndex - right.baselineIndex;
    })
    .map((entry) => entry.item);
}

export function applyManjuCanvasOverrides<T extends {
  id: string;
  title: string;
  tag?: string;
  coverImage: string;
}>(items: readonly T[], catalog: ManjuShowcaseCatalogV1 | null): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const requestedOrder = catalog?.canvas_examples.order ?? [];
  const orderedIds = [
    ...requestedOrder.filter((id) => byId.has(id)),
    ...items.map((item) => item.id).filter((id) => !requestedOrder.includes(id)),
  ];
  return orderedIds.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    const override = catalog?.canvas_examples.overrides[id];
    if (override?.enabled === false) return [];
    return [{
      ...item,
      ...(override?.title ? { title: override.title } : {}),
      ...(override?.tag ? { tag: override.tag } : {}),
      ...(override?.cover?.path ? { coverImage: override.cover.path } : {}),
    } as T];
  });
}
