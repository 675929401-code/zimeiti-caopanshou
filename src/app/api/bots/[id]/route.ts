import { NextResponse } from "next/server";
import { getBotInfo } from "@/lib/coze-api";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await getBotInfo(id);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const invalidUpstreamRequest = /(?:^|\s)400(?:\s|:|$)|parameter .* invalid/i.test(message);
    return NextResponse.json(
      { error: invalidUpstreamRequest ? "无效的智能体 ID" : "获取智能体信息失败" },
      { status: invalidUpstreamRequest ? 400 : 502 },
    );
  }
}
