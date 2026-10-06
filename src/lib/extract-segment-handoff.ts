import { workbenchUserStorageKey } from "@/lib/workbench-user-storage";
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const SEGMENTER_HANDOFF_KEY = "segmenter_handoff";
export const SEGMENTER_HANDOFF_TTL_MS = 2 * 60 * 1_000;

type SegmenterHandoffEnvelope = {
  version: 1;
  ownerUserId: string;
  text: string;
  expiresAt: number;
};

function clearLegacyHandoff(storage: DraftStorage): void {
  try { storage.removeItem(SEGMENTER_HANDOFF_KEY); } catch { /* Legacy bytes are never trusted. */ }
}

/** Transfer only the displayed text. The destination consumes it once. */
export function prepareExtractSegmentDraft(text: string, ownerUserId: string, storage: DraftStorage = sessionStorage): void {
  if (typeof text !== "string" || !text.trim()) throw new Error("没有可传递的文案");
  const cleanOwnerUserId = ownerUserId.trim();
  if (!cleanOwnerUserId) throw new Error("登录状态无效，未传递文案");
  clearLegacyHandoff(storage);
  const key = workbenchUserStorageKey(SEGMENTER_HANDOFF_KEY, cleanOwnerUserId);
  const previous = storage.getItem(key);
  const envelope: SegmenterHandoffEnvelope = {
    version: 1,
    ownerUserId: cleanOwnerUserId,
    text,
    expiresAt: Date.now() + SEGMENTER_HANDOFF_TTL_MS,
  };
  try {
    storage.setItem(key, JSON.stringify(envelope));
  } catch {
    try { if (previous === null) storage.removeItem(key); else storage.setItem(key, previous); } catch { /* Best effort after storage becomes unavailable. */ }
    throw new Error("分段草稿保存失败，请复制文案后粘贴到分段工具");
  }
}

/** Read a deliberate cross-page handoff once so reopening or refreshing starts blank. */
export function consumeExtractSegmentDraft(ownerUserId: string, storage: DraftStorage = sessionStorage): string {
  const cleanOwnerUserId = ownerUserId.trim();
  if (!cleanOwnerUserId) return "";
  clearLegacyHandoff(storage);
  const key = workbenchUserStorageKey(SEGMENTER_HANDOFF_KEY, cleanOwnerUserId);
  const raw = storage.getItem(key);
  if (raw === null) return "";
  try { storage.removeItem(key); } catch { return ""; }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return "";
    const envelope = parsed as Partial<SegmenterHandoffEnvelope>;
    const remainingMs = Number(envelope.expiresAt) - Date.now();
    return envelope.version === 1
      && envelope.ownerUserId === cleanOwnerUserId
      && typeof envelope.text === "string"
      && envelope.text.trim()
      && Number.isFinite(remainingMs)
      && remainingMs > 0
      && remainingMs <= SEGMENTER_HANDOFF_TTL_MS
      ? envelope.text
      : "";
  } catch {
    return "";
  }
}

/** Remove keys created by the retired cross-refresh editor memory. */
export function clearRetiredSegmenterDraft(ownerUserId: string, storage: DraftStorage = sessionStorage): void {
  const keys = [
    "app_state_segmenter_input",
    "app_state_segmenter_duration",
    "app_state_segmenter_result",
    "app_state_segmenter_input:anonymous",
    "app_state_segmenter_duration:anonymous",
    "app_state_segmenter_result:anonymous",
  ];
  if (ownerUserId.trim()) {
    for (const base of ["segmenter_input", "segmenter_duration", "segmenter_result"]) {
      keys.push("app_state_" + workbenchUserStorageKey(base, ownerUserId));
    }
  }
  for (const key of keys) {
    try { storage.removeItem(key); } catch { /* The editor still starts from in-memory defaults. */ }
  }
}
