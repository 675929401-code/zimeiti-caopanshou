/**
 * 存储工具函数（向后兼容层）
 *
 * ⚠️ 新代码请直接使用 storageManager：
 *   import { storageManager } from "@/storage/object";
 *
 * 旧接口保持签名不变，内部委托到 StorageManager。
 */
import crypto from "node:crypto";
import sharp from "sharp";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";
import { getSupabaseAdminClient, getSupabaseClient } from "@/storage/database/supabase-client";
import { safeFetch } from "@/lib/safe-fetch";
import { safeUploadFileName, validateUploadBuffer } from "@/lib/file-upload-security";

const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AGENT_IMAGE_PIXELS = 40_000_000;
const AGENT_IMAGE_FETCH_TIMEOUT_MS = 20_000;
const ALLOWED_AGENT_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_AGENT_IMAGE_SOURCES = new Set(["agent-image-upload", "agent-avatar-transfer", "agent-avatar-generated"]);

export type AgentImagePurpose = "avatar" | "cover";

export class AgentImageReferenceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 502 | 504 = 400,
  ) {
    super(message);
    this.name = "AgentImageReferenceError";
  }
}

type OwnedAgentImageRow = {
  id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_size: number;
  content_type: string;
  file_category: string;
  source: string | null;
  meta: Record<string, unknown> | null;
};


/**
 * 上传文件到对象存储
 * @param fileContent 文件内容 (Buffer)
 * @param fileName 文件名
 * @param contentType MIME 类型
 * @returns 实际存储的 key
 */
export async function uploadFile(
  fileContent: Buffer,
  fileName: string,
  contentType: string
): Promise<string> {
  const result = await storageManager.upload(fileContent, fileName, contentType);
  return result.key;
}

/**
 * 读取文件内容
 * @param key 文件 key（uploadFile 返回的）
 * @returns 文件内容 Buffer
 */
export async function readFileContent(key: string): Promise<Buffer> {
  return storageManager.read(key);
}

/**
 * 检查文件是否存在
 * @param key 文件 key
 */
export async function fileExists(key: string): Promise<boolean> {
  return storageManager.exists(key);
}

/**
 * 生成文件签名访问 URL
 * @param key 文件 key（uploadFile 返回的）
 * @param expireTime 有效期（秒），默认 1 小时
 * @returns 签名 URL
 */
export async function getSignedUrl(
  key: string,
  expireTime: number = 3600
): Promise<string> {
  return storageManager.getSignedUrl(key, { expireTime });
}

/**
 * 删除文件
 * @param key 文件 key
 */
export async function deleteFile(key: string): Promise<boolean> {
  return storageManager.delete(key);
}

/**
 * 从 URL 下载并上传到对象存储
 * @param url 远程 URL
 * @returns 存储的 key
 */
export async function uploadFromUrl(url: string): Promise<string> {
  const result = await storageManager.uploadFromUrl(url);
  return result.key;
}

/**
 * 列出指定前缀的文件
 * @param prefix 文件前缀
 * @param maxKeys 最大返回数量
 */
export async function listFiles(prefix?: string, maxKeys?: number) {
  const result = await storageManager.list({ prefix, maxKeys });
  return result.items;
}

