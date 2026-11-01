import type { StoryboardVisualAssetDraft } from "./storyboard-visual-asset-workspace";

export type ReferenceUploadPending = {
  id: string;
  contextId: string;
  contextKind: "project" | "reference-session";
  draft: StoryboardVisualAssetDraft;
  sha256: string;
  byteLength: number;
  contentType: string;
  status: "uploading" | "unknown" | "uploaded";
  storageKey?: string;
};
type UploadStorage = Pick<Storage, "getItem" | "setItem">;
const keyOf = (userId: string) => `storyboard-reference-uploads:v1:${encodeURIComponent(userId)}`;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
function validate(items: unknown): asserts items is ReferenceUploadPending[] {
  if (!Array.isArray(items) || items.length > 32) throw new Error("参考图上传记录无法读取，原记录已保留。");
  const ids = new Set<string>();
  for (const item of items as ReferenceUploadPending[]) {
    if (!item || typeof item.id !== "string" || ids.has(item.id) || !item.contextId || !["project", "reference-session"].includes(item.contextKind)
      || !item.draft?.planId || !["character", "pet", "environment", "prop"].includes(item.draft.role)
      || typeof item.draft.name !== "string" || typeof item.draft.prompt !== "string" || typeof item.draft.tagsText !== "string" || typeof item.draft.customCategory !== "string"
      || !/^[a-f0-9]{64}$/u.test(item.sha256) || !Number.isSafeInteger(item.byteLength) || item.byteLength <= 0 || item.byteLength > 5 * 1024 * 1024
      || !TYPES.has(item.contentType) || !["uploading", "unknown", "uploaded"].includes(item.status)
      || (item.status === "uploaded" && !item.storageKey)
      || (item.storageKey !== undefined && (typeof item.storageKey !== "string" || !item.storageKey || item.storageKey.length > 2048 || /[:\\\u0000\r\n]/u.test(item.storageKey) || item.storageKey.startsWith("/") || item.storageKey.split("/").includes("..")))) {
      throw new Error("参考图上传记录无法读取，原记录已保留。");
    }
    ids.add(item.id);
  }
}
export function readReferenceUploadPending(storage: UploadStorage, userId: string): ReferenceUploadPending[] {
  if (!userId) throw new Error("请先登录后读取参考图。");
  const raw = storage.getItem(keyOf(userId));
  if (!raw) return [];
  let items: unknown;
  try { items = JSON.parse(raw); } catch { throw new Error("参考图上传记录无法读取，原记录已保留。"); }
  validate(items);
  return items;
}
export function writeReferenceUploadPending(storage: UploadStorage, userId: string, pending: ReferenceUploadPending | null, removeId?: string) {
  const items = readReferenceUploadPending(storage, userId).filter(item => item.id !== (pending?.id || removeId));
  if (pending) items.push(pending);
  validate(items);
  // Explicit projection: never persist a token, signed URL, file bytes, or additional response fields.
  const serialized = JSON.stringify(items.map(item => ({ id: item.id, contextId: item.contextId, contextKind: item.contextKind,
    draft: { planId: item.draft.planId, role: item.draft.role, name: item.draft.name, prompt: item.draft.prompt, tagsText: item.draft.tagsText, customCategory: item.draft.customCategory },
    sha256: item.sha256, byteLength: item.byteLength, contentType: item.contentType, status: item.status, storageKey: item.storageKey })));
  storage.setItem(keyOf(userId), serialized);
  if (storage.getItem(keyOf(userId)) !== serialized) throw new Error("上传记录未能保存，请允许本地存储后再试。");
}
export async function describeReferenceUpload(file: File) {
  if (!TYPES.has(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error("请选择 5MB 以内的 PNG、JPG 或 WebP 参考图。");
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("");
  return { sha256, byteLength: file.size, contentType: file.type };
}

/** Only an explicit file selection calls upload. Resuming a confirmed key never uploads again. */
export async function resolveReferenceUpload<T>(input: {
  pending: ReferenceUploadPending;
  file?: File;
  persist: (pending: ReferenceUploadPending | null, removeId?: string) => void;
  stillCurrent: () => boolean;
  upload: (file: File) => Promise<{ storageKey: string }>;
  readOwned: (storageKey: string) => Promise<{ assetId: string; storageKey: string; url: string }>;
  register: (owned: { assetId: string; storageKey: string; url: string }, pending: ReferenceUploadPending) => Promise<T | null>;
}): Promise<T> {
  let pending = input.pending;
  if (!input.stillCurrent()) throw new Error("参考位置已变化，未上传或替换当前图片。");
  if (!pending.storageKey) {
    if (!input.file || pending.status !== "uploading") throw new Error("上传结果尚未确认，请在我的图片中核对原图，勿重复上传。");
    input.persist(pending);
    try {
      const uploaded = await input.upload(input.file);
      pending = { ...pending, storageKey: uploaded.storageKey, status: "uploaded" };
      // Preserve the original scope even when navigation or identity changed during upload.
      input.persist(pending);
    } catch (error) {
      if (!pending.storageKey) input.persist({ ...pending, status: "unknown" });
      throw error;
    }
  }
  if (!input.stillCurrent()) throw new Error("原图已上传，原参考位置记录已保留；未替换当前图片。");
  const owned = await input.readOwned(pending.storageKey!);
  if (!owned.assetId || owned.storageKey !== pending.storageKey || !owned.url) throw new Error("图片归属未确认，原上传记录已保留。");
  if (!input.stillCurrent()) throw new Error("参考位置已变化，原上传记录已保留。");
  const result = await input.register(owned, pending);
  if (!result) throw new Error("图片已上传，候选保存未确认；可重新读取上传图。");
  if (!input.stillCurrent()) throw new Error("参考位置已变化，请返回原参考位置读取已上传图片。");
  input.persist(null, pending.id);
  return result;
}
