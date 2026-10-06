import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DRAMA_SCRIPT_PROFILE_ID,
  GENERAL_SCRIPT_PROFILE_VERSION,
} from "@/lib/short-drama/general-script-contract";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import { requireShortDramaPaidRequestId } from "@/lib/short-drama/paid-request-idempotency";
import { assertShortDramaReadyForPaidModelCall } from "@/lib/short-drama/readiness";
import {
  classifyUpstreamDramaFailure,
  describePublicDramaFailure,
  type PublicDramaFailure,
} from "@/lib/short-drama/public-drama-errors";
import { selectShortDramaTextModel } from "@/lib/short-drama/text-model-selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InputSchema = z.object({
  theme: z.enum(["relationship", "power", "advantage", "revenge"]),
  storyType: z.enum(["auto", "male", "female"]),
  tone: z.enum(["爽文", "甜宠", "虐心", "悬疑"]),
  animationStyle: z.string().trim().min(1).max(120).default("电影级光影，高对比度，浅景深，自然光影"),
  batchEpisodeCount: z.number().int().min(1).max(10),
  totalEpisodeCount: z.number().int().min(1).max(500).nullable(),
  brief: z.string().trim().min(20).max(100_000),
  videoSize: z.literal("9:16"),
}).strict();

const RequestSchema = z.object({
  operation: z.enum(["generate", "optimize"]),
  profileId: z.literal(DRAMA_SCRIPT_PROFILE_ID),
  clientRequestId: z.string().trim().min(8).max(128),
  modelId: z.string().trim().regex(/^pm_[A-Za-z0-9_-]{16,120}$/u).optional(),
  input: InputSchema,
}).strict();

const THEME_LABELS = {
  relationship: "两性主题",
  power: "暴力主题",
  advantage: "优势主题",
  revenge: "复仇主题",
} as const;

const STORY_TYPE_LABELS = { auto: "自动", male: "男频", female: "女频" } as const;
const TONE_MAP = {
  "爽文": "inspiring",
  "甜宠": "warm",
  "虐心": "emotional",
  "悬疑": "suspense",
} as const;

function json(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text) as unknown; } catch { return { error: text.slice(0, 500) }; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicFailurePayload(failure: PublicDramaFailure) {
  return {
    ok: false,
    code: failure.code,
    error: failure.message,
    title: failure.title,
    guidance: failure.guidance,
    retryable: failure.retryable,
  };
}

function throwPublicFailure(failure: PublicDramaFailure): never {
  throw Object.assign(new Error(failure.message), { publicFailure: failure });
}

function publicFailureFromError(error: unknown): PublicDramaFailure {
  if (error && typeof error === "object") {
    const carrier = error as { publicFailure?: unknown; status?: unknown; code?: unknown };
    if (
      carrier.publicFailure
      && typeof carrier.publicFailure === "object"
      && typeof (carrier.publicFailure as PublicDramaFailure).code === "string"
    ) {
      return carrier.publicFailure as PublicDramaFailure;
    }
    const status = Number(carrier.status || 500);
    const code = typeof carrier.code === "string" ? carrier.code : "DRAMA_SCRIPT_FAILED";
    return describePublicDramaFailure(status, code);
  }
  return describePublicDramaFailure(500);
}

function extractText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.output_text === "string") return value.output_text.trim();
  if (typeof value.content === "string") return value.content.trim();
  if (Array.isArray(value.content)) {
    const joined = value.content.map((item) => (
      isRecord(item) && typeof item.text === "string" ? item.text : ""
    )).join("").trim();
    if (joined) return joined;
  }
  if (Array.isArray(value.choices) && value.choices.length > 0) {
    const choice = value.choices[0];
    if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string") {
      return choice.message.content.trim();
    }
  }
  if (isRecord(value.data)) return extractText(value.data);
  return "";
}

async function callMainLlm(
  request: NextRequest,
  authorization: string,
  clientRequestId: string,
  modelId: string,
  body: Record<string, unknown>,
) {
  const selectedModel = await selectShortDramaTextModel(modelId);
  const response = await fetch(new URL("/api/llm", request.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "Idempotency-Key": clientRequestId,
    },
    body: JSON.stringify({
      ...body,
      modelId: selectedModel.id,
      model_overridden: true,
      client_request_id: clientRequestId,
    }),
    cache: "no-store",
    signal: request.signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throwPublicFailure(classifyUpstreamDramaFailure(response.status, payload));
  }
  return payload;
}

