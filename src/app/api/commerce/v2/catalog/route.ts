import { NextResponse } from "next/server";

import { requireIdentity } from "@/commerce/server/auth";
import { publicCommerceV2DirectorCatalog } from "@/commerce-v2/server/director-registry";
import { commerceV2Sha256 } from "@/commerce-v2/server/hash";
import { commerceV2Models } from "@/commerce-v2/server/model-catalog-adapter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = requireIdentity(request);
    const [agentModels, imageModels, videoModels] = await Promise.all([
      commerceV2Models("agent"),
      commerceV2Models("image"),
      commerceV2Models("video"),
    ]);
    return NextResponse.json({
      schema: "commerce-catalog/v2",
      workspaceKey: commerceV2Sha256({ ownerId: identity.id, namespace: "commerce-v2" }).slice(0, 24),
      directors: publicCommerceV2DirectorCatalog(),
      models: { agent: agentModels, image: imageModels, video: videoModels },
      boundaries: {
        paidSubmissionEnabled: false,
        reason: "新核心先完成零费用生产计划验收；付费提交等待用户费用上限与明确授权。",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "目录读取失败";
    return NextResponse.json({ error: message === "UNAUTHORIZED" ? "UNAUTHORIZED" : message }, { status: message === "UNAUTHORIZED" ? 401 : 503 });
  }
}
