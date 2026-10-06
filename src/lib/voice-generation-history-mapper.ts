import type {
  Emotion,
  OutputFormat,
  TTSEngine,
  VoiceGeneration,
} from "@/lib/types";

type JsonObject = Record<string, unknown>;

export type VoiceHistorySnapshotInput = {
  voiceModelName: string;
  inputText: string;
  textLength?: number;
  outputFormat?: string;
  speedRatio?: number;
  emotion?: string;
  engine?: string;
};

export type DurableVoiceHistoryRow = {
  request_id: string;
  user_id: string;
  phase: string;
  model_id: string;
  charge_credits: number | string;
  refunded_credits: number | string;
  billing_exempt?: boolean;
  state: string;
  wallet_operation_id?: number | string | null;
  asset_id?: string | null;
  generation_id?: string | null;
  response?: JsonObject | null;
  error?: JsonObject | null;
  metadata?: JsonObject | null;
  started_at: string;
  refunded_at?: string | null;
};

export type OwnedVoiceHistoryAsset = {
  id: string;
  storage_key: string;
  storage_provider: "coze_s3" | "tencent_cos" | "local";
  file_size?: number | string | null;
  content_type?: string | null;
};

const ENGINES = new Set<TTSEngine>([
  "volcano",
  "cosyvoice",
  "fish_audio",
  "elevenlabs",
  "gpt_sovits",
  "openai_tts",
  "aliyun_clone",
  "aliyun_tts",
]);
const EMOTIONS = new Set<Emotion>(["neutral", "happy", "sad", "angry", "fearful", "gentle", "serious"]);
const FORMATS = new Set<OutputFormat>(["mp3", "wav", "ogg", "flac"]);

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function outputFormat(value: unknown, contentType?: string | null): OutputFormat {
  const normalized = textValue(value).toLowerCase() === "ogg_opus"
    ? "ogg"
    : textValue(value).toLowerCase();
  if (FORMATS.has(normalized as OutputFormat)) return normalized as OutputFormat;
  if (contentType?.includes("wav")) return "wav";
  if (contentType?.includes("ogg")) return "ogg";
  if (contentType?.includes("flac")) return "flac";
  return "mp3";
}

function engine(value: unknown): TTSEngine {
  const normalized = textValue(value) as TTSEngine;
  return ENGINES.has(normalized) ? normalized : "volcano";
}

function emotion(value: unknown): Emotion {
  const normalized = textValue(value) as Emotion;
  return EMOTIONS.has(normalized) ? normalized : "neutral";
}

function publicAssetUrl(assetId: string): string {
  return `/api/storage/files/${encodeURIComponent(assetId)}/content`;
}

export function createVoiceHistorySnapshot(input: VoiceHistorySnapshotInput): JsonObject {
  const inputText = String(input.inputText || "");
  return {
    schema_version: 1,
    voice_model_name: String(input.voiceModelName || "语音合成"),
    input_text: inputText,
    text_length: Number.isFinite(input.textLength) ? input.textLength : inputText.length,
    output_format: outputFormat(input.outputFormat),
    speed_ratio: finiteNumber(input.speedRatio, 1),
    emotion: emotion(input.emotion),
    engine: engine(input.engine),
  };
}

