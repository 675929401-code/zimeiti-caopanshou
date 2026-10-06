/**
 * StorageManager — 存储模块核心管理器
 *
 * 职责：
 * 1. 根据配置加载并初始化 Provider（工厂模式）
 * 2. 对外暴露统一 API，内部委托给当前活跃 Provider
 * 3. 文件元数据写入数据库（user_files 表）
 * 4. 配置热加载：管理后台切换供应商后无需重启
 * 5. 降级策略：主供应商不可用时回退到备用供应商
 *
 * 使用方式：
 *   import { storageManager } from "@/storage/object";
 *   const result = await storageManager.upload(buffer, "photo.png", "image/png", { category: "image", userId });
 */
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
  FileCategory,
  UserFileRecord,
  UserStorageQuota,
} from "./types";
import { CozeS3Provider } from "./providers/coze-s3";
import { TencentCOSProvider } from "./providers/tencent-cos";
import { LocalProvider } from "./providers/local";
import { safeFetch } from "@/lib/safe-fetch";
import { safeUploadFileName, validateUploadBuffer } from "@/lib/file-upload-security";
import { cloudMediaRetentionTarget } from "@/lib/media-retention-policy";

// ── Provider 注册表 ──
const PROVIDER_REGISTRY: Record<StorageProviderType, new () => IStorageProvider> = {
  coze_s3: CozeS3Provider,
  tencent_cos: TencentCOSProvider,
  local: LocalProvider,
};

// ── 配置缓存有效期（5分钟） ──
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

const IS_PRODUCTION_RUNTIME =
  process.env.NODE_ENV === "production" || process.env.COZE_PROJECT_ENV === "PROD";
const ALLOW_LOCAL_STORAGE_IN_PRODUCTION =
  process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === "true";

const PROVIDER_CONFIG_KEY_ALIASES: Record<string, string> = {
  secret_id: "secretId",
  secret_key: "secretKey",
  endpoint_url: "endpointUrl",
  bucket_name: "bucketName",
  access_key: "accessKey",
};

function isProviderType(value: string | undefined): value is StorageProviderType {
  return Boolean(value && PROVIDER_REGISTRY[value as StorageProviderType]);
}

function dbValue(dbConfig: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = dbConfig[key]?.trim();
    if (value) return value;
  }
  return "";
}

function hasTencentCOSConfig(dbConfig: Record<string, string>): boolean {
  return Boolean(
    (dbValue(dbConfig, "storage_tencent_cos_secret_id", "storage_tencent_cos_secretId") ||
      process.env.COS_SECRET_ID) &&
      (dbValue(dbConfig, "storage_tencent_cos_secret_key", "storage_tencent_cos_secretKey") ||
        process.env.COS_SECRET_KEY) &&
      (dbValue(dbConfig, "storage_tencent_cos_bucket") || process.env.COS_BUCKET)
  );
}

function hasCozeS3Config(dbConfig: Record<string, string>): boolean {
  return Boolean(
    dbValue(dbConfig, "storage_coze_s3_endpoint_url", "storage_coze_s3_endpointUrl") ||
      process.env.COZE_BUCKET_ENDPOINT_URL
  );
}

function redactStorageConfig(config: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    redacted[key] = /secret|token|password|access[_-]?key/iu.test(key)
      ? value
        ? "<configured>"
        : ""
      : value;
  }
  return redacted;
}

class StorageManager {
  private providers = new Map<StorageProviderType, IStorageProvider>();
  private defaultProvider: StorageProviderType = "coze_s3";
  private fallbackProvider: StorageProviderType = "local";
  private initialized = false;
  private lastConfigLoad = 0;
  private currentConfig: Record<string, string> = {};
  private providerErrors = new Map<StorageProviderType, string>();

  // ── 初始化 ──
  async ensureInitialized(): Promise<void> {
    if (this.initialized && Date.now() - this.lastConfigLoad < CONFIG_CACHE_TTL) {
      return;
    }
    await this.loadConfig();
  }

