import { NextRequest, NextResponse } from "next/server";
import {
  CreateShortDramaEntityRequestSchema,
  ListShortDramaEntitiesQuerySchema,
  ShortDramaProjectParamsSchema,
} from "@/lib/short-drama/contracts";
import { parseShortDramaJson, shortDramaErrorResponse } from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ShortDramaProjectRepository } from "@/lib/short-drama/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

async function readProjectId(context: RouteContext): Promise<string> {
  return ShortDramaProjectParamsSchema.parse(await context.params).projectId;
}

function responseHeaders(storageMode: "native" | "compat"): HeadersInit {
  return {
    "Cache-Control": "private, no-store",
    "X-Short-Drama-Storage-Mode": storageMode,
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const query = ListShortDramaEntitiesQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const repository = new ShortDramaProjectRepository(auth.db);
    const result = await repository.listEntities(auth.userId, projectId, query);
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { ...result, storageMode },
      { status: 200, headers: responseHeaders(storageMode) },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:entities:list");
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const input = await parseShortDramaJson(request, CreateShortDramaEntityRequestSchema);
    const repository = new ShortDramaProjectRepository(auth.db);
    const result = await repository.createEntity(auth.userId, projectId, input);
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { ...result, storageMode },
      {
        status: result.replayed ? 200 : 201,
        headers: {
          ...responseHeaders(storageMode),
          ...(result.replayed ? { "Idempotency-Replayed": "true" } : {}),
        },
      },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:entities:create");
  }
}
