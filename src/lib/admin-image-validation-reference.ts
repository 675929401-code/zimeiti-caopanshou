import type { ImageValidationDto, ImageValidationInputs } from "@/components/admin-image-validation-state";

export type AdminValidationReferenceScope = { userId: string; modelId: string; configurationHash: string; index: number };
export type AdminValidationReferencePending = AdminValidationReferenceScope & {
  status: "uploading" | "unknown" | "uploaded" | "ready";
  storageKey?: string;
};
type ReferenceStorage = Pick<Storage, "getItem" | "setItem">;
const storageKey = (userId: string) => `admin-image-validation-reference:v1:${encodeURIComponent(userId)}`;
export function sameAdminValidationReferenceScope(left: AdminValidationReferenceScope, right: AdminValidationReferenceScope) {
  return left.userId === right.userId && left.modelId === right.modelId && left.configurationHash === right.configurationHash && left.index === right.index;
}
function assertPending(value: AdminValidationReferencePending, userId: string) {
  if (!value || value.userId !== userId || !value.modelId || !/^[a-f0-9]{64}$/u.test(value.configurationHash) || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 7
    || !["uploading", "unknown", "uploaded", "ready"].includes(value.status) || (["uploaded", "ready"].includes(value.status) && !value.storageKey)
    || (value.storageKey !== undefined && (typeof value.storageKey !== "string" || !value.storageKey || value.storageKey.length > 2048 || /[:\\\u0000\r\n]/u.test(value.storageKey) || value.storageKey.startsWith("/") || value.storageKey.split("/").includes("..")))) throw new Error("参考图上传记录无法确认，原记录已保留。");
}
export function readAdminValidationReferences(storage: ReferenceStorage, userId: string): AdminValidationReferencePending[] {
  const raw = storage.getItem(storageKey(userId));
  if (!raw) return [];
  let values: AdminValidationReferencePending[];
  try { values = JSON.parse(raw); } catch { throw new Error("参考图上传记录无法读取，原记录已保留。"); }
  if (!Array.isArray(values) || values.length > 64) throw new Error("参考图上传记录无法读取，原记录已保留。");
  values.forEach(value => assertPending(value, userId));
  return values;
}
export function restoreAdminValidationReferenceInputs(dto: Pick<ImageValidationDto, "modelId" | "configurationHash" | "capabilities">, inputs: ImageValidationInputs, pending: AdminValidationReferencePending[], userId: string): ImageValidationInputs {
  const matching = pending.filter(item => item.userId === userId && item.modelId === dto.modelId && item.configurationHash === dto.configurationHash);
  if (!matching.length) return inputs;
  const count = Math.max(inputs.referenceImageUrls.length, ...matching.map(item => item.index + 1));
  if (!dto.capabilities.supportsReferenceInput || count > Math.min(8, dto.capabilities.maxReferenceImages)) throw new Error("当前模型无法显示原上传位置，原记录已保留，请核对配置后再读取。");
  return { ...inputs, referenceMode: true, referenceImageUrls: Array.from({ length: count }, (_, index) => inputs.referenceImageUrls[index] || "") };
}
export function writeAdminValidationReference(storage: ReferenceStorage, pending: AdminValidationReferencePending) {
  assertPending(pending, pending.userId);
  const values = [...readAdminValidationReferences(storage, pending.userId).filter(value => !sameAdminValidationReferenceScope(value, pending)), pending];
  if (values.length > 64) throw new Error("参考图上传记录已满，原记录已保留。");
  const raw = JSON.stringify(values.map(value => ({ userId: value.userId, modelId: value.modelId, configurationHash: value.configurationHash, index: value.index, status: value.status, storageKey: value.storageKey })));
  storage.setItem(storageKey(pending.userId), raw);
  if (storage.getItem(storageKey(pending.userId)) !== raw) throw new Error("上传记录无法保存，请保留当前页面，勿重复上传。");
}

export async function resolveAdminValidationReference(input: {
  scope: AdminValidationReferenceScope;
  pending?: AdminValidationReferencePending;
  file?: File;
  token: string;
  fetcher: typeof fetch;
  persist: (pending: AdminValidationReferencePending) => void;
  stillCurrent: () => boolean;
  decode: (url: string) => Promise<void>;
}) {
  const fetcher = input.fetcher;
  if (!input.token || !input.stillCurrent()) throw new Error("验证配置或账号已变化，未上传或替换参考图。");
  let pending = input.pending;
  if (pending && !sameAdminValidationReferenceScope(pending, input.scope)) throw new Error("原上传记录不属于当前验证位置。");
  if (!pending) {
    if (!input.file || input.file.size <= 0 || input.file.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(input.file.type)) throw new Error("请选择 5MB 以内的 PNG、JPG 或 WebP 图片。");
    pending = { ...input.scope, status: "uploading" };
    input.persist(pending);
    const body = new FormData(); body.set("file", input.file); body.set("category", "image"); body.set("source", "admin-image-validation-reference");
    try {
      const response = await fetcher("/api/storage/upload", { method: "POST", headers: { Authorization: `Bearer ${input.token}` }, body, redirect: "error", signal: AbortSignal.timeout(60000) });
      const data = await response.json() as { success?: boolean; file?: { key?: string }; error?: string };
      if (!response.ok || data.success !== true || !data.file?.key) throw new Error("上传结果未确认，请到我的图片核对原图，勿重复上传。");
      pending = { ...input.scope, status: "uploaded", storageKey: data.file.key };
      // A private object may legitimately have no public upload URL. Keep its stable key first.
      input.persist(pending);
    } catch (error) {
      if (!pending.storageKey) input.persist({ ...pending, status: "unknown" });
      throw error;
    }
  } else if (input.file) throw new Error("此位置已有上传记录，请重新读取已上传图，勿重复上传。");
  if (!pending.storageKey) throw new Error("上传结果待确认，请到我的图片核对原图，勿重复上传。");
  if (!input.stillCurrent()) throw new Error("原图已上传，原位置记录已保留；未替换当前参考图。");
  const response = await fetcher(`/api/storyboard/image?${new URLSearchParams({ storageKey: pending.storageKey })}`, { headers: { Authorization: `Bearer ${input.token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
  const owned = await response.json() as { url?: string; assetId?: string; storageKey?: string };
  if (!response.ok || !owned.url || !owned.assetId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(owned.assetId) || owned.storageKey !== pending.storageKey) throw new Error("图片归属暂未确认；请重新读取已上传图，不需要再次上传。");
  const url = new URL(owned.url);
  if (owned.url.length > 2048 || url.protocol !== "https:" || url.username || url.password) throw new Error("原参考图地址无效，上传记录已保留。");
  if (!input.stillCurrent()) throw new Error("验证配置或账号已变化，原上传记录已保留。");
  await input.decode(owned.url);
  if (!input.stillCurrent()) throw new Error("验证配置或账号已变化，未替换当前参考图。");
  input.persist({ ...pending, status: "ready" });
  return { ...owned, url: owned.url, assetId: owned.assetId, storageKey: pending.storageKey };
}
