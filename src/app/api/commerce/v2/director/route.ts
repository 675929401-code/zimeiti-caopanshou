import { NextResponse } from "next/server";

import { requireIdentity, sameOrigin } from "@/commerce/server/auth";
import { applyDirector, directorPage, openDirector, quoteDirectorTurn, readDirector } from "@/commerce/server/director-conversation";
import { parseProductionDraft } from "@/commerce-v2/domain/parse-draft";
import { validateDirectorMaterialContract } from "@/commerce-v2/domain/director-material-contract";
import { commerceV2DirectorDefinition } from "@/commerce-v2/server/director-registry";
import { canonicalizeProductionMaterials } from "@/commerce-v2/server/material-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function settings(draft: ReturnType<typeof parseProductionDraft>) {
  if (!draft.director || !draft.videoSettings) throw new Error("编导绑定或视频设置缺失");
  return {
    skillKey: draft.director.skillKey,
    selections: {},
    spokenLanguage: "中文",
    durationSeconds: draft.videoSettings.durationSeconds,
    generateAudio: draft.videoSettings.generateAudio,
  };
}

function prepared(owner: string, rawDraft: unknown, enforceMaterials = true) {
  const draft = canonicalizeProductionMaterials(owner, parseProductionDraft(rawDraft));
  if (!draft.director?.conversationId) throw new Error("编导会话标识缺失");
  const director = commerceV2DirectorDefinition(draft.director.skillKey, draft.director.registryVersion, draft.director.promptVersion);
  const issues = validateDirectorMaterialContract(draft.materials, director.slots);
  if (enforceMaterials && issues.length) throw new Error(issues.join("；"));
  const references = draft.materials.flatMap((material) => {
    if (!material.assetId) {
      if (enforceMaterials) throw new Error(`素材“${material.name}”尚未持久化`);
      return [];
    }
    return [{ id: material.assetId, slot: material.role, instanceId: material.instanceId }];
  });
  return { draft, director, references, settings: settings(draft) };
}

export async function GET(request: Request) {
  try {
    const identity = requireIdentity(request);
    const id = new URL(request.url).searchParams.get("id") || "";
    return NextResponse.json({ conversation: directorPage(readDirector(identity.id, id)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "编导会话读取失败";
    return NextResponse.json({ error: message }, { status: message === "UNAUTHORIZED" ? 401 : 422 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = requireIdentity(request);
    const body = await request.json();
    const value = prepared(identity.id, body?.draft, body.action !== "open");
    if (body.action === "open") {
      const conversation = directorPage(openDirector(identity.id, value.draft.director!.conversationId!, value.settings));
      return NextResponse.json({ conversation, sideEffects: { databaseWrites: 1, walletCalls: 0, providerCalls: 0, paidGenerationCalls: 0 } });
    }
    if (body.action === "quote") {
      const quote = await quoteDirectorTurn(identity.id, {
        id: value.draft.director!.conversationId!,
        operationId: body.operationId,
        message: value.draft.prompt,
        expectedScriptMessageId: body.expectedScriptMessageId ?? null,
        settings: value.settings,
        references: value.references,
      });
      return NextResponse.json({
        quote,
        boundary: { confirmationEnabled: false, reason: "编导真实推理同样等待用户明确费用授权。" },
        sideEffects: { databaseWrites: 1, walletCalls: 0, providerCalls: 0, paidGenerationCalls: 0 },
      }, { status: 201 });
    }
    if (body.action === "apply") {
      const application = applyDirector(identity.id, {
        id: value.draft.director!.conversationId!,
        messageId: body.messageId,
        expectedScriptMessageId: body.expectedScriptMessageId,
        settings: value.settings,
        references: value.references,
        videoSettings: {
          aspectRatio: value.draft.videoSettings!.aspectRatio,
          resolution: value.draft.videoSettings!.resolution,
          duration: value.draft.videoSettings!.durationSeconds,
          generateAudio: value.draft.videoSettings!.generateAudio,
        },
      });
      return NextResponse.json({ application, sideEffects: { databaseWrites: 1, walletCalls: 0, providerCalls: 0, paidGenerationCalls: 0 } });
    }
    throw new Error("编导操作无效");
  } catch (error) {
    const message = error instanceof Error ? error.message : "编导操作失败";
    const status = message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
