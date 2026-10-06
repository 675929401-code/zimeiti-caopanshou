import type { ManjuConfigDomain } from "@/lib/server/manju-runtime-config";

export type ManjuAdminOperation = "read" | "validate" | "save-draft" | "publish" | "rollback";

export interface ManjuAdminCapability {
  permission: string;
  requireStepUp: boolean;
  operation: string;
}

type DomainPolicy = {
  read: string;
  write: string;
  protectRead?: boolean;
};

/**
 * Manju configuration is a shared persistence mechanism for several business
 * domains. Authorization follows the domain being changed instead of treating
 * every payload as a prompt. This keeps an operator who can edit public UI copy
 * from acquiring access to prompts, skills, models, or agent workflows.
 */
const MANJU_DOMAIN_POLICIES: Readonly<Record<ManjuConfigDomain, DomainPolicy>> = {
  prompt: { read: "prompts.view", write: "prompts.edit", protectRead: true },
  skill: { read: "internal_tools.manage", write: "internal_tools.manage", protectRead: true },
  agent: { read: "agents.view", write: "agents.manage" },
  workflow: { read: "agents.view", write: "agents.manage" },
  model_policy: { read: "models.view", write: "models.manage" },
  ui: { read: "brand.settings.manage", write: "brand.settings.manage" },
  content: { read: "brand.settings.manage", write: "brand.settings.manage" },
  media: { read: "brand.settings.manage", write: "brand.settings.manage" },
  feature_flags: { read: "platform.settings.manage", write: "platform.settings.manage" },
};

export function manjuAdminCapability(
  domain: ManjuConfigDomain,
  operation: ManjuAdminOperation,
): ManjuAdminCapability {
  const policy = MANJU_DOMAIN_POLICIES[domain];
  const isRead = operation === "read";
  const isMutating = operation === "save-draft" || operation === "publish" || operation === "rollback";

  return {
    permission: isRead ? policy.read : policy.write,
    requireStepUp: isMutating || (isRead && policy.protectRead === true),
    operation: `manju_${domain}_${operation.replaceAll("-", "_")}`,
  };
}
