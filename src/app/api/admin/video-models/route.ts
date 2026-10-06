import { NextRequest, NextResponse } from "next/server";
import { updateVideoModelAtomic } from "@/lib/video-model-atomic-update";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  ModelActivationGateError,
  prepareVideoModelBindingUpdate,
  forceNewVideoModelPending,
  preservePersistedVideoActivationGate,
} from "@/lib/model-activation-gate";
import { AUTODL_COMFYUI_WORKFLOW_PROTOCOL } from "@/lib/video-autodl-comfyui-workflow";
import { videoPriceConfigurationError } from "@/lib/model-price-rounding";
import { RETIRED_MODEL_PROVIDER } from "@/lib/model-retirement";
import {
  stageLegacyModelPoolCatalogState,
  stageLegacyModelPoolUpsert,
} from "@/lib/server/platform-configuration-compatibility";

type VideoModelRecord = Record<string, unknown>;

type ProtocolPreset = {
  name: string;
  description: string;
  urlPattern: string;
  method: "POST";
  headers: Record<string, string>;
  bodyTemplate: Record<string, unknown>;
  responsePath: { taskId: string; status: string; videoUrl: string };
  statusValues: { processing: string; success: string; failed: string };
  pollEndpoint: string;
};

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

const PROTOCOL_PRESETS: Record<string, ProtocolPreset> = {
  [AUTODL_COMFYUI_WORKFLOW_PROTOCOL]: {
    name: "AutoDL ComfyUI 官方工作流",
    description: "Raw ComfyUI group token; workflow-specific body and asynchronous GET result polling.",
    urlPattern: "{base_url}/comfyui/comfyui_workflow/{workflow_id}",
    method: "POST",
    headers: { Authorization: "{api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      prompt: "{prompt}",
      duration: "{duration}",
      resolution: "{resolution_with_orientation}",
    },
    responsePath: { taskId: "data.task_id", status: "data.status", videoUrl: "data.results.0.url" },
    statusValues: { processing: "RUNNING", success: "SUCCESS", failed: "FAILED" },
    pollEndpoint: "{base_url}/comfyui/comfyui_workflow/result/{task_id}",
  },
  dashscope_wan_s2v: {
    name: "DashScope Wan 2.2 数字人",
    description: "Character image plus 4-15 second voice audio; asynchronous lip-synced speech video.",
    urlPattern: "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis",
    method: "POST",
    headers: {
      Authorization: "Bearer {api_key}",
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    bodyTemplate: {
      model: "wan2.2-s2v",
      input: { image_url: "{image_url}", audio_url: "{audio_url}" },
      parameters: { style: "speech", resolution: "{resolution}" },
    },
    responsePath: { taskId: "output.task_id", status: "output.task_status", videoUrl: "output.results.video_url" },
    statusValues: { processing: "RUNNING", success: "SUCCEEDED", failed: "FAILED" },
    pollEndpoint: "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}",
  },
  autodl_comfyui_h3: {
    name: "AutoDL 托管 · MiniMax H3",
    description: "Raw ComfyUI token; submit an asynchronous hosted workflow and poll by task_id.",
    urlPattern: "{base_url}/comfyui/comfyui_workflow/{workflow_id}",
    method: "POST",
    headers: { Authorization: "{api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      prompt: "{prompt}",
      duration: "{duration}",
      resolution: "{resolution_with_orientation}",
      ref_image_0: "{image_url}",
      ref_audio_0: "{audio_url}",
    },
    responsePath: { taskId: "data.task_id", status: "data.status", videoUrl: "data.results.0.url" },
    statusValues: { processing: "RUNNING", success: "SUCCESS", failed: "FAILED" },
    pollEndpoint: "{base_url}/comfyui/comfyui_workflow/result/{task_id}",
  },
  suanlicheng_video: {
    name: "算力橙 LC · MiniMax H3",
    description: "Upload versioned materials, submit an H3 generation, then poll the asynchronous task.",
    urlPattern: "{base_url}/v1/h3/videos/generations",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      task: "multi_reference_to_video",
      model: "{model_id}",
      prompt: "{prompt}",
      materials: ["{uploaded_material_reference}"],
      idempotency_key: "{idempotency_key}",
      frames: "{frames}",
      seed: "{random_seed}",
      width: "{width}",
      height: "{height}",
    },
    responsePath: { taskId: "id", status: "status", videoUrl: "video_url" },
    statusValues: { processing: "in_progress", success: "completed", failed: "failed" },
    pollEndpoint: "{base_url}/v1/h3/videos/generations/{task_id}",
  },
  siliconflow_kling: {
    name: "SiliconFlow Kling",
    description: "SiliconFlow proxy for Kling video generation.",
    urlPattern: "https://api.siliconflow.cn/v1/video/kling/{version}/{tier}/generations",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      model: "{model_id}",
      prompt: "{prompt}",
      image: "{image_url}",
      negative_prompt: "{negative_prompt}",
      duration: "{duration}",
      aspect_ratio: "{aspect_ratio}",
    },
    responsePath: { taskId: "requestId", status: "status", videoUrl: "results[0].url" },
    statusValues: { processing: "InQueue", success: "Succeed", failed: "Failed" },
    pollEndpoint: "https://api.siliconflow.cn/v1/video/kling/{version}/{tier}/generations/{task_id}",
  },
  siliconflow_vidu: {
    name: "SiliconFlow Vidu",
    description: "SiliconFlow proxy for Vidu video generation.",
    urlPattern: "https://api.siliconflow.cn/v1/video/vidu/{version}/generations",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      model: "{model_id}",
      prompt: "{prompt}",
      image: "{image_url}",
      duration: "{duration}",
      aspect_ratio: "{aspect_ratio}",
    },
    responsePath: { taskId: "requestId", status: "status", videoUrl: "results[0].url" },
    statusValues: { processing: "InQueue", success: "Succeed", failed: "Failed" },
    pollEndpoint: "https://api.siliconflow.cn/v1/video/vidu/{version}/generations/{task_id}",
  },
  openai_compatible: {
    name: "OpenAI compatible",
    description: "OpenAI-style video generation endpoint.",
    urlPattern: "{base_url}/v1/video/generations",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      model: "{model_id}",
      prompt: "{prompt}",
      image_url: "{image_url}",
      size: "{aspect_ratio}",
      duration: "{duration}",
    },
    responsePath: { taskId: "id", status: "status", videoUrl: "data[0].url" },
    statusValues: { processing: "processing", success: "completed", failed: "failed" },
    pollEndpoint: "{base_url}/v1/video/generations/{task_id}",
  },
  secure_skill_video: {
    name: "Channel A MiniMax H3",
    description: "Channel A asynchronous MiniMax H3 reference-image video endpoint.",
    urlPattern: "{base_url}/v1/videos",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      model: "{model_id}",
      prompt: "{prompt}",
      duration: "{duration}",
      resolution: "{resolution}",
      aspect_ratio: "{aspect_ratio}",
      image_urls: ["{image_url}"],
    },
    responsePath: { taskId: "task_id", status: "status", videoUrl: "video_url" },
    statusValues: { processing: "in_progress", success: "completed", failed: "failed" },
    pollEndpoint: "{base_url}/v1/videos/{task_id}",
  },
  secure_skill_flow_jobs: {
    name: "Channel A Flow Jobs",
    description: "Channel A Flow jobs endpoint for VEO / Omni video tasks.",
    urlPattern: "{base_url}/v1/jobs",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      model: "{model_id}",
      video_url: "{source_video_url}",
      messages: [{ role: "user", content: [{ type: "text", text: "{prompt}" }] }],
      stream: false,
    },
    responsePath: { taskId: "id", status: "status", videoUrl: "video_url" },
    statusValues: { processing: "processing", success: "completed", failed: "failed" },
    pollEndpoint: "{base_url}/v1/jobs/{task_id}",
  },
  secure_skill_wan3_video: {
    name: "Channel A Wan3 Video",
    description: "Channel A Wan3 standard asynchronous video endpoint.",
    urlPattern: "{base_url}/v1/videos/generations",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      model: "{model_id}",
      prompt: "{prompt}",
      media: [],
      resolution: "{resolution}",
      ratio: "{aspect_ratio}",
      duration: "{duration}",
      prompt_extend: false,
    },
    responsePath: { taskId: "task_id", status: "status", videoUrl: "video_url" },
    statusValues: { processing: "running", success: "succeeded", failed: "failed" },
    pollEndpoint: "{base_url}/v1/videos/tasks/{task_id}",
  },
  runway: {
    name: "Runway",
    description: "Runway Gen video generation API.",
    urlPattern: "https://api.dev.runwayml.com/v1/image_to_video",
    method: "POST",
    headers: { Authorization: "Bearer {api_key}", "X-Runway-Version": "2024-11-06", "Content-Type": "application/json" },
    bodyTemplate: {
      promptImage: "{image_url}",
      promptText: "{prompt}",
      model: "{model_id}",
      duration: "{duration}",
      ratio: "{aspect_ratio}",
    },
    responsePath: { taskId: "id", status: "status", videoUrl: "output[0]" },
    statusValues: { processing: "RUNNING", success: "SUCCEEDED", failed: "FAILED" },
    pollEndpoint: "https://api.dev.runwayml.com/v1/tasks/{task_id}",
  },
  replicate: {
    name: "Replicate",
    description: "Replicate prediction API for video models.",
    urlPattern: "https://api.replicate.com/v1/predictions",
    method: "POST",
    headers: { Authorization: "Token {api_key}", "Content-Type": "application/json" },
    bodyTemplate: {
      version: "{model_id}",
      input: {
        prompt: "{prompt}",
        image: "{image_url}",
        aspect_ratio: "{aspect_ratio}",
      },
    },
    responsePath: { taskId: "id", status: "status", videoUrl: "output" },
    statusValues: { processing: "starting", success: "succeeded", failed: "failed" },
    pollEndpoint: "https://api.replicate.com/v1/predictions/{task_id}",
  },
};

