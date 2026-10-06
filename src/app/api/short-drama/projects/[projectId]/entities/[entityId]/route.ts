import { NextRequest, NextResponse } from "next/server";
import {
  DeleteShortDramaEntityRequestSchema,
  ShortDramaEntityParamsSchema,
  UpdateShortDramaEntityRequestSchema,
} from "@/lib/short-drama/contracts";
import { parseShortDramaJson, shortDramaErrorResponse } from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ShortDramaProjectRepository } from "@/lib/short-drama/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string; entityId: string }>;
}

async function readParams(context: RouteContext): Promise<{ projectId: string; entityId: string }> {
  return ShortDramaEntityParamsSchema.parse(await context.params);
}

function responseHeaders(storageMode: "native" | "compat"): HeadersInit {
  return {
    "Cache-Control": "private, no-store",
    "X-Short-Drama-Storage-Mode": storageMode,
  };
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const { projectId, entityId } = await readParams(context);
    const input = await parseShortDramaJson(request, UpdateShortDramaEntityRequestSchema);
    const repository = new ShortDramaProjectRepository(auth.db);
    const entity = await repository.updateEntity(auth.userId, projectId, entityId, input);
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { entity, storageMode },
      { status: 200, headers: responseHeaders(storageMode) },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:entities:update");
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const { projectId, entityId } = await readParams(context);
    const input = DeleteShortDramaEntityRequestSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const repository = new ShortDramaProjectRepository(auth.db);
    const entity = await repository.deleteEntity(
      auth.userId,
      projectId,
      entityId,
      input.expectedRevision,
    );
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { entity, deleted: true, storageMode },
      { status: 200, headers: responseHeaders(storageMode) },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:entities:delete");
  }
}
