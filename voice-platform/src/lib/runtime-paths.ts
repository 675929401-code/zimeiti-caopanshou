import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveReferenceAudioDirectory(
  environment: RuntimeEnvironment = process.env,
  cwd = process.cwd(),
): string {
  const configured = environment.VOICE_REFERENCE_AUDIO_DIR?.trim();
  const production = environment.NODE_ENV === "production";
  if (production && (!configured || !path.isAbsolute(configured))) {
    throw new Error("VOICE_REFERENCE_AUDIO_DIR must be an absolute persistent path in production");
  }
  return path.resolve(configured || path.join(cwd, "public", "reference-audio"));
}

export function referenceAudioPublicUrl(filename: string): string {
  return `/voice-platform/reference-audio/${encodeURIComponent(filename)}`;
}

export const MAX_REFERENCE_AUDIO_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_REFERENCE_AUDIO_USER_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_REFERENCE_AUDIO_USER_FILES = 1_000;

const ALLOWED_REFERENCE_AUDIO_EXTENSIONS = new Set(['aac', 'm4a', 'mp3', 'mp4', 'ogg', 'opus', 'wav', 'webm']);

type ReferenceAudioMetadataEntry = {
  displayName?: string;
  ownerId?: string;
  mimeType?: string;
  size?: number;
  createdAt?: string;
};

type ReferenceAudioMetadata = Record<string, ReferenceAudioMetadataEntry>;

export type OwnedReferenceAudio = {
  filename: string;
  filepath: string;
  displayName: string;
  customName: boolean;
  mimeType: string;
  size: number;
  createdAt: string;
};

export class ReferenceAudioStorageError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'ReferenceAudioStorageError';
  }
}

function storageError(message: string, code: string, status: number): never {
  throw new ReferenceAudioStorageError(message, code, status);
}

function metadataFile(directory: string): string {
  return path.join(directory, '.meta.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMetadata(raw: string): ReferenceAudioMetadata {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) storageError('参考音频元数据格式无效', 'METADATA_INVALID', 500);
  const metadata: ReferenceAudioMetadata = {};
  for (const [filename, value] of Object.entries(parsed)) {
    validateReferenceAudioFilename(filename);
    if (!isPlainObject(value)) storageError('参考音频元数据条目无效', 'METADATA_INVALID', 500);
    const entry: ReferenceAudioMetadataEntry = {};
    if (value.displayName !== undefined) {
      if (typeof value.displayName !== 'string' || value.displayName.length > 50) storageError('参考音频显示名称无效', 'METADATA_INVALID', 500);
      entry.displayName = value.displayName;
    }
    if (value.ownerId !== undefined) {
      if (typeof value.ownerId !== 'string' || value.ownerId.length === 0 || value.ownerId.length > 128) storageError('参考音频所有者信息无效', 'METADATA_INVALID', 500);
      entry.ownerId = value.ownerId;
    }
    if (value.mimeType !== undefined) {
      if (typeof value.mimeType !== 'string' || !/^(?:audio|video)\/[a-z0-9.+-]+$/iu.test(value.mimeType)) storageError('参考音频 MIME 信息无效', 'METADATA_INVALID', 500);
      entry.mimeType = value.mimeType.toLowerCase();
    }
    if (value.size !== undefined) {
      if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) storageError('参考音频大小信息无效', 'METADATA_INVALID', 500);
      entry.size = value.size;
    }
    if (value.createdAt !== undefined) {
      if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) storageError('参考音频创建时间无效', 'METADATA_INVALID', 500);
      entry.createdAt = value.createdAt;
    }
    metadata[filename] = entry;
  }
  return metadata;
}

export function readReferenceAudioMetadata(directory = resolveReferenceAudioDirectory()): ReferenceAudioMetadata {
  const filepath = metadataFile(directory);
  if (!fs.existsSync(filepath)) return {};
  const stat = fs.lstatSync(filepath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) storageError('参考音频元数据文件不安全', 'METADATA_INVALID', 500);
  try {
    return parseMetadata(fs.readFileSync(filepath, 'utf8'));
  } catch (error) {
    if (error instanceof ReferenceAudioStorageError) throw error;
    storageError('参考音频元数据无法读取', 'METADATA_INVALID', 500);
  }
}

