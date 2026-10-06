import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import {
  getVoiceGenerationAccountHistory,
  VoiceGenerationHistoryError,
} from "@/lib/voice-generation-history-repository";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function privateNoStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(req: NextRequest): Promise<Response> {
  const response = await withAuth(req, async (user) => {
    try {
      const { searchParams } = new URL(req.url);
      const requestedPage = Number(searchParams.get("page") || "1");
      const requestedPageSize = Number(searchParams.get("pageSize") || "20");
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const pageSize = Number.isInteger(requestedPageSize)
        ? Math.min(100, Math.max(1, requestedPageSize))
        : 20;
      const result = await getVoiceGenerationAccountHistory({
        userId: user.id,
        page,
        pageSize,
        modelId: searchParams.get("modelId")?.trim() || undefined,
      });

      return NextResponse.json({
        success: true,
        data: result,
        message: `共 ${result.total} 条记录`,
      });
    } catch (error) {
      if (error instanceof VoiceGenerationHistoryError) {
        return NextResponse.json({
          success: false,
          code: error.code,
          message: error.message,
        }, { status: error.status });
      }
      console.error("[voice/history] durable history read failed", error);
      return NextResponse.json({
        success: false,
        code: "VOICE_HISTORY_UNAVAILABLE",
        message: "语音账号历史暂时无法读取，请稍后重试",
      }, { status: 503 });
    }
  });
  return privateNoStore(response);
}
