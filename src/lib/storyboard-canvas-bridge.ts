import {
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_MODE_LABELS,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION,
  STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_ASSETS_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_PLAN_ARTIFACT_TYPE,
  parseStoryboardDirectorPackage,
  parseStoryboardDirectorAssetsPackage,
  parseStoryboardDirectorPlanPackage,
  storyboardDirectorPlanAsStoryboardPackage,
  normalizeStoryboardDirectorInput,
  validateStoryboardDirectorPlanPackage,
  validateStoryboardDirectorAssetsPackage,
  storyboardShotCountRule,
  validateStoryboardDirectorPackage,
  isQualityWarningIssue,
  type StoryboardContinuityLink,
  type StoryboardDirectorMode,
  type StoryboardDirectorPackage,
  type StoryboardDirectorInput,
  type StoryboardActualShotCount,
  type StoryboardVerifiedAssetBinding,
  type StoryboardVisualAssetReferenceKind,
  type StoryboardVisualAssetRefRole,
  type StoryboardLayout,
  type StoryboardPacingMode,
  type StoryboardShotTimeRange,
  type StoryboardBottomPanelRole,
} from "@/lib/storyboard-director-protocol";
import type {
  StoryboardEnvironmentGroupSchema,
  StoryboardQualityCheck,
  StoryboardVisualAssetPlan,
  StoryboardVisualAssetRef,
  StoryboardWardrobePlan,
  StoryboardWardrobeChangeEvent,
} from "@/lib/storyboard-workbench";
import { STORYBOARD_PROMPT_DRAFT_SCHEMA, parseLegacyStoryboardDraftImport } from "@/lib/storyboard-legacy-prompt-draft";
import { StoryboardVisualAssetPlanSchema } from "@/lib/storyboard-workbench";
import type { StoryboardPerformancePlan } from "./storyboard-director-performance";
import { parseStoryboardPromptDraftImport } from "./storyboard-prompt-draft";
import { parseAgentStoryboardPromptDraftImport } from "./agent-storyboard-prompt-draft";
import type { StoryboardExecutionMode } from "./storyboard-chain-contract";
import { storyboardExecutionModeFromIntake } from "./storyboard-creation-mode";

type UnknownRecord = Record<string, unknown>;

export interface StoryboardCanvasImportSettings {
  directorMode: StoryboardDirectorMode;
  directorLabel: string;
  targetDurationSeconds: 8 | 10 | 15;
  animationStyle: string;
  aspectRatio: "16:9" | "9:16";
}

export interface StoryboardCanvasImportSegment {
  segmentId: string;
  sourceIndex: number;
  narration: string;
  imagePrompt: string;
  imageExactText?: string;
  imageTextLayoutEnabled?: boolean;
  imageAnnotationIssue?: string;
  videoPrompt: string;
  panelCount: 4 | 5;
  layout: StoryboardLayout;
  pacingMode: StoryboardPacingMode;
  actualShotCount: StoryboardActualShotCount | 0;
  shotTimeRanges: StoryboardShotTimeRange[];
  panoramicAnchorRole: string | null;
  bottomPanelRole?: StoryboardBottomPanelRole;
  continuityLinks: StoryboardContinuityLink[];
  characterAssets: string[];
  characterAssetIds?: string[];
  visualAssetRefs?: StoryboardVisualAssetRef[];
  sceneId?: string;
  sceneZone?: string;
  styleLock?: string;
  sceneLock?: string;
  camera?: string;
  dynamicState?: string[];
  capabilityGaps?: string[];
  qualityChecks?: StoryboardQualityCheck[];
  wardrobeChangeEvents?: StoryboardWardrobeChangeEvent[];
  semanticVisualizations: Array<{ trigger: string; visual_form: string; interaction: string }>;
  performancePlan?: StoryboardPerformancePlan;
}

