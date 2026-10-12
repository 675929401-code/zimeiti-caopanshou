export type ImageDownloadSource =
  | { kind: "inline_ephemeral"; blob: Blob }
  | { kind: "provider_url"; recordId: string }
  | { kind: "legacy_owned"; read: () => Promise<Blob> };
const maximumBytes = 30 * 1024 * 1024;
const validTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
async function validate(blob: Blob) {
  if (!validTypes.has(blob.type) || !blob.size || blob.size > maximumBytes) throw new Error("图片类型或大小异常；任务与费用收据仍保留");
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!(blob.type === "image/png" ? png : blob.type === "image/jpeg" ? jpeg : webp)) throw new Error("下载结果不是有效图片；任务与费用收据仍保留");
  return blob;
}
/** Inline bytes are already in RAM: fetching their Blob URL would require CSP connect-src blob. */
export async function readImageDownloadBlob(source: ImageDownloadSource, token: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (source.kind === "inline_ephemeral") return validate(source.blob);
  if (source.kind === "legacy_owned") return validate(await source.read());
  if (!/^[a-f0-9]{64}$/u.test(source.recordId) || !token.trim()) throw new Error("图片归属凭证无效；任务与费用收据仍保留");
  const response = await fetch("/api/media-history/content?recordId=" + source.recordId, {
    headers: { Authorization: "Bearer " + token }, cache: "no-store", redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok) throw new Error("图片当前不可下载；任务与费用收据仍保留");
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!validTypes.has(type) || Number(response.headers.get("content-length")) > maximumBytes) throw new Error("图片类型或大小异常；任务与费用收据仍保留");
  if (!response.body) throw new Error("图片内容为空；任务与费用收据仍保留");
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error("图片超过下载大小上限；任务与费用收据仍保留");
      chunks.push(new Uint8Array(part.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return validate(new Blob(chunks, { type }));
}
export function imageDownloadFilename(name: string, blob: Blob) {
  const suffix = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[blob.type];
  if (!suffix) throw new Error("图片类型无法确认");
  return name.replace(/\.(?:png|jpe?g|webp)$/iu, "") + "." + suffix;
}
/** Cancellation is separate from preview URL lifetime and card deletion. */
export class ImageDownloadOperations {
  private controllers = new Set<AbortController>();
  constructor(private currentOwner: () => string | null) {}
  begin(owner: string) {
    const controller = new AbortController(); this.controllers.add(controller);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (this.currentOwner() !== owner) throw new Error("下载已取消：当前账号或页面已变化");
    };
    return { signal: controller.signal, assertCurrent, finish: () => { this.controllers.delete(controller); } };
  }
  cancelAll() { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
}