  /** 从数据库 platform_settings 加载存储配置 */
  private async loadConfig(): Promise<void> {
    const dbConfig: Record<string, string> = {};

    try {
      const { getSupabaseClient } = await import("@/storage/database/supabase-client");
      const db = getSupabaseClient();
      const { data } = await db
        .from("platform_settings")
        .select("setting_key, setting_value")
        .like("setting_key", "storage_%");

      if (data && data.length > 0) {
        for (const row of data) {
          dbConfig[row.setting_key] = row.setting_value;
        }
      }
    } catch (e) {
      console.warn("[StorageManager] 数据库配置加载失败，使用环境变量:", e);
    }

    this.currentConfig = dbConfig;
    this.providerErrors.clear();

    // 管理后台/环境变量显式选择优先；未显式选择时按“真实可用配置”推断。
    // 不能把 coze_s3 当作固定默认值，否则 COS 已配置的生产环境会因缺少
    // COZE_BUCKET_ENDPOINT_URL 而静默写入本机磁盘。
    const configuredDefault =
      dbConfig.storage_default_provider?.trim() || process.env.STORAGE_DEFAULT_PROVIDER?.trim();
    if (isProviderType(configuredDefault)) {
      this.defaultProvider = configuredDefault;
    } else if (hasTencentCOSConfig(dbConfig)) {
      this.defaultProvider = "tencent_cos";
    } else if (hasCozeS3Config(dbConfig)) {
      this.defaultProvider = "coze_s3";
    } else {
      this.defaultProvider = "local";
    }

    const configuredFallback =
      dbConfig.storage_fallback_provider?.trim() || process.env.STORAGE_FALLBACK_PROVIDER?.trim();
    if (
      isProviderType(configuredFallback) &&
      !(
        IS_PRODUCTION_RUNTIME &&
        configuredFallback === "local" &&
        !ALLOW_LOCAL_STORAGE_IN_PRODUCTION
      )
    ) {
      this.fallbackProvider = configuredFallback;
    } else {
      // 生产环境默认 fail-closed；开发环境仍可回退本机，便于离线开发。
      this.fallbackProvider = IS_PRODUCTION_RUNTIME ? this.defaultProvider : "local";
    }

    // 初始化默认 Provider
    await this.initProvider(this.defaultProvider, dbConfig);

    // 初始化回退 Provider（如果是不同的）
    if (this.fallbackProvider !== this.defaultProvider) {
      await this.initProvider(this.fallbackProvider, dbConfig);
    }

    this.lastConfigLoad = Date.now();
    this.initialized = true;
  }

  /** 初始化单个 Provider */
  private async initProvider(type: StorageProviderType, dbConfig: Record<string, string>): Promise<boolean> {
    if (this.providers.has(type)) return true;

    if (
      type === "local" &&
      IS_PRODUCTION_RUNTIME &&
      !ALLOW_LOCAL_STORAGE_IN_PRODUCTION
    ) {
      const message =
        "生产环境禁止使用本机对象存储；请配置腾讯 COS/Coze S3，或在明确接受单机持久化风险后设置 ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true";
      this.providerErrors.set(type, message);
      console.error(`[StorageManager] Provider ${type} 初始化失败: ${message}`);
      return false;
    }

    const ProviderClass = PROVIDER_REGISTRY[type];
    if (!ProviderClass) {
      console.error(`[StorageManager] 未注册的供应商类型: ${type}`);
      this.providerErrors.set(type, "未注册的供应商类型");
      return false;
    }

    const provider = new ProviderClass();

    // 按 type 提取对应的配置前缀
    const configPrefix = `storage_${type}_`;
    const providerConfig: Record<string, string> = {};

    for (const [key, value] of Object.entries(dbConfig)) {
      if (key.startsWith(configPrefix)) {
        // 去掉前缀，并兼容管理后台常见的 snake_case 键。
        const shortKey = key.slice(configPrefix.length);
        providerConfig[PROVIDER_CONFIG_KEY_ALIASES[shortKey] || shortKey] = value;
      }
    }

    // 补充环境变量回退
    if (type === "coze_s3") {
      providerConfig.endpointUrl = providerConfig.endpointUrl || process.env.COZE_BUCKET_ENDPOINT_URL || "";
      providerConfig.bucketName = providerConfig.bucketName || process.env.COZE_BUCKET_NAME || "";
    }
    if (type === "tencent_cos") {
      providerConfig.secretId = providerConfig.secretId || process.env.COS_SECRET_ID || "";
      providerConfig.secretKey = providerConfig.secretKey || process.env.COS_SECRET_KEY || "";
      providerConfig.bucket = providerConfig.bucket || process.env.COS_BUCKET || "";
      providerConfig.region = providerConfig.region || process.env.COS_REGION || "ap-guangzhou";
    }

    try {
      await provider.initialize(providerConfig);
      this.providers.set(type, provider);
      this.providerErrors.delete(type);
      console.log(`[StorageManager] Provider ${type} 初始化成功`);
      return true;
    } catch (e) {
      console.error(`[StorageManager] Provider ${type} 初始化失败:`, e);
      this.providerErrors.set(type, e instanceof Error ? e.message : "初始化失败");
      // 保留配置的默认供应商身份，避免状态接口把失败伪装成成功回退。
      return false;
    }
  }

