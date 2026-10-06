import { NextRequest, NextResponse } from "next/server";
import {
  DeleteShortDramaProjectRequestSchema,
  ShortDramaProjectParamsSchema,
  UpdateShortDramaProjectRequestSchema,
} from "@/lib/short-drama/contracts";
import { validateEpisodeWorkflowTransition } from "@/lib/short-drama/episode-workflow";
import {
  parseShortDramaJson,
  ShortDramaHttpError,
  shortDramaErrorResponse,
} from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ShortDramaProjectRepository } from "@/lib/short-drama/repository";
import { ShortDramaProductionRepository } from "@/lib/short-drama/production-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

async function readProjectId(context: RouteContext): Promise<string> {
  const params = ShortDramaProjectParamsSchema.parse(await context.params);
  return params.projectId;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const repository = new ShortDramaProjectRepository(auth.db);
    const project = await repository.getProject(auth.userId, projectId);
    if (!project) {
      return NextResponse.json(
        { error: "项目不存在", code: "PROJECT_NOT_FOUND" },
        { status: 404 },
      );
    }
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { project, storageMode },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Short-Drama-Storage-Mode": storageMode,
        },
      },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:get");
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const input = await parseShortDramaJson(request, UpdateShortDramaProjectRequestSchema);
    const repository = new ShortDramaProjectRepository(auth.db);
    if (input.sourcePayload) {
      const current = await repository.getProject(auth.userId, projectId);
      if (!current) {
        throw new ShortDramaHttpError(404, "PROJECT_NOT_FOUND", "项目不存在");
      }
      const { total: downstreamShotCount } = await repository.listShots(
        auth.userId,
        projectId,
        { limit: 1, offset: 0 },
      );
      const issue = validateEpisodeWorkflowTransition({
        currentPayload: current.sourcePayload,
        nextPayload: input.sourcePayload,
        hasDownstreamData: downstreamShotCount > 0,
      });
      if (issue) throw new ShortDramaHttpError(issue.status, issue.code, issue.message);
    }
    const project = await repository.updateProject(auth.userId, projectId, input);
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { project, storageMode },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Short-Drama-Storage-Mode": storageMode,
        },
      },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:update");
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const input = DeleteShortDramaProjectRequestSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const repository = new ShortDramaProjectRepository(auth.db);
    if (await repository.getStorageMode() === "native") {
      await ShortDramaProductionRepository.fromAuth(auth).assertNoActiveProjectJobs(auth.userId, projectId);
    }
    const project = await repository.deleteProject(
      auth.userId,
      projectId,
      input.expectedRevision,
    );
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { project, deleted: true, storageMode },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Short-Drama-Storage-Mode": storageMode,
        },
      },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:delete");
  }
}
