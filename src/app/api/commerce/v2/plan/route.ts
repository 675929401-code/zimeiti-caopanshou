import { NextResponse } from "next/server";

import { requireIdentity, sameOrigin } from "@/commerce/server/auth";
import { compileCommerceV2Production } from "@/commerce-v2/server/compile-production";

export async function POST(request: Request) {
  try {
    const identity = requireIdentity(request);
    sameOrigin(request);
    const body = await request.json();
    const { plan, planHash } = await compileCommerceV2Production(identity.id, body?.draft);
    return NextResponse.json({
      plan,
      planHash,
      sideEffects: {
        databaseWrites: 0,
        walletCalls: 0,
        providerCalls: 0,
        paidGenerationCalls: 0,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "生产计划核对失败";
    const status = message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