function writeReferenceAudioMetadata(metadata: ReferenceAudioMetadata, directory = resolveReferenceAudioDirectory()): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  const filepath = metadataFile(directory);
  const temporary = `${filepath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, filepath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function validateReferenceAudioFilename(filename: unknown): string {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 180) storageError('文件名无效', 'INVALID_FILENAME', 400);
  if (filename !== path.basename(filename) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/u.test(filename)) storageError('文件名无效', 'INVALID_FILENAME', 400);
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!ALLOWED_REFERENCE_AUDIO_EXTENSIONS.has(extension)) storageError('不支持的音频格式', 'UNSUPPORTED_MEDIA_TYPE', 415);
  return filename;
}

function sniffMimeType(header: Buffer, extension: string): string | null {
  const ascii = header.toString('ascii');
  if (header.length >= 12 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return extension === 'wav' ? 'audio/wav' : null;
  if ((ascii.startsWith('ID3') || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) && extension === 'mp3') return 'audio/mpeg';
  if (ascii.startsWith('OggS') && (extension === 'ogg' || extension === 'opus')) return extension === 'opus' ? 'audio/opus' : 'audio/ogg';
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && extension === 'webm') return 'audio/webm';
  if (header.length >= 2 && header[0] === 0xff && (header[1] === 0xf1 || header[1] === 0xf9) && extension === 'aac') return 'audio/aac';
  if (header.length >= 12 && ascii.slice(4, 8) === 'ftyp' && (extension === 'm4a' || extension === 'mp4')) return extension === 'm4a' ? 'audio/mp4' : 'video/mp4';
  return null;
}

function inspectReferenceAudioFile(directory: string, filename: string): Omit<OwnedReferenceAudio, 'displayName' | 'customName'> {
  validateReferenceAudioFilename(filename);
  const filepath = path.join(directory, filename);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filepath);
  } catch {
    storageError('参考音频不存在', 'REFERENCE_AUDIO_NOT_FOUND', 404);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) storageError('参考音频不存在', 'REFERENCE_AUDIO_NOT_FOUND', 404);
  if (stat.size <= 0 || stat.size > MAX_REFERENCE_AUDIO_FILE_BYTES) storageError('参考音频大小不符合限制', 'REFERENCE_AUDIO_SIZE_INVALID', 413);
  const descriptor = fs.openSync(filepath, 'r');
  const header = Buffer.alloc(Math.min(32, stat.size));
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  const mimeType = sniffMimeType(header, extension);
  if (!mimeType) storageError('参考音频内容与格式不匹配', 'REFERENCE_AUDIO_MIME_INVALID', 415);
  return { filename, filepath, mimeType, size: stat.size, createdAt: stat.birthtime.toISOString() };
}

function parseDisplayName(filename: string): string {
  const name = filename.replace(/\.[A-Za-z0-9]+$/u, '');
  const parts = name.split('_');
  if (parts.length >= 3) return `${parts[1] === 'link' ? '链接提取' : '上传文件'} (${parts[2] || ''})`;
  return filename;
}

function assertMetadataMatchesFile(entry: ReferenceAudioMetadataEntry, file: ReturnType<typeof inspectReferenceAudioFile>): void {
  if (!entry.mimeType || !entry.size || entry.mimeType !== file.mimeType || entry.size !== file.size) storageError('参考音频完整性校验失败', 'REFERENCE_AUDIO_INTEGRITY_MISMATCH', 409);
}

export function listOwnedReferenceAudio(ownerId: string, directory = resolveReferenceAudioDirectory()): OwnedReferenceAudio[] {
  if (!ownerId) storageError('缺少所有者身份', 'UNAUTHORIZED', 401);
  if (!fs.existsSync(directory)) return [];
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) storageError('参考音频存储目录不安全', 'STORAGE_INVALID', 500);
  const metadata = readReferenceAudioMetadata(directory);
  const owned: OwnedReferenceAudio[] = [];
  let totalBytes = 0;
  for (const [filename, entry] of Object.entries(metadata)) {
    if (entry.ownerId !== ownerId) continue;
    const file = inspectReferenceAudioFile(directory, filename);
    assertMetadataMatchesFile(entry, file);
    totalBytes += file.size;
    owned.push({ ...file, createdAt: entry.createdAt || file.createdAt, displayName: entry.displayName || parseDisplayName(filename), customName: Boolean(entry.displayName) });
  }
  if (owned.length > MAX_REFERENCE_AUDIO_USER_FILES || totalBytes > MAX_REFERENCE_AUDIO_USER_BYTES) storageError('参考音频存储配额异常', 'REFERENCE_AUDIO_QUOTA_EXCEEDED', 507);
  return owned.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function getOwnedReferenceAudio(ownerId: string, filename: unknown, directory = resolveReferenceAudioDirectory()): OwnedReferenceAudio {
  const safeFilename = validateReferenceAudioFilename(filename);
  const metadata = readReferenceAudioMetadata(directory);
  const entry = metadata[safeFilename];
  if (!entry || entry.ownerId !== ownerId) storageError('参考音频不存在', 'REFERENCE_AUDIO_NOT_FOUND', 404);
  const file = inspectReferenceAudioFile(directory, safeFilename);
  assertMetadataMatchesFile(entry, file);
  return { ...file, createdAt: entry.createdAt || file.createdAt, displayName: entry.displayName || parseDisplayName(safeFilename), customName: Boolean(entry.displayName) };
}

export function registerReferenceAudioOwnership(ownerId: string, filename: unknown, displayName?: string, directory = resolveReferenceAudioDirectory()): OwnedReferenceAudio {
  // Server-only boundary: call only after a trusted authenticated write or an
  // explicit administrator migration. Never let a caller claim an arbitrary
  // legacy filename through a public API.
  const safeFilename = validateReferenceAudioFilename(filename);
  const file = inspectReferenceAudioFile(directory, safeFilename);
  const metadata = readReferenceAudioMetadata(directory);
  const existing = metadata[safeFilename];
  if (existing?.ownerId && existing.ownerId !== ownerId) storageError('参考音频不存在', 'REFERENCE_AUDIO_NOT_FOUND', 404);
  const current = listOwnedReferenceAudio(ownerId, directory);
  const replacingBytes = existing?.ownerId === ownerId && existing.size ? existing.size : 0;
  const totalBytes = current.reduce((sum, item) => sum + item.size, 0) - replacingBytes + file.size;
  const totalFiles = current.length + (existing?.ownerId === ownerId ? 0 : 1);
  if (totalBytes > MAX_REFERENCE_AUDIO_USER_BYTES || totalFiles > MAX_REFERENCE_AUDIO_USER_FILES) storageError('参考音频存储配额不足', 'REFERENCE_AUDIO_QUOTA_EXCEEDED', 507);
  const normalizedDisplayName = displayName?.trim();
  metadata[safeFilename] = { ...(normalizedDisplayName ? { displayName: normalizedDisplayName.slice(0, 50) } : {}), ownerId, mimeType: file.mimeType, size: file.size, createdAt: existing?.createdAt || file.createdAt };
  writeReferenceAudioMetadata(metadata, directory);
  return getOwnedReferenceAudio(ownerId, safeFilename, directory);
}

export function renameOwnedReferenceAudio(ownerId: string, filename: unknown, displayName: unknown, directory = resolveReferenceAudioDirectory()): OwnedReferenceAudio {
  const file = getOwnedReferenceAudio(ownerId, filename, directory);
  if (typeof displayName !== 'string') storageError('显示名称无效', 'INVALID_DISPLAY_NAME', 400);
  const normalized = displayName.trim();
  if (normalized.length > 50) storageError('显示名称不能超过 50 个字符', 'INVALID_DISPLAY_NAME', 400);
  const metadata = readReferenceAudioMetadata(directory);
  metadata[file.filename] = { ...metadata[file.filename], ...(normalized ? { displayName: normalized } : { displayName: undefined }) };
  if (!normalized) delete metadata[file.filename].displayName;
  writeReferenceAudioMetadata(metadata, directory);
  return getOwnedReferenceAudio(ownerId, file.filename, directory);
}

export function deleteOwnedReferenceAudio(ownerId: string, filename: unknown, directory = resolveReferenceAudioDirectory()): string {
  const file = getOwnedReferenceAudio(ownerId, filename, directory);
  const metadata = readReferenceAudioMetadata(directory);
  const quarantine = `${file.filepath}.deleting-${process.pid}-${randomUUID()}`;
  fs.renameSync(file.filepath, quarantine);
  delete metadata[file.filename];
  try {
    writeReferenceAudioMetadata(metadata, directory);
  } catch (error) {
    fs.renameSync(quarantine, file.filepath);
    throw error;
  }
  fs.rmSync(quarantine, { force: true });
  return file.filename;
}
