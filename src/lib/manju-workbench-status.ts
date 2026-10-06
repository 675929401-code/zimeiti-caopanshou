import {
  inspectVideoModelActivationReadiness,
  isActivationGatedImageId,
  isActivationGatedTextUserAccess,
  type VideoActivationBinding,
} from "@/lib/model-activation-gate";

export type ManjuModelFamily = "text" | "image" | "video" | "audio";
export type ManjuAcceptanceState =
  | "evidence_complete"
  | "evidence_pending"
  | "legacy_unverified"
  | "not_available";

type CommonRow = {
  id?: unknown;
  name?: unknown;
  model_name?: unknown;
  api_endpoint?: unknown;
  api_key?: unknown;
  is_active?: unknown;
  is_hidden?: unknown;
};

export type ManjuTextModelRow = CommonRow & {
  proxy_url?: unknown;
  user_access?: unknown;
};

export type ManjuImageModelRow = CommonRow;

export type ManjuVideoModelRow = CommonRow & {
  provider?: unknown;
  protocol_type?: unknown;
  api_protocol_config?: unknown;
};

export type ManjuAudioModelRow = {
  id?: unknown;
  name?: unknown;
  modelId?: unknown;
  resourceId?: unknown;
  apiKey?: unknown;
  isActive?: unknown;
};

export interface ManjuSafeModelStatus {
  id: string;
  name: string;
  bindingComplete: boolean;
  userAvailable: boolean;
  acceptance: ManjuAcceptanceState;
  reason: string;
}

export interface ManjuModelFamilyStatus {
  family: ManjuModelFamily;
  label: string;
  source: string;
  records: number;
  active: number;
  visible: number;
  bindingComplete: number;
  evidenceComplete: number;
  pending: number;
  unverified: number;
  loadError: string;
  models: ManjuSafeModelStatus[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

function configured(value: unknown): boolean {
  return text(value).length > 0;
}

function safeIdentity(row: { id?: unknown; name?: unknown }, fallback: string) {
  const id = text(row.id) || fallback;
  return {
    id,
    name: text(row.name) || id,
  };
}

function summarize(
  family: ManjuModelFamily,
  label: string,
  source: string,
  models: ManjuSafeModelStatus[],
  active: number,
  visible: number,
  loadError = "",
): ManjuModelFamilyStatus {
  return {
    family,
    label,
    source,
    records: models.length,
    active,
    visible,
    bindingComplete: models.filter((model) => model.bindingComplete).length,
    evidenceComplete: models.filter((model) => model.acceptance === "evidence_complete").length,
    pending: models.filter((model) => model.acceptance === "evidence_pending").length,
    unverified: models.filter((model) => model.acceptance === "legacy_unverified").length,
    loadError,
    models,
  };
}

export function unavailableManjuFamily(
  family: ManjuModelFamily,
  label: string,
  source: string,
  loadError: string,
): ManjuModelFamilyStatus {
  return summarize(family, label, source, [], 0, 0, loadError);
}

export function summarizeManjuTextModels(
  rows: ManjuTextModelRow[],
  options: { globalEndpointConfigured?: boolean; globalCredentialConfigured?: boolean } = {},
): ManjuModelFamilyStatus {
  let active = 0;
  let visible = 0;
  const models = rows.map((row, index): ManjuSafeModelStatus => {
    const identity = safeIdentity(row, `text-${index + 1}`);
    const isActive = row.is_active === true;
    const isVisible = isActive && row.is_hidden !== true && text(row.user_access) !== "hidden";
    const gated = isActivationGatedTextUserAccess(row.user_access);
    const endpointConfigured = configured(row.api_endpoint)
      || configured(row.proxy_url)
      || options.globalEndpointConfigured === true;
    const credentialConfigured = configured(row.api_key) || options.globalCredentialConfigured === true;
    const bindingComplete = configured(row.model_name) && endpointConfigured && credentialConfigured;
    if (isActive) active += 1;
    if (isVisible) visible += 1;
    if (!isActive || !isVisible || !bindingComplete) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: false,
        acceptance: gated ? "evidence_pending" : "not_available",
        reason: !isActive
          ? "模型已停用"
          : !isVisible
            ? "模型未向普通用户发布"
            : "模型名、服务地址或凭据引用不完整",
      };
    }
    if (gated) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: false,
        acceptance: "evidence_pending",
        reason: "新接入文案模型仍在验收门内，当前表不能安全保存完整 canary 证据",
      };
    }
    return {
      ...identity,
      bindingComplete,
      userAvailable: true,
      acceptance: "legacy_unverified",
      reason: "统一模型池已发布，但没有漫剧工作台专属 canary 与结果持久化证据",
    };
  });
  return summarize("text", "文案模型", "llm_models", models, active, visible);
}

