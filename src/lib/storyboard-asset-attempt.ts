import { z } from "zod";
import { workbenchUserStorageKey, type WorkbenchStorageLike } from "./workbench-user-storage";

const AttemptSchema = z.object({
  projectId: z.string().min(1).optional(), referenceSessionId: z.string().regex(/^reference-session_[a-zA-Z0-9_-]{8,100}$/u).optional(), planId: z.string().min(1),
  role: z.enum(["character", "pet", "environment", "prop"]),
  name: z.string(), prompt: z.string(), modelId: z.string().min(1), modelName: z.string(),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(), customCategory: z.string().trim().max(40).optional(),
  derivedFromAssetId: z.string().min(1).max(240).optional(),
  identityState: z.enum(["current", "young", "senior"]).optional(),
  resolution: z.string(), ratio: z.string(), quotedPrice: z.number().finite().nonnegative(),
  clientTraceId: z.string().min(8), clientIdempotencyKey: z.string().min(8), createdAt: z.string(),
}).superRefine((attempt, context) => {
  if (Boolean(attempt.projectId) === Boolean(attempt.referenceSessionId)) context.addIssue({ code: "custom", message: "Asset request must have exactly one project or reference session" });
});
export type StoryboardAssetAttempt = z.infer<typeof AttemptSchema>;
/** These exact route codes return before generation intent creation; debt settlement may concern older jobs. */
export function assetAttemptWasNotAccepted(data: { code?: string; upstreamCalled?: boolean; billed?: boolean; taskSubmitted?: boolean; state?: string; canResubmit?: boolean }): boolean {
  return ["IMAGE_PRICE_NOT_CONFIGURED", "IMAGE_MODEL_CONFIGURATION_REQUIRED", "MEMBERSHIP_REQUIRED", "INSUFFICIENT_BALANCE", "BILLING_LEDGER_UNAVAILABLE", "OUTSTANDING_CASH_DEBT"].includes(data.code || "")
    || (data.upstreamCalled === false && data.billed === false)
    || (data.state === "rejected" && data.canResubmit === true && data.billed === false);
}
const key = (userId: string) => workbenchUserStorageKey("storyboard-asset-pending:v1", userId);

/** Pending dispatches never expire locally: only the authenticated original receipt can release them. */
export function readStoryboardAssetAttempts(storage: WorkbenchStorageLike, userId: string): StoryboardAssetAttempt[] {
  const raw = storage.getItem(key(userId));
  if (!raw) return [];
  const parsed = z.array(AttemptSchema).max(100).safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("资产原请求记录无法读取，请核对历史状态；已阻止新生成");
  return parsed.data;
}

export function writeStoryboardAssetAttempts(storage: WorkbenchStorageLike, userId: string, attempts: StoryboardAssetAttempt[]): void {
  const value = JSON.stringify(z.array(AttemptSchema).max(100).parse(attempts));
  storage.setItem(key(userId), value);
  if (storage.getItem(key(userId)) !== value) throw new Error("资产请求记录未保存确认，本次未提交");
}
