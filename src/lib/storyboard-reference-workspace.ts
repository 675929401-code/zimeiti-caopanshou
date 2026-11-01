import { z } from "zod";
import { StoryboardVisualAssetWorkspaceSchema } from "./storyboard-visual-asset-workspace";
import { workbenchUserStorageKey, type WorkbenchStorageLike } from "./workbench-user-storage";

export const isReferenceSessionId = (value: string): boolean => /^reference-session_[a-zA-Z0-9_-]{8,100}$/u.test(value);
const sessionId = z.string().refine(isReferenceSessionId, "Invalid reference session");
export const ReferenceWorkspaceSchema = z.object({
  schema: z.literal("storyboard-reference-workspace.v1"), sessionId, revision: z.number().int().nonnegative(),
  modelId: z.string().max(200), resolution: z.string().max(40), ratio: z.enum(["16:9","9:16","1:1"]),
  workspace: StoryboardVisualAssetWorkspaceSchema,
}).superRefine((document, context) => {
  if (document.workspace.candidates.some(candidate => candidate.projectId !== undefined)) context.addIssue({ code: "custom", message: "Reference session must not claim a project" });
});
export type ReferenceWorkspace = z.infer<typeof ReferenceWorkspaceSchema>;
const key = (userId: string, id: string) => workbenchUserStorageKey("storyboard-reference-workspace.v1:" + id, userId);
const pointerKey = (userId: string) => workbenchUserStorageKey("storyboard-reference-tab-session.v1", userId);
export function readReferenceSessionId(storage: WorkbenchStorageLike, userId: string): string | null {
  const id = storage.getItem(pointerKey(userId));
  if (id !== null && !isReferenceSessionId(id)) throw new Error("参考制作标识无法读取，原记录已保留。");
  return id;
}
export function writeReferenceSessionId(storage: WorkbenchStorageLike, userId: string, id: string): void {
  if (!isReferenceSessionId(id)) throw new Error("参考制作标识无效。");
  storage.setItem(pointerKey(userId), id);
  if (storage.getItem(pointerKey(userId)) !== id) throw new Error("参考制作标识未保存确认，本次未提交。");
}
export function readReferenceWorkspace(storage: WorkbenchStorageLike, userId: string, id: string): ReferenceWorkspace | null {
  if (!isReferenceSessionId(id)) throw new Error("参考制作标识无效。");
  const raw = storage.getItem(key(userId, id));
  if (!raw) return null;
  const document = ReferenceWorkspaceSchema.parse(JSON.parse(raw));
  if (document.sessionId !== id) throw new Error("参考制作标识不一致，原记录已保留。");
  return document;
}
/** A tab owns its session. Revision/readback also rejects stale snapshots and failed browser storage writes. */
export function saveReferenceWorkspace(storage: WorkbenchStorageLike, userId: string, document: ReferenceWorkspace): ReferenceWorkspace {
  const parsed = ReferenceWorkspaceSchema.parse(document);
  const previous = readReferenceWorkspace(storage, userId, parsed.sessionId);
  if ((previous?.revision || 0) !== parsed.revision) throw new Error("参考制作已被更新，请刷新后核对；本次未覆盖。");
  const next = { ...parsed, revision: parsed.revision + 1 };
  const encoded = JSON.stringify(next);
  storage.setItem(key(userId, parsed.sessionId), encoded);
  if (storage.getItem(key(userId, parsed.sessionId)) !== encoded) throw new Error("参考制作未保存确认，本次未提交。");
  return ReferenceWorkspaceSchema.parse(next);
}
