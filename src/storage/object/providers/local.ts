/**
 * Local Filesystem Storage Provider
 * 开发测试和临时回退用。
 * 开发环境→public/uploads，生产环境必须显式挂载 STORAGE_LOCAL_BASE_PATH。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  IStorageProvider, StorageProviderType, StorageUploadOptions,
  StorageUploadResult, StorageListOptions,
  StorageListResult, StorageListItem, FileCategory,
} from "../types";
import { safeFetch } from "@/lib/safe-fetch";
import { validateUploadBuffer } from "@/lib/file-upload-security";

const CATEGORY_PREFIX: Record<FileCategory, string> = {
  image: "images/", video: "videos/", document: "docs/",
  audio: "audio/", archive: "archives/", other: "misc/",
};

export function resolvePathWithinRoot(basePath: string, key: string): string {
  const resolvedBase = path.resolve(/* turbopackIgnore: true */ basePath);
  const resolvedPath = path.resolve(/* turbopackIgnore: true */ resolvedBase, key);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error("Invalid storage path");
  }
  return resolvedPath;
}

function safeExtension(fileName: string): string {
  const extension = path.extname(path.basename(fileName)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : "";
}

function safePrefix(prefix: string): string {
  const segments = prefix.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => !/^[a-z0-9_-]{1,40}$/i.test(segment))) {
    throw new Error("Invalid storage prefix");
  }
  return `${segments.join("/")}/`;
}

export class LocalProvider implements IStorageProvider {
  readonly type: StorageProviderType = "local";
  private basePath = "";
  private urlPrefix = "";
  private config: Record<string, string> = {};

  async initialize(config: Record<string, string>): Promise<void> {
    this.config = config;
    const isDev = process.env.COZE_PROJECT_ENV !== "PROD";
    const productionBasePath = process.env.STORAGE_LOCAL_BASE_PATH?.trim();

    // ★ 开发环境：优先写项目 public/uploads（Next.js 自动作为静态资源服务，URL 与 /uploads 前缀匹配）
    //   显式配置 basePath > 环境变量 > 项目 public 目录 > workspace 兼容目录
    let resolvedBase: string;
    if (config.basePath) {
      resolvedBase = config.basePath;
    } else if (isDev) {
      resolvedBase = process.env.STORAGE_LOCAL_BASE_PATH || path.join(/* turbopackIgnore: true */ process.cwd(), "public", "uploads");
    } else {
      if (!productionBasePath || !path.isAbsolute(productionBasePath)) {
        throw new Error("STORAGE_LOCAL_BASE_PATH must be an absolute persistent path in production");
      }
      resolvedBase = productionBasePath;
    }
    this.basePath = path.resolve(/* turbopackIgnore: true */ resolvedBase);

    if (isDev) {
      const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT || "http://127.0.0.1:5000";
      this.urlPrefix = `${domain}/uploads`;
    } else {
      this.urlPrefix = "/uploads";
    }

    const fs = await import("fs/promises");
    await fs.mkdir(/* turbopackIgnore: true */ this.basePath, { recursive: true });
    console.log("[LocalStorage] 初始化成功:", this.basePath);
  }

  private buildPath(fileName: string, category: FileCategory, options?: StorageUploadOptions): string {
    const prefix = safePrefix(options?.prefix || CATEGORY_PREFIX[category]);
    const extension = safeExtension(options?.fileName || fileName);
    const name = `${randomUUID()}${extension}`;
    const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    return `${prefix}${datePath}/${name}`;
  }

  async upload(fileContent: Buffer, fileName: string, contentType: string, options?: StorageUploadOptions): Promise<StorageUploadResult> {
    const fs = await import("fs/promises");
    const validated = validateUploadBuffer(fileContent, contentType);
    const category: FileCategory = options?.category || "other";
    const relativePath = this.buildPath(fileName, category, {
      ...options,
      fileName: `validated-upload${validated.extension}`,
    });
    const fullPath = resolvePathWithinRoot(this.basePath, relativePath);
    await fs.mkdir(/* turbopackIgnore: true */ path.dirname(fullPath), { recursive: true });
    const temporaryPath = path.join(/* turbopackIgnore: true */ path.dirname(fullPath), `.${path.basename(fullPath)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(/* turbopackIgnore: true */ temporaryPath, "wx", 0o644);
      await handle.writeFile(fileContent);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(/* turbopackIgnore: true */ temporaryPath, fullPath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(/* turbopackIgnore: true */ temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      key: relativePath, url: `${this.urlPrefix}/${relativePath}`,
      isPublic: options?.publicRead !== false, size: fileContent.length,
      contentType: validated.contentType, provider: this.type, category,
    };
  }

  async uploadFromUrl(url: string, options?: StorageUploadOptions): Promise<StorageUploadResult> {
    const response = await safeFetch(url, { maxBytes: 100 * 1024 * 1024, timeoutMs: 15_000 });
    const validated = validateUploadBuffer(response.buffer, response.contentType);
    return this.upload(response.buffer, `${randomUUID()}${validated.extension}`, validated.contentType, options);
  }

  async read(key: string): Promise<Buffer> {
    const fs = await import("fs/promises");
    return fs.readFile(/* turbopackIgnore: true */ resolvePathWithinRoot(this.basePath, key));
  }

  async exists(key: string): Promise<boolean> {
    const fs = await import("fs/promises");
    try { await fs.access(/* turbopackIgnore: true */ resolvePathWithinRoot(this.basePath, key)); return true; } catch { return false; }
  }

  async getSignedUrl(key: string): Promise<string> {
    resolvePathWithinRoot(this.basePath, key);
    const encodedKey = key.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
    return `${this.urlPrefix}/${encodedKey}`;
  }

  async delete(key: string): Promise<boolean> {
    const fs = await import("fs/promises");
    try { await fs.unlink(/* turbopackIgnore: true */ resolvePathWithinRoot(this.basePath, key)); return true; } catch { return false; }
  }

  async deleteBatch(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) { if (await this.delete(k)) n++; }
    return n;
  }

  async list(options?: StorageListOptions): Promise<StorageListResult> {
    const fs = await import("fs/promises");
    const items: StorageListItem[] = [];
    const prefix = options?.prefix ? safePrefix(options.prefix) : "";
    const maxKeys = options?.maxKeys || 100;

    const scan = async (dir: string, rel: string) => {
      if (items.length >= maxKeys) return;
      let entries;
      try { entries = await fs.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (items.length >= maxKeys) break;
        const fp = path.join(/* turbopackIgnore: true */ dir, e.name);
        const rp = path.join(/* turbopackIgnore: true */ rel, e.name);
        if (e.isDirectory()) { await scan(fp, rp); }
        else if (!prefix || rp.startsWith(prefix)) {
          const st = await fs.stat(/* turbopackIgnore: true */ fp);
          items.push({ key: rp, size: st.size, lastModified: st.mtime, contentType: null });
        }
      }
    };
    await scan(this.basePath, "");
    return { items, hasMore: false };
  }

  async head(key: string): Promise<{ size: number; contentType: string; lastModified: Date } | null> {
    const fs = await import("fs/promises");
    try {
      const st = await fs.stat(/* turbopackIgnore: true */ resolvePathWithinRoot(this.basePath, key));
      return { size: st.size, contentType: "application/octet-stream", lastModified: st.mtime };
    } catch { return null; }
  }

  async dispose(): Promise<void> { /* no-op */ }
}
