export type {
  AspectRatio,
  CardStatus,
  GenerationRoute,
  ReferenceStrategy,
  GenerationTask,
  StoryboardCard,
  StudioAsset,
  StudioEvent,
  StudioProject,
} from "@/lib/studio-schema";

export interface CoverModel {
  id: string;
  name: string;
  model_name: string;
  provider: string;
  selling_price: number;
  supports_image_input: boolean;
  supports_reference_input?: boolean;
  reference_input_mode?: "none" | "single" | "multi";
  identity_reference_level?: "none" | "single-subject" | "multi-subject";
  max_reference_images?: number;
  max_character_references?: number;
  reference_capability_label?: string;
  capabilities?: Record<string, unknown>;
  sort_order?: number;
  resolution_options: string[];
  default_resolution: string;
}

export interface VideoModel {
  id: string;
  name: string;
  modelName: string;
  provider: string;
  pricePerUse: number;
  durationSeconds: number;
  maxDuration: number;
  resolutionTier: string;
  supportsImageInput: boolean;
  requiresImage: boolean;
  successRate: number;
  durationMode?: "range" | "discrete" | "fixed";
  minDuration?: number;
  nativeDurations?: number[];
  durationStep?: number;
  resolutionOptions?: string[];
  defaultResolution?: string;
  resolutionPrices?: Record<string, number>;
  resolutionCostPrices?: Record<string, number>;
  requiresSourceVideo?: boolean;
  maxReferenceImages?: number;
  supportsAudioInput?: boolean;
  minReferenceAudios?: number;
  maxReferenceAudios?: number;
  billingUnit?: "per_use" | "output_second";
  workspaceSurfaces?: string[];
  supportsRemoteCancel?: boolean;
  aspectRatios?: string[];
  capabilities?: Record<string, unknown>;
  api_protocol_config?: Record<string, unknown>;
}

export interface CanvasVoiceOption {
  id: string;
  name: string;
  engine: string;
  speakerId: string;
  gender: string;
  language: string;
  category: string;
  type: string;
  isPublic: boolean;
  isRecommended: boolean | null;
  description?: string;
  styleTags?: string[];
}

export interface CanvasVoicePricing {
  modelId: string;
  name: string;
  costPrice: number;
  unit: string;
  profitMargin: number;
  sellPrice: number;
}

export interface ChatModel {
  id: string;
  name: string;
  modelName: string;
  description: string;
  userAccess: string;
}

export interface PromptImportItem {
  imagePrompt: string;
  videoPrompt: string;
}

export interface PromptImportResult {
  items: PromptImportItem[];
  mode: "tagged" | "numbered" | "separated" | "paragraphs" | "lines" | "single";
  warnings: string[];
}
