import "server-only";
import { NextRequest } from "next/server";
import type { AuthUser, getSupabase } from "@/lib/api-middleware";
import { NativeHistoryQuerySchema, projectNativeHistoryConsumption, projectNativeHistoryMedia, type NativeHistoryResource } from "@/lib/native-history-contract";
import { GET as readMainMediaHistory } from "@/app/api/media-history/route";
import { PublishingError } from "./publishing-service";

type DB = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const unavailable = () => new PublishingError("NATIVE_HISTORY_UNAVAILABLE", "主站记录暂时不可确认，请稍后重试", 503);
interface Dependencies { mediaHistory?: (request: NextRequest) => Promise<Response> }
/** GET-only projections. Never call a provider, settle billing, or confirm a publishing asset. */
export async function readNativeHistory(user: AuthUser, db: DB, resource: NativeHistoryResource, request: NextRequest, dependencies: Dependencies = {}) {
  const search = request.nextUrl.searchParams;
  if (new Set(search.keys()).size !== [...search.keys()].length) throw new PublishingError("NATIVE_INPUT_INVALID", "查询参数不能重复", 400);
  const parsed = NativeHistoryQuerySchema.safeParse(Object.fromEntries(search));
  if (!parsed.success) throw new PublishingError("NATIVE_INPUT_INVALID", "历史记录查询参数无效", 400);
  const query = parsed.data, offset = (query.page - 1) * query.pageSize;
  if (resource !== "logs") {
    if (query.startDate || query.endDate) throw new PublishingError("NATIVE_INPUT_INVALID", "媒体历史请使用页面筛选项", 400);
    const url = new URL("/api/media-history", request.url);
    url.search = new URLSearchParams({ limit: String(query.pageSize), offset: String(offset), kind: resource === "videos" ? "video" : "all" }).toString();
    const headers = new Headers();
    headers.set("cookie", request.headers.get("cookie") ?? "");
    const result = await (dependencies.mediaHistory ?? readMainMediaHistory)(new NextRequest(url, { headers }));
    if (!result.ok) throw unavailable();
    const body = object(await result.json());
    if (!Array.isArray(body.items)) throw unavailable();
    const total = typeof body.totalCount === "number" && Number.isSafeInteger(body.totalCount) && body.totalCount >= 0 ? body.totalCount : null;
    const partial = total === null || Array.isArray(body.sourceFailures) && body.sourceFailures.length > 0;
    return {
      page: query.page, pageSize: query.pageSize, total, totalPages: total === null ? null : Math.ceil(total / query.pageSize),
      list: body.items.map(item => projectNativeHistoryMedia(object(item), resource)),
      nativeAvailability: partial ? "unknown" : total === 0 ? "no_data" : "ready",
      nativeSource: "main_site_media_history", nativePublishingReady: false,
      nativeMessage: partial ? "部分主站媒体记录暂不可确认" : "主站媒体历史；用于发布时仍需导入并确认素材",
    };
  }
  const prefix = offset + query.pageSize;
  const read = async (table: "credit_transactions" | "cash_transactions") => {
    let statement = db.from(table).select("id,amount,created_at", { count: "exact" }).eq("user_id", user.id);
    statement = table === "credit_transactions" ? statement.in("type", ["consume", "consumption"]) : statement.eq("type", "consume");
    if (query.startDate) statement = statement.gte("created_at", `${query.startDate}T00:00:00.000Z`);
    if (query.endDate) statement = statement.lt("created_at", new Date(new Date(`${query.endDate}T00:00:00.000Z`).getTime() + 86400000).toISOString());
    statement = statement.order("created_at", { ascending: false }).order("id", { ascending: false });
    const rows: Row[] = [];
    let count: number | null = null;
    // PostgREST can cap one response. Enumerate the bounded union prefix in
    // explicit small pages; a truncated response is not an empty later page.
    for (let lower = 0; lower < prefix; lower += 500) {
      const upper = Math.min(lower + 499, prefix - 1);
      const result = await statement.range(lower, upper);
      if (result.error || !Array.isArray(result.data) || typeof result.count !== "number" || !Number.isSafeInteger(result.count) || result.count < 0) throw unavailable();
      if (count !== null && count !== result.count) throw unavailable();
      count = result.count;
      if (result.data.length !== Math.min(upper - lower + 1, Math.max(0, count - lower))) throw unavailable();
      rows.push(...result.data.map(object));
      if (rows.length >= count) break;
    }
    return { count: count ?? 0, list: rows.map(row => projectNativeHistoryConsumption(row, table === "credit_transactions" ? "credits" : "CNY", user.id)) };
  };
  const [credits, cash] = await Promise.all([read("credit_transactions"), read("cash_transactions")]);
  const rows = [...credits.list, ...cash.list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const total = credits.count + cash.count;
  return { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize), list: rows.slice(offset, offset + query.pageSize), nativeAvailability: total === 0 ? "no_data" : "ready", nativeSource: "main_site_settled_consumption_history", nativeMessage: "显示主站已结算的积分与现金消费，两种单位分别标示" };
}
