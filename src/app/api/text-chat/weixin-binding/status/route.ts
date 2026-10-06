import { NextRequest, NextResponse } from "next/server";
import {
  authorizeTextChatControlRequest,
  getWeixinBindingAvailability,
  textChatControlErrorResponse,
  weixinBindingDisabledResponse,
} from "@/lib/text-chat-controls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await authorizeTextChatControlRequest(request);
    const availability = getWeixinBindingAvailability();
    return NextResponse.json({
      success: true,
      enabled: false,
      status: "disabled",
      reason: availability.reason,
    });
  } catch (error) {
    return textChatControlErrorResponse(error, "weixin-status:get");
  }
}

export async function POST(request: NextRequest) {
  try {
    await authorizeTextChatControlRequest(request);
    return weixinBindingDisabledResponse();
  } catch (error) {
    return textChatControlErrorResponse(error, "weixin-status:verify");
  }
}
