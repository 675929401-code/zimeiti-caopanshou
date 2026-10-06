import {
  GeneralScriptContractError,
  parseGeneralScriptResult,
  type GeneralScriptRequest,
  type GeneralScriptResult,
} from "./general-script-contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentPartToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  return "";
}

function extractText(payload: unknown): string {
  if (!isRecord(payload)) return "";

  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.content === "string") return payload.content;

  if (Array.isArray(payload.content)) {
    const combined = payload.content.map(contentPartToText).filter(Boolean).join("");
    if (combined) return combined;
  }

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const choice = payload.choices[0];
    if (isRecord(choice)) {
      const message = choice.message;
      if (isRecord(message)) {
        if (typeof message.content === "string") return message.content;
        if (Array.isArray(message.content)) {
          const combined = message.content.map(contentPartToText).filter(Boolean).join("");
          if (combined) return combined;
        }
      }
      if (typeof choice.text === "string") return choice.text;
    }
  }

  if (isRecord(payload.data)) return extractText(payload.data);
  if (isRecord(payload.result)) return JSON.stringify(payload.result);
  return "";
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new GeneralScriptContractError("模型没有返回剧本内容");
  }

  const withoutFence = trimmed
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const firstBrace = withoutFence.indexOf("{");
    const lastBrace = withoutFence.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as unknown;
      } catch {
        // Fall through to the stable contract error below.
      }
    }
  }

  throw new GeneralScriptContractError("模型返回的内容不是有效 JSON");
}

export function parseGeneralScriptLlmPayload(payload: unknown): GeneralScriptResult {
  if (isRecord(payload) && payload.schemaVersion === "general-script-result.v1") {
    return parseGeneralScriptResult(payload);
  }
  const text = extractText(payload);
  return parseGeneralScriptResult(parseJsonText(text));
}

/** Bind form-owned metadata after structural parsing; never synthesize story assets. */
export function bindGeneralScriptRequestSettings(
  request: GeneralScriptRequest,
  result: GeneralScriptResult,
): GeneralScriptResult {
  return {
    ...result,
    summary: {
      ...result.summary,
      creationMode: request.settings.creationMode,
      targetAudience: request.settings.targetAudience,
      animationStyle: request.settings.animationStyle,
      videoSize: request.settings.videoSize,
      genre: request.settings.genre,
      totalEpisodes: request.settings.totalEpisodes,
      isFinale: request.settings.isFinale,
    },
  };
}

export function extractUpstreamError(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message.trim() || fallback;
  }
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  return fallback;
}