async function optimizeBrief(
  request: NextRequest,
  authorization: string,
  clientRequestId: string,
  modelId: string,
  input: z.infer<typeof InputSchema>,
) {
  const systemPrompt = [
    "你是爽剧创作需求编辑，只补全和结构化用户已有意图，不写完整剧本。",
    "输出包含主角设定、主要人物、故事框架、核心冲突与爽点、关键场景、风格基调、特殊要求的纯文本。",
    "必须保留用户明确的人物、事件、结局和禁改项；不要给多个方案，不要输出 Markdown 代码围栏。",
  ].join("\n");
  const payload = await callMainLlm(request, authorization, clientRequestId, modelId, {
    system_prompt: systemPrompt,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: JSON.stringify({
          theme: THEME_LABELS[input.theme],
          storyType: STORY_TYPE_LABELS[input.storyType],
          tone: input.tone,
          animationStyle: input.animationStyle,
          episodesToGenerate: input.batchEpisodeCount,
          totalEpisodes: input.totalEpisodeCount,
          brief: input.brief,
        }),
      },
    ],
    stream: false,
    temperature: 0.4,
    max_reply_tokens: 8_192,
    timeout: 120,
    agentName: "爽剧需求优化",
  });
  const optimizedBrief = extractText(payload);
  if (!optimizedBrief) {
    throwPublicFailure(describePublicDramaFailure(502, "DRAMA_EMPTY_MODEL_RESULT"));
  }
  return optimizedBrief;
}

export async function POST(request: NextRequest) {
  try {
    await authorizeShortDramaRequest(request);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      const failure = describePublicDramaFailure(401, "UNAUTHORIZED");
      return json(failure.status, publicFailurePayload(failure));
    }
    const task = RequestSchema.parse(await request.json());
    await assertShortDramaReadyForPaidModelCall();
    const clientRequestId = requireShortDramaPaidRequestId(request, task.clientRequestId);

    if (task.operation === "optimize") {
      const optimizedBrief = await optimizeBrief(
        request,
        authorization,
        clientRequestId,
        task.modelId || "",
        task.input,
      );
      return json(200, { ok: true, operation: "optimize", optimizedBrief });
    }

    const genre = [
      THEME_LABELS[task.input.theme],
      STORY_TYPE_LABELS[task.input.storyType],
      task.input.tone,
    ].join(" · ");
    const scriptResponse = await fetch(new URL("/api/short-drama/script", request.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
        "Idempotency-Key": clientRequestId,
        ...(task.modelId ? { "X-Short-Drama-Model-Id": task.modelId } : {}),
      },
      body: JSON.stringify({
        profile: { id: DRAMA_SCRIPT_PROFILE_ID, version: GENERAL_SCRIPT_PROFILE_VERSION },
        operation: "generate",
        settings: {
          creationMode: "original",
          targetAudience: "adult",
          tone: TONE_MAP[task.input.tone],
          customTone: "",
          genre,
          animationStyle: task.input.animationStyle,
          videoSize: task.input.videoSize,
          episodesToGenerate: task.input.batchEpisodeCount,
          totalEpisodes: task.input.totalEpisodeCount,
          isFinale: task.input.totalEpisodeCount !== null
            && task.input.batchEpisodeCount >= task.input.totalEpisodeCount,
        },
        content: {
          title: "",
          brief: task.input.brief,
          sourceMaterial: "",
          requirements: `主题=${THEME_LABELS[task.input.theme]}；频向=${STORY_TYPE_LABELS[task.input.storyType]}；基调=${task.input.tone}；竖屏9:16。`,
        },
        rewriteEpisodeNumbers: [],
        rewriteInstruction: "",
      }),
      cache: "no-store",
      signal: request.signal,
    });
    const scriptPayload = await readJson(scriptResponse);
    if (!scriptResponse.ok || !isRecord(scriptPayload) || scriptPayload.ok !== true || !isRecord(scriptPayload.result)) {
      const failure = scriptResponse.ok
        ? describePublicDramaFailure(502, "DRAMA_SCRIPT_GENERATION_FAILED")
        : classifyUpstreamDramaFailure(scriptResponse.status, scriptPayload);
      return json(failure.status, publicFailurePayload(failure));
    }

    const summary = isRecord(scriptPayload.result.summary) ? scriptPayload.result.summary : {};
    const title = typeof summary.title === "string" && summary.title.trim()
      ? summary.title.trim().slice(0, 120)
      : `爽剧项目-${new Date().toISOString().slice(0, 10)}`;
    const importResponse = await fetch(new URL("/api/short-drama/projects/import-script", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({
        clientRequestId,
        title,
        result: scriptPayload.result,
      }),
      cache: "no-store",
      signal: request.signal,
    });
    const importPayload = await readJson(importResponse);
    if (!importResponse.ok || !isRecord(importPayload)) {
      const failure = describePublicDramaFailure(
        importResponse.ok ? 502 : importResponse.status,
        "DRAMA_PROJECT_IMPORT_FAILED",
      );
      return json(failure.status, publicFailurePayload(failure));
    }
    return json(200, {
      ok: true,
      operation: "generate",
      result: scriptPayload.result,
      project: importPayload.project,
      href: importPayload.href,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const failure = describePublicDramaFailure(400, "INVALID_DRAMA_SCRIPT_REQUEST");
      return json(failure.status, publicFailurePayload(failure));
    }
    const failure = publicFailureFromError(error);
    return json(failure.status, publicFailurePayload(failure));
  }
}
