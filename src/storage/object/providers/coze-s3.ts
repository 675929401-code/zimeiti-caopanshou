/**
 * Coze S3 Storage Provider
 *
 * 适配 coze-coding-dev-sdk 的 S3Storage，作为默认供应商。
 * 保持与旧 storage.ts 完全兼容，只是套上了 IStorageProvider 接口。
 */
import type {
  IStorageProvider,
  StorageProviderType,
  StorageUploadOptions,
  StorageUploadResult,
  StorageSignedUrlOptions,
  StorageListOptions,
  StorageListResult,
  StorageListItem,
  FileCategory,
} from "../types";

// ── Category → key 前缀映射 ──
const CATEGORY_PREFIX: Record<FileCategory, string> = {
  image: "images/",
  video: "videos/",
  document: "docs/",
  audio: "audio/",
  archive: "archives/",
  other: "misc/",
};

export class CozeS3Provider implements IStorageProvider {
  readonly type: StorageProviderType = "coze_s3";

  private client: any = null; // S3Storage 实例
  private config: Record<string, string> = {};

  async initialize(config: Record<string, string>): Promise<void> {
    this.config = config;

    const endpointUrl = config.endpointUrl || process.env.COZE_BUCKET_ENDPOINT_URL;
    const bucketName = config.bucketName || process.env.COZE_BUCKET_NAME;

    // ★ 配置校验：endpoint 缺失时直接抛错，触发 StorageManager 回退到备用供应商
    if (!endpointUrl) {
      throw new Error("Storage endpoint not configured: Set COZE_BUCKET_ENDPOINT_URL");
    }

    // 懒加载 SDK
    const { S3Storage } = await import("coze-coding-dev-sdk");

    this.client = new S3Storage({
      endpointUrl,
      accessKey: config.accessKey || "",
      secretKey: config.secretKey || "",
      bucketName,
      region: config.region || "cn-beijing",
    });
  }

  async upload(
    fileContent: Buffer,
    fileName: string,
    contentType: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResult> {
    const category: FileCategory = options?.category || "other";
    const prefix = options?.prefix || CATEGORY_PREFIX[category];

    // SDK 会自动添加 UUID 前缀，但我们先按前缀组织
    const composedName = options?.fileName
      ? `${prefix}${options.fileName}`
      : `${prefix}${fileName}`;

    const key = await this.client.uploadFile({
      fileContent,
      fileName: composedName,
      contentType,
    });

    return {
      key,
      url: await this.getSignedUrl(key, { expireTime: 86400 }),
      isPublic: options?.publicRead || false,
      size: fileContent.length,
      contentType,
      provider: this.type,
      category,
    };
  }

  async uploadFromUrl(
    url: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResult> {
    const key = await this.client.uploadFromUrl({ url });
    const category: FileCategory = options?.category || "other";

    return {
      key,
      url: await this.getSignedUrl(key, { expireTime: 86400 }),
      isPublic: options?.publicRead || false,
      size: 0, // SDK 不返回 size
      contentType: "application/octet-stream",
      provider: this.type,
      category,
    };
  }

  async read(key: string): Promise<Buffer> {
    return this.client.readFile({ fileKey: key });
  }

  async exists(key: string): Promise<boolean> {
    return this.client.fileExists({ fileKey: key });
  }

  async getSignedUrl(key: string, options?: StorageSignedUrlOptions): Promise<string> {
    return this.client.generatePresignedUrl({
      key,
      expireTime: options?.expireTime || 3600,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.client.deleteFile({ fileKey: key });
  }

  async deleteBatch(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      try {
        const ok = await this.delete(key);
        if (ok) deleted++;
      } catch {
        // 继续删除剩余
      }
    }
    return deleted;
  }

  async list(options?: StorageListOptions): Promise<StorageListResult> {
    const result = await this.client.listFiles({
      prefix: options?.prefix,
      maxKeys: options?.maxKeys,
    });

    const items: StorageListItem[] = (result?.items || result || []).map(
      (item: any) => ({
        key: item.Key || item.key || "",
        size: item.Size || item.size || 0,
        lastModified: item.LastModified ? new Date(item.LastModified) : null,
        contentType: item.ContentType || item.contentType || null,
      })
    );

    return {
      items,
      hasMore: result?.isTruncated || false,
      nextCursor: result?.nextContinuationToken || undefined,
    };
  }

  async head(key: string): Promise<{ size: number; contentType: string; lastModified: Date } | null> {
    // SDK 没有 head 方法，用 exists + 读取部分来推断
    const fileExists = await this.exists(key);
    if (!fileExists) return null;

    // 签名 URL 中无法获取元数据，尝试读取前几个字节
    try {
      const buffer = await this.read(key);
      return {
        size: buffer.length,
        contentType: "application/octet-stream",
        lastModified: new Date(),
      };
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    this.client = null;
  }
}