function protocolList() {
  return Object.entries(PROTOCOL_PRESETS).map(([id, preset]) => ({
    id,
    name: preset.name,
    description: preset.description,
  }));
}

const MASKED_SECRET = /^(?:[*•●·]+|已配置)$/u;

function replacementApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !MASKED_SECRET.test(trimmed) ? trimmed : undefined;
}

function publicModel<T extends Record<string, unknown>>(model: T): Omit<T, "api_key"> & { api_key_configured: boolean } {
  const { api_key, ...safe } = model;
  return { ...safe, api_key_configured: Boolean(String(api_key || "").trim()) };
}

function buildRecord(body: Record<string, unknown>, detectedProtocol: string, modelId: string) {
  const duration = Number(body.duration_seconds) || 5;
  return {
    id: modelId,
    name: String(body.name || ""),
    model_name: String(body.model_name || body.name || ""),
    provider: String(body.provider || ""),
    admin_notes: String(body.admin_notes || ""),
    api_endpoint: String(body.api_endpoint || ""),
    api_key: String(body.api_key || ""),
    protocol_type: detectedProtocol,
    price_per_use: Number(body.price_per_use) || 0,
    cost_price: Number(body.cost_price) || 0,
    currency: "CNY",
    duration_seconds: duration,
    max_duration: Number(body.max_duration) || duration || 10,
    supports_image_input: body.supports_image_input !== false,
    is_active: true,
    is_hidden: false,
    sort_order: Number(body.sort_order) || 100,
    api_protocol_config: body.api_protocol_config || {},
  };
}

