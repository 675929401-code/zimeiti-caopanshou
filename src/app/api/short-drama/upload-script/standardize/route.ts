import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { requireShortDramaPaidRequestId } from "@/lib/short-drama/paid-request-idempotency";
import { assertShortDramaReadyForPaidModelCall } from "@/lib/short-drama/readiness";
import { selectShortDramaTextModel } from "@/lib/short-drama/text-model-selection";
import {
  extractJsonText,
  StandardizedScriptSchema,
  UploadScriptError,
} from "@/lib/short-drama/upload-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  title: z.string().trim().max(120).default(""),
  genre: z.enum(["drama", "short", "formal"]),
  text: z.string().trim().min(1).max(100_000),
}).strict();

const GENRE_LABEL_BY_VALUE = {
  drama: "爽剧",
  short: "短剧",
  formal: "正剧",
} as const satisfies Record<z.infer<typeof RequestSchema>["genre"], string>;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text) as unknown; } catch { return { error: text.slice(0, 500) }; }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const value = payload as Record<string, unknown>;
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim();
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return fallback;
}

function upstreamCode(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "";
  const code = (payload as Record<string, unknown>).code;
  return typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code) ? code : "";
}

export async function POST(request: NextRequest) {
  try {
    await authorizeShortDramaRequest(request);
    const input = RequestSchema.parse(await request.json());
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
    }

    await assertShortDramaReadyForPaidModelCall();
    const clientRequestId = requireShortDramaPaidRequestId(request);
    const selectedModel = await selectShortDramaTextModel();
    const systemPrompt = [
      "你是影视剧本格式标准化编辑。只整理用户已有内容的格式，绝对禁止补写剧情、对白、人物、结局或场景。",
      "规范场景标注、动作描述、对白标签、段落和分集标题；原文含义、事件顺序和全部信息必须保留。",
      "识别分集；没有明确分集时作为第1集。输出合法 JSON，不要 Markdown。",
      "JSON 字段：title、standardizedText、episodes、quality、issues、suggestions。episodes 每项为 episodeNumber、title、content。",
      "quality 必须含 sceneLabels、actionDescriptions、dialogueFormat、videoReadiness 四个 0-100 整数。issues 和 suggestions 为短字符串数组。",
    ].join("\n");

    const upstream = await fetch(new URL("/api/llm", request.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
        "Idempotency-Key": clientRequestId,
      },
      body: JSON.stringify({
        system_prompt: systemPrompt,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: JSON.stringify({
              filename: input.filename,
              requestedTitle: input.title || null,
              genre: GENRE_LABEL_BY_VALUE[input.genre],
              originalText: input.text,
            }),
          },
        ],
        stream: false,
        response_format: "json_object",
        temperature: 0.1,
        max_reply_tokens: 65_536,
        timeout: 300,
        agentName: "剧本格式标准化",
        modelId: selectedModel.id,
        model_overridden: true,
        client_request_id: clientRequestId,
      }),
      cache: "no-store",
      signal: request.signal,
    });
    const upstreamPayload = await readJson(upstream);
    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: upstreamCode(upstreamPayload) || "LLM_UPSTREAM_FAILED",
          error: errorMessage(upstreamPayload, "主站文案模型暂时不可用"),
        },
        { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 },
      );
    }
    const result = StandardizedScriptSchema.parse(extractJsonText(upstreamPayload));
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    if (error instanceof UploadScriptError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, code: "INVALID_STANDARDIZE_RESULT", error: "剧本标准化输入或结果格式不正确" }, { status: 400 });
    }
    const status = Number((error as { status?: unknown } | null)?.status || 500);
    const code = String((error as { code?: unknown } | null)?.code || "STANDARDIZE_FAILED");
    const message = error instanceof Error ? error.message : "剧本标准化失败";
    return NextResponse.json({ ok: false, code, error: message }, { status });
  }
}
