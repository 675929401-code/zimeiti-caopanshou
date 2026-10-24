/** Model diagnostics use the same protocol adapter as actual conversations. */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { resolveVideoDetectionDraft } from "@/lib/model-endpoint";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { validateSafeUrl } from "@/lib/safe-fetch";
import { LLMProxy } from "@/lib/llm-proxy/proxy";
import { LlmModelValidationError, assertLlmValidationConfigurationUnchanged, llmDiagnosticScope, llmModelValidationConfigurationHash } from "@/lib/llm-model-validation-gate";
import { modelProbeFailure } from "@/lib/model-probe-result";
import { llmProxyBindingConfig, resolveLlmProviderBinding } from "@/lib/llm-provider-contract";
import { assertPublishedModelPoolEntry } from "@/lib/server/platform-configuration-compatibility";
import { PlatformConfigurationError } from "@/lib/server/platform-configuration-admin";

const MODEL_CONFIGURATION_COLUMNS = "*";

export async function POST(req: NextRequest) {
  // Model diagnostics can spend supplier quota and persist activation evidence.
  // Keep a route-local capability and step-up gate in addition to the proxy
  // mapping so this endpoint still fails closed if it is invoked directly.
  const authorization = await authorizeAdminCapability(req, "models.manage", {
    requireStepUp: true,
    operation: "llm_test",
    auditAllowed: true,
  });
  if (!authorization.ok) {
    authorization.response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return authorization.response;
  }
  const started = Date.now();
  let dispatched = false;
  try {
    const body = await req.json();
    const scope = llmDiagnosticScope(body);
    if (body.model_type && body.model_type !== "text") return NextResponse.json({ success: false, message: "该接口仅验证对话模型，图片和视频请使用各自的检查入口" }, { status: 400 });
    let stored: Record<string, unknown> | undefined;
    const db = getSupabaseClient();
    let modelId = String(body.model_id || "").trim();
    if (!modelId && body.agent_id) {
      const { data, error } = await db.from("agents").select("model_id").eq("id", body.agent_id).maybeSingle();
      if (error || !data?.model_id) return NextResponse.json({ success: false, message: "智能体没有有效模型绑定，请先配置" }, { status: 400 });
      modelId = String(data.model_id);
    }
    if (modelId) {
      const { data, error } = await db.from("llm_models")
        .select(MODEL_CONFIGURATION_COLUMNS)
        .eq("id", modelId)
        .maybeSingle();
      if (error || !data) return NextResponse.json({ success: false, message: "指定模型不存在，未回退到其他模型" }, { status: 404 });
      stored = { ...data, api_endpoint: data.api_endpoint || data.proxy_url };
    }
    if (scope === "saved") await assertPublishedModelPoolEntry("llm_models", modelId);
    // This also prevents sending a saved key to a different draft origin.
    const draft = resolveVideoDetectionDraft(scope === "saved" ? {} : body, stored);
    const key = resolveProviderSecret(draft.apiKey);
    // A local transparent proxy can resolve public HTTPS hosts into its
    // synthetic 198.18.0.0/15 range. Trust only the exact origin already saved
    // by an administrator; new or cross-origin drafts still receive the full
    // DNS/IP validation and never inherit the stored credential.
    const storedEndpoint = String(stored?.api_endpoint || "").trim();
    const trustedHostnames = storedEndpoint
      && new URL(storedEndpoint).origin === new URL(draft.apiEndpoint).origin
      ? [new URL(storedEndpoint).hostname]
      : [];
    await validateSafeUrl(draft.apiEndpoint, { trustedHostnames });
    const effectiveConfiguration = scope === "saved" ? stored! : {
      ...stored, ...body,
      id: modelId || "",
      model_name: draft.modelName, api_endpoint: draft.apiEndpoint,
      api_protocol_config: body.api_protocol_config ?? stored?.api_protocol_config,
    };
    const llmProviderBinding = resolveLlmProviderBinding(effectiveConfiguration);
    const configurationHash = llmModelValidationConfigurationHash(effectiveConfiguration, key);
    const proxy = new LLMProxy({
      apiBase: draft.apiEndpoint,
      apiKey: key,
      defaultModel: draft.modelName,
      timeout: Math.max(1, Math.min(45, Number(effectiveConfiguration.timeout) || 45)),
      retryCount: 0,
      ...llmProxyBindingConfig(llmProviderBinding),
    });
    const expected = "MODEL_CHECK_" + crypto.randomUUID().replaceAll("-", "");
    dispatched = true;
    const result = await proxy.chat({ model: draft.modelName, messages: [
      { role: "system", content: "Return exactly " + expected + " and no additional text." },
      { role: "user", content: "Run the instruction." },
    ], max_tokens: Math.min(256, Number(effectiveConfiguration.max_reply_tokens) > 0 ? Number(effectiveConfiguration.max_reply_tokens) : 256), enable_thinking: Number(effectiveConfiguration.deep_thinking_type) !== 0 });
    const passed = result.content.trim() === expected;
    let evidence: { id: string; checked_at: string } | null = null;
    if (passed && scope === "saved" && stored?.id) {
      // A successful response to an obsolete configuration cannot authorize the
      // current model. Re-read credentials and configuration after dispatch.
      const latest = await db.from("llm_models").select(MODEL_CONFIGURATION_COLUMNS).eq("id", modelId).maybeSingle();
      if (latest.error || !latest.data) throw new LlmModelValidationError("VALIDATION_CONFIGURATION_CHANGED", "验证期间模型配置无法重新读取，未记录激活证据");
      assertLlmValidationConfigurationUnchanged(stored, latest.data, configurationHash, resolveProviderSecret(latest.data.api_key));
      await assertPublishedModelPoolEntry("llm_models", modelId);
      const checkedAt = new Date().toISOString();
      const providerHost = new URL(draft.apiEndpoint).hostname;
      const persisted = await db.from("llm_model_validation_evidence").upsert({
        model_id: stored.id,
        configuration_hash: configurationHash,
        provider_host: providerHost,
        latency_ms: Date.now() - started,
        prompt_tokens: result.usage?.prompt_tokens ?? null,
        completion_tokens: result.usage?.completion_tokens ?? null,
        checked_by: authorization.actor.userId,
        checked_at: checkedAt,
      }, { onConflict: "model_id,configuration_hash" })
        .select("id,checked_at")
        .single();
      if (persisted.error || !persisted.data) {
        return NextResponse.json({
          success: false,
          model_available: false,
          diagnosticCode: "VALIDATION_EVIDENCE_PERSIST_FAILED",
          message: "上游验证已响应，但验证证据未能安全落库；模型保持未激活，本次不会自动重试",
          paidProbeUsed: true,
          latency: Date.now() - started,
        }, { status: 503 });
      }
      evidence = persisted.data;
    }
    return NextResponse.json({ success: passed, model_available: passed, scope, configurationHash, latency: Date.now() - started,
      diagnosticCode: passed ? "INSTRUCTION_CHECK_PASSED" : "INSTRUCTION_CHECK_FAILED",
      message: passed ? "指定模型已响应并遵守最小系统指令；实际业务输出质量需单独验收" : "上游已响应，但未遵守最小系统指令，不能标记通路验收通过",
      paidProbeUsed: true, usage: result.usage ? { prompt_tokens: result.usage.prompt_tokens, completion_tokens: result.usage.completion_tokens } : null,
      evidence: evidence ? { id: evidence.id, evidenceRecorded: true, checkedAt: evidence.checked_at } : null,
    });
  } catch (error) {
    if (error instanceof LlmModelValidationError || error instanceof PlatformConfigurationError) {
      return NextResponse.json({ success: false, model_available: false, diagnosticCode: error.code, message: error.message, paidProbeUsed: dispatched }, { status: error instanceof LlmModelValidationError ? error.status : 409 });
    }
    const text = error instanceof Error ? error.message : "";
    const match = text.match(/LLM API (\d{3})/);
    const status = match ? Number(match[1]) : 0;
    const diagnostic = status ? modelProbeFailure(status, text) : {
      diagnosticCode: dispatched ? "REQUEST_FAILED" : "CONFIGURATION_INVALID",
      message: dispatched ? "请求未完成，请核对上游连接；未自动重试、隐藏或删除模型" : "配置检查未通过，请核对接口地址、模型ID和后端密钥；更换站点须填写该站点的密钥",
    };
    return NextResponse.json({ success: false, model_available: false, ...diagnostic, status: status || undefined, latency: Date.now() - started, paidProbeUsed: dispatched });
  }
}
