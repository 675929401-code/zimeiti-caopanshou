import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Compatibility endpoint for stale browser bundles and old bookmarks. The
// customer-facing segmenter is rule based and runs in the browser; keeping this
// route closed guarantees that an old client cannot start a provider request,
// reserve wallet credit, or create an exactly-once attempt.
export async function POST() {
  return NextResponse.json(
    {
      error: "分段已改为页面内规则处理，请刷新页面后重试",
      code: "SEGMENTER_RULE_ONLY",
      charged: false,
      provider_call_started: false,
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Segmenter-Provider-Call": "blocked",
      },
    },
  );
}
