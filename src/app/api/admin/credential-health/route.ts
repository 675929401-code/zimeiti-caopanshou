import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  LlmModelValidationError,
  assertFreshLlmModelValidationEvidence,
  llmModelValidationConfigurationHash,
} from "@/lib/llm-model-validation-gate";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { assertPublishedModelPoolEntry } from "@/lib/server/platform-configuration-compatibility";
import { readReviewedTextHistory, REVIEWED_TEXT_HISTORY } from "@/lib/server/text-model-reviewed-history";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type ModelTable = "cover_models" | "llm_models" | "video_models";
type CredentialStorageMode = "isolated_binding" | "server_reference" | "legacy_restricted" | "missing";
type ValidationStatus = "verified" | "pending" | "needs_attention" | "unverified" | "not_recorded";

type ModelRow = {
  id: string;
  name?: string | null;
  model_name?: string | null;
  provider?: string | null;
  api_key?: string | null;
  api_endpoint?: string | null;
  proxy_url?: string | null;
  billing_mode?: string | null;
  token_billing_enabled?: boolean | null;
  input_cost_per_million?: number | null;
  output_cost_per_million?: number | null;
  cached_cost_per_million?: number | null;
  profit_margin?: number | null;
  max_context_rounds?: number | null;
  max_context_tokens?: number | null;
  max_reply_tokens?: number | null;
  timeout?: number | null;
  deep_thinking_type?: number | null;
  enable_web_search?: boolean | null;
  is_active?: boolean | null;
  is_hidden?: boolean | null;
  updated_at?: string | null;
};

type BindingRow = {
  model_key: string;
  updated_at: string | null;
};

type ImageValidationRow = {
  model_id: string;
  state: string;
  published_at: string | null;
  updated_at: string | null;
};

type VideoHealthRow = {
  channel_id: string;
  total_requests: number | null;
  last_success_at: string | null;
  last_fail_at: string | null;
  updated_at: string | null;
};

type LlmValidationEvidenceRow = {
  model_id: string;
  configuration_hash: string;
  checked_at: string;
};

const TABLE_META: Record<ModelTable, { kind: "image" | "text" | "video"; purpose: string }> = {
  cover_models: { kind: "image", purpose: "图像生成与封面工作台" },
  llm_models: { kind: "text", purpose: "智能体对话与文本生成" },
  video_models: { kind: "video", purpose: "视频生成工作台" },
};

function credentialId(modelKey: string): string {
  // This is a configuration identifier derived only from the model identity.
  // It is deliberately not a hash, suffix or substring of the credential.
  return `cfg_${createHash("sha256").update(`credential-health:v1:${modelKey}`).digest("hex").slice(0, 12)}`;
}

function latestBy<T>(rows: T[], key: (row: T) => string, time: (row: T) => string | null): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const identity = key(row);
    const current = result.get(identity);
    if (!current || Date.parse(time(row) || "") > Date.parse(time(current) || "")) result.set(identity, row);
  }
  return result;
}

function imageValidation(row: ImageValidationRow | undefined): { status: ValidationStatus; at: string | null; explanation: string } {
  if (!row) return { status: "unverified", at: null, explanation: "尚无真实生成验收记录" };
  if (row.state === "published") return { status: "verified", at: row.published_at || row.updated_at, explanation: "已有绑定当前模型的真实结果发布记录" };
  if (["claimed", "unknown"].includes(row.state)) return { status: "pending", at: row.updated_at, explanation: "验收任务仍待终态或需人工核对" };
  return { status: "needs_attention", at: row.updated_at, explanation: `最近验收状态：${row.state}` };
}

function videoValidation(row: VideoHealthRow | undefined): { status: ValidationStatus; at: string | null; explanation: string } {
  if (!row) return { status: "unverified", at: null, explanation: "尚无通道健康或真实运行记录" };
  if (row.last_success_at) return { status: "verified", at: row.last_success_at, explanation: "已有真实成功运行记录" };
  if (Number(row.total_requests || 0) > 0 || row.last_fail_at) return { status: "needs_attention", at: row.last_fail_at || row.updated_at, explanation: "已有调用记录，但尚无成功终态" };
  return { status: "pending", at: row.updated_at, explanation: "已建立验证通道，尚未完成真实成功验收" };
}

