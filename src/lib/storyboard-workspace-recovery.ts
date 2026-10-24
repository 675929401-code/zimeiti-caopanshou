import { StoryboardProjectDocument } from "@/lib/storyboard-project-contract";
import { createStoryboardPersistenceSnapshot } from "@/lib/storyboard-local-persistence";
const PREFIX = "storyboard_workspace_recovery_v1";
const MAX_BYTES = 4_000_000;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem">;
export async function storyboardRecoveryStorageKey(userId: string, token: string): Promise<string> {
  if (!userId || !token) throw new Error("Authenticated session required");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const session = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${PREFIX}:${encodeURIComponent(userId)}:${session}`;
}
export function readStoryboardRecovery(storage: RecoveryStorage, key: string) {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > MAX_BYTES) return null;
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1 || envelope.scope !== key || !Number.isFinite(envelope.savedAt)) return null;
    const parsed = StoryboardProjectDocument.safeParse(envelope.run);
    if (!parsed.success) return null;
    return { run: createStoryboardPersistenceSnapshot(parsed.data), savedAt: envelope.savedAt,
      baseContentFingerprint: typeof envelope.baseContentFingerprint === "string" && envelope.baseContentFingerprint.length < MAX_BYTES ? envelope.baseContentFingerprint : "" };
  } catch { return null; }
}
export function writeStoryboardRecovery(storage: RecoveryStorage, key: string, run: Parameters<typeof createStoryboardPersistenceSnapshot>[0], baseContentFingerprint = "") {
  const snapshot = createStoryboardPersistenceSnapshot(run);
  const parsed = StoryboardProjectDocument.safeParse(snapshot);
  if (!parsed.success) throw new Error("Invalid workspace recovery snapshot");
  const raw = JSON.stringify({ version: 1, scope: key, savedAt: Date.now(), baseContentFingerprint, run: snapshot });
  if (raw.length > MAX_BYTES) throw new Error("Workspace recovery snapshot exceeds storage limit");
  storage.setItem(key, raw);
}

const runEditFields = ["title", "ratio", "imageRatio", "imageResolution", "videoResolution", "videoDuration", "imageModelId", "videoModelId", "videoContract", "wardrobePlan", "visualAssetPlan", "visualAssetWorkspace", "environmentGroups"];
const cardEditFields = ["order", "sourceNumber", "label", "narration", "imagePrompt", "imageExactText", "imageTextLayoutEnabled", "videoPrompt", "referenceImageUrls", "visualAssetRefs", "visualAssetRefsMode", "visualAssetSelectionMode", "sceneId", "sceneZone", "styleLock", "sceneLock", "camera", "dynamicState", "capabilityGaps", "bottomPanelRole", "qualityChecks", "wardrobeChangeEvents"];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const pick = (object: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
function editableContent(document: unknown, legacy = false) {
  const run = record(document);
  return { ...pick(run, ["id", ...runEditFields, ...(legacy ? [] : ["directorIntake"])]),
    cards: Array.isArray(run.cards) ? run.cards.map(card => pick(record(card), ["id", ...cardEditFields, ...(legacy ? [] : ["directorExecution"])])) : [] };
}
const signatureKeys = new Set(["q-sign-algorithm", "q-ak", "q-sign-time", "q-key-time", "q-header-list", "q-url-param-list", "q-signature", "x-cos-security-token", "x-amz-algorithm", "x-amz-credential", "x-amz-date", "x-amz-expires", "x-amz-signedheaders", "x-amz-signature", "x-amz-security-token"]);
function stableMediaUrl(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value, "https://storyboard.invalid");
    for (const key of [...url.searchParams.keys()]) if (signatureKeys.has(key.toLowerCase())) url.searchParams.delete(key);
    if (/^\/api\/video\//u.test(url.pathname)) url.searchParams.delete("media_ticket");
    url.searchParams.sort();
    return url.toString();
  } catch { return value; }
}
function mapReferenceUrls(value: unknown, transform: (url: string) => string, urlContext = false): unknown {
  if (typeof value === "string") return urlContext ? transform(value) : value;
  if (Array.isArray(value)) return value.map(item => mapReferenceUrls(item, transform, urlContext));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapReferenceUrls(item, transform, /(?:Urls?$|^urls?$|^taskLineages$)/u.test(key))]));
  return value;
}
function normalizeReferenceSignatures(value: unknown): unknown {
  return mapReferenceUrls(value, url => /^(?:https?:\/\/|asset:\/\/|\/api\/video\/)/iu.test(url) ? stableMediaUrl(url)! : url);
}
function canonicalFingerprint(value: string) {
  try { return JSON.stringify(normalizeReferenceSignatures(JSON.parse(value))); } catch { return ""; }
}
type RecoveryConflictIndexEntry = { key: string; runId: string };
function validConflictIndexEntry(value: unknown, scope: string): value is RecoveryConflictIndexEntry {
  const entry = record(value);
  if (typeof entry.key !== "string" || typeof entry.runId !== "string" || !/^[A-Za-z0-9:_-]{8,160}$/u.test(entry.runId)) return false;
  return entry.key === `${scope}:conflict:${encodeURIComponent(entry.runId)}` || entry.key === `${scope}:new-workspace:conflict:${encodeURIComponent(entry.runId)}`;
}
function conflictIndex(storage: RecoveryStorage, scope: string): RecoveryConflictIndexEntry[] {
  const raw = storage.getItem(`${scope}:conflict-index`);
  if (raw === null) return [];
  if (raw.length > 16000) throw new Error("本地冲突稿索引过大，原记录仍保留");
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1 || parsed.scope !== scope || !Array.isArray(parsed.entries) || parsed.entries.length > 16
    || !parsed.entries.every((entry: unknown) => validConflictIndexEntry(entry, scope))
    || new Set(parsed.entries.map((entry: RecoveryConflictIndexEntry) => entry.key)).size !== parsed.entries.length) {
    throw new Error("本地冲突稿索引无法验证，原记录仍保留");
  }
  return parsed.entries;
}
/** Read only this authenticated session's explicitly indexed, valid sidecars. */
export function readStoryboardRecoveryConflicts(storage: RecoveryStorage, indexScope: string) {
  try {
    return conflictIndex(storage, indexScope).flatMap(entry => {
      const recovery = readStoryboardRecovery(storage, entry.key);
      return recovery && record(recovery.run).id === entry.runId ? [{ key: entry.key, ...recovery }] : [];
    });
  } catch { return []; }
}
/** Discard only the selected workspace drafts in this authenticated session. */
export function clearStoryboardWorkspaceRecovery(storage: RecoveryStorage & Pick<Storage, "removeItem">, scope: string, runIds: readonly string[]): void {
  const ids = new Set(runIds.filter(id => /^[A-Za-z0-9:_-]{8,160}$/u.test(id)));
  const primary = readStoryboardRecovery(storage, scope);
  if (primary && ids.has(primary.run.id)) storage.removeItem(scope);
  for (const id of ids) {
    storage.removeItem(`${scope}:conflict:${encodeURIComponent(id)}`);
    storage.removeItem(`${scope}:new-workspace:conflict:${encodeURIComponent(id)}`);
  }
  const entries = conflictIndex(storage, scope);
  const remaining = entries.filter(entry => !ids.has(entry.runId));
  if (remaining.length === entries.length) return;
  if (remaining.length) storage.setItem(`${scope}:conflict-index`, JSON.stringify({ version: 1, scope, entries: remaining }));
  else storage.removeItem(`${scope}:conflict-index`);
}
/** Retain bounded indexed sidecars; never overwrite or evict a distinct older draft. */
export function preserveStoryboardRecoveryConflict<T extends Parameters<typeof createStoryboardPersistenceSnapshot>[0] & { id: string }>(storage: RecoveryStorage, key: string,
  recovery: { run: T; baseContentFingerprint: string; savedAt?: number }, indexScope = key): void {
  const sidecarKey = `${key}:conflict:${encodeURIComponent(recovery.run.id)}`;
  const entry = { key: sidecarKey, runId: recovery.run.id };
  if (!validConflictIndexEntry(entry, indexScope)) throw new Error("本地冲突稿不属于当前会话，原记录仍保留");
  const entries = conflictIndex(storage, indexScope);
  const indexed = entries.some(item => item.key === sidecarKey);
  if (!indexed && entries.length >= 16) throw new Error("本地冲突稿已达保留上限，请先下载并明确处理旧稿");
  const existing = readStoryboardRecovery(storage, sidecarKey);
  if (existing) {
    if (record(existing.run).id !== entry.runId) throw new Error("已有本地冲突稿无法验证，当前恢复内容不会覆盖");
    if (JSON.stringify(existing.run) !== JSON.stringify(createStoryboardPersistenceSnapshot(recovery.run))) {
      // Upgrade pre-index sidecars before reporting the occupied slot, so a
      // subsequent alternate-slot save cannot make this original draft vanish.
      if (!indexed) storage.setItem(`${indexScope}:conflict-index`, JSON.stringify({ version: 1, scope: indexScope, entries: [...entries, entry] }));
      throw new Error("已有未处理的本地冲突稿；请先保留或处理该稿，当前恢复内容不会覆盖");
    }
  } else {
    if (storage.getItem(sidecarKey) !== null) throw new Error("已有本地冲突稿无法读取，当前恢复内容不会覆盖");
    writeStoryboardRecovery(storage, sidecarKey, recovery.run, recovery.baseContentFingerprint);
  }
  if (!indexed) storage.setItem(`${indexScope}:conflict-index`, JSON.stringify({ version: 1, scope: indexScope, entries: [...entries, entry] }));
}
/** A request remains the same request while its task ID, result and progress arrive. */
function taskLineages(document: unknown) {
  const cards = record(document).cards;
  return Array.isArray(cards) ? cards.map(value => {
    const card = record(value);
    const image = card.imageClientRequestId
      ? ["request", card.imageClientRequestId, card.imageClientRequestFingerprint, card.imageAttemptOrdinal]
      : ["result", card.imageRecordId || record(card.imageRef).recordId || card.imageAssetId || card.imageStorageKey || stableMediaUrl(card.imageUrl)];
    const video = card.videoClientRequestId ? ["request", card.videoClientRequestId, card.videoClientRequestFingerprint]
      : ["task", card.videoTaskId || stableMediaUrl(card.videoUrl)];
    return [card.id, image, video];
  }) : [];
}

/** Content and stable request lineage; polling progress/status/URLs are not conflict clocks. */
export function storyboardRecoveryContentFingerprint(document: unknown): string {
  return JSON.stringify(normalizeReferenceSignatures({ ...editableContent(document), taskLineages: taskLineages(document) }));
}

type RecoverableRun = { id: string; cards: Array<{ id: string }> };
/**
 * Restore only unsaved editable fields over the latest owned cloud document.
 * Cloud task IDs, media, billing and all other runtime fields remain authoritative.
 * A rejected recovery is retained in browser storage; this function never deletes it.
 */
export function mergeStoryboardRecoveryEdits<T extends RecoverableRun>(cloud: T,
  recovery: { run: T; baseContentFingerprint: string } | null | undefined): T {
  return inspectStoryboardRecoveryEdits(cloud, recovery).run;
}
export function inspectStoryboardRecoveryEdits<T extends RecoverableRun>(cloud: T,
  recovery: { run: T; baseContentFingerprint: string } | null | undefined): { run: T; status: "none" | "applied" | "conflict" } {
  if (!recovery || recovery.run.id !== cloud.id || !recovery.baseContentFingerprint) return { run: cloud, status: "none" };
  const baseMatches = canonicalFingerprint(recovery.baseContentFingerprint) === storyboardRecoveryContentFingerprint(cloud);
  // Older envelopes carried content only. Admit them only when their request
  // lineage and director metadata still agree with the owned cloud document.
  const legacyMatches = canonicalFingerprint(recovery.baseContentFingerprint) === JSON.stringify(normalizeReferenceSignatures(editableContent(cloud, true)))
    && JSON.stringify(normalizeReferenceSignatures({ taskLineages: taskLineages(recovery.run) })) === JSON.stringify(normalizeReferenceSignatures({ taskLineages: taskLineages(cloud) }))
    && JSON.stringify(record(recovery.run).directorIntake) === JSON.stringify(record(cloud).directorIntake)
    && JSON.stringify(recovery.run.cards.map(card => record(card).directorExecution)) === JSON.stringify(cloud.cards.map(card => record(card).directorExecution));
  if (!baseMatches && !legacyMatches) return { run: cloud, status: "conflict" };
  const cloudCards = new Map(cloud.cards.map(card => [card.id, card]));
  if (cloudCards.size !== cloud.cards.length || new Set(recovery.run.cards.map(card => card.id)).size !== recovery.run.cards.length) return { run: cloud, status: "conflict" };
  const currentUrls = new Map<string, Set<string>>();
  const collect = (value: unknown): void => {
    if (typeof value === "string" && /^https?:\/\//iu.test(value)) {
      const key = stableMediaUrl(value)!;
      const values = currentUrls.get(key) || new Set<string>(); values.add(value); currentUrls.set(key, values);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(cloud);
  const refreshSignatures = (value: unknown) => mapReferenceUrls(value, url => {
    const matches = currentUrls.get(stableMediaUrl(url) || "");
    return matches?.size === 1 ? [...matches][0] : url;
  });
  const overlay = (original: Record<string, unknown>, edited: Record<string, unknown>, fields: string[]) => {
    const next = { ...original };
    for (const field of fields) {
      if (edited[field] === undefined) delete next[field];
      else next[field] = record(refreshSignatures({ [field]: structuredClone(edited[field]) }))[field];
    }
    return next;
  };
  const cards = [];
  for (const local of recovery.run.cards) {
    const saved = cloudCards.get(local.id);
    if (!saved) {
      const item = record(local);
      // New draft cards may restore prompts, never unverified task/media receipts.
      if (Object.keys(item).some(key => /^(?:image|video)(?:Client|Task|Record|Asset|Storage|Url|Ref$|RequestSnapshot)/u.test(key) && item[key] !== undefined)
        || item.imageStatus !== "idle" || item.videoStatus !== "idle") return { run: cloud, status: "conflict" };
    }
    cards.push(overlay(saved ? record(saved) : { id: local.id, imageStatus: "idle", videoStatus: "idle" }, record(local), [...cardEditFields, "directorExecution"]));
  }
  return { run: { ...overlay(record(cloud), record(recovery.run), [...runEditFields, "directorIntake"]), cards } as T, status: "applied" };
}
