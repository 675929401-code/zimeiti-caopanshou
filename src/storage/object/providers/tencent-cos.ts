/**
 * Tencent COS Storage Provider
 *
 * 腾讯云对象存储（Cloud Object Storage）适配器。
 * 基于 cos-nodejs-sdk-v5 实现，接入步骤：
 *
 * 1. 安装依赖：pnpm add cos-nodejs-sdk-v5
 * 2. 在管理后台"平台连接"中配置：
 *    - storage_tencent_cos_secret_id   → SecretId
 *    - storage_tencent_cos_secret_key  → SecretKey
 *    - storage_tencent_cos_bucket      → 存储桶名（如 agent-hub-1250000000）
 *    - storage_tencent_cos_region      → 地域（如 ap-guangzhou）
 * 3. 在存储设置中将默认供应商切换为 tencent_cos
 *
 * 特性：
 * - 支持签名 URL、公开读、分片上传
 * - 支持跨域 CORS 配置
 * - 支持生命周期规则（自动清理过期文件）
 */
import { Writable } from "node:stream";
import {createHash} from "node:crypto";
import type {
  IStorageProvider,
  StorageProviderType,
  StorageUploadOptions,
  StorageUploadResult,
  StorageSignedUrlOptions,
  StorageDirectUploadRequest,
  StorageDirectUploadTicket,
  StorageListOptions,
  StorageListResult,
  StorageListItem,
  FileCategory,
} from "../types";

const CATEGORY_PREFIX: Record<FileCategory, string> = {
  image: "images/",
  video: "videos/",
  document: "docs/",
  audio: "audio/",
  archive: "archives/",
  other: "misc/",
};

export class TencentCOSProvider implements IStorageProvider {
  readonly type: StorageProviderType = "tencent_cos";

  private cos: any = null;
  private bucket = "";
  private region = "";
  private config: Record<string, string> = {};

  async initialize(config: Record<string, string>): Promise<void> {
    this.config = config;
    this.bucket = config.bucket || "";
    this.region = config.region || "ap-guangzhou";

    if (!config.secretId || !config.secretKey) {
      throw new Error(
        "[TencentCOS] 缺少必要配置: secretId 和 secretKey。请在管理后台平台连接中配置 storage_tencent_cos_secret_id 和 storage_tencent_cos_secret_key"
      );
    }

    if (!this.bucket) {
      throw new Error(
        "[TencentCOS] 缺少存储桶名。请配置 storage_tencent_cos_bucket"
      );
    }

    try {
      // cos-nodejs-sdk-v5 为可选依赖，初始化时动态加载
      const COS = (await import("cos-nodejs-sdk-v5")).default;
      this.cos = new COS({
        SecretId: config.secretId,
        SecretKey: config.secretKey,
      });
      console.log("[TencentCOS] 初始化成功:", this.bucket, this.region);
    } catch (importError) {
      console.error(
        "[TencentCOS] cos-nodejs-sdk-v5 未安装，请执行: pnpm add cos-nodejs-sdk-v5"
      );
      throw importError;
    }
  }

  /** 生成存储 key */
  private buildKey(fileName: string, category: FileCategory, options?: StorageUploadOptions): string {
    const prefix = options?.prefix || CATEGORY_PREFIX[category];
    const name = options?.fileName || fileName;
    // 加日期子目录便于管理
    const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    return `${prefix}${datePath}/${name}`;
  }

  /** Server-only publication path. No user_files write and no arbitrary object keys. */
  async uploadPublicationObjectOnly(buffer:Buffer,key:string,contentType:string):Promise<void> {
    if(!new RegExp("^admin-image-publication/[a-f0-9]{64}/ivc_[a-f0-9]{64}/[a-f0-9]{64}/[a-f0-9]{64}$").test(key)
      || createHash('sha256').update(buffer).digest('hex')!==key.split('/').at(-1) || !buffer.length || buffer.length>30*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(contentType))throw new Error('IMAGE_PUBLICATION_OBJECT_INVALID');
    await new Promise<void>((resolve,reject)=>this.cos.putObject({Bucket:this.bucket,Region:this.region,Key:key,Body:buffer,
      ContentType:contentType,ContentLength:buffer.length,Headers:{'x-cos-forbid-overwrite':'true'}},(error:Error|null)=>error?reject(new Error('IMAGE_PUBLICATION_OBJECT_UPLOAD_UNKNOWN')):resolve()));
  }

