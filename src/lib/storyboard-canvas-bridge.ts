import {
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_MODE_LABELS,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  parseStoryboardDirectorPackage,
  storyboardShotCountRule,
  validateStoryboardDirectorPackage,
  type StoryboardContinuityLink,
  type StoryboardDirectorMode,
  type StoryboardVisualAssetReferenceKind,
  type StoryboardVisualAssetRefRole,
  type StoryboardLayout,
  type StoryboardPacingMode,
  type StoryboardShotTimeRange,
} from "@/lib/storyboard-director-protocol";
import type { StoryboardVisualAssetRef } from "@/lib/storyboard-workbench";

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
  videoPrompt: string;
  panelCount: 4 | 5;
  layout: StoryboardLayout;
  pacingMode: StoryboardPacingMode;
  actualShotCount: 3 | 4 | 5;
  shotTimeRanges: StoryboardShotTimeRange[];
  panoramicAnchorRole: string | null;
  continuityLinks: StoryboardContinuityLink[];
  characterAssets: string[];
  visualAssetRefs?: StoryboardVisualAssetRef[];
  semanticVisualizations: Array<{ trigger: string; visual_form: string; interaction: string }>;
}

export interface StoryboardCanvasImportPlan {
  schemaVersion: typeof STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION;
  artifactType: typeof STORYBOARD_DIRECTOR_ARTIFACT_TYPE;
  commitKey: string;
  messageId: string;
  sourceScript: string;
  settings: StoryboardCanvasImportSettings;
  segments: StoryboardCanvasImportSegment[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts only the stable machine package into a canvas plan. Object property order,
 * Markdown headings and code-fence order are deliberately irrelevant here.
 */
export function parseStoryboardCanvasImport(value: unknown): StoryboardCanvasImportPlan | null {
  if (!isRecord(value)
    || value.source !== "stable_json"
    || value.schema_version !== STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION
    || !isRecord(value.machine_payload)) {
    return null;
  }
  const pkg = parseStoryboardDirectorPackage(JSON.stringify(value.machine_payload));
  if (!pkg) return null;
  // The parser normalizes legacy aliases for compatibility.  Before a package
  // is handed to a production canvas, run the full stable-v1 validator so a
  // malformed or semantically incomplete payload cannot bypass the handoff
  // gate merely by looking structurally valid.
  if (validateStoryboardDirectorPackage(pkg, pkg.input).length > 0) return null;
  const duration = pkg.input.target_duration_seconds;
  if (duration !== 8 && duration !== 10 && duration !== 15) return null;
  const shotRule = storyboardShotCountRule(duration, pkg.director_mode);
  if (pkg.segments.some((segment) => (
    segment.actual_shot_count < shotRule.min || segment.actual_shot_count > shotRule.max
  ))) return null;

  return {
    schemaVersion: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifactType: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    commitKey: String(value.commit_key ?? "").trim(),
    messageId: String(value.message_id ?? "").trim(),
    sourceScript: pkg.input.segmented_script,
    settings: {
      directorMode: pkg.director_mode,
      directorLabel: STORYBOARD_DIRECTOR_MODE_LABELS[pkg.director_mode],
      targetDurationSeconds: duration,
      animationStyle: pkg.input.animation_style,
      aspectRatio: pkg.input.aspect_ratio,
    },
    segments: pkg.segments.map((segment) => ({
      segmentId: segment.segment_id,
      sourceIndex: segment.source_index,
      narration: segment.narration,
      imagePrompt: segment.storyboard_image_prompt,
      videoPrompt: segment.image_to_video_prompt,
      panelCount: segment.panel_count,
      layout: segment.layout,
      pacingMode: segment.pacing_mode,
      actualShotCount: segment.actual_shot_count as 3 | 4 | 5,
      shotTimeRanges: segment.shot_time_ranges,
      panoramicAnchorRole: segment.panoramic_anchor_role,
      continuityLinks: segment.continuity_links,
      characterAssets: segment.character_assets,
      visualAssetRefs: segment.visual_asset_refs?.map((ref) => ({
        assetId: ref.asset_id,
        role: ref.role as StoryboardVisualAssetRefRole,
        referenceKinds: ref.reference_kinds as StoryboardVisualAssetReferenceKind[],
      })),
      semanticVisualizations: segment.semantic_visualizations,
    })),
  };
}