export function mapDurableVoiceHistoryRow(
  row: DurableVoiceHistoryRow,
  ownedAsset?: OwnedVoiceHistoryAsset,
  legacySnapshot?: VoiceGeneration,
): VoiceGeneration {
  const metadata = objectValue(row.metadata);
  const snapshot = objectValue(metadata.history_snapshot);
  const response = objectValue(row.response);
  const responseData = objectValue(response.data);
  const billing = objectValue(responseData.billing);
  const error = objectValue(row.error);
  const inputText = textValue(snapshot.input_text) || legacySnapshot?.inputText || "";
  const durableState = String(row.state || "") as VoiceGeneration["terminalState"];
  const status = durableState === "completed"
    ? "success"
    : durableState === "submitting" || durableState === "recovery_required"
      ? "processing"
      : "failed";
  const asset = ownedAsset && row.asset_id === ownedAsset.id ? ownedAsset : undefined;
  const chargedCredits = Math.max(0, finiteNumber(row.charge_credits));
  const refundedCredits = Math.max(0, finiteNumber(row.refunded_credits));
  const charged = Math.max(0, chargedCredits - refundedCredits);
  const billingState: NonNullable<VoiceGeneration["billingState"]> = row.billing_exempt === true && chargedCredits === 0
    ? "exempt"
    : chargedCredits === 0 && refundedCredits === 0
      ? "not_charged"
      : chargedCredits > 0 && refundedCredits >= chargedCredits && Boolean(row.refunded_at)
        ? "fully_refunded"
        : charged > 0
          ? "charged"
          : "unknown";
  const retryEligible = durableState === "refunded"
    && ["not_charged", "exempt", "fully_refunded"].includes(billingState);
  const retryUnavailableReason = durableState === "failed_unknown"
    ? "任务终态尚未确认，需先完成核对，暂不能重试"
    : durableState === "refunded" && !retryEligible
      ? "退款或零扣费状态尚未完整确认，暂不能重试"
      : "该任务没有可安全重试的明确终态";
  const failureMessage = textValue(error.message)
    || textValue(response.message)
    || (durableState === "failed_unknown" ? "任务终态尚未确认，请联系管理员核对" : "语音生成未完成");

  return {
    id: row.generation_id || row.request_id,
    userId: row.user_id,
    voiceModelId: textValue(snapshot.voice_model_id) || row.model_id,
    voiceModelName: textValue(snapshot.voice_model_name)
      || legacySnapshot?.voiceModelName
      || textValue(billing.modelName)
      || row.model_id,
    inputText,
    textLength: Math.max(0, finiteNumber(snapshot.text_length, legacySnapshot?.textLength ?? inputText.length)),
    outputAudioUrl: asset ? publicAssetUrl(asset.id) : undefined,
    outputDuration: status === "success"
      ? Math.max(0, finiteNumber(responseData.duration, legacySnapshot?.outputDuration || 0)) || undefined
      : undefined,
    outputStorageKey: asset?.storage_key,
    outputAssetId: asset?.id,
    outputStorageProvider: asset?.storage_provider,
    outputContentType: asset?.content_type || undefined,
    outputFileSize: asset ? Math.max(0, finiteNumber(asset.file_size)) || undefined : undefined,
    outputFormat: outputFormat(snapshot.output_format || legacySnapshot?.outputFormat, asset?.content_type),
    speedRatio: finiteNumber(snapshot.speed_ratio, legacySnapshot?.speedRatio ?? 1),
    emotion: emotion(snapshot.emotion || legacySnapshot?.emotion),
    engine: engine(snapshot.engine || legacySnapshot?.engine),
    cost: charged,
    status,
    terminalState: durableState,
    billingState,
    chargedCredits,
    refundedCredits,
    retryEligible,
    retryUnavailableReason: retryEligible ? undefined : retryUnavailableReason,
    errorMessage: status === "failed" ? failureMessage : undefined,
    createdAt: row.started_at,
  };
}

export function sanitizeLegacyVoiceHistory(
  item: VoiceGeneration,
  ownedAsset?: OwnedVoiceHistoryAsset,
): VoiceGeneration {
  const failedWithoutDurableProof = item.status === "failed";
  return {
    ...item,
    outputAudioUrl: ownedAsset ? publicAssetUrl(ownedAsset.id) : undefined,
    outputStorageKey: ownedAsset?.storage_key,
    outputAssetId: ownedAsset?.id,
    outputStorageProvider: ownedAsset?.storage_provider,
    outputContentType: ownedAsset?.content_type || undefined,
    outputFileSize: ownedAsset ? Math.max(0, finiteNumber(ownedAsset.file_size)) || undefined : undefined,
    terminalState: failedWithoutDurableProof ? "legacy_unknown" : item.terminalState,
    billingState: failedWithoutDurableProof ? "unknown" : item.billingState,
    retryEligible: failedWithoutDurableProof ? false : item.retryEligible,
    retryUnavailableReason: failedWithoutDurableProof
      ? "旧版历史缺少明确终态和计费证明，暂不能安全重试"
      : item.retryUnavailableReason,
  };
}