export interface StoryboardCanvasImportPlan {
  executionMode?: StoryboardExecutionMode;
  schemaVersion: typeof STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION | typeof STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION | typeof STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION | typeof STORYBOARD_PROMPT_DRAFT_SCHEMA;
  artifactType: typeof STORYBOARD_DIRECTOR_ARTIFACT_TYPE | typeof STORYBOARD_DIRECTOR_ASSETS_ARTIFACT_TYPE | typeof STORYBOARD_DIRECTOR_PLAN_ARTIFACT_TYPE | "storyboard_prompt_draft";
  phase: "assets" | "storyboard" | "planned" | "draft";
  commitKey: string;
  messageId: string;
  sourceScript: string;
  originalInput: StoryboardDirectorInput;
  intakeVerified: boolean;
  referenceProjectId?: string;
  pendingAssetVerification?: boolean;
  legacyDraftWarning?: string;
  /** Text cards carry no model quality verdict or generated-media approval. */
  promptDraft?: boolean;
  /** Visible-text mode declarations are advisory; original submitted choices win. */
  importWarnings?: string[];
  productionContractVersion?: typeof STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION;
  settings: StoryboardCanvasImportSettings;
  wardrobePlan?: StoryboardWardrobePlan;
  visualAssetPlan?: StoryboardVisualAssetPlan;
  environmentGroups?: Array<ReturnType<typeof StoryboardEnvironmentGroupSchema.parse>>;
  pendingRuntimePrerequisites?: Array<{ segmentId: string; checkId: string; verification: { kind: "visual_asset_binding"; asset_ids: string[] } }>;
  segments: StoryboardCanvasImportSegment[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapVisualAssetPlan(value: StoryboardDirectorPackage["visual_asset_plan"]): StoryboardVisualAssetPlan | undefined {
  if (!value) return undefined;
  return {
    mode: value.mode,
    ...(value.generation_policy ? {
      generationPolicy: {
        maxInitialImages: value.generation_policy.max_initial_images,
        initialRequiredAssetIds: value.generation_policy.initial_required_asset_ids,
        initialDeferredAssetIds: value.generation_policy.initial_deferred_asset_ids,
        environmentAnchorPolicy: value.generation_policy.environment_anchor_policy,
      },
    } : {}),
    assets: value.assets.map((asset) => ({
      id: asset.id,
      role: asset.role,
      name: asset.name,
      identityLock: asset.identity_lock,
      allowedChanges: asset.allowed_changes,
      referencePrompts: asset.reference_prompts.map((reference) => ({
        kind: reference.kind,
        purpose: reference.purpose,
        prompt: reference.prompt,
      })),
      ...(asset.scene_id ? { sceneId: asset.scene_id } : {}),
      ...(asset.scene_zone ? { sceneZone: asset.scene_zone } : {}),
      ...(asset.camera_coverage ? { cameraCoverage: asset.camera_coverage } : {}),
      ...(asset.fixed_anchors?.length ? { fixedAnchors: asset.fixed_anchors } : {}),
      ...(asset.allowed_segment_kinds?.length ? { allowedSegmentKinds: asset.allowed_segment_kinds } : {}),
      ...(asset.derived_from_asset_id ? { derivedFromAssetId: asset.derived_from_asset_id } : {}),
      ...(asset.source ? {
        source: {
          kind: asset.source.kind,
          assetId: asset.source.asset_id,
          ...(asset.source.preset_id ? { presetId: asset.source.preset_id, presetRevision: asset.source.preset_revision } : {}),
          ...(asset.source.library_saved !== undefined ? { librarySaved: asset.source.library_saved } : {}),
          ...(asset.source.history_record_id ? { historyRecordId: asset.source.history_record_id } : {}),
          ...(asset.source.storage_key ? { storageKey: asset.source.storage_key } : {}),
          ...(asset.source.model_id ? { modelId: asset.source.model_id } : {}),
          ...(asset.source.model_name ? { modelName: asset.source.model_name } : {}),
          ...(asset.source.quoted_price !== undefined ? { quotedPrice: asset.source.quoted_price } : {}),
          ...(asset.source.created_at ? { createdAt: asset.source.created_at } : {}),
        },
      } : {}),
    })),
  };
}

/**
 * Converts only the stable machine package into a canvas plan. Object property order,
 * Markdown headings and code-fence order are deliberately irrelevant here.
 */
export function parseStoryboardCanvasImport(
  value: unknown,
  options: {
    expectedInput?: StoryboardDirectorInput;
    allowLegacyUnverified?: boolean;
    requiredContractVersion?: typeof STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION;
    /** Preflight may show a button; saving/delivery always uses the default. */
    assetVerification?: "required" | "preview";
    verifiedAssetBindings?: StoryboardVerifiedAssetBinding[];
    requirePerformancePlan?: boolean;
    /** Keep a structurally valid package importable while the source agent is repaired. */
    allowQualityWarnings?: boolean;
  } = {},
): StoryboardCanvasImportPlan | null {
  const manualDraft = parseAgentStoryboardPromptDraftImport(value);
  if (manualDraft) {
    if (options.expectedInput || options.requiredContractVersion !== undefined || options.requirePerformancePlan === true) return null;
    return manualDraft;
  }
  const promptDraft = parseStoryboardPromptDraftImport(value);
  if (promptDraft) {
    if (options.expectedInput && JSON.stringify(normalizeStoryboardDirectorInput(options.expectedInput)) !== JSON.stringify(normalizeStoryboardDirectorInput(promptDraft.originalInput))) return null;
    return promptDraft;
  }
  const draft = parseLegacyStoryboardDraftImport(value);
  if (draft) {
    // Historical drafts cannot satisfy a caller's production contract.
    if (options.requiredContractVersion !== undefined || options.requirePerformancePlan === true) return null;
    if (options.expectedInput && JSON.stringify(normalizeStoryboardDirectorInput(options.expectedInput))
      !== JSON.stringify(normalizeStoryboardDirectorInput(draft.originalInput))) return null;
    return draft;
  }
  if (!isRecord(value)
    || value.source !== "stable_json"
    || ![STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION, STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION, STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION].includes(String(value.schema_version))
    || !isRecord(value.machine_payload)) {
    return null;
  }
  const assetPackage = value.schema_version === STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION
    ? parseStoryboardDirectorAssetsPackage(JSON.stringify(value.machine_payload)) : null;
  const planPackage = value.schema_version === STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION
    ? parseStoryboardDirectorPlanPackage(JSON.stringify(value.machine_payload)) : null;
  const pkg: StoryboardDirectorPackage | null = planPackage ? storyboardDirectorPlanAsStoryboardPackage(planPackage) : assetPackage ? {
    ...assetPackage, schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE, phase: "storyboard", segments: [],
  } : value.schema_version === STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION
    ? parseStoryboardDirectorPackage(JSON.stringify(value.machine_payload)) : null;
  if (!pkg) return null;
  const allowLegacyUnverified = options.allowLegacyUnverified === true || value.legacy_input_compatibility === true;
  const requiredContract = options.requiredContractVersion ?? value.required_contract_version;
  if (requiredContract !== undefined && (requiredContract !== STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION
    || pkg.production_contract_version !== requiredContract)) return null;
  // This snapshot is populated by the host from the original user message,
  // never copied from machine_payload.input. Legacy unverified import is an
  // explicit compatibility choice and cannot bypass the current contract.
  const candidateInput = options.expectedInput ?? value.expected_input;
  const expectedInput = isRecord(candidateInput)
    && typeof candidateInput.segmented_script === "string" && candidateInput.segmented_script.trim()
    && typeof candidateInput.animation_style === "string"
    && typeof candidateInput.special_notes === "string"
    && ["16:9", "9:16"].includes(String(candidateInput.aspect_ratio))
    && [8, 10, 15].includes(Number(candidateInput.target_duration_seconds))
    ? candidateInput as unknown as StoryboardDirectorInput : undefined;
  if (!expectedInput && (pkg.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION
    || !allowLegacyUnverified)) return null;
  // The parser normalizes legacy aliases for compatibility.  Before a package
  // is handed to a production canvas, run the full stable-v1 validator so a
  // malformed or semantically incomplete payload cannot bypass the handoff
  // gate merely by looking structurally valid.
  const issues = planPackage ? validateStoryboardDirectorPlanPackage(planPackage, expectedInput) : assetPackage ? validateStoryboardDirectorAssetsPackage(assetPackage, expectedInput)
    : validateStoryboardDirectorPackage(pkg, expectedInput, {
    stage: "planning", allowLegacyMissingChoices: allowLegacyUnverified,
    requirePerformancePlan: options.requirePerformancePlan === true || value.require_performance_plan === true,
  });
  const hardIssues = issues.filter(issue => !isQualityWarningIssue(issue));
  if (hardIssues.length > 0 || (issues.length > 0 && !options.allowQualityWarnings)) return null;
  const referenceProjectId = typeof value.reference_project_id === "string"
    && /^[A-Za-z0-9:_-]{8,160}$/.test(value.reference_project_id) ? value.reference_project_id : undefined;
  const rawBindings = options.verifiedAssetBindings ?? value.verified_asset_bindings;
  const bindings: StoryboardVerifiedAssetBinding[] = !planPackage && Array.isArray(rawBindings) ? rawBindings.filter(binding => (
    isRecord(binding) && typeof binding.assetId === "string" && !!binding.assetId.trim()
    && typeof binding.sourceAssetId === "string" && !!binding.sourceAssetId.trim()
    && (binding.role === "character" || binding.role === "pet") && binding.referenceKind === "turnaround"
    && typeof binding.historyRecordId === "string" && !!binding.historyRecordId.trim()
    && (binding.storageKey === undefined || typeof binding.storageKey === "string")
  )) : [];
  const requiresVerifiedAssets = !assetPackage && !planPackage && pkg.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION
    && pkg.visual_asset_plan?.mode === "selected";
  const declaredCharacters = pkg.visual_asset_plan?.assets.filter(asset => asset.role === "character" || asset.role === "pet") || [];
  const pendingAssetVerification = requiresVerifiedAssets && (!referenceProjectId
    || new Set(bindings.map(binding => binding.assetId)).size !== bindings.length
    || declaredCharacters.some(asset => !bindings.some(binding => binding.assetId === asset.id && binding.role === asset.role)));
  if (pendingAssetVerification && options.assetVerification !== "preview") return null;
  // A model may propose assets but cannot claim it generated or adopted them.
  // For the current contract only independently checked host bindings provide
  // the real source used by a new workbench project.
  const visualAssetPlan = pkg.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION && pkg.visual_asset_plan
    ? { ...pkg.visual_asset_plan, assets: pkg.visual_asset_plan.assets.map(({ source: _source, ...asset }) => {
      const binding = !assetPackage ? bindings.find(item => item.assetId === asset.id && item.role === asset.role) : undefined;
      return { ...asset, ...(binding ? { source: { kind: "generated-image-history" as const,
        asset_id: binding.sourceAssetId, history_record_id: binding.historyRecordId,
        ...(binding.storageKey ? { storage_key: binding.storageKey } : {}) } } : {}) };
    }) } : pkg.visual_asset_plan;
  const duration = pkg.input.target_duration_seconds;
  if (duration !== 8 && duration !== 10 && duration !== 15) return null;
  const shotRule = storyboardShotCountRule(duration, pkg.director_mode);
  if (pkg.segments.some((segment) => (
    segment.actual_shot_count < shotRule.min || segment.actual_shot_count > shotRule.max
  ))) return null;

  const mappedVisualAssetPlan = mapVisualAssetPlan(visualAssetPlan);
  if (pkg.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION
    && mappedVisualAssetPlan && !StoryboardVisualAssetPlanSchema.safeParse(mappedVisualAssetPlan).success) return null;
  return {
    schemaVersion: planPackage ? STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION : assetPackage ? STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION : STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifactType: planPackage ? STORYBOARD_DIRECTOR_PLAN_ARTIFACT_TYPE : assetPackage ? STORYBOARD_DIRECTOR_ASSETS_ARTIFACT_TYPE : STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    phase: planPackage ? "planned" : assetPackage ? "assets" : "storyboard",
    commitKey: String(value.commit_key ?? "").trim(),
    messageId: String(value.message_id ?? "").trim(),
    sourceScript: pkg.input.segmented_script,
    originalInput: expectedInput || pkg.input,
    executionMode: storyboardExecutionModeFromIntake(expectedInput || pkg.input),
    ...(!planPackage && referenceProjectId ? { referenceProjectId } : {}),
    ...(pendingAssetVerification ? { pendingAssetVerification: true } : {}),
    intakeVerified: !!expectedInput && pkg.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION,
    ...(pkg.production_contract_version ? { productionContractVersion: pkg.production_contract_version } : {}),
    pendingRuntimePrerequisites: pkg.segments.flatMap(segment => (segment.quality_checks || [])
      .filter(check => check.status === "unknown" && check.verification?.kind === "visual_asset_binding")
      .map(check => ({ segmentId: segment.segment_id, checkId: check.check_id,
        verification: { kind: "visual_asset_binding" as const, asset_ids: [...check.verification!.asset_ids] } }))),
    settings: {
      directorMode: pkg.director_mode,
      directorLabel: STORYBOARD_DIRECTOR_MODE_LABELS[pkg.director_mode],
      targetDurationSeconds: duration,
      animationStyle: pkg.input.animation_style,
      aspectRatio: pkg.input.aspect_ratio,
    },
    wardrobePlan: pkg.wardrobe_plan ? {
      baseLook: pkg.wardrobe_plan.base_look,
      continuityRule: pkg.wardrobe_plan.continuity_rule,
      changeEvents: pkg.wardrobe_plan.change_events.map((event) => ({
        segmentId: event.segment_id,
        from: event.from,
        to: event.to,
        reason: event.reason,
      })),
    } : undefined,
    visualAssetPlan: mappedVisualAssetPlan,
    environmentGroups: pkg.environment_groups?.map((group) => ({
      sceneId: group.scene_id,
      name: group.name,
      fixedAnchors: group.fixed_anchors,
      zones: group.zones,
      availableAngles: group.available_angles,
      allowedSegmentKinds: group.allowed_segment_kinds,
      ...(group.scene_type ? { sceneType: group.scene_type } : {}),
      ...(group.environment_mode ? { environmentMode: group.environment_mode } : {}),
      ...(group.anchor_required !== undefined ? { anchorRequired: group.anchor_required } : {}),
      ...(group.scene_zone ? { sceneZone: group.scene_zone } : {}),
      ...(group.confidence ? { confidence: group.confidence } : {}),
    })),
    segments: pkg.segments.map((segment) => ({
      segmentId: segment.segment_id,
      sourceIndex: segment.source_index,
      narration: segment.narration,
      imagePrompt: segment.storyboard_image_prompt,
      videoPrompt: segment.image_to_video_prompt,
      panelCount: segment.panel_count,
      layout: segment.layout,
      pacingMode: segment.pacing_mode,
      actualShotCount: segment.actual_shot_count,
      shotTimeRanges: segment.shot_time_ranges,
      panoramicAnchorRole: segment.panoramic_anchor_role,
      ...(segment.bottom_panel_role ? { bottomPanelRole: segment.bottom_panel_role } : {}),
      continuityLinks: segment.continuity_links,
      characterAssets: segment.character_assets,
      ...(segment.character_asset_ids ? { characterAssetIds: segment.character_asset_ids } : {}),
      visualAssetRefs: segment.visual_asset_refs?.map((ref) => ({
        assetId: ref.asset_id,
        role: ref.role as StoryboardVisualAssetRefRole,
        referenceKinds: ref.reference_kinds as StoryboardVisualAssetReferenceKind[],
        ...(ref.scene_id ? { sceneId: ref.scene_id } : {}),
        ...(ref.scene_zone ? { sceneZone: ref.scene_zone } : {}),
        ...(ref.camera_coverage ? { cameraCoverage: ref.camera_coverage } : {}),
      })),
      ...(segment.scene_id ? { sceneId: segment.scene_id } : {}),
      ...(segment.scene_zone ? { sceneZone: segment.scene_zone } : {}),
      ...(segment.style_lock ? { styleLock: segment.style_lock } : {}),
      ...(segment.scene_lock ? { sceneLock: segment.scene_lock } : {}),
      ...(segment.camera ? { camera: segment.camera } : {}),
      ...(segment.dynamic_state?.length ? { dynamicState: segment.dynamic_state } : {}),
      ...(segment.capability_gaps?.length ? { capabilityGaps: segment.capability_gaps } : {}),
      ...(segment.quality_checks?.length ? { qualityChecks: segment.quality_checks.map((check) => ({ checkId: check.check_id, status: check.status, detail: check.detail,
        ...(check.verification ? { verification: { kind: check.verification.kind, asset_ids: [...check.verification.asset_ids] } } : {}) })) } : {}),
      ...(segment.wardrobe_change_events?.length ? { wardrobeChangeEvents: segment.wardrobe_change_events.map((event) => ({ segmentId: event.segment_id, from: event.from, to: event.to, reason: event.reason })) } : {}),
      semanticVisualizations: segment.semantic_visualizations,
      ...(segment.performance_plan ? { performancePlan: segment.performance_plan } : {}),
    })),
  };
}
