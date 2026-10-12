"use client";

import { readBrowserWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";
import { GeneratedImageReferenceSchema, parseGeneratedImageReferenceUri, type GeneratedImageReference } from "@/lib/generated-image-reference";

export const VIDEO_WORKFLOW_DRAFT_KEY = "agent_hub_video_workflow_draft_v1";
export const VIDEO_WORKFLOW_DRAFT_EVENT = "agent-hub-video-workflow-draft";
export const VIDEO_WORKFLOW_DRAFT_TTL_MS = 2 * 60 * 1000;
export const VIDEO_WORKFLOW_MAX_TASKS = 40;

export type VideoWorkflowImageMode = "reference" | "first-last";
export type VideoWorkflowImageTarget = "reference" | "first-frame" | "last-frame";
export type VideoWorkflowPromptKind = "video" | "image";

export interface VideoWorkflowSlot {
  order: number;
  prompt?: string;
  promptKind?: VideoWorkflowPromptKind;
  label?: string;
  title?: string;
  referenceImageUrl?: string;
  referenceImageRef?: GeneratedImageReference;
  firstFrameUrl?: string;
  firstFrameImageRef?: GeneratedImageReference;
  lastFrameUrl?: string;
  lastFrameImageRef?: GeneratedImageReference;
  updatedAt: number;
}

export interface VideoWorkflowDraft {
  version: 1;
  ownerUserId?: string;
  imageMode: VideoWorkflowImageMode;
  slots: VideoWorkflowSlot[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface VideoWorkflowDraftUpdate {
  order: number;
  prompt?: string;
  promptKind?: VideoWorkflowPromptKind;
  label?: string;
  title?: string;
  imageUrl?: string;
  imageRef?: GeneratedImageReference;
  imageTarget?: VideoWorkflowImageTarget;
  clearPrompt?: boolean;
  clearImageTarget?: VideoWorkflowImageTarget;
}

function normalizeOrder(value: unknown, fallback = 1) {
  const order = Number(value);
  if (!Number.isFinite(order)) return fallback;
  return Math.min(VIDEO_WORKFLOW_MAX_TASKS, Math.max(1, Math.floor(order)));
}

function isImageMode(value: unknown): value is VideoWorkflowImageMode {
  return value === "reference" || value === "first-last";
}

function isDraft(value: unknown): value is VideoWorkflowDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as VideoWorkflowDraft;
  return draft.version === 1 &&
    isImageMode(draft.imageMode) &&
    typeof draft.createdAt === "number" &&
    typeof draft.updatedAt === "number" &&
    typeof draft.expiresAt === "number" &&
    Array.isArray(draft.slots) &&
    draft.slots.every((slot) => typeof slot?.order === "number" && typeof slot?.updatedAt === "number");
}

function durableImageUrl(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4096) throw new Error("VIDEO_DRAFT_IMAGE_INVALID");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname === "/api/media-history/content") throw new Error("VIDEO_DRAFT_IMAGE_INVALID");
  return value;
}
export function projectVideoWorkflowSlot(slot: VideoWorkflowSlot): VideoWorkflowSlot {
  if (!Number.isSafeInteger(slot.order) || slot.order < 1 || slot.order > VIDEO_WORKFLOW_MAX_TASKS || !Number.isFinite(slot.updatedAt)) throw new Error("VIDEO_DRAFT_SLOT_INVALID");
  const result: VideoWorkflowSlot = { order: slot.order, updatedAt: slot.updatedAt };
  for (const key of ["prompt", "label", "title"] as const) {
    if (slot[key] !== undefined) { if (typeof slot[key] !== "string" || slot[key]!.length > 50_000) throw new Error("VIDEO_DRAFT_TEXT_INVALID"); result[key] = slot[key]; }
  }
  if (slot.promptKind === "video" || slot.promptKind === "image") result.promptKind = slot.promptKind;
  for (const [urlKey, refKey] of [["referenceImageUrl", "referenceImageRef"], ["firstFrameUrl", "firstFrameImageRef"], ["lastFrameUrl", "lastFrameImageRef"]] as const) {
    if (slot[refKey] !== undefined) {
      if (slot[urlKey] !== undefined) throw new Error("VIDEO_DRAFT_IMAGE_CONFLICT");
      result[refKey] = GeneratedImageReferenceSchema.parse(slot[refKey]);
    } else { const url = durableImageUrl(slot[urlKey]); if (url) result[urlKey] = url; }
  }
  return result;
}

