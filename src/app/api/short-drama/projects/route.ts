import { NextRequest, NextResponse } from "next/server";
import {
  CreateShortDramaProjectRequestSchema,
  ListShortDramaProjectsQuerySchema,
} from "@/lib/short-drama/contracts";
import { shortDramaErrorResponse, parseShortDramaJson } from "@/lib/short-drama/http";
import { hashShortDramaRequest } from "@/lib/short-drama/idempotency";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ShortDramaProjectRepository } from "@/lib/short-drama/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const query = ListShortDramaProjectsQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const repository = new ShortDramaProjectRepository(auth.db);
    const result = await repository.listProjects(auth.userId, query);
    const storageMode = await repository.getStorageMode();
    return NextResponse.json(
      { ...result, storageMode },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Short-Drama-Storage-Mode": storageMode,
        },
      },
    );
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:list");
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const input = await parseShortDramaJson(request, CreateShortDramaProjectRequestSchema);
    const requestHash = hashShortDramaRequest({
      title: input.title,
      description: input.description,
      projectType: input.projectType,
      sourcePayload: input.sourcePayload,
      settings: input.settings,
    });
    const repository = new ShortDramaProjectRepository(auth.db);
    const result = await repository.createProject(auth.userId, input, requestHash);
    const storageMode = await repository.getStorageMode();

    return NextResponse.json({ ...result, storageMode }, {
      status: result.replayed ? 200 : 201,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Short-Drama-Storage-Mode": storageMode,
        ...(result.replayed ? { "Idempotency-Replayed": "true" } : {}),
      },
    });
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:create");
  }
}
