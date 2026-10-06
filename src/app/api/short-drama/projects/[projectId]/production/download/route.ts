import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ShortDramaProjectParamsSchema } from "@/lib/short-drama/contracts";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { shortDramaErrorResponse } from "@/lib/short-drama/http";
import { readOwnedFilmDownload } from "@/lib/short-drama/production-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const { projectId } = ShortDramaProjectParamsSchema.parse(await context.params);
    const assetId = z.string().uuid().parse(request.nextUrl.searchParams.get("assetId"));
    const { bytes, contentType, extension } = await readOwnedFilmDownload(auth, projectId, assetId);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="film-${projectId}.${extension}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:production:download");
  }
}
