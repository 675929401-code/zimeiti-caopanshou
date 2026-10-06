/** A minimal tombstone preserves task/ledger foreign keys after configuration removal. */
export const RETIRED_MODEL_PROVIDER = "retired_configuration";

export const PERMANENTLY_RETIRED_MODEL_IDS = new Set([
  "minimax-h3-autodl-hosted",
  "minimax-h3-autodl-hosted-first-last",
  "minimax-h3-autodl-hosted-image-audio",
  "minimax-h3-autodl-hosted-image-audio-v2-15s",
  "minimax-h3-autodl-hosted-lightx2v-v5-15s",
  "minimax-h3-turbo-selfhost-pro6000",
  "qwen-image-2512-hq-selfhost-pro6000",
  "grok-video-3-10s-ch1",
  "grok-video-3-10s-ch1-stable",
  "grok-video-3-15s-ch1b",
  "veo-3-1-fast-ch1",
]);

export function isPermanentlyRetiredModel(input: Record<string, unknown>) {
  const id = String(input.id || "").trim();
  if (PERMANENTLY_RETIRED_MODEL_IDS.has(id)) return true;
  try {
    return new URL(String(input.api_endpoint || "")).hostname.toLowerCase() === "yunwu.ai";
  } catch {
    return false;
  }
}

export function modelRetirementPatch(kind: "drawing" | "text" | "video") {
  const common = { is_active: false, is_hidden: true, provider: RETIRED_MODEL_PROVIDER,
    api_key: "", api_endpoint: "" };
  return kind === "video" ? { ...common, admin_notes: "模型接入配置已删除；此占位仅保留历史任务和账单关联。", api_protocol_config: {}, request_template: null, response_mapping: null } : common;
}