  /** 获取活跃 Provider */
  private async getProvider(type?: StorageProviderType): Promise<IStorageProvider> {
    await this.ensureInitialized();
    const targetType = type || this.defaultProvider;
    if (!this.providers.has(targetType)) {
      await this.initProvider(targetType, this.currentConfig);
    }
    const provider = this.providers.get(targetType);
    if (!provider) {
      throw new Error(`[StorageManager] Provider ${targetType} 未初始化`);
    }
    return provider;
  }

  // ═══════════════════════════════════════════
  //  公共 API — 统一代理到 Provider
  // ═══════════════════════════════════════════

  /** 上传文件（自动记录元数据） */
  async upload(
    fileContent: Buffer,
    fileName: string,
    contentType: string,
    options?: StorageUploadOptions
  ): Promise<StorageUploadResult> {
    const targetType = options?.providerType as StorageProviderType | undefined;
    let result: StorageUploadResult;
    try {
      const provider = await this.getProvider(targetType);
      result = await provider.upload(fileContent, fileName, contentType, options);
    } catch (primaryErr) {
      if (options?.strictProvider) throw primaryErr;
      // ★ 运行时降级：默认供应商失败（如未配置 COZE_BUCKET）时回退到备用供应商
      const fallback = await this.tryGetFallbackProvider(targetType);
      if (fallback && fallback.type !== (targetType || this.defaultProvider)) {
        console.warn(`[StorageManager] 主供应商(${targetType || this.defaultProvider})上传失败，回退到 ${fallback.type}:`, primaryErr instanceof Error ? primaryErr.message : primaryErr);
        result = await fallback.upload(fileContent, fileName, contentType, options);
      } else {
        throw primaryErr;
      }
    }

    if (options?.userId && options.requireOwnershipRecord) {
      await this.recordFileMeta(result, options);
    } else {
      this.recordMetaSafe(result, options);
    }
    return result;
  }

  /** 从 URL 下载并上传 */
  async uploadFromUrl(
    url: string,
    options?: StorageUploadOptions,
    networkOptions: { networkPolicy?: "default" | "fixed-public-dns-pinned" | "system-dns-pinned"; trustedHostnames?: string[] } = { networkPolicy: "system-dns-pinned" },
  ): Promise<StorageUploadResult> {
    const downloaded = await safeFetch(url, {
      maxBytes: 100 * 1024 * 1024,
      // 供应商视频 CDN 可能较慢（实测 ~5MB 需 13s+），15s 会误杀合法转存。
      timeoutMs: 120_000,
      maxRedirects: 3,
      // Keep the socket pinned to the validated public address by default.
      // A caller may supply one exact, independently reviewed CDN hostname for
      // local proxy DNS environments; arbitrary URLs never receive that bypass.
      ...networkOptions,
    });
    const validated = validateUploadBuffer(downloaded.buffer, downloaded.contentType);
    const safeName = safeUploadFileName(validated.extension);
    return this.upload(downloaded.buffer, safeName, validated.contentType, {
      ...options,
      fileName: safeName,
    });
  }

