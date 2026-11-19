import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { calculateCredits, getBillingConfig } from "@/lib/billing";

export async function GET(request: NextRequest) {
  const auth = await authorizeAdminCapability(request, "billing.view", {operation: "billing_preview"});
  if (!auth.ok) return auth.response;
  const reply = (body: object, status = 200) => NextResponse.json(body,{status, headers: {"Cache-Control": "private, no-store"}});
  const params = request.nextUrl.searchParams;
  function number(key: string, integer = false) {
    const raw = params.get(key);
    if (raw === null || !raw.trim() || params.getAll(key).length !== 1) return NaN;
    const value = Number(raw);
    return value >= 0 && value <= 1e9 && (!integer || Number.isSafeInteger(value)) ? value : NaN;
  }
  const inputCostPerMillion = number("input"), cachedCostPerMillion = number("cache"), outputCostPerMillion = number("output");
  const profitMargin = number("margin"), prompt = number("prompt",true), cached = number("hit",true), completion = number("completion",true);
  if (![inputCostPerMillion,cachedCostPerMillion,outputCostPerMillion,profitMargin,prompt,cached,completion].every(Number.isFinite)
      || profitMargin >= 100 || cached > prompt) return reply({error: "请核对成本和用量，缓存命中数须包含在输入总数内。"},400);
  try {
    const config = {...await getBillingConfig(), inputCostPerMillion, cachedCostPerMillion, outputCostPerMillion,
      profitMargin, tokenRoundingEnabled: false, tokenRoundingUnit: 0};
    const result = calculateCredits(config,prompt,completion,cached);
    return reply({cost: result.actualCostRmb, sale: result.sellPriceRmb, credits: result.creditsCharged, creditsPerYuan: config.creditsPerYuan});
  } catch {
    return reply({error: "当前计费配置无法读取，请稍后重试。"},503);
  }
}
