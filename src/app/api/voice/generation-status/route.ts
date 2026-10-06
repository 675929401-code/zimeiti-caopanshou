import { NextRequest, NextResponse } from "next/server";
import { withAuth, type AuthUser } from "@/lib/api-middleware";
import { publicVoiceResponse } from '@/lib/public-voice-response';
import {
  getVoiceGenerationStatus,
  VoiceGenerationLifecycleError,
  type VoiceGenerationPhase,
} from "@/lib/voice-generation-lifecycle";

const PHASES = new Set<VoiceGenerationPhase>(["seed-audio", "mix", "dual", "tts"]);

export async function GET(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    const searchParams = request.nextUrl.searchParams;
    const requestId = searchParams.get("requestId")?.trim() || undefined;
    const clientRequestId = searchParams.get("clientRequestId")?.trim() || undefined;
    const rawPhase = searchParams.get("phase")?.trim() || undefined;
    const phase = rawPhase && PHASES.has(rawPhase as VoiceGenerationPhase)
      ? rawPhase as VoiceGenerationPhase
      : undefined;

    if (!requestId && (!clientRequestId || !phase)) {
      return NextResponse.json({
        success: false,
        code: "VOICE_LIFECYCLE_STATUS_INPUT_INVALID",
        message: "查询语音任务需要 requestId，或 clientRequestId 与合法 phase",
      }, { status: 400 });
    }

    try {
      const record = await getVoiceGenerationStatus({
        userId: user.id,
        requestId,
        clientRequestId,
        phase,
      });
      if (!record) {
        return NextResponse.json({
          success: false,
          code: "VOICE_LIFECYCLE_REQUEST_NOT_FOUND",
          message: "未找到语音任务",
        }, { status: 404 });
      }
      return NextResponse.json({
        success: true,
        data: {
          requestId: record.requestId,
          clientRequestId: record.clientRequestId,
          phase: record.phase,
          state: record.state,
          modelId: record.modelId,
          quotedCredits: record.quotedCredits,
          chargedCredits: record.chargeCredits,
          refundedCredits: record.refundedCredits,
          assetId: record.assetId,
          generationId: record.generationId,
          providerTaskId: record.providerTaskId,
          response: record.state === "completed" ? publicVoiceResponse(record.response) : null,
          error: record.state === "refunded" || record.state === "failed_unknown"
            ? record.error
            : null,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt,
          refundedAt: record.refundedAt,
        },
      });
    } catch (error) {
      if (error instanceof VoiceGenerationLifecycleError) {
        return NextResponse.json({
          success: false,
          code: error.code,
          message: error.message,
        }, { status: error.status });
      }
      console.error("[voice/generation-status] query failed", error);
      return NextResponse.json({
        success: false,
        code: "VOICE_LIFECYCLE_UNAVAILABLE",
        message: "语音任务服务暂时不可用",
      }, { status: 503 });
    }
  });
}
