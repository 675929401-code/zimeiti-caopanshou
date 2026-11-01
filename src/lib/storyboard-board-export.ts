export type StoryboardBoardBlob = { owner: string; runId: string; cardId: string; recordId: string; blob: Blob };
export function rememberStoryboardBoardBlob(cache: Map<string, StoryboardBoardBlob>, url: string, entry: StoryboardBoardBlob): void {
  if (!url.startsWith("blob:") || !entry.owner || !entry.runId || !entry.cardId || !/^[a-f0-9]{64}$/u.test(entry.recordId) || !(entry.blob instanceof Blob)) throw new Error("原图内存身份无法确认。");
  cache.set(url, entry);
}
/** Browser CSP intentionally excludes connect-src blob:. Read native delivery RAM without URL fetching. */
export async function readStoryboardBoardBlob(cache: Map<string, StoryboardBoardBlob>, url: string, expected: Omit<StoryboardBoardBlob, "blob">): Promise<{ bytes: Uint8Array; mime: string }> {
  const entry = cache.get(url);
  if (!entry || entry.owner !== expected.owner || entry.runId !== expected.runId || entry.cardId !== expected.cardId || entry.recordId !== expected.recordId) throw new Error("本页原始分镜图或账号已变化，未读取其他图像。");
  return { bytes: new Uint8Array(await entry.blob.arrayBuffer()), mime: entry.blob.type };
}
export type StoryboardOwnedBoard = { assetId: string; storageKey: string; url: string; width: number; height: number };
type BoardIdentity = { imageRecordId?: string; imageDeliveryMode?: string; imageAssetId?: string; imageStorageKey?: string; imageRef?: unknown; imageUrl?: string };
export function isOwnedStoryboardBoard(card: BoardIdentity | undefined, recordId?: string): boolean {
  return Boolean(card && card.imageDeliveryMode === undefined && !card.imageRef && card.imageAssetId && card.imageStorageKey && (!recordId || card.imageRecordId === recordId));
}
export function needsStoryboardBoardExport(card: BoardIdentity): boolean {
  return !isOwnedStoryboardBoard(card) && !card.imageRef && Boolean(card.imageUrl && (card.imageDeliveryMode === "inline_ephemeral" || /^(?:blob:|data:)/u.test(card.imageUrl)));
}
const hash = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, "0")).join("");
export async function saveStoryboardBoardOriginal(input: {
  userId: string; runId: string; cardId: string; recordId: string; url: string; width: number; height: number; token: string;
  chainOriginal?: { projectId: string; cardId: string; recordId: string };
  cache: Map<string, { assetId: string; storageKey: string }>; stillCurrent: () => boolean;
  readOwned: (reference: { assetId: string; storageKey: string }) => Promise<StoryboardOwnedBoard>;
  readOriginal?: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  request?: typeof fetch;
}): Promise<StoryboardOwnedBoard> {
  const guard = () => { if (!input.stillCurrent()) throw new Error("原故事板或账号已变化，未更改当前卡片。"); };
  guard();
  if (!input.userId || !input.runId || !input.cardId || !/^[a-f0-9]{64}$/u.test(input.recordId) || !input.width || !input.height) throw new Error("原故事板身份或尺寸未确认，未保存。");
  const original = await (input.readOriginal || (async url => { if (/^(?:blob:|data:)/u.test(url)) throw new Error("临时原图必须从本页原始字节读取，未发起URL请求。"); const response = await fetch(url); if (!response.ok) throw new Error("原故事板读取失败，临时图仍保留。"); const blob = await response.blob(); return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type }; }))(input.url);
  guard();
  if (!original.bytes.byteLength || original.bytes.byteLength > 25 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(original.mime)) throw new Error("原故事板文件类型或大小无法确认，未保存。");
  const byteHash = await hash(original.bytes);
  const trace = "storyboard-board-export-" + await hash(new TextEncoder().encode(JSON.stringify([input.userId,input.runId,input.cardId,input.recordId,byteHash])));
  guard();
  const cacheKey = input.chainOriginal ? trace + ":chain-original" : trace;
  let receipt = input.cache.get(cacheKey);
  if (!receipt) {
    let binary = ""; for (let start = 0; start < original.bytes.length; start += 32768) binary += String.fromCharCode(...original.bytes.subarray(start, start + 32768));
    const dataUrl = `data:${original.mime};base64,${btoa(binary)}`;
    const response = await (input.request || fetch)("/api/image-workbench/persist", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` },
      body: JSON.stringify({ url: dataUrl, index: 0, clientTraceId: trace, intent: "user_asset_export", ...(input.chainOriginal ? { chainOriginal: input.chainOriginal } : {}) }) });
    const result = await response.json() as { assetId?: string; key?: string; error?: string };
    if (!response.ok || !result.assetId || !result.key) throw new Error(result.error || "故事板保存未确认，原图仍保留；可重试同一保存操作。");
    receipt = { assetId: result.assetId, storageKey: result.key }; input.cache.set(cacheKey, receipt);
  }
  guard();
  const owned = await input.readOwned(receipt);
  guard();
  if (owned.assetId !== receipt.assetId || owned.storageKey !== receipt.storageKey || owned.width !== input.width || owned.height !== input.height || !/^https?:\/\//u.test(owned.url)) throw new Error("保存后原图归属或完整尺寸不一致，未绑定视频。");
  return owned;
}

/** Roll back only fields still carrying this operation's patch; preserve later edits. */
export function rollbackStoryboardBoardBinding<T extends object>(current: T, before: T, patch: Partial<T>): T {
  const next = { ...current };
  for (const key of Object.keys(patch) as Array<keyof T>) if (Object.is(current[key], patch[key])) next[key] = before[key];
  return next;
}
