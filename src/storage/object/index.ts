/**
 * 存储模块统一导出入口
 *
 * 使用方式：
 *   import { storageManager } from "@/storage/object";
 *   const result = await storageManager.upload(buffer, "photo.png", "image/png", { category: "image" });
 */

// 核心管理器（单例）
export { storageManager } from "./manager";

// 类型定义
export type {
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
  StorageProviderConfig,
  FileCategory,
  UserFileRecord,
  UserStorageQuota,
} from "./types";

// Provider 实现（按需导入）
export { CozeS3Provider } from "./providers/coze-s3";
export { TencentCOSProvider } from "./providers/tencent-cos";
export { LocalProvider } from "./providers/local";
