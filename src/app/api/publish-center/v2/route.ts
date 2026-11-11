import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { PublishingV2ActionSchema, PublishingV2QuerySchema } from "@/lib/publishing-v2-contract";
import { mutatePublishingV2, readPublishingV2 } from "@/lib/server/publishing-v2-service";
import { PublishingError, publishingFailure, readPublishingJson } from "@/lib/server/publishing-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
function failure(error: unknown) { const value = publishingFailure(error); return NextResponse.json(value.body, { status: value.status, headers }); }
export async function GET(request: Request) {
  try { return await withAuth(request, async (user, database) => {
    const query = PublishingV2QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    if (!query.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "分页查询参数无效", 400);
    return NextResponse.json(await readPublishingV2(user, database, query.data), { headers });
  }); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try { return await withAuth(request, async (user, database) => {
    const action = PublishingV2ActionSchema.safeParse(await readPublishingJson(request));
    if (!action.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "内容管理参数不符合合同", 400);
    return NextResponse.json(await mutatePublishingV2(user, database, action.data), { headers });
  }); } catch (error) { return failure(error); }
}
