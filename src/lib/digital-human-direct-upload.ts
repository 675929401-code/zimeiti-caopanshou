import 'server-only';

import { createHash } from 'node:crypto';

import { validateUploadBuffer, type ValidatedUpload } from '@/lib/file-upload-security';

export type DigitalHumanUploadCategory = 'image' | 'audio' | 'video';

export const DIGITAL_HUMAN_UPLOAD_LIMITS: Record<DigitalHumanUploadCategory, number> = {
  image: 10 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};
export const DIGITAL_HUMAN_UPLOAD_TICKET_TTL_SECONDS = 10 * 60;
export const DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS = 5 * 60;
export const DIGITAL_HUMAN_PENDING_SOURCE = 'digital-human-upload-pending';
export const DIGITAL_HUMAN_FINAL_SOURCE = 'digital-human-input';
export const DIGITAL_HUMAN_MAX_PENDING_PER_USER = 3;
export const DIGITAL_HUMAN_MAGIC_BYTES = 64 * 1024;

const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/u;
const SUPPORTED: Record<DigitalHumanUploadCategory, ReadonlySet<string>> = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']),
  audio: new Set(['audio/mpeg', 'audio/wav', 'audio/aac']),
  video: new Set(['video/mp4', 'video/quicktime', 'video/x-msvideo']),
};

export class DigitalHumanUploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'DigitalHumanUploadError';
  }
}

export type UploadTicketInput = {
  requestId: string;
  category: DigitalHumanUploadCategory;
  size: number;
  contentType: string;
  originalName: string;
  prefix: Buffer;
  detected: ValidatedUpload;
};

export type UploadTicketRecord = {
  id: string;
  user_id: string;
  storage_key: string;
  storage_provider: string;
  file_name: string;
  file_category: string;
  file_size: number | string;
  content_type: string;
  source: string | null;
  meta: Record<string, unknown> | null;
  is_public: boolean;
  created_at: string;
};

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeMime(value: unknown) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function decodePrefix(value: unknown) {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length > Math.ceil(DIGITAL_HUMAN_MAGIC_BYTES / 3) * 4 + 8
      || !/^[a-zA-Z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new DigitalHumanUploadError('无法验证文件内容，请重新选择素材', 'UPLOAD_PREFIX_INVALID', 400);
  }
  const prefix = Buffer.from(encoded, 'base64');
  if (prefix.length < 12 || prefix.length > DIGITAL_HUMAN_MAGIC_BYTES) {
    throw new DigitalHumanUploadError('无法验证文件内容，请重新选择素材', 'UPLOAD_PREFIX_INVALID', 400);
  }
  return prefix;
}

function cleanOriginalName(value: unknown) {
  const name = String(value || 'upload').replace(/[\\/\u0000-\u001f]/gu, '_').trim();
  return (name || 'upload').slice(0, 180);
}

export function parseDigitalHumanUploadTicketInput(body: Record<string, unknown>): UploadTicketInput {
  const requestId = String(body.requestId || '').trim();
  if (!REQUEST_ID.test(requestId)) {
    throw new DigitalHumanUploadError('上传请求编号无效，请重新选择素材', 'UPLOAD_REQUEST_ID_INVALID', 400);
  }
  const category = String(body.category || '') as DigitalHumanUploadCategory;
  if (!Object.prototype.hasOwnProperty.call(DIGITAL_HUMAN_UPLOAD_LIMITS, category)) {
    throw new DigitalHumanUploadError('素材类型无效', 'UPLOAD_CATEGORY_INVALID', 400);
  }
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > DIGITAL_HUMAN_UPLOAD_LIMITS[category]) {
    throw new DigitalHumanUploadError('文件大小超出当前素材类型限制', 'UPLOAD_SIZE_INVALID', 413);
  }
  const contentType = normalizeMime(body.contentType);
  const prefix = decodePrefix(body.prefixBase64);
  let detected: ValidatedUpload;
  try {
    detected = validateUploadBuffer(prefix, contentType);
  } catch {
    throw new DigitalHumanUploadError('文件内容与格式不匹配，请重新选择素材', 'UPLOAD_SIGNATURE_INVALID', 415);
  }
  if (!SUPPORTED[category].has(detected.contentType)) {
    throw new DigitalHumanUploadError('文件格式与所选素材类型不匹配', 'UPLOAD_CATEGORY_MISMATCH', 415);
  }
  return {
    requestId,
    category,
    size,
    contentType: detected.contentType,
    originalName: cleanOriginalName(body.originalName),
    prefix,
    detected,
  };
}

export function digitalHumanUploadTicketId(userId: string, requestId: string) {
  const value = digest(`digital-human-upload-ticket:v1\0${userId}\0${requestId}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function digitalHumanUploadObjectKey(
  userId: string,
  requestId: string,
  category: DigitalHumanUploadCategory,
  extension: string,
) {
  const owner = digest(`digital-human-upload-owner:v1\0${userId}`).slice(0, 24);
  const request = digest(`digital-human-upload-object:v1\0${userId}\0${requestId}`).slice(0, 32);
  return `digital-human-inputs/staging/${owner}/${category}/${request}${extension}`;
}

export function digitalHumanUploadRequestHash(requestId: string) {
  return digest(`digital-human-upload-request:v1\0${requestId}`);
}

export function digitalHumanUploadMeta(input: UploadTicketInput, expiresAt: string) {
  return {
    uploadState: 'pending',
    uploadRequestHash: digitalHumanUploadRequestHash(input.requestId),
    uploadExpiresAt: expiresAt,
    declaredSize: String(input.size),
    declaredContentType: input.contentType,
    prefixSha256: createHash('sha256').update(input.prefix).digest('hex'),
    originalName: input.originalName,
  };
}

export function assertDigitalHumanUploadRecord(
  record: UploadTicketRecord,
  userId: string,
  input: Pick<UploadTicketInput, 'requestId' | 'category' | 'size' | 'contentType'> & { prefix?: Buffer },
) {
  const expectedTicket = digitalHumanUploadTicketId(userId, input.requestId);
  const expectedRequestHash = digitalHumanUploadRequestHash(input.requestId);
  if (record.id !== expectedTicket || record.user_id !== userId
      || record.file_category !== input.category || Number(record.file_size) !== input.size
      || normalizeMime(record.content_type) !== input.contentType
      || String(record.meta?.uploadRequestHash || '') !== expectedRequestHash
      || (input.prefix && String(record.meta?.prefixSha256 || '') !== createHash('sha256').update(input.prefix).digest('hex'))) {
    throw new DigitalHumanUploadError('同一上传请求的文件信息不一致，请重新选择素材', 'UPLOAD_REQUEST_CONFLICT', 409);
  }
}

export function uploadTicketExpired(record: UploadTicketRecord, graceSeconds = 0) {
  const expiresAt = Date.parse(String(record.meta?.uploadExpiresAt || ''));
  return !Number.isFinite(expiresAt) || Date.now() > expiresAt + graceSeconds * 1000;
}

export function normalizeUploadContentType(value: unknown) {
  return normalizeMime(value);
}
