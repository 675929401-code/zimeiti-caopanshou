import { NextResponse } from "next/server";

import { requireIdentity, sameOrigin } from "@/commerce/server/auth";
import { compileCommerceV2Production } from "@/commerce-v2/server/compile-production";
import { readCommerceV2Quote, storeCommerceV2Quote } from "@/commerce-v2/server/quote-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = requireIdentity(request);
    const quoteId = new URL(request.url).searchParams.get("id") || "";
    const quote = readCommerceV2Quote(identity.id, quoteId);
    if (!quote) return NextResponse.json({ error: "报价不存在或不属于当前账号" }, { status: 404 });
    return NextResponse.json({ quote });
  } catch (error) {
    const message = error instanceof Error ? error.message : "报价读取失败";
    return NextResponse.json({ error: message }, { status: message === "UNAUTHORIZED" ? 401 : 422 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = requireIdentity(request);
    const body = await request.json();
    const { plan, planHash } = await compileCommerceV2Production(identity.id, body?.draft);
    const quote = storeCommerceV2Quote(identity.id, plan, planHash);
    return NextResponse.json({
      quote,
      sideEffects: { databaseWrites: 1, walletCalls: 0, providerCalls: 0, paidGenerationCalls: 0 },
      boundary: { confirmationEnabled: false, reason: "真实生成等待用户费用上限与明确授权。" },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "报价创建失败";
    const status = message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
