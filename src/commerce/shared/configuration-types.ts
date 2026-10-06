export type CommerceModelKind = 'agent' | 'image' | 'video';
export type CommerceExecutorType = 'director' | 'agent_plan' | 'image_skill' | 'video_entry' | 'fixed_pipeline';
export type CommerceLifecycleState = 'draft' | 'pending_validation' | 'validated' | 'published' | 'disabled' | 'archived';

export interface CommerceMaterialSlot {
  id: string;
  label: string;
  responsibility: string;
  mediaTypes: Array<'image' | 'video' | 'audio' | 'document'>;
  minCount: number;
  maxCount: number;
  maxFileBytes?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  cover?: string;
}

export interface CommerceInputField {
  id: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'boolean';
  title: string;
  description?: string;
  required: boolean;
  defaultValue?: string | number | boolean;
  options?: string[];
  validation?: { min?: number; max?: number; pattern?: string; maxLength?: number };
}

export interface CommerceCardDisplay {
  name: string;
  description: string;
  category: string;
  icon: string;
  recommended: boolean;
  sortOrder: number;
  visibility: 'members' | 'admins' | 'hidden';
}

export interface CommerceCardVersion {
  id: string;
  cardId: string;
  stableKey: string;
  version: number;
  display: CommerceCardDisplay;
  materialSlots: CommerceMaterialSlot[];
  inputFields: CommerceInputField[];
  executorType: CommerceExecutorType;
  promptVersionId: string | null;
  knowledgeDocumentIds: string[];
  outputContract: Record<string, unknown>;
  qualityRules: Record<string, unknown>;
  modelPolicy: Record<string, unknown>;
  videoDefaults: Record<string, unknown>;
  testCases: unknown[];
  status: CommerceLifecycleState;
  validationResult: Record<string, unknown>;
}

export interface CommercePromptVersion {
  id: string;
  promptKey: string;
  version: number;
  name: string;
  content: string;
  source: string;
  status: CommerceLifecycleState;
}

export interface CommerceKnowledgeDocument {
  id: string;
  knowledgeKey: string;
  version: number;
  name: string;
  content: string;
  enabled: boolean;
  applicableCardKeys: string[];
  status: CommerceLifecycleState;
}

export interface CommerceRoutePolicy {
  id: string;
  operationId: string;
  version: number;
  label: string;
  modelKind: CommerceModelKind;
  primaryModelId: string;
  fallbackModelIds: string[];
  capabilityRequirements: Record<string, unknown>;
  userSelectable: boolean;
  status: CommerceLifecycleState;
}

export interface CommerceReleaseManifest {
  schema: 'commerce-config/v1';
  cardVersionIds: string[];
  promptVersionIds: string[];
  knowledgeDocumentIds: string[];
  operationRouteIds: string[];
  defaultModels: Partial<Record<CommerceModelKind, string>>;
}

export interface PublishedCommerceConfiguration {
  releaseId: string;
  releaseVersion: number;
  manifestSha256: string;
  publishedAt: string;
  validationMode: 'full' | 'migration-baseline';
  paidJobsReady: boolean;
  cards: CommerceCardVersion[];
  prompts: CommercePromptVersion[];
  knowledge: CommerceKnowledgeDocument[];
  routes: CommerceRoutePolicy[];
  defaultModels: Partial<Record<CommerceModelKind, string>>;
}

export interface CommercePromptPackageIdentity {
  schema: 'commerce-prompt-package/v1';
  authority: 'published-release' | 'curated-main-catalog' | 'legacy-local';
  skillKind: 'director-skill' | 'image-skill' | 'generic';
  localSkillId: string;
  promptVersionId: string;
  promptVersion: number;
  promptContentSha256: string;
  skillContractSha256: string;
  packageSha256: string;
  benchmarkReference?: {
    source: 'benchmark-observed-catalog';
    contractOnly: true;
    skillId: string;
    configVersion: string;
    versionId?: string;
    version?: number;
  };
}

export interface CommerceQuoteSnapshot {
  schema: 'commerce-quote/v1';
  id: string;
  owner: string;
  operationId: string;
  cardVersionId?: string;
  inputFingerprint: string;
  modelId: string;
  modelDisplayName: string;
  modelConfigHash: string;
  billingUnit: 'per_use' | 'output_second';
  quantity: number;
  unitCost: number;
  estimatedTotalCost: number;
  unitPrice: number;
  payableTotal: number;
  profitAmount: number;
  profitRate: number | null;
  currency: 'CNY';
  releaseId?: string;
  releaseVersion?: number;
  manifestSha256?: string;
  promptPackage?: CommercePromptPackageIdentity;
  createdAt: number;
  expiresAt: number;
  status: 'quoted' | 'consumed' | 'expired';
  clientRequestId?: string;
  jobId?: string;
}

export interface CommerceJobSnapshot {
  releaseId?: string;
  releaseVersion?: number;
  cardVersionId?: string;
  promptVersionId?: string;
  knowledgeVersionIds: string[];
  routeVersionId?: string;
  promptPackage?: CommercePromptPackageIdentity;
  quoteId?: string;
  modelConfigHash: string;
  idempotencyKey: string;
}

export interface PublicCommerceCard {
  key: string;
  version: number;
  name: string;
  description: string;
  category: string;
  icon: string;
  recommended: boolean;
  sortOrder: number;
  slots: Array<{
    key: string;
    label: string;
    responsibility: string;
    min: number;
    max: number;
    kinds: string[];
    maxFileBytes?: number;
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
    cover: string;
  }>;
  inputFields: CommerceInputField[];
}