/** Convert canonical editor strings into the strict API representation, keeping role/index. */
export function videoWorkflowImageRequestFields(input: { imageUrl?: string; lastFrameUrl?: string; referenceImageUrl?: string; referenceImageUrls?: string[] }) {
  const fields: Record<string, unknown> = {};
  for (const [value, urlKey, refKey] of [[input.imageUrl, "image_url", "image_ref"], [input.lastFrameUrl, "last_frame_url", "last_frame_ref"], [input.referenceImageUrl, "reference_image_url", "reference_image_ref"]] as const) {
    const ref = parseGeneratedImageReferenceUri(value);
    if (ref) fields[refKey] = ref; else fields[urlKey] = value || "";
  }
  const items = input.referenceImageUrls || [];
  fields[items.some(item => Boolean(parseGeneratedImageReferenceUri(item))) ? "reference_image_inputs" : "reference_image_urls"] = items.map(item => parseGeneratedImageReferenceUri(item) || item);
  return fields;
}

/** Preview only: source and crop bytes remain in this page's memory. */
export async function generatedVideoPreviewBlob(blob: Blob, value: GeneratedImageReference): Promise<Blob> {
  const ref = GeneratedImageReferenceSchema.parse(value);
  if (!blob.type.startsWith("image/") || blob.size > 16 * 1024 * 1024) throw new Error("VIDEO_PREVIEW_IMAGE_INVALID");
  if (!ref.transform) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const crop = ref.transform;
    if (bitmap.width * bitmap.height > 40_000_000 || crop.x + crop.width > bitmap.width || crop.y + crop.height > bitmap.height) throw new Error("VIDEO_PREVIEW_CROP_INVALID");
    const canvas = document.createElement("canvas");
    canvas.width = crop.width; canvas.height = crop.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("VIDEO_PREVIEW_CANVAS_UNAVAILABLE");
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("VIDEO_PREVIEW_CROP_FAILED")), "image/png"));
  } finally { bitmap.close(); }
}

export function clearLegacyVideoWorkflowDraft(): void {
  if (typeof window === "undefined") return;
  const identity = readBrowserWorkbenchIdentity();
  try {
    window.localStorage.removeItem(VIDEO_WORKFLOW_DRAFT_KEY);
    window.sessionStorage.removeItem(VIDEO_WORKFLOW_DRAFT_KEY);
    if (identity) {
      window.localStorage.removeItem(workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId));
    }
  } catch {
    // Legacy cleanup must not block an explicit handoff.
  }
}

export function readVideoWorkflowDraft(): VideoWorkflowDraft | null {
  if (typeof window === "undefined") return null;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return null;
  clearLegacyVideoWorkflowDraft();
  const storageKey = workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId);
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const draft = JSON.parse(raw) as unknown;
    if (!isDraft(draft) || draft.ownerUserId !== identity.userId) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    const now = Date.now();
    if (draft.expiresAt <= now || draft.expiresAt > now + VIDEO_WORKFLOW_DRAFT_TTL_MS) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    if (draft.slots.length > VIDEO_WORKFLOW_MAX_TASKS || ![draft.createdAt, draft.updatedAt, draft.expiresAt].every(Number.isFinite)
      || draft.createdAt > draft.updatedAt || draft.updatedAt > now || draft.expiresAt - draft.updatedAt > VIDEO_WORKFLOW_DRAFT_TTL_MS) throw new Error("VIDEO_DRAFT_TIME_INVALID");
    const projected = { version: 1 as const, ownerUserId: identity.userId, imageMode: draft.imageMode,
      slots: draft.slots.map(projectVideoWorkflowSlot), createdAt: draft.createdAt, updatedAt: draft.updatedAt, expiresAt: draft.expiresAt };
    window.sessionStorage.setItem(storageKey, JSON.stringify(projected));
    return projected;
  } catch {
    return null;
  }
}

