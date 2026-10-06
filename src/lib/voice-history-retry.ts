import type { VoiceGeneration } from "@/lib/types";

export function voiceHistoryRetryUnavailableReason(item: VoiceGeneration): string {
  if (item.status !== "failed") return "只有失败记录可以载入后重试";
  if (item.terminalState === "failed_unknown") {
    return "任务终态尚未确认，需先完成核对，暂不能重试";
  }
  if (item.retryEligible !== true) {
    return item.retryUnavailableReason
      || "历史记录缺少明确的未扣费或已退款证明，暂不能安全重试";
  }
  if (!String(item.inputText || "").trim()) return "历史记录缺少原文，无法安全恢复";
  const modelId = String(item.voiceModelId || "").toLowerCase();
  const modelName = String(item.voiceModelName || "");
  if (
    modelId === "seed-audio-1.0"
    || modelId.startsWith("dual:")
    || /音频生成|双人|混音/u.test(modelName)
  ) {
    return "该模式的历史记录缺少完整参考音频或多角色快照，请重新配置输入";
  }
  return "";
}

export function canLoadVoiceHistoryForRetry(item: VoiceGeneration): boolean {
  return voiceHistoryRetryUnavailableReason(item) === "";
}
