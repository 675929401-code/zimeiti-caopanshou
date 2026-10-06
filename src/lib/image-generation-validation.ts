import type { AdminAuthorizationResult } from "@/lib/admin-auth";
import type { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { ImageRequestRejectedError } from "@/lib/image-exactly-once";
import {
  IMAGE_ADMIN_VALIDATION_CONFIRMATION, authorizeImageValidationProof, claimImageAdminValidation,
  imageValidationFailure, loadImageAdminValidationContext, recordImageAdminValidationOutcome,
  type ImageValidationProof,
} from "@/lib/image-admin-validation";

type Database = ReturnType<typeof getSupabaseAdminClient>;
export type ImageGenerationValidationInput = ImageValidationProof & { confirmation: string; retestReason?: string };

/** Admits one signed original configuration; submission remains in the existing image route. */
export async function prepareImageGenerationValidation(input: {
  db: Database; authorization: AdminAuthorizationResult; modelId: unknown; mode: string;
  proof: ImageGenerationValidationInput; clientKey: string; clientTraceId: string;
}) {
  if (input.mode !== "local" || input.proof?.confirmation !== IMAGE_ADMIN_VALIDATION_CONFIRMATION) {
    imageValidationFailure("IMAGE_VALIDATION_CONFIRMATION_REQUIRED", "请明确确认原配置的单次本地模型验证", 400);
  }
  const context = await loadImageAdminValidationContext(input.db, input.modelId, input.authorization, input.proof.retestReason || "");
  authorizeImageValidationProof(context, input.proof, input.authorization);
  if (input.clientKey !== context.validationKey || input.clientTraceId !== context.validationKey) {
    imageValidationFailure("IMAGE_VALIDATION_ORIGINAL_KEYS_REQUIRED", "必须使用验证证明绑定的原请求号和追踪号", 400);
  }
  let claimed = false;
  return {
    model: context.model,
    configurationHash: context.configurationHash,
    async claim(payloadFingerprint: string) {
      const receipt = await claimImageAdminValidation({ db: input.db, context, authorization: input.authorization,
        proof: input.proof, confirmation: input.proof.confirmation, payloadFingerprint });
      claimed = true; return receipt;
    },
    async recordOutcome(error?: unknown) {
      if (!claimed && !context.existing) return false;
      try {
        const rejection = error instanceof ImageRequestRejectedError ? error.rejection : undefined;
        await recordImageAdminValidationOutcome({ db: input.db, context, authorization: input.authorization,
          outcome: rejection ? "rejected" : error === undefined ? "completed" : "unknown", rejection });
        return true;
      } catch {
        // A lost governance acknowledgement must never erase an owned image or re-submit.
        // Publication/GET re-read the original image record, not this best-effort projection.
        return false;
      }
    },
  };
}