  /** 元数据写入（不阻塞上传返回） */
  private recordMetaSafe(result: StorageUploadResult, options?: StorageUploadOptions): void {
    if (options?.userId) {
      this.recordFileMeta(result, options).catch((e) =>
        console.warn("[StorageManager] 文件元数据写入失败:", e)
      );
    }
  }

  /** 尝试获取备用供应商（初始化失败时返回 null） */
  private async tryGetFallbackProvider(targetType?: StorageProviderType): Promise<IStorageProvider | null> {
    try {
      await this.ensureInitialized();
      const primary = targetType || this.defaultProvider;
      if (this.fallbackProvider === primary) return null;
      if (!this.providers.has(this.fallbackProvider)) {
        await this.initProvider(this.fallbackProvider, this.currentConfig);
      }
      return this.providers.get(this.fallbackProvider) || null;
    } catch (e) {
      console.error("[StorageManager] 获取备用供应商失败:", e);
      return null;
    }
  }

  /** 读取文件 */
  async read(key: string, providerType?: StorageProviderType): Promise<Buffer> {
    const provider = await this.getProvider(providerType);
    return provider.read(key);
  }

  /** Never fall back to an unbounded read or an arbitrary external URL. */
  async readBounded(key: string, maxBytes: number, timeoutMs: number, providerType: StorageProviderType): Promise<Buffer> {
    const provider = await this.getProvider(providerType);
    if (!provider.readBounded) throw new Error("STORAGE_BOUNDED_READ_UNAVAILABLE");
    return provider.readBounded(key, maxBytes, timeoutMs);
  }

  /** 检查文件是否存在 */
  async exists(key: string, providerType?: StorageProviderType): Promise<boolean> {
    const provider = await this.getProvider(providerType);
    return provider.exists(key);
  }

  /** 获取签名 URL */
  async getSignedUrl(key: string, options?: StorageSignedUrlOptions, providerType?: StorageProviderType): Promise<string> {
    const provider = await this.getProvider(providerType);
    return provider.getSignedUrl(key, options);
  }

  /** Generate a short-lived browser PUT grant for one server-owned object key. */
  async createDirectUploadTicket(
    request: StorageDirectUploadRequest,
    providerType: StorageProviderType = "tencent_cos"
  ): Promise<StorageDirectUploadTicket> {
    const provider = await this.getProvider(providerType);
    if (!provider.createDirectUploadTicket) {
      throw new Error(`[StorageManager] Provider ${providerType} 不支持浏览器直传`);
    }
    return provider.createDirectUploadTicket(request);
  }

  /** Read a small byte range without buffering the whole object in the web process. */
  async readRange(
    key: string,
    start: number,
    endInclusive: number,
    providerType: StorageProviderType = "tencent_cos"
  ): Promise<Buffer> {
    const provider = await this.getProvider(providerType);
    if (!provider.readRange) {
      throw new Error(`[StorageManager] Provider ${providerType} 不支持范围读取`);
    }
    return provider.readRange(key, start, endInclusive);
  }

  /** 删除文件（同时清理元数据） */
  async delete(key: string, providerType?: StorageProviderType): Promise<boolean> {
    const provider = await this.getProvider(providerType);
    const ok = await provider.delete(key);

    // 异步清理元数据
    this.deleteFileMeta(key).catch((e: unknown) => { console.error("[storage-manager] deleteFileMeta failed:", e instanceof Error ? e.message : e); });

    return ok;
  }

  /** Delete only the object bytes. Upload-session code owns its scoped row CAS. */
  async deleteObjectOnly(key: string, providerType?: StorageProviderType): Promise<boolean> {
    const provider = await this.getProvider(providerType);
    return provider.delete(key);
  }

  /** 批量删除 */
  async deleteBatch(keys: string[], providerType?: StorageProviderType): Promise<number> {
    const provider = await this.getProvider(providerType);
    const count = await provider.deleteBatch(keys);

    // 异步批量清理元数据
    this.deleteFileMetaBatch(keys).catch(() => {});

    return count;
  }

