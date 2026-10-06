import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withAuth } from "@/lib/api-middleware";
import { normalizeDisplayText } from "@/lib/display-normalization";
import { configuredExtractionMoney } from "@/lib/extract-pricing";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export const dynamic = "force-dynamic";

type PluginRow = {
  role?: string | null;
  name?: string | null;
  config?: Record<string, unknown> | null;
  price_per_use?: number | string | null;
  cost_price?: number | string | null;
};

function providerFallbackForRole(row: PluginRow | undefined, genericFallback: string): string {
  switch (row?.role) {
    case "coze_multifunction_extract": return "Coze";
    case "extract_text_third_party": return "第三方文案提取";
    case "extract_workflow": return "文案提取工作流";
    case "extract_batch_third_party": return "第三方批量提取";
    default: return genericFallback;
  }
}

function quote(row: PluginRow | undefined, fallbackProvider: string) {
  if (!row) return { available: false, provider: fallbackProvider, model: "未配置", unitPrice: null, currency: "CNY", unit: "条" };
  const config = row.config || {};
  const unitPrice = configuredExtractionMoney(row.price_per_use);
  const costPrice = configuredExtractionMoney(row.cost_price);
  const pricingReady = unitPrice !== null && costPrice !== null;
  const provider = normalizeDisplayText(config.provider || config.site_name, providerFallbackForRole(row, fallbackProvider));
  // Public runtime metadata uses a human-facing plugin/model label. Internal
  // workflow identifiers remain server-side and are not useful to end users.
  const model = normalizeDisplayText(
    config.public_model_name || config.model_display_name || row.name || row.role,
    "提取工作流",
  );
  let hasEndpoint = false;
  try {
    const endpoint = new URL(String(config.api_base_url || "").trim());
    hasEndpoint = endpoint.protocol === "https:"
      && Boolean(endpoint.hostname)
      && !endpoint.username
      && !endpoint.password;
  } catch {
    hasEndpoint = false;
  }
  const hasCredential = Boolean(String(config.api_token || config.api_key || config.client_secret_key || "").trim());
  return { available: pricingReady && hasEndpoint && hasCredential, pricingReady, provider, model, unitPrice, currency: "CNY", unit: "条" };
}

function publicQuote(value: ReturnType<typeof quote>, service: string, isAdmin: boolean) {
  const { provider, model, ...customerQuote } = value;
  return { ...customerQuote, service, ...(isAdmin ? { provider, model } : {}) };
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
    const { data, error } = await db.from("plugins")
      .select("role,name,config,price_per_use,cost_price")
      .eq("role", "coze_multifunction_extract")
      .eq("is_active", true);
    if (error || !Array.isArray(data)) {
      return NextResponse.json({ error: "工具运行配置暂时无法读取，付费提交已关闭" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    const rows = data as PluginRow[];
    // 多条 active 记录代表配置冲突；此时按未配置处理，避免无排序地选中任意凭据。
    const coze = rows.length === 1 ? rows[0] : undefined;
    // 视频、单条文案、批量与搜索共用同一三合一插件、凭据和价格。
    // 历史 extract_video/PPT6 记录只用于旧任务恢复，不参与新请求的公开运行目录。
    const sharedQuote = quote(coze, "三合一提取工作流");

    let canViewInternalModelMetadata = false;
    if (user.role === "admin") {
      const authorization = await authorizeAdminCapability(request, "models.view", {
        operation: "runtime_catalog_internal_metadata_read",
        requireStepUp: false,
      });
      canViewInternalModelMetadata = authorization.ok;
    }
    return NextResponse.json({
      items: {
        video: publicQuote(sharedQuote, "视频提取", canViewInternalModelMetadata),
        text: publicQuote(sharedQuote, "文案提取", canViewInternalModelMetadata),
        batch: publicQuote(sharedQuote, "批量提取", canViewInternalModelMetadata),
        search: publicQuote(sharedQuote, "搜索提取", canViewInternalModelMetadata),
        formatter: { available: true, service: "文字排版", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" },
        segmenter: { available: true, service: "智能分段", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" },
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
