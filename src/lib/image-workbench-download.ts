export type ImageDownloadReference = { assetId?: string; historyRecordId?: string };

/** Read owned bytes through the existing history endpoint; never expose auth to a media host. */
export async function fetchWorkbenchImagePng(reference: ImageDownloadReference, token: string): Promise<Blob> {
  if (!token.trim()) throw new Error("请先登录后下载图片");
  const assetId = String(reference.assetId || "").trim();
  const historyRecordId = String(reference.historyRecordId || "").trim();
  if (!assetId && (!historyRecordId || !/^[A-Za-z0-9_.-]+$/u.test(historyRecordId))) {
    throw new Error("图片资产凭据不完整，请刷新后重试");
  }
  if (assetId && !/^[A-Za-z0-9_-]{1,160}$/u.test(assetId)) throw new Error("图片资产凭据无效");
  const query = historyRecordId ? new URLSearchParams({ id: historyRecordId, index: "0", download: "1" }) : null;
  const path = assetId
    ? `/api/storage/files/${encodeURIComponent(assetId)}/content?download=1`
    : `/api/media-history/content?${query}`;
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(error instanceof Error && error.name === "TimeoutError" ? "图片读取超时，请稍后重试" : "网络连接暂不可用，请重试下载");
  }
  if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录后下载" : "图片下载失败，请稍后重试");
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const maximumBytes = 30 * 1024 * 1024;
  if (!/^image\/(png|jpeg|webp|gif)$/u.test(contentType)) throw new Error("下载结果不是有效图片");
  if (Number(response.headers.get("content-length")) > maximumBytes) throw new Error("图片超过下载大小上限");
  const blob = await response.blob();
  if (!blob.size || blob.size > maximumBytes) throw new Error("图片大小异常，无法下载");
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => signature[index] === value)) return new Blob([blob], { type: "image/png" });
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { throw new Error("图片无法解码，请稍后重试"); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 33_554_432) {
      throw new Error("图片尺寸超过导出上限");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器暂时无法导出图片");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error("图片导出失败，请稍后重试")), "image/png",
    ));
  } finally { bitmap.close(); }
}
