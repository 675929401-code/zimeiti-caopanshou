import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
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

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  return payload?.role === "admin" ? payload : null;
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  try {
    const body = await request.json().catch(() => ({})) as {
      id?: string;
      model_type?: "drawing" | "image" | "text" | "video";
    };
    const id = String(body.id || "").trim();
    const modelType = body.model_type;
    if (!id || !modelType) {
      return NextResponse.json({ error: "Missing model id or model_type" }, { status: 400 });
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
      const { data: model, error: readError } = await supabase
        .from("llm_models")
        .select("id,name,model_name,api_endpoint,proxy_url,api_key,billing_mode,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,deep_thinking_type,enable_web_search,api_protocol_config,is_active,is_hidden,user_access,updated_at")
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