export function clearVideoWorkflowDraft() {
  if (typeof window !== "undefined") {
    const identity = readBrowserWorkbenchIdentity();
    if (identity) window.sessionStorage.removeItem(workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId));
    clearLegacyVideoWorkflowDraft();
  }
}

export function mergeVideoWorkflowDraft(
  updates: VideoWorkflowDraftUpdate[],
  imageMode?: VideoWorkflowImageMode,
): VideoWorkflowDraft | null {
  if (typeof window === "undefined") return null;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return null;
  const validUpdates = updates.filter((item) => item.prompt?.trim() || item.imageUrl || item.imageRef || item.clearPrompt || item.clearImageTarget);
  if (validUpdates.length === 0) return readVideoWorkflowDraft();

  const previous = readVideoWorkflowDraft();
  const now = Date.now();
  const slots = new Map<number, VideoWorkflowSlot>();
  for (const slot of previous?.slots || []) slots.set(slot.order, { ...slot });

  for (const update of validUpdates) {
    const order = normalizeOrder(update.order, slots.size + 1);
    const current = slots.get(order) || { order, updatedAt: now };
    const next: VideoWorkflowSlot = { ...current, updatedAt: now };
    if (update.clearPrompt) {
      delete next.prompt;
      delete next.promptKind;
    }
    if (update.clearImageTarget === "reference") { delete next.referenceImageUrl; delete next.referenceImageRef; }
    if (update.clearImageTarget === "first-frame") { delete next.firstFrameUrl; delete next.firstFrameImageRef; }
    if (update.clearImageTarget === "last-frame") { delete next.lastFrameUrl; delete next.lastFrameImageRef; }
    if (update.prompt?.trim() && (update.promptKind === "video" || !next.prompt || next.promptKind !== "video")) {
      next.prompt = update.prompt.trim();
      next.promptKind = update.promptKind || "video";
    }
    if (update.label) next.label = update.label;
    if (update.title) next.title = update.title;
    if (update.imageUrl !== undefined && update.imageRef !== undefined) throw new Error("VIDEO_DRAFT_IMAGE_CONFLICT");
    if (update.imageUrl || update.imageRef) {
      const target = update.imageTarget || "reference";
      const [urlKey, refKey] = target === "reference" ? ["referenceImageUrl", "referenceImageRef"] as const : target === "first-frame" ? ["firstFrameUrl", "firstFrameImageRef"] as const : ["lastFrameUrl", "lastFrameImageRef"] as const;
      delete next[urlKey]; delete next[refKey];
      if (update.imageRef) next[refKey] = GeneratedImageReferenceSchema.parse(update.imageRef);
      else next[urlKey] = durableImageUrl(update.imageUrl);
    }
    slots.set(order, projectVideoWorkflowSlot(next));
  }

  const draft: VideoWorkflowDraft = {
    version: 1,
    ownerUserId: identity.userId,
    imageMode: imageMode || previous?.imageMode || "reference",
    slots: Array.from(slots.values()).sort((left, right) => left.order - right.order),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    expiresAt: now + VIDEO_WORKFLOW_DRAFT_TTL_MS,
  };
  try {
    window.sessionStorage.setItem(workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId), JSON.stringify(draft));
    window.dispatchEvent(new CustomEvent(VIDEO_WORKFLOW_DRAFT_EVENT, { detail: draft }));
    return draft;
  } catch {
    return null;
  }
}
