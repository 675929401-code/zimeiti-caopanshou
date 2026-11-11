import { z } from "zod";

export const NativeHistoryResourceSchema = z.enum(["assets", "logs", "videos"]);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const NativeHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  startDate: day.optional(),
  endDate: day.optional(),
}).strict().refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate, "日期范围无效");
export type NativeHistoryQuery = z.infer<typeof NativeHistoryQuerySchema>;
export type NativeHistoryResource = z.infer<typeof NativeHistoryResourceSchema>;

type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value : "";
/** Existing main-site media handlers own storage authorization and retention. */
export function nativeHistoryMediaPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/api/") || /[\\\r\n\0]/u.test(value)) return "";
  const parsed = new URL(value, "https://native.invalid");
  if (parsed.origin !== "https://native.invalid" || parsed.hash) return "";
  return /^\/api\/(?:media-history\/(?:content|commerce\/content\/[A-Za-z0-9_-]+)|video\/storage\/[A-Za-z0-9_-]+)$/u.test(parsed.pathname) ? `${parsed.pathname}${parsed.search}` : "";
}
export function projectNativeHistoryMedia(row: Row, resource: "assets" | "videos") {
  const url = nativeHistoryMediaPath(row.previewPath);
  const cover = nativeHistoryMediaPath(row.thumbnailPath);
  const kind = row.kind === "video" ? "video" : "image";
  const common = { nativeSource: "main_site_media_history", nativePublishingReady: false, nativeAvailability: url ? "ready" : "unavailable" };
  if (resource === "assets") return {
    id: text(row.id), url, type: kind, mimeType: `${kind}/*`, filename: text(row.title),
    metadata: { ...(cover ? { cover } : {}), ...(typeof row.durationSeconds === "number" ? { duration: row.durationSeconds } : {}) },
    status: text(row.status), createdAt: text(row.createdAt), updatedAt: text(row.completedAt) || text(row.createdAt), ...common,
  };
  const status = row.status === "completed" ? url ? "SUCCESS" : "UNAVAILABLE" : ["failed", "cancelled"].includes(text(row.status)) ? "FAILED" : "PROCESSING";
  return {
    task_id: text(row.id), action: "主站视频生成", status, fail_reason: text(row.errorMessage),
    submit_time: text(row.createdAt), finish_time: text(row.completedAt), progress: status === "SUCCESS" ? "100%" : "",
    prompt: text(row.title), data: { model: text(row.publicModelName), status: text(row.status), ...(url ? { result_url: url, url, video_url: url } : {}), ...(cover ? { cover } : {}), ...(typeof row.durationSeconds === "number" ? { seconds: String(row.durationSeconds) } : {}) }, ...common,
  };
}
export function projectNativeHistoryConsumption(row: Row, unit: "credits" | "CNY", ownerId: string) {
  const value = row.amount;
  const raw = typeof value === "number" ? value : typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value.trim()) ? Number(value) : NaN;
  const amount = Number.isFinite(raw) ? Math.abs(raw) : null;
  return {
    id: `${unit}:${text(row.id)}`, userId: ownerId, type: "主站已结算消费", model: "以主站账单为准", channel: "主站", status: "settled",
    startedAt: text(row.created_at), createdAt: text(row.created_at), updatedAt: text(row.created_at),
    points: unit === "credits" ? amount : null,
    nativeBilling: { unit, amount, source: unit === "credits" ? "credit_transactions" : "cash_transactions" },
    nativeSource: "main_site_settled_consumption_history",
  };
}
