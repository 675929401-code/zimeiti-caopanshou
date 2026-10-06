import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ShortDramaHttpError } from "@/lib/short-drama/http";
import { hashShortDramaRequest } from "@/lib/short-drama/idempotency";
import {
  GENERAL_SCRIPT_PROJECT_IMPORT_VERSION,
  mapGeneralScriptResultToProject,
  parseGeneralScriptProjectImport,
} from "@/lib/short-drama/general-script-import";
import { GeneralScriptContractError } from "@/lib/short-drama/general-script-contract";
import {
  ShortDramaAccessError,
  authorizeShortDramaRequest as requireShortDramaAccess,
} from "@/lib/short-drama/permissions";
import {
  ShortDramaProjectRepository,
  ShortDramaRepositoryError,
} from "@/lib/short-drama/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fixtureModeEnabled(): boolean {
  return process.env.SHORT_DRAMA_FIXTURE_MODE === "1" && process.env.NODE_ENV !== "production";
}

async function readImportRequest(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ShortDramaHttpError(400, "INVALID_JSON", "请求正文必须是有效 JSON");
  }
  return parseGeneralScriptProjectImport(body);
}

function projectHref(projectId: string): string {
  return `/tools/film-studio/projects/${encodeURIComponent(projectId)}?step=script`;
}

function importErrorResponse(error: unknown): NextResponse {
  if (
    error instanceof ShortDramaAccessError ||
    error instanceof ShortDramaRepositoryError ||
    error instanceof ShortDramaHttpError
  ) {
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (error instanceof GeneralScriptContractError || error instanceof z.ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof GeneralScriptContractError
          ? error.message
          : "导入请求不符合 general-script-result.v1 合同",
        code: "GENERAL_SCRIPT_RESULT_INVALID",
      },
      { status: 400 },
    );
  }

  console.error(
    "[short-drama:projects:import-script] unexpected error type",
    error instanceof Error ? error.name : typeof error,
  );
  return NextResponse.json(
    { ok: false, error: "短剧结果导入暂时不可用", code: "SHORT_DRAMA_IMPORT_ERROR" },
    { status: 500 },
  );
}

export async function POST(request: NextRequest) {
  try {
    if (fixtureModeEnabled()) {
      const input = await readImportRequest(request);
      const mapping = mapGeneralScriptResultToProject(input);
      const fixtureHash = hashShortDramaRequest({
        importContractVersion: GENERAL_SCRIPT_PROJECT_IMPORT_VERSION,
        clientRequestId: input.clientRequestId,
        title: input.title,
        result: mapping.promptAgentPayload,
      });
      const projectId = `fixture-${fixtureHash.slice(0, 20)}`;
      const project = {
        id: projectId,
        title: mapping.createRequest.title,
        description: mapping.createRequest.description,
        projectType: mapping.createRequest.projectType,
        status: "draft" as const,
        sourcePayload: mapping.createRequest.sourcePayload,
        settings: mapping.createRequest.settings,
        revision: 1,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
      return NextResponse.json(
        {
          ok: true,
          executionMode: "fixture",
          storageMode: "fixture",
          project,
          href: projectHref(project.id),
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Default and production paths never silently fall back to fixture mode.
    const auth = await requireShortDramaAccess(request);
    const input = await readImportRequest(request);
    const mapping = mapGeneralScriptResultToProject(input);
    const requestHash = hashShortDramaRequest({
      importContractVersion: GENERAL_SCRIPT_PROJECT_IMPORT_VERSION,
      title: mapping.createRequest.title,
      projectType: mapping.createRequest.projectType,
      sourcePayload: mapping.createRequest.sourcePayload,
      settings: mapping.createRequest.settings,
    });
    const repository = new ShortDramaProjectRepository(auth.db);
    const result = await repository.createProject(
      auth.userId,
      mapping.createRequest,
      requestHash,
    );
    const storageMode = await repository.getStorageMode();

    return NextResponse.json(
      {
        ok: true,
        executionMode: "database",
        storageMode,
        project: result.project,
        href: projectHref(result.project.id),
      },
      {
        status: result.replayed ? 200 : 201,
        headers: {
          "Cache-Control": "no-store",
          "X-Short-Drama-Storage-Mode": storageMode,
          ...(result.replayed ? { "Idempotency-Replayed": "true" } : {}),
        },
      },
    );
  } catch (error) {
    return importErrorResponse(error);
  }
}
