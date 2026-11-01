import { ImageProviderBindingError, resolveImageProviderContract } from "@/lib/image-provider-contract";

export type ImageModelReadiness = {
  protocolBindingReady: boolean;
  canaryVerified: boolean;
  generationReady: boolean;
  readinessMessage: string;
  verificationNotice: string;
};

/**
 * Publication evidence is supplied by the server-side publication RPC. It is
 * deliberately separate from model configuration so a client/admin payload
 * cannot manufacture readiness by setting a boolean in api_protocol_config.
 */
export type ImageModelPublicationEvidence = {
  published?: boolean;
  legacyBaseline?: boolean;
};

type ModelRecord = Record<string, unknown>;

function protocolConfig(model: ModelRecord): ModelRecord {
  const config = model.api_protocol_config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? config as ModelRecord
    : {};
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) if (typeof value === "boolean") return value;
  return undefined;
}

function firstText(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

export function inspectImageModelReadiness(
  model: ModelRecord,
  publicationEvidence: ImageModelPublicationEvidence = {},
): ImageModelReadiness {
  const config = protocolConfig(model);
  let protocolBindingReady = false;
  try {
    resolveImageProviderContract(model as Parameters<typeof resolveImageProviderContract>[0]);
    protocolBindingReady = true;
  } catch (error) {
    if (!(error instanceof ImageProviderBindingError)) throw error;
  }

  const gate = config.__model_activation_gate && typeof config.__model_activation_gate === "object"
    && !Array.isArray(config.__model_activation_gate)
    ? config.__model_activation_gate as ModelRecord
    : {};
  const notice = firstText(config.verification_notice, config.verificationNotice);
  const explicitCanary = firstBoolean(
    config.canary_verified,
    config.canaryVerified,
    (config.canary && typeof config.canary === "object" && !Array.isArray(config.canary))
      ? (config.canary as ModelRecord).verified
      : undefined,
    // A gate state alone is only a catalog hint. The complete evidence,
    // binding fingerprint and credential check are validated at submission;
    // absence of an explicit canary flag must stay fail-closed here.
    gate.state ? false : undefined,
  );
  const gateEvidence = gate.evidence && typeof gate.evidence === "object" && !Array.isArray(gate.evidence)
    ? gate.evidence as ModelRecord
    : {};
  const serverEvidenceReady = gate.state === "evidence_ready"
    && gateEvidence.issuer === "server"
    && typeof gateEvidence.evidence_id === "string"
    && gateEvidence.evidence_id.trim().length >= 8
    && typeof gateEvidence.binding_sha256 === "string"
    && /^[a-f0-9]{64}$/iu.test(gateEvidence.binding_sha256);
  // A canary is evidence for operator confidence and publication reporting;
  // it is not a public catalog or submission switch. A model with a valid
  // protocol binding is allowed to reach the live provider so the current
  // credential/channel result can be observed and repaired without silently
  // hiding the configured model.
  const serverPublishedEvidence = publicationEvidence.published === true || publicationEvidence.legacyBaseline === true;
  const canaryVerified = serverPublishedEvidence
    || (serverEvidenceReady && (explicitCanary === true || gate.state === "evidence_ready"));
  const generationReady = protocolBindingReady;
  const readinessMessage = !protocolBindingReady
    ? "该模型当前无法生成"
    : "";

  return { protocolBindingReady, canaryVerified, generationReady, readinessMessage, verificationNotice: notice };
}