function textValidation(
  model: ModelRow,
  rows: LlmValidationEvidenceRow[],
  evidenceAvailable: boolean,
  now: number,
): { status: ValidationStatus; at: string | null; explanation: string } {
  if (!evidenceAvailable) {
    return { status: "needs_attention", at: null, explanation: "持久化验收证据暂时不可读，不能计为通过" };
  }
  let resolvedSecret = "";
  try {
    resolvedSecret = resolveProviderSecret(String(model.api_key || "")).trim();
  } catch {
    return { status: "unverified", at: null, explanation: "当前模型缺少可解析的服务端凭据，不能计为通过" };
  }
  if (!resolvedSecret) {
    return { status: "unverified", at: null, explanation: "当前模型缺少可用的服务端凭据，不能计为通过" };
  }

  const configurationHash = llmModelValidationConfigurationHash(model, resolvedSecret);
  const modelEvidence = rows.filter((row) => String(row.model_id || "").trim() === model.id);
  const evidence = modelEvidence.find((row) => String(row.configuration_hash || "").trim() === configurationHash);
  if (!evidence) {
    return modelEvidence.length > 0
      ? { status: "needs_attention", at: null, explanation: "模型配置或服务端凭据已变化，旧验收证据不能计为通过" }
      : { status: "unverified", at: null, explanation: "尚无绑定当前模型配置的持久化通路验收证据" };
  }

  try {
    const accepted = assertFreshLlmModelValidationEvidence(model, resolvedSecret, evidence, now);
    return { status: "verified", at: accepted.checkedAt, explanation: "当前配置已通过持久化通路指令验收；通路指令验收不等于业务质量" };
  } catch (error) {
    const expired = error instanceof LlmModelValidationError && error.code === "TEXT_MODEL_VALIDATION_EVIDENCE_EXPIRED";
    return {
      status: "needs_attention",
      at: evidence.checked_at || null,
      explanation: expired
        ? "当前配置的验收证据已过期或时间异常，不能计为通过"
        : "当前配置未通过统一验收门禁，不能计为通过",
    };
  }
}

