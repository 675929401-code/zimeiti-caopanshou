type CanvasAdmissionModel = { id: string; provider?: string; selling_price?: number; pricePerUse?: number; capabilities?: Record<string, unknown> };

/** Catalog visibility and generation admission are separate contracts. */
export function canvasModelAdmissionIssue(model: CanvasAdmissionModel | undefined, kind: "image" | "video"): string {
  if (!model) return "所选模型不在当前目录，请手动选择模型";
  const caps = model.capabilities || {};
  if (caps.catalogHealthReady === false) return "模型健康状态暂不可确认，请稍后刷新";
  if (caps.permissionGranted === false || caps.authorized === false) return "当前账户尚无该模型使用权限";
  if (caps.available === false || (model.provider === "platform_public" && caps.available !== true)) {
    return typeof caps.availabilityMessage === "string" && caps.availabilityMessage.trim() ? caps.availabilityMessage : "该模型当前不可提交，请手动选择其他模型";
  }
  const price = kind === "image" ? model.selling_price : model.pricePerUse;
  if (caps.priceReady === false || typeof price !== "number" || !Number.isFinite(price) || price < 0) return "模型报价尚未确认，本次不能提交";
  return "";
}

export function canvasPublicAdmissionCapabilities(record: Record<string, unknown>) {
  const caps = record.capabilities && typeof record.capabilities === "object" ? record.capabilities as Record<string, unknown> : {};
  const rawPrice = record.publicPrice ?? record.selling_price ?? record.pricePerUse;
  const numericPrice = typeof rawPrice === "number" || typeof rawPrice === "string" && rawPrice.trim() ? Number(rawPrice) : Number.NaN;
  return { ...caps, available: (caps.available ?? record.available) === true,
    priceReady: caps.priceReady === false || record.priceReady === false ? false : Number.isFinite(numericPrice) && numericPrice >= 0,
    availabilityMessage: caps.availabilityMessage ?? record.availabilityMessage };
}

/** Validate each independent service before it can replace its own catalog. */
export async function readCanvasPublicCatalog(url: string, shape: "models" | "runtime" | "voices" | "pricing", signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) throw new Error("CATALOG_HTTP_FAILURE");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CATALOG_SHAPE_INVALID");
  const data = value as Record<string, unknown>;
  if (data.ok === false || data.success === false) throw new Error("CATALOG_READ_REJECTED");
  const config = data.config && typeof data.config === "object" ? data.config as Record<string, unknown> : null;
  const health = config?.health && typeof config.health === "object" ? config.health as Record<string, unknown> : null;
  const valid = shape === "models" ? Array.isArray(data.models)
    : shape === "runtime" ? data.mode !== "safe_default" && Boolean(config && !Array.isArray(config) && health && Array.isArray(health.disabledImageModelIds) && health.disabledImageModelIds.every(id => typeof id === "string"))
      : shape === "pricing" ? Array.isArray(data.data)
        : Boolean(data.data && typeof data.data === "object" && Array.isArray((data.data as Record<string, unknown>).voices));
  if (!valid) throw new Error("CATALOG_SHAPE_INVALID");
  return data;
}