export function summarizeManjuImageModels(
  rows: ManjuImageModelRow[],
  options: { globalEndpointConfigured?: boolean; globalCredentialConfigured?: boolean } = {},
): ManjuModelFamilyStatus {
  let active = 0;
  let visible = 0;
  const models = rows.map((row, index): ManjuSafeModelStatus => {
    const identity = safeIdentity(row, `image-${index + 1}`);
    const isActive = row.is_active === true;
    const isVisible = isActive && row.is_hidden !== true;
    const gated = isActivationGatedImageId(row.id);
    const bindingComplete = configured(row.model_name)
      && (configured(row.api_endpoint) || options.globalEndpointConfigured === true)
      && (configured(row.api_key) || options.globalCredentialConfigured === true);
    if (isActive) active += 1;
    if (isVisible) visible += 1;
    if (!isActive || !isVisible || !bindingComplete) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: false,
        acceptance: gated ? "evidence_pending" : "not_available",
        reason: !isActive
          ? "模型已停用"
          : !isVisible
            ? "模型仍处于隐藏状态"
            : "模型名、服务地址或凭据引用不完整",
      };
    }
    if (gated) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: false,
        acceptance: "evidence_pending",
        reason: "新接入生图模型仍在验收门内，尚未持久化真实生成证据",
      };
    }
    return {
      ...identity,
      bindingComplete,
      userAvailable: true,
      acceptance: "legacy_unverified",
      reason: "统一模型池已发布，但没有漫剧工作台专属 canary 与资产落库证据",
    };
  });
  return summarize("image", "生图模型", "cover_models", models, active, visible);
}

export function summarizeManjuVideoModels(rows: ManjuVideoModelRow[]): ManjuModelFamilyStatus {
  let active = 0;
  let visible = 0;
  const models = rows.map((row, index): ManjuSafeModelStatus => {
    const identity = safeIdentity(row, `video-${index + 1}`);
    const isActive = row.is_active === true;
    const isVisible = isActive && row.is_hidden !== true;
    const bindingComplete = configured(row.model_name)
      && configured(row.api_endpoint)
      && configured(row.api_key)
      && configured(row.protocol_type);
    if (isActive) active += 1;
    if (isVisible) visible += 1;
    const readiness = inspectVideoModelActivationReadiness({
      id: identity.id,
      model_name: row.model_name,
      provider: row.provider,
      protocol_type: row.protocol_type,
      api_endpoint: row.api_endpoint,
      api_key: row.api_key,
      api_protocol_config: row.api_protocol_config,
      is_active: row.is_active,
      is_hidden: row.is_hidden,
    } satisfies VideoActivationBinding);
    if (!isActive || !isVisible || !bindingComplete) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: false,
        acceptance: readiness.gated && !readiness.ready ? "evidence_pending" : "not_available",
        reason: !isActive
          ? "模型已停用"
          : !isVisible
            ? "模型仍处于隐藏状态"
            : "模型名、协议、服务地址或凭据引用不完整",
      };
    }
    if (readiness.gated && !readiness.ready) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: false,
        acceptance: "evidence_pending",
        reason: `视频验收证据未齐全：${readiness.reason}`,
      };
    }
    if (readiness.gated && readiness.ready) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: true,
        acceptance: "evidence_complete",
        reason: "服务端已保存并校验视频 canary、结果持久化与绑定证据",
      };
    }
    return {
      ...identity,
      bindingComplete,
      userAvailable: true,
      acceptance: "legacy_unverified",
      reason: "既有视频模型未被追溯纳入新验收门，不能视为漫剧工作台已完成验收",
    };
  });
  return summarize("video", "视频模型", "video_models", models, active, visible);
}

export function summarizeManjuAudioModels(
  rows: ManjuAudioModelRow[],
  options: { globalCredentialConfigured?: boolean } = {},
): ManjuModelFamilyStatus {
  let active = 0;
  let visible = 0;
  const models = rows.map((row, index): ManjuSafeModelStatus => {
    const identity = safeIdentity(row, `audio-${index + 1}`);
    const isActive = row.isActive === true;
    const bindingComplete = configured(row.modelId)
      && configured(row.resourceId)
      && (configured(row.apiKey) || options.globalCredentialConfigured === true);
    if (isActive) {
      active += 1;
      visible += 1;
    }
    if (!isActive || !bindingComplete) {
      return {
        ...identity,
        bindingComplete,
        userAvailable: false,
        acceptance: "not_available",
        reason: !isActive ? "语音模型已停用" : "模型、资源或凭据引用不完整",
      };
    }
    return {
      ...identity,
      bindingComplete,
      userAvailable: true,
      acceptance: "legacy_unverified",
      reason: "智音工坊配置可读取，但没有漫剧工作台专属合成、资产落库与计费验收证据",
    };
  });
  return summarize("audio", "音频/配音模型", "voice-platform.ModelConfig", models, active, visible);
}
