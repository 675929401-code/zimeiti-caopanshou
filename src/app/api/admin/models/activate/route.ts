import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability, getAdminStepUpToken, hashAdminStepUpToken } from "@/lib/server/admin-governance-authority";
import {
  ModelActivationGateError,
  assertVideoModelActivationReady,
} from "@/lib/model-activation-gate";
import {
  LlmModelValidationError,
  assertFreshLlmModelValidationEvidence,
  llmModelValidationConfigurationHash,
} from "@/lib/llm-model-validation-gate";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { assertPublishedModelPoolEntry } from "@/lib/server/platform-configuration-compatibility";
import { PlatformConfigurationError } from "@/lib/server/platform-configuration-admin";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { sharedConfigurationConnection } from "@/storage/database/configuration-source";
import { assertReviewedHistoryRequest, readReviewedTextHistory, REVIEWED_TEXT_HISTORY } from "@/lib/server/text-model-reviewed-history";

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "models_activate",
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json().catch(() => ({})) as {
      id?: string;
      model_type?: "drawing" | "image" | "text" | "video";
      reviewedHistory?: unknown;
    };
    const id = String(body.id || "").trim();
    const modelType = body.model_type;
    if (!id || !modelType) {
      return NextResponse.json({ error: "Missing model id or model_type" }, { status: 400 });
    }
    const reviewed = Object.hasOwn(body, "reviewedHistory");
    if (reviewed) {
      assertReviewedHistoryRequest(body);
      const { access, stepUp, maintenanceLock } = authorization;
      const shared = sharedConfigurationConnection();
      if (request.headers.get("host") !== "zyuani8.com" || request.headers.get("origin") !== "https://zyuani8.com"
        || request.nextUrl.search || process.env.NODE_ENV !== "production" || process.env.LOCAL_ACCEPTANCE_PREVIEW === "true"
        || process.env.LOCAL_RUNTIME_PROFILE?.startsWith("formal-local") || process.env.LOCAL_RUNTIME_PROFILE === "local-acceptance"
        || (shared && new URL(shared.url).href !== new URL(process.env.COZE_SUPABASE_URL || "").href)) {
        throw new LlmModelValidationError("REVIEWED_HISTORY_DESTINATION_REQUIRED", "本次受审采纳仅限已登记正式站", 403);
      }
      if (access.adminLevel !== "super_admin" || access.authorityStatus !== "ready" || !access.profileActive
        || !access.integrityValid || access.revision < 1 || !access.checksum || access.checksum === "legacy-schema-absent"
        || maintenanceLock?.status !== "ready" || maintenanceLock.enabled || stepUp?.status !== "ready"
        || stepUp.authMethod !== "login_password" || !stepUp.sessionId) {
        throw new LlmModelValidationError("REVIEWED_HISTORY_OWNER_REQUIRED", "本次采纳需要所有者在正式站通过登录密码二次验证", 403);
      }
    }

    if (modelType === "drawing" || modelType === "image") {
      await assertPublishedModelPoolEntry("cover_models", id);
      throw new ModelActivationGateError(
        "IMAGE_VALIDATION_PUBLICATION_REQUIRED",
        "生图模型必须通过真实生成验证窗口发布，不能用旧激活入口绕过图片、历史和扣费证据",
      );
    }
    if (modelType === "text") {
      await assertPublishedModelPoolEntry("llm_models", id);
      const supabase = getSupabaseAdminClient();
      const beforeGuard = reviewed
        ? await supabase.rpc("read_agent_catalog_model_guard_v1", { p_model_id: id })
        : null;
      if (reviewed && (beforeGuard?.error || beforeGuard?.data?.poolCount !== 1 || typeof beforeGuard.data.rowVersion !== "string")) {
        throw new LlmModelValidationError("REVIEWED_HISTORY_POOL_GUARD_REQUIRED", "无法确认唯一已发布的模型及其行版本");
      }
      const { data: model, error: readError } = await supabase
        .from("llm_models")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (readError || !model) {
        return NextResponse.json({ error: readError?.message || "Text model not found" }, { status: 404 });
      }
      let resolvedSecret = "";
      try {
        resolvedSecret = resolveProviderSecret(model.api_key);
      } catch {
        throw new LlmModelValidationError("TEXT_MODEL_CREDENTIAL_REQUIRED", "对话模型缺少可用的服务端凭据，不能激活");
      }
      const configurationHash = llmModelValidationConfigurationHash(model, resolvedSecret);
      if (reviewed) {
        if (!resolvedSecret || configurationHash !== REVIEWED_TEXT_HISTORY.configurationHash
          || model.is_hidden === true || model.model_name !== "deepseek-flash") {
          throw new LlmModelValidationError("REVIEWED_HISTORY_CONFIGURATION_CHANGED", "模型配置与已审证据不一致");
        }
        const guard = await supabase.rpc("read_agent_catalog_model_guard_v1", { p_model_id: id });
        if (guard.error || guard.data?.poolCount !== 1 || guard.data.rowVersion !== beforeGuard.data.rowVersion) {
          throw new LlmModelValidationError("REVIEWED_HISTORY_POOL_GUARD_REQUIRED", "核验模型执行配置期间，已发布模型或其行版本发生变化");
        }
        const operation = await supabase.rpc("activate_reviewed_deepseek_history_v1", {
          p_actor: authorization.actor.userId,
          p_step_hash: hashAdminStepUpToken(getAdminStepUpToken(request)),
          p_model_id: id,
          p_agent_id: REVIEWED_TEXT_HISTORY.agentId,
          p_configuration_hash: configurationHash,
          p_expected_row_version: guard.data.rowVersion,
        });
        if (operation.error) {
          const reason = String(operation.error.message ?? "");
          const code = /^REVIEWED_HISTORY_[A-Z_]+$/u.test(reason) ? reason : "REVIEWED_HISTORY_ACTIVATION_UNCONFIRMED";
          throw new LlmModelValidationError(code, "受审采纳未获确认，请核对原请求及当前状态", code === reason ? 409 : 503);
        }
        await assertPublishedModelPoolEntry("llm_models", id);
        const current = await supabase.from("llm_models").select("*").eq("id", id).maybeSingle();
        if (current.error || !current.data || current.data.is_active !== true || current.data.is_hidden === true
          || current.data.user_access !== "available") {
          throw new LlmModelValidationError("REVIEWED_HISTORY_READBACK_REQUIRED", "请核对本次受审采纳的原始回执", 503);
        }
        const currentHash = llmModelValidationConfigurationHash(current.data, resolveProviderSecret(current.data.api_key));
        const proof = await readReviewedTextHistory(supabase, id, currentHash, REVIEWED_TEXT_HISTORY.agentId);
        if (!proof || operation.data?.activated !== true || operation.data.acceptance?.id !== proof.auditId
          || operation.data.acceptance?.source !== proof.source || operation.data.acceptance?.checkedAt !== proof.checkedAt
          || Date.parse(String(operation.data.acceptance?.auditCreatedAt)) !== Date.parse(proof.auditCreatedAt)
          || typeof operation.data.idempotent !== "boolean") {
          throw new LlmModelValidationError("REVIEWED_HISTORY_READBACK_REQUIRED", "受审模型配置及其审计回执未能对应", 503);
        }
        const { name, model_name, is_active, is_hidden, user_access, updated_at } = current.data;
        return NextResponse.json({
          activated: true, idempotent: operation.data.idempotent,
          model: { id, name, model_name, is_active, is_hidden, user_access, updated_at }, operationalAdmission: proof,
        }, { headers: { "Cache-Control": "private, no-store" } });
      }
      const evidenceResult = await supabase
        .from("llm_model_validation_evidence")
        .select("id,model_id,configuration_hash,checked_at")
        .eq("model_id", id)
        .eq("configuration_hash", configurationHash)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (evidenceResult.error) {
        throw new LlmModelValidationError("TEXT_MODEL_VALIDATION_EVIDENCE_READ_FAILED", "对话模型验证证据读取失败，模型保持未激活", 503);
      }
      const accepted = assertFreshLlmModelValidationEvidence(model, resolvedSecret, evidenceResult.data);
      if (model.is_active === true && model.is_hidden !== true && model.user_access === "available") {
        return NextResponse.json({
          model: {
            id: model.id,
            name: model.name,
            model_name: model.model_name,
            is_active: model.is_active,
            is_hidden: model.is_hidden,
            user_access: model.user_access,
            updated_at: model.updated_at,
          },
          activated: true,
          idempotent: true,
          evidence_id: evidenceResult.data?.id,
          checked_at: accepted.checkedAt,
        });
      }
      const activationTimestamp = new Date().toISOString();
      const { data: activated, error: activationError } = await supabase
        .from("llm_models")
        .update({ is_active: true, user_access: "available", updated_at: activationTimestamp })
        .eq("id", id)
        .eq("updated_at", model.updated_at)
        .select("id,name,model_name,is_active,is_hidden,user_access,updated_at")
        .maybeSingle();
      if (activationError) {
        return NextResponse.json({ error: activationError.message || "Text model activation failed" }, { status: 409 });
      }
      if (!activated) return NextResponse.json({ error: "Text model activation compare-and-set failed" }, { status: 409 });
      return NextResponse.json({
        model: activated,
        activated: true,
        idempotent: false,
        evidence_id: evidenceResult.data?.id,
        checked_at: accepted.checkedAt,
      });
    }
    if (modelType !== "video") {
      return NextResponse.json({ error: "Unsupported model_type" }, { status: 400 });
    }

    await assertPublishedModelPoolEntry("video_models", id);
    const supabase = getSupabaseAdminClient();
    const { data: model, error: readError } = await supabase
      .from("video_models")
      .select("id,model_name,provider,protocol_type,api_endpoint,api_key,api_protocol_config,is_active,is_hidden")
      .eq("id", id)
      .single();
    if (readError || !model) {
      return NextResponse.json({ error: readError?.message || "Video model not found" }, { status: 404 });
    }
    // 客户端不能随请求提交证据；只接受此前由服务端真实验收器持久化的完整证据。
    const evidenceId = assertVideoModelActivationReady(model);
    const { data: activated, error: activationError } = await supabase
      .from("video_models")
      .update({ is_active: true })
      .eq("id", id)
      .select("id,name,model_name,is_active,is_hidden,updated_at")
      .single();
    if (activationError || !activated) {
      return NextResponse.json({ error: activationError?.message || "Activation compare-and-set failed" }, { status: 409 });
    }

    return NextResponse.json({
      model: activated,
      activated: true,
      evidence_id: evidenceId,
    });
  } catch (error) {
    if (error instanceof LlmModelValidationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof PlatformConfigurationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof ModelActivationGateError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[admin/models/activate] failed:", error);
    return NextResponse.json({ error: "Model activation failed" }, { status: 500 });
  }
}