function assertManagedAgentImageKey(key: string, purpose: AgentImagePurpose): void {
  if (!key.startsWith(`agent-images/${purpose}/`)
    || key.length > 512
    || key.includes("://")
    || /[\\\u0000\r\n?#]/u.test(key)
    || key.split("/").includes("..")) {
    throw new AgentImageReferenceError("图片对象 key 无效", "AGENT_IMAGE_KEY_INVALID", 400);
  }
}

function dataImageBytes(rawUrl: string): { buffer: Buffer; contentType: string } {
  const comma = rawUrl.indexOf(",");
  if (comma < 1) throw new AgentImageReferenceError("图片 Data URL 无效", "AGENT_IMAGE_DATA_URL_INVALID", 400);
  const header = rawUrl.slice(0, comma).toLowerCase();
  const match = /^data:(image\/(?:png|jpeg|webp));base64$/u.exec(header);
  if (!match) throw new AgentImageReferenceError("仅支持 PNG、JPEG 或 WebP 图片", "AGENT_IMAGE_TYPE_FORBIDDEN", 415);
  const encoded = rawUrl.slice(comma + 1);
  const maximumEncodedLength = Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4 + 4;
  if (!encoded || encoded.length > maximumEncodedLength || !/^[a-z0-9+/]*={0,2}$/iu.test(encoded)) {
    throw new AgentImageReferenceError("图片必须在 5MB 以内", "AGENT_IMAGE_TOO_LARGE", 413);
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.byteLength > MAX_AGENT_IMAGE_BYTES) {
    throw new AgentImageReferenceError("图片必须在 5MB 以内", "AGENT_IMAGE_TOO_LARGE", 413);
  }
  return { buffer, contentType: match[1] };
}

async function readAgentImageSource(rawUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (rawUrl.startsWith("data:")) return dataImageBytes(rawUrl);
  if (!/^https?:\/\//iu.test(rawUrl)) {
    throw new AgentImageReferenceError("头像来源必须是 HTTP(S) 图片", "AGENT_IMAGE_SOURCE_INVALID", 400);
  }
  try {
    const response = await safeFetch(rawUrl, {
      timeoutMs: AGENT_IMAGE_FETCH_TIMEOUT_MS,
      maxBytes: MAX_AGENT_IMAGE_BYTES,
      maxRedirects: 2,
      networkPolicy: "system-dns-pinned",
      allowedContentTypes: [...ALLOWED_AGENT_IMAGE_MIME],
    });
    return { buffer: response.buffer, contentType: response.contentType };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "FETCH_FAILED";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 502;
    const mappedStatus = [413, 415, 504].includes(status) ? status as 413 | 415 | 504 : 502;
    throw new AgentImageReferenceError(
      code === "RESPONSE_TOO_LARGE" ? "远程头像超过 5MB" : code === "CONTENT_TYPE_FORBIDDEN" ? "远程内容不是允许的图片" : "远程头像读取失败",
      `AGENT_IMAGE_${code}`,
      mappedStatus,
    );
  }
}

async function validateAgentImageBytes(buffer: Buffer, declaredContentType: string) {
  let validated: ReturnType<typeof validateUploadBuffer>;
  try {
    validated = validateUploadBuffer(buffer, declaredContentType);
  } catch {
    throw new AgentImageReferenceError("图片声明类型与真实内容不一致", "AGENT_IMAGE_SIGNATURE_MISMATCH", 415);
  }
  if (!ALLOWED_AGENT_IMAGE_MIME.has(validated.contentType)) {
    throw new AgentImageReferenceError("仅支持 PNG、JPEG 或 WebP 图片", "AGENT_IMAGE_TYPE_FORBIDDEN", 415);
  }
  try {
    const metadata = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_AGENT_IMAGE_PIXELS,
      animated: false,
    }).metadata();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if ((metadata.pages || 1) !== 1 || width < 16 || height < 16 || width > 8192 || height > 8192) {
      throw new Error("invalid dimensions");
    }
    return { ...validated, width, height };
  } catch {
    throw new AgentImageReferenceError("图片无法安全解码", "AGENT_IMAGE_DECODE_FAILED", 415);
  }
}

/** Verify a client-supplied managed key against the authenticated owner and its exact use. */
export async function verifyOwnedAgentImageReference(
  key: string,
  ownerUserId: string,
  purpose: AgentImagePurpose,
): Promise<string> {
  const normalized = key.trim();
  assertManagedAgentImageKey(normalized, purpose);
  const { data, error } = await getSupabaseAdminClient()
    .from("user_files")
    .select("id,storage_key,storage_provider,file_size,content_type,file_category,source,meta")
    .eq("user_id", ownerUserId)
    .eq("storage_key", normalized)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new AgentImageReferenceError("无法核验图片资产归属", "AGENT_IMAGE_OWNERSHIP_UNAVAILABLE", 502);
  }
  const owned = data as OwnedAgentImageRow | null;
  if (!owned) {
    throw new AgentImageReferenceError("图片不存在或不属于当前管理员", "AGENT_IMAGE_NOT_OWNED", 403);
  }
  const meta = owned.meta || {};
  if (owned.file_category !== "image"
    || !ALLOWED_AGENT_IMAGE_SOURCES.has(owned.source || "")
    || !ALLOWED_AGENT_IMAGE_MIME.has(owned.content_type)
    || Number(owned.file_size) < 1
    || Number(owned.file_size) > MAX_AGENT_IMAGE_BYTES
    || String(meta.purpose || "") !== purpose
    || !String(meta.sha256 || "").match(/^[a-f0-9]{64}$/u)) {
    throw new AgentImageReferenceError("图片用途或持久化回执无效", "AGENT_IMAGE_PURPOSE_MISMATCH", 409);
  }
  const head = await storageManager.head(normalized, owned.storage_provider).catch(() => null);
  if (!head
    || head.size !== Number(owned.file_size)
    || head.contentType.split(";", 1)[0].toLowerCase() !== owned.content_type) {
    throw new AgentImageReferenceError("图片对象与持久化回执不一致", "AGENT_IMAGE_STORAGE_MISMATCH", 409);
  }
  return normalized;
}

