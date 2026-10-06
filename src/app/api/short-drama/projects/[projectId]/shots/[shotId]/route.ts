import { NextRequest, NextResponse } from "next/server";
import {
  DeleteShortDramaShotRequestSchema,
  ShortDramaShotParamsSchema,
  UpdateShortDramaShotRequestSchema,
} from "@/lib/short-drama/contracts";
import { parseShortDramaJson, shortDramaErrorResponse } from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ShortDramaProjectRepository } from "@/lib/short-drama/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string; shotId: string }>;
}

async function readParams(context: RouteContext): Promise<{ projectId: string; shotId: string }> {
  return ShortDramaShotParamsSchema.parse(await context.params);
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
    const { projectId, shotId } = await readParams(context);
    const input = await parseShortDramaJson(request, UpdateShortDramaShotRequestSchema);
    const repository = new ShortDramaProjectRepository(auth.db);
    const shot = await repository.updateShot(auth.userId, projectId, shotId, input);
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { shot, storageMode },
      { status: 200, headers: responseHeaders(storageMode) },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:shots:update");
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const { projectId, shotId } = await readParams(context);
    const input = DeleteShortDramaShotRequestSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const repository = new ShortDramaProjectRepository(auth.db);
    const shot = await repository.deleteShot(
      auth.userId,
      projectId,
      shotId,
      input.expectedRevision,
    );
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { shot, deleted: true, storageMode },
      { status: 200, headers: responseHeaders(storageMode) },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:shots:delete");
  }
}
