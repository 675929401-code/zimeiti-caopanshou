import { isPublishedTextBillingModel } from "@/lib/text-model-eligibility";
import { isValidPublicChatModelId } from "./chat-model-switching-policy";

export interface ChatModelOverrideAccessInput {
  authenticated: boolean;
  isAdmin: boolean;
  isCanvasInternalWorkflow: boolean;
  requestedModelId?: unknown;
  requestedModel?: unknown;
  requestedModelOverridden?: unknown;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export function hasExplicitChatModelSelection(input: ChatModelOverrideAccessInput): boolean {
  return input.requestedModelOverridden === true
    || hasNonEmptyString(input.requestedModelId)
    || hasNonEmptyString(input.requestedModel);
}

export function shouldRejectOrdinaryChatModelOverride(input: ChatModelOverrideAccessInput): boolean {
  if (!input.authenticated || input.isAdmin || input.isCanvasInternalWorkflow) return false;
  const selections = [input.requestedModelId, input.requestedModel]
    .filter((value) => value !== undefined && value !== null && value !== "");
  if (selections.some((value) => !isValidPublicChatModelId(value))) return true;
  if (selections.length === 2 && selections[0] !== selections[1]) return true;
  return input.requestedModelOverridden === true && selections.length === 0;
}

export interface BoundChatModelPublicationInput {
  isAdmin: boolean;
  modelRow: Record<string, unknown> | null | undefined;
}

/** Admins keep their explicit custom-model authority; ordinary users only reach published rows. */
export function shouldRejectOrdinaryUnpublishedChatModel(
  input: BoundChatModelPublicationInput,
): boolean {
  return !input.isAdmin && !isPublishedTextBillingModel(input.modelRow);
}