  /** 列出文件 */
  async list(options?: StorageListOptions, providerType?: StorageProviderType): Promise<StorageListResult> {
    const provider = await this.getProvider(providerType);
    return provider.list(options);
  }

  /** 获取文件元信息 */
  async head(key: string, providerType?: StorageProviderType): Promise<{ size: number; contentType: string; lastModified: Date } | null> {
    const provider = await this.getProvider(providerType);
    return provider.head(key);
  }

  // ═══════════════════════════════════════════
  //  元数据管理
  // ═══════════════════════════════════════════

  /** 写入文件元数据到 user_files 表 */
  private async recordFileMeta(result: StorageUploadResult, options: StorageUploadOptions): Promise<void> {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const db = getSupabaseClient();
    const retentionTarget = cloudMediaRetentionTarget(result.key);
    const { error } = await db.from("user_files").insert({
      user_id: options.userId,
      storage_key: result.key,
      storage_provider: result.provider,
      file_name: options.fileName || result.key.split("/").pop() || "unknown",
      file_category: result.category,
      file_size: result.size,
      content_type: result.contentType,
      source: options.source || null,
      meta: retentionTarget
        ? {
            ...(options.meta || {}),
            cloudRetentionPolicyVersion: retentionTarget.policyVersion,
            cloudRetentionRuleId: retentionTarget.ruleId,
            cloudRetentionClass: retentionTarget.retentionClass,
            cloudRetentionDays: String(retentionTarget.days),
            cloudRetentionTargetAt: retentionTarget.targetExpiresAt,
            cloudRetentionEnforcement: retentionTarget.enforcement,
          }
        : options.meta || null,
      is_public: result.isPublic,
    });
    if (error) throw error;
  }

  /** 删除文件元数据 */
  private async deleteFileMeta(key: string): Promise<void> {
    try {
      const { getSupabaseClient } = await import("@/storage/database/supabase-client");
      const db = getSupabaseClient();
      await db.from("user_files").delete().eq("storage_key", key);
    } catch {}
  }

  /** 批量删除文件元数据 */
  private async deleteFileMetaBatch(keys: string[]): Promise<void> {
    try {
      const { getSupabaseClient } = await import("@/storage/database/supabase-client");
      const db = getSupabaseClient();
      await db.from("user_files").delete().in("storage_key", keys);
    } catch {}
  }

  // ═══════════════════════════════════════════
  //  用户文件查询 & 配额
  // ═══════════════════════════════════════════

  /** 查询用户文件列表 */
  async listUserFiles(
    userId: string,
    options?: { category?: FileCategory; limit?: number; offset?: number }
  ): Promise<UserFileRecord[]> {
    await this.ensureInitialized();
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const db = getSupabaseClient();

    const limit = Math.max(1, options?.limit || 50);
    const offset = Math.max(0, options?.offset || 0);
    let query = db
      .from("user_files")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (options?.category) query = query.eq("file_category", options.category);

    const { data, error } = await query;
    if (error) throw error;
    return (data || []) as UserFileRecord[];
  }

  /** 查询当前用户文件总数（用于服务端分页；不返回 storage_key） */
  async countUserFiles(userId: string, category?: FileCategory): Promise<number> {
    await this.ensureInitialized();
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const db = getSupabaseClient();
    let query = db
      .from("user_files")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (category) query = query.eq("file_category", category);
    const { count, error } = await query;
    if (error) throw error;
    return Number(count) || 0;
  }

  /** 获取用户存储配额统计 */
  async getUserQuota(userId: string): Promise<UserStorageQuota> {
    await this.ensureInitialized();
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const db = getSupabaseClient();

    const { data, error } = await db
      .from("user_files")
      .select("file_category, file_size")
      .eq("user_id", userId);

    if (error) throw error;

    const byCategory = {} as Record<FileCategory, { usedBytes: number; fileCount: number }>;
    const categories: FileCategory[] = ["image", "video", "document", "audio", "archive", "other"];
    for (const c of categories) byCategory[c] = { usedBytes: 0, fileCount: 0 };

    let totalBytes = 0;
    let totalCount = 0;
    for (const row of data || []) {
      const cat = (row.file_category as FileCategory) || "other";
      const size = Number(row.file_size) || 0;
      if (byCategory[cat]) {
        byCategory[cat].usedBytes += size;
        byCategory[cat].fileCount += 1;
      }
      totalBytes += size;
      totalCount += 1;
    }

    return { usedBytes: totalBytes, fileCount: totalCount, byCategory };
  }