function generateModelId(modelName: string, endpoint: string) {
  const base = modelName.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "video-model";
  let platform = "custom";
  try {
    const host = new URL(endpoint).hostname;
    if (host.includes("yunwu")) platform = "ch1";
    else if (host.includes("vectorengine")) platform = "ch2";
    else if (host.includes("openclaw")) platform = "ch3";
    else if (host.includes("siliconflow")) platform = "sf";
    else platform = host.replace(/^api\./, "").split(".")[0] || "custom";
  } catch {}
  return `${base}-${platform}`;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("video_models")
      .select("*")
      .order("sort_order");

    if (!error) {
      return NextResponse.json({ models: (data || []).filter((model: Record<string, unknown>) => model.provider !== "retired_configuration").map(publicModel), protocols: protocolList() });
    }
    console.error("[admin/video-models] Supabase query failed:", error.message);
    return NextResponse.json({ error: "Realtime video model data unavailable" }, { status: 503 });
  } catch (error) {
    console.error("[admin/video-models] Supabase client failed:", error);
    return NextResponse.json({ error: "Realtime video model data unavailable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const name = String(body.name || "");
    const endpoint = String(body.api_endpoint || "");
    const modelName = String(body.model_name || name);
    if (!name || !endpoint) {
      return NextResponse.json({ error: "Model name and API endpoint are required" }, { status: 400 });
    }

    const detectedProtocol = String(body.protocol_type || "").trim();
    const provider = String(body.provider || "").trim();
    if (!detectedProtocol || !provider) {
      return NextResponse.json({ error: "Provider and protocol_type are required", code: "VIDEO_PROTOCOL_BINDING_REQUIRED" }, { status: 400 });
    }
    const bodyId = String(body.id || "");
    const modelId = bodyId && !bodyId.startsWith("temp-") ? bodyId : generateModelId(modelName, endpoint);
    const record = buildRecord(body, detectedProtocol, modelId);
    if (record.provider === RETIRED_MODEL_PROVIDER) {
      return NextResponse.json({ error: "Retirement is only available through DELETE", code: "MODEL_RETIREMENT_DELETE_ONLY" }, { status: 409 });
    }
    const supabase = getSupabaseAdminClient();

    const { data: existing, error: existingError } = await supabase
      .from("video_models")
      .select("*")
      .eq("id", modelId)
      .maybeSingle();
    if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

    if (!String(record.api_key || "").trim() && body.copy_api_key_from_model_id) {
      const sourceId = String(body.copy_api_key_from_model_id || "").trim();
      const sourceResult = await supabase
        .from("video_models")
        .select("api_endpoint,api_key")
        .eq("id", sourceId)
        .maybeSingle();
      if (sourceResult.error || !sourceResult.data?.api_key) {
        return NextResponse.json({ error: "复用渠道密钥失败", code: "VIDEO_CHANNEL_KEY_SOURCE_NOT_FOUND" }, { status: 400 });
      }
      let targetHost = "";
      let sourceHost = "";
      try {
        targetHost = new URL(String(record.api_endpoint || "")).hostname.toLowerCase();
        sourceHost = new URL(String(sourceResult.data.api_endpoint || "")).hostname.toLowerCase();
      } catch {
        return NextResponse.json({ error: "渠道地址无效", code: "VIDEO_CHANNEL_ENDPOINT_INVALID" }, { status: 400 });
      }
      if (!targetHost || targetHost !== sourceHost) {
        return NextResponse.json({ error: "只允许在同一渠道站点内复用密钥", code: "VIDEO_CHANNEL_KEY_HOST_MISMATCH" }, { status: 400 });
      }
      record.api_key = sourceResult.data.api_key;
    }

    const pricingChanged = !existing
      || Number(record.cost_price) !== Number(existing.cost_price)
      || Number(record.price_per_use) !== Number(existing.price_per_use)
      || body.api_protocol_config !== undefined
        && JSON.stringify((record.api_protocol_config as Record<string, unknown>)?.resolution_cost_prices || {})
          !== JSON.stringify((existing.api_protocol_config as Record<string, unknown> | undefined)?.resolution_cost_prices || {})
      || body.api_protocol_config !== undefined
        && JSON.stringify((record.api_protocol_config as Record<string, unknown>)?.resolution_prices || {})
          !== JSON.stringify((existing.api_protocol_config as Record<string, unknown> | undefined)?.resolution_prices || {});
    if (pricingChanged) {
      const priceError = videoPriceConfigurationError({
        costPrice: record.cost_price,
        sellingPrice: record.price_per_use,
        protocolConfig: record.api_protocol_config,
      });
      if (priceError) return NextResponse.json({ error: priceError, code: "VIDEO_PRICE_CONFIGURATION_REQUIRED" }, { status: 400 });
    }

    let writeRecord: VideoModelRecord;
    if (existing) {
      const nextApiKey = replacementApiKey(body.api_key);
      writeRecord = {
        ...record,
        api_key: nextApiKey ?? existing.api_key,
        is_active: true,
        is_hidden: false,
        api_protocol_config: body.api_protocol_config === undefined
          ? existing.api_protocol_config
          : preservePersistedVideoActivationGate(existing.api_protocol_config, record.api_protocol_config),
      };
      writeRecord = prepareVideoModelBindingUpdate(existing, writeRecord);
    } else {
      if (!String(record.api_key || "").trim()) {
        return NextResponse.json({ error: "API credential is required", code: "VIDEO_MODEL_CREDENTIAL_REQUIRED" }, { status: 400 });
      }
      writeRecord = forceNewVideoModelPending(record);
    }

    const result = await stageLegacyModelPoolUpsert({
      actorId: admin.userId,
      table: "video_models",
      id: modelId,
      values: writeRecord,
      changeNote: `${existing ? "修改" : "新增"}视频模型 ${modelId}`,
    });
    return NextResponse.json({
      success: true,
      staged: true,
      published: false,
      result,
      detected_protocol: detectedProtocol,
    }, { status: 202 });
  } catch (error) {
    if (error instanceof ModelActivationGateError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[admin/video-models] POST failed:", error);
    return NextResponse.json({ error: "Video model update failed" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const id = String(body.id || "");
    if (!id) return NextResponse.json({ error: "Missing model id" }, { status: 400 });

    const supabase = getSupabaseAdminClient();
    const { data: current, error: currentError } = await supabase
      .from("video_models")
      .select("*")
      .eq("id", id)
      .single();
    if (currentError || !current) {
      return NextResponse.json({ error: currentError?.message || "Video model not found" }, { status: 404 });
    }
    if (current.provider === RETIRED_MODEL_PROVIDER || body.provider === RETIRED_MODEL_PROVIDER) {
      return NextResponse.json({ error: "Retirement is only available through DELETE", code: "MODEL_RETIREMENT_DELETE_ONLY" }, { status: 409 });
    }

    const updates: VideoModelRecord = { ...body };
    delete updates.id;
    delete updates.api_key_configured;
    const nextApiKey = replacementApiKey(body.api_key);
    if (nextApiKey === undefined) delete updates.api_key;
    else updates.api_key = nextApiKey;
    if (!String(updates.provider ?? current.provider ?? "").trim()
      || !String(updates.protocol_type ?? current.protocol_type ?? "").trim()) {
      return NextResponse.json({ error: "Provider and protocol_type are required", code: "VIDEO_PROTOCOL_BINDING_REQUIRED" }, { status: 400 });
    }
    if (updates.api_protocol_config !== undefined) {
      updates.api_protocol_config = preservePersistedVideoActivationGate(
        current.api_protocol_config,
        updates.api_protocol_config,
      );
    }
    updates.is_active = true;
    updates.is_hidden = false;

    const pricingChanged = updates.cost_price !== undefined
      && Number(updates.cost_price) !== Number(current.cost_price)
      || updates.price_per_use !== undefined
      && Number(updates.price_per_use) !== Number(current.price_per_use)
      || updates.api_protocol_config !== undefined
        && JSON.stringify((updates.api_protocol_config as Record<string, unknown>)?.resolution_cost_prices || {})
          !== JSON.stringify((current.api_protocol_config as Record<string, unknown> | undefined)?.resolution_cost_prices || {})
      || updates.api_protocol_config !== undefined
        && JSON.stringify((updates.api_protocol_config as Record<string, unknown>)?.resolution_prices || {})
          !== JSON.stringify((current.api_protocol_config as Record<string, unknown> | undefined)?.resolution_prices || {});
    if (pricingChanged) {
      const priceError = videoPriceConfigurationError({
        costPrice: updates.cost_price ?? current.cost_price,
        sellingPrice: updates.price_per_use ?? current.price_per_use,
        protocolConfig: updates.api_protocol_config ?? current.api_protocol_config,
      });
      if (priceError) return NextResponse.json({ error: priceError, code: "VIDEO_PRICE_CONFIGURATION_REQUIRED" }, { status: 400 });
    }

    Object.assign(updates, prepareVideoModelBindingUpdate(current, updates));

    const result = await stageLegacyModelPoolUpsert({
      actorId: admin.userId,
      table: "video_models",
      id,
      values: updates,
      changeNote: `修改视频模型 ${id}`,
    });
    return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
  } catch (error) {
    if (error instanceof ModelActivationGateError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[admin/video-models] PUT failed:", error);
    return NextResponse.json({ error: "Video model update failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const url = new URL(req.url);
  let id = url.searchParams.get("id");
  if (!id) {
    try {
      const body = (await req.json()) as { id?: string };
      id = body.id || null;
    } catch {}
  }
  if (!id) return NextResponse.json({ error: "Missing model id" }, { status: 400 });

  const result = await stageLegacyModelPoolCatalogState({
    actorId: admin.userId,
    table: "video_models",
    id,
    catalogState: "retired",
    changeNote: `退役视频模型 ${id}`,
  });
  return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
}
