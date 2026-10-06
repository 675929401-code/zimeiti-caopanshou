import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ImagePromptInput = z.object({
  theme: z.string().trim().min(4).max(4_000),
  style: z.string().trim().min(1).max(120),
  detail: z.enum(["concise", "standard", "detailed"]),
  targetModel: z.string().trim().min(1).max(120),
}).strict();

const MusicPlanInput = z.object({
  title: z.string().trim().max(120),
  brief: z.string().trim().min(4).max(4_000),
  lyrics: z.string().trim().max(12_000),
  style: z.string().trim().min(1).max(500),
  instrumental: z.boolean(),
}).strict();

const RequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("image-prompt"), input: ImagePromptInput }).strict(),
  z.object({ operation: z.literal("music-plan"), input: MusicPlanInput }).strict(),
]);

function json(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function message(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim();
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return fallback;
}

function extractText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.output_text === "string") return value.output_text.trim();
  if (typeof value.content === "string") return value.content.trim();
  if (Array.isArray(value.choices) && value.choices.length > 0) {
    const choice = value.choices[0];
    if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string") {
      return choice.message.content.trim();
    }
  }
  if (isRecord(value.data)) return extractText(value.data);
  return "";
}

function parseModelJson(text: string): Record<string, unknown> {
  const normalized = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return isRecord(parsed) ? parsed : { text: normalized };
  } catch {
    return { text: normalized };
  }
}

async function callMainLlm(
  request: NextRequest,
  authorization: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  agentName: string,
) {
  const response = await fetch(new URL("/api/llm", request.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({
      messages,
      stream: false,
      temperature: 0.35,
      max_reply_tokens: 8_192,
      timeout: 120,
      agentName,
    }),
    cache: "no-store",
    signal: request.signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw Object.assign(new Error(message(payload, "主站文案模型暂时不可用")), {
      status: response.status,
    });
  }
  const text = extractText(payload);
  if (!text) throw Object.assign(new Error("模型没有返回有效内容"), { status: 502 });
  return parseModelJson(text);
}

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return json(401, { ok: false, code: "UNAUTHORIZED", error: "请先登录主站" });
    }

    const task = RequestSchema.parse(await request.json());
    if (task.operation === "image-prompt") {
      const result = await callMainLlm(
        request,
        authorization,
        [
          {
            role: "system",
            content: [
              "你是商业级生图提示词编辑。只根据用户已给信息补全可执行的视觉描述，不改变其主题。",
              "输出严格 JSON，不使用代码围栏：{\"title\":\"\",\"promptZh\":\"\",\"promptEn\":\"\",\"negativePrompt\":\"\",\"suggestedRatio\":\"\"}。",
              "promptZh 按主体、行为、环境、风格、光线、镜头与构图组织；不得加入水印、品牌或不存在的人物。",
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(task.input) },
        ],
        "图片提示词生成",
      );
      return json(200, { ok: true, operation: task.operation, result });
    }

    const result = await callMainLlm(
      request,
      authorization,
      [
        {
          role: "system",
          content: [
            "你是音乐项目前期策划和歌词编辑。你只输出制作方案，不声称已经生成音频。",
            "输出严格 JSON，不使用代码围栏：{\"title\":\"\",\"lyrics\":\"\",\"stylePrompt\":\"\",\"arrangement\":\"\",\"vocalDirection\":\"\"}。",
            "歌词使用 [Intro] [Verse] [Pre Chorus] [Chorus] [Bridge] [Outro] 等结构标签；纯音乐模式则 lyrics 置空。",
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify(task.input) },
      ],
      "音乐歌词与编曲方案",
    );
    return json(200, { ok: true, operation: task.operation, result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json(400, { ok: false, code: "INVALID_REQUEST", error: "提交内容不完整或超出长度限制" });
    }
    const status = Number((error as { status?: unknown } | null)?.status || 500);
    return json(status >= 400 && status < 600 ? status : 500, {
      ok: false,
      code: "CREATIVE_PLAN_FAILED",
      error: error instanceof Error ? error.message : "创作方案生成失败",
    });
  }
}
