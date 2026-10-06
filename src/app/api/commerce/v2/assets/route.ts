import { NextResponse } from "next/server";

import { assets, publicAsset, storeAsset } from "@/commerce/server/assets";
import { requireIdentity, sameOrigin } from "@/commerce/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = requireIdentity(request);
    return NextResponse.json({
      schema: "commerce-assets/v2",
      assets: assets(identity.id).map(publicAsset),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "资产读取失败";
    return NextResponse.json({ error: message }, { status: message === "UNAUTHORIZED" ? 401 : 422 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = requireIdentity(request);
    if (Number(request.headers.get("content-length")) > 151 * 1024 * 1024) throw new Error("文件超过 150 MB");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("请选择文件");
    const asset = await storeAsset(identity.id, Buffer.from(await file.arrayBuffer()), file.type, file.name);
    return NextResponse.json({
      schema: "commerce-asset-write/v2",
      asset: publicAsset(asset),
      sideEffects: { databaseWrites: 1, assetWrites: 1, walletCalls: 0, providerCalls: 0, paidGenerationCalls: 0 },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "资产保存失败";
    const status = message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
