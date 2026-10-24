/**
 * 存储模块核心类型定义
 *
 * 设计原则：
 * 1. Provider 接口统一 — 所有存储供应商实现同一套 API
 * 2. 配置驱动 — 通过 platform_settings 或环境变量切换供应商
 * 3. 文件分类 — image/video/document/audio/archive 等类别，便于配额与检索
 * 4. 元数据入库 — 每次上传记录到 user_files 表，便于管理、统计、回收
 */

// ── 文件分类 ──
export type FileCategory =
  | "image"     // 封面、头像、AI生图
  | "video"     // AI视频、上传视频
  | "document"  // 文案、文档(txt/pdf/docx)
  | "audio"     // 音频、配音
  | "archive"   // 压缩包、备份
  | "other";    // 其他

// ── 存储供应商标识 ──
export type StorageProviderType =
  | "coze_s3"       // Coze 内置 S3（当前默认）
  | "tencent_cos"   // 腾讯云 COS
  | "local";         // 本地文件系统（开发/回退）

// ── 上传选项 ──
export interface StorageUploadOptions {
  /** Server-only key reserved by the durable storyboard queue. */
  storyboardArchiveKey?: string;
  /** 文件分类，默认 "other" */
  category?: FileCategory;
  /** 自定义 key 前缀，默认按 category 自动生成 */
  prefix?: string;
  /** 自定义文件名（不含路径），不填则自动生成 */
  fileName?: string;
  /** 是否公开可读（生成公开 URL），默认 false */
  publicRead?: boolean;
  /** 文件元数据（存入 user_files 表） */
  meta?: Record<string, string>;
  /** 关联用户 ID（元数据记录用） */
  userId?: string;
  /** 来源描述，如 "封面制作"、"视频生成" */
  source?: string;
  /** 强制指定供应商（覆盖默认） */
  providerType?: StorageProviderType;
  /** 指定供应商失败时禁止回退；用于必须保持存储/公开访问契约的跨平台桥接素材。 */
  strictProvider?: boolean;
  /**
   * 在返回上传结果前必须把 user_files 归属元数据持久化。
   * 只用于后续会进入异步队列的私有输入资产；写入失败时整个请求 fail-closed。
   */
  requireOwnershipRecord?: boolean;
}

// ── 上传结果 ──
export interface StorageUploadResult {
  /** 存储供应商内部的 key（全局唯一） */
  key: string;
  /** 文件访问 URL（签名或公开） */
  url: string;
  /** 是否为公开可读 URL */
  isPublic: boolean;
  /** 文件大小（字节） */
  size: number;
  /** MIME 类型 */
  contentType: string;
  /** 使用的供应商 */
  provider: StorageProviderType;
  /** 文件分类 */
  category: FileCategory;
}

// ── 签名 URL 选项 ──
export interface StorageSignedUrlOptions {
  /** 有效期（秒），默认 3600 */
  expireTime?: number;
  /** 响应式下载时的文件名 */
  responseFileName?: string;
  /** 响应式下载时的 Content-Type */
  responseContentType?: string;
}

export interface StorageDirectUploadRequest {
  /** Fully server-generated object key. The browser never chooses this value. */
  key: string;
  contentType: string;
  contentLength: number;
  expireTime: number;
}

export interface StorageDirectUploadTicket {
  provider: StorageProviderType;
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

// ── 文件列表选项 ──
export interface StorageListOptions {
  /** key 前缀过滤 */
  prefix?: string;
  /** 最大返回数量 */
  maxKeys?: number;
  /** 分页游标 */
  cursor?: string;
}

// ── 文件列表项 ──
export interface StorageListItem {
  key: string;
  size: number;
  lastModified: Date | null;
  contentType: string | null;
}

// ── 文件列表结果 ──
export interface StorageListResult {
  items: StorageListItem[];
  /** 是否还有更多 */
  hasMore: boolean;
  /** 下一页游标 */
  nextCursor?: string;
}

// ── 供应商配置 ──
export interface StorageProviderConfig {
  /** 供应商类型 */
  type: StorageProviderType;
  /** 是否为默认供应商 */
  isDefault: boolean;
  /** 供应商特定配置（各 Provider 自行解析） */
  options: Record<string, string>;
}

// ── Provider 接口（核心 — 所有供应商必须实现） ──
export interface IStorageProvider {
  /** 供应商标识 */
  readonly type: StorageProviderType;

  /** 初始化（读取配置、建立连接等） */
  initialize(config: Record<string, string>): Promise<void>;

  /** 上传文件 */
  upload(
    fileContent: Buffer,
    fileName: string,
    contentType: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResult>;

  /** 从 URL 下载并上传 */
  uploadFromUrl(
    url: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResult>;

  /** 读取文件内容 */
  read(key: string): Promise<Buffer>;

  /** Read an owned object through its authenticated provider with hard limits. */
  readBounded?(key: string, maxBytes: number, timeoutMs: number): Promise<Buffer>;

  /** 检查文件是否存在 */
  exists(key: string): Promise<boolean>;

  /** 生成签名访问 URL */
  getSignedUrl(key: string, options?: StorageSignedUrlOptions): Promise<string>;

  /**
   * Issue a short-lived, single-method URL for one server-generated object key.
   * Providers without browser-direct upload support leave this undefined.
   */
  createDirectUploadTicket?(
    request: StorageDirectUploadRequest
  ): Promise<StorageDirectUploadTicket>;

  /** Read only a bounded byte range for post-upload signature verification. */
  readRange?(key: string, start: number, endInclusive: number): Promise<Buffer>;

  /** 删除文件 */
  delete(key: string): Promise<boolean>;

  /** 批量删除 */
  deleteBatch(keys: string[]): Promise<number>;

  /** 列出文件 */
  list(options?: StorageListOptions): Promise<StorageListResult>;

  /** 获取文件元信息（大小、类型等） */
  head(key: string): Promise<{ size: number; contentType: string; lastModified: Date } | null>;

  /** 释放资源 */
  dispose?(): Promise<void>;
}

// ── 文件元数据（数据库 user_files 表映射） ──
export interface UserFileRecord {
  id: string;
  user_id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_name: string;
  file_category: FileCategory;
  file_size: number;
  content_type: string;
  source: string | null;
  meta: Record<string, string> | null;
  is_public: boolean;
  created_at: string;
}

// ── 用户配额 ──
export interface UserStorageQuota {
  /** 总已用字节 */
  usedBytes: number;
  /** 文件数量 */
  fileCount: number;
  /** 按类别统计 */
  byCategory: Record<FileCategory, { usedBytes: number; fileCount: number }>;
}
