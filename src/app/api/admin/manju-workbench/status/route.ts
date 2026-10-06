import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  summarizeManjuAudioModels,
  summarizeManjuImageModels,
  summarizeManjuTextModels,
  summarizeManjuVideoModels,
  unavailableManjuFamily,
  type ManjuAudioModelRow,
  type ManjuImageModelRow,
  type ManjuTextModelRow,
  type ManjuVideoModelRow,
} from "@/lib/manju-workbench-status";
import { queryAll } from "@/lib/voice-studio/db";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TableLoad<T> = { rows: T[]; error: string };

async function loadSupabaseTable<T>(table: string, columns: string): Promise<TableLoad<T>> {
  try {
    const client = getSupabaseClient();
    const result = await client.from(table).select(columns);
    if (result.error || !Array.isArray(result.data)) {
      return { rows: [], error: `${table} 暂时无法读取` };
    }
    return { rows: result.data as T[], error: "" };
  } catch {
    return { rows: [], error: `${table} 暂时无法读取` };
  }
}

function loadAudioModels(): TableLoad<ManjuAudioModelRow> {
  try {
    return {
      rows: queryAll<ManjuAudioModelRow>(
        "SELECT id, name, modelId, resourceId, apiKey, isActive FROM ModelConfig ORDER BY sort ASC",
      ),
      error: "",
    };
  } catch {
    return { rows: [], error: "智音工坊 ModelConfig 暂时无法读取" };
  }
}

export async function GET(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const [textResult, imageResult, videoResult] = await Promise.all([
    loadSupabaseTable<ManjuTextModelRow>(
      "llm_models",
      "id,name,model_name,api_endpoint,proxy_url,api_key,is_active,is_hidden,user_access",
    ),
    loadSupabaseTable<ManjuImageModelRow>(
      "cover_models",
      "id,name,model_name,api_endpoint,api_key,is_active,is_hidden",
    ),
    loadSupabaseTable<ManjuVideoModelRow>(
      "video_models",
      "id,name,model_name,provider,protocol_type,api_endpoint,api_key,api_protocol_config,is_active,is_hidden",
    ),
  ]);
  const audioResult = loadAudioModels();

  const globalLlmEndpointConfigured = Boolean(
    process.env.LLM_API_BASE_URL?.trim() || process.env.LLM_API_BASE?.trim(),
  );
  const globalLlmCredentialConfigured = Boolean(process.env.LLM_API_KEY?.trim());
  const globalAudioCredentialConfigured = Boolean(process.env.VOLCENGINE_API_KEY_1?.trim());

  const families = [
    textResult.error
      ? unavailableManjuFamily("text", "文案模型", "llm_models", textResult.error)
      : summarizeManjuTextModels(textResult.rows, {
          globalEndpointConfigured: globalLlmEndpointConfigured,
          globalCredentialConfigured: globalLlmCredentialConfigured,
        }),
    imageResult.error
      ? unavailableManjuFamily("image", "生图模型", "cover_models", imageResult.error)
      : summarizeManjuImageModels(imageResult.rows, {
          globalEndpointConfigured: globalLlmEndpointConfigured,
          globalCredentialConfigured: globalLlmCredentialConfigured,
        }),
    videoResult.error
      ? unavailableManjuFamily("video", "视频模型", "video_models", videoResult.error)
      : summarizeManjuVideoModels(videoResult.rows),
    audioResult.error
      ? unavailableManjuFamily("audio", "音频/配音模型", "voice-platform.ModelConfig", audioResult.error)
      : summarizeManjuAudioModels(audioResult.rows, {
          globalCredentialConfigured: globalAudioCredentialConfigured,
        }),
  ];

  return NextResponse.json({
    application: {
      id: "manju-workbench",
      name: "漫剧工作台",
      publicRoute: "/youcai",
      accountMode: "shared-main-account",
      billingMode: "shared-main-credits",
      assetMode: "shared-main-media-and-storage",
      modelPolicy: "shared-pools-no-branch-allowlist",
    },
    truthBoundary: {
      configuredMeans: "只表示数据库或受保护环境中存在可解析的绑定",
      availableMeans: "表示当前记录处于启用且非隐藏状态",
      verifiedMeans: "只有服务端保存并复核 canary、结果持久化等证据后才算已验收",
      limitation: "当前没有漫剧工作台专属模型白名单；页面读取主站统一模型池，不能把共享池状态表述为分支已独立配置完成。",
    },
    families,
    generatedAt: new Date().toISOString(),
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