  async upload(
    fileContent: Buffer,
    fileName: string,
    contentType: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResult> {
    const category: FileCategory = options?.category || "other";
    const key = this.buildKey(fileName, category, options);

    return new Promise<StorageUploadResult>((resolve, reject) => {
      this.cos.putObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
          Body: fileContent,
          ContentType: contentType,
          ContentLength: fileContent.length,
          // `publicRead` is an explicit call-site opt-in used for assets that
          // third-party inference services must fetch without query-string
          // credentials. Returning a bare URL without setting the object ACL
          // produces a misleading 403 URL, so keep the ACL and URL contract
          // atomic here. The default remains private.
          ...(options?.publicRead ? { ACL: "public-read" } : {}),
        },
        (err: Error | null, data: any) => {
          if (err) {
            reject(new Error(`[TencentCOS] 上传失败: ${err.message}`));
            return;
          }

          const isPublic = options?.publicRead || false;
          const url = isPublic
            ? `https://${this.bucket}.cos.${this.region}.myqcloud.com/${key}`
            : ""; // 私有文件用签名 URL

          resolve({
            key,
            url: url || "", // 稍后可通过 getSignedUrl 获取
            isPublic,
            size: fileContent.length,
            contentType,
            provider: this.type,
            category,
          });
        }
      );
    });
  }

  async uploadFromUrl(
    url: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResult> {
    // COS 没有原生的 URL 转存，先下载再上传
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`[TencentCOS] 下载远程文件失败: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const urlFileName = url.split("/").pop() || `file_${Date.now()}`;

    return this.upload(buffer, urlFileName, contentType, options);
  }

  async read(key: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.cos.getObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
        },
        (err: Error | null, data: any) => {
          if (err) {
            reject(new Error(`[TencentCOS] 读取失败: ${err.message}`));
            return;
          }
          resolve(Buffer.from(data.Body));
        }
      );
    });
  }

  async exists(key: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.cos.headObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
        },
        (err: Error | null) => {
          resolve(!err);
        }
      );
    });
  }

  async readBounded(key: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
    if (!key || key.startsWith("/") || key.includes("://") || /[\u0000\r\n\\]/u.test(key) || key.split("/").includes("..")) {
      throw new Error("STORAGE_OBJECT_KEY_INVALID");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > (new RegExp("^admin-image-publication/[a-f0-9]{64}/ivc_[a-f0-9]{64}/[a-f0-9]{64}/[a-f0-9]{64}$").test(key)?30:25) * 1024 * 1024
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error("STORAGE_READ_LIMIT_INVALID");
    }
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      let outputFinished = false;
      let requestSucceeded = false;
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (total + chunk.length > maxBytes) return callback(new Error("STORAGE_OBJECT_TOO_LARGE"));
          total += chunk.length;
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      const timeout = setTimeout(() => {
        const error = new Error("STORAGE_READ_TIMEOUT");
        finish(error);
        output.destroy(error);
      }, timeoutMs);
      const finish = (error: Error | null) => {
        if (settled) return;
        if (!error && (!outputFinished || !requestSucceeded)) return;
        settled = true;
        clearTimeout(timeout);
        if (error) { chunks.length = 0; reject(error); }
        else resolve(Buffer.concat(chunks, total));
      };
      output.on("error", finish);
      output.once("finish", () => { outputFinished = true; finish(null); });
      try {
        // The SDK aborts its network request when Output emits an error. The
        // authenticated bucket/key read works with COS private cloud DNS too.
        this.cos.getObject({ Bucket: this.bucket, Region: this.region, Key: key, Output: output },
          (error: Error | null, data: { statusCode?: number } | undefined) => {
            if (error || data?.statusCode !== 200) {
              const failure = new Error("STORAGE_OBJECT_READ_FAILED");
              finish(failure);
              output.destroy(failure);
            } else { requestSucceeded = true; finish(null); }
          });
      } catch {
        const error = new Error("STORAGE_OBJECT_READ_FAILED");
        finish(error);
        output.destroy(error);
      }
    });
  }

  async getSignedUrl(key: string, options?: StorageSignedUrlOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.cos.getObjectUrl(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
          Sign: true,
          Expires: options?.expireTime || 3600,
          Query: options?.responseFileName
            ? { "response-content-disposition": `attachment; filename="${options.responseFileName}"` }
            : undefined,
        },
        (err: Error | null, data: any) => {
          if (err) {
            reject(new Error(`[TencentCOS] 生成签名URL失败: ${err.message}`));
            return;
          }
          resolve(data.Url);
        }
      );
    });
  }

  async createDirectUploadTicket(
    request: StorageDirectUploadRequest
  ): Promise<StorageDirectUploadTicket> {
    if (!this.cos || !this.bucket || !this.region) {
      throw new Error("[TencentCOS] 浏览器直传暂不可用");
    }
    if (!request.key || request.key.startsWith("/") || request.key.includes("..")) {
      throw new Error("[TencentCOS] 直传对象路径无效");
    }
    if (!Number.isSafeInteger(request.contentLength) || request.contentLength <= 0) {
      throw new Error("[TencentCOS] 直传文件大小无效");
    }
    const expires = Math.max(60, Math.min(900, Math.trunc(request.expireTime)));
    const expiresAt = new Date(Date.now() + expires * 1000).toISOString();
    const url = await new Promise<string>((resolve, reject) => {
      this.cos.getObjectUrl(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: request.key,
          Method: "PUT",
          Sign: true,
          Expires: expires,
          Headers: { "Content-Type": request.contentType },
        },
        (err: Error | null, data: { Url?: unknown } | null) => {
          if (err || !data?.Url) {
            reject(new Error(`[TencentCOS] 生成直传授权失败: ${err?.message || "EMPTY_URL"}`));
            return;
          }
          resolve(String(data.Url));
        }
      );
    });
    return {
      provider: this.type,
      key: request.key,
      url,
      method: "PUT",
      headers: { "Content-Type": request.contentType },
      expiresAt,
    };
  }

  async readRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    const safeStart = Math.max(0, Math.trunc(start));
    const safeEnd = Math.max(safeStart, Math.trunc(endInclusive));
    if (safeEnd - safeStart + 1 > 128 * 1024) {
      throw new Error("[TencentCOS] 读取范围超过验证上限");
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.cos.getObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
          Range: `bytes=${safeStart}-${safeEnd}`,
        },
        (err: Error | null, data: { Body?: Buffer | Uint8Array | string } | null) => {
          if (err) {
            reject(new Error(`[TencentCOS] 范围读取失败: ${err.message}`));
            return;
          }
          resolve(Buffer.from(data?.Body || []));
        }
      );
    });
  }

  async delete(key: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.cos.deleteObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
        },
        (err: Error | null) => {
          resolve(!err);
        }
      );
    });
  }

  async deleteBatch(keys: string[]): Promise<number> {
    return new Promise<number>((resolve) => {
      this.cos.deleteMultipleObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Objects: keys.map((k) => ({ Key: k })),
        },
        (err: Error | null, data: any) => {
          if (err) {
            console.error("[TencentCOS] 批量删除失败:", err.message);
            resolve(0);
            return;
          }
          const deleted = data?.Deleted?.length || 0;
          resolve(deleted);
        }
      );
    });
  }

  async list(options?: StorageListOptions): Promise<StorageListResult> {
    return new Promise<StorageListResult>((resolve, reject) => {
      this.cos.getBucket(
        {
          Bucket: this.bucket,
          Region: this.region,
          Prefix: options?.prefix || "",
          MaxKeys: options?.maxKeys || 100,
          Marker: options?.cursor || "",
        },
        (err: Error | null, data: any) => {
          if (err) {
            reject(new Error(`[TencentCOS] 列出文件失败: ${err.message}`));
            return;
          }

          const items: StorageListItem[] = (data?.Contents || []).map(
            (item: any) => ({
              key: item.Key,
              size: item.Size,
              lastModified: item.LastModified ? new Date(item.LastModified) : null,
              contentType: null, // COS list 不返回 contentType
            })
          );

          resolve({
            items,
            hasMore: data?.IsTruncated === "true",
            nextCursor: data?.NextMarker || undefined,
          });
        }
      );
    });
  }

  async head(key: string): Promise<{ size: number; contentType: string; lastModified: Date } | null> {
    return new Promise((resolve) => {
      this.cos.headObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
        },
        (err: Error | null, data: any) => {
          if (err) {
            resolve(null);
            return;
          }
          // COS SDK exposes HTTP metadata under `headers`, not ContentLength.
          const headers = data?.headers && typeof data.headers === "object" ? data.headers : {};
          const header = (name: string, legacy: unknown): unknown => {
            const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
            return entry?.[1] ?? legacy;
          };
          const rawSize = header("content-length", data?.ContentLength);
          const size = typeof rawSize === "number" ? rawSize
            : typeof rawSize === "string" && /^\d+$/u.test(rawSize.trim()) ? Number(rawSize.trim()) : NaN;
          if (!Number.isSafeInteger(size) || size < 0) {
            resolve(null);
            return;
          }
          const rawType = header("content-type", data?.ContentType);
          const rawModified = header("last-modified", data?.LastModified);
          const modifiedTime = rawModified instanceof Date ? rawModified.getTime()
            : typeof rawModified === "string" ? Date.parse(rawModified) : NaN;
          resolve({
            size,
            contentType: typeof rawType === "string" && rawType.trim() ? rawType.trim() : "application/octet-stream",
            lastModified: new Date(Number.isFinite(modifiedTime) ? modifiedTime : 0),
          });
        }
      );
    });
  }

  async headPublicationObjectOnly(key: string): Promise<{ size: number; contentType: string; lastModified: Date } | null> {
    if(!new RegExp("^admin-image-publication/[a-f0-9]{64}/ivc_[a-f0-9]{64}/[a-f0-9]{64}/[a-f0-9]{64}$").test(key))throw new Error("IMAGE_PUBLICATION_KEY_INVALID");
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error("IMAGE_PUBLICATION_HEAD_UNKNOWN")),10000);
      this.cos.headObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
        },
        (err: (Error & {statusCode?:number}) | null, data: any) => {
          clearTimeout(timer);
          if (err) {
            if(err.statusCode===404)resolve(null);else reject(new Error("IMAGE_PUBLICATION_HEAD_UNKNOWN"));
            return;
          }
          // COS SDK exposes HTTP metadata under `headers`, not ContentLength.
          const headers = data?.headers && typeof data.headers === "object" ? data.headers : {};
          const header = (name: string, legacy: unknown): unknown => {
            const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
            return entry?.[1] ?? legacy;
          };
          const rawSize = header("content-length", data?.ContentLength);
          const size = typeof rawSize === "number" ? rawSize
            : typeof rawSize === "string" && /^\d+$/u.test(rawSize.trim()) ? Number(rawSize.trim()) : NaN;
          if (!Number.isSafeInteger(size) || size < 0) {
            reject(new Error("IMAGE_PUBLICATION_HEAD_UNKNOWN"));
            return;
          }
          const rawType = header("content-type", data?.ContentType);
          const rawModified = header("last-modified", data?.LastModified);
          const modifiedTime = rawModified instanceof Date ? rawModified.getTime()
            : typeof rawModified === "string" ? Date.parse(rawModified) : NaN;
          resolve({
            size,
            contentType: typeof rawType === "string" && rawType.trim() ? rawType.trim() : "application/octet-stream",
            lastModified: new Date(Number.isFinite(modifiedTime) ? modifiedTime : 0),
          });
        }
      );
    });
  }

  async dispose(): Promise<void> {
    this.cos = null;
  }
}
