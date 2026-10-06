import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIRED_RESPONSE = {
  error: "该旧版智能体通道已停用，请在后台将智能体绑定到统一对话模型后重试。",
  code: "LEGACY_CODING_AGENT_RETIRED",
  retry_safe: true,
  provider_call_started: false,
  charged: false,
};

export async function POST() {
  return NextResponse.json(RETIRED_RESPONSE, { status: 410 });
}