function storageMode(rawCredential: string, hasBinding: boolean): CredentialStorageMode {
  if (hasBinding) return "isolated_binding";
  if (/^(?:secret|env):\/\//u.test(rawCredential)) return "server_reference";
  if (rawCredential) return "legacy_restricted";
  return "missing";
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "credential_health_view",
  });
  if (!authorization.ok) return authorization.response;

  try {
    const db = getSupabaseAdminClient();
    const [cover, text, video, bindings, llmValidations, imageValidations, videoHealth] = await Promise.all([
      db.from("cover_models").select("id,name,model_name,provider,api_key,is_active,is_hidden,updated_at"),
      db.from("llm_models").select("id,name,model_name,api_endpoint,proxy_url,api_key,billing_mode,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,deep_thinking_type,enable_web_search,api_protocol_config,is_active,is_hidden,updated_at"),
      db.from("video_models").select("id,name,model_name,provider,api_key,is_active,is_hidden"),
      db.from("platform_model_credential_bindings").select("model_key,updated_at"),
      db.from("llm_model_validation_evidence").select("model_id,configuration_hash,checked_at"),
      db.from("image_model_validations").select("model_id,state,published_at,updated_at"),
      db.from("video_channel_health").select("channel_id,total_requests,last_success_at,last_fail_at,updated_at"),
    ]);
    const requiredErrors = [cover.error, text.error, video.error, bindings.error].filter(Boolean);
    if (requiredErrors.length > 0) {
      return NextResponse.json({ error: "暂时无法读取凭据安全状态", code: "CREDENTIAL_HEALTH_LOOKUP_FAILED" }, { status: 503 });
    }

    const bindingMap = new Map(((bindings.data || []) as BindingRow[]).map((row) => [row.model_key, row]));
    const llmValidationRows = (llmValidations.data || []) as LlmValidationEvidenceRow[];
    const llmEvidenceAvailable = !llmValidations.error;
    const imageValidationMap = latestBy((imageValidations.data || []) as ImageValidationRow[], (row) => row.model_id, (row) => row.updated_at);
    const videoHealthMap = latestBy((videoHealth.data || []) as VideoHealthRow[], (row) => row.channel_id, (row) => row.updated_at);
    const sources: Array<{ table: ModelTable; rows: ModelRow[] }> = [
      { table: "cover_models", rows: (cover.data || []) as ModelRow[] },
      { table: "llm_models", rows: (text.data || []) as ModelRow[] },
      { table: "video_models", rows: (video.data || []) as ModelRow[] },
    ];

    const reviewedModel = (text.data as ModelRow[]).find(model => model.id === REVIEWED_TEXT_HISTORY.modelId);
    let reviewedHistory = null;
    let historyReadFailed = false;
    if (reviewedModel && reviewedModel.is_active === true && reviewedModel.is_hidden !== true) {
      try {
        const resolved = resolveProviderSecret(String(reviewedModel.api_key || ""));
        if (resolved) {
          const proof = await readReviewedTextHistory(db, reviewedModel.id,
            llmModelValidationConfigurationHash(reviewedModel, resolved), REVIEWED_TEXT_HISTORY.agentId);
          if (proof) {
            await assertPublishedModelPoolEntry("llm_models", reviewedModel.id);
            reviewedHistory = proof;
          }
        }
      } catch {
        historyReadFailed = true;
      }
    }

    const credentials = sources.flatMap(({ table, rows }) => rows.map((model) => {
      const modelKey = `${table}:${model.id}`;
      const binding = bindingMap.get(modelKey);
      const rawCredential = String(model.api_key || "").trim();
      const mode = storageMode(rawCredential, Boolean(binding));
      const validation = table === "cover_models"
        ? imageValidation(imageValidationMap.get(model.id))
        : table === "video_models"
          ? videoValidation(videoHealthMap.get(model.id))
          : textValidation(model, llmValidationRows, llmEvidenceAvailable, Date.now());
      return {
        credentialId: credentialId(modelKey),
        modelId: model.id,
        modelName: model.name || model.model_name || model.id,
        kind: TABLE_META[table].kind,
        purpose: TABLE_META[table].purpose,
        provider: model.provider || (table === "llm_models" ? "对话模型渠道" : "未标注渠道"),
        configured: mode !== "missing",
        storageMode: mode,
        storageLabel: mode === "isolated_binding"
          ? "独立受限凭据绑定"
          : mode === "server_reference"
            ? "服务器密钥引用"
            : mode === "legacy_restricted"
              ? "旧版受限字段（待迁移）"
              : "未配置",
        bindingUpdatedAt: binding?.updated_at || model.updated_at || null,
        active: model.is_active !== false && model.is_hidden !== true,
        validationStatus: validation.status,
        lastValidatedAt: validation.at,
        validationExplanation: table === "llm_models" && model.id === REVIEWED_TEXT_HISTORY.modelId && reviewedHistory
          ? `${validation.explanation}。另已采纳本地三笔成功且已结算的业务调用，正式指令验证状态单独记录。`
          : validation.explanation,
        ...(table === "llm_models" && model.id === REVIEWED_TEXT_HISTORY.modelId
          ? { operationalAdmission: reviewedHistory, historicalAdmissionReadFailed: historyReadFailed }
          : {}),
      };
    })).sort((left, right) => left.kind.localeCompare(right.kind) || left.modelName.localeCompare(right.modelName, "zh-CN"));

    const configured = credentials.filter((item) => item.configured).length;
    const isolated = credentials.filter((item) => ["isolated_binding", "server_reference"].includes(item.storageMode)).length;
    const legacyReview = credentials.filter((item) => item.storageMode === "legacy_restricted").length;
    const verified = credentials.filter((item) => item.validationStatus === "verified").length;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      policy: {
        plaintextCredentialReturned: false,
        resolvedCredentialReturned: false,
        credentialSuffixReturned: false,
        editFieldsAreWriteOnly: true,
        configurationIdDerivedFromSecret: false,
        configurationHashReturned: false,
        validationAndConfigurationSeparated: true,
      },
      summary: { total: credentials.length, configured, isolated, legacyReview, missing: credentials.length - configured, verified },
      credentials,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法读取凭据安全状态", code: "CREDENTIAL_HEALTH_LOOKUP_FAILED" }, { status: 503 });
  }
}
