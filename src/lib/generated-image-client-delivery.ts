import { GeneratedImageReferenceSchema } from "@/lib/generated-image-reference";

export type GeneratedImageClientReceipt = {
  recordId: string; deliveryMode: "provider_url" | "inline_ephemeral";
  generationCompleted: true; mediaAvailable: false; canRecover: boolean;
  cashCharged: number; billingReferenceId?: string; retention?: "current_page_only";
  width?: number; height?: number; sha256?: string; byteLength?: number; contentType?: "image/png" | "image/jpeg" | "image/webp";
};
export type GeneratedImageClientDelivery = {
  kind: "legacy_owned" | "provider_url" | "inline_ephemeral"; receipt?: GeneratedImageClientReceipt;
  url: string; assetId?: string; storageKey?: string;
  imageRef?: { schema: "generated_image_ref.v1"; recordId: string }; blob?: Blob; revoke: () => void;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
export function projectGeneratedImageClientReceipt(value: unknown): GeneratedImageClientReceipt | null {
  const data = object(value), first = object(Array.isArray(data.images) ? data.images[0] : undefined);
  const recordId = String(first.recordId || data.recordId || ""), deliveryMode = first.deliveryMode || data.deliveryMode;
  if (first.recordId && data.recordId && first.recordId !== data.recordId) return null;
  if (first.deliveryMode && data.deliveryMode && first.deliveryMode !== data.deliveryMode) return null;
  if (!/^[a-f0-9]{64}$/u.test(recordId) || (deliveryMode !== "provider_url" && deliveryMode !== "inline_ephemeral")) return null;
  if (typeof data.cashCharged !== "number" || !Number.isFinite(data.cashCharged) || data.cashCharged < 0) return null;
  const receipt: GeneratedImageClientReceipt = { recordId, deliveryMode, generationCompleted: true, mediaAvailable: false, canRecover: deliveryMode === "provider_url", cashCharged: data.cashCharged, ...(deliveryMode === "inline_ephemeral" ? {retention:"current_page_only" as const} : {}) };
  if (typeof data.billingReferenceId === "string" && /^[A-Za-z0-9_:.-]{1,160}$/u.test(data.billingReferenceId)) receipt.billingReferenceId = data.billingReferenceId;
  for (const key of ["width", "height", "byteLength"] as const) { const n = positive(data[key] ?? first[key]); if (n) receipt[key] = n; }
  if (typeof data.sha256 === "string" && /^[a-f0-9]{64}$/u.test(data.sha256)) receipt.sha256 = data.sha256;
  if (typeof data.contentType === "string" && /^image\/(png|jpeg|webp)$/u.test(data.contentType)) receipt.contentType = data.contentType as "image/png"|"image/jpeg"|"image/webp";
  return receipt;
}
export async function resolveGeneratedImageClientDelivery(value: unknown): Promise<GeneratedImageClientDelivery> {
  const data = object(value), first = object(Array.isArray(data.images) ? data.images[0] : undefined), rawUrl = typeof first.url === "string" ? first.url : "";
  const receipt = projectGeneratedImageClientReceipt(data), noop = () => {};
  if((first.deliveryMode || data.deliveryMode) && !receipt)throw new Error("图片任务收据身份不一致，请保留原请求号核查");
  if (receipt?.deliveryMode === "inline_ephemeral") {
    if (!rawUrl) return { kind: "inline_ephemeral", receipt, url: "", revoke: noop };
    const match = rawUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u);
    if (!match || match[2].length % 4 || match[2].length > 40 * 1024 * 1024) throw new Error("临时图片格式无法确认，任务与费用收据仍保留");
    let decoded: string; try { decoded = atob(match[2]); } catch { throw new Error("临时图片无法解码，任务与费用收据仍保留"); }
    const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
    if (!bytes.length || bytes.length > 30 * 1024 * 1024 || (receipt.byteLength && bytes.length !== receipt.byteLength)) throw new Error("临时图片大小不一致，任务与费用收据仍保留");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    if (receipt.sha256 && hash !== receipt.sha256) throw new Error("临时图片摘要不一致，任务与费用收据仍保留");
    if (receipt.contentType && receipt.contentType !== match[1]) throw new Error("临时图片类型不一致，任务与费用收据仍保留");
    const blob = new Blob([bytes], { type: match[1] }), url = URL.createObjectURL(blob); let revoked = false;
    return { kind: "inline_ephemeral", receipt: { ...receipt, sha256: hash, byteLength: bytes.length, contentType: match[1] as "image/png"|"image/jpeg"|"image/webp" }, url, blob, revoke: () => { if (!revoked) { revoked = true; URL.revokeObjectURL(url); } } };
  }
  if (receipt?.deliveryMode === "provider_url") {
    const imageRef = GeneratedImageReferenceSchema.parse({ schema: "generated_image_ref.v1", recordId: receipt.recordId });
    return { kind: "provider_url", receipt, url: data.state === "expired" ? "" : "/api/media-history/content?recordId=" + receipt.recordId, imageRef, revoke: noop };
  }
  if (rawUrl && typeof first.assetId === "string" && first.assetId && typeof first.storageKey === "string" && first.storageKey && !/^(data:|blob:)/u.test(rawUrl)) {
    return { kind: "legacy_owned", url: rawUrl, assetId: first.assetId, storageKey: first.storageKey, revoke: noop };
  }
  throw new Error("图片交付收据无法确认，请保留原任务号核查费用");
}

/** Explicit document boundary: runtime previews and encoded media never enter a canvas snapshot. */
export function projectGeneratedImageDocument<T>(value:T):T {
  const mediaKeys=new Set(["imagePreviewUrl","outputUrl","imageUrl","pendingPersistUrl","previewUrl","url"]);
  const visit=(item:unknown):unknown=>{
    if(Array.isArray(item))return item.map(visit);
    if(!item || typeof item!=="object")return item;
    if(ArrayBuffer.isView(item) || item instanceof ArrayBuffer || (typeof Blob!=="undefined" && item instanceof Blob))return undefined;
    const result:Record<string,unknown>={};
    for(const [key,entry] of Object.entries(item)) {
      if(key==="imagePreviewUrl" || key==="transientDelivery" || key==="blob" || key==="base64" || key==="b64_json" || key==="bytes" || key==="buffer")continue;
      if(key==="imageDeliveryReceipt") {const receipt=projectGeneratedImageClientReceipt(entry);if(receipt)result[key]=receipt;continue;}
      if(key==="imageRef"){const reference=GeneratedImageReferenceSchema.safeParse(entry);if(reference.success)result[key]=reference.data;continue;}
      if(["referenceImageUrls","imageUrls"].includes(key) && Array.isArray(entry)){result[key]=entry.filter(value=>typeof value!=="string" || !/^(?:data:|blob:)/u.test(value)).map(visit);continue;}
      if(mediaKeys.has(key) && typeof entry==="string" && /^(?:data:|blob:)/u.test(entry)) {if(key==="outputUrl")result[key]="";continue;}
      result[key]=visit(entry);
    }
    return result;
  };
  return visit(value) as T;
}
