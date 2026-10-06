import { NextRequest, NextResponse } from "next/server";
// eslint-disable-next-line no-restricted-imports -- This owner-checked facade intentionally delegates bytes/trimming to the existing export route.
import { POST as exportVideoRoute } from "@/app/api/video/export/route";
import { ShortDramaProjectParamsSchema } from "@/lib/short-drama/contracts";
import { parseShortDramaJson, shortDramaErrorResponse } from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ProductionExportRequestSchema } from "@/lib/short-drama/production-contracts";
import { ShortDramaProductionError } from "@/lib/short-drama/production-repository";
import {
  prepareProductionExport,
  productionErrorBody,
} from "@/lib/short-drama/production-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

async function readProjectId(context: RouteContext): Promise<string> {
  return ShortDramaProjectParamsSchema.parse(await context.params).projectId;
}

function exportRouteError(error: unknown): NextResponse {
  if (error instanceof ShortDramaProductionError) {
    return NextResponse.json(productionErrorBody(error), { status: error.status });
  }
  return shortDramaErrorResponse(error, "projects:production:export");
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const body = await parseShortDramaJson(request, ProductionExportRequestSchema);
    const prepared = await prepareProductionExport({ auth, projectId, body });
    const serialized = JSON.stringify({
      taskId: prepared.taskId,
      targetDurationSeconds: body.targetDurationSeconds,
    });
    const authorization = request.headers.get("authorization") || "";
    const internalRequest = new NextRequest(
      new URL("/api/video/export", request.nextUrl.origin),
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(serialized, "utf8")),
        },
        body: serialized,
      },
    );
    const response = await exportVideoRoute(internalRequest);
    if (response.ok) return response;

    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    return NextResponse.json(
      {
        error: String(payload.error || "视频导出失败"),
        code: "VIDEO_EXPORT_FAILED",
      },
      { status: response.status },
    );
  } catch (error) {
    return exportRouteError(error);
  }
}
