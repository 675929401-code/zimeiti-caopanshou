import { randomUUID } from "node:crypto";

const ACTIVE_MIME_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "text/xml",
  "application/xml",
  "application/javascript",
  "text/javascript",
  "application/typescript",
  "text/typescript",
]);

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/aac", "audio/webm", "audio/flac", "audio/x-flac",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv", "text/markdown", "application/json",
  "application/zip", "application/x-rar-compressed", "application/gzip", "application/x-tar",
]);

const TEXT_MIME_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);
const ZIP_MIME_TYPES = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export class UploadValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export interface ValidatedUpload {
  contentType: string;
  extension: string;
}

function startsWithBytes(buffer: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString("ascii");
}

function detectBinaryType(buffer: Buffer): ValidatedUpload | null {
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", extension: ".png" };
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extension: ".jpg" };
  if (["GIF87a", "GIF89a"].includes(ascii(buffer, 0, 6))) return { contentType: "image/gif", extension: ".gif" };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") return { contentType: "image/webp", extension: ".webp" };
  if (ascii(buffer, 0, 2) === "BM") return { contentType: "image/bmp", extension: ".bmp" };
  if (ascii(buffer, 0, 4) === "%PDF") return { contentType: "application/pdf", extension: ".pdf" };
  if (ascii(buffer, 0, 4) === "PK\u0003\u0004") return { contentType: "application/zip", extension: ".zip" };
  if (startsWithBytes(buffer, [0x1f, 0x8b])) return { contentType: "application/gzip", extension: ".gz" };
  if (ascii(buffer, 0, 4) === "Rar!") return { contentType: "application/x-rar-compressed", extension: ".rar" };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WAVE") return { contentType: "audio/wav", extension: ".wav" };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "AVI ") return { contentType: "video/x-msvideo", extension: ".avi" };
  if (ascii(buffer, 0, 4) === "OggS") return { contentType: "audio/ogg", extension: ".ogg" };
  if (ascii(buffer, 0, 4) === "fLaC") return { contentType: "audio/flac", extension: ".flac" };
  if (ascii(buffer, 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return { contentType: "audio/mpeg", extension: ".mp3" };
  if (buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9)) return { contentType: "audio/aac", extension: ".aac" };
  if (startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return { contentType: "video/webm", extension: ".webm" };
  if (ascii(buffer, 4, 4) === "ftyp") {
    const brand = ascii(buffer, 8, 4).toLowerCase();
    if (brand === "avif" || brand === "avis") return { contentType: "image/avif", extension: ".avif" };
    if (brand === "qt  ") return { contentType: "video/quicktime", extension: ".mov" };
    return { contentType: "video/mp4", extension: ".mp4" };
  }
  return null;
}

function assertNoActiveText(buffer: Buffer): void {
  const sample = buffer.subarray(0, 8192).toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (/^(?:<!doctype\s+html|<html\b|<svg\b|<\?xml\b|<script\b)/i.test(sample)
    || /<script\b|javascript\s*:|on(?:load|error|click)\s*=/i.test(sample)) {
    throw new UploadValidationError("不允许上传主动脚本或标记内容", "ACTIVE_CONTENT_FORBIDDEN");
  }
}

function typesCompatible(declared: string, detected: string): boolean {
  if (declared === detected) return true;
  if (ZIP_MIME_TYPES.has(declared) && detected === "application/zip") return true;
  if (declared === "video/x-matroska" && detected === "video/webm") return true;
  if (declared === "audio/webm" && detected === "video/webm") return true;
  if (declared === "audio/x-flac" && detected === "audio/flac") return true;
  return false;
}

function zipExtension(contentType: string): string {
  if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return ".docx";
  if (contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return ".xlsx";
  if (contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return ".pptx";
  return ".zip";
}

export function validateUploadBuffer(buffer: Buffer, declaredContentType: string): ValidatedUpload {
  const contentType = declaredContentType.split(";", 1)[0].trim().toLowerCase();
  if (!buffer.length) throw new UploadValidationError("文件为空", "EMPTY_FILE");
  if (ACTIVE_MIME_TYPES.has(contentType)) {
    throw new UploadValidationError("不允许上传主动脚本或标记内容", "ACTIVE_CONTENT_FORBIDDEN");
  }
  if (!ALLOWED_MIME_TYPES.has(contentType) || contentType === "application/octet-stream") {
    throw new UploadValidationError("不支持的文件类型", "UNSUPPORTED_FILE_TYPE");
  }

  assertNoActiveText(buffer);
  if (TEXT_MIME_TYPES.has(contentType)) {
    if (buffer.subarray(0, 8192).includes(0)) {
      throw new UploadValidationError("文本文件内容无效", "INVALID_TEXT_FILE");
    }
    if (contentType === "application/json") {
      try {
        JSON.parse(buffer.toString("utf8"));
      } catch {
        throw new UploadValidationError("JSON 文件内容无效", "INVALID_JSON_FILE");
      }
    }
    const extension = contentType === "text/csv" ? ".csv" : contentType === "text/markdown" ? ".md" : contentType === "application/json" ? ".json" : ".txt";
    return { contentType, extension };
  }

  const detected = detectBinaryType(buffer);
  if (!detected || !typesCompatible(contentType, detected.contentType)) {
    throw new UploadValidationError("文件内容与声明类型不匹配", "FILE_SIGNATURE_MISMATCH");
  }
  return { contentType, extension: ZIP_MIME_TYPES.has(contentType) ? zipExtension(contentType) : detected.extension };
}

export function safeUploadFileName(extension: string): string {
  const safeExtension = /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : "";
  return `${randomUUID()}${safeExtension}`;
}
