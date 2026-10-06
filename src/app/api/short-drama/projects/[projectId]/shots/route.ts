import { NextRequest, NextResponse } from "next/server";
import {
  CreateShortDramaShotRequestSchema,
  ListShortDramaShotsQuerySchema,
  ShortDramaProjectParamsSchema,
} from "@/lib/short-drama/contracts";
import { parseShortDramaJson, shortDramaErrorResponse } from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ShortDramaProjectRepository } from "@/lib/short-drama/repository";
import { ShortDramaRepositoryError } from "@/lib/short-drama/repository";
import { validateStoryboardEpisodeReadiness } from "@/lib/short-drama/episode-workflow";

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
    const query = ListShortDramaShotsQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const repository = new ShortDramaProjectRepository(auth.db);
    const result = await repository.listShots(auth.userId, projectId, query);
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { ...result, storageMode },
      { status: 200, headers: responseHeaders(storageMode) },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:shots:list");
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const input = await parseShortDramaJson(request, CreateShortDramaShotRequestSchema);
    const repository = new ShortDramaProjectRepository(auth.db);
    const project = await repository.getProject(auth.userId, projectId);
    if (!project) {
      throw new ShortDramaRepositoryError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
    const readinessIssue = validateStoryboardEpisodeReadiness(project.sourcePayload);
    if (readinessIssue) {
      throw new ShortDramaRepositoryError(
        readinessIssue.status,
        readinessIssue.code,
        readinessIssue.message,
      );
    }
    const result = await repository.createShot(auth.userId, projectId, input);
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
    return shortDramaErrorResponse(error, "projects:shots:create");
  }
}