  // ═══════════════════════════════════════════
  //  管理工具
  // ═══════════════════════════════════════════

  /** 获取当前存储配置信息 */
  async getStatus(): Promise<{
    defaultProvider: StorageProviderType;
    fallbackProvider: StorageProviderType;
    initializedProviders: StorageProviderType[];
    config: Record<string, string>;
    runtimeMode: "production" | "development";
    productionSafe: boolean;
    degraded: boolean;
    issues: string[];
  }> {
    await this.ensureInitialized();
    const initializedProviders = Array.from(this.providers.keys());
    const issues: string[] = [];
    if (!this.providers.has(this.defaultProvider)) {
      issues.push(
        `默认对象存储 ${this.defaultProvider} 未初始化：${this.providerErrors.get(this.defaultProvider) || "配置不可用"}`
      );
    }
    if (
      IS_PRODUCTION_RUNTIME &&
      !ALLOW_LOCAL_STORAGE_IN_PRODUCTION &&
      (this.defaultProvider === "local" || initializedProviders.includes("local"))
    ) {
      issues.push("生产环境不得使用本机对象存储");
    }
    for (const [provider, error] of this.providerErrors) {
      const issue = `对象存储 ${provider}：${error}`;
      if (!issues.includes(issue) && provider !== this.defaultProvider) issues.push(issue);
    }
    const productionSafe =
      this.providers.has(this.defaultProvider) &&
      (!IS_PRODUCTION_RUNTIME ||
        ALLOW_LOCAL_STORAGE_IN_PRODUCTION ||
        (this.defaultProvider !== "local" && !initializedProviders.includes("local")));
    return {
      defaultProvider: this.defaultProvider,
      fallbackProvider: this.fallbackProvider,
      initializedProviders,
      config: redactStorageConfig(this.currentConfig),
      runtimeMode: IS_PRODUCTION_RUNTIME ? "production" : "development",
      productionSafe,
      degraded: issues.length > 0,
      issues,
    };
  }

  /** 强制重新加载配置（管理后台切换供应商后调用） */
  async reloadConfig(): Promise<void> {
    this.initialized = false;
    this.lastConfigLoad = 0;
    // 清理旧 Provider
    for (const [, provider] of this.providers) {
      try { await provider.dispose?.(); } catch {}
    }
    this.providers.clear();
    await this.ensureInitialized();
  }

  /** 管理员：获取全局存储统计 */
  async getGlobalStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    byCategory: Record<string, { count: number; size: number }>;
    byProvider: Record<string, { count: number; size: number }>;
  }> {
    await this.ensureInitialized();
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const db = getSupabaseClient();

    const { data, error } = await db
      .from("user_files")
      .select("file_category, file_size, storage_provider");

    if (error) throw error;

    const byCategory: Record<string, { count: number; size: number }> = {};
    const byProvider: Record<string, { count: number; size: number }> = {};
    let totalFiles = 0;
    let totalSize = 0;

    for (const row of data || []) {
      const cat = row.file_category || "other";
      const prov = row.storage_provider || "unknown";
      const size = Number(row.file_size) || 0;

      byCategory[cat] = byCategory[cat] || { count: 0, size: 0 };
      byCategory[cat].count += 1;
      byCategory[cat].size += size;

      byProvider[prov] = byProvider[prov] || { count: 0, size: 0 };
      byProvider[prov].count += 1;
      byProvider[prov].size += size;

      totalFiles += 1;
      totalSize += size;
    }

    return { totalFiles, totalSize, byCategory, byProvider };
  }
}

// ── 单例导出 ──
export const storageManager = new StorageManager();
