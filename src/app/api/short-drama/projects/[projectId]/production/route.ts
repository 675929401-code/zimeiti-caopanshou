import { NextRequest, NextResponse } from "next/server";
import { ShortDramaProjectParamsSchema } from "@/lib/short-drama/contracts";
import { parseShortDramaJson, shortDramaErrorResponse } from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { ProductionActionRequestSchema } from "@/lib/short-drama/production-contracts";
import { ShortDramaProductionError } from "@/lib/short-drama/production-repository";
import {
  assembleProductionFinal,
  createProductionPlan,
  deleteProductionTake,
  generateProductionEntityImage,
  generateProductionImage,
  generateProductionVideo,
  getProductionState,
  pollProductionJob,
  productionErrorBody,
  saveProductionTimeline,
  updateProductionTake,
} from "@/lib/short-drama/production-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

async function readProjectId(context: RouteContext): Promise<string> {
  return ShortDramaProjectParamsSchema.parse(await context.params).projectId;
}

function productionRouteError(error: unknown, routeTag: string): NextResponse {
  if (error instanceof ShortDramaProductionError) {
    return NextResponse.json(productionErrorBody(error), { status: error.status });
  }
  return shortDramaErrorResponse(error, routeTag);
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const result = await getProductionState({ auth, projectId });
    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return productionRouteError(error, "projects:production:get");
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectId = await readProjectId(context);
    const body = await parseShortDramaJson(request, ProductionActionRequestSchema);
    const result = body.action === "create_plan"
      ? await createProductionPlan({ auth, projectId, body })
      : body.action === "generate_entity_image"
        ? await generateProductionEntityImage({ request, auth, projectId, body })
        : body.action === "generate_image"
          ? await generateProductionImage({ request, auth, projectId, body })
          : body.action === "generate_video"
            ? await generateProductionVideo({ request, auth, projectId, body })
            : body.action === "update_take"
              ? await updateProductionTake({ auth, projectId, body })
              : body.action === "delete_take"
                ? await deleteProductionTake({ auth, projectId, body })
                : body.action === "save_timeline"
                  ? await saveProductionTimeline({ auth, projectId, body })
                  : body.action === "assemble_final"
                    ? await assembleProductionFinal({ auth, projectId, body })
                    : await pollProductionJob({ request, auth, projectId, body });

    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        "Cache-Control": "private, no-store",
        ...(result.body.replayed === true ? { "Idempotency-Replayed": "true" } : {}),
      },
    });
  } catch (error) {
    return productionRouteError(error, "projects:production:post");
  }
}
