import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";

export const UPLOAD_SCRIPT_MAX_BYTES = 1024 * 1024;
export const UPLOAD_SCRIPT_MAX_CHARS = 100_000;
export const UPLOAD_SCRIPT_EXTENSIONS = ["txt", "md", "docx"] as const;

export const StandardizedEpisodeSchema = z.object({
  episodeNumber: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(100_000),
});

export const StandardizedScriptSchema = z.object({
  title: z.string().trim().min(1).max(120),
  standardizedText: z.string().trim().min(1).max(100_000),
  episodes: z.array(StandardizedEpisodeSchema).min(1).max(500),
  quality: z.object({
    sceneLabels: z.number().int().min(0).max(100),
    actionDescriptions: z.number().int().min(0).max(100),
    dialogueFormat: z.number().int().min(0).max(100),
    videoReadiness: z.number().int().min(0).max(100),
  }),
  issues: z.array(z.string().trim().min(1).max(500)).max(20),
  suggestions: z.array(z.string().trim().min(1).max(500)).max(20),
});

export type StandardizedScript = z.infer<typeof StandardizedScriptSchema>;

export class UploadScriptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UploadScriptError";
  }
}

function extensionOf(filename: string): string {
  return filename.toLowerCase().split(".").pop() || "";
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractDocxText(bytes: Uint8Array): string {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new UploadScriptError("DOCX_INVALID", "DOCX 文件损坏或不是有效的 Office 文档");
  }
  const documentXml = archive["word/document.xml"];
  if (!documentXml) {
    throw new UploadScriptError("DOCX_DOCUMENT_MISSING", "DOCX 中未找到正文内容");
  }
  const xml = strFromU8(documentXml);
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/gi, "\t")
      .replace(/<w:br\b[^>]*\/>/gi, "\n")
      .replace(/<\/w:p>/gi, "\n")
      .replace(/<\/w:tr>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

function decodePlainText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const replacementRatio = (utf8.match(/�/g)?.length || 0) / Math.max(utf8.length, 1);
  if (replacementRatio < 0.005) return utf8.replace(/^\uFEFF/, "");
  try {
    return new TextDecoder("gb18030").decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return utf8.replace(/^\uFEFF/, "");
  }
}

export function normalizeUploadedScriptText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function parseUploadedScriptFile(input: {
  filename: string;
  bytes: Uint8Array;
}): { filename: string; extension: (typeof UPLOAD_SCRIPT_EXTENSIONS)[number]; text: string; chars: number } {
  if (!input.filename.trim()) {
    throw new UploadScriptError("FILENAME_REQUIRED", "文件名不能为空");
  }
  if (input.bytes.byteLength === 0) {
    throw new UploadScriptError("FILE_EMPTY", "剧本文件不能为空");
  }
  if (input.bytes.byteLength > UPLOAD_SCRIPT_MAX_BYTES) {
    throw new UploadScriptError("FILE_TOO_LARGE", "文件不能超过 1MB");
  }
  const extension = extensionOf(input.filename);
  if (!UPLOAD_SCRIPT_EXTENSIONS.includes(extension as (typeof UPLOAD_SCRIPT_EXTENSIONS)[number])) {
    throw new UploadScriptError("FILE_TYPE_UNSUPPORTED", "仅支持 TXT、MD、DOCX 文件");
  }
  const text = normalizeUploadedScriptText(
    extension === "docx" ? extractDocxText(input.bytes) : decodePlainText(input.bytes),
  );
  if (!text) {
    throw new UploadScriptError("SCRIPT_EMPTY", "没有从文件中读取到剧本正文");
  }
  if (text.length > UPLOAD_SCRIPT_MAX_CHARS) {
    throw new UploadScriptError("SCRIPT_TOO_LONG", "剧本正文不能超过 10 万字");
  }
  return {
    filename: input.filename,
    extension: extension as (typeof UPLOAD_SCRIPT_EXTENSIONS)[number],
    text,
    chars: text.length,
  };
}

export function extractJsonText(payload: unknown): unknown {
  const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
  const findText = (value: unknown): string => {
    if (!isRecord(value)) return "";
    if (typeof value.output_text === "string") return value.output_text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) {
      const joined = value.content.map((part) => (
        isRecord(part) && typeof part.text === "string" ? part.text : ""
      )).join("");
      if (joined) return joined;
    }
    if (Array.isArray(value.choices) && value.choices.length > 0) {
      const choice = value.choices[0];
      if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string") {
        return choice.message.content;
      }
    }
    if (isRecord(value.data)) return findText(value.data);
    if (isRecord(value.result)) return JSON.stringify(value.result);
    return "";
  };
  const text = findText(payload).trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!text) throw new UploadScriptError("MODEL_EMPTY", "模型没有返回标准化结果", 502);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        // Use stable error below.
      }
    }
  }
  throw new UploadScriptError("MODEL_JSON_INVALID", "模型返回的标准化结果不是有效 JSON", 502);
}
