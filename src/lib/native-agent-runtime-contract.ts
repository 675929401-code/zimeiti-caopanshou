import { z } from "zod";

export const NATIVE_AGENT_RUNTIME_ROLES = ["default", "background", "think"] as const;
export type NativeAgentRuntimeRole = typeof NATIVE_AGENT_RUNTIME_ROLES[number];
export const NativeAgentPublicModelIdSchema = z.string().regex(/^pm_[A-Za-z0-9_-]{24}$/u);
const credits = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u)
  .refine(value => /[1-9]/u.test(value), "任务积分上限必须大于零")
  .transform(value => { const [integer, fraction = ""] = value.split("."); return `${integer}.${fraction.padEnd(6, "0")}`; });

/** A disabled candidate can be incomplete. Saving it never grants runtime admission. */
export const NativeAgentRuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  modelIds: z.object({ default: NativeAgentPublicModelIdSchema.nullable().default(null),
    background: NativeAgentPublicModelIdSchema.nullable().default(null), think: NativeAgentPublicModelIdSchema.nullable().default(null) }).strict().default({ default: null, background: null, think: null }),
  allowedModelIds: z.array(NativeAgentPublicModelIdSchema).max(16).default([]),
  maxCallsPerTurn: z.number().int().min(1).max(24).default(8),
  maxOutputTokens: z.number().int().min(512).max(8192).default(4096),
  maxInputBytes: z.number().int().min(16_384).max(1_048_576).default(262_144),
  maxCreditsPerTurn: credits.default("50.000000"),
}).strict().superRefine((config, context) => {
  if (new Set(config.allowedModelIds).size !== config.allowedModelIds.length)
    context.addIssue({ code: "custom", path: ["allowedModelIds"], message: "允许列表不能重复" });
  if (config.enabled) for (const role of NATIVE_AGENT_RUNTIME_ROLES) {
    const id = config.modelIds[role];
    if (!id || !config.allowedModelIds.includes(id)) context.addIssue({ code: "custom", path: ["modelIds", role], message: "启用时角色模型必须已配置并加入允许列表" });
  }
});
export type NativeAgentRuntimeConfig = z.infer<typeof NativeAgentRuntimeConfigSchema>;
export const NativeAgentRuntimeSaveSchema = z.object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), config: NativeAgentRuntimeConfigSchema }).strict();

/** No credential, endpoint, internal model UUID or administrator identity crosses this boundary. */
export type NativeAgentRuntimeConfigSnapshot = {
  revision: number;
  configHash: string;
  roles: Record<NativeAgentRuntimeRole, { modelId: string; modelName: string }>;
  maxCallsPerTurn: number;
  maxOutputTokens: number;
  maxInputBytes: number;
  maxCreditsPerTurn: string;
};
export type NativeAgentRuntimeModelChoice = { id: string; displayName: string; modelName: string; available: boolean; reasons: string[] };
export type NativeAgentRuntimeReadiness = { ready: boolean; code: string; message: string; inactiveRoles: ("background" | "think")[] };
export type NativeAgentRuntimeAdminState = {
  configured: boolean; revision: number; configHash: string | null; config: NativeAgentRuntimeConfig;
  updatedAt: string | null; choices: NativeAgentRuntimeModelChoice[]; readiness: NativeAgentRuntimeReadiness;
};
