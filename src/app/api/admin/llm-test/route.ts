/** Model diagnostics use the same protocol adapter as actual conversations. */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
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
import {
  parseVisionProbeRequest, effectiveVisionBinding, visionConfigurationHash, buildVisionChallenge,
  diagnoseVisionChallenge, visionFinishReason, assertVisionConfigurationUnchanged,
} from "@/lib/server/llm-vision-validation";

const MODEL_CONFIGURATION_COLUMNS = "*";

/** A separate capability challenge cannot write an ordinary text-validation hash. */
async function runVisionDiagnostic(body: Record<string, unknown>, actorId: string, started: number) {
  let dispatched = false;
  let completedReceipt: Record<string, unknown> | null = null;
  try {
    const { scope, modelId } = parseVisionProbeRequest(body);
    const db = getSupabaseClient();
    const lookup = await db.from("llm_models").select(MODEL_CONFIGURATION_COLUMNS).eq("id", modelId).maybeSingle();
    if (lookup.error || !lookup.data) throw new LlmModelValidationError("VISION_MODEL_NOT_FOUND", "指定原模型不存在，未选择替代模型", 404);
    const stored = lookup.data;
    await assertPublishedModelPoolEntry("llm_models", modelId);
    const effective = effectiveVisionBinding(stored, scope);
    const endpoint = String(stored.api_endpoint || stored.proxy_url || "");
    const secret = resolveProviderSecret(stored.api_key);
    const ordinaryHash = llmModelValidationConfigurationHash(stored, secret);
    const configurationHash = visionConfigurationHash(effective, secret);
    await validateSafeUrl(endpoint, { trustedHostnames: [new URL(endpoint).hostname] });
    const binding = resolveLlmProviderBinding(effective);
    const proxy = new LLMProxy({ apiBase: endpoint, apiKey: secret, defaultModel: String(stored.model_name),
      timeout: Math.max(1, Math.min(45, Number(stored.timeout) || 45)), retryCount: 0, ...llmProxyBindingConfig(binding) });
    const challenge = await buildVisionChallenge();
    dispatched = true;
    const result = await proxy.chat({ model: String(stored.model_name), messages: challenge.messages,
      max_tokens: Math.min(512, Number(stored.max_reply_tokens) > 0 ? Number(stored.max_reply_tokens) : 512), enable_thinking: false });
    const diagnostics = diagnoseVisionChallenge(result.content, challenge.expected, visionFinishReason(result));
    const passed = diagnostics.failure === null;
    const diagnosticReceipt = { modelId, modelName: String(stored.model_name), providerHost: new URL(endpoint).hostname,
      fixtureVersion: challenge.fixtureVersion, fixtureSha256: challenge.fixtureSha256,
      inputImages: { imageCount: challenge.imageCount, imageSha256: challenge.imageSha256 }, diagnostics,
      responseSha256: createHash("sha256").update(typeof result.content === "string" ? result.content : "").digest("hex"), usage: result.usage ?? null };
    completedReceipt = diagnosticReceipt;
    if (!passed) return NextResponse.json({ success: false, model_available: false, capability: "vision", scope,
      diagnosticCode: "VISION_CHALLENGE_FAILED", message: "上游已响应，但未准确按顺序识别全部三图；未记录视觉证据，不改变能力或启用状态",
      paidProbeUsed: true, billingVerified: false, latency: Date.now() - started, ...diagnosticReceipt });
    const latest = await db.from("llm_models").select(MODEL_CONFIGURATION_COLUMNS).eq("id", modelId).maybeSingle();
    if (latest.error || !latest.data) throw new LlmModelValidationError("VALIDATION_CONFIGURATION_CHANGED", "验证后无法核对原模型配置，未记录视觉证据");
    const currentSecret = resolveProviderSecret(latest.data.api_key);
    assertVisionConfigurationUnchanged(stored, latest.data, ordinaryHash, currentSecret);
    if (visionConfigurationHash(effectiveVisionBinding(latest.data, scope), currentSecret) !== configurationHash) {
      throw new LlmModelValidationError("VALIDATION_CONFIGURATION_CHANGED", "当前能力候选与请求时不同，未记录视觉证据");
    }
    await assertPublishedModelPoolEntry("llm_models", modelId);
    const persisted = await db.from("llm_model_validation_evidence").upsert({ model_id: modelId, configuration_hash: configurationHash,
      provider_host: new URL(endpoint).hostname, latency_ms: Date.now() - started,
      prompt_tokens: result.usage?.prompt_tokens ?? null, completion_tokens: result.usage?.completion_tokens ?? null,
      checked_by: actorId, checked_at: new Date().toISOString() }, { onConflict: "model_id,configuration_hash" }).select("id,checked_at").single();
    if (persisted.error || !persisted.data) return NextResponse.json({ success: false, model_available: false, capability: "vision",
      diagnosticCode: "VISION_EVIDENCE_PERSIST_FAILED", message: "三图识别已响应，但视觉证据未能安全记录；不改变能力或启用状态，本次不自动重试",
      paidProbeUsed: true, billingVerified: false, outcome: "evidence_not_recorded", latency: Date.now() - started, ...diagnosticReceipt }, { status: 503 });
    return NextResponse.json({ success: true, model_available: true, capability: "vision", scope, configurationHash,
      diagnosticCode: "VISION_CHALLENGE_PASSED", message: "指定原模型的当前通路已通过随机三图识别；仅记录视觉证据，未发布能力或激活模型，业务图片解析质量仍需单独验收",
      paidProbeUsed: true, billingVerified: false, latency: Date.now() - started, ...diagnosticReceipt,
      evidence: { id: persisted.data.id, evidenceRecorded: true, checkedAt: persisted.data.checked_at } });
  } catch (error) {
    const known = error instanceof LlmModelValidationError || error instanceof PlatformConfigurationError;
    return NextResponse.json({ success: false, model_available: false, capability: "vision",
      diagnosticCode: known ? error.code : dispatched ? "VISION_RESULT_UNKNOWN" : "VISION_CONFIGURATION_INVALID",
      message: known ? error.message : dispatched ? "图片验证结果未知；本次不自动重试，请先核对原请求和供应商账单" : "图片验证配置检查未通过，未发送请求",
      outcome: dispatched ? "unknown" : "not_dispatched", paidProbeUsed: dispatched, billingVerified: false,
      latency: Date.now() - started, ...(completedReceipt ?? {}) }, { status: known && error instanceof LlmModelValidationError ? error.status : 503 });
  }
}

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
    if (body?.capability !== undefined) {
      if (body.capability !== "vision") throw new LlmModelValidationError("MODEL_CAPABILITY_TEST_INVALID", "不支持该能力验证", 400);
      return await runVisionDiagnostic(body, authorization.actor.userId, started);
    }
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
