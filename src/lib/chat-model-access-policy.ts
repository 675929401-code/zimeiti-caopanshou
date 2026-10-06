import { isPublishedTextBillingModel } from "@/lib/text-model-eligibility";

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
  return hasExplicitChatModelSelection(input);
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