/** Upload already validated bytes to the legacy public avatar bucket. */
async function uploadAvatarToSupabase(
  buffer: Buffer,
  contentType: string,
  fileName: string,
): Promise<string> {
  const client = getSupabaseClient();
  const { error } = await client.storage
    .from("avatars")
    .upload(fileName, buffer, { contentType, upsert: false, cacheControl: "31536000" });
  if (error) throw new Error(`Supabase Storage 上传失败: ${error.message}`);
  return client.storage.from("avatars").getPublicUrl(fileName).data.publicUrl;
}

/**
 * 持久化头像：上传到 Supabase Storage（云端存储）
 *
 * 存储策略：
 * 1. 上传到 Supabase Storage avatars bucket（云端，三端通用，永不丢失）
 * 2. 调用方可关闭原始 URL 回退；智能体头像链必须关闭，避免保存临时外链
 *
 * @param rawUrl 原始图片 URL
 * @param label 日志标签（如智能体名称）
 * @returns 可作为 avatar 字段存储的值
 */
export async function persistAvatar(
  rawUrl: string,
  label: string = "",
  options: {
    allowOriginalUrlFallback?: boolean;
    ownerUserId?: string;
    source?: "agent-avatar-transfer" | "agent-avatar-generated";
  } = {},
): Promise<string> {
  const downloaded = await readAgentImageSource(rawUrl);
  const validated = await validateAgentImageBytes(downloaded.buffer, downloaded.contentType);
  const fileName = safeUploadFileName(validated.extension);
  const digest = crypto.createHash("sha256").update(downloaded.buffer).digest("hex");

  // 管理员触发的头像必须落入私有托管前缀并同步写入 user_files。
  if (options.ownerUserId) {
    const result = await storageManager.upload(downloaded.buffer, fileName, validated.contentType, {
      category: "image",
      prefix: "agent-images/avatar/",
      fileName,
      publicRead: false,
      userId: options.ownerUserId,
      source: options.source || "agent-avatar-transfer",
      requireOwnershipRecord: true,
      meta: {
        purpose: "avatar",
        sha256: digest,
        width: String(validated.width),
        height: String(validated.height),
      },
    });
    await verifyOwnedAgentImageReference(result.key, options.ownerUserId, "avatar");
    console.log(`[AvatarStorage] Persisted owned avatar for ${label || "agent"} (${result.size} bytes)`);
    return result.key;
  }

  // 兼容旧导入链：仍优先写入公开头像桶，但下载、大小、类型和解码已经统一校验。
  try {
    const publicUrl = await uploadAvatarToSupabase(downloaded.buffer, validated.contentType, fileName);
    console.log(`[AvatarStorage] Persisted legacy avatar for ${label || "import"} (${downloaded.buffer.length} bytes)`);
    return publicUrl;
  } catch (supabaseErr) {
    console.warn(`[AvatarStorage] Supabase upload failed for ${label}, trying object storage:`, supabaseErr instanceof Error ? supabaseErr.message : supabaseErr);
  }

  // 回退到对象存储时复用已经受限并校验的字节，禁止 provider 再次从 URL 下载。
  try {
    const result = await storageManager.upload(downloaded.buffer, fileName, validated.contentType, {
      category: "image",
      prefix: "agent-images/avatar/",
      fileName,
      publicRead: false,
      source: "agent-avatar-transfer",
      meta: { purpose: "avatar", sha256: digest, width: String(validated.width), height: String(validated.height) },
    });
    console.log(`[AvatarStorage] Persisted legacy avatar for ${label || "import"} via object storage (${result.size} bytes)`);
    return result.key;
  } catch (storeErr) {
    console.warn(`[AvatarStorage] Object storage also failed for ${label}:`, storeErr instanceof Error ? storeErr.message : storeErr);
  }

  if (options.allowOriginalUrlFallback === false) {
    throw new Error(`头像未能保存到平台托管存储: ${label || "unknown"}`);
  }

  // 兼容仍依赖旧行为的导入链；智能体新增、编辑和自动头像均显式关闭此回退。
  console.error(`[AvatarStorage] All storage strategies failed for ${label}, using raw URL as fallback`);
  return rawUrl;
}
