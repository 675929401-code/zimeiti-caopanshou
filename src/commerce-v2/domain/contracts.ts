export const COMMERCE_V2_DRAFT_SCHEMA = "commerce-production-draft/v2" as const;
export const COMMERCE_V2_PLAN_SCHEMA = "commerce-production-plan/v2" as const;
export const COMMERCE_V2_QUOTE_SCHEMA = "commerce-production-quote/v2" as const;

export type ProductionKind = "image" | "video";
export type MaterialKind = "image" | "video" | "audio";

export type ProductionMaterial = {
  instanceId: string;
  assetId?: string;
  name: string;
  kind: MaterialKind;
  role: string;
  source: "local-session" | "asset-library";
  mimeType?: string;
  size?: number;
  sha256?: string;
};

export type VideoProductionSettings = {
  aspectRatio: string;
  resolution: string;
  durationSeconds: number;
  generateAudio: boolean;
};

export type ImageProductionSettings = {
  aspectRatio: string;
  resolution: string;
  format: "PNG" | "JPEG" | "WEBP";
};

export type DirectorBinding = {
  skillKey: string;
  registryVersion: string;
  promptVersion: string;
  outputProtocol: "director-script/v2";
  conversationId?: string;
  messageId?: string;
  applicationId?: string;
  script?: string;
};

export type ProductionDraft = {
  schema: typeof COMMERCE_V2_DRAFT_SCHEMA;
  id: string;
  revision: number;
  kind: ProductionKind;
  prompt: string;
  skillKey: string;
  modelId: string | null;
  materials: ProductionMaterial[];
  director?: DirectorBinding;
  videoSettings?: VideoProductionSettings;
  imageSettings?: ImageProductionSettings;
};

export type ModelCapabilityProfile = {
  id: string;
  displayName: string;
  configHash: string;
  available: boolean;
  executionReady: boolean;
  readinessMessage: string;
  billingUnit: "per_use" | "output_second";
  publicPrice: number | null;
  capabilities: {
    supportsImageInput: boolean;
    maxReferenceImages: number;
    minReferenceImages: number;
    supportsSourceVideoInput: boolean;
    maxReferenceVideos: number;
    requiresSourceVideo: boolean;
    supportsAudioInput: boolean;
    maxReferenceAudios: number;
    supportsGenerateAudioToggle: boolean;
    aspectRatios: string[];
    resolutionOptions: string[];
    nativeDurations: number[];
    supportsRollingContinuation: boolean;
  };
};

export type ProductionSegment = {
  index: number;
  durationSeconds: number;
  continuitySource: "input" | "previous-final-frame";
};

export type ProductionPlan = {
  schema: typeof COMMERCE_V2_PLAN_SCHEMA;
  planId: string;
  draftId: string;
  draftRevision: number;
  kind: ProductionKind;
  skillKey: string;
  model: Pick<ModelCapabilityProfile, "id" | "displayName" | "configHash" | "billingUnit" | "publicPrice">;
  settings: VideoProductionSettings | ImageProductionSettings;
  materials: ProductionMaterial[];
  segments: ProductionSegment[];
  prompt: string;
  director?: DirectorBinding;
  configurationIssues: string[];
  executionIssues: string[];
  warnings: string[];
  confirmable: boolean;
};

export type ProductionQuote = {
  schema: typeof COMMERCE_V2_QUOTE_SCHEMA;
  quoteId: string;
  planHash: string;
  modelId: string;
  modelConfigHash: string;
  billingUnit: "per_use" | "output_second";
  quantity: number;
  unitPrice: number;
  payableTotal: number;
  currency: "CNY";
  expiresAt: number;
  confirmable: boolean;
};

export type ProductionTaskState =
  | "draft"
  | "planned"
  | "quoted"
  | "confirmed"
  | "queued"
  | "running"
  | "saving"
  | "succeeded"
  | "failed"
  | "unknown"
  | "save_failed"
  | "cancelled"
  | "refunding"
  | "refunded";

export type ProductionTaskEvent =
  | "plan"
  | "quote"
  | "confirm"
  | "enqueue"
  | "start"
  | "provider_succeeded"
  | "save_succeeded"
  | "provider_failed"
  | "dispatch_unknown"
  | "save_failed"
  | "retry_save"
  | "cancel"
  | "begin_refund"
  | "refund_succeeded";
